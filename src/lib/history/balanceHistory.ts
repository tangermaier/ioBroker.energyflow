/**
 * Hour-by-hour energy-balance history - pure, ioBroker-free. The history counterpart of
 * EntityManager.recomputeBalance: hourly InfluxDB means per entity are combined into category
 * series (with the same parent-rest logic as the live sums), from which the balance value of the
 * grid/storage and the effective value of a balance-derived entity are built per hour - a
 * `measuredWithFallback` grid uses its measurement wherever an hour has one (Tibber Pulse) and the
 * balance for every other hour (before the meter existed, outages).
 *
 * Timestamps are InfluxDB window ENDS (see HourlyActual); calendar days use hourStartOf.
 */

import { hourStartOf } from "./historyClient.js";
import { normalizePower, type EntityCategory, type EntityDefinition, type PowerSourceMode } from "../entityModel.js";

/** Energy totals in kWh for the three history windows. */
export interface EnergyTotals {
	/** Today (local calendar day) in kWh */
	today: number;
	/** Yesterday in kWh */
	yesterday: number;
	/** Rolling last 7 days in kWh */
	last7Days: number;
}

/**
 * Local (not UTC) calendar-day key for a timestamp, so hourly InfluxDB points bucket into
 * "today"/"yesterday" the same way a person looking at a clock on this host would.
 *
 * @param ts - absolute Unix timestamp in milliseconds
 */
export function localDayKey(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Hour (window-end timestamp, ms) -> mean power in W. */
export type HourlySeries = Map<number, number>;

/**
 * An entity's measured hourly series: normalized import minus normalized export (for a source
 * reporting both separately). An hour with an import reading but no export reading counts the
 * export as 0 (a meter logging on change only writes nothing while it stays at 0); an hour
 * without an import reading has no value.
 *
 * @param entity - the entity (unit/sign/noise normalization)
 * @param importPoints - hourly means of powerStateId
 * @param exportPoints - hourly means of exportStateId, if configured
 */
export function measuredHourly(
	entity: EntityDefinition,
	importPoints: Array<{ ts: number; powerW: number }>,
	exportPoints: Array<{ ts: number; powerW: number }> = [],
): HourlySeries {
	const exports = new Map(exportPoints.map(p => [p.ts, normalizePower(p.powerW, entity)]));
	const out: HourlySeries = new Map();
	for (const p of importPoints) {
		out.set(p.ts, normalizePower(p.powerW, entity) - (exports.get(p.ts) ?? 0));
	}
	return out;
}

/**
 * Hourly category sum mirroring EntityManager.recomputeCategorySum: every entity of the category
 * counts, a parent with children with its rest (parent − children, `invertInParent` children
 * added back). A missing child reading counts as 0; a parent without a reading in an hour
 * contributes nothing that hour.
 *
 * @param category - which category
 * @param entities - all entities
 * @param hourlyByEntity - effective hourly series per entity id
 * @param childrenByParent - parent id -> children
 * @param excludeId - an entity to leave out (the balance-derived one, whose value is being computed)
 */
export function categoryHourly(
	category: EntityCategory,
	entities: EntityDefinition[],
	hourlyByEntity: Map<string, HourlySeries>,
	childrenByParent: Map<string, EntityDefinition[]>,
	excludeId?: string,
): HourlySeries {
	const out: HourlySeries = new Map();
	for (const entity of entities) {
		if (entity.category !== category || entity.entityId === excludeId) {
			continue;
		}
		const own = hourlyByEntity.get(entity.entityId);
		if (!own) {
			continue;
		}
		const children = childrenByParent.get(entity.entityId) ?? [];
		for (const [ts, value] of own) {
			let rest = value;
			for (const child of children) {
				const childValue = hourlyByEntity.get(child.entityId)?.get(ts) ?? 0;
				rest -= child.invertInParent ? -childValue : childValue;
			}
			out.set(ts, (out.get(ts) ?? 0) + rest);
		}
	}
	return out;
}

/**
 * Signed sum of hourly series over the union of their hours (a series without an hour counts 0).
 *
 * @param terms - [series, sign] pairs
 */
export function combineHourly(terms: Array<[HourlySeries, number]>): HourlySeries {
	const out: HourlySeries = new Map();
	for (const [series] of terms) {
		for (const ts of series.keys()) {
			out.set(ts, 0);
		}
	}
	for (const [series, sign] of terms) {
		for (const [ts, value] of series) {
			out.set(ts, (out.get(ts) ?? 0) + sign * value);
		}
	}
	return out;
}

/**
 * The effective hourly series of a balance-capable entity: the balance for `balance`; for
 * `measuredWithFallback` the measurement where available, else the fallback state's reading, else
 * the balance; the measurement alone for `measured`.
 *
 * @param mode - the entity's power-source mode
 * @param measured - its measured hourly series
 * @param balance - its balance hourly series
 * @param fallback - its fallback-state hourly series (already normalized), if configured
 */
export function effectiveHourly(mode: PowerSourceMode, measured: HourlySeries, balance: HourlySeries, fallback?: HourlySeries): HourlySeries {
	if (mode === "measured") {
		return measured;
	}
	if (mode === "balance") {
		return balance;
	}
	const out: HourlySeries = new Map(balance);
	for (const [ts, value] of fallback ?? []) {
		out.set(ts, value);
	}
	for (const [ts, value] of measured) {
		out.set(ts, value);
	}
	return out;
}

/**
 * Hourly measured loss of a hybrid inverter (see entityModel.computeInverterLoss): only hours with
 * an AC output reading get a value.
 *
 * @param pvSeries - effective hourly series of the producers on the inverter's DC side
 * @param storage - effective hourly series of the battery (positive = charging)
 * @param acOut - hourly series of the inverter AC output (W)
 */
export function inverterLossHourly(pvSeries: HourlySeries[], storage: HourlySeries, acOut: HourlySeries): HourlySeries {
	const out: HourlySeries = new Map();
	for (const [ts, ac] of acOut) {
		const pv = pvSeries.reduce((sum, s) => sum + (s.get(ts) ?? 0), 0);
		out.set(ts, Math.max(0, pv - (storage.get(ts) ?? 0) - ac));
	}
	return out;
}

/**
 * Today/Yesterday/Last-7-Days kWh totals of an hourly series (each value = one hour of mean
 * power), bucketed by the local calendar day of the hour it covers.
 *
 * @param series - hourly series
 * @param todayKey - localDayKey() of "now"
 * @param yesterdayKey - localDayKey() of "now" minus one day
 */
export function totalsFromHourly(series: HourlySeries, todayKey: string, yesterdayKey: string): EnergyTotals {
	let today = 0,
		yesterday = 0,
		last7Days = 0;
	for (const [ts, w] of series) {
		const kWh = w / 1000;
		last7Days += kWh;
		const key = localDayKey(hourStartOf(ts));
		if (key === todayKey) {
			today += kWh;
		} else if (key === yesterdayKey) {
			yesterday += kWh;
		}
	}
	return { today, yesterday, last7Days };
}
