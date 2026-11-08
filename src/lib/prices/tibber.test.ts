import assert from "node:assert";
import { feedInForSlot, findSlotAt, formatTibberHomeLabel, median, mergePriceSlots, normalizeInstance, parseTibberPriceJson } from "./tibber.js";

// Real excerpt of tibberlink's PricesToday.json (2026-10-31, quarter-hourly), shortened.
const SAMPLE = JSON.stringify([
	{ total: 0.4549, energy: 0.2548, tax: 0.2001, startsAt: "2026-10-31T00:00:00.000+01:00", currency: "EUR", level: "NORMAL" },
	{ total: 0.4447, energy: 0.2462, tax: 0.1985, startsAt: "2026-10-31T00:15:00.000+01:00", currency: "EUR", level: "NORMAL" },
	{ total: 0.4089, energy: 0.2162, tax: 0.1927, startsAt: "2026-10-31T00:30:00.000+01:00", currency: "EUR", level: "CHEAP" },
]);
const T0 = Date.parse("2026-10-31T00:00:00.000+01:00");
const Q = 15 * 60 * 1000;

describe("tibber", () => {
	describe("parseTibberPriceJson", () => {
		it("parses a real tibberlink price list into ct/kWh slots", () => {
			const slots = parseTibberPriceJson(SAMPLE);
			assert.strictEqual(slots.length, 3);
			assert.strictEqual(slots[0].startTs, T0);
			assert.strictEqual(slots[0].endTs, T0 + Q);
			assert.ok(Math.abs(slots[2].totalCt - 40.89) < 1e-9);
			assert.ok(Math.abs(slots[2].energyCt - 21.62) < 1e-9);
			assert.strictEqual(slots[2].level, "CHEAP");
		});

		it("gives the last slot the same length as its predecessor", () => {
			const slots = parseTibberPriceJson(SAMPLE);
			assert.strictEqual(slots[2].endTs - slots[2].startTs, Q);
		});

		it("returns [] for empty, malformed or non-array input", () => {
			assert.deepStrictEqual(parseTibberPriceJson("[]"), []);
			assert.deepStrictEqual(parseTibberPriceJson("{nope"), []);
			assert.deepStrictEqual(parseTibberPriceJson('{"a":1}'), []);
			assert.deepStrictEqual(parseTibberPriceJson(null), []);
		});

		it("skips malformed entries and sorts by start time", () => {
			const json = JSON.stringify([
				{ total: 0.3, energy: 0.1, startsAt: "2026-10-31T01:00:00.000+01:00" },
				{ total: "x", startsAt: "2026-10-31T00:30:00.000+01:00" },
				{ total: 0.2, energy: 0.05, startsAt: "2026-10-31T00:00:00.000+01:00" },
			]);
			const slots = parseTibberPriceJson(json);
			assert.strictEqual(slots.length, 2);
			assert.strictEqual(slots[0].startTs, T0);
			// gap to the next known slot becomes the slot length (hourly data still works)
			assert.strictEqual(slots[0].endTs, T0 + 4 * Q);
		});
	});

	describe("mergePriceSlots / findSlotAt", () => {
		it("lets later lists win, drops ended slots, keeps order", () => {
			const a = parseTibberPriceJson(SAMPLE);
			const b = [{ ...a[1], totalCt: 99 }];
			const merged = mergePriceSlots([a, b], T0 + Q);
			assert.strictEqual(merged.length, 2);
			assert.strictEqual(merged[0].totalCt, 99);
			assert.strictEqual(findSlotAt(merged, T0 + Q + 1)?.totalCt, 99);
			assert.strictEqual(findSlotAt(merged, T0 + 10 * Q), undefined);
		});
	});

	describe("feedInForSlot", () => {
		it("pays the fixed tariff normally, 0 during negative spot prices, tariff if spot unknown", () => {
			const slot = parseTibberPriceJson(SAMPLE)[0];
			assert.strictEqual(feedInForSlot(slot, 7.08), 7.08);
			assert.strictEqual(feedInForSlot({ ...slot, energyCt: -0.5 }, 7.08), 0);
			assert.strictEqual(feedInForSlot({ ...slot, energyCt: NaN }, 7.08), 7.08);
		});
	});

	describe("formatTibberHomeLabel / normalizeInstance / median", () => {
		it("formats address, postal code, city and app name", () => {
			assert.strictEqual(
				formatTibberHomeLabel({ id: "g", address1: "Musterstraße 1", postalCode: "12345", city: "Musterstadt", nameInApp: "Home" }),
				"Musterstraße 1, 12345 Musterstadt (Home)",
			);
			assert.strictEqual(formatTibberHomeLabel({ id: "g" }), "g");
		});

		it("normalizes both instance selector formats", () => {
			assert.strictEqual(normalizeInstance("system.adapter.tibberlink.0"), "tibberlink.0");
			assert.strictEqual(normalizeInstance("tibberlink.1"), "tibberlink.1");
			assert.strictEqual(normalizeInstance(undefined), "");
		});

		it("computes the median", () => {
			assert.strictEqual(median([3, 1, 2]), 2);
			assert.strictEqual(median([4, 1, 2, 3]), 2.5);
			assert.strictEqual(median([]), undefined);
		});
	});
});
