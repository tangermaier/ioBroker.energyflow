import assert from "node:assert";
import { filterTrainingPairs } from "./trainingData.js";

const H = 3600 * 1000;
const T0 = Date.UTC(2026, 7, 1, 10);
const pair = (i: number, predictedW: number, actualW: number): { ts: number; predictedW: number; actualW: number } => ({ ts: T0 + i * H, predictedW, actualW });

describe("trainingData", () => {
	describe("filterTrainingPairs", () => {
		it("drops negative and physically impossible hours", () => {
			const { pairs, stats } = filterTrainingPairs([pair(0, 3000, 2900), pair(1, 3000, -927750), pair(2, 3000, 6000)], { peakPowerW: 5000 });
			assert.deepStrictEqual(
				pairs.map(p => p.actualW),
				[2900],
			);
			assert.strictEqual(stats.implausible, 2);
			// 6000 W > 1.1 x 5000 W
		});

		it("uses the AC limit as ceiling when it is lower than the peak", () => {
			const { stats } = filterTrainingPairs([pair(0, 800, 950)], { peakPowerW: 920, acLimitW: 800 });
			assert.strictEqual(stats.implausible, 1);
		});

		it("drops hours with a full battery and a measurement below the model (curtailed)", () => {
			const soc = new Map([
				[Math.round((T0 + 0 * H) / H), 100],
				[Math.round((T0 + 1 * H) / H), 100],
				[Math.round((T0 + 2 * H) / H), 85],
			]);
			const { pairs, stats } = filterTrainingPairs(
				[
					pair(0, 6000, 4500), // full + below model -> curtailed
					pair(1, 4000, 4200), // full but at/above model -> informative, kept
					pair(2, 6000, 3000), // battery not full -> a genuinely low hour, kept
					pair(3, 6000, 3000), // no SoC data -> kept
				],
				{ peakPowerW: 11375, socMaxByHour: soc },
			);
			assert.strictEqual(stats.curtailed, 1);
			assert.strictEqual(stats.kept, 3);
			assert.deepStrictEqual(
				pairs.map(p => p.ts),
				[T0 + H, T0 + 2 * H, T0 + 3 * H],
			);
		});

		it("keeps everything without SoC history and with plausible values", () => {
			const { stats } = filterTrainingPairs([pair(0, 100, 50), pair(1, 100, 150)], { peakPowerW: 1000 });
			assert.deepStrictEqual(stats, { kept: 2, implausible: 0, curtailed: 0 });
		});
	});
});
