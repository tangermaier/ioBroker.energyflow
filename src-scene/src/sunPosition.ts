// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Solar position math: pure functions, no DOM/map dependencies. Ported from Helios
 * (https://github.com/ReikanYsora/Helios, src/core/time/sun.ts, GPL-3.0-only - same license as
 * this project, chosen specifically to allow this kind of reuse) and adapted to drop the
 * single-entry render cache (not needed here - the widget re-renders far less often than
 * Helios' per-frame 3D scene). Validated by the original author against NOAA SPA over a year x
 * 8 latitudes (mean altitude error 0.30 degrees, azimuth error 0.36 degrees).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sun position in degrees (altitude above horizon, azimuth from north) */
export interface SunPosition {
	/** Degrees above (positive) or below (negative) the horizon */
	altitude: number;
	/** Degrees clockwise from north */
	azimuth: number;
}

/**
 * Computes the sun's altitude/azimuth at a UTC instant for a lat/lon point.
 *
 * @param date - the instant to compute the sun's position for
 * @param lat - observer latitude in degrees
 * @param lon - observer longitude in degrees
 */
export function getSunPosition(date: Date, lat: number, lon: number): SunPosition {
	const D = Math.PI / 180;
	const H = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
	const doy = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 0)) / DAY_MS);
	const decl = 23.45 * Math.sin(D * (360 / 365) * (doy - 81));
	const B = D * (360 / 365) * (doy - 81);
	const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);

	// Normalise hour angle to [-180, 180] so sign(ha) reliably gives AM/PM; without it, longitudes
	// far from Greenwich push ha out of range and flip the azimuth by up to 180 degrees.
	let ha = 15 * (H + lon / 15 + eot / 60 - 12);
	ha = ((((ha + 180) % 360) + 360) % 360) - 180;

	const sinA = Math.sin(D * lat) * Math.sin(D * decl) + Math.cos(D * lat) * Math.cos(D * decl) * Math.cos(D * ha);
	const alt = Math.asin(Math.max(-1, Math.min(1, sinA))) / D;
	const cAlt = Math.cos(alt * D);
	const cAz = cAlt > 1e-4 ? (Math.sin(D * decl) - Math.sin(D * lat) * sinA) / (Math.cos(D * lat) * cAlt) : 0;
	let az = Math.acos(Math.max(-1, Math.min(1, cAz))) / D;
	if (ha > 0) {
		az = 360 - az;
	}
	return { altitude: alt, azimuth: az };
}
