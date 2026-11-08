/**
 * Household consumption forecast for the planner - pure, ioBroker-free.
 *
 * A historical profile: per (workday/weekend, local hour of day) the median of the hourly mean
 * consumption over the last weeks. The median keeps single outliers (a laundry day, a sauna
 * evening) from skewing the typical day. For the first hour ahead the profile is blended
 * linearly towards the live consumption, so "right now" stays realistic without letting a
 * momentary spike (cooking at 3 kW) leak into the whole night's plan.
 */

import { groupChildrenByParent, normalizePower, type EntityDefinition } from "../entityModel.js";
import { hourStartOf } from "../history/historyClient.js";
import { median } from "../prices/tibber.js";

export type DayType = "workday" | "weekend";

/** Median consumption in W per day type and local hour (0-23); undefined = no data. */
export type LoadProfile = Record<DayType, Array<number | undefined>>;

const MS_PER_HOUR = 3600 * 1000;

/**
 * Day type of a timestamp in local time (Saturday/Sunday = weekend).
 *
 * @param ts - absolute timestamp in ms
 */
export function dayTypeOf(ts: number): DayType {
	const day = new Date(ts).getDay();
	return day === 0 || day === 6 ? "weekend" : "workday";
}

/**
 * Reconstructs the hourly total household consumption (W) from per-entity hourly InfluxDB means,
 * mirroring the live `summary.consumer.power`: every consumer entity counts, a parent with
 * children counts with its rest power (parent minus children, `invertInParent` children added
 * back) - so a balcony plant netted into the house meter doesn't make consumption look smaller.
 *
 * Only TOP-LEVEL consumers (no consumer parent) must have a reading for an hour to count: an
 * individually measured consumer child cancels out of the total anyway (parent rest + child =
 * parent), so a missing child reading - common for smart plugs logging only on change - simply
 * counts as 0 instead of discarding the whole hour (found live 2026-10-31: the profile stayed
 * empty because the washing machine/oven plugs had gaps in almost every hour).
 *
 * @param entities - all configured entities
 * @param pointsByEntity - hourly mean raw readings per entity id
 */
export function consumptionSeries(
	entities: EntityDefinition[],
	pointsByEntity: Map<string, Array<{ ts: number; powerW: number }>>,
): Array<{ ts: number; powerW: number }> {
	const consumers = entities.filter(e => e.category === "consumer");
	if (consumers.length === 0) {
		return [];
	}
	const childrenByParent = groupChildrenByParent(entities);
	const consumerIds = new Set(consumers.map(c => c.entityId));
	const topLevel = consumers.filter(c => !c.parentId || !consumerIds.has(c.parentId));
	const valueAt = new Map<string, Map<number, number>>();
	for (const entity of entities) {
		const m = new Map<number, number>();
		for (const p of pointsByEntity.get(entity.entityId) ?? []) {
			m.set(p.ts, normalizePower(p.powerW, entity));
		}
		valueAt.set(entity.entityId, m);
	}
	const hours = new Set<number>();
	for (const c of topLevel) {
		for (const ts of valueAt.get(c.entityId)?.keys() ?? []) {
			hours.add(ts);
		}
	}
	const out: Array<{ ts: number; powerW: number }> = [];
	for (const ts of [...hours].sort((a, b) => a - b)) {
		let sum = 0;
		let complete = true;
		for (const c of consumers) {
			const own = valueAt.get(c.entityId)?.get(ts);
			if (own === undefined && topLevel.includes(c)) {
				complete = false;
				break;
			}
			let value = own ?? 0;
			for (const child of childrenByParent.get(c.entityId) ?? []) {
				const childValue = valueAt.get(child.entityId)?.get(ts) ?? 0;
				value -= child.invertInParent ? -childValue : childValue;
			}
			sum += value;
		}
		if (complete) {
			out.push({ ts, powerW: Math.max(0, sum) });
		}
	}
	return out;
}

/**
 * Builds the median profile from an hourly consumption series. Timestamps are InfluxDB window
 * ENDS (the 09:00-10:00 mean carries 10:00), so each value is filed under the hour it covers.
 *
 * @param series - hourly mean consumption in W (timestamps = window ends, see HourlyActual)
 */
export function buildLoadProfile(series: Array<{ ts: number; powerW: number }>): LoadProfile {
	const buckets: Record<DayType, number[][]> = {
		workday: Array.from({ length: 24 }, () => []),
		weekend: Array.from({ length: 24 }, () => []),
	};
	for (const p of series) {
		const start = hourStartOf(p.ts);
		buckets[dayTypeOf(start)][new Date(start).getHours()].push(p.powerW);
	}
	return {
		workday: buckets.workday.map(values => median(values)),
		weekend: buckets.weekend.map(values => median(values)),
	};
}

/**
 * Expected consumption at a point in time: the profile value for its day type and hour, falling
 * back to the other day type's value for that hour, then to the overall median, then to the live
 * value. Within the first hour after `now` the result is blended linearly towards `liveW`.
 *
 * @param profile - the median profile
 * @param ts - point in time (ms)
 * @param now - current time (ms)
 * @param liveW - current live consumption in W (undefined = unknown)
 */
export function expectedLoadW(profile: LoadProfile, ts: number, now: number, liveW: number | undefined): number {
	const hour = new Date(ts).getHours();
	const type = dayTypeOf(ts);
	const other: DayType = type === "workday" ? "weekend" : "workday";
	const overall = median([...profile.workday, ...profile.weekend].filter((v): v is number => v !== undefined));
	const base = profile[type][hour] ?? profile[other][hour] ?? overall ?? liveW ?? 0;
	if (liveW === undefined) {
		return base;
	}
	const ahead = ts - now;
	if (ahead >= MS_PER_HOUR) {
		return base;
	}
	const w = 1 - Math.max(0, ahead) / MS_PER_HOUR;
	return w * liveW + (1 - w) * base;
}
