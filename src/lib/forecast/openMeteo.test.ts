import assert from "node:assert";
import { currentHourIndex, localDateKey, nextDateKey, toEpochMs, toWeatherSeries, type OpenMeteoHourly } from "./openMeteo.js";

function makeHourly(times: string[]): OpenMeteoHourly {
	return {
		times,
		globalTiltedIrradiance: times.map(() => 0),
		temperature: times.map(() => 0),
		snowDepth: times.map(() => 0),
		cloudCoverPct: times.map(() => 0),
		precipitationMm: times.map(() => 0),
		snowfallCm: times.map(() => 0),
		weatherCode: times.map(() => 0),
		utcOffsetSeconds: 0,
	};
}

describe("openMeteo", () => {
	describe("toEpochMs", () => {
		it("interprets the local time string as UTC and subtracts the offset", () => {
			// "14:00" local at UTC+2 (7200s) is 12:00 UTC.
			const epoch = toEpochMs("2026-09-08T14:00", 7200);
			assert.strictEqual(new Date(epoch).toISOString(), "2026-09-08T12:00:00.000Z");
		});

		it("passes UTC times through unchanged when offset is 0", () => {
			const epoch = toEpochMs("2026-09-08T14:00", 0);
			assert.strictEqual(new Date(epoch).toISOString(), "2026-09-08T14:00:00.000Z");
		});

		it("handles a negative offset (west of UTC)", () => {
			// "10:00" local at UTC-5 is 15:00 UTC.
			const epoch = toEpochMs("2026-09-08T10:00", -5 * 3600);
			assert.strictEqual(new Date(epoch).toISOString(), "2026-09-08T15:00:00.000Z");
		});
	});

	describe("localDateKey", () => {
		it("extracts the date portion of a local time string", () => {
			assert.strictEqual(localDateKey("2026-09-08T14:00"), "2026-09-08");
		});

		it("is stable across different hours of the same day", () => {
			assert.strictEqual(localDateKey("2026-09-08T00:00"), localDateKey("2026-09-08T23:00"));
		});
	});

	describe("nextDateKey", () => {
		it("advances to the next calendar day", () => {
			assert.strictEqual(nextDateKey("2026-09-08"), "2026-09-09");
		});

		it("rolls over a month boundary", () => {
			assert.strictEqual(nextDateKey("2026-09-30"), "2026-10-01");
		});

		it("rolls over a year boundary, including into a leap day", () => {
			assert.strictEqual(nextDateKey("2027-12-31"), "2028-01-01");
			assert.strictEqual(nextDateKey("2028-02-28"), "2028-02-29");
		});
	});

	describe("currentHourIndex", () => {
		const hourly = makeHourly(["2026-09-08T00:00", "2026-09-08T01:00", "2026-09-08T02:00", "2026-09-08T03:00"]);

		it("picks the exact matching hour", () => {
			const now = toEpochMs("2026-09-08T02:00", 0);
			assert.strictEqual(currentHourIndex(hourly, now), 2);
		});

		it("picks the most recent past hour when between two entries", () => {
			const now = toEpochMs("2026-09-08T02:45", 0);
			assert.strictEqual(currentHourIndex(hourly, now), 2);
		});

		it("clamps to 0 when now is before the series starts", () => {
			const now = toEpochMs("2026-09-07T23:00", 0);
			assert.strictEqual(currentHourIndex(hourly, now), 0);
		});

		it("clamps to the last index when now is after the series ends", () => {
			const now = toEpochMs("2026-09-08T23:00", 0);
			assert.strictEqual(currentHourIndex(hourly, now), 3);
		});
	});

	describe("toWeatherSeries", () => {
		it("maps each hourly index into a weather point with the correct absolute timestamp", () => {
			const hourly = makeHourly(["2026-09-08T00:00", "2026-09-08T01:00"]);
			hourly.temperature = [12, 13.5];
			hourly.cloudCoverPct = [10, 80];
			hourly.precipitationMm = [0, 1.5];
			hourly.snowfallCm = [0, 0];
			hourly.weatherCode = [0, 61];

			const series = toWeatherSeries(hourly);
			assert.strictEqual(series.length, 2);
			assert.strictEqual(series[0].ts, toEpochMs("2026-09-08T00:00", 0));
			assert.strictEqual(series[1].ts, toEpochMs("2026-09-08T01:00", 0));
			assert.deepStrictEqual(series[1], { ts: series[1].ts, temperatureC: 13.5, cloudCoverPct: 80, precipitationMm: 1.5, snowfallCm: 0, weatherCode: 61 });
		});
	});
});
