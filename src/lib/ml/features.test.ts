import assert from "node:assert";
import { buildFeatureVector, denormalizeOutput, normalizeTarget } from "./features.js";

describe("features", () => {
	describe("buildFeatureVector", () => {
		it("normalizes predicted power by peak power", () => {
			const [predictedNorm] = buildFeatureVector(500, Date.UTC(2026, 5, 15, 12), 1000);
			assert.strictEqual(predictedNorm, 0.5);
		});

		it("produces a 5-element vector", () => {
			const vec = buildFeatureVector(500, Date.UTC(2026, 5, 15, 12), 1000);
			assert.strictEqual(vec.length, 5);
		});

		it("encodes hour-of-day cyclically so midnight and just-before-midnight are close", () => {
			const nearMidnight = buildFeatureVector(0, Date.UTC(2026, 5, 15, 23, 55), 1000);
			const justAfterMidnight = buildFeatureVector(0, Date.UTC(2026, 5, 16, 0, 5), 1000);
			const [, hourSinA, hourCosA] = nearMidnight;
			const [, hourSinB, hourCosB] = justAfterMidnight;
			const distance = Math.hypot(hourSinA - hourSinB, hourCosA - hourCosB);
			assert.ok(distance < 0.1, `expected hour encodings to be close across midnight, got distance ${distance}`);
		});

		it("gives noon and midnight distinctly different hour encodings", () => {
			const noon = buildFeatureVector(0, Date.UTC(2026, 5, 15, 12), 1000);
			const midnight = buildFeatureVector(0, Date.UTC(2026, 5, 15, 0), 1000);
			const distance = Math.hypot(noon[1] - midnight[1], noon[2] - midnight[2]);
			assert.ok(distance > 1.5, `expected noon/midnight to be far apart, got distance ${distance}`);
		});

		it("encodes day-of-year cyclically so year-end and year-start are close", () => {
			const endOfYear = buildFeatureVector(0, Date.UTC(2026, 11, 31, 12), 1000);
			const startOfYear = buildFeatureVector(0, Date.UTC(2027, 0, 1, 12), 1000);
			const distance = Math.hypot(endOfYear[3] - startOfYear[3], endOfYear[4] - startOfYear[4]);
			assert.ok(distance < 0.1, `expected day-of-year encodings to be close across new year, got distance ${distance}`);
		});
	});

	describe("normalizeTarget / denormalizeOutput", () => {
		it("round-trips a value through normalize and denormalize", () => {
			const normalized = normalizeTarget(750, 1500);
			assert.strictEqual(normalized, 0.5);
			assert.strictEqual(denormalizeOutput(normalized, 1500), 750);
		});
	});
});
