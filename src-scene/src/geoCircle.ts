import { localToLonLat } from "./localGeo";

/**
 * Builds a small regular-polygon ring (octagon) approximating a circle of `radiusM` around a
 * local east/north offset, as a closed GeoJSON-ready lon/lat ring. Used to give the sun (and its
 * daily trail) a small extruded footprint, the same way real buildings have one - fill-extrusion
 * layers need polygons, not points.
 *
 * @param eastM - east offset in meters (negative = west)
 * @param northM - north offset in meters (negative = south)
 * @param radiusM - circle radius in meters
 * @param homeLat - home latitude in degrees
 * @param homeLon - home longitude in degrees
 */
export function circleRing(eastM: number, northM: number, radiusM: number, homeLat: number, homeLon: number): [number, number][] {
	const SIDES = 8;
	const ring: [number, number][] = [];
	for (let i = 0; i <= SIDES; i++) {
		const angle = (i / SIDES) * 2 * Math.PI;
		const p = localToLonLat(eastM + Math.sin(angle) * radiusM, northM + Math.cos(angle) * radiusM, homeLat, homeLon);
		ring.push([p.lon, p.lat]);
	}
	return ring;
}
