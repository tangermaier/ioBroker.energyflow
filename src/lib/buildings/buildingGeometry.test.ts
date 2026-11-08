import assert from "node:assert";
import { pointInPolygon, toLocalBuildings } from "./buildingGeometry.js";
import type { OfmRing } from "./openFreeMap.js";

const HOME_LAT = 52.5162746; // neutral test location (Berlin, Pariser Platz)
const HOME_LON = 13.3777041;

function square(centerEastM: number, centerNorthM: number, halfSize: number): { eastM: number; northM: number }[] {
	return [
		{ eastM: centerEastM - halfSize, northM: centerNorthM - halfSize },
		{ eastM: centerEastM + halfSize, northM: centerNorthM - halfSize },
		{ eastM: centerEastM + halfSize, northM: centerNorthM + halfSize },
		{ eastM: centerEastM - halfSize, northM: centerNorthM + halfSize },
	];
}

/** Builds a lon/lat square ring roughly `eastM`/`northM` meters from HOME_LAT/HOME_LON, `halfSize` meters wide. */
function lonLatSquare(eastM: number, northM: number, halfSize: number): [number, number][] {
	const metresPerDegLat = 111_320;
	const metresPerDegLon = metresPerDegLat * Math.cos((HOME_LAT * Math.PI) / 180);
	const lon = HOME_LON + eastM / metresPerDegLon;
	const lat = HOME_LAT + northM / metresPerDegLat;
	const dLon = halfSize / metresPerDegLon;
	const dLat = halfSize / metresPerDegLat;
	return [
		[lon - dLon, lat - dLat],
		[lon + dLon, lat - dLat],
		[lon + dLon, lat + dLat],
		[lon - dLon, lat + dLat],
	];
}

function centroidEast(b: { points: { eastM: number }[] }): number {
	return b.points.reduce((sum, p) => sum + p.eastM / b.points.length, 0);
}

describe("buildingGeometry", () => {
	describe("pointInPolygon", () => {
		it("returns true for a point inside a square", () => {
			assert.strictEqual(pointInPolygon({ eastM: 0, northM: 0 }, square(0, 0, 5)), true);
		});

		it("returns false for a point outside a square", () => {
			assert.strictEqual(pointInPolygon({ eastM: 20, northM: 20 }, square(0, 0, 5)), false);
		});
	});

	describe("toLocalBuildings", () => {
		it("converts lon/lat rings into local meters roughly centered where expected", () => {
			const rings: OfmRing[] = [{ lonLat: lonLatSquare(30, 40, 4), heightM: 10 }];
			const building = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100).find(b => !b.isHome)!;
			const centroid = building.points.reduce((sum, p) => ({ eastM: sum.eastM + p.eastM / 4, northM: sum.northM + p.northM / 4 }), { eastM: 0, northM: 0 });
			assert.ok(Math.abs(centroid.eastM - 30) < 0.5, `expected eastM near 30, got ${centroid.eastM}`);
			assert.ok(Math.abs(centroid.northM - 40) < 0.5, `expected northM near 40, got ${centroid.northM}`);
		});

		it("marks the ring the home sits inside of as isHome and keeps it, rather than dropping it", () => {
			const rings: OfmRing[] = [{ lonLat: lonLatSquare(0, 0, 5), heightM: 8 }];
			const buildings = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100);
			assert.strictEqual(buildings.length, 1);
			assert.strictEqual(buildings[0].isHome, true);
			assert.strictEqual(buildings[0].heightM, 8);
		});

		it("synthesizes a small fallback square for the home when no OSM ring covers it", () => {
			const buildings = toLocalBuildings([], HOME_LAT, HOME_LON, 100);
			assert.strictEqual(buildings.length, 1);
			assert.strictEqual(buildings[0].isHome, true);
			assert.strictEqual(pointInPolygon({ eastM: 0, northM: 0 }, buildings[0].points), true);
		});

		it("excludes non-home buildings farther than radiusM, but still keeps the home", () => {
			const rings: OfmRing[] = [{ lonLat: lonLatSquare(200, 0, 4), heightM: 8 }];
			const buildings = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100);
			assert.strictEqual(buildings.length, 1);
			assert.strictEqual(buildings[0].isHome, true);
		});

		it("falls back to the default height when untagged", () => {
			const rings: OfmRing[] = [{ lonLat: lonLatSquare(20, 0, 4), heightM: null }];
			const building = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100).find(b => !b.isHome)!;
			assert.strictEqual(building.heightM, 6);
		});

		it("caps an implausibly tall untagged/real height", () => {
			const rings: OfmRing[] = [{ lonLat: lonLatSquare(20, 0, 4), heightM: 400 }];
			const building = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100).find(b => !b.isHome)!;
			assert.strictEqual(building.heightM, 25);
		});

		it("sorts non-home buildings nearest-first, with the home always first", () => {
			const rings: OfmRing[] = [
				{ lonLat: lonLatSquare(80, 0, 4), heightM: 8 },
				{ lonLat: lonLatSquare(20, 0, 4), heightM: 8 },
			];
			const buildings = toLocalBuildings(rings, HOME_LAT, HOME_LON, 100);
			assert.strictEqual(buildings.length, 3);
			assert.strictEqual(buildings[0].isHome, true);
			assert.ok(centroidEast(buildings[1]) < centroidEast(buildings[2]));
		});
	});
});
