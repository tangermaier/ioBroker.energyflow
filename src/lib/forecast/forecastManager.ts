// Portions derived from Helios-Forecast (https://github.com/ReikanYsora/Helios-Forecast), (c) ReikanYsora, GPL-3.0-only.
import { tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import { type EntityDefinition, type ForecastableEntity, selectForecastableEntities } from "../entityModel.js";
import { getHistorySourceFromAdapter, isHistoryConfigured } from "../history/historyClient.js";
import { getSystemLocation } from "../location.js";
import { CorrectionManager } from "../ml/correctionManager.js";
import { fetchActualProducerSeries } from "./actualYield.js";
import { currentHourIndex, fetchOpenMeteoForecast, localDateKey, nextDateKey, toWeatherSeries, type OpenMeteoHourly } from "./openMeteo.js";
import { dailyTotalsKWh, estimateProducerForecast, sumForecastSeries, type ForecastPoint } from "./pvModel.js";

/** How many days ahead to request from Open-Meteo, matching Helios-Forecast's horizon. */
const FORECAST_DAYS = 7;
/** Fallback for native.forecastHistoryDays if it is unset or not a valid number. */
const DEFAULT_PAST_DAYS = 2;
/** Upper bound for native.forecastHistoryDays (also the admin UI's max) - keeps a mistaken huge value from blowing up the Open-Meteo/InfluxDB requests made on every hourly refresh. */
const MAX_PAST_DAYS = 14;
/** How often to refresh the forecast. Hourly is more than enough for hourly-resolution data. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Reads and validates native.forecastHistoryDays: how many days of actual past data to prepend
 * to the forecast series, for the widget's/scene's timeline scrubback to look back into and the
 * sparkline's forecast-vs-actual comparison. Uses Open-Meteo's near-real-time forecast model (via
 * pastDays), not the days-late ERA5 archive the ML correction's training bootstrap uses - that
 * lag is fine for training on months of history, but useless for "what did we predict yesterday".
 *
 * @param adapter - the adapter instance to read config from
 */
function getPastDays(adapter: utils.AdapterInstance): number {
	const configured = Number(adapter.config.forecastHistoryDays);
	if (!Number.isFinite(configured) || configured < 0) {
		return DEFAULT_PAST_DAYS;
	}
	return Math.min(Math.round(configured), MAX_PAST_DAYS);
}

/**
 * Fetches an Open-Meteo yield forecast for every producer entity with peak power/tilt/azimuth
 * configured, writes per-entity and category-summary forecast states, and refreshes on a
 * timer. Entities without those three fields configured are silently skipped - the forecast
 * is opt-in per entity. Delegates to a CorrectionManager to apply a per-entity ML correction
 * on top of the raw physics forecast where one has been trained (see correctionManager.ts);
 * the raw physics series stays available per entity for comparison/debugging.
 */
export class ForecastManager {
	private readonly adapter: utils.AdapterInstance;
	private readonly correctionManager: CorrectionManager;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
		this.correctionManager = new CorrectionManager(adapter);
	}

	/**
	 * Builds the forecast object tree for the currently configured forecastable entities, sets
	 * up the ML correction manager, runs an initial fetch, and schedules the periodic refresh.
	 *
	 * @param entities - all configured entities (producers without forecast fields are ignored)
	 */
	public async init(entities: EntityDefinition[]): Promise<void> {
		const forecastable = selectForecastableEntities(entities);
		await this.createForecastObjects(forecastable);

		if (forecastable.length === 0) {
			return;
		}

		const location = await getSystemLocation(this.adapter);
		if (location) {
			await this.correctionManager.init(forecastable, location);
		}

		await this.refresh(forecastable);
		this.refreshTimer = setInterval(() => {
			void this.refresh(forecastable);
		}, REFRESH_INTERVAL_MS);
	}

	/** Stops the periodic refresh timer and the ML correction manager's retrain timer. */
	public stop(): void {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		this.correctionManager.stop();
	}

	private async createForecastObjects(entities: ForecastableEntity[]): Promise<void> {
		for (const entity of entities) {
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}.forecastPower`, {
				type: "state",
				common: {
					name: tAll("{name} forecast power series (ML-corrected if available, physics-only otherwise)", { name: entity.name }),
					role: "json",
					type: "string",
					read: true,
					write: false,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}.forecastPowerPhysics`, {
				type: "state",
				common: {
					name: tAll("{name} forecast power series (raw physics model, uncorrected)", { name: entity.name }),
					role: "json",
					type: "string",
					read: true,
					write: false,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}.forecastToday`, {
				type: "state",
				common: {
					name: tAll("{name} forecast today", { name: entity.name }),
					role: "value.energy",
					type: "number",
					unit: "kWh",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}.forecastTomorrow`, {
				type: "state",
				common: {
					name: tAll("{name} forecast tomorrow", { name: entity.name }),
					role: "value.energy",
					type: "number",
					unit: "kWh",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		}
		if (entities.length > 0) {
			await this.adapter.extendObjectAsync("summary.producer.forecastPower", {
				type: "state",
				common: {
					name: tAll("Producer forecast power series (combined, ML-corrected where available)"),
					role: "json",
					type: "string",
					read: true,
					write: false,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync("summary.producer.forecastToday", {
				type: "state",
				common: {
					name: tAll("Producer forecast today (combined)"),
					role: "value.energy",
					type: "number",
					unit: "kWh",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync("summary.producer.forecastTomorrow", {
				type: "state",
				common: {
					name: tAll("Producer forecast tomorrow (combined)"),
					role: "value.energy",
					type: "number",
					unit: "kWh",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
			await this.adapter.extendObjectAsync("summary.producer.actualPower", {
				type: "state",
				common: {
					name: tAll("Producer actual power series (combined, last {days} days, from history) - for comparison against forecastPower", {
						days: getPastDays(this.adapter),
					}),
					role: "json",
					type: "string",
					read: true,
					write: false,
				},
				native: {},
			});
			await this.createWeatherObjects();
		}
	}

	private async createWeatherObjects(): Promise<void> {
		await this.adapter.extendObjectAsync("summary.weather", { type: "channel", common: { name: tAll("Current weather conditions") }, native: {} });
		await this.adapter.extendObjectAsync("summary.weather.temperature", {
			type: "state",
			common: { name: tAll("Current air temperature"), role: "value.temperature", type: "number", unit: "°C", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.weather.cloudCoverPct", {
			type: "state",
			common: { name: tAll("Current total cloud cover"), role: "value", type: "number", unit: "%", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.weather.precipitationMm", {
			type: "state",
			common: { name: tAll("Current precipitation (this hour)"), role: "value", type: "number", unit: "mm", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.weather.snowfallCm", {
			type: "state",
			common: { name: tAll("Current snowfall (this hour)"), role: "value", type: "number", unit: "cm", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.weather.weatherCode", {
			type: "state",
			common: { name: tAll("Current WMO weather interpretation code"), role: "value", type: "number", read: true, write: false, def: 0 },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.weather.forecastSeries", {
			type: "state",
			common: {
				name: tAll("Weather forecast series (JSON) - cloud/precipitation/snowfall/weather code per hour, for the widget's timeline scrubback"),
				role: "json",
				type: "string",
				read: true,
				write: false,
			},
			native: {},
		});
	}

	/**
	 * Reads "today"/"tomorrow" out of a daily-totals map by explicit date key rather than
	 * positional array order - the map's insertion order follows the hourly series, which since
	 * `fetchOpenMeteoForecast`'s pastDays now also contains days before today, so the first two
	 * entries are no longer reliably "today" and "tomorrow".
	 *
	 * @param hourly - the same Open-Meteo response the series was computed from
	 * @param daily - the per-day totals from dailyTotalsKWh(hourly, series)
	 */
	private todayAndTomorrow(hourly: OpenMeteoHourly, daily: Map<string, number>): [number, number] {
		const todayKey = localDateKey(hourly.times[currentHourIndex(hourly, Date.now())]);
		return [daily.get(todayKey) ?? 0, daily.get(nextDateKey(todayKey)) ?? 0];
	}

	private async refresh(entities: ForecastableEntity[]): Promise<void> {
		const location = await getSystemLocation(this.adapter);
		if (!location) {
			this.adapter.log.warn("Cannot refresh yield forecast: no latitude/longitude configured in system.config (Admin > System Settings)");
			return;
		}

		const pastDays = getPastDays(this.adapter);
		const allCorrectedSeries: ForecastPoint[][] = [];
		let referenceHourly: OpenMeteoHourly | undefined;

		for (const entity of entities) {
			try {
				const hourly = await fetchOpenMeteoForecast({
					latitude: location.latitude,
					longitude: location.longitude,
					tiltDeg: entity.tiltDeg,
					azimuthDeg: entity.azimuthDeg,
					forecastDays: FORECAST_DAYS,
					pastDays,
				});
				referenceHourly ??= hourly;

				const physicsSeries = estimateProducerForecast(entity.peakPowerKWp, hourly, entity.acLimitW, {
					latitude: location.latitude,
					longitude: location.longitude,
					tiltDeg: entity.tiltDeg,
					azimuthDeg: entity.azimuthDeg,
				});
				const correctedSeries = this.correctionManager.correct(entity.entityId, physicsSeries, entity.peakPowerKWp * 1000);
				allCorrectedSeries.push(correctedSeries);

				const [today, tomorrow] = this.todayAndTomorrow(hourly, dailyTotalsKWh(hourly, correctedSeries));

				await this.adapter.setStateAsync(`entities.${entity.entityId}.forecastPower`, { val: JSON.stringify(correctedSeries), ack: true });
				await this.adapter.setStateAsync(`entities.${entity.entityId}.forecastPowerPhysics`, { val: JSON.stringify(physicsSeries), ack: true });
				await this.adapter.setStateAsync(`entities.${entity.entityId}.forecastToday`, { val: today, ack: true });
				await this.adapter.setStateAsync(`entities.${entity.entityId}.forecastTomorrow`, { val: tomorrow, ack: true });
			} catch (error) {
				this.adapter.log.warn(`Yield forecast for entity "${entity.entityId}" failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (allCorrectedSeries.length > 0 && referenceHourly) {
			const combined = sumForecastSeries(allCorrectedSeries);
			const [today, tomorrow] = this.todayAndTomorrow(referenceHourly, dailyTotalsKWh(referenceHourly, combined));

			await this.adapter.setStateAsync("summary.producer.forecastPower", { val: JSON.stringify(combined), ack: true });
			await this.adapter.setStateAsync("summary.producer.forecastToday", { val: today, ack: true });
			await this.adapter.setStateAsync("summary.producer.forecastTomorrow", { val: tomorrow, ack: true });

			const historySource = getHistorySourceFromAdapter(this.adapter);
			if (isHistoryConfigured(historySource)) {
				try {
					const actualSeries = await fetchActualProducerSeries(entities, historySource, pastDays * 24);
					await this.adapter.setStateAsync("summary.producer.actualPower", { val: JSON.stringify(actualSeries), ack: true });
				} catch (error) {
					this.adapter.log.warn(`Fetching actual producer yield history failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}

			// Cloud cover/precipitation/snowfall/weather code don't depend on panel tilt/azimuth, so
			// any one entity's already-fetched hourly response carries the same values - no extra
			// Open-Meteo request needed just for "current weather".
			const nowIndex = currentHourIndex(referenceHourly, Date.now());
			await this.adapter.setStateAsync("summary.weather.temperature", { val: referenceHourly.temperature[nowIndex] ?? 0, ack: true });
			await this.adapter.setStateAsync("summary.weather.cloudCoverPct", { val: referenceHourly.cloudCoverPct[nowIndex] ?? 0, ack: true });
			await this.adapter.setStateAsync("summary.weather.precipitationMm", { val: referenceHourly.precipitationMm[nowIndex] ?? 0, ack: true });
			await this.adapter.setStateAsync("summary.weather.snowfallCm", { val: referenceHourly.snowfallCm[nowIndex] ?? 0, ack: true });
			await this.adapter.setStateAsync("summary.weather.weatherCode", { val: referenceHourly.weatherCode[nowIndex] ?? 0, ack: true });
			await this.adapter.setStateAsync("summary.weather.forecastSeries", { val: JSON.stringify(toWeatherSeries(referenceHourly)), ack: true });
		}
	}
}
