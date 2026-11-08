// Portions derived from Helios-Forecast (https://github.com/ReikanYsora/Helios-Forecast), (c) ReikanYsora, GPL-3.0-only.
/**
 * Physics-based PV yield estimate from Open-Meteo's plane-of-array irradiance forecast.
 * Deliberately simple (no ML correction yet - that is a later phase, trained on InfluxDB
 * history once enough of it has accumulated): a standard NOCT cell-temperature estimate, a
 * linear temperature derate, a binary snow cutoff, and one lumped system-loss factor covering
 * inverter efficiency, wiring and soiling. Good enough as the physical baseline the ML
 * correction will later be trained against.
 */

import { localDateKey, toEpochMs, type OpenMeteoHourly } from "./openMeteo.js";
import { cosIncidence, incidenceAngleModifier, sunVector } from "./solarGeometry.js";

/** One point in a producer's forecast series. */
export interface ForecastPoint {
	/** Absolute Unix timestamp in milliseconds */
	ts: number;
	/** Estimated power in Watt */
	powerW: number;
}

/**
 * Nominal Operating Cell Temperature used for the cell-temperature estimate, in °C. The
 * user's actual panel datasheets give 45°C for the main-roof panels and 42°C for the smaller
 * balcony power plant panels - one shared constant is a deliberate simplification (the
 * difference has a small effect on the result) rather than a per-entity NOCT setting.
 */
const NOCT_C = 45;
/**
 * Crystalline-silicon power temperature coefficient. -0.28 %/°C per the user's actual panel
 * datasheets (Jolywood JW-HD96N-455W and JW-HD108N-460W both specify this exact value),
 * used here as the default rather than a generic -0.4 %/°C guess.
 */
const TEMP_COEFF_PER_C = -0.0028;
/** Snow depth above which a panel is assumed fully covered and producing nothing, in meters. */
const SNOW_CUTOFF_M = 0.02;
/**
 * Lumped loss factor for everything between the array and the meter that no optical model covers
 * (inverter, wiring, mismatch, soiling, degradation). Helios-Forecast measured 0.827 against
 * 1875 forecasts from 57 installations (PVWatts' defaults give 0.825; audit commit 54fb07eb,
 * 2026-09-08) - replaces the earlier rule-of-thumb 0.9, which together with the missing
 * incidence-angle modifier made the bare physics model over-promise noticeably. The ML
 * correction absorbs site specifics on top of this.
 */
const SYSTEM_LOSS_FACTOR = 0.83;

/** Installation geometry, needed for the incidence-angle modifier. */
export interface PanelGeometry {
	/** Installation latitude in degrees */
	latitude: number;
	/** Installation longitude in degrees (east positive) */
	longitude: number;
	/** Panel tilt in degrees */
	tiltDeg: number;
	/** Panel azimuth, Open-Meteo convention (0 = south, -90 = east, 90 = west) */
	azimuthDeg: number;
}

/**
 * Plane-of-array irradiance after glass reflection losses: the beam share (DNI x cos incidence,
 * at most the whole plane-of-array value) is scaled by the ASHRAE incidence-angle modifier, the
 * diffuse remainder passes unchanged. Open-Meteo's hourly values are means over the PRECEDING
 * hour, so the sun is evaluated at the hour's middle (ts - 30 min). Without geometry or DNI the
 * plane-of-array value is returned unchanged.
 *
 * @param gtiWm2 - plane-of-array irradiance
 * @param dniWm2 - direct normal irradiance (null/undefined = unknown)
 * @param hourEndTs - the point's timestamp (end of the averaged hour), ms
 * @param geometry - installation geometry, if known
 */
export function effectiveIrradiance(gtiWm2: number, dniWm2: number | null | undefined, hourEndTs: number, geometry: PanelGeometry | undefined): number {
	if (!geometry || dniWm2 === null || dniWm2 === undefined || gtiWm2 <= 0) {
		return gtiWm2;
	}
	const sun = sunVector(hourEndTs - 30 * 60 * 1000, geometry.latitude, geometry.longitude);
	const cosTheta = cosIncidence(sun, geometry.tiltDeg, geometry.azimuthDeg);
	const beam = Math.min(gtiWm2, Math.max(0, dniWm2) * Math.max(0, cosTheta));
	return beam * incidenceAngleModifier(cosTheta) + (gtiWm2 - beam);
}

/**
 * Estimates PV cell temperature from ambient air temperature and plane-of-array irradiance
 * using the standard NOCT approximation.
 *
 * @param ambientC - air temperature in °C
 * @param gtiWm2 - plane-of-array irradiance in W/m^2
 */
function estimateCellTemperatureC(ambientC: number, gtiWm2: number): number {
	return ambientC + ((NOCT_C - 20) / 800) * gtiWm2;
}

/**
 * Computes a producer's estimated power output series from its physical parameters and an
 * Open-Meteo plane-of-array forecast for the same orientation.
 *
 * @param peakPowerKWp - nominal peak power in kWp
 * @param hourly - Open-Meteo forecast fetched for this producer's tilt/azimuth
 * @param acLimitW - optional inverter/AC feed-in cap in Watt (e.g. a balcony power plant's
 *   inverter limiting a higher panel peak to a lower grid feed-in limit); the estimate is
 *   clamped to this so it never predicts more than the inverter can actually deliver
 * @param geometry - installation location and panel orientation; enables the incidence-angle
 *   modifier (glass reflection at flat sun angles). Omitted = plane-of-array value used as-is.
 */
export function estimateProducerForecast(peakPowerKWp: number, hourly: OpenMeteoHourly, acLimitW?: number, geometry?: PanelGeometry): ForecastPoint[] {
	const points: ForecastPoint[] = [];
	for (let i = 0; i < hourly.times.length; i++) {
		const ts = toEpochMs(hourly.times[i], hourly.utcOffsetSeconds);
		const gtiRaw = hourly.globalTiltedIrradiance[i] ?? 0;
		const gti = effectiveIrradiance(gtiRaw, hourly.directNormalIrradiance?.[i], ts, geometry);
		const ambientC = hourly.temperature[i] ?? 20;
		const snowM = hourly.snowDepth[i] ?? 0;

		const snowFactor = snowM > SNOW_CUTOFF_M ? 0 : 1;
		// Cell heating follows what the module absorbs, reflected light included - use the raw value.
		const cellTempC = estimateCellTemperatureC(ambientC, gtiRaw);
		const tempFactor = Math.max(0, 1 + TEMP_COEFF_PER_C * (cellTempC - 25));

		let powerW = peakPowerKWp * 1000 * (gti / 1000) * tempFactor * snowFactor * SYSTEM_LOSS_FACTOR;
		powerW = Math.max(0, powerW);
		if (acLimitW !== undefined) {
			powerW = Math.min(powerW, acLimitW);
		}
		points.push({ ts, powerW });
	}
	return points;
}

/**
 * Sums several producers' forecast series into one combined series, aligned by array index
 * (safe because every producer's Open-Meteo request uses the same location/timezone/
 * forecast_days, so their hourly grids line up one-to-one).
 *
 * @param series - one forecast series per producer
 */
export function sumForecastSeries(series: ForecastPoint[][]): ForecastPoint[] {
	if (series.length === 0) {
		return [];
	}
	return series[0].map((point, i) => ({
		ts: point.ts,
		powerW: series.reduce((sum, s) => sum + (s[i]?.powerW ?? 0), 0),
	}));
}

/**
 * Groups an hourly forecast series into per-day energy totals (kWh), keyed by the location's
 * local calendar date ("YYYY-MM-DD"). Each point is treated as representing one hour of
 * average power, matching Open-Meteo's hourly resolution.
 *
 * @param hourly - the same Open-Meteo response the series was computed from, for its local time strings
 * @param series - a forecast series with the same length/order as hourly.times
 */
export function dailyTotalsKWh(hourly: OpenMeteoHourly, series: ForecastPoint[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (let i = 0; i < series.length; i++) {
		const dateKey = localDateKey(hourly.times[i]);
		const kWh = series[i].powerW / 1000;
		totals.set(dateKey, (totals.get(dateKey) ?? 0) + kWh);
	}
	return totals;
}
