import assert from "node:assert";
import type { PlanSlot } from "./optimizer.js";
import { setLanguage } from "../i18n/i18n.js";
import { buildPlanText, formatWhen, pvAt, serializePlan } from "./planText.js";

const H = 3600 * 1000;
const at = (day: number, hour: number, minute = 0): number => new Date(2026, 9, day, hour, minute).getTime();

const slot: PlanSlot = {
	startTs: at(31, 12),
	endTs: at(31, 12, 15),
	mode: "chargeFromGrid",
	socStartPercent: 40,
	socEndPercent: 45.04,
	priceCt: 30.123,
	feedInCt: 7.08,
	level: "CHEAP",
	pvW: 0,
	loadW: 400.4,
	gridW: 8400,
	batteryW: 8000,
	curtailedW: 0,
	marginalCostCt: 30.123,
	storedValueCt: 45,
	costCt: 63,
	reason: "Netzladen",
};

describe("planText", () => {
	beforeEach(() => setLanguage("de"));
	afterEach(() => setLanguage("en"));

	it("formats today, tomorrow and later dates", () => {
		const now = at(31, 10);
		assert.strictEqual(formatWhen(at(31, 12, 15), now), "heute 12:15");
		assert.strictEqual(formatWhen(at(32, 3), now), "morgen 03:00"); // Nov 1st
		assert.strictEqual(formatWhen(at(33, 12, 15), now), "Mo., 02.11. 12:15");
		setLanguage("en");
		assert.strictEqual(formatWhen(at(31, 12, 15), now), "today 12:15");
	});

	it("builds the recommendation sentence with flex window and savings", () => {
		const text = buildPlanText({
			current: slot,
			flex: { startTs: at(31, 12, 15), endTs: at(31, 14, 15), costCt: 28, avgCtPerKWh: 7, mainSource: "pv" },
			flexDurationH: 2,
			flexPowerKW: 2,
			expectedSavingsCt: 123,
			now: at(31, 10),
		});
		assert.ok(text.startsWith("Jetzt: Akku aus dem Netz laden – Netzladen (Strom 30,1 ct/kWh)."));
		assert.ok(text.includes("(2 h, 2 kW): heute 12:15 Uhr, ca. 0,28 € (Ø 7,0 ct/kWh, PV-Überschuss)."));
		assert.ok(text.includes("1,23 €"));
	});

	it("interpolates preceding-hour PV means between hour centers", () => {
		const points = [
			{ ts: at(31, 11), powerW: 1000 }, // mean 10:00-11:00 -> center 10:30
			{ ts: at(31, 12), powerW: 3000 }, // mean 11:00-12:00 -> center 11:30
		];
		assert.strictEqual(pvAt(points, at(31, 10, 30)), 1000);
		assert.strictEqual(pvAt(points, at(31, 11)), 2000);
		assert.strictEqual(pvAt(points, at(31, 11, 45)), 3000);
		assert.strictEqual(pvAt(points, at(31, 13)), 0);
		assert.strictEqual(pvAt([], at(31, 11)), 0);
		assert.ok(H > 0);
	});

	it("serializes a compact rounded plan", () => {
		const json = JSON.parse(serializePlan([slot]));
		assert.strictEqual(json[0].price, 30.12);
		assert.strictEqual(json[0].soc, 45);
		assert.strictEqual(json[0].load, 400);
		assert.strictEqual(json[0].mode, "chargeFromGrid");
	});
});
