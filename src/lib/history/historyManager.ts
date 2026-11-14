import { periodName, tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import {
	computeBalance,
	groupChildrenByParent,
	normalizePower,
	usesBalance,
	type EntityCategory,
	type EntityDefinition,
	type LossDefinition,
} from "../entityModel.js";
import { getHistorySourceFromAdapter, hourStartOf, isHistoryConfigured, queryHourlyActual } from "./historyClient.js";
import {
	categoryHourly,
	combineHourly,
	effectiveHourly,
	inverterLossHourly,
	localDayKey,
	matchesLocalDay,
	measuredHourly,
	totalsFromHourly,
	type EnergyTotals,
	type HourlySeries,
} from "./balanceHistory.js";
import { runSafely } from "../safeAsync.js";

export { localDayKey, matchesLocalDay, type EnergyTotals };

/** How often to recompute the Today/Yesterday/Last-7-Days totals - these change slowly, no need for anything near-real-time. */
const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** Rolling window queried from InfluxDB - covers "yesterday" plus "last 7 days" in one request per entity. */
const LOOKBACK_DAYS = 7;

const ZERO_TOTALS: EnergyTotals = { today: 0, yesterday: 0, last7Days: 0 };

function addTotals(a: EnergyTotals, b: EnergyTotals): EnergyTotals {
	return { today: a.today + b.today, yesterday: a.yesterday + b.yesterday, last7Days: a.last7Days + b.last7Days };
}

function subtractTotals(a: EnergyTotals, b: EnergyTotals): EnergyTotals {
	return { today: a.today - b.today, yesterday: a.yesterday - b.yesterday, last7Days: a.last7Days - b.last7Days };
}

function scaleTotals(totals: EnergyTotals, factor: number): EnergyTotals {
	return { today: totals.today * factor, yesterday: totals.yesterday * factor, last7Days: totals.last7Days * factor };
}

/**
 * Sums one entity's hourly InfluxDB readings into Today/Yesterday/Last-7-Days kWh totals, applying
 * the same unit/sign/noise-threshold normalization the live power reading uses (see normalizePower).
 *
 * @param points - hourly mean-power readings from queryHourlyActual, already scoped to the lookback window
 * @param entity - the entity the readings belong to, for unit/sign/noise-threshold normalization
 * @param todayKey - localDayKey() of "now", so points don't need their own Date math per call
 * @param yesterdayKey - localDayKey() of "now" minus one day
 */
export function sumEnergyTotals(points: { ts: number; powerW: number }[], entity: EntityDefinition, todayKey: string, yesterdayKey: string): EnergyTotals {
	let today = 0,
		yesterday = 0,
		last7Days = 0;
	for (const point of points) {
		const kWh = normalizePower(point.powerW, entity) / 1000;
		last7Days += kWh;
		// point.ts is the window END - the 23:00-24:00 mean belongs to the day it was measured on.
		const key = localDayKey(hourStartOf(point.ts));
		if (key === todayKey) {
			today += kWh;
		} else if (key === yesterdayKey) {
			yesterday += kWh;
		}
	}
	return { today, yesterday, last7Days };
}

/**
 * Same per-point integration as `sumEnergyTotals`, but only counts the portion of each point
 * flowing in the given direction (`charge` = positive normalized power, `discharge` = negative),
 * scaled by `1 - efficiencyPercent / 100`. Reconstructs a storage entity's charge-/discharge-loss
 * history from the exact same raw points already fetched for its own energy total - a single
 * aggregated (net) total can't be split this way after the fact, since charging and discharging
 * can both happen within the same day and would otherwise cancel out.
 *
 * @param points - hourly mean-power readings for the storage entity, same as passed to sumEnergyTotals
 * @param entity - the storage entity the readings belong to, for unit/sign/noise-threshold normalization
 * @param todayKey - localDayKey() of "now"
 * @param yesterdayKey - localDayKey() of "now" minus one day
 * @param efficiencyPercent - assumed efficiency (0-100) for this direction
 * @param direction - which direction of flow to count
 */
export function sumDirectionalLossTotals(
	points: { ts: number; powerW: number }[],
	entity: EntityDefinition,
	todayKey: string,
	yesterdayKey: string,
	efficiencyPercent: number,
	direction: "charge" | "discharge",
): EnergyTotals {
	const factor = 1 - efficiencyPercent / 100;
	let today = 0,
		yesterday = 0,
		last7Days = 0;
	for (const point of points) {
		const kWh = normalizePower(point.powerW, entity) / 1000;
		const directionalKWh = direction === "charge" ? Math.max(0, kWh) : Math.max(0, -kWh);
		const lossKWh = directionalKWh * factor;
		last7Days += lossKWh;
		const key = localDayKey(hourStartOf(point.ts));
		if (key === todayKey) {
			today += lossKWh;
		} else if (key === yesterdayKey) {
			yesterday += lossKWh;
		}
	}
	return { today, yesterday, last7Days };
}

/**
 * Historical counterpart of `EntityManager.recomputeCategorySum`: sums every entity in `category`,
 * using each parent-with-children's rest-energy totals instead of its raw totals (see
 * `recomputeCategorySum` for why a netted-in producer/individually-measured child would otherwise
 * be under/double-counted). Needed to reconstruct `deriveFromBalance` history correctly - see
 * `HistoryManager.refresh`.
 *
 * @param category - which category to sum
 * @param entities - all configured entities
 * @param totalsByEntity - each entity's own (raw) Today/Yesterday/Last7Days totals
 * @param restTotalsByParent - each parent-with-children's rest-energy totals (parent minus its assigned children)
 */
export function sumCategoryTotals(
	category: EntityCategory,
	entities: EntityDefinition[],
	totalsByEntity: Map<string, EnergyTotals>,
	restTotalsByParent: Map<string, EnergyTotals>,
): EnergyTotals {
	let sum = ZERO_TOTALS;
	for (const entity of entities) {
		if (entity.category !== category) {
			continue;
		}
		const contribution = restTotalsByParent.get(entity.entityId) ?? totalsByEntity.get(entity.entityId) ?? ZERO_TOTALS;
		sum = addTotals(sum, contribution);
	}
	return sum;
}

/**
 * Periodically pre-computes Today/Yesterday/Last-7-Days energy totals (kWh) per entity from
 * InfluxDB, so the arrow-diagram widget's history view only ever has to read plain states - no
 * on-demand InfluxDB round-trip from the browser. Mirrors the live entities.<id>.restPower model:
 * a parent with children also gets entities.<parentId>.restEnergy{Today,Yesterday,Last7Days},
 * computed the same way (parent total minus children, invertInParent respected) so the widget's
 * automatic "Sonstiges" arrow works identically in the history view as it does live.
 *
 * Balance-capable entities (grid/storage with `powerSource` balance or measuredWithFallback) are
 * built hour by hour exactly like live (see balanceHistory.ts): `balance` uses the balance of the
 * other categories for every hour, `measuredWithFallback` its measurement wherever an hour has one
 * and the balance elsewhere. Their measured series alone is kept as `rawEnergy*` (like the live
 * `rawPower`), every grid/storage entity gets its balance value as `balanceEnergy*` (like
 * `balancePower`), and `summary.balanceResidual.energy*` holds the signed measurement residual.
 */
export class HistoryManager {
	private readonly adapter: utils.AdapterInstance;
	private refreshTimer: ioBroker.Interval | undefined;
	private lossDefinitions: LossDefinition[] = [];

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
	}

	/**
	 * Builds the history object tree for the currently configured entities (and any synthesized
	 * loss entities), runs an initial computation, and schedules the periodic refresh. A no-op
	 * (besides object creation) when InfluxDB isn't configured - the widget's history view then
	 * simply shows zeros.
	 *
	 * @param entities - all configured entities
	 * @param lossDefinitions - loss entities synthesized from producer/storage efficiency fields, see EntityManager.getLossDefinitions
	 */
	public async init(entities: EntityDefinition[], lossDefinitions: LossDefinition[] = []): Promise<void> {
		this.lossDefinitions = lossDefinitions;
		const childrenByParent = groupChildrenByParent(entities);
		await this.createHistoryObjects(entities, childrenByParent);

		await this.refresh(entities, childrenByParent);
		this.refreshTimer = this.adapter.setInterval(() => {
			runSafely(this.adapter, "Energy history refresh", () => this.refresh(entities, childrenByParent));
		}, REFRESH_INTERVAL_MS);
	}

	/** Stops the periodic refresh timer. */
	public stop(): void {
		if (this.refreshTimer) {
			this.adapter.clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private async createHistoryObjects(entities: EntityDefinition[], childrenByParent: Map<string, EntityDefinition[]>): Promise<void> {
		for (const entity of entities) {
			for (const suffix of ["energyToday", "energyYesterday", "energyLast7Days"] as const) {
				await this.adapter.extendObjectAsync(`entities.${entity.entityId}.${suffix}`, {
					type: "state",
					common: {
						name: tAll("{name} {period}", { name: entity.name, period: periodName(suffix) }),
						role: "value.energy",
						type: "number",
						unit: "kWh",
						read: true,
						write: false,
						def: 0,
					},
					native: {},
				});
			}
			if (entity.category === "grid" || entity.category === "storage") {
				for (const suffix of ["balanceEnergyToday", "balanceEnergyYesterday", "balanceEnergyLast7Days"] as const) {
					await this.adapter.extendObjectAsync(`entities.${entity.entityId}.${suffix}`, {
						type: "state",
						common: {
							name: tAll("{name} {period} (according to the energy balance - diagnostic)", { name: entity.name, period: periodName(suffix) }),
							role: "value.energy",
							type: "number",
							unit: "kWh",
							read: true,
							write: false,
							def: 0,
						},
						native: {},
					});
				}
			}
			if (usesBalance(entity)) {
				for (const suffix of ["rawEnergyToday", "rawEnergyYesterday", "rawEnergyLast7Days"] as const) {
					await this.adapter.extendObjectAsync(`entities.${entity.entityId}.${suffix}`, {
						type: "state",
						common: {
							name: tAll("{name} {period} (unused raw register, for comparison/debugging)", { name: entity.name, period: periodName(suffix) }),
							role: "value.energy",
							type: "number",
							unit: "kWh",
							read: true,
							write: false,
							def: 0,
						},
						native: {},
					});
				}
			} else {
				// Config may have turned deriveFromBalance off since the previous run - drop stale raw-comparison states.
				for (const suffix of ["rawEnergyToday", "rawEnergyYesterday", "rawEnergyLast7Days"] as const) {
					await this.adapter.delObjectAsync(`entities.${entity.entityId}.${suffix}`).catch(() => undefined);
				}
			}
			const hasChildren = childrenByParent.has(entity.entityId);
			for (const suffix of ["restEnergyToday", "restEnergyYesterday", "restEnergyLast7Days"] as const) {
				if (hasChildren) {
					await this.adapter.extendObjectAsync(`entities.${entity.entityId}.${suffix}`, {
						type: "state",
						common: {
							name: tAll("{name} {period} (aggregate minus assigned individual measurements)", { name: entity.name, period: periodName(suffix) }),
							role: "value.energy",
							type: "number",
							unit: "kWh",
							read: true,
							write: false,
							def: 0,
						},
						native: {},
					});
				} else {
					// Config may have removed the last child since the previous run - drop a stale rest state.
					await this.adapter.delObjectAsync(`entities.${entity.entityId}.${suffix}`).catch(() => undefined);
				}
			}
		}

		for (const loss of this.lossDefinitions) {
			for (const suffix of ["energyToday", "energyYesterday", "energyLast7Days"] as const) {
				await this.adapter.extendObjectAsync(`entities.${loss.entityId}.${suffix}`, {
					type: "state",
					common: {
						name: tAll("{name} {period}", { name: loss.name, period: periodName(suffix) }),
						role: "value.energy",
						type: "number",
						unit: "kWh",
						read: true,
						write: false,
						def: 0,
					},
					native: {},
				});
			}
		}

		for (const suffix of ["energyToday", "energyYesterday", "energyLast7Days"] as const) {
			await this.adapter.extendObjectAsync(`summary.balanceResidual.${suffix}`, {
				type: "state",
				common: {
					name: tAll("Measurement residual {period} (signed, positive = more measured supply than use)", { period: periodName(suffix) }),
					role: "value.energy",
					type: "number",
					unit: "kWh",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		}
	}

	/**
	 * Writes the three totals states of a prefix (`<prefix>Today/Yesterday/Last7Days`).
	 *
	 * @param prefix - full state id prefix, e.g. "entities.netz.energy"
	 * @param totals - the totals
	 */
	private async writeTotals(prefix: string, totals: EnergyTotals): Promise<void> {
		await this.adapter.setStateAsync(`${prefix}Today`, { val: totals.today, ack: true });
		await this.adapter.setStateAsync(`${prefix}Yesterday`, { val: totals.yesterday, ack: true });
		await this.adapter.setStateAsync(`${prefix}Last7Days`, { val: totals.last7Days, ack: true });
	}

	private async refresh(entities: EntityDefinition[], childrenByParent: Map<string, EntityDefinition[]>): Promise<void> {
		const historySource = getHistorySourceFromAdapter(this.adapter);
		if (!isHistoryConfigured(historySource)) {
			return;
		}

		const now = new Date();
		const yesterday = new Date(now);
		yesterday.setDate(yesterday.getDate() - 1);
		const todayKey = localDayKey(now.getTime());
		const yesterdayKey = localDayKey(yesterday.getTime());
		const start = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

		// 1) Measured hourly series per entity (import − export where a separate export source exists).
		const measuredByEntity = new Map<string, HourlySeries>();
		const pointsByEntity = new Map<string, { ts: number; powerW: number }[]>();
		for (const entity of entities) {
			try {
				const points = await queryHourlyActual(historySource, entity.powerStateId, start, now);
				const exportPoints = entity.exportStateId ? await queryHourlyActual(historySource, entity.exportStateId, start, now) : [];
				pointsByEntity.set(entity.entityId, points);
				measuredByEntity.set(entity.entityId, measuredHourly(entity, points, exportPoints));
			} catch (error) {
				this.adapter.log.warn(`History totals for entity "${entity.entityId}" failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		// 2) Effective series: measured, except the (at most one) balance-capable entity, which is
		// built hour by hour from the other categories - exactly like EntityManager.recomputeBalance.
		const effectiveByEntity = new Map(measuredByEntity);
		const balanceEntity = entities.find(e => usesBalance(e));
		const balanceSeriesFor = (category: "grid" | "storage", excludeId?: string): HourlySeries => {
			const cat = (c: EntityCategory): HourlySeries => categoryHourly(c, entities, effectiveByEntity, childrenByParent, excludeId);
			return category === "grid"
				? combineHourly([
						[cat("consumer"), 1],
						[cat("producer"), -1],
						[cat("storage"), 1],
					])
				: combineHourly([
						[cat("producer"), 1],
						[cat("grid"), 1],
						[cat("consumer"), -1],
					]);
		};
		if (balanceEntity && (balanceEntity.category === "grid" || balanceEntity.category === "storage")) {
			const balance = balanceSeriesFor(balanceEntity.category, balanceEntity.entityId);
			const measured = measuredByEntity.get(balanceEntity.entityId) ?? new Map<number, number>();
			let fallback: HourlySeries | undefined;
			if (balanceEntity.fallbackStateId) {
				try {
					const sign = balanceEntity.fallbackInvertSign ? -1 : 1;
					const points = await queryHourlyActual(historySource, balanceEntity.fallbackStateId, start, now);
					fallback = new Map(points.map(p => [p.ts, sign * p.powerW]));
				} catch (error) {
					this.adapter.log.warn(
						`History of fallback state "${balanceEntity.fallbackStateId}" failed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
			effectiveByEntity.set(balanceEntity.entityId, effectiveHourly(balanceEntity.powerSource, measured, balance, fallback));
			await this.writeTotals(`entities.${balanceEntity.entityId}.rawEnergy`, totalsFromHourly(measured, todayKey, yesterdayKey));
		}

		const totalsByEntity = new Map<string, EnergyTotals>();
		for (const entity of entities) {
			const series = effectiveByEntity.get(entity.entityId);
			if (!series) {
				continue;
			}
			const totals = totalsFromHourly(series, todayKey, yesterdayKey);
			totalsByEntity.set(entity.entityId, totals);
			await this.writeTotals(`entities.${entity.entityId}.energy`, totals);
		}

		// 3) Balance diagnostics for every grid/storage entity (what it would have to be).
		for (const entity of entities) {
			if (entity.category !== "grid" && entity.category !== "storage") {
				continue;
			}
			await this.writeTotals(`entities.${entity.entityId}.balanceEnergy`, totalsFromHourly(balanceSeriesFor(entity.category), todayKey, yesterdayKey));
		}

		const restTotalsByParent = new Map<string, EnergyTotals>();
		for (const [parentId, children] of childrenByParent) {
			const parentTotals = totalsByEntity.get(parentId);
			if (!parentTotals) {
				continue;
			}
			const childrenSum = children.reduce((sum, child) => {
				const childTotals = totalsByEntity.get(child.entityId) ?? ZERO_TOTALS;
				return addTotals(sum, scaleTotals(childTotals, child.invertInParent ? -1 : 1));
			}, ZERO_TOTALS);
			const restTotals = subtractTotals(parentTotals, childrenSum);
			restTotalsByParent.set(parentId, restTotals);
			await this.writeTotals(`entities.${parentId}.restEnergy`, restTotals);
		}

		let lossSum: EnergyTotals = ZERO_TOTALS;
		// Loss entities: a physically-motivated estimate from their source entity's own already-
		// computed history - see entityModel.deriveLossDefinitions/computeLossPower for the live
		// equivalent and why charge/discharge loss needs the raw points, not the (possibly net-
		// cancelling) aggregated total.
		for (const loss of this.lossDefinitions) {
			const sourceTotals = totalsByEntity.get(loss.sourceEntityId);
			if (!sourceTotals) {
				continue;
			}
			let lossTotals: EnergyTotals;
			if (loss.kind === "inverterLoss") {
				if (!loss.acStateId) {
					continue;
				}
				try {
					const acPoints = await queryHourlyActual(historySource, loss.acStateId, start, now);
					const acSeries: HourlySeries = new Map(acPoints.map(p => [p.ts, p.powerW]));
					const pvSeries = (loss.inputIds ?? []).map(id => effectiveByEntity.get(id) ?? new Map<number, number>());
					const storageSeries = effectiveByEntity.get(loss.sourceEntityId) ?? new Map<number, number>();
					lossTotals = totalsFromHourly(inverterLossHourly(pvSeries, storageSeries, acSeries), todayKey, yesterdayKey);
				} catch (error) {
					this.adapter.log.warn(
						`History of inverter AC output "${loss.acStateId}" failed: ${error instanceof Error ? error.message : String(error)}`,
					);
					continue;
				}
			} else if (loss.kind === "producerLoss") {
				lossTotals = scaleTotals(sourceTotals, 1 - loss.efficiencyPercent / 100);
			} else {
				const sourceEntity = entities.find(e => e.entityId === loss.sourceEntityId);
				const points = pointsByEntity.get(loss.sourceEntityId);
				if (!sourceEntity || !points) {
					continue;
				}
				lossTotals = sumDirectionalLossTotals(
					points,
					sourceEntity,
					todayKey,
					yesterdayKey,
					loss.efficiencyPercent,
					loss.kind === "chargeLoss" ? "charge" : "discharge",
				);
			}
			lossSum = addTotals(lossSum, lossTotals);
			await this.writeTotals(`entities.${loss.entityId}.energy`, lossTotals);
		}

		// 4) Signed measurement residual over the same windows (see entityModel.computeBalance).
		const cat = (c: EntityCategory): EnergyTotals => sumCategoryTotals(c, entities, totalsByEntity, restTotalsByParent);
		const totalsOf = (pick: (t: EnergyTotals) => number): number =>
			computeBalance({
				producer: pick(cat("producer")),
				consumer: pick(cat("consumer")),
				storage: pick(cat("storage")),
				grid: pick(cat("grid")),
				loss: pick(lossSum),
			}).residual;
		await this.writeTotals("summary.balanceResidual.energy", {
			today: totalsOf(t => t.today),
			yesterday: totalsOf(t => t.yesterday),
			last7Days: totalsOf(t => t.last7Days),
		});
	}
}
