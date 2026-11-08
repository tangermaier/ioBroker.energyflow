import assert from "node:assert";
import type { EntityDefinition } from "../entityModel.js";
import { buildLoadProfile, consumptionSeries, dayTypeOf, expectedLoadW } from "./loadProfile.js";

const H = 3600 * 1000;
// Local-time constructors so hour/day-of-week bucketing matches the host's timezone.
const monday = (hour: number): number => new Date(2026, 9, 26, hour).getTime();
const saturday = (hour: number): number => new Date(2026, 9, 31, hour).getTime();

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

describe("loadProfile", () => {
	it("classifies weekends", () => {
		assert.strictEqual(dayTypeOf(monday(12)), "workday");
		assert.strictEqual(dayTypeOf(saturday(12)), "weekend");
	});

	it("adds a netted-in producer child back to the house consumption", () => {
		const house = entity({ entityId: "haus" });
		const bkw = entity({ entityId: "bkw", category: "producer", parentId: "haus", invertInParent: true });
		const points = new Map([
			["haus", [{ ts: monday(12), powerW: 200 }]],
			["bkw", [{ ts: monday(12), powerW: 500 }]],
		]);
		const series = consumptionSeries([house, bkw], points);
		assert.deepStrictEqual(series, [{ ts: monday(12), powerW: 700 }]);
	});

	it("skips hours where a consumer reading is missing", () => {
		const a = entity({ entityId: "a" });
		const b = entity({ entityId: "b" });
		const points = new Map([
			["a", [{ ts: monday(1), powerW: 100 }, { ts: monday(2), powerW: 100 }]],
			["b", [{ ts: monday(1), powerW: 50 }]],
		]);
		assert.deepStrictEqual(consumptionSeries([a, b], points), [{ ts: monday(1), powerW: 150 }]);
	});

	it("keeps hours where only an individually measured child consumer has no reading", () => {
		const house = entity({ entityId: "haus" });
		const washer = entity({ entityId: "wm", parentId: "haus" });
		const points = new Map([
			["haus", [{ ts: monday(1), powerW: 800 }, { ts: monday(2), powerW: 300 }]],
			["wm", [{ ts: monday(1), powerW: 500 }]],
		]);
		// child cancels out: total = house reading in both hours
		assert.deepStrictEqual(consumptionSeries([house, washer], points), [
			{ ts: monday(1), powerW: 800 },
			{ ts: monday(2), powerW: 300 },
		]);
	});

	it("builds per-day-type hourly medians robust to outliers", () => {
		// InfluxDB window-end timestamps: ts 21:00 = mean over 20:00-21:00
		const series = [
			{ ts: monday(21), powerW: 400 },
			{ ts: monday(21) + 24 * H, powerW: 500 },
			{ ts: monday(21) + 48 * H, powerW: 5000 }, // sauna evening
			{ ts: saturday(21), powerW: 900 },
		];
		const profile = buildLoadProfile(series);
		assert.strictEqual(profile.workday[20], 500);
		assert.strictEqual(profile.weekend[20], 900);
		assert.strictEqual(profile.workday[21], undefined);
		assert.strictEqual(profile.workday[3], undefined);
	});

	it("files the window ending at midnight under 23:00 of the previous day", () => {
		// Sunday 23:00-24:00 (window end = Monday 00:00) is a weekend hour
		const profile = buildLoadProfile([{ ts: monday(0), powerW: 777 }]);
		assert.strictEqual(profile.weekend[23], 777);
		assert.strictEqual(profile.workday[0], undefined);
	});

	it("blends the first hour towards the live value and falls back sensibly", () => {
		const profile = buildLoadProfile([{ ts: monday(21), powerW: 400 }]);
		const now = monday(20);
		assert.strictEqual(expectedLoadW(profile, now, now, 3000), 3000);
		assert.strictEqual(expectedLoadW(profile, now + H / 2, now, 3000), 1700);
		assert.strictEqual(expectedLoadW(profile, now + 2 * H - 1, now, 3000) > 0, true);
		// no data for 03:00 on any day type -> overall median (400)
		assert.strictEqual(expectedLoadW(profile, monday(3) + 24 * H, now, 3000), 400);
		// saturday 20:00 has no weekend data -> workday value for that hour
		assert.strictEqual(expectedLoadW(profile, saturday(20), now, undefined), 400);
	});
});
