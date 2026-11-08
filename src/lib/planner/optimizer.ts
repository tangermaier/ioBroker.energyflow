/**
 * Advisory battery/consumption planner - pure, ioBroker-free, unit-testable.
 *
 * Dynamic programming over the battery state of charge: for every slot of the horizon (usually
 * the known Tibber quarter-hours) and every SoC grid point, the cheapest cost-to-go is computed
 * backwards; the plan is then rolled forward from the exact current SoC. The SoC itself stays
 * continuous (cost-to-go is linearly interpolated between grid points), so tiny night-time
 * loads (300 W for 15 min = 0.25 % SoC) are modelled exactly instead of being rounded away.
 *
 * Per slot the planner chooses one of four modes, each with an exactly computed battery energy
 * change:
 * - `selfConsumption` - what the inverter does on its own: surplus charges, deficit discharges
 * - `chargeFromGrid` - charge beyond the PV surplus from the grid (at 25/50/100 % of max power)
 * - `holdBattery` - don't discharge, cover a deficit from the grid (saves energy for later)
 * - `exportFirst` - export PV surplus up to the export limit, only charge the overflow
 * Discharging into the grid is deliberately not a mode (with a fixed feed-in tariff it never pays off).
 *
 * Energy conventions: `deltaKWh` is the change of energy stored in the battery (battery side);
 * AC energy is `delta / etaCharge` when charging and `-delta * etaDischarge` when discharging.
 * Wear cost is charged per discharged (battery-side) kWh. Leftover energy above the minimum SoC
 * at the horizon end is credited at `terminalValueCtPerKWh`, so the plan doesn't dump the
 * battery just because the known prices end at midnight.
 */

import { fmtNum, t } from "../i18n/i18n.js";

/** One input slot - prices in ct/kWh, powers in W (averages over the slot). */
export interface PlanInputSlot {
	/** Slot start (ms, inclusive) */
	startTs: number;
	/** Slot end (ms, exclusive) */
	endTs: number;
	/** Gross grid purchase price */
	priceCt: number;
	/** Feed-in remuneration (0 during negative spot prices) */
	feedInCt: number;
	/** Forecast PV production (all producers) */
	pvW: number;
	/** Forecast household consumption */
	loadW: number;
	/** Tibber price level, passed through for display */
	level?: string;
}

/** Battery parameters as the planner uses them. */
export interface BatteryParams {
	/** Nominal capacity in kWh */
	capacityKWh: number;
	/** Current SoC in percent */
	socPercent: number;
	/** Lowest SoC the plan may discharge to, in percent */
	minSocPercent: number;
	/** Highest SoC the plan may charge to, in percent */
	maxSocPercent: number;
	/** Max AC charge/discharge power in kW (Infinity = unlimited) */
	maxPowerKW: number;
	/** Charge efficiency 0..1 */
	chargeEfficiency: number;
	/** Discharge efficiency 0..1 */
	dischargeEfficiency: number;
	/** Wear cost per discharged (battery-side) kWh, in ct */
	wearCtPerKWh: number;
}

/** Global planner options. */
export interface PlannerOptions {
	/** Planning starts here - a slot already in progress is only counted from `now` on */
	now: number;
	/** Grid export limit in W (Infinity = unlimited); surplus beyond it is curtailed */
	exportLimitW: number;
	/** Value credited per kWh left in the battery (above min SoC) at the horizon end */
	terminalValueCtPerKWh: number;
	/** SoC grid resolution in percent (default 0.5) */
	socStepPercent?: number;
}

/** The four advisory modes (see file header). */
export type PlanMode = "selfConsumption" | "chargeFromGrid" | "holdBattery" | "exportFirst";

/** One output slot of the plan. Powers in W (slot averages), prices/costs in ct. */
export interface PlanSlot {
	/** Slot start (ms) */
	startTs: number;
	/** Slot end (ms) */
	endTs: number;
	/** Chosen mode */
	mode: PlanMode;
	/** SoC at the start of the slot (or at `now` for the current slot) */
	socStartPercent: number;
	/** Planned SoC at the slot end - the "target SoC" a Phase-4 executor would steer to */
	socEndPercent: number;
	/** Gross purchase price */
	priceCt: number;
	/** Feed-in remuneration */
	feedInCt: number;
	/** Tibber price level (empty without Tibber) */
	level: string;
	/** Forecast PV power */
	pvW: number;
	/** Forecast household load */
	loadW: number;
	/** Grid exchange, positive = import, negative = export */
	gridW: number;
	/** Battery AC power, positive = charging */
	batteryW: number;
	/** PV surplus that can't be exported (export limit) nor stored */
	curtailedW: number;
	/** Cost of one additional kWh consumed in this slot, in ct */
	marginalCostCt: number;
	/** Marginal value of one more kWh stored in the battery after this slot, in ct (0 without battery) */
	storedValueCt: number;
	/** Net cost of this slot in ct (import - export revenue + wear) */
	costCt: number;
	/** Short German explanation of the decision */
	reason: string;
}

/** Cheapest run window for the configured flexible load. */
export interface FlexWindow {
	/** Recommended start (ms) */
	startTs: number;
	/** Expected end (ms) */
	endTs: number;
	/** Expected cost of the run in ct */
	costCt: number;
	/** Average cost per kWh in ct */
	avgCtPerKWh: number;
	/** Dominant energy source for the run */
	mainSource: "pv" | "battery" | "grid";
}

/** Result of computePlan(). */
export interface PlanResult {
	/** The planned slots, starting with the current one */
	slots: PlanSlot[];
	/** Total cost of the plan in ct, minus the terminal credit for leftover battery energy */
	totalCostCt: number;
	/** Same for pure self-consumption (what the inverter does without any plan) */
	baselineCostCt: number;
	/** baselineCostCt - totalCostCt */
	expectedSavingsCt: number;
}

/** Cost difference below which a non-default mode is not worth recommending (avoids flicker), in ct. */
const MODE_TIE_EPSILON_CT = 0.5;
/** Grid-charge power fractions offered as candidate actions. */
const GRID_CHARGE_FRACTIONS = [0.25, 0.5, 1];
const MS_PER_HOUR = 3600 * 1000;

interface SlotFlows {
	importKWh: number;
	exportKWh: number;
	curtailedKWh: number;
	chargeAcKWh: number;
	dischargeAcKWh: number;
	costCt: number;
}

interface Candidate {
	mode: PlanMode;
	deltaKWh: number;
}

/** Internal per-slot context with the derived duration. */
interface Ctx extends PlanInputSlot {
	hours: number;
}

/**
 * Battery-agnostic flows/cost of one slot for a given battery energy change.
 *
 * @param slot - the slot
 * @param deltaKWh - change of stored energy (battery side), + = charge
 * @param bat - battery params (undefined = no battery)
 * @param exportLimitW - grid export limit in W
 */
function slotFlows(slot: Ctx, deltaKWh: number, bat: BatteryParams | undefined, exportLimitW: number): SlotFlows {
	const chargeAcKWh = deltaKWh > 0 && bat ? deltaKWh / bat.chargeEfficiency : 0;
	const dischargeAcKWh = deltaKWh < 0 && bat ? -deltaKWh * bat.dischargeEfficiency : 0;
	const wear = deltaKWh < 0 && bat ? -deltaKWh * bat.wearCtPerKWh : 0;
	const net = ((slot.loadW - slot.pvW) / 1000) * slot.hours + chargeAcKWh - dischargeAcKWh;
	const importKWh = Math.max(0, net);
	const surplus = Math.max(0, -net);
	const exportKWh = Math.min(surplus, (exportLimitW / 1000) * slot.hours);
	const curtailedKWh = surplus - exportKWh;
	return {
		importKWh,
		exportKWh,
		curtailedKWh,
		chargeAcKWh,
		dischargeAcKWh,
		costCt: importKWh * slot.priceCt - exportKWh * slot.feedInCt + wear,
	};
}

/**
 * Candidate actions for one slot from a given stored energy level.
 *
 * @param slot - the slot
 * @param energyKWh - currently stored energy above 0 % (battery side)
 * @param bat - battery params
 * @param exportLimitW - grid export limit in W
 */
function candidates(slot: Ctx, energyKWh: number, bat: BatteryParams | undefined, exportLimitW: number): Candidate[] {
	if (!bat) {
		return [{ mode: "selfConsumption", deltaKWh: 0 }];
	}
	const minE = (bat.minSocPercent / 100) * bat.capacityKWh;
	const maxE = (bat.maxSocPercent / 100) * bat.capacityKWh;
	const room = Math.max(0, maxE - energyKWh);
	const avail = Math.max(0, energyKWh - minE);
	const maxAcKWh = bat.maxPowerKW * slot.hours;
	const maxChargeStored = Math.min(room, maxAcKWh * bat.chargeEfficiency);
	const surplusAcKWh = (Math.max(0, slot.pvW - slot.loadW) / 1000) * slot.hours;
	const deficitAcKWh = (Math.max(0, slot.loadW - slot.pvW) / 1000) * slot.hours;

	const list: Candidate[] = [];
	// Self-consumption: surplus charges (as far as room/power allow), deficit discharges.
	const naturalCharge = Math.min(surplusAcKWh * bat.chargeEfficiency, maxChargeStored);
	const naturalDischarge = Math.min(deficitAcKWh / bat.dischargeEfficiency, avail, maxAcKWh / bat.dischargeEfficiency);
	const natural = naturalCharge > 0 ? naturalCharge : -naturalDischarge;
	list.push({ mode: "selfConsumption", deltaKWh: natural });

	if (naturalDischarge > 1e-9) {
		list.push({ mode: "holdBattery", deltaKWh: 0 });
	}
	if (naturalCharge > 1e-9) {
		// Export first, charge only what would otherwise be curtailed.
		const overflowAc = Math.max(0, surplusAcKWh - (exportLimitW / 1000) * slot.hours);
		const exportFirstCharge = Math.min(overflowAc * bat.chargeEfficiency, maxChargeStored);
		if (exportFirstCharge < naturalCharge - 1e-9) {
			list.push({ mode: "exportFirst", deltaKWh: exportFirstCharge });
		}
	}
	for (const fraction of GRID_CHARGE_FRACTIONS) {
		const target = Math.min(room, maxAcKWh * fraction * bat.chargeEfficiency);
		if (target > naturalCharge + 1e-9 && target > 1e-9) {
			list.push({ mode: "chargeFromGrid", deltaKWh: target });
		}
	}
	return list;
}

/**
 * Linear interpolation of a value-function row at a stored energy level.
 *
 * @param row - cost-to-go per grid point
 * @param energyKWh - stored energy
 * @param gridMinE - energy of grid point 0
 * @param stepKWh - energy per grid step
 */
function interp(row: Float64Array, energyKWh: number, gridMinE: number, stepKWh: number): number {
	if (row.length === 1 || stepKWh <= 0) {
		return row[0];
	}
	const x = (energyKWh - gridMinE) / stepKWh;
	if (x <= 0) {
		// Below the grid (only possible at the very start) - extrapolate with the first segment's slope.
		return row[0] + (row[1] - row[0]) * x;
	}
	if (x >= row.length - 1) {
		const n = row.length - 1;
		return row[n] + (row[n] - row[n - 1]) * (x - n);
	}
	const i = Math.floor(x);
	const f = x - i;
	return row[i] * (1 - f) + row[i + 1] * f;
}

/**
 * Formats a ct value German-style with one decimal ("38,1").
 *
 * @param v - value in ct
 */
function ct(v: number): string {
	return fmtNum(v, 1);
}

/**
 * Computes the optimal advisory plan.
 *
 * @param input - the horizon's slots (sorted, contiguous)
 * @param battery - battery params, or undefined if there is no (configured) battery
 * @param options - planner options
 */
export function computePlan(input: PlanInputSlot[], battery: BatteryParams | undefined, options: PlannerOptions): PlanResult {
	const bat = battery && battery.capacityKWh > 0 ? battery : undefined;
	const slots: Ctx[] = input.map(s => ({ ...s, hours: (s.endTs - Math.max(s.startTs, options.now)) / MS_PER_HOUR })).filter(s => s.hours > 1e-6);
	const n = slots.length;
	if (n === 0) {
		return { slots: [], totalCostCt: 0, baselineCostCt: 0, expectedSavingsCt: 0 };
	}

	const stepPercent = options.socStepPercent ?? 0.5;
	const gridMinE = bat ? (bat.minSocPercent / 100) * bat.capacityKWh : 0;
	const gridMaxE = bat ? (bat.maxSocPercent / 100) * bat.capacityKWh : 0;
	const stepKWh = bat ? (stepPercent / 100) * bat.capacityKWh : 0;
	const levels = bat ? Math.max(1, Math.round((gridMaxE - gridMinE) / stepKWh)) + 1 : 1;
	const energyAt = (i: number): number => (bat ? Math.min(gridMaxE, gridMinE + i * stepKWh) : 0);
	const terminal = (e: number): number => -Math.max(0, e - gridMinE) * options.terminalValueCtPerKWh;

	// Backward pass: V[t][i] = min cost from the start of slot t at grid level i.
	const V: Float64Array[] = new Array<Float64Array>(n + 1);
	V[n] = new Float64Array(levels);
	for (let i = 0; i < levels; i++) {
		V[n][i] = terminal(energyAt(i));
	}
	for (let t = n - 1; t >= 0; t--) {
		const row = new Float64Array(levels);
		for (let i = 0; i < levels; i++) {
			const e = energyAt(i);
			let best = Infinity;
			for (const c of candidates(slots[t], e, bat, options.exportLimitW)) {
				const cost = slotFlows(slots[t], c.deltaKWh, bat, options.exportLimitW).costCt + interp(V[t + 1], e + c.deltaKWh, gridMinE, stepKWh);
				if (cost < best) {
					best = cost;
				}
			}
			row[i] = best;
		}
		V[t] = row;
	}

	// Forward pass from the exact current SoC; prefer self-consumption unless clearly worse.
	const startE = bat ? Math.min(gridMaxE, Math.max(0, (bat.socPercent / 100) * bat.capacityKWh)) : 0;
	const out: PlanSlot[] = [];
	let e = startE;
	let total = 0;
	for (let t = 0; t < n; t++) {
		const slot = slots[t];
		const cands = candidates(slot, e, bat, options.exportLimitW);
		const scored = cands.map(c => ({
			c,
			flows: slotFlows(slot, c.deltaKWh, bat, options.exportLimitW),
			future: interp(V[t + 1], e + c.deltaKWh, gridMinE, stepKWh),
		}));
		const totalOf = (s: (typeof scored)[number]): number => s.flows.costCt + s.future;
		let chosen = scored[0];
		for (const s of scored) {
			if (totalOf(s) < totalOf(chosen) - MODE_TIE_EPSILON_CT) {
				chosen = s;
			}
		}
		const eEnd = e + chosen.c.deltaKWh;
		// Marginal value of one more stored kWh after this slot (ct per battery-side kWh).
		const lambda =
			bat && stepKWh > 0 ? Math.max(0, (interp(V[t + 1], eEnd - stepKWh, gridMinE, stepKWh) - interp(V[t + 1], eEnd, gridMinE, stepKWh)) / stepKWh) : 0;
		const sources = extraLoadSources(slot, chosen.flows, eEnd, lambda, bat);
		const marginal = sources.length > 0 ? sources[0].unitCt : slot.priceCt;
		const h = slot.hours;
		out.push({
			startTs: slot.startTs,
			endTs: slot.endTs,
			mode: chosen.c.mode,
			socStartPercent: bat ? (e / bat.capacityKWh) * 100 : 0,
			socEndPercent: bat ? (eEnd / bat.capacityKWh) * 100 : 0,
			priceCt: slot.priceCt,
			feedInCt: slot.feedInCt,
			level: slot.level ?? "",
			pvW: slot.pvW,
			loadW: slot.loadW,
			gridW: ((chosen.flows.importKWh - chosen.flows.exportKWh) / h) * 1000,
			batteryW: ((chosen.flows.chargeAcKWh - chosen.flows.dischargeAcKWh) / h) * 1000,
			curtailedW: (chosen.flows.curtailedKWh / h) * 1000,
			marginalCostCt: marginal,
			storedValueCt: lambda,
			costCt: chosen.flows.costCt,
			reason: explain(chosen.c.mode, slot, chosen.flows, lambda, bat),
		});
		total += chosen.flows.costCt;
		e = eEnd;
	}
	total += terminal(e);

	// Baseline: pure self-consumption from the same start.
	let eb = startE;
	let baseline = 0;
	for (const slot of slots) {
		const c = candidates(slot, eb, bat, options.exportLimitW)[0];
		baseline += slotFlows(slot, c.deltaKWh, bat, options.exportLimitW).costCt;
		eb += c.deltaKWh;
	}
	baseline += terminal(eb);

	return { slots: out, totalCostCt: total, baselineCostCt: baseline, expectedSavingsCt: baseline - total };
}

/** One way to supply additional consumption in a slot: up to `kWh` at `unitCt` per kWh. */
interface Source {
	kWh: number;
	unitCt: number;
	kind: "pv" | "battery" | "grid";
}

/**
 * Where additional consumption in a slot would come from, cheapest first: curtailed PV (free),
 * exported PV (lost feed-in), PV that would otherwise charge the battery (lost stored value),
 * extra battery discharge (stored value + wear), grid (price).
 *
 * @param slot - the slot
 * @param flows - the planned flows of the slot
 * @param eEnd - planned stored energy at the slot end
 * @param lambda - marginal value of one stored kWh after this slot, in ct
 * @param bat - battery params
 */
function extraLoadSources(slot: Ctx, flows: SlotFlows, eEnd: number, lambda: number, bat: BatteryParams | undefined): Source[] {
	const list: Source[] = [];
	if (flows.curtailedKWh > 1e-9) {
		list.push({ kWh: flows.curtailedKWh, unitCt: 0, kind: "pv" });
	}
	if (flows.exportKWh > 1e-9) {
		list.push({ kWh: flows.exportKWh, unitCt: slot.feedInCt, kind: "pv" });
	}
	if (bat) {
		if (flows.chargeAcKWh > 1e-9) {
			// Diverting energy that would otherwise charge the battery: the PV-surplus part is PV
			// energy (worth its stored value), a grid-charge part is simply grid energy.
			const unitCt = Math.min(slot.priceCt, lambda * bat.chargeEfficiency);
			const pvPart = Math.min(flows.chargeAcKWh, (Math.max(0, slot.pvW - slot.loadW) / 1000) * slot.hours);
			if (pvPart > 1e-9) {
				list.push({ kWh: pvPart, unitCt, kind: "pv" });
			}
			if (flows.chargeAcKWh - pvPart > 1e-9) {
				list.push({ kWh: flows.chargeAcKWh - pvPart, unitCt, kind: "grid" });
			}
		}
		const minE = (bat.minSocPercent / 100) * bat.capacityKWh;
		const headroomAc = Math.min(bat.maxPowerKW * slot.hours - flows.dischargeAcKWh, Math.max(0, eEnd - minE) * bat.dischargeEfficiency);
		if (headroomAc > 1e-9 && flows.chargeAcKWh <= 1e-9) {
			list.push({ kWh: headroomAc, unitCt: lambda / bat.dischargeEfficiency + bat.wearCtPerKWh, kind: "battery" });
		}
	}
	list.push({ kWh: Infinity, unitCt: slot.priceCt, kind: "grid" });
	return list.sort((a, b) => a.unitCt - b.unitCt);
}

/**
 * Short explanation for a slot's decision (current language).
 *
 * @param mode - the chosen mode
 * @param slot - the slot
 * @param flows - the chosen flows
 * @param lambda - marginal value of one stored kWh after this slot, in ct
 * @param bat - battery params
 */
function explain(mode: PlanMode, slot: Ctx, flows: SlotFlows, lambda: number, bat: BatteryParams | undefined): string {
	switch (mode) {
		case "chargeFromGrid":
			return t("Grid charging at {price} ct/kWh – stored energy is worth approx. {value} ct/kWh later", { price: ct(slot.priceCt), value: ct(lambda) });
		case "holdBattery": {
			const batteryCost = bat ? lambda / bat.dischargeEfficiency + bat.wearCtPerKWh : lambda;
			return t("Save the battery: grid power now {price} ct/kWh, battery energy is needed later at approx. {value} ct/kWh", {
				price: ct(slot.priceCt),
				value: ct(batteryCost),
			});
		}
		case "exportFirst":
			return flows.curtailedKWh > 0
				? t("Export first ({price} ct/kWh) – the battery will still be filled from PV later", { price: ct(slot.feedInCt) })
				: t("Export first ({price} ct/kWh) – the battery will still be filled from PV later, curtailment is avoided", { price: ct(slot.feedInCt) });
		default:
			if (flows.chargeAcKWh > 1e-9) {
				return t("PV surplus charges the battery");
			}
			if (flows.dischargeAcKWh > 1e-9) {
				return t("Battery covers the consumption");
			}
			if (flows.exportKWh > 1e-9 || flows.curtailedKWh > 1e-9) {
				return bat ? t("Battery full – surplus is exported") : t("Surplus is exported");
			}
			return bat ? t("Grid import (battery at minimum charge)") : t("Grid import");
	}
}

/**
 * Cheapest contiguous start for a flexible load of `durationH` hours at `powerKW`, evaluated on
 * the plan's per-slot extra-load cost. Windows start at slot boundaries (the first one "now");
 * the last slot of a window may be used partially.
 *
 * @param plan - the computed plan
 * @param battery - battery params (same as passed to computePlan)
 * @param now - planning time (ms)
 * @param durationH - load run time in hours
 * @param powerKW - load power in kW
 */
export function findFlexWindow(plan: PlanResult, battery: BatteryParams | undefined, now: number, durationH: number, powerKW: number): FlexWindow | undefined {
	const bat = battery && battery.capacityKWh > 0 ? battery : undefined;
	const slots = plan.slots;
	if (slots.length === 0 || durationH <= 0 || powerKW <= 0) {
		return undefined;
	}
	// Per-slot cost of running the load for a given number of hours within that slot.
	const slotCost = (s: PlanSlot, hours: number): { costCt: number; pvKWh: number; batKWh: number } => {
		const slotHours = (s.endTs - Math.max(s.startTs, now)) / MS_PER_HOUR;
		const ctx: Ctx = { ...s, hours: slotHours };
		const flows: SlotFlows = {
			importKWh: (Math.max(0, s.gridW) / 1000) * slotHours,
			exportKWh: (Math.max(0, -s.gridW) / 1000) * slotHours,
			curtailedKWh: (s.curtailedW / 1000) * slotHours,
			chargeAcKWh: (Math.max(0, s.batteryW) / 1000) * slotHours,
			dischargeAcKWh: (Math.max(0, -s.batteryW) / 1000) * slotHours,
			costCt: s.costCt,
		};
		const sources = extraLoadSources(ctx, flows, (s.socEndPercent / 100) * (bat?.capacityKWh ?? 0), s.storedValueCt, bat);
		let need = powerKW * hours;
		let cost = 0,
			pv = 0,
			batK = 0;
		for (const src of sources) {
			if (need <= 1e-9) {
				break;
			}
			const take = Math.min(need, src.kWh);
			cost += take * src.unitCt;
			if (src.kind === "pv") {
				pv += take;
			} else if (src.kind === "battery") {
				batK += take;
			}
			need -= take;
		}
		return { costCt: cost, pvKWh: pv, batKWh: batK };
	};

	let best: FlexWindow | undefined;
	for (let k = 0; k < slots.length; k++) {
		let remaining = durationH;
		let cost = 0,
			pv = 0,
			batK = 0;
		let endTs = slots[k].startTs;
		const startTs = Math.max(slots[k].startTs, now);
		let j = k;
		while (remaining > 1e-9 && j < slots.length) {
			const s = slots[j];
			const slotHours = (s.endTs - Math.max(s.startTs, now)) / MS_PER_HOUR;
			const use = Math.min(remaining, slotHours);
			const c = slotCost(s, use);
			cost += c.costCt;
			pv += c.pvKWh;
			batK += c.batKWh;
			remaining -= use;
			endTs = Math.max(s.startTs, now) + use * MS_PER_HOUR;
			j++;
		}
		if (remaining > 1e-9) {
			break; // horizon too short for this and all later starts
		}
		if (!best || cost < best.costCt - 1e-6) {
			const total = powerKW * durationH;
			const gridK = total - pv - batK;
			const mainSource = pv >= batK && pv >= gridK ? "pv" : batK >= gridK ? "battery" : "grid";
			best = { startTs, endTs, costCt: cost, avgCtPerKWh: cost / total, mainSource };
		}
	}
	return best;
}
