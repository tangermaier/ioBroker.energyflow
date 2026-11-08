// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Building-shadow geometry: pure functions, no DOM/MapLibre dependencies. The shadow-length/
 * direction formula is ported from Helios (https://github.com/ReikanYsora/Helios,
 * src/scene/buildings.ts renderShadows(), GPL-3.0-only - same license as this project). The
 * shadow SHAPE itself is a deliberate simplification: Helios draws the exact swept envelope
 * (footprint + translated copy + the quad each edge sweeps, to avoid a convex hull filling the
 * notch of an L-shaped building); this uses the convex hull of (footprint union translated
 * footprint) instead - visually very close for the mostly-rectangular residential footprints
 * OpenFreeMap returns, and enough simpler to keep this a small module rather than a full
 * scene-painter port. Ported near-verbatim from the widget-era `shadow.ts` (see git history,
 * commit 865675d) - the widget's 2D site-plan approach was retired when the 2.5D scene took over
 * lighting/occlusion via the real map, but the underlying geometry is exactly what's needed again
 * to draw real shadow polygons on the scene's ground plane. Building geometry itself
 * (BuildingFootprint) is real OSM data, local flat-earth meters relative to the home - see the
 * backend's buildingGeometry.ts.
 */

/** Cast length is capped so a very low sun doesn't streak a shadow across the whole scene. */
const MAX_SHADOW_M = 50;

export interface LocalPoint {
	eastM: number;
	northM: number;
}

export interface ShadowBuildingFootprint {
	points: LocalPoint[];
	heightM: number;
	/** True for the one building that is the home itself - excluded as a shadow caster (see homeIsShadowed/buildingShadowHull callers). */
	isHome: boolean;
}

/**
 * The offset vector (east, north meters) a building's shadow extends by, for a given sun
 * position - away from the sun, length capped at MAX_SHADOW_M. Returns a zero vector at/below
 * the horizon (no shadow to cast).
 *
 * @param heightM - the casting building's height in meters
 * @param sun - the sun's current altitude/azimuth in degrees
 * @param sun.altitudeDeg
 * @param sun.azimuthDeg
 */
export function shadowOffset(heightM: number, sun: { altitudeDeg: number; azimuthDeg: number }): LocalPoint {
	if (sun.altitudeDeg <= 0) {
		return { eastM: 0, northM: 0 };
	}
	const D = Math.PI / 180;
	const length = Math.min(heightM / Math.tan(sun.altitudeDeg * D), MAX_SHADOW_M);
	const away = (sun.azimuthDeg + 180) * D;
	return { eastM: Math.sin(away) * length, northM: Math.cos(away) * length };
}

/**
 * Translates every point of a footprint by a shadow offset - the "shadow-tip" copy of the
 * footprint, at the far end of the cast.
 *
 * @param points - the footprint's points
 * @param offset - the shadow offset from shadowOffset()
 */
export function translatePoints(points: LocalPoint[], offset: LocalPoint): LocalPoint[] {
	return points.map(p => ({ eastM: p.eastM + offset.eastM, northM: p.northM + offset.northM }));
}

/**
 * Convex hull via Andrew's monotone chain. Returns points in counter-clockwise order (fewer
 * than 3 input points are returned unchanged, degenerate but harmless for the callers here).
 *
 * @param points - the points to hull (footprint + translated footprint, typically)
 */
export function convexHull(points: LocalPoint[]): LocalPoint[] {
	if (points.length < 3) {
		return points;
	}
	const sorted = [...points].sort((a, b) => a.eastM - b.eastM || a.northM - b.northM);
	const cross = (o: LocalPoint, a: LocalPoint, b: LocalPoint): number =>
		(a.eastM - o.eastM) * (b.northM - o.northM) - (a.northM - o.northM) * (b.eastM - o.eastM);

	const lower: LocalPoint[] = [];
	for (const p of sorted) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
			lower.pop();
		}
		lower.push(p);
	}
	const upper: LocalPoint[] = [];
	for (let i = sorted.length - 1; i >= 0; i--) {
		const p = sorted[i];
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
			upper.pop();
		}
		upper.push(p);
	}
	lower.pop();
	upper.pop();
	return [...lower, ...upper];
}

/**
 * Ray-casting point-in-polygon test (even-odd rule).
 *
 * @param point
 * @param ring
 */
export function pointInPolygon(point: LocalPoint, ring: LocalPoint[]): boolean {
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
 * The shadow shape a building casts at a given sun position, as a convex hull of its footprint
 * and the shadow-tip copy - null when the sun is at/below the horizon (nothing is cast).
 *
 * @param building - the casting building
 * @param sun - the sun's current altitude/azimuth in degrees
 * @param sun.altitudeDeg
 * @param sun.azimuthDeg
 */
export function buildingShadowHull(building: ShadowBuildingFootprint, sun: { altitudeDeg: number; azimuthDeg: number }): LocalPoint[] | null {
	if (sun.altitudeDeg <= 0) {
		return null;
	}
	const offset = shadowOffset(building.heightM, sun);
	const cast = translatePoints(building.points, offset);
	return convexHull([...building.points, ...cast]);
}

/**
 * Whether any of the given buildings casts a shadow reaching the home (local origin) at the
 * given sun position.
 *
 * @param buildings - nearby buildings (see the backend's summary.buildings.footprints)
 * @param sun - the sun's current altitude/azimuth in degrees
 * @param sun.altitudeDeg
 * @param sun.azimuthDeg
 */
export function homeIsShadowed(buildings: ShadowBuildingFootprint[], sun: { altitudeDeg: number; azimuthDeg: number }): boolean {
	const home: LocalPoint = { eastM: 0, northM: 0 };
	return buildings.some(b => {
		if (b.isHome) {
			return false;
		}
		const hull = buildingShadowHull(b, sun);
		return hull !== null && pointInPolygon(home, hull);
	});
}
