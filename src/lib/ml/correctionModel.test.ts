import assert from "node:assert";
import { applyCorrection, deserializeModel, serializeModel, trainCorrectionModel, type TrainingPair } from "./correctionModel.js";

const PEAK_POWER_W = 1000;
/** Fixed seed: weight init and sample order are otherwise random, which made the accuracy test fail ~1 in 3 runs. */
const SEED = 42;

/** Synthetic data: actual is always 70% of predicted, regardless of time - a clean, learnable relationship. */
function syntheticPairs(count: number): TrainingPair[] {
	const pairs: TrainingPair[] = [];
	const start = Date.UTC(2026, 5, 1);
	for (let i = 0; i < count; i++) {
		const ts = start + i * 3600000;
		const predictedW = 200 + (i % 24) * 30; // varies with hour-of-day, never zero/negative
		pairs.push({ ts, predictedW, actualW: predictedW * 0.7 });
	}
	return pairs;
}

describe("correctionModel", function () {
	// Pure-JS TF.js training of even a tiny network over ~200 epoch-equivalents takes real time.
	this.timeout(30000);

	describe("trainCorrectionModel / applyCorrection", () => {
		it("learns a consistent scaling relationship well enough to reduce error", async () => {
			// Compared against the uncorrected (raw physics) error (off by a constant 30%). Seeded,
			// so the run is deterministic - unseeded (as in production) a fixed-epoch run landed
			// too far from the 0.7x relationship about one run in three.
			const pairs = syntheticPairs(240);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W, SEED);

			const testPoints = Array.from({ length: 20 }, (_, i) => ({
				ts: pairs[i * 10].ts,
				powerW: 200 + i * 25,
			}));
			const corrected = applyCorrection(model, testPoints, PEAK_POWER_W);

			const meanCorrectedError = testPoints.reduce((sum, p, i) => sum + Math.abs(corrected[i].powerW - p.powerW * 0.7), 0) / testPoints.length;
			const meanUncorrectedError = testPoints.reduce((sum, p) => sum + Math.abs(p.powerW - p.powerW * 0.7), 0) / testPoints.length;
			assert.ok(
				meanCorrectedError < meanUncorrectedError * 0.7,
				`expected corrected mean error (${meanCorrectedError.toFixed(0)}W) well below uncorrected (${meanUncorrectedError.toFixed(0)}W)`,
			);
			model.dispose();
		});

		it("returns an empty array for an empty input series", async () => {
			const pairs = syntheticPairs(50);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W);
			assert.deepStrictEqual(applyCorrection(model, [], PEAK_POWER_W), []);
			model.dispose();
		});

		it("never returns negative corrected power", async () => {
			const pairs = syntheticPairs(50);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W);
			const corrected = applyCorrection(model, [{ ts: Date.now(), powerW: 5 }], PEAK_POWER_W);
			assert.ok(corrected[0].powerW >= 0);
			model.dispose();
		});

		it("forces corrected power to exactly zero wherever the physics input was zero", async () => {
			// A physics prediction of 0 means zero irradiance (night) - no amount of learned
			// correction should invent production the physics model says is impossible.
			const pairs = syntheticPairs(50);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W);
			const corrected = applyCorrection(model, [{ ts: Date.now(), powerW: 0 }], PEAK_POWER_W);
			assert.strictEqual(corrected[0].powerW, 0);
			model.dispose();
		});
	});

	describe("serializeModel / deserializeModel", () => {
		it("round-trips a trained model so predictions match before and after", async () => {
			const pairs = syntheticPairs(120);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W);

			const testPoints = [{ ts: pairs[5].ts, powerW: 400 }];
			const before = applyCorrection(model, testPoints, PEAK_POWER_W);

			const serialized = await serializeModel(model);
			const restored = await deserializeModel(serialized);
			const after = applyCorrection(restored, testPoints, PEAK_POWER_W);

			assert.strictEqual(before[0].powerW, after[0].powerW);
			model.dispose();
			restored.dispose();
		});

		it("produces a JSON-serializable payload", async () => {
			const pairs = syntheticPairs(30);
			const { model } = await trainCorrectionModel(pairs, PEAK_POWER_W);
			const serialized = await serializeModel(model);
			// Must not throw and must round-trip through JSON without losing data.
			const roundTripped = JSON.parse(JSON.stringify(serialized));
			assert.strictEqual(roundTripped.weightDataBase64, serialized.weightDataBase64);
			model.dispose();
		});
	});
});
