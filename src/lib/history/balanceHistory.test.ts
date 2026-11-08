import assert from "node:assert";
import type { EntityDefinition } from "../entityModel.js";
import { categoryHourly, combineHourly, effectiveHourly, inverterLossHourly, localDayKey, measuredHourly, totalsFromHourly } from "./balanceHistory.js";

const H = 3600 * 1000;
const at = (hour: number): number => new Date(2026, 9, 31, hour).getTime();

function entity(overrides: Partial<EntityDefinition>): EntityDefinition {
	return {
		entityId: "x",
		name: "x",
		category: "consumer",
		powerStateId: "s",
		powerUnit: "W",
		invertSign: false,
		noiseThresholdW: 0,
		invertInParent: false,
		color: "#000000",
		powerSource: "measured",
		staleAfterS: 120,
		...overrides,
	} as EntityDefinition;
}

describe("balanceHistory", () => {
	it("builds import minus export per hour, missing export counting 0", () => {
		const grid = entity({ entityId: "netz", category: "grid" });
		const series = measuredHourly(
			grid,
			[
				{ ts: at(10), powerW: 400 },
				{ ts: at(11), powerW: 0 },
			],
			[{ ts: at(11), powerW: 1500 }],
		);
		assert.deepStrictEqual(
			[...series.entries()],
			[
				[at(10), 400],
				[at(11), -1500],
			],
		);
	});

	it("sums a category with parent rest values like the live sums", () => {
		const house = entity({ entityId: "haus" });
		const bkw = entity({ entityId: "bkw", category: "producer", parentId: "haus", invertInParent: true });
		const hourly = new Map([
			["haus", new Map([[at(12), 200]])],
			["bkw", new Map([[at(12), 500]])],
		]);
		const children = new Map([["haus", [bkw]]]);
		assert.strictEqual(categoryHourly("consumer", [house, bkw], hourly, children).get(at(12)), 700);
		assert.strictEqual(categoryHourly("producer", [house, bkw], hourly, children).get(at(12)), 500);
	});

	it("combines signed series over the union of hours", () => {
		const a = new Map([[at(1), 10]]);
		const b = new Map([
			[at(1), 3],
			[at(2), 4],
		]);
		assert.deepStrictEqual(
			[
				...combineHourly([
					[a, 1],
					[b, -1],
				]).entries(),
			],
			[
				[at(1), 7],
				[at(2), -4],
			],
		);
	});

	it("uses the measurement where available and the balance elsewhere (measuredWithFallback)", () => {
		const measured = new Map([[at(15), 30]]);
		const balance = new Map([
			[at(14), -150],
			[at(15), -160],
		]);
		const eff = effectiveHourly("measuredWithFallback", measured, balance);
		assert.strictEqual(eff.get(at(14)), -150);
		assert.strictEqual(eff.get(at(15)), 30);
		assert.strictEqual(effectiveHourly("balance", measured, balance).get(at(15)), -160);
		assert.strictEqual(effectiveHourly("measured", measured, balance).get(at(14)), undefined);
	});

	it("totals hours into the day they cover (window-end timestamps)", () => {
		const today = new Date(2026, 9, 31, 12).getTime();
		const yesterday = new Date(2026, 9, 30, 12).getTime();
		const series = new Map([
			[at(0), 500], // 23:00-24:00 yesterday
			[at(1), 1000], // 00:00-01:00 today
		]);
		const t = totalsFromHourly(series, localDayKey(today), localDayKey(yesterday));
		assert.strictEqual(t.yesterday, 0.5);
		assert.strictEqual(t.today, 1);
		assert.strictEqual(t.last7Days, 1.5);
		assert.ok(H > 0);
	});
	it("uses measurement, then fallback, then balance per hour", () => {
		const measured = new Map([[at(3), 10]]);
		const fallback = new Map([
			[at(2), 20],
			[at(3), 99],
		]);
		const balance = new Map([
			[at(1), 30],
			[at(2), 98],
			[at(3), 97],
		]);
		const eff = effectiveHourly("measuredWithFallback", measured, balance, fallback);
		assert.strictEqual(eff.get(at(1)), 30);
		assert.strictEqual(eff.get(at(2)), 20);
		assert.strictEqual(eff.get(at(3)), 10);
	});

	it("builds the inverter loss only for hours with an AC reading", () => {
		const loss = inverterLossHourly(
			[new Map([[at(12), 2000]]), new Map([[at(12), 1500]])],
			new Map([
				[at(3), -250],
				[at(12), 2000],
			]),
			new Map([
				[at(3), 120],
				[at(12), 1200],
			]),
		);
		assert.strictEqual(loss.get(at(3)), 130);
		assert.strictEqual(loss.get(at(12)), 300);
		assert.strictEqual(loss.size, 2);
	});
});
