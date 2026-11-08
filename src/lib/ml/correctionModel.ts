/**
 * The yield-forecast correction model itself: a small feedforward network that learns to map
 * the physics model's (normalized) prediction plus cyclic time-of-day/day-of-year features to
 * the actual (normalized) power observed at that time - capturing systematic effects the
 * physics model can't know about (shading, soiling, inverter quirks) without needing to model
 * them explicitly.
 *
 * Deliberately plain `@tensorflow/tfjs` (pure JS/CPU backend), not `@tensorflow/tfjs-node`:
 * the latter needs a prebuilt native binding per platform, which is a real risk on a
 * Raspberry Pi (ARM) install. Training sets here are small (weeks of hourly data, one model
 * per producer entity) so the pure-JS backend's slower throughput doesn't matter in practice.
 */

import * as tf from "@tensorflow/tfjs";
import { buildFeatureVector, denormalizeOutput, normalizeTarget } from "./features.js";

const FEATURE_COUNT = 5;
const TRAINING_EPOCHS = 150;

/** One historical (physics prediction, actual measurement) pair used to train the correction model. */
export interface TrainingPair {
	/** Absolute Unix timestamp in milliseconds */
	ts: number;
	/** What the physics model would have predicted for this hour, in Watt */
	predictedW: number;
	/** What was actually measured for this hour, in Watt */
	actualW: number;
}

/** Serializable form of a trained model, suitable for storing in a single ioBroker state. */
export interface SerializedModel {
	/** The model's layer/architecture definition, as returned by TensorFlow.js */
	modelTopology: unknown;
	/** Per-weight-tensor metadata (name, shape, dtype) needed to reconstruct the model */
	weightSpecs: tf.io.WeightsManifestEntry[];
	/** The trained weight values, base64-encoded so the whole model fits in one string state */
	weightDataBase64: string;
}

/**
 * Builds a fresh, untrained correction model: 5 input features -> 8 -> 4 -> 1 output, small on
 * purpose (a few hundred hourly training points per entity does not warrant a larger network).
 *
 * @param seed - optional seed for the weight initialization (tests only - production keeps it random)
 */
function buildModel(seed?: number): tf.LayersModel {
	// One distinct seed per layer, so the layers do not start from correlated weights.
	const init = (offset: number): { kernelInitializer?: ReturnType<typeof tf.initializers.glorotUniform> } =>
		seed === undefined ? {} : { kernelInitializer: tf.initializers.glorotUniform({ seed: seed + offset }) };
	const model = tf.sequential();
	model.add(tf.layers.dense({ inputShape: [FEATURE_COUNT], units: 8, activation: "relu", ...init(0) }));
	model.add(tf.layers.dense({ units: 4, activation: "relu", ...init(1) }));
	model.add(tf.layers.dense({ units: 1, activation: "linear", ...init(2) }));
	model.compile({ optimizer: tf.train.adam(0.01), loss: "meanSquaredError" });
	return model;
}

/**
 * Trains a fresh correction model on a set of (predicted, actual) pairs backtested from
 * historical weather/production data.
 *
 * @param pairs - historical (predicted, actual) power pairs for one entity
 * @param peakPowerW - the entity's peak power in Watt, used to normalize inputs/outputs
 * @param seed - optional seed making the run deterministic (seeded weight init, no epoch
 *   shuffling, which would otherwise use Math.random) - for tests; production stays random
 */
export async function trainCorrectionModel(pairs: TrainingPair[], peakPowerW: number, seed?: number): Promise<{ model: tf.LayersModel; finalLoss: number }> {
	const xs = tf.tensor2d(pairs.map(p => buildFeatureVector(p.predictedW, p.ts, peakPowerW)));
	const ys = tf.tensor2d(pairs.map(p => [normalizeTarget(p.actualW, peakPowerW)]));

	const model = buildModel(seed);
	const history = await model.fit(xs, ys, { epochs: TRAINING_EPOCHS, shuffle: seed === undefined, verbose: 0 });
	xs.dispose();
	ys.dispose();

	const lossHistory = history.history.loss as number[];
	return { model, finalLoss: lossHistory[lossHistory.length - 1] };
}

/**
 * Applies a trained correction model to a series of physics-model predictions.
 *
 * @param model - a model previously returned by trainCorrectionModel or loadModel
 * @param points - the physics forecast to correct
 * @param peakPowerW - the entity's peak power in Watt, used to normalize/denormalize
 */
export function applyCorrection(model: tf.LayersModel, points: { ts: number; powerW: number }[], peakPowerW: number): { ts: number; powerW: number }[] {
	if (points.length === 0) {
		return [];
	}
	const xs = tf.tensor2d(points.map(p => buildFeatureVector(p.powerW, p.ts, peakPowerW)));
	const prediction = model.predict(xs) as tf.Tensor;
	const values = prediction.dataSync();
	xs.dispose();
	prediction.dispose();

	// A physics prediction of exactly 0 means zero irradiance (night, or the model wasn't
	// asked about this point at all) - no PV production is physically possible then,
	// regardless of what the learned correction extrapolates for that input.
	return points.map((p, i) => ({ ts: p.ts, powerW: p.powerW <= 0 ? 0 : Math.max(0, denormalizeOutput(values[i], peakPowerW)) }));
}

/**
 * Serializes a trained model into a plain-JSON-friendly shape for storing in an ioBroker
 * state, using a custom save handler instead of tfjs-node's `file://` scheme (which the
 * pure-JS `@tensorflow/tfjs` package does not provide).
 *
 * @param model - the model to serialize
 */
export async function serializeModel(model: tf.LayersModel): Promise<SerializedModel> {
	let captured: tf.io.ModelArtifacts | undefined;
	await model.save(
		tf.io.withSaveHandler(artifacts => {
			captured = artifacts;
			return Promise.resolve({ modelArtifactsInfo: { dateSaved: new Date(), modelTopologyType: "JSON" } });
		}),
	);
	if (!captured || !captured.weightData) {
		throw new Error("Model serialization produced no weight data");
	}
	const weightData = Array.isArray(captured.weightData) ? captured.weightData[0] : captured.weightData;
	return {
		modelTopology: captured.modelTopology,
		weightSpecs: captured.weightSpecs ?? [],
		weightDataBase64: Buffer.from(weightData).toString("base64"),
	};
}

/**
 * Restores a model previously produced by serializeModel.
 *
 * @param serialized - the serialized model, as previously returned by serializeModel
 */
export async function deserializeModel(serialized: SerializedModel): Promise<tf.LayersModel> {
	const weightBuffer = Buffer.from(serialized.weightDataBase64, "base64");
	const weightData = weightBuffer.buffer.slice(weightBuffer.byteOffset, weightBuffer.byteOffset + weightBuffer.byteLength);
	return tf.loadLayersModel(
		tf.io.fromMemory({
			modelTopology: serialized.modelTopology,
			weightSpecs: serialized.weightSpecs,
			weightData,
		}),
	);
}
