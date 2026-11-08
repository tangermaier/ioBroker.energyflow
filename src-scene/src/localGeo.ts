/**
 * Local flat-earth meters <-> lon/lat conversions, relative to a home position - the same
 * equirectangular approximation used throughout this project (see the backend's
 * buildingGeometry.ts and the widget's shadow.ts), so a building's points from
 * summary.buildings.footprints (already in local meters) can be placed back onto a real map, and
 * the sun's computed local position can be placed onto the same map.
 */

const METRES_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;

export interface LonLat {
	lon: number;
	lat: number;
}

/**
 * Converts a local east/north offset (in meters, relative to the home) back to an absolute
 * lon/lat point.
 *
 * @param eastM - east offset in meters (negative = west)
 * @param northM - north offset in meters (negative = south)
 * @param homeLat - home latitude in degrees
 * @param homeLon - home longitude in degrees
 */
export function localToLonLat(eastM: number, northM: number, homeLat: number, homeLon: number): LonLat {
	const metresPerDegLon = METRES_PER_DEGREE * Math.cos(homeLat * DEG);
	return {
		lon: homeLon + eastM / metresPerDegLon,
		lat: homeLat + northM / METRES_PER_DEGREE,
	};
}
