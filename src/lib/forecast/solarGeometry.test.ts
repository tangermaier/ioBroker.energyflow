import assert from "node:assert";
import { cosIncidence, incidenceAngleModifier, sunVector } from "./solarGeometry.js";

const DEG = 180 / Math.PI;
const LAT = 49.74;
const LON = 9.96;

describe("solarGeometry", () => {
	it("puts the summer-solstice noon sun at 90 - lat + 23.44 degrees elevation, due south", () => {
		// local solar noon ~ 12:00 UTC - 4 min/deg x 9.96 deg + 1.7 min equation of time ~ 11:22 UTC
		const sun = sunVector(Date.UTC(2026, 5, 21, 11, 22), LAT, LON);
		const elevation = Math.asin(sun.up) * DEG;
		assert.ok(Math.abs(elevation - (90 - LAT + 23.44)) < 0.5, String(elevation));
		assert.ok(Math.abs(sun.east) < 0.02, `east ${sun.east}`);
		assert.ok(sun.north < 0, "sun is to the south");
	});

	it("rises in the east and is below the horizon at midnight", () => {
		const morning = sunVector(Date.UTC(2026, 5, 21, 5, 0), LAT, LON);
		assert.ok(morning.east > 0.5);
		const midnight = sunVector(Date.UTC(2026, 5, 21, 23, 22), LAT, LON);
		assert.ok(midnight.up < 0);
	});

	it("gives normal incidence for a panel tilted towards the noon sun", () => {
		const sun = sunVector(Date.UTC(2026, 5, 21, 11, 22), LAT, LON);
		const tilt = LAT - 23.44; // panel normal points at the noon sun
		assert.ok(cosIncidence(sun, tilt, 0) > 0.999);
		// a north-facing vertical wall sees the noon sun from behind
		assert.ok(cosIncidence(sun, 90, 180) < 0);
	});

	it("uses the Open-Meteo azimuth convention (-90 = east)", () => {
		const morning = sunVector(Date.UTC(2026, 5, 21, 5, 0), LAT, LON);
		assert.ok(cosIncidence(morning, 90, -90) > cosIncidence(morning, 90, 90));
	});

	it("models the ASHRAE incidence-angle modifier", () => {
		assert.strictEqual(incidenceAngleModifier(1), 1);
		assert.ok(Math.abs(incidenceAngleModifier(0.5) - 0.95) < 1e-12); // 60 deg
		assert.strictEqual(incidenceAngleModifier(0), 0);
		assert.strictEqual(incidenceAngleModifier(-0.3), 0);
		assert.ok(Math.abs(incidenceAngleModifier(0.05) - 0.05) < 1e-12); // ~87 deg
		assert.strictEqual(incidenceAngleModifier(0.04), 0); // beyond ~87.3 deg: clamped at 0
	});
});
