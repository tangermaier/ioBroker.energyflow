/**
 * Minimal client for the Open-Meteo forecast API, requesting plane-of-array irradiance
 * (global_tilted_irradiance) computed server-side for a given panel tilt/azimuth - see
 * https://open-meteo.com/en/docs. No API key needed for non-commercial use.
 */

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/** One location/orientation's hourly forecast, in the location's local wall-clock time. */
export interface OpenMeteoHourly {
	/** Local time strings without UTC offset, e.g. "2026-09-08T14:00" - see localDateKey/toEpochMs */
	times: string[];
	/** Plane-of-array irradiance in W/m^2, one entry per time */
	globalTiltedIrradiance: number[];
	/** Direct normal irradiance in W/m^2 (mean over the preceding hour), one entry per time - splits the plane-of-array value into beam and diffuse for the incidence-angle modifier */
	directNormalIrradiance?: Array<number | null>;
	/** Ambient air temperature in °C, one entry per time */
	temperature: number[];
	/** Snow depth on the ground in meters, one entry per time */
	snowDepth: number[];
	/** Total cloud cover, percent (0-100), one entry per time */
	cloudCoverPct: number[];
	/** Precipitation (rain/showers/snow melt equivalent), mm, one entry per time */
	precipitationMm: number[];
	/** Snowfall, cm, one entry per time */
	snowfallCm: number[];
	/** WMO weather interpretation code (https://open-meteo.com/en/docs), one entry per time */
	weatherCode: number[];
	/** Seconds to add to a UTC instant to get local time at the requested location */
	utcOffsetSeconds: number;
}

interface OpenMeteoResponse {
	utc_offset_seconds: number;
	hourly: {
		time: string[];
		global_tilted_irradiance: number[];
		direct_normal_irradiance?: Array<number | null>;
		temperature_2m: number[];
		snow_depth: number[];
		cloud_cover: number[];
		precipitation: number[];
		snowfall: number[];
		weather_code: number[];
	};
}

/**
 * Fetches the plane-of-array irradiance forecast for one panel orientation at one location.
 *
 * @param params - the location and panel orientation to request the forecast for
 * @param params.latitude - installation latitude in degrees
 * @param params.longitude - installation longitude in degrees
 * @param params.tiltDeg - panel tilt in degrees (0 = horizontal, 90 = vertical)
 * @param params.azimuthDeg - panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west)
 * @param params.forecastDays - number of days to forecast (Open-Meteo allows up to 16)
 * @param params.pastDays - optional number of past days to prepend (Open-Meteo allows up to 92),
 *   served from the same near-real-time forecast model rather than the days-late ERA5 archive -
 *   the right source for a rolling "look back a day or two" comparison against actual production
 */
export async function fetchOpenMeteoForecast(params: {
	latitude: number;
	longitude: number;
	tiltDeg: number;
	azimuthDeg: number;
	forecastDays: number;
	pastDays?: number;
}): Promise<OpenMeteoHourly> {
	const url = new URL(FORECAST_URL);
	setCommonParams(url, params);
	url.searchParams.set("forecast_days", String(params.forecastDays));
	if (params.pastDays) {
		url.searchParams.set("past_days", String(params.pastDays));
	}
	return requestHourly(url);
}

/**
 * Fetches the same plane-of-array irradiance/temperature/snow data as fetchOpenMeteoForecast,
 * but for a past date range instead of a forecast horizon - Open-Meteo's Historical Weather
 * API (ERA5 reanalysis) supports the same global_tilted_irradiance computation for any past
 * date back to 1940. Used to reconstruct "what the physics model would have predicted" for
 * dates we have real production data for, to train the ML correction model without ever
 * having logged a live forecast for those dates.
 *
 * @param params - the location, panel orientation and date range to request
 * @param params.latitude - installation latitude in degrees
 * @param params.longitude - installation longitude in degrees
 * @param params.tiltDeg - panel tilt in degrees (0 = horizontal, 90 = vertical)
 * @param params.azimuthDeg - panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west)
 * @param params.startDate - first day to fetch, "YYYY-MM-DD"
 * @param params.endDate - last day to fetch (inclusive), "YYYY-MM-DD"
 */
export async function fetchOpenMeteoHistorical(params: {
	latitude: number;
	longitude: number;
	tiltDeg: number;
	azimuthDeg: number;
	startDate: string;
	endDate: string;
}): Promise<OpenMeteoHourly> {
	const url = new URL(ARCHIVE_URL);
	setCommonParams(url, params);
	url.searchParams.set("start_date", params.startDate);
	url.searchParams.set("end_date", params.endDate);
	return requestHourly(url);
}

/**
 * Sets the query parameters shared by both the forecast and archive endpoints.
 *
 * @param url - the request URL to add parameters to
 * @param params - location and panel orientation
 * @param params.latitude - installation latitude in degrees
 * @param params.longitude - installation longitude in degrees
 * @param params.tiltDeg - panel tilt in degrees (0 = horizontal, 90 = vertical)
 * @param params.azimuthDeg - panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west)
 */
function setCommonParams(url: URL, params: { latitude: number; longitude: number; tiltDeg: number; azimuthDeg: number }): void {
	url.searchParams.set("latitude", params.latitude.toFixed(6));
	url.searchParams.set("longitude", params.longitude.toFixed(6));
	url.searchParams.set("tilt", String(params.tiltDeg));
	url.searchParams.set("azimuth", String(params.azimuthDeg));
	url.searchParams.set("timezone", "auto");
	url.searchParams.set(
		"hourly",
		"global_tilted_irradiance,direct_normal_irradiance,temperature_2m,snow_depth,cloud_cover,precipitation,snowfall,weather_code",
	);
}

/**
 * Performs the HTTP request and maps the response into our own hourly shape.
 *
 * @param url - the fully-built request URL
 */
async function requestHourly(url: URL): Promise<OpenMeteoHourly> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Open-Meteo request failed: HTTP ${response.status} ${response.statusText}`);
	}
	const body = (await response.json()) as OpenMeteoResponse;

	return {
		times: body.hourly.time,
		globalTiltedIrradiance: body.hourly.global_tilted_irradiance,
		directNormalIrradiance: body.hourly.direct_normal_irradiance ?? [],
		temperature: body.hourly.temperature_2m,
		snowDepth: body.hourly.snow_depth,
		cloudCoverPct: body.hourly.cloud_cover,
		precipitationMm: body.hourly.precipitation,
		snowfallCm: body.hourly.snowfall,
		weatherCode: body.hourly.weather_code,
		utcOffsetSeconds: body.utc_offset_seconds,
	};
}

/** One point in a weather timeline series - the raw hourly values behind the widget's timeline scrubback. */
export interface WeatherPoint {
	/** Absolute Unix timestamp in milliseconds */
	ts: number;
	/** Air temperature in °C */
	temperatureC: number;
	/** Total cloud cover in percent */
	cloudCoverPct: number;
	/** Precipitation in mm */
	precipitationMm: number;
	/** Snowfall in cm */
	snowfallCm: number;
	/** WMO weather code */
	weatherCode: number;
}

/**
 * Maps an hourly Open-Meteo response into a weather timeline series, for the widget's timeline
 * scrubback to look up "what was the weather at this scrubbed time" - distinct from
 * currentHourIndex, which reads a single "right now" snapshot.
 *
 * @param hourly - an hourly series, in the location's local wall-clock time
 */
export function toWeatherSeries(hourly: OpenMeteoHourly): WeatherPoint[] {
	return hourly.times.map((t, i) => ({
		ts: toEpochMs(t, hourly.utcOffsetSeconds),
		temperatureC: hourly.temperature[i] ?? 0,
		cloudCoverPct: hourly.cloudCoverPct[i] ?? 0,
		precipitationMm: hourly.precipitationMm[i] ?? 0,
		snowfallCm: hourly.snowfallCm[i] ?? 0,
		weatherCode: hourly.weatherCode[i] ?? 0,
	}));
}

/**
 * Finds the index of the current (or most recently past) hour in an hourly series, for reading
 * a single "right now" snapshot out of an otherwise forward-looking forecast series - used for
 * the current-conditions weather states, distinct from the full multi-day series kept for the
 * yield forecast.
 *
 * @param hourly - an hourly series, in the location's local wall-clock time
 * @param nowMs - the instant to find the closest-past hour for, as a Unix timestamp in milliseconds
 */
export function currentHourIndex(hourly: OpenMeteoHourly, nowMs: number): number {
	let index = 0;
	for (let i = 0; i < hourly.times.length; i++) {
		if (toEpochMs(hourly.times[i], hourly.utcOffsetSeconds) <= nowMs) {
			index = i;
		} else {
			break;
		}
	}
	return index;
}

/**
 * Converts one of Open-Meteo's local (offset-less) time strings to an absolute Unix timestamp
 * in milliseconds.
 *
 * @param localTimeString - a value from OpenMeteoHourly.times, e.g. "2026-09-08T14:00"
 * @param utcOffsetSeconds - OpenMeteoHourly.utcOffsetSeconds for the same response
 */
export function toEpochMs(localTimeString: string, utcOffsetSeconds: number): number {
	return Date.parse(`${localTimeString}Z`) - utcOffsetSeconds * 1000;
}

/**
 * Extracts the location-local calendar date ("YYYY-MM-DD") from one of Open-Meteo's local time
 * strings - the right key to group hourly points into daily totals for "today"/"tomorrow".
 *
 * @param localTimeString - a value from OpenMeteoHourly.times, e.g. "2026-09-08T14:00"
 */
export function localDateKey(localTimeString: string): string {
	return localTimeString.slice(0, 10);
}

/**
 * Advances a "YYYY-MM-DD" date key by one calendar day. Pure calendar-string arithmetic (parsed
 * as UTC midnight, no timezone conversion involved) - used to derive "tomorrow"'s key from
 * "today"'s so daily totals can be looked up by date instead of assumed array position, which
 * broke once the hourly series could also contain past days (see fetchOpenMeteoForecast's
 * pastDays).
 *
 * @param dateKey - a date key as returned by localDateKey, e.g. "2026-09-08"
 */
export function nextDateKey(dateKey: string): string {
	const next = new Date(`${dateKey}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	return next.toISOString().slice(0, 10);
}
