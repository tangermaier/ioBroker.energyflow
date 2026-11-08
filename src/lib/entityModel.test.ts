import assert from "node:assert";
import {
	computeBalance,
	computeInverterLoss,
	computeLossPower,
	deriveLossDefinitions,
	groupChildrenByParent,
	isSourceStale,
	normalizePower,
	parseEntities,
	resolveSource,
	selectForecastableEntities,
	type EntityRowConfig,
} from "./entityModel.js";

function row(overrides: Partial<EntityRowConfig>): EntityRowConfig {
	return {
		entityId: "e1",
		name: "Entity 1",
		category: "consumer",
		powerStateId: "some.state.power",
		powerUnit: "W",
		invertSign: false,
		noiseThresholdW: 0,
		energyStateId: "",
		parentId: "",
		invertInParent: false,
		socStateId: "",
		capacityKWh: 0,
		peakPowerKWp: 0,
		tiltDeg: 0,
		azimuthDeg: 0,
		acLimitW: 0,
		color: "#8892a0",
		deriveFromBalance: false,
		...overrides,
	};
}

describe("entityModel", () => {
	describe("parseEntities", () => {
		it("accepts a valid minimal entity", () => {
			const { entities, warnings } = parseEntities([row({})]);
			assert.strictEqual(entities.length, 1);
			assert.strictEqual(warnings.length, 0);
			assert.strictEqual(entities[0].entityId, "e1");
		});

		it("skips a row without an entity ID", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "" })]);
			assert.strictEqual(entities.length, 0);
			assert.strictEqual(warnings.length, 1);
		});

		it("skips a row with an invalid entity ID", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "not valid!" })]);
			assert.strictEqual(entities.length, 0);
			assert.match(warnings[0], /may only contain/);
		});

		it("skips duplicate entity IDs, keeping the first", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "dup", name: "First" }), row({ entityId: "dup", name: "Second" })]);
			assert.strictEqual(entities.length, 1);
			assert.strictEqual(entities[0].name, "First");
			assert.strictEqual(warnings.length, 1);
		});

		it("skips a row without a power state", () => {
			const { entities, warnings } = parseEntities([row({ powerStateId: "" })]);
			assert.strictEqual(entities.length, 0);
			assert.match(warnings[0], /no power state/);
		});

		it("drops socStateId/capacityKWh for non-storage categories", () => {
			const { entities } = parseEntities([row({ category: "producer", socStateId: "some.soc", capacityKWh: 10 })]);
			assert.strictEqual(entities[0].socStateId, undefined);
			assert.strictEqual(entities[0].capacityKWh, undefined);
		});

		it("keeps socStateId/capacityKWh for storage entities", () => {
			const { entities } = parseEntities([row({ category: "storage", socStateId: "some.soc", capacityKWh: 10 })]);
			assert.strictEqual(entities[0].socStateId, "some.soc");
			assert.strictEqual(entities[0].capacityKWh, 10);
		});

		it("defaults noiseThresholdW to 0 and keeps it regardless of category", () => {
			const { entities } = parseEntities([row({ category: "producer" })]);
			assert.strictEqual(entities[0].noiseThresholdW, 0);
		});

		it("parses a configured noiseThresholdW as its absolute value", () => {
			const { entities } = parseEntities([row({ noiseThresholdW: 12 })]);
			assert.strictEqual(entities[0].noiseThresholdW, 12);
		});

		it("resolves a forward-referenced parent", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "child", parentId: "parent" }), row({ entityId: "parent", category: "consumer" })]);
			assert.strictEqual(warnings.length, 0);
			assert.strictEqual(entities.find(e => e.entityId === "child")?.parentId, "parent");
		});

		it("drops a dangling parent reference with a warning", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "child", parentId: "ghost" })]);
			assert.strictEqual(entities[0].parentId, undefined);
			assert.match(warnings[0], /does not exist/);
		});

		it("drops a self-referencing parent with a warning", () => {
			const { entities, warnings } = parseEntities([row({ entityId: "loop", parentId: "loop" })]);
			assert.strictEqual(entities[0].parentId, undefined);
			assert.match(warnings[0], /does not exist/);
		});

		it("keeps invertInParent for a producer netted into a parent's reading", () => {
			// e.g. a balcony power plant feeding into the house wiring downstream of a house
			// consumption meter: the meter already nets the production out, so it must be
			// added back (inverted) rather than subtracted like a regular sub-consumer.
			const { entities } = parseEntities([
				row({ entityId: "house_meter", category: "consumer" }),
				row({ entityId: "balcony_pv", category: "producer", parentId: "house_meter", invertInParent: true }),
			]);
			assert.strictEqual(entities.find(e => e.entityId === "balcony_pv")?.invertInParent, true);
		});

		it("drops forecast fields for non-producer categories", () => {
			const { entities } = parseEntities([row({ category: "consumer", peakPowerKWp: 5, tiltDeg: 30, azimuthDeg: 0 })]);
			assert.strictEqual(entities[0].peakPowerKWp, undefined);
			assert.strictEqual(entities[0].tiltDeg, undefined);
			assert.strictEqual(entities[0].azimuthDeg, undefined);
		});

		it("keeps forecast fields for producer entities", () => {
			const { entities } = parseEntities([row({ category: "producer", peakPowerKWp: 5.5, tiltDeg: 35, azimuthDeg: -90 })]);
			assert.strictEqual(entities[0].peakPowerKWp, 5.5);
			assert.strictEqual(entities[0].tiltDeg, 35);
			assert.strictEqual(entities[0].azimuthDeg, -90);
		});
	});

	describe("selectForecastableEntities", () => {
		it("includes a producer with all three physical parameters set", () => {
			const { entities } = parseEntities([row({ category: "producer", peakPowerKWp: 5, tiltDeg: 30, azimuthDeg: 0 })]);
			assert.strictEqual(selectForecastableEntities(entities).length, 1);
		});

		it("excludes a producer missing peak power", () => {
			const { entities } = parseEntities([row({ category: "producer", peakPowerKWp: 0, tiltDeg: 30, azimuthDeg: 0 })]);
			assert.strictEqual(selectForecastableEntities(entities).length, 0);
		});

		it("excludes a producer missing tilt", () => {
			// tiltDeg: 0 is a valid, meaningful value (a flat panel) - only an unconfigured
			// field (never set, i.e. undefined after parsing) should exclude the entity.
			const rows = [row({ category: "producer", peakPowerKWp: 5, azimuthDeg: 0 })];
			delete (rows[0] as Partial<EntityRowConfig>).tiltDeg;
			const { entities } = parseEntities(rows);
			assert.strictEqual(selectForecastableEntities(entities).length, 0);
		});

		it("excludes a non-producer entity even with all three fields set", () => {
			const { entities } = parseEntities([row({ category: "consumer", peakPowerKWp: 5, tiltDeg: 30, azimuthDeg: 0 })]);
			assert.strictEqual(selectForecastableEntities(entities).length, 0);
		});
	});

	describe("normalizePower", () => {
		it("passes Watt values through unchanged", () => {
			assert.strictEqual(normalizePower(150, { powerUnit: "W", invertSign: false, noiseThresholdW: 0 }), 150);
		});

		it("converts kW to W", () => {
			assert.strictEqual(normalizePower(1.5, { powerUnit: "kW", invertSign: false, noiseThresholdW: 0 }), 1500);
		});

		it("inverts sign when configured", () => {
			assert.strictEqual(normalizePower(150, { powerUnit: "W", invertSign: true, noiseThresholdW: 0 }), -150);
		});

		it("combines unit conversion and sign inversion", () => {
			assert.strictEqual(normalizePower(-2, { powerUnit: "kW", invertSign: true, noiseThresholdW: 0 }), 2000);
		});

		it("zeroes out a reading below the noise threshold", () => {
			assert.strictEqual(normalizePower(8, { powerUnit: "W", invertSign: false, noiseThresholdW: 10 }), 0);
		});

		it("zeroes out a negative reading whose magnitude is below the noise threshold", () => {
			assert.strictEqual(normalizePower(-8, { powerUnit: "W", invertSign: false, noiseThresholdW: 10 }), 0);
		});

		it("leaves a reading at or above the noise threshold unaffected", () => {
			assert.strictEqual(normalizePower(10, { powerUnit: "W", invertSign: false, noiseThresholdW: 10 }), 10);
			assert.strictEqual(normalizePower(15, { powerUnit: "W", invertSign: false, noiseThresholdW: 10 }), 15);
		});

		it("judges the threshold in Watt after kW conversion, not before", () => {
			assert.strictEqual(normalizePower(0.008, { powerUnit: "kW", invertSign: false, noiseThresholdW: 10 }), 0);
			assert.strictEqual(normalizePower(0.015, { powerUnit: "kW", invertSign: false, noiseThresholdW: 10 }), 15);
		});

		it("a threshold of 0 disables the cutoff entirely", () => {
			assert.strictEqual(normalizePower(0.001, { powerUnit: "W", invertSign: false, noiseThresholdW: 0 }), 0.001);
		});
	});

	describe("groupChildrenByParent", () => {
		it("groups multiple children under the same parent", () => {
			const { entities } = parseEntities([
				row({ entityId: "parent" }),
				row({ entityId: "c1", parentId: "parent" }),
				row({ entityId: "c2", parentId: "parent" }),
			]);
			const groups = groupChildrenByParent(entities);
			assert.strictEqual(groups.get("parent")?.length, 2);
		});

		it("returns an empty map when nothing has a parent", () => {
			const { entities } = parseEntities([row({ entityId: "solo" })]);
			assert.strictEqual(groupChildrenByParent(entities).size, 0);
		});
	});

	describe("deriveLossDefinitions", () => {
		it("creates a producer loss entity when efficiencyPercent is below 100", () => {
			const { entities } = parseEntities([row({ entityId: "pv", category: "producer", efficiencyPercent: 97 })]);
			const losses = deriveLossDefinitions(entities);
			assert.strictEqual(losses.length, 1);
			assert.strictEqual(losses[0].entityId, "pv_loss");
			assert.strictEqual(losses[0].kind, "producerLoss");
			assert.strictEqual(losses[0].sourceEntityId, "pv");
			assert.strictEqual(losses[0].efficiencyPercent, 97);
		});

		it("creates no loss entity for a producer left at the 100% default", () => {
			const { entities } = parseEntities([row({ entityId: "pv", category: "producer" })]);
			assert.strictEqual(deriveLossDefinitions(entities).length, 0);
		});

		it("creates separate charge- and discharge-loss entities for a storage with both configured", () => {
			const { entities } = parseEntities([
				row({ entityId: "battery", category: "storage", chargeEfficiencyPercent: 95, dischargeEfficiencyPercent: 92 }),
			]);
			const losses = deriveLossDefinitions(entities);
			assert.strictEqual(losses.length, 2);
			const charge = losses.find(l => l.kind === "chargeLoss");
			const discharge = losses.find(l => l.kind === "dischargeLoss");
			assert.strictEqual(charge?.entityId, "battery_chargeloss");
			assert.strictEqual(charge?.efficiencyPercent, 95);
			assert.strictEqual(discharge?.entityId, "battery_dischargeloss");
			assert.strictEqual(discharge?.efficiencyPercent, 92);
		});

		it("creates only a charge-loss entity when only charge efficiency is configured", () => {
			const { entities } = parseEntities([row({ entityId: "battery", category: "storage", chargeEfficiencyPercent: 95 })]);
			const losses = deriveLossDefinitions(entities);
			assert.strictEqual(losses.length, 1);
			assert.strictEqual(losses[0].kind, "chargeLoss");
		});

		it("ignores efficiency fields on categories they don't apply to", () => {
			// parseEntities only carries efficiencyPercent through for category "producer" - a consumer row setting it is a no-op.
			const { entities } = parseEntities([row({ entityId: "c1", category: "consumer", efficiencyPercent: 50 })]);
			assert.strictEqual(deriveLossDefinitions(entities).length, 0);
		});
	});

	describe("computeLossPower", () => {
		it("computes producer loss from any positive source power", () => {
			assert.ok(Math.abs(computeLossPower({ kind: "producerLoss", efficiencyPercent: 97 }, 1000) - 30) < 1e-9);
		});

		it("never returns negative producer loss for a negative source power", () => {
			assert.strictEqual(computeLossPower({ kind: "producerLoss", efficiencyPercent: 97 }, -500), 0);
		});

		it("computes charge loss only while the source power is positive (charging)", () => {
			assert.ok(Math.abs(computeLossPower({ kind: "chargeLoss", efficiencyPercent: 95 }, 1000) - 50) < 1e-9);
			assert.strictEqual(computeLossPower({ kind: "chargeLoss", efficiencyPercent: 95 }, -1000), 0);
		});

		it("computes discharge loss only while the source power is negative (discharging)", () => {
			assert.ok(Math.abs(computeLossPower({ kind: "dischargeLoss", efficiencyPercent: 95 }, -1000) - 50) < 1e-9);
			assert.strictEqual(computeLossPower({ kind: "dischargeLoss", efficiencyPercent: 95 }, 1000), 0);
		});
	});

	describe("powerSource", () => {
		it("migrates the legacy deriveFromBalance flag and defaults to measured", () => {
			const { entities } = parseEntities([
				row({ entityId: "netz", category: "grid", deriveFromBalance: true }),
				row({ entityId: "akku", category: "storage" }),
			]);
			assert.strictEqual(entities[0].powerSource, "balance");
			assert.strictEqual(entities[1].powerSource, "measured");
			assert.strictEqual(entities[0].staleAfterS, 120);
		});

		it("prefers an explicit powerSource over the legacy flag and only allows it for grid/storage", () => {
			const { entities } = parseEntities([
				row({ entityId: "netz", category: "grid", deriveFromBalance: true, powerSource: "measuredWithFallback", staleAfterS: 60 }),
				row({ entityId: "haus", category: "consumer", powerSource: "balance" }),
			]);
			assert.strictEqual(entities[0].powerSource, "measuredWithFallback");
			assert.strictEqual(entities[0].staleAfterS, 60);
			assert.strictEqual(entities[1].powerSource, "measured");
		});

		it("allows only one balance-derived entity and warns about the second", () => {
			const { entities, warnings } = parseEntities([
				row({ entityId: "netz", category: "grid", powerSource: "measuredWithFallback" }),
				row({ entityId: "akku", category: "storage", powerSource: "balance" }),
			]);
			assert.strictEqual(entities[0].powerSource, "measuredWithFallback");
			assert.strictEqual(entities[1].powerSource, "measured");
			assert.ok(warnings.some(w => w.includes("akku") && w.includes("only one entity")));
		});

		it("keeps exportStateId for grid entities only", () => {
			const { entities } = parseEntities([
				row({ entityId: "netz", category: "grid", exportStateId: "tibber.production" }),
				row({ entityId: "pv", category: "producer", exportStateId: "x" }),
			]);
			assert.strictEqual(entities[0].exportStateId, "tibber.production");
			assert.strictEqual(entities[1].exportStateId, undefined);
		});
	});

	describe("computeBalance", () => {
		it("derives grid and storage and the signed residual (day-1 numbers of the Pulse round)", () => {
			// 2026-10-31 until 16:30: PV 6.25, house 4.65, battery register -1.14 (discharge), Pulse grid +0.43 kWh
			const b = computeBalance({ producer: 6.25, consumer: 4.65, storage: -1.14, grid: 0.43, loss: 0 });
			assert.ok(Math.abs(b.gridBalance - -2.74) < 1e-9);
			assert.ok(Math.abs(b.storageBalance - 2.03) < 1e-9);
			assert.ok(Math.abs(b.residual - 3.17) < 1e-9); // more measured supply than use
		});

		it("has a residual of exactly -losses when the grid itself is the balance", () => {
			const t = { producer: 3000, consumer: 1200, storage: 500, grid: 0, loss: 80 };
			const grid = computeBalance(t).gridBalance;
			assert.strictEqual(computeBalance({ ...t, grid }).residual, -80);
		});
	});

	describe("isSourceStale", () => {
		it("judges staleness by the newest source update", () => {
			const now = 1_000_000;
			assert.strictEqual(isSourceStale(now - 119_000, now, 120), false);
			assert.strictEqual(isSourceStale(now - 121_000, now, 120), true);
			assert.strictEqual(isSourceStale(undefined, now, 120), true);
		});
	});
	describe("fallback source", () => {
		it("prefers the primary, then the fallback, then the balance", () => {
			assert.strictEqual(resolveSource("measuredWithFallback", true, true), "measured");
			assert.strictEqual(resolveSource("measuredWithFallback", false, true), "fallback");
			assert.strictEqual(resolveSource("measuredWithFallback", false, false), "balance");
			assert.strictEqual(resolveSource("measured", false, true), "measured");
			assert.strictEqual(resolveSource("balance", true, true), "balance");
		});

		it("keeps a fallback state only for measuredWithFallback grid/storage entities", () => {
			const { entities, warnings } = parseEntities([
				row({ entityId: "netz", category: "grid", powerSource: "measuredWithFallback", fallbackStateId: "deye.40626", fallbackInvertSign: true }),
				row({ entityId: "akku", category: "storage", powerSource: "measured", fallbackStateId: "x" }),
			]);
			assert.strictEqual(entities[0].fallbackStateId, "deye.40626");
			assert.strictEqual(entities[0].fallbackInvertSign, true);
			assert.strictEqual(entities[1].fallbackStateId, undefined);
			assert.strictEqual(warnings.length, 1);
		});
	});

	describe("measured inverter loss", () => {
		const rows = (): EntityRowConfig[] => [
			row({ entityId: "pv1", category: "producer", efficiencyPercent: 97 }),
			row({ entityId: "pv2", category: "producer", efficiencyPercent: 97 }),
			row({ entityId: "bkw", category: "producer", efficiencyPercent: 96.7 }),
			row({
				entityId: "akku",
				category: "storage",
				chargeEfficiencyPercent: 95,
				dischargeEfficiencyPercent: 95,
				inverterAcStateId: "deye.40637",
				inverterPvIds: "pv1, pv2, nope",
			}),
		];

		it("validates the DC input ids", () => {
			const { entities, warnings } = parseEntities(rows());
			assert.deepStrictEqual(entities.find(e => e.entityId === "akku")?.inverterPvIds, ["pv1", "pv2"]);
			assert.ok(warnings.some(w => w.includes("nope")));
		});

		it("replaces the estimated losses of the inverter's inputs and battery, keeps the others", () => {
			const losses = deriveLossDefinitions(parseEntities(rows()).entities);
			assert.deepStrictEqual(losses.map(l => l.entityId).sort(), ["akku_inverterloss", "bkw_loss"]);
			const inv = losses.find(l => l.kind === "inverterLoss");
			assert.strictEqual(inv?.acStateId, "deye.40637");
			assert.deepStrictEqual(inv?.inputIds, ["pv1", "pv2"]);
		});

		it("computes DC in minus AC out, clamped at 0", () => {
			// night: battery discharges 249 W DC, inverter delivers 120 W AC
			assert.strictEqual(computeInverterLoss(0, -249, 120), 129);
			// day: 3500 W PV, 2300 W into the battery, 900 W AC out
			assert.strictEqual(computeInverterLoss(3500, 2300, 900), 300);
			// absorbing AC (balcony surplus charged into the battery): 100 W AC in, 80 W DC into the battery
			assert.strictEqual(computeInverterLoss(0, 80, -100), 20);
			assert.strictEqual(computeInverterLoss(0, 0, 50), 0);
		});
	});
});
