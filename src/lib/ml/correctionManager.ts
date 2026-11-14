import { tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import type * as tf from "@tensorflow/tfjs";
import type { ForecastableEntity } from "../entityModel.js";
import type { HistorySource } from "../history/historyClient.js";
import { getHistorySourceFromAdapter, isHistoryConfigured } from "../history/historyClient.js";
import type { ForecastPoint } from "../forecast/pvModel.js";
import { applyCorrection, deserializeModel, serializeModel, trainCorrectionModel, type SerializedModel } from "./correctionModel.js";
import { fetchTrainingPairs, MIN_TRAINING_POINTS } from "./trainingData.js";
import { runSafely } from "../safeAsync.js";

/** How many days of InfluxDB/Open-Meteo-historical data to train on. */
const TRAINING_WINDOW_DAYS = 60;
/** How often to retrain (new data accumulates daily; training itself is cheap, so daily is plenty). */
const RETRAIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Owns one ML correction model per forecastable producer entity: trains it from InfluxDB
 * history backtested against Open-Meteo's historical weather (see trainingData.ts), persists
 * it to an ioBroker state so it survives adapter restarts, and applies it to live physics
 * forecasts. Entirely optional - if InfluxDB is not configured, or there is not yet enough
 * history for an entity, that entity's forecast simply passes through the physics model
 * unmodified.
 */
export class CorrectionManager {
	private readonly adapter: utils.AdapterInstance;
	private readonly models = new Map<string, tf.LayersModel>();
	private retrainTimer: ioBroker.Interval | undefined;

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
	}

	/**
	 * Creates the ML-related objects for every forecastable entity and loads any previously
	 * trained model from its state (both fast - safe to await before the adapter proceeds).
	 * If InfluxDB is configured, also kicks off training fresh models and schedules periodic
	 * retraining - but does NOT wait for that first training run to finish (it can take the
	 * better part of a minute for several entities), so it must not delay the rest of adapter
	 * startup. Until it completes, correct() simply falls through to the physics-only forecast,
	 * exactly as it would for an entity that never had a model at all.
	 *
	 * @param entities - the forecastable producer entities
	 * @param location - installation latitude/longitude, for the historical weather query
	 * @param location.latitude - installation latitude in degrees
	 * @param location.longitude - installation longitude in degrees
	 */
	public async init(entities: ForecastableEntity[], location: { latitude: number; longitude: number }): Promise<void> {
		if (entities.length === 0) {
			return;
		}
		for (const entity of entities) {
			await this.createObjects(entity.entityId);
			await this.loadModel(entity.entityId);
		}

		const historySource = getHistorySourceFromAdapter(this.adapter);
		if (!isHistoryConfigured(historySource)) {
			this.adapter.log.info("No history instance configured - yield forecast correction disabled, using physics-only forecast");
			return;
		}

		runSafely(this.adapter, "Yield forecast correction training", () => this.trainAll(entities, historySource, location));
		this.retrainTimer = this.adapter.setInterval(() => {
			runSafely(this.adapter, "Yield forecast correction training", () => this.trainAll(entities, historySource, location));
		}, RETRAIN_INTERVAL_MS);
	}

	/** Stops the periodic retraining timer. Call this from the adapter's unload handler. */
	public stop(): void {
		if (this.retrainTimer) {
			this.adapter.clearInterval(this.retrainTimer);
			this.retrainTimer = undefined;
		}
		for (const model of this.models.values()) {
			model.dispose();
		}
		this.models.clear();
	}

	/**
	 * Applies the entity's trained correction model to a physics forecast series, if one
	 * exists; otherwise returns the series unchanged.
	 *
	 * @param entityId - the producer entity's id
	 * @param physicsSeries - the raw Open-Meteo/pvModel forecast for this entity
	 * @param peakPowerW - the entity's peak power in Watt
	 */
	public correct(entityId: string, physicsSeries: ForecastPoint[], peakPowerW: number): ForecastPoint[] {
		const model = this.models.get(entityId);
		if (!model) {
			return physicsSeries;
		}
		return applyCorrection(model, physicsSeries, peakPowerW);
	}

	private async trainAll(entities: ForecastableEntity[], historySource: HistorySource, location: { latitude: number; longitude: number }): Promise<void> {
		for (const entity of entities) {
			try {
				await this.trainOne(entity, historySource, location);
			} catch (error) {
				this.adapter.log.warn(
					`Training yield forecast correction for "${entity.entityId}" failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	private async trainOne(entity: ForecastableEntity, historySource: HistorySource, location: { latitude: number; longitude: number }): Promise<void> {
		const { pairs, stats } = await fetchTrainingPairs(entity, historySource, location, TRAINING_WINDOW_DAYS, await this.socHistoryIds());
		await this.adapter.setStateAsync(`entities.${entity.entityId}.mlModelTrainingPoints`, { val: pairs.length, ack: true });
		if (stats.implausible > 0 || stats.curtailed > 0) {
			this.adapter.log.info(
				`Yield forecast training for "${entity.entityId}": left out ${stats.curtailed} probably curtailed hour(s) (battery full, below model) and ${stats.implausible} implausible hour(s)`,
			);
		}

		if (pairs.length < MIN_TRAINING_POINTS) {
			this.adapter.log.info(
				`Not enough history yet for a yield forecast correction on "${entity.entityId}" (${pairs.length}/${MIN_TRAINING_POINTS} hourly points) - using physics-only forecast for now`,
			);
			return;
		}

		const peakPowerW = entity.peakPowerKWp * 1000;
		const { model, finalLoss } = await trainCorrectionModel(pairs, peakPowerW);

		this.models.get(entity.entityId)?.dispose();
		this.models.set(entity.entityId, model);

		const serialized = await serializeModel(model);
		await this.adapter.setStateAsync(`entities.${entity.entityId}.mlModel`, { val: JSON.stringify(serialized), ack: true });
		await this.adapter.setStateAsync(`entities.${entity.entityId}.mlModelTrainedAt`, { val: Date.now(), ack: true });
		await this.adapter.setStateAsync(`entities.${entity.entityId}.mlModelLoss`, { val: finalLoss, ack: true });
		this.adapter.log.info(`Trained yield forecast correction for "${entity.entityId}" on ${pairs.length} hourly points (loss ${finalLoss.toFixed(4)})`);
	}

	/**
	 * InfluxDB measurement ids that may hold the battery SoC history: the configured socStateId
	 * and, for an alias, its target - often only one of the two is historized (on the live system
	 * the raw Modbus register is, the alias is not).
	 */
	private async socHistoryIds(): Promise<string[]> {
		const storage = (this.adapter.config.EntitiesList ?? []).find(row => row.category === "storage" && row.socStateId);
		const id = storage?.socStateId;
		if (!id) {
			return [];
		}
		const ids = [id];
		try {
			const obj = await this.adapter.getForeignObjectAsync(id);
			const alias = (obj?.common as { alias?: { id?: string | { read?: string } } } | undefined)?.alias;
			const target = typeof alias?.id === "string" ? alias.id : alias?.id?.read;
			if (target && target !== id) {
				ids.push(target);
			}
		} catch {
			// no object / no alias - just the configured id
		}
		return ids;
	}

	private async loadModel(entityId: string): Promise<void> {
		const state = await this.adapter.getStateAsync(`entities.${entityId}.mlModel`);
		if (!state || typeof state.val !== "string") {
			return;
		}
		try {
			const serialized = JSON.parse(state.val) as SerializedModel;
			const model = await deserializeModel(serialized);
			this.models.set(entityId, model);
			this.adapter.log.info(`Loaded previously trained yield forecast correction for "${entityId}"`);
		} catch (error) {
			this.adapter.log.warn(
				`Could not load stored yield forecast correction for "${entityId}", will retrain: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private async createObjects(entityId: string): Promise<void> {
		await this.adapter.extendObjectAsync(`entities.${entityId}.mlModel`, {
			type: "state",
			common: { name: tAll("{id} ML correction model (internal)", { id: entityId }), role: "json", type: "string", read: true, write: false },
			native: {},
		});
		await this.adapter.extendObjectAsync(`entities.${entityId}.mlModelTrainedAt`, {
			type: "state",
			common: { name: tAll("{id} ML correction model last trained", { id: entityId }), role: "date", type: "number", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync(`entities.${entityId}.mlModelTrainingPoints`, {
			type: "state",
			common: {
				name: tAll("{id} ML correction model training points used", { id: entityId }),
				role: "value",
				type: "number",
				read: true,
				write: false,
				def: 0,
			},
			native: {},
		});
		await this.adapter.extendObjectAsync(`entities.${entityId}.mlModelLoss`, {
			type: "state",
			common: {
				name: tAll("{id} ML correction model final training loss", { id: entityId }),
				role: "value",
				type: "number",
				read: true,
				write: false,
				def: 0,
			},
			native: {},
		});
	}
}
