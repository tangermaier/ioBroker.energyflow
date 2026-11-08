import assert from "node:assert";
import { setLanguage } from "../i18n/i18n.js";
import { buildRecommendationText, computeSurplusSeries, findBestSurplusWindow, positiveSurplusKWh, splitTodayTomorrow, type SurplusPoint } from "./surplus.js";

const HOUR = 3600000;
const BASE_TS = Date.UTC(2026, 5, 15, 0, 0);

function surplusSeries(surplusValues: number[]): SurplusPoint[] {
	return surplusValues.map((surplusW, i) => ({ ts: BASE_TS + i * HOUR, surplusW }));
}

describe("surplus", () => {
	describe("computeSurplusSeries", () => {
		it("subtracts the baseline consumption from each forecast point", () => {
			const forecast = [
				{ ts: 1000, powerW: 500 },
				{ ts: 2000, powerW: 100 },
			];
			const surplus = computeSurplusSeries(forecast, 200);
			assert.deepStrictEqual(
				surplus.map(p => p.surplusW),
				[300, -100],
			);
		});
	});

	describe("positiveSurplusKWh", () => {
		it("sums only positive surplus points, converting W to kWh at one point per hour", () => {
			const points = surplusSeries([1000, -500, 2000, 0]);
			// 1000W + 2000W over their respective hours = 1kWh + 2kWh = 3kWh; negative and zero contribute 0.
			assert.strictEqual(positiveSurplusKWh(points), 3);
		});

		it("returns 0 for an all-deficit series", () => {
			assert.strictEqual(positiveSurplusKWh(surplusSeries([-100, -200])), 0);
		});
	});

	describe("splitTodayTomorrow", () => {
		it("splits the first 24 points as today and the next 24 as tomorrow", () => {
			const points = surplusSeries(Array.from({ length: 48 }, (_, i) => i));
			const { today, tomorrow } = splitTodayTomorrow(points);
			assert.strictEqual(today.length, 24);
			assert.strictEqual(tomorrow.length, 24);
			assert.strictEqual(today[0].surplusW, 0);
			assert.strictEqual(tomorrow[0].surplusW, 24);
		});

		it("handles a series shorter than 2 days gracefully", () => {
			const points = surplusSeries([1, 2, 3]);
			const { today, tomorrow } = splitTodayTomorrow(points);
			assert.strictEqual(today.length, 3);
			assert.strictEqual(tomorrow.length, 0);
		});
	});

	describe("findBestSurplusWindow", () => {
		it("finds the contiguous run with the highest total kWh, not just the highest peak", () => {
			// Short, high spike (1h @ 2000W = 2kWh) vs a longer, moderate run (4h @ 1000W = 4kWh):
			// the spike has a higher peak but less total energy, so the moderate run should win.
			const points = surplusSeries([0, 2000, 0, 1000, 1000, 1000, 1000, 0]);
			const window = findBestSurplusWindow(points, BASE_TS, 300);
			assert.strictEqual(window?.totalKWh, 4);
			assert.strictEqual(window?.startTs, points[3].ts);
			assert.strictEqual(window?.endTs, points[6].ts);
		});

		it("ignores points before 'now'", () => {
			const points = surplusSeries([2000, 2000, 0, 500, 500]);
			const window = findBestSurplusWindow(points, points[3].ts, 300);
			assert.strictEqual(window?.startTs, points[3].ts);
		});

		it("returns undefined when nothing exceeds the threshold", () => {
			const points = surplusSeries([100, 200, 150]);
			assert.strictEqual(findBestSurplusWindow(points, BASE_TS, 300), undefined);
		});

		it("computes the correct average surplus power for the winning window", () => {
			const points = surplusSeries([1000, 3000]);
			const window = findBestSurplusWindow(points, BASE_TS, 300);
			assert.strictEqual(window?.avgSurplusW, 2000);
		});
	});

	describe("buildRecommendationText", () => {
		beforeEach(() => setLanguage("de"));
		afterEach(() => setLanguage("en"));

		it("mentions the current surplus when above the noise threshold", () => {
			const text = buildRecommendationText({ nowSurplusW: 1500, todaySurplusKWh: 0, bestWindow: undefined, selfConsumptionValueCtPerKWh: 33.47 });
			assert.match(text, /1,5 kW Überschuss/);
		});

		it("says there is no notable surplus when close to zero", () => {
			const text = buildRecommendationText({ nowSurplusW: 20, todaySurplusKWh: 0, bestWindow: undefined, selfConsumptionValueCtPerKWh: 33.47 });
			assert.match(text, /kein nennenswerter Überschuss/);
		});

		it("includes the best window's time range when present", () => {
			const window = { startTs: Date.UTC(2026, 5, 15, 11), endTs: Date.UTC(2026, 5, 15, 14), avgSurplusW: 2100, totalKWh: 6.3 };
			const text = buildRecommendationText({ nowSurplusW: 0, todaySurplusKWh: 0, bestWindow: window, selfConsumptionValueCtPerKWh: 33.47 });
			assert.match(text, /Bestes Zeitfenster/);
		});

		it("includes an estimated euro value when today's surplus and price are meaningful", () => {
			const text = buildRecommendationText({ nowSurplusW: 0, todaySurplusKWh: 10, bestWindow: undefined, selfConsumptionValueCtPerKWh: 33.47 });
			// 10 kWh * 33.47 ct/kWh = 334.7 ct = 3.347 EUR, toFixed(2) rounds to 3.35
			assert.match(text, /3,35 €/);
		});
	});
});
