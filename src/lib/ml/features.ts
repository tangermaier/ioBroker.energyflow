/**
 * Feature engineering for the yield-forecast correction model. Kept free of any TensorFlow
 * dependency so it stays trivially unit-testable; correctionModel.ts turns these plain number
 * arrays into tensors.
 */

const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Builds the model input vector for one point: the physics-model prediction (normalized by
 * the entity's peak power, since a model trained on one entity should transfer reasonably to
 * another producer of a different size), plus cyclic (sin/cos) encodings of hour-of-day and
 * day-of-year so the model can learn time-of-day shading patterns and seasonal effects (soiling
 * build-up, sun angle) without discontinuities at midnight/year-end.
 *
 * @param predictedW - the physics model's power estimate for this point, in Watt
 * @param ts - absolute Unix timestamp in milliseconds
 * @param peakPowerW - the entity's peak power in Watt, used to normalize predictedW to roughly [0, 1.2]
 */
export function buildFeatureVector(predictedW: number, ts: number, peakPowerW: number): number[] {
	const date = new Date(ts);
	const hourOfDay = date.getUTCHours() + date.getUTCMinutes() / 60;
	const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
	const dayOfYear = (ts - startOfYear) / MS_PER_DAY;

	const hourAngle = (hourOfDay / 24) * 2 * Math.PI;
	const dayAngle = (dayOfYear / 365.25) * 2 * Math.PI;

	return [predictedW / peakPowerW, Math.sin(hourAngle), Math.cos(hourAngle), Math.sin(dayAngle), Math.cos(dayAngle)];
}

/**
 * Normalizes an actual power reading the same way predictedW is normalized in the feature
 * vector, so the model's output is on a comparable, peak-power-independent scale.
 *
 * @param actualW - measured actual power in Watt
 * @param peakPowerW - the entity's peak power in Watt
 */
export function normalizeTarget(actualW: number, peakPowerW: number): number {
	return actualW / peakPowerW;
}

/**
 * Inverse of normalizeTarget: turns a model output back into Watt.
 *
 * @param normalized - the model's raw output value
 * @param peakPowerW - the entity's peak power in Watt
 */
export function denormalizeOutput(normalized: number, peakPowerW: number): number {
	return normalized * peakPowerW;
}
