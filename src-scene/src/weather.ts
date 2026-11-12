// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Weather-to-visual mapping: pure functions, no DOM dependencies. Ported from Helios
 * (https://github.com/ReikanYsora/Helios, src/scene/weather-fx.ts, GPL-3.0-only - same license
 * as this project, chosen specifically to allow this kind of reuse), keeping only the
 * `weatherLayers` condition/intensity model - Helios' particle-canvas rain/snow animation and
 * scene color grading are full-screen dashboard effects, out of scope for a compact card
 * widget. The condition label is translated to German, consistent with this widget's other
 * hardcoded German strings (see NODE_LABELS in SolarCockpitForecastWidget.tsx).
 */

import { t } from "./i18n";

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

/** Raw weather at an instant: cloud cover in %, precipitation in mm, snowfall in cm, WMO code, sun altitude in degrees. */
export interface WeatherInput {
	cloudCoverPct: number;
	precipitationMm: number;
	snowfallCm: number;
	weatherCode: number;
	sunAltitudeDeg: number;
}

export type WeatherCondition = "clear" | "partly-cloudy" | "cloudy" | "overcast" | "rain" | "snow" | "storm";

export interface WeatherLayers {
	/** Sun-glow strength (0-1): fades out under cloud cover and near/below the horizon - used to tint the sun-arc dot. */
	sun: number;
	condition: WeatherCondition;
	/** German label for the condition, for direct display. */
	label: string;
}

// WMO weather-code groups (https://open-meteo.com/en/docs). Snow: 71-77 (snowfall) + 85/86 (snow showers).
// Thunderstorm: 95 (slight/moderate) + 96/99 (with hail).
const isSnowCode = (c: number): boolean => (c >= 71 && c <= 77) || c === 85 || c === 86;
const isStormCode = (c: number): boolean => c === 95 || c === 96 || c === 99;

// A forecast can report a hair of precipitation (0.05mm in an hour, from rounding or dew) under an otherwise
// clear sky - that's a trace, not weather to show, so below these floors precipitation is treated as none.
const RAIN_MIN_MM = 0.1;
const SNOW_MIN_CM = 0.1;

/**
 * Maps raw weather (cloud/precipitation/snowfall/WMO code/sun altitude) to a display condition,
 * German label, and sun-glow strength.
 *
 * @param w - the raw weather to interpret
 */
export function weatherLayers(w: WeatherInput): WeatherLayers {
	const cloud01 = clamp01(w.cloudCoverPct / 100);
	const snowing = w.snowfallCm >= SNOW_MIN_CM || isSnowCode(w.weatherCode);
	const storm = isStormCode(w.weatherCode);
	const raining = !snowing && w.precipitationMm >= RAIN_MIN_MM;

	// Day factor fades the sun glow out as the sun nears the horizon (0 at/below horizon, full by ~18 degrees)
	// so sunrise/sunset don't show a full midday glow, and night stays dark.
	const dayFactor = clamp01(w.sunAltitudeDeg / 18);
	const sun = dayFactor * clamp01(1 - cloud01 / 0.85);

	const condition: WeatherCondition = storm
		? "storm"
		: snowing
			? "snow"
			: raining
				? "rain"
				: cloud01 > 0.75
					? "overcast"
					: cloud01 > 0.4
						? "cloudy"
						: cloud01 > 0.15
							? "partly-cloudy"
							: "clear";

	return { sun, condition, label: t(`weather_${condition}`) };
}
