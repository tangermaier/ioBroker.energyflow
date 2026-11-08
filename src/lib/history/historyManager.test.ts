import assert from "node:assert";
import type { EntityDefinition } from "../entityModel.js";
import { localDayKey, sumCategoryTotals, sumDirectionalLossTotals, sumEnergyTotals, type EnergyTotals } from "./historyManager.js";

function entity(overrides: Partial<EntityDefinition>): EntityDefinition {
	return {
		entityId: "e1",
		name: "Entity 1",
		category: "consumer",
		powerStateId: "some.state.power",
		powerUnit: "W",
		invertSign: false,
		noiseThresholdW: 0,
		invertInParent: false,
		color: "#8892a0",
		powerSource: "measured",
		staleAfterS: 120,
		...overrides,
	};
}

describe("historyManager", () => {
	describe("localDayKey", () => {
		it("gives the same key for two timestamps on the same local day", () => {
			const morning = new Date(2026, 8, 11, 6, 0, 0).getTime();
			const evening = new Date(2026, 8, 11, 23, 30, 0).getTime();
			assert.strictEqual(localDayKey(morning), localDayKey(evening));
		});

		it("gives a different key for the next day", () => {
			const today = new Date(2026, 8, 11, 23, 59, 0).getTime();
			const tomorrow = new Date(2026, 8, 12, 0, 1, 0).getTime();
			assert.notStrictEqual(localDayKey(today), localDayKey(tomorrow));
		});
	});

	describe("sumEnergyTotals", () => {
		const today = new Date(2026, 8, 11, 12, 0, 0);
		const todayKey = localDayKey(today.getTime());
		const yesterdayKey = localDayKey(new Date(2026, 8, 10, 12, 0, 0).getTime());

		it("buckets hourly points into today/yesterday and sums everything into last7Days", () => {
			const points = [
				{ ts: new Date(2026, 8, 9, 10, 0, 0).getTime(), powerW: 1000 }, // 2 days ago
				{ ts: new Date(2026, 8, 10, 10, 0, 0).getTime(), powerW: 2000 }, // yesterday
				{ ts: new Date(2026, 8, 11, 10, 0, 0).getTime(), powerW: 3000 }, // today
			];
			const totals = sumEnergyTotals(points, entity({}), todayKey, yesterdayKey);
			assert.strictEqual(totals.today, 3);
			assert.strictEqual(totals.yesterday, 2);
			assert.strictEqual(totals.last7Days, 6);
		});

		it("files the window ending at midnight (InfluxDB window-end timestamp) under the previous day", () => {
			// mean over 23:00-24:00 yesterday carries ts = today 00:00
			const points = [{ ts: new Date(2026, 8, 11, 0, 0, 0).getTime(), powerW: 500 }];
			const totals = sumEnergyTotals(points, entity({}), todayKey, yesterdayKey);
			assert.strictEqual(totals.yesterday, 0.5);
			assert.strictEqual(totals.today, 0);
		});

		it("applies unit conversion and sign inversion the same way live power normalization does", () => {
			const points = [{ ts: today.getTime(), powerW: 1.5 }]; // logged in kW, per entity.powerUnit
			const totals = sumEnergyTotals(points, entity({ powerUnit: "kW", invertSign: true }), todayKey, yesterdayKey);
			assert.strictEqual(totals.today, -1.5);
		});

		it("zeroes out readings below the noise threshold before integrating", () => {
			const points = [{ ts: today.getTime(), powerW: 8 }];
			const totals = sumEnergyTotals(points, entity({ noiseThresholdW: 10 }), todayKey, yesterdayKey);
			assert.strictEqual(totals.today, 0);
		});

		it("returns all zeros for an empty series", () => {
			const totals = sumEnergyTotals([], entity({}), todayKey, yesterdayKey);
			assert.deepStrictEqual(totals, { today: 0, yesterday: 0, last7Days: 0 });
		});
	});

	describe("sumDirectionalLossTotals", () => {
		const today = new Date(2026, 8, 11, 12, 0, 0);
		const todayKey = localDayKey(today.getTime());
		const yesterdayKey = localDayKey(new Date(2026, 8, 10, 12, 0, 0).getTime());
		const storage = entity({ category: "storage" });

		it("counts only the charging (positive) portion, scaled by the loss factor", () => {
			const points = [
				{ ts: today.getTime(), powerW: 1000 }, // charging
				{ ts: today.getTime(), powerW: -500 }, // discharging, same hour bucket for the test's purposes
			];
			const totals = sumDirectionalLossTotals(points, storage, todayKey, yesterdayKey, 95, "charge");
			// only the +1000W point counts: 1 kWh * (1 - 0.95) = 0.05 kWh
			assert.ok(Math.abs(totals.today - 0.05) < 1e-9);
		});

		it("counts only the discharging (negative) portion, scaled by the loss factor", () => {
			const points = [
				{ ts: today.getTime(), powerW: 1000 },
				{ ts: today.getTime(), powerW: -2000 },
			];
			const totals = sumDirectionalLossTotals(points, storage, todayKey, yesterdayKey, 95, "discharge");
			// only the -2000W point counts: 2 kWh * (1 - 0.95) = 0.1 kWh
			assert.ok(Math.abs(totals.today - 0.1) < 1e-9);
		});

		it("returns zero when nothing flows in the requested direction", () => {
			const points = [{ ts: today.getTime(), powerW: 1000 }];
			const totals = sumDirectionalLossTotals(points, storage, todayKey, yesterdayKey, 95, "discharge");
			assert.strictEqual(totals.today, 0);
		});
	});

	describe("sumCategoryTotals", () => {
		const totalsA: EnergyTotals = { today: 1, yesterday: 2, last7Days: 3 };
		const totalsB: EnergyTotals = { today: 10, yesterday: 20, last7Days: 30 };
		const restForParent: EnergyTotals = { today: 4, yesterday: 5, last7Days: 6 };

		it("sums only entities in the requested category, using each entity's own totals", () => {
			const entities = [entity({ entityId: "a", category: "producer" }), entity({ entityId: "b", category: "consumer" })];
			const totalsByEntity = new Map([
				["a", totalsA],
				["b", totalsB],
			]);
			const result = sumCategoryTotals("producer", entities, totalsByEntity, new Map());
			assert.deepStrictEqual(result, totalsA);
		});

		it("uses a parent's rest-energy totals instead of its raw totals when it has children", () => {
			const entities = [entity({ entityId: "parent", category: "producer" })];
			const totalsByEntity = new Map([["parent", totalsA]]);
			const restTotalsByParent = new Map([["parent", restForParent]]);
			const result = sumCategoryTotals("producer", entities, totalsByEntity, restTotalsByParent);
			assert.deepStrictEqual(result, restForParent);
		});

		it("returns all zeros when no entity matches the category", () => {
			const entities = [entity({ entityId: "a", category: "consumer" })];
			const result = sumCategoryTotals("producer", entities, new Map([["a", totalsA]]), new Map());
			assert.deepStrictEqual(result, { today: 0, yesterday: 0, last7Days: 0 });
		});
	});
});
