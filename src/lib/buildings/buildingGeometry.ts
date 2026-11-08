// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Converts raw OpenFreeMap building rings (lon/lat) into local flat-earth geometry relative to
 * the home, for the widget's shadow math and mini site plan. Height fallback/cap values match
 * Helios' tuned defaults (src/core/config/constants.ts REAL_HEIGHT_CAP_M/REAL_HEIGHT_FALLBACK_M/
 * MIN_BUILDING_HEIGHT_M) - real-world constants, not project-specific, so reused as-is rather
 * than re-derived.
 */

import type { OfmRing } from "./openFreeMap.js";

const METRES_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;

/** Real-height cap (m) so one nearby tall building can't dominate; untagged buildings fall back to this height. */
const REAL_HEIGHT_CAP_M = 25;
const REAL_HEIGHT_FALLBACK_M = 6;
const MIN_BUILDING_HEIGHT_M = 3;
/** Safety cap on how many nearby buildings to keep (nearest first, home always included) in a dense urban area. */
const MAX_BUILDING_COUNT = 80;
/** Half-width (m) of the synthetic square used for the home when no OSM footprint covers it - Helios' fallbackHouse() default. */
const FALLBACK_HOME_HALF_WIDTH_M = 5;

/** A building footprint in local flat-earth meters relative to the home (+east, +north), with its cast height. */
export interface BuildingFootprint {
	/** Footprint outline in local meters relative to the home */
	points: { eastM: number; northM: number }[];
	/** Building height in meters */
	heightM: number;
	/** True for the one building that is the home itself - rendered highlighted, excluded as a shadow caster. */
	isHome: boolean;
}

/**
 * Converts a lon/lat point to local meters relative to a home position, using the same
 * equirectangular approximation as the rest of the project's geometry (see sunPosition.ts's
 * Helios lineage) - accurate enough at the few-hundred-meter scale a shadow query needs.
 *
 * @param lon - point longitude in degrees
 * @param lat - point latitude in degrees
 * @param homeLat - home latitude in degrees
 * @param homeLon - home longitude in degrees
 */
function toLocalMetres(lon: number, lat: number, homeLat: number, homeLon: number): { eastM: number; northM: number } {
	const metresPerDegLon = METRES_PER_DEGREE * Math.cos(homeLat * DEG);
	return {
		eastM: (lon - homeLon) * metresPerDegLon,
		northM: (lat - homeLat) * METRES_PER_DEGREE,
	};
}

/**
 * Ray-casting point-in-polygon test (even-odd rule) for a point and ring in local meters.
 *
 * @param point - the point to test
 * @param point.eastM
 * @param point.northM
 * @param ring - a closed (or implicitly-closed) polygon ring
 */
export function pointInPolygon(point: { eastM: number; northM: number }, ring: { eastM: number; northM: number }[]): boolean {
	let inside = false;
	for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
		const xi = ring[i].eastM;
		const yi = ring[i].northM;
		const xj = ring[j].eastM;
		const yj = ring[j].northM;
		const intersects = yi > point.northM !== yj > point.northM && point.eastM < ((xj - xi) * (point.northM - yi)) / (yj - yi) + xi;
		if (intersects) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * A single standard square footprint centred on the home, used when no OSM building covers the
 * configured position (untagged/unmapped house) - same fallback idea as Helios' fallbackHouse(),
 * so the site plan always has a home to highlight instead of silently having none.
 */
function fallbackHome(): { points: { eastM: number; northM: number }[]; heightM: number } {
	const h = FALLBACK_HOME_HALF_WIDTH_M;
	return {
		points: [
			{ eastM: -h, northM: -h },
			{ eastM: h, northM: -h },
			{ eastM: h, northM: h },
			{ eastM: -h, northM: h },
		],
		heightM: REAL_HEIGHT_FALLBACK_M,
	};
}

/**
 * Converts raw OpenFreeMap rings into local building footprints. The ring the home itself sits
 * inside of (if any) is marked `isHome` and always kept regardless of the distance/count limits
 * (it cannot shadow itself - see shadow.ts - but is still rendered, highlighted); a synthetic
 * square fallback is used if no OSM ring covers the home. Every other ring beyond `radiusM` from
 * the home is dropped (the tile fetch covers a bounding box slightly larger than the circular
 * radius); the rest are returned nearest-first, capped to MAX_BUILDING_COUNT.
 *
 * @param rings - raw building rings from fetchOfmBuildingRings
 * @param homeLat - home latitude in degrees
 * @param homeLon - home longitude in degrees
 * @param radiusM - only keep buildings within this distance of the home, in meters
 */
export function toLocalBuildings(rings: OfmRing[], homeLat: number, homeLon: number, radiusM: number): BuildingFootprint[] {
	const home = { eastM: 0, northM: 0 };

	const all = rings.map(ring => {
		const points = ring.lonLat.map(([lon, lat]) => toLocalMetres(lon, lat, homeLat, homeLon));
		const heightM = Math.min(REAL_HEIGHT_CAP_M, Math.max(MIN_BUILDING_HEIGHT_M, ring.heightM ?? REAL_HEIGHT_FALLBACK_M));
		const centroid = points.reduce((sum, p) => ({ eastM: sum.eastM + p.eastM / points.length, northM: sum.northM + p.northM / points.length }), {
			eastM: 0,
			northM: 0,
		});
		const distanceM = Math.hypot(centroid.eastM, centroid.northM);
		return { points, heightM, distanceM, isHome: pointInPolygon(home, points) };
	});

	const homeRing = all.find(b => b.isHome) ?? { ...fallbackHome(), distanceM: 0, isHome: true };
	const others = all
		.filter(b => !b.isHome && b.distanceM <= radiusM)
		.sort((a, b) => a.distanceM - b.distanceM)
		.slice(0, MAX_BUILDING_COUNT - 1);

	return [homeRing, ...others].map(b => ({ points: b.points, heightM: b.heightM, isHome: b.isHome }));
}
