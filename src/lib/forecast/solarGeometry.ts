// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Minimal solar geometry for the PV model - pure, no dependencies. Uses NOAA's "General Solar
 * Position Calculations" fractional-year approximation (declination and equation of time, error
 * well below 0.5° - plenty for an hourly incidence-angle factor). The scene has its own, more
 * exact port of Helios' sun.ts (src-scene/src/sunPosition.ts); the backend deliberately doesn't
 * import from the separate Vite project.
 */

const DEG = Math.PI / 180;

/** Sun direction as a unit vector in local east/north/up coordinates. */
export interface SunVector {
	/** East component */
	east: number;
	/** North component */
	north: number;
	/** Up component (sine of the sun elevation) */
	up: number;
}

/**
 * Unit vector pointing at the sun for an instant and location.
 *
 * @param ts - absolute timestamp in ms
 * @param latitudeDeg - latitude in degrees
 * @param longitudeDeg - longitude in degrees (east positive)
 */
export function sunVector(ts: number, latitudeDeg: number, longitudeDeg: number): SunVector {
	const d = new Date(ts);
	const startOfYear = Date.UTC(d.getUTCFullYear(), 0, 1);
	const dayOfYear = Math.floor((ts - startOfYear) / 86400000) + 1;
	const hourUtc = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
	const gamma = ((2 * Math.PI) / 365) * (dayOfYear - 1 + (hourUtc - 12) / 24);

	const eqTimeMin =
		229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
	const decl =
		0.006918 -
		0.399912 * Math.cos(gamma) +
		0.070257 * Math.sin(gamma) -
		0.006758 * Math.cos(2 * gamma) +
		0.000907 * Math.sin(2 * gamma) -
		0.002697 * Math.cos(3 * gamma) +
		0.00148 * Math.sin(3 * gamma);

	const trueSolarTimeMin = hourUtc * 60 + eqTimeMin + 4 * longitudeDeg;
	const hourAngle = (trueSolarTimeMin / 4 - 180) * DEG;
	const lat = latitudeDeg * DEG;

	return {
		east: -Math.cos(decl) * Math.sin(hourAngle),
		north: Math.cos(lat) * Math.sin(decl) - Math.sin(lat) * Math.cos(decl) * Math.cos(hourAngle),
		up: Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(hourAngle),
	};
}

/**
 * Cosine of the angle of incidence of the sun on a tilted panel (negative = sun behind the panel).
 *
 * @param sun - sun direction (east/north/up unit vector)
 * @param tiltDeg - panel tilt (0 = horizontal, 90 = vertical)
 * @param azimuthDeg - panel azimuth, Open-Meteo convention (0 = south, -90 = east, 90 = west)
 */
export function cosIncidence(sun: SunVector, tiltDeg: number, azimuthDeg: number): number {
	const tilt = tiltDeg * DEG;
	const az = azimuthDeg * DEG;
	const nEast = -Math.sin(az) * Math.sin(tilt);
	const nNorth = -Math.cos(az) * Math.sin(tilt);
	const nUp = Math.cos(tilt);
	return sun.east * nEast + sun.north * nNorth + sun.up * nUp;
}

/** ASHRAE incidence-angle modifier coefficient for standard glass-covered modules. */
const ASHRAE_B0 = 0.05;

/**
 * Incidence-angle modifier (ASHRAE model): the fraction of BEAM irradiance that gets through
 * the module glass at a given incidence - glass reflects more the flatter the sun hits it.
 * 1 at normal incidence, falls off steeply below ~25° sun-to-panel angle, 0 behind the panel.
 *
 * @param cosTheta - cosine of the angle of incidence
 */
export function incidenceAngleModifier(cosTheta: number): number {
	if (cosTheta <= 0) {
		return 0;
	}
	return Math.max(0, Math.min(1, 1 - ASHRAE_B0 * (1 / cosTheta - 1)));
}
