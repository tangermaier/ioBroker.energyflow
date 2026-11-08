import assert from "node:assert";
import { computePlan, findFlexWindow, type BatteryParams, type PlanInputSlot } from "./optimizer.js";

const Q = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 31, 0, 0);

/** Builds n quarter-hour slots from a per-slot generator. */
function slots(n: number, f: (i: number) => Partial<PlanInputSlot>): PlanInputSlot[] {
	return Array.from({ length: n }, (_, i) => ({
		startTs: T0 + i * Q,
		endTs: T0 + (i + 1) * Q,
		priceCt: 40,
		feedInCt: 7.08,
		pvW: 0,
		loadW: 0,
		...f(i),
	}));
}

function battery(overrides: Partial<BatteryParams> = {}): BatteryParams {
	return {
		capacityKWh: 30.72,
		socPercent: 50,
		minSocPercent: 20,
		maxSocPercent: 100,
		maxPowerKW: 8,
		chargeEfficiency: 0.95,
		dischargeEfficiency: 0.95,
		wearCtPerKWh: 3,
		...overrides,
	};
}

const opts = { now: T0, exportLimitW: 6900, terminalValueCtPerKWh: 35 };

describe("planner optimizer", () => {
	it("without a battery only uses self-consumption and prices import/export correctly", () => {
		const input = slots(4, i => (i < 2 ? { loadW: 1000 } : { pvW: 3000, loadW: 1000 }));
		const plan = computePlan(input, undefined, opts);
		assert.ok(plan.slots.every(s => s.mode === "selfConsumption"));
		// 2 slots x 0.25 kWh import at 40 ct, 2 slots x 0.5 kWh export at 7.08 ct
		assert.ok(Math.abs(plan.totalCostCt - (2 * 0.25 * 40 - 2 * 0.5 * 7.08)) < 1e-9);
		assert.ok(Math.abs(plan.expectedSavingsCt) < 1e-9);
	});

	it("models small night loads exactly (continuous SoC)", () => {
		const input = slots(4, () => ({ loadW: 300 }));
		const plan = computePlan(input, battery(), { ...opts, terminalValueCtPerKWh: 31.5 });
		assert.ok(plan.slots.every(s => s.mode === "selfConsumption"));
		const drop = ((0.3 * 1) / 0.95 / 30.72) * 100;
		assert.ok(Math.abs(plan.slots[0].socStartPercent - plan.slots[3].socEndPercent - drop) < 1e-6);
		assert.ok(plan.slots.every(s => Math.abs(s.gridW) < 1e-6));
	});

	it("charges from the grid when the price spread beats losses and wear", () => {
		// 2 h at 30 ct, then 4 h at 60 ct with 2 kW load, battery at min SoC
		const input = slots(24, i => (i < 8 ? { priceCt: 30 } : { priceCt: 60, loadW: 2000 }));
		const plan = computePlan(input, battery({ socPercent: 20 }), { ...opts, terminalValueCtPerKWh: 0 });
		assert.ok(plan.slots.slice(0, 8).some(s => s.mode === "chargeFromGrid"));
		assert.ok(plan.slots.slice(8).every(s => s.mode !== "chargeFromGrid"));
		assert.ok(plan.expectedSavingsCt > 0);
		// discharge in the expensive part covers the load
		assert.ok(plan.slots.slice(8).some(s => s.batteryW < 0));
	});

	it("does not charge from the grid when the spread is too small", () => {
		// 40 / 0.9025 + 3 = 47.3 ct > 42 ct -> not worth it
		const input = slots(24, i => (i < 8 ? { priceCt: 40 } : { priceCt: 42, loadW: 2000 }));
		const plan = computePlan(input, battery({ socPercent: 20 }), { ...opts, terminalValueCtPerKWh: 0 });
		assert.ok(plan.slots.every(s => s.mode !== "chargeFromGrid"));
	});

	it("holds the battery during cheap hours to cover a later expensive peak", () => {
		// little energy left: 2 h cheap-ish (35 ct) then 2 h expensive (70 ct), same load
		const input = slots(16, i => ({ priceCt: i < 8 ? 35 : 70, loadW: 2000 }));
		const plan = computePlan(input, battery({ socPercent: 25 }), { ...opts, terminalValueCtPerKWh: 0 });
		assert.ok(plan.slots.slice(0, 8).some(s => s.mode === "holdBattery"));
		assert.ok(plan.expectedSavingsCt > 0);
	});

	it("exports first in the morning to avoid curtailment at noon", () => {
		// battery 80 % (6.1 kWh room), morning 4 kW surplus for 2 h, then 3 h of 8.5 kW surplus:
		// 1.6 kW above the 6.9 kW export limit = 4.8 kWh AC that only fits if the morning exports.
		const input = slots(20, i => ({ pvW: i < 8 ? 4500 : 9000, loadW: 500 }));
		const plan = computePlan(input, battery({ socPercent: 80 }), { ...opts, terminalValueCtPerKWh: 35 });
		assert.ok(plan.slots.slice(0, 8).some(s => s.mode === "exportFirst"));
		const curtailedPlan = plan.slots.reduce((sum, s) => sum + s.curtailedW, 0);
		assert.ok(curtailedPlan < 1, `expected (almost) no curtailment, got ${curtailedPlan} W-slots`);
		assert.ok(plan.expectedSavingsCt > 0);
	});

	it("prefers charging during negative-price (unpaid) slots and exporting while paid", () => {
		// 3 kW surplus all along, battery has room for only ~2 h of it; 2nd half unpaid (feed-in 0)
		const input = slots(16, i => ({ pvW: 3500, loadW: 500, feedInCt: i < 8 ? 7.08 : 0 }));
		const plan = computePlan(input, battery({ socPercent: 80, maxSocPercent: 100 }), { ...opts, terminalValueCtPerKWh: 10 });
		assert.ok(plan.slots.slice(0, 8).some(s => s.mode === "exportFirst"));
		const paidExport = plan.slots.slice(0, 8).reduce((sum, s) => sum + Math.max(0, -s.gridW), 0);
		const baselinePaidExportHigher = plan.expectedSavingsCt > 0;
		assert.ok(paidExport > 0 && baselinePaidExportHigher);
	});

	it("credits leftover energy at the horizon end instead of dumping it", () => {
		// flat 30 ct, terminal value 31.5 ct: discharging saves only 30 x 0.95 = 28.5 ct per stored kWh
		// (keep it), grid charging would cost 30 / 0.95 = 31.6 ct per stored kWh (don't buy either).
		// (Per slot the advantage must exceed the 0.5 ct mode tie epsilon: 0.263 x 31.5 - 7.5 = 0.79 ct.)
		const input = slots(8, () => ({ priceCt: 30, loadW: 1000 }));
		const plan = computePlan(input, battery({ socPercent: 60, wearCtPerKWh: 0 }), { ...opts, terminalValueCtPerKWh: 31.5 });
		assert.ok(plan.slots.every(s => s.mode === "holdBattery"), plan.slots.map(s => `${s.mode} ${s.socEndPercent.toFixed(2)}`).join("; "));
	});

	it("only counts the remaining part of a slot already in progress", () => {
		const input = slots(2, () => ({ loadW: 1000 }));
		const plan = computePlan(input, undefined, { ...opts, now: T0 + Q / 3 * 2 });
		// 5 min remaining of slot 0 + full slot 1: (1/12 + 1/4) kWh at 40 ct
		assert.ok(Math.abs(plan.totalCostCt - (1 / 12 + 1 / 4) * 40) < 1e-9);
	});

	it("finds the PV surplus window for a flexible load", () => {
		const input = slots(32, i => ({ priceCt: 40, loadW: 300, pvW: i >= 16 && i < 28 ? 5000 : 0 }));
		const bat = battery({ socPercent: 100 });
		const plan = computePlan(input, bat, opts);
		const w = findFlexWindow(plan, bat, T0, 2, 2);
		assert.ok(w);
		assert.ok(w.startTs >= T0 + 16 * Q && w.endTs <= T0 + 28 * Q);
		assert.strictEqual(w.mainSource, "pv");
		assert.ok(w.avgCtPerKWh <= 7.08 + 1e-9);
	});

	it("returns no flex window when the horizon is shorter than the run time", () => {
		const input = slots(4, () => ({ loadW: 300 }));
		const plan = computePlan(input, undefined, opts);
		assert.strictEqual(findFlexWindow(plan, undefined, T0, 2, 2), undefined);
	});

	it("plans a realistic 35 h quarter-hour horizon quickly", () => {
		const input = slots(140, i => ({
			priceCt: 38 + 12 * Math.sin(i / 10),
			pvW: Math.max(0, 9000 * Math.sin(((i % 96) - 28) / 40 * Math.PI)),
			loadW: 400 + 1500 * ((i % 7) === 0 ? 1 : 0),
		}));
		const started = Date.now();
		const plan = computePlan(input, battery(), opts);
		const elapsed = Date.now() - started;
		assert.strictEqual(plan.slots.length, 140);
		assert.ok(elapsed < 1000, `took ${elapsed} ms`);
		console.log(`      (35 h horizon planned in ${elapsed} ms)`);
	});
});
