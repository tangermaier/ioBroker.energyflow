import { tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import type { EntityDefinition } from "../entityModel.js";
import type { ForecastPoint } from "../forecast/pvModel.js";
import { localDayKey, matchesLocalDay } from "../history/historyManager.js";
import { getHistorySourceFromAdapter, isHistoryConfigured, queryHourlyActual } from "../history/historyClient.js";
import { buildLoadProfile, consumptionSeries, expectedLoadW, type LoadProfile } from "../planner/loadProfile.js";
import { computePlan, findFlexWindow, type BatteryParams, type PlanInputSlot } from "../planner/optimizer.js";
import { buildPlanText, modeLabel, pvAt, serializePlan } from "../planner/planText.js";
import type { PriceManager } from "../prices/priceManager.js";
import { findSlotAt, median } from "../prices/tibber.js";
import { buildRecommendationText, computeSurplusSeries, findBestSurplusWindow, positiveSurplusKWh, splitTodayTomorrow } from "./surplus.js";
import { handleTaskError, runSafely } from "../safeAsync.js";

/** Plan recomputation cadence - one Tibber slot. */
const SLOT_MS = 15 * 60 * 1000;
/** Load profile refresh cadence (InfluxDB query of the last LOAD_PROFILE_DAYS days). */
const PROFILE_REFRESH_MS = 60 * 60 * 1000;
const LOAD_PROFILE_DAYS = 28;
/** Cost integration sampling interval. */
const COST_SAMPLE_MS = 60 * 1000;
/** A longer gap between two cost samples (adapter was down) is not integrated. */
const COST_MAX_GAP_MS = 5 * 60 * 1000;
/** Minimum surplus power for an hour to count towards the fallback "best window", in Watt. */
const SURPLUS_THRESHOLD_W = 300;
/** Debounce for event-triggered replans (new prices + new forecast often arrive together). */
const REPLAN_DEBOUNCE_MS = 3000;

/** Defaults for storage planner fields left empty in the admin table. */
const DEFAULT_MIN_SOC = 20;
const DEFAULT_MAX_SOC = 100;

/**
 * Advisory energy planner + recommendation glue: collects prices (PriceManager), the PV forecast,
 * the household load profile (InfluxDB) and the battery state, runs the DP optimizer
 * (planner/optimizer.ts) every slot and on new prices/forecasts, and mirrors the result into
 * `plan.*`, `recommendation.*` and `costs.*`. Read-only/advisory - nothing is ever written to the
 * inverter (active control would be a separate, later feature).
 *
 * Without price data for the current slot the plan is suspended (`plan.status = noPriceData`)
 * and the recommendation falls back to the earlier pure PV-surplus advice.
 */
export class RecommendationManager {
	private readonly adapter: utils.AdapterInstance;
	private readonly prices: PriceManager;
	private readonly entities: EntityDefinition[];
	private profile: LoadProfile = { workday: new Array(24).fill(undefined), weekend: new Array(24).fill(undefined) };
	private slotTimer: ioBroker.Timeout | undefined;
	private profileTimer: ioBroker.Interval | undefined;
	private costTimer: ioBroker.Interval | undefined;
	private replanTimer: ioBroker.Timeout | undefined;
	private refreshing = false;
	private refreshAgain = false;
	private cost = { dayKey: "", todayCt: 0, yesterdayCt: 0, lastSampleTs: 0 };

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 * @param prices - the price manager (already initialized)
	 * @param entities - all configured entities
	 */
	public constructor(adapter: utils.AdapterInstance, prices: PriceManager, entities: EntityDefinition[]) {
		this.adapter = adapter;
		this.prices = prices;
		this.entities = entities;
	}

	/** Creates the object tree, loads the profile, runs an initial plan and starts the timers. */
	public async init(): Promise<void> {
		await this.createObjects();
		await this.restoreCosts();
		await this.refreshProfile();
		await this.refresh();
		this.scheduleSlotTick();
		this.profileTimer = this.adapter.setInterval(() => runSafely(this.adapter, "Load profile refresh", () => this.refreshProfile()), PROFILE_REFRESH_MS);
		this.costTimer = this.adapter.setInterval(() => runSafely(this.adapter, "Cost sampling", () => this.sampleCost()), COST_SAMPLE_MS);
	}

	/** Stops all timers. Call this from the adapter's unload handler. */
	public stop(): void {
		for (const t of [this.slotTimer, this.replanTimer]) {
			if (t) {
				this.adapter.clearTimeout(t);
			}
		}
		for (const t of [this.profileTimer, this.costTimer]) {
			if (t) {
				this.adapter.clearInterval(t);
			}
		}
		this.slotTimer = this.replanTimer = this.profileTimer = this.costTimer = undefined;
	}

	/** Requests a (debounced) replan - call on new prices or a new PV forecast. */
	public requestReplan(): void {
		if (this.replanTimer) {
			this.adapter.clearTimeout(this.replanTimer);
		}
		this.replanTimer = this.adapter.setTimeout(() => {
			this.replanTimer = undefined;
			void this.refresh();
		}, REPLAN_DEBOUNCE_MS);
	}

	private scheduleSlotTick(): void {
		const now = Date.now();
		// a few seconds after the boundary, so PriceManager has already switched to the new slot
		const next = Math.floor(now / SLOT_MS) * SLOT_MS + SLOT_MS + 5000;
		this.slotTimer = this.adapter.setTimeout(() => {
			void this.refresh().finally(() => this.scheduleSlotTick());
		}, next - now);
	}

	/** Serializes refreshes - a trigger arriving mid-refresh causes exactly one more run. */
	private async refresh(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return;
		}
		this.refreshing = true;
		try {
			do {
				this.refreshAgain = false;
				await this.computeAndWrite();
			} while (this.refreshAgain);
		} catch (error) {
			handleTaskError(this.adapter, "Energy plan computation", error);
		} finally {
			this.refreshing = false;
		}
	}

	private async computeAndWrite(): Promise<void> {
		const now = Date.now();
		const gridPowerW = await this.getNumberState("summary.grid.power");
		const consumerPowerW = await this.getNumberState("summary.consumer.power");
		const forecast = await this.getForecastSeries();

		// Plain PV-surplus figures - kept for the widgets and as the no-price fallback.
		// summary.grid.power: positive = import, negative = export, so a live surplus is the negated value.
		const nowSurplusW = -(gridPowerW ?? 0);
		const surplusSeries = computeSurplusSeries(forecast, consumerPowerW ?? 0);
		const { today, tomorrow } = splitTodayTomorrow(surplusSeries);
		await this.adapter.setStateAsync("recommendation.nowSurplusPower", { val: nowSurplusW, ack: true });
		await this.adapter.setStateAsync("recommendation.forecastSurplusPower", { val: JSON.stringify(surplusSeries), ack: true });
		await this.adapter.setStateAsync("recommendation.todaySurplusKWh", { val: positiveSurplusKWh(today), ack: true });
		await this.adapter.setStateAsync("recommendation.tomorrowSurplusKWh", { val: positiveSurplusKWh(tomorrow), ack: true });

		const priceSeries = this.prices.getPriceSeries(now);
		if (priceSeries.length === 0) {
			const bestWindow = findBestSurplusWindow([...today, ...tomorrow], now, SURPLUS_THRESHOLD_W);
			const fallback = buildRecommendationText({ nowSurplusW, todaySurplusKWh: positiveSurplusKWh(today), bestWindow, selfConsumptionValueCtPerKWh: 0 });
			await this.writeSuspended("noPriceData", `Keine aktuellen Preisdaten – Energieplan ausgesetzt. ${fallback}`);
			return;
		}

		const battery = await this.getBatteryParams();
		const input: PlanInputSlot[] = priceSeries.map(slot => {
			const mid = (Math.max(slot.startTs, now) + slot.endTs) / 2;
			return {
				startTs: slot.startTs,
				endTs: slot.endTs,
				priceCt: slot.totalCt,
				feedInCt: this.prices.getFeedInForSlot(slot) ?? 0,
				pvW: pvAt(forecast, mid),
				loadW: expectedLoadW(this.profile, mid, now, consumerPowerW),
				level: slot.level,
			};
		});
		const medianPrice = median(input.map(s => s.priceCt)) ?? 0;
		const terminalValueCtPerKWh = battery ? Math.max(0, medianPrice * battery.dischargeEfficiency - battery.wearCtPerKWh) : 0;
		const exportLimitW = this.adapter.config.maxGridExportW > 0 ? Number(this.adapter.config.maxGridExportW) : Infinity;

		const plan = computePlan(input, battery, { now, exportLimitW, terminalValueCtPerKWh });
		const current = plan.slots[0];
		if (!current) {
			await this.writeSuspended("noPriceData", "Keine aktuellen Preisdaten – Energieplan ausgesetzt.");
			return;
		}
		const flexDurationH = Number(this.adapter.config.flexLoadDurationH) || 2;
		const flexPowerKW = Number(this.adapter.config.flexLoadPowerKW) || 2;
		const flex = findFlexWindow(plan, battery, now, flexDurationH, flexPowerKW);
		const text = buildPlanText({ current, flex, flexDurationH, flexPowerKW, expectedSavingsCt: plan.expectedSavingsCt, now });

		await this.adapter.setStateAsync("plan.status", { val: battery ? "ok" : "noBattery", ack: true });
		await this.adapter.setStateAsync("plan.json", { val: serializePlan(plan.slots), ack: true });
		await this.adapter.setStateAsync("plan.currentMode", { val: current.mode, ack: true });
		await this.adapter.setStateAsync("plan.currentModeLabel", { val: modeLabel(current.mode), ack: true });
		await this.adapter.setStateAsync("plan.currentReason", { val: current.reason, ack: true });
		await this.adapter.setStateAsync("plan.currentTargetSoc", { val: Math.round(current.socEndPercent * 10) / 10, ack: true });
		await this.adapter.setStateAsync("plan.marginalCost", { val: Math.round(current.marginalCostCt * 100) / 100, ack: true });
		await this.adapter.setStateAsync("plan.expectedSavings", { val: Math.round(plan.expectedSavingsCt) / 100, ack: true });
		await this.adapter.setStateAsync("plan.horizonEnd", { val: plan.slots[plan.slots.length - 1].endTs, ack: true });
		await this.adapter.setStateAsync("plan.lastUpdate", { val: now, ack: true });
		await this.adapter.setStateAsync("recommendation.flexWindowStart", { val: flex?.startTs ?? 0, ack: true });
		await this.adapter.setStateAsync("recommendation.flexWindowEnd", { val: flex?.endTs ?? 0, ack: true });
		await this.adapter.setStateAsync("recommendation.flexWindowCost", { val: flex ? Math.round(flex.costCt) / 100 : 0, ack: true });
		await this.adapter.setStateAsync("recommendation.flexWindowAvgPrice", { val: flex ? Math.round(flex.avgCtPerKWh * 100) / 100 : 0, ack: true });
		await this.adapter.setStateAsync("recommendation.flexWindowSource", { val: flex?.mainSource ?? "", ack: true });
		await this.adapter.setStateAsync("recommendation.text", { val: text, ack: true });
	}

	/**
	 * Marks the plan as suspended and writes the fallback text.
	 *
	 * @param status - the plan.status value
	 * @param text - recommendation text to show instead
	 */
	private async writeSuspended(status: string, text: string): Promise<void> {
		await this.adapter.setStateAsync("plan.status", { val: status, ack: true });
		await this.adapter.setStateAsync("plan.json", { val: "[]", ack: true });
		await this.adapter.setStateAsync("plan.currentMode", { val: "", ack: true });
		await this.adapter.setStateAsync("plan.currentModeLabel", { val: "", ack: true });
		await this.adapter.setStateAsync("plan.currentReason", { val: "", ack: true });
		await this.adapter.setStateAsync("plan.lastUpdate", { val: Date.now(), ack: true });
		await this.adapter.setStateAsync("recommendation.text", { val: text, ack: true });
	}

	/** Battery parameters of the (single) configured storage entity, or undefined if none is usable. */
	private async getBatteryParams(): Promise<BatteryParams | undefined> {
		const storage = this.entities.find(e => e.category === "storage");
		if (!storage || !storage.capacityKWh || !storage.socStateId) {
			return undefined;
		}
		const socState = await this.adapter.getForeignStateAsync(storage.socStateId);
		const soc = typeof socState?.val === "number" ? socState.val : Number(socState?.val);
		if (!Number.isFinite(soc)) {
			return undefined;
		}
		const minSoc = storage.minSocPercent ?? DEFAULT_MIN_SOC;
		const maxSoc = Math.max(minSoc + 1, storage.maxSocPercent ?? DEFAULT_MAX_SOC);
		return {
			capacityKWh: storage.capacityKWh,
			socPercent: Math.min(maxSoc, Math.max(minSoc, soc)),
			minSocPercent: minSoc,
			maxSocPercent: maxSoc,
			maxPowerKW: storage.maxPowerKW && storage.maxPowerKW > 0 ? storage.maxPowerKW : Infinity,
			chargeEfficiency: (storage.chargeEfficiencyPercent ?? 100) / 100,
			dischargeEfficiency: (storage.dischargeEfficiencyPercent ?? 100) / 100,
			wearCtPerKWh: storage.wearCostCtPerKWh ?? 0,
		};
	}

	/** Rebuilds the household load profile from the last LOAD_PROFILE_DAYS days in InfluxDB. */
	private async refreshProfile(): Promise<void> {
		const historySource = getHistorySourceFromAdapter(this.adapter);
		if (!isHistoryConfigured(historySource)) {
			return;
		}
		const consumerIds = new Set(this.entities.filter(e => e.category === "consumer").map(e => e.entityId));
		const relevant = this.entities.filter(e => consumerIds.has(e.entityId) || (e.parentId && consumerIds.has(e.parentId)));
		const end = new Date();
		const start = new Date(end.getTime() - LOAD_PROFILE_DAYS * 24 * 3600 * 1000);
		const points = new Map<string, Array<{ ts: number; powerW: number }>>();
		try {
			for (const entity of relevant) {
				if (entity.powerStateId) {
					points.set(entity.entityId, await queryHourlyActual(historySource, entity.powerStateId, start, end));
				}
			}
			const series = consumptionSeries(this.entities, points);
			if (series.length > 0) {
				this.profile = buildLoadProfile(series);
				await this.adapter.setStateAsync("plan.loadProfile", { val: JSON.stringify(this.profile), ack: true });
			}
		} catch (error) {
			this.adapter.log.warn(`Load profile refresh failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Restores today's/yesterday's cost accumulators after an adapter restart. */
	private async restoreCosts(): Promise<void> {
		const now = Date.now();
		const todayKey = localDayKey(now);
		const yesterdayDate = new Date(now);
		yesterdayDate.setDate(yesterdayDate.getDate() - 1);
		const storedKey = (await this.adapter.getStateAsync("costs.todayDate"))?.val;
		const storedToday = (await this.getNumberState("costs.today")) ?? 0;
		const storedYesterday = (await this.getNumberState("costs.yesterday")) ?? 0;
		if (matchesLocalDay(storedKey, now)) {
			this.cost = { dayKey: todayKey, todayCt: storedToday * 100, yesterdayCt: storedYesterday * 100, lastSampleTs: 0 };
		} else if (matchesLocalDay(storedKey, yesterdayDate.getTime())) {
			this.cost = { dayKey: todayKey, todayCt: 0, yesterdayCt: storedToday * 100, lastSampleTs: 0 };
		} else {
			this.cost = { dayKey: todayKey, todayCt: 0, yesterdayCt: 0, lastSampleTs: 0 };
		}
		await this.writeCosts();
	}

	/**
	 * Integrates grid cost: import x current price - export x current feed-in, sampled every minute
	 * from summary.grid.power (an approximation of the real meter reading).
	 */
	private async sampleCost(): Promise<void> {
		const now = Date.now();
		const dayKey = localDayKey(now);
		if (dayKey !== this.cost.dayKey) {
			this.cost = { dayKey, todayCt: 0, yesterdayCt: this.cost.todayCt, lastSampleTs: this.cost.lastSampleTs };
		}
		const last = this.cost.lastSampleTs;
		this.cost.lastSampleTs = now;
		const gridW = await this.getNumberState("summary.grid.power");
		const slot = findSlotAt(this.prices.getPriceSeries(now), now);
		if (last === 0 || now - last > COST_MAX_GAP_MS || gridW === undefined || !slot) {
			await this.writeCosts();
			return;
		}
		const kWh = (gridW / 1000) * ((now - last) / (3600 * 1000));
		const feedIn = this.prices.getFeedInForSlot(slot) ?? 0;
		this.cost.todayCt += kWh >= 0 ? kWh * slot.totalCt : kWh * feedIn;
		await this.writeCosts();
	}

	private async writeCosts(): Promise<void> {
		await this.adapter.setStateAsync("costs.today", { val: Math.round(this.cost.todayCt * 100) / 10000, ack: true });
		await this.adapter.setStateAsync("costs.yesterday", { val: Math.round(this.cost.yesterdayCt * 100) / 10000, ack: true });
		await this.adapter.setStateAsync("costs.todayDate", { val: this.cost.dayKey, ack: true });
	}

	/**
	 * Own numeric state value, or undefined if missing/non-numeric.
	 *
	 * @param id - own state id
	 */
	private async getNumberState(id: string): Promise<number | undefined> {
		const state = await this.adapter.getStateAsync(id);
		return typeof state?.val === "number" ? state.val : undefined;
	}

	private async getForecastSeries(): Promise<ForecastPoint[]> {
		const state = await this.adapter.getStateAsync("summary.producer.forecastPower");
		if (typeof state?.val !== "string") {
			return [];
		}
		try {
			const parsed: unknown = JSON.parse(state.val);
			if (!Array.isArray(parsed)) {
				return [];
			}
			return parsed
				.filter((p): p is ForecastPoint => typeof p === "object" && p !== null && typeof p.ts === "number" && typeof p.powerW === "number")
				.sort((a, b) => a.ts - b.ts);
		} catch {
			return [];
		}
	}

	private async createObjects(): Promise<void> {
		type Common = Partial<ioBroker.StateCommon>;
		const state = async (id: string, common: Common): Promise<void> => {
			await this.adapter.extendObjectAsync(id, { type: "state", common: { read: true, write: false, ...common }, native: {} });
		};

		await this.adapter.extendObjectAsync("recommendation", { type: "channel", common: { name: tAll("Consumption/sell recommendation") }, native: {} });
		await state("recommendation.nowSurplusPower", {
			name: tAll("Current surplus (negative = deficit)"),
			role: "value.power",
			type: "number",
			unit: "W",
			def: 0,
		});
		await state("recommendation.forecastSurplusPower", { name: tAll("Forecasted surplus power series"), role: "json", type: "string" });
		await state("recommendation.todaySurplusKWh", {
			name: tAll("Total forecasted surplus today"),
			role: "value.energy",
			type: "number",
			unit: "kWh",
			def: 0,
		});
		await state("recommendation.tomorrowSurplusKWh", {
			name: tAll("Total forecasted surplus tomorrow"),
			role: "value.energy",
			type: "number",
			unit: "kWh",
			def: 0,
		});
		await state("recommendation.flexWindowStart", {
			name: tAll("Cheapest start for the configured flexible load (0 if none)"),
			role: "date",
			type: "number",
			def: 0,
		});
		await state("recommendation.flexWindowEnd", {
			name: tAll("End of the cheapest flexible-load window (0 if none)"),
			role: "date",
			type: "number",
			def: 0,
		});
		await state("recommendation.flexWindowCost", {
			name: tAll("Expected cost of the flexible-load run"),
			role: "value",
			type: "number",
			unit: "€",
			def: 0,
		});
		await state("recommendation.flexWindowAvgPrice", {
			name: tAll("Average cost per kWh of the flexible-load run"),
			role: "value",
			type: "number",
			unit: "ct/kWh",
			def: 0,
		});
		await state("recommendation.flexWindowSource", {
			name: tAll("Dominant energy source of the flexible-load run (pv/battery/grid)"),
			role: "text",
			type: "string",
			def: "",
		});
		await state("recommendation.text", { name: tAll("Human-readable recommendation text"), role: "text", type: "string", def: "" });
		// Replaced by flexWindow* (planner marginal costs instead of raw PV surplus).
		for (const old of ["bestWindowStart", "bestWindowEnd", "bestWindowAvgPower"]) {
			await this.adapter.delObjectAsync(`recommendation.${old}`).catch(() => undefined);
		}

		await this.adapter.extendObjectAsync("plan", { type: "channel", common: { name: tAll("Advisory energy plan (no active control)") }, native: {} });
		await state("plan.status", {
			name: tAll("Plan status"),
			role: "text",
			type: "string",
			def: "",
			states: { ok: "ok", noBattery: "no battery configured", noPriceData: "no price data" },
		});
		await state("plan.json", {
			name: tAll("Plan slots (mode, target SoC, prices, flows, marginal cost, reason)"),
			role: "json",
			type: "string",
			def: "[]",
		});
		await state("plan.currentMode", {
			name: tAll("Planned mode for the current slot"),
			role: "text",
			type: "string",
			def: "",
			states: { selfConsumption: "selfConsumption", chargeFromGrid: "chargeFromGrid", holdBattery: "holdBattery", exportFirst: "exportFirst" },
		});
		await state("plan.currentModeLabel", { name: tAll("Planned mode for the current slot (display label)"), role: "text", type: "string", def: "" });
		await state("plan.currentReason", { name: tAll("Reason for the current slot's mode"), role: "text", type: "string", def: "" });
		await state("plan.currentTargetSoc", {
			name: tAll("Planned battery SoC at the end of the current slot"),
			role: "value.battery",
			type: "number",
			unit: "%",
			def: 0,
		});
		await state("plan.marginalCost", {
			name: tAll("Cost of one additional kWh consumed right now"),
			role: "value",
			type: "number",
			unit: "ct/kWh",
			def: 0,
		});
		await state("plan.expectedSavings", {
			name: tAll("Expected advantage of the plan over pure self-consumption (plan horizon)"),
			role: "value",
			type: "number",
			unit: "€",
			def: 0,
		});
		await state("plan.horizonEnd", { name: tAll("End of the plan horizon"), role: "date", type: "number", def: 0 });
		await state("plan.lastUpdate", { name: tAll("Last plan computation"), role: "date", type: "number", def: 0 });
		await state("plan.loadProfile", { name: tAll("Household load profile (median W per hour, workday/weekend)"), role: "json", type: "string", def: "" });

		await this.adapter.extendObjectAsync("costs", {
			type: "channel",
			common: { name: tAll("Grid electricity cost (approximation from the grid entity)") },
			native: {},
		});
		await state("costs.today", { name: tAll("Grid cost today (import x price - export x feed-in)"), role: "value", type: "number", unit: "€", def: 0 });
		await state("costs.yesterday", { name: tAll("Grid cost yesterday"), role: "value", type: "number", unit: "€", def: 0 });
		await state("costs.todayDate", { name: tAll("Local day the costs.today accumulator belongs to (internal)"), role: "text", type: "string", def: "" });
	}
}
