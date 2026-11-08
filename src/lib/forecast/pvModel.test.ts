import assert from "node:assert";
import type { OpenMeteoHourly } from "./openMeteo.js";
import { dailyTotalsKWh, effectiveIrradiance, estimateProducerForecast, sumForecastSeries } from "./pvModel.js";

function hourly(overrides: Partial<OpenMeteoHourly>): OpenMeteoHourly {
	return {
		times: ["2026-09-08T12:00"],
		globalTiltedIrradiance: [0],
		temperature: [20],
		snowDepth: [0],
		cloudCoverPct: [0],
		precipitationMm: [0],
		snowfallCm: [0],
		weatherCode: [0],
		utcOffsetSeconds: 0,
		...overrides,
	};
}

describe("pvModel", () => {
	describe("estimateProducerForecast", () => {
		it("produces zero power at zero irradiance", () => {
			const series = estimateProducerForecast(5, hourly({ globalTiltedIrradiance: [0] }));
			assert.strictEqual(series[0].powerW, 0);
		});

		it("applies peak power, temperature derate and system loss at full irradiance", () => {
			// NOCT model: cellTemp = 25 + (45-20)/800*1000 = 56.25°C
			// tempFactor = 1 + (-0.0028)*(56.25-25) = 0.9125
			// powerW = 1kWp * 1000 * (1000/1000) * 0.9125 * 1 (no snow) * 0.83 (system loss) = 757.375
			const series = estimateProducerForecast(1, hourly({ globalTiltedIrradiance: [1000], temperature: [25] }));
			assert.ok(Math.abs(series[0].powerW - 757.375) < 1e-9);
		});

		it("cuts production to zero above the snow depth threshold", () => {
			const series = estimateProducerForecast(5, hourly({ globalTiltedIrradiance: [1000], snowDepth: [0.05] }));
			assert.strictEqual(series[0].powerW, 0);
		});

		it("never returns negative power even at extreme cell temperatures", () => {
			const series = estimateProducerForecast(5, hourly({ globalTiltedIrradiance: [1000], temperature: [80] }));
			assert.ok(series[0].powerW >= 0);
		});

		it("converts local time + offset to an absolute timestamp per point", () => {
			const series = estimateProducerForecast(1, hourly({ times: ["2026-09-08T12:00"], utcOffsetSeconds: 3600 }));
			assert.strictEqual(new Date(series[0].ts).toISOString(), "2026-09-08T11:00:00.000Z");
		});

		it("clamps to the inverter AC limit when the physical estimate exceeds it", () => {
			// Unclamped this would be well above 800 W (see the "applies peak power..." case above
			// at 1 kWp -> 757.375 W; a 2 kWp panel under the same conditions would be ~1514.75 W).
			const series = estimateProducerForecast(2, hourly({ globalTiltedIrradiance: [1000], temperature: [25] }), 800);
			assert.strictEqual(series[0].powerW, 800);
		});

		it("does not clamp when the estimate is already below the AC limit", () => {
			// 0.9 kWp under the same conditions as the "applies peak power..." case (which gives
			// 757.375 W per kWp) comes out to 681.64 W - comfortably under an 800 W cap.
			const series = estimateProducerForecast(0.9, hourly({ globalTiltedIrradiance: [1000], temperature: [25] }), 800);
			assert.ok(Math.abs(series[0].powerW - 681.6375) < 1e-9);
		});

		it("leaves the estimate uncapped when no AC limit is given", () => {
			const series = estimateProducerForecast(2, hourly({ globalTiltedIrradiance: [1000], temperature: [25] }));
			assert.ok(Math.abs(series[0].powerW - 1514.75) < 1e-9);
		});

		it("leaves the irradiance unchanged without geometry or DNI", () => {
			const geometry = { latitude: 49.74, longitude: 9.96, tiltDeg: 38, azimuthDeg: -70 };
			const base = estimateProducerForecast(1, hourly({ globalTiltedIrradiance: [500], temperature: [25] }));
			const noDni = estimateProducerForecast(1, hourly({ globalTiltedIrradiance: [500], temperature: [25] }), undefined, geometry);
			assert.strictEqual(noDni[0].powerW, base[0].powerW);
		});
	});

	describe("effectiveIrradiance (incidence-angle modifier)", () => {
		const south = { latitude: 49.74, longitude: 9.96, tiltDeg: 30, azimuthDeg: 0 };

		it("barely changes a south panel's irradiance around solar noon", () => {
			// 2026-06-21, hour ending 13:00 UTC+0 -> sun evaluated 12:30 UTC, near local solar noon (~11:22 UTC)
			const ts = Date.UTC(2026, 5, 21, 12, 0);
			const eff = effectiveIrradiance(800, 700, ts, south);
			assert.ok(eff > 790 && eff <= 800, String(eff));
		});

		it("reduces the beam share at grazing incidence, never the diffuse share", () => {
			// east-facing vertical-ish panel in the late afternoon: sun far off-normal
			const west = { ...south, tiltDeg: 80, azimuthDeg: -90 };
			const ts = Date.UTC(2026, 5, 21, 17, 0);
			const eff = effectiveIrradiance(100, 600, ts, west);
			assert.ok(eff <= 100);
			assert.ok(eff >= 0);
		});

		it("returns the plane-of-array value when DNI is unknown", () => {
			assert.strictEqual(effectiveIrradiance(300, null, Date.UTC(2026, 5, 21, 12), south), 300);
			assert.strictEqual(effectiveIrradiance(300, 500, Date.UTC(2026, 5, 21, 12), undefined), 300);
		});
	});

	describe("sumForecastSeries", () => {
		it("sums multiple series element-wise", () => {
			const a = [
				{ ts: 1000, powerW: 100 },
				{ ts: 2000, powerW: 200 },
			];
			const b = [
				{ ts: 1000, powerW: 50 },
				{ ts: 2000, powerW: 25 },
			];
			const combined = sumForecastSeries([a, b]);
			assert.deepStrictEqual(
				combined.map(p => p.powerW),
				[150, 225],
			);
		});

		it("returns an empty array for no series", () => {
			assert.deepStrictEqual(sumForecastSeries([]), []);
		});

		it("passes a single series through unchanged", () => {
			const a = [{ ts: 1000, powerW: 100 }];
			assert.deepStrictEqual(sumForecastSeries([a]), a);
		});
	});

	describe("dailyTotalsKWh", () => {
		it("groups hourly points by local calendar date and sums to kWh", () => {
			const h = hourly({
				times: ["2026-09-08T22:00", "2026-09-08T23:00", "2026-09-09T00:00"],
				globalTiltedIrradiance: [0, 0, 0],
			});
			const series = [
				{ ts: 1, powerW: 1000 },
				{ ts: 2, powerW: 1000 },
				{ ts: 3, powerW: 500 },
			];
			const totals = dailyTotalsKWh(h, series);
			assert.strictEqual(totals.get("2026-09-08"), 2);
			assert.strictEqual(totals.get("2026-09-09"), 0.5);
		});
	});
});
