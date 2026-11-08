// Portions derived from Helios-Forecast (https://github.com/ReikanYsora/Helios-Forecast), (c) ReikanYsora, GPL-3.0-only.
/**
 * Builds a training set for one producer entity by reconstructing "what the physics model
 * would have predicted" for a past date range (via Open-Meteo's historical/archive API,
 * backtested through the same pvModel used for live forecasts) and pairing it with the real
 * historical production from InfluxDB for the same hours. This lets the correction model train
 * on weeks of history immediately, without ever having logged a live forecast before now.
 */

import { queryHourlyActual, type HistorySource } from "../history/historyClient.js";
import type { ForecastableEntity } from "../entityModel.js";
import { fetchOpenMeteoHistorical } from "../forecast/openMeteo.js";
import { estimateProducerForecast } from "../forecast/pvModel.js";
import type { TrainingPair } from "./correctionModel.js";

/** Minimum number of aligned (predicted, actual) hours before training is worthwhile. */
export const MIN_TRAINING_POINTS = 168; // one week of hourly data

/** Measured hours above this multiple of the physical ceiling (peak/AC limit) are impossible - meter swap, restored backup, unit glitch. */
const IMPLAUSIBLE_FACTOR = 1.1;
/** Battery SoC (hourly maximum, percent) at or above which the battery counts as full. */
const FULL_SOC_PERCENT = 98;

/** What filterTrainingPairs dropped, for logging. */
export interface TrainingFilterStats {
	/** Pairs kept for training */
	kept: number;
	/** Negative or physically impossible measurements */
	implausible: number;
	/** Hours where the battery was full and the measurement fell below the model - probably curtailed */
	curtailed: number;
}

/**
 * Removes hours that would teach the correction model something false (both ideas from the
 * Helios-Forecast audit, commits 0781399c / af04cfcb / 54fb07eb, 2026-09):
 *
 * - **implausible**: a negative hour, or one above what the panels (or the inverter's AC limit)
 *   can deliver - a single phantom hour from a replaced meter or restored backup otherwise drags
 *   the whole correction.
 * - **curtailed**: the battery was full during the hour and the measurement sits BELOW the
 *   physics model. With a full battery and an export limit the inverter throttles the panels,
 *   so the measurement is a lower bound on what the sky allowed, not a low hour - learning it
 *   would depress the forecast for exactly the sunny hours. Hours at or above the model are kept
 *   (they are informative either way).
 *
 * @param pairs - aligned (predicted, actual) pairs
 * @param options - filter inputs
 * @param options.peakPowerW - the entity's peak power in W
 * @param options.acLimitW - the entity's inverter AC limit in W, if any
 * @param options.socMaxByHour - hourly maximum battery SoC (percent), keyed by Math.round(ts / 1h) - same key as the pairs
 */
export function filterTrainingPairs(
	pairs: TrainingPair[],
	options: { peakPowerW: number; acLimitW?: number; socMaxByHour?: Map<number, number> },
): { pairs: TrainingPair[]; stats: TrainingFilterStats } {
	const ceiling = Math.min(options.peakPowerW, options.acLimitW && options.acLimitW > 0 ? options.acLimitW : Infinity) * IMPLAUSIBLE_FACTOR;
	const stats: TrainingFilterStats = { kept: 0, implausible: 0, curtailed: 0 };
	const kept: TrainingPair[] = [];
	for (const pair of pairs) {
		if (!Number.isFinite(pair.actualW) || pair.actualW < 0 || pair.actualW > ceiling) {
			stats.implausible++;
			continue;
		}
		const socMax = options.socMaxByHour?.get(Math.round(pair.ts / 3600000));
		if (socMax !== undefined && socMax >= FULL_SOC_PERCENT && pair.actualW < pair.predictedW) {
			stats.curtailed++;
			continue;
		}
		kept.push(pair);
	}
	stats.kept = kept.length;
	return { pairs: kept, stats };
}

/**
 * Fetches and aligns historical (predicted, actual) power pairs for one entity.
 *
 * @param entity - the producer entity to build training data for
 * @param historySource - InfluxDB connection details
 * @param location - installation latitude/longitude
 * @param location.latitude - installation latitude in degrees
 * @param location.longitude - installation longitude in degrees
 * @param days - how many days of history to fetch (bounded by both InfluxDB's actual data and Open-Meteo's ERA5 delay of a few days)
 * @param socHistoryIds - candidate InfluxDB measurement ids of the battery SoC (e.g. an alias and
 *   its target), tried in order; the first with data enables the curtailment filter
 */
export async function fetchTrainingPairs(
	entity: ForecastableEntity,
	historySource: HistorySource,
	location: { latitude: number; longitude: number },
	days: number,
	socHistoryIds: string[] = [],
): Promise<{ pairs: TrainingPair[]; stats: TrainingFilterStats }> {
	const end = new Date();
	const start = new Date(end.getTime() - days * 24 * 3600 * 1000);

	const actual = await queryHourlyActual(historySource, entity.powerStateId, start, end);
	if (actual.length === 0) {
		return { pairs: [], stats: { kept: 0, implausible: 0, curtailed: 0 } };
	}

	const hourly = await fetchOpenMeteoHistorical({
		latitude: location.latitude,
		longitude: location.longitude,
		tiltDeg: entity.tiltDeg,
		azimuthDeg: entity.azimuthDeg,
		startDate: start.toISOString().slice(0, 10),
		endDate: end.toISOString().slice(0, 10),
	});
	const predicted = estimateProducerForecast(entity.peakPowerKWp, hourly, entity.acLimitW, {
		latitude: location.latitude,
		longitude: location.longitude,
		tiltDeg: entity.tiltDeg,
		azimuthDeg: entity.azimuthDeg,
	});
	const predictedByHour = new Map(predicted.map(p => [Math.round(p.ts / 3600000), p.powerW]));

	const pairs: TrainingPair[] = [];
	for (const point of actual) {
		const predictedW = predictedByHour.get(Math.round(point.ts / 3600000));
		if (predictedW === undefined) {
			continue;
		}
		pairs.push({ ts: point.ts, predictedW, actualW: point.powerW });
	}

	let socMaxByHour: Map<number, number> | undefined;
	for (const id of socHistoryIds) {
		const soc = await queryHourlyActual(historySource, id, start, end, "max");
		if (soc.length > 0) {
			socMaxByHour = new Map(soc.map(p => [Math.round(p.ts / 3600000), p.powerW]));
			break;
		}
	}
	return filterTrainingPairs(pairs, { peakPowerW: entity.peakPowerKWp * 1000, acLimitW: entity.acLimitW, socMaxByHour });
}
