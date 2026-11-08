/**
 * Data model for user-configured energy entities (producer, consumer, storage, grid, other).
 * Kept free of any adapter/ioBroker dependency so it can be unit-tested in isolation.
 */

import { tAll, type Translated } from "./i18n/i18n.js";

/**
 * `loss` is never picked by the user for a config row (there is no sensor that measures a loss
 * directly) - it only ever appears on entities that `deriveLossDefinitions` synthesizes from a
 * producer's/storage's own efficiency fields, see below.
 */
export type EntityCategory = "producer" | "consumer" | "storage" | "grid" | "loss" | "other";

export const ENTITY_CATEGORIES: EntityCategory[] = ["producer", "consumer", "storage", "grid", "loss", "other"];

/** Config-row-selectable categories - excludes `loss`, which only ever exists as a synthesized entity. */
export const CONFIGURABLE_ENTITY_CATEGORIES: EntityCategory[] = ["producer", "consumer", "storage", "grid", "other"];

export type PowerUnit = "W" | "kW";

/** Raw row shape as it arrives from admin/jsonConfig (native.EntitiesList). */
export interface EntityRowConfig {
	/** Technical, unique id (letters, digits, "_" and "-" only) */
	entityId: string;
	/** Display name */
	name: string;
	/** What kind of entity this is */
	category: EntityCategory;
	/** ioBroker state id reporting the current power */
	powerStateId: string;
	/** Unit the power state reports its value in */
	powerUnit: PowerUnit;
	/** Flip the sign of the power reading */
	invertSign: boolean;
	/**
	 * Power readings whose absolute value is below this (in Watt) are treated as exactly 0
	 * instead of their raw value. For compensating a source that never quite settles at zero
	 * (sensor noise, or a stuck/stale reading like a Shelly plug that stopped updating) from
	 * showing up as a phantom flow once everything else is genuinely at zero. 0 disables it.
	 */
	noiseThresholdW: number;
	/** Optional ioBroker state id reporting cumulative energy in kWh */
	energyStateId: string;
	/** Optional entity id of an aggregate/collective measurement this entity is part of */
	parentId: string;
	/**
	 * When true, this entity's contribution to its parent's rest-power is subtracted with an
	 * inverted sign instead of added directly. Needed when the parent's own reading already
	 * nets this entity out (e.g. a house consumption meter positioned downstream of a locally
	 * fed-in producer such as a balcony power plant) rather than including it as a sub-total.
	 */
	invertInParent: boolean;
	/** Optional ioBroker state id reporting state of charge in %, storage entities only */
	socStateId: string;
	/** Optional nominal usable capacity in kWh, storage entities only */
	capacityKWh: number;
	/** Optional nominal peak power in kWp, producer entities only - enables the Open-Meteo yield forecast for this entity */
	peakPowerKWp: number;
	/** Panel tilt in degrees (0 = horizontal, 90 = vertical), producer entities only */
	tiltDeg: number;
	/** Panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west, ±180 = north), producer entities only */
	azimuthDeg: number;
	/** Optional inverter/AC feed-in cap in Watt, producer entities only - clamps the forecast so it never exceeds what the inverter can actually deliver */
	acLimitW: number;
	/**
	 * Assumed inverter/conversion efficiency in percent (0-100), producer entities only. Below
	 * 100, `deriveLossDefinitions` synthesizes a paired loss entity modeling
	 * `power * (1 - efficiencyPercent / 100)` - a physically-motivated estimate (typical inverter
	 * DC/AC conversion loss), not a measurement. 100 (or unset) disables it.
	 */
	efficiencyPercent?: number;
	/** Assumed charge-direction efficiency in percent (0-100), storage entities only - see efficiencyPercent. 100/unset disables it. */
	chargeEfficiencyPercent?: number;
	/** Assumed discharge-direction efficiency in percent (0-100), storage entities only - see efficiencyPercent. 100/unset disables it. */
	dischargeEfficiencyPercent?: number;
	/** Lowest state of charge the energy planner may plan down to, in percent, storage entities only (default 20) */
	minSocPercent?: number;
	/** Highest state of charge the energy planner may plan up to, in percent, storage entities only (default 100) */
	maxSocPercent?: number;
	/** Max charge/discharge power the energy planner may plan with, in kW, storage entities only (0/unset = unlimited by this setting) */
	maxPowerKW?: number;
	/** Estimated battery wear cost per discharged kWh in ct, storage entities only (default 0) */
	wearCostCtPerKWh?: number;
	/** Display color (hex) for this entity in flow-diagram widgets, e.g. "#ffb703" */
	color: string;
	/**
	 * Where `power` comes from, grid and storage entities only (others are always "measured"):
	 * - `measured` - the configured source state(s)
	 * - `balance` - computed from the energy balance of the other categories (grid = consumption −
	 *   production + storage; storage = production + grid − consumption), for a source that
	 *   doesn't reflect reality; the measured reading is still
	 *   mirrored to `entities.<id>.rawPower`
	 * - `measuredWithFallback` - measured, but the balance stands in while the source is stale
	 *   (no update for `staleAfterS`), e.g. a cloud-fed meter (Tibber Pulse) during an outage
	 * Legacy configs without this field: `deriveFromBalance: true` maps to `balance`.
	 */
	powerSource?: PowerSourceMode;
	/** Seconds without a source update after which `measuredWithFallback` switches to the balance (default 120) */
	staleAfterS?: number;
	/**
	 * Optional separate feed-in source, grid entities only: for meters that report import and
	 * export as two non-negative values (e.g. Tibber Pulse powerConsumption/powerProduction).
	 * `power = normalize(powerStateId) − normalize(exportStateId)`.
	 */
	exportStateId?: string;
	/**
	 * Optional second measured source, grid/storage entities in `measuredWithFallback` mode only:
	 * used while the primary source is stale, before falling back to the energy balance (e.g. the
	 * inverter's own grid CT register while the cloud-fed Tibber Pulse is offline). Already signed
	 * (positive = import / charging after `fallbackInvertSign`), always in Watt.
	 */
	fallbackStateId?: string;
	/** Flip the sign of the fallback reading */
	fallbackInvertSign?: boolean;
	/**
	 * Optional AC output state of the hybrid inverter this storage is attached to, storage entities
	 * only, in Watt, positive = the inverter feeds AC into the house. Enables a MEASURED inverter loss
	 * entity: DC inputs (the `inverterPvIds` producers + battery discharge) − AC output. Replaces the
	 * estimated efficiency losses of those producers and of this storage.
	 */
	inverterAcStateId?: string;
	/** Comma-separated entity ids of the producers on this hybrid inverter's DC side (storage only) */
	inverterPvIds?: string;
	/** Legacy (before 2026-10-31): replaced by powerSource; true is migrated to "balance". */
	deriveFromBalance?: boolean;
}

/** Validated, normalized entity definition used at runtime. */
export interface EntityDefinition {
	/** Technical, unique id (letters, digits, "_" and "-" only) */
	entityId: string;
	/** Display name */
	name: string;
	/** What kind of entity this is */
	category: EntityCategory;
	/** ioBroker state id reporting the current power */
	powerStateId: string;
	/** Unit the power state reports its value in */
	powerUnit: PowerUnit;
	/** Flip the sign of the power reading */
	invertSign: boolean;
	/** Power readings below this magnitude (in Watt) are treated as exactly 0; 0 disables it - see EntityRowConfig.noiseThresholdW */
	noiseThresholdW: number;
	/** ioBroker state id reporting cumulative energy in kWh, if configured */
	energyStateId?: string;
	/** Entity id of the aggregate/collective measurement this entity is part of, if configured */
	parentId?: string;
	/** When true, this entity's contribution to its parent's rest-power is subtracted inverted (added back) instead of added directly */
	invertInParent: boolean;
	/** ioBroker state id reporting state of charge in %, storage entities only */
	socStateId?: string;
	/** Nominal usable capacity in kWh, storage entities only */
	capacityKWh?: number;
	/** Nominal peak power in kWp, if configured - enables the Open-Meteo yield forecast for this entity */
	peakPowerKWp?: number;
	/** Panel tilt in degrees (0 = horizontal, 90 = vertical), if configured */
	tiltDeg?: number;
	/** Panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west, ±180 = north), if configured */
	azimuthDeg?: number;
	/** Inverter/AC feed-in cap in Watt, if configured - clamps the forecast to what the inverter can actually deliver */
	acLimitW?: number;
	/** Assumed inverter/conversion efficiency in percent (0-100), if configured and below 100 - see EntityRowConfig.efficiencyPercent */
	efficiencyPercent?: number;
	/** Assumed charge-direction efficiency in percent (0-100), if configured and below 100, storage entities only */
	chargeEfficiencyPercent?: number;
	/** Assumed discharge-direction efficiency in percent (0-100), if configured and below 100, storage entities only */
	dischargeEfficiencyPercent?: number;
	/** Planner SoC lower bound in percent, storage entities only */
	minSocPercent?: number;
	/** Planner SoC upper bound in percent, storage entities only */
	maxSocPercent?: number;
	/** Planner max charge/discharge power in kW, storage entities only */
	maxPowerKW?: number;
	/** Battery wear cost per discharged kWh in ct, storage entities only */
	wearCostCtPerKWh?: number;
	/** Display color (hex) for this entity in flow-diagram widgets */
	color: string;
	/** Where `power` comes from - see EntityRowConfig.powerSource */
	powerSource: PowerSourceMode;
	/** Staleness threshold in seconds for `measuredWithFallback` */
	staleAfterS: number;
	/** Separate feed-in source (grid only) - see EntityRowConfig.exportStateId */
	exportStateId?: string;
	/** Second measured source for `measuredWithFallback` (grid/storage) - see EntityRowConfig.fallbackStateId */
	fallbackStateId?: string;
	/** Flip the sign of the fallback reading */
	fallbackInvertSign?: boolean;
	/** Hybrid inverter AC output state (storage only) - see EntityRowConfig.inverterAcStateId */
	inverterAcStateId?: string;
	/** Validated producer entity ids on the hybrid inverter's DC side (storage only) */
	inverterPvIds?: string[];
}

/** See EntityRowConfig.powerSource. */
export type PowerSourceMode = "measured" | "balance" | "measuredWithFallback";
const POWER_SOURCE_MODES: PowerSourceMode[] = ["measured", "balance", "measuredWithFallback"];
/** Default staleness threshold for `measuredWithFallback`, in seconds. */
export const DEFAULT_STALE_AFTER_S = 120;

/**
 * True if the entity's power is (or can become) the balance value - `balance` or `measuredWithFallback`.
 *
 * @param entity - the entity
 */
export function usesBalance(entity: Pick<EntityDefinition, "powerSource">): boolean {
	return entity.powerSource !== "measured";
}

/**
 * Resolves the configured power-source mode, including the legacy `deriveFromBalance` flag.
 * Only grid and storage entities can be balance-derived.
 *
 * @param row - the raw config row
 */
function resolvePowerSource(row: EntityRowConfig): PowerSourceMode {
	if (row.category !== "grid" && row.category !== "storage") {
		return "measured";
	}
	if (row.powerSource && POWER_SOURCE_MODES.includes(row.powerSource)) {
		return row.powerSource;
	}
	return row.deriveFromBalance ? "balance" : "measured";
}

/** Fallback color used when an entity row has no color configured. */
export const DEFAULT_ENTITY_COLOR = "#8892a0";

const ID_PATTERN = /^[a-z0-9_-]+$/i;

/**
 * True for a numeric (or numeric-string) config value that was actually set - unlike a plain
 * truthiness check, 0 counts as set (e.g. a deliberate 0 % min SoC or 0 ct wear cost).
 *
 * @param v - raw config value
 */
function isSetNumber(v: unknown): boolean {
	return v !== undefined && v !== null && v !== "" && Number.isFinite(Number(v));
}

/**
 * Validates and normalizes the raw admin config rows into a de-duplicated list of entity
 * definitions, plus warnings for rows that had to be skipped or auto-corrected.
 *
 * @param rows - raw rows as stored in native.EntitiesList
 */
export function parseEntities(rows: EntityRowConfig[] | undefined): { entities: EntityDefinition[]; warnings: string[] } {
	const warnings: string[] = [];
	const entities: EntityDefinition[] = [];
	const seenIds = new Set<string>();

	for (const row of rows ?? []) {
		const entityId = (row.entityId ?? "").trim();
		if (!entityId) {
			warnings.push(`Skipping entity "${row.name || "?"}": entity ID is empty`);
			continue;
		}
		if (!ID_PATTERN.test(entityId)) {
			warnings.push(`Skipping entity "${entityId}": ID may only contain letters, digits, "_" and "-"`);
			continue;
		}
		if (seenIds.has(entityId.toLowerCase())) {
			warnings.push(`Skipping entity "${entityId}": duplicate entity ID`);
			continue;
		}
		if (!row.powerStateId) {
			warnings.push(`Skipping entity "${entityId}": no power state configured`);
			continue;
		}
		if (!ENTITY_CATEGORIES.includes(row.category)) {
			warnings.push(`Skipping entity "${entityId}": unknown category "${row.category as string}"`);
			continue;
		}

		seenIds.add(entityId.toLowerCase());
		entities.push({
			entityId,
			name: row.name?.trim() || entityId,
			category: row.category,
			powerStateId: row.powerStateId,
			powerUnit: row.powerUnit === "kW" ? "kW" : "W",
			invertSign: !!row.invertSign,
			noiseThresholdW: row.noiseThresholdW ? Math.abs(Number(row.noiseThresholdW)) : 0,
			energyStateId: row.energyStateId || undefined,
			parentId: row.parentId || undefined,
			invertInParent: !!row.invertInParent,
			socStateId: row.category === "storage" ? row.socStateId || undefined : undefined,
			capacityKWh: row.category === "storage" && row.capacityKWh ? Number(row.capacityKWh) : undefined,
			peakPowerKWp: row.category === "producer" && row.peakPowerKWp ? Number(row.peakPowerKWp) : undefined,
			tiltDeg: row.category === "producer" && row.tiltDeg !== undefined && row.tiltDeg !== null ? Number(row.tiltDeg) : undefined,
			azimuthDeg: row.category === "producer" && row.azimuthDeg !== undefined && row.azimuthDeg !== null ? Number(row.azimuthDeg) : undefined,
			acLimitW: row.category === "producer" && row.acLimitW ? Number(row.acLimitW) : undefined,
			efficiencyPercent: row.category === "producer" && row.efficiencyPercent ? Number(row.efficiencyPercent) : undefined,
			chargeEfficiencyPercent: row.category === "storage" && row.chargeEfficiencyPercent ? Number(row.chargeEfficiencyPercent) : undefined,
			dischargeEfficiencyPercent: row.category === "storage" && row.dischargeEfficiencyPercent ? Number(row.dischargeEfficiencyPercent) : undefined,
			minSocPercent: row.category === "storage" && isSetNumber(row.minSocPercent) ? Number(row.minSocPercent) : undefined,
			maxSocPercent: row.category === "storage" && row.maxSocPercent ? Number(row.maxSocPercent) : undefined,
			maxPowerKW: row.category === "storage" && row.maxPowerKW ? Number(row.maxPowerKW) : undefined,
			wearCostCtPerKWh: row.category === "storage" && isSetNumber(row.wearCostCtPerKWh) ? Number(row.wearCostCtPerKWh) : undefined,
			color: /^#[0-9a-fA-F]{6}$/.test(row.color ?? "") ? row.color : DEFAULT_ENTITY_COLOR,
			powerSource: resolvePowerSource(row),
			staleAfterS: row.staleAfterS && Number(row.staleAfterS) > 0 ? Number(row.staleAfterS) : DEFAULT_STALE_AFTER_S,
			exportStateId: row.category === "grid" ? row.exportStateId || undefined : undefined,
			fallbackStateId: row.category === "grid" || row.category === "storage" ? row.fallbackStateId || undefined : undefined,
			fallbackInvertSign: !!row.fallbackInvertSign,
			inverterAcStateId: row.category === "storage" ? row.inverterAcStateId || undefined : undefined,
			inverterPvIds:
				row.category === "storage" && row.inverterAcStateId
					? (row.inverterPvIds ?? "")
							.split(",")
							.map(s => s.trim())
							.filter(Boolean)
					: undefined,
		});
	}

	// The inverter's DC inputs must be producers that actually exist.
	for (const entity of entities) {
		if (!entity.inverterPvIds) {
			continue;
		}
		entity.inverterPvIds = entity.inverterPvIds.filter(id => {
			const ok = entities.some(e => e.entityId === id && e.category === "producer");
			if (!ok) {
				warnings.push(`Entity "${entity.entityId}": inverter input "${id}" is not a configured producer, ignoring it`);
			}
			return ok;
		});
	}
	for (const entity of entities) {
		if (entity.fallbackStateId && entity.powerSource !== "measuredWithFallback") {
			warnings.push(`Entity "${entity.entityId}": a fallback state is only used with power source "measuredWithFallback", ignoring it`);
			entity.fallbackStateId = undefined;
		}
	}

	// Only one balance equation exists - at most one entity can be derived from it.
	let balanceEntity: EntityDefinition | undefined;
	for (const entity of entities) {
		if (!usesBalance(entity)) {
			continue;
		}
		if (balanceEntity) {
			warnings.push(
				`Entity "${entity.entityId}": only one entity can be derived from the energy balance ("${balanceEntity.entityId}" already is) - using its measured source instead`,
			);
			entity.powerSource = "measured";
			continue;
		}
		balanceEntity = entity;
	}

	// Resolve parent references after all entities are known, so a forward reference
	// (parent defined further down in the table) still works but a dangling/self reference doesn't.
	const idSet = new Set(entities.map(e => e.entityId));
	for (const entity of entities) {
		if (entity.parentId && (entity.parentId === entity.entityId || !idSet.has(entity.parentId))) {
			warnings.push(`Entity "${entity.entityId}": parent "${entity.parentId}" does not exist, ignoring aggregation link`);
			entity.parentId = undefined;
		}
	}

	return { entities, warnings };
}

/**
 * Normalizes a raw reading to Watt, applying unit conversion, the noise-threshold cutoff and
 * sign inversion (in that order - the threshold judges the reading's real-world magnitude, which
 * unit conversion affects and sign inversion doesn't).
 *
 * @param rawValue - the value as read from the configured ioBroker state
 * @param entity - the entity definition the value belongs to
 */
export function normalizePower(rawValue: number, entity: Pick<EntityDefinition, "powerUnit" | "invertSign" | "noiseThresholdW">): number {
	let value = entity.powerUnit === "kW" ? rawValue * 1000 : rawValue;
	if (entity.noiseThresholdW && Math.abs(value) < entity.noiseThresholdW) {
		value = 0;
	}
	if (entity.invertSign) {
		value = -value;
	}
	return value;
}

/** A producer entity with complete physical parameters, ready to be forecast via Open-Meteo. */
export interface ForecastableEntity extends EntityDefinition {
	/** Nominal peak power in kWp */
	peakPowerKWp: number;
	/** Panel tilt in degrees (0 = horizontal, 90 = vertical) */
	tiltDeg: number;
	/** Panel azimuth in degrees, Open-Meteo convention (0 = south, -90 = east, 90 = west, ±180 = north) */
	azimuthDeg: number;
}

/**
 * Returns the entities that have all three physical parameters configured (peak power, tilt,
 * azimuth) and can therefore be fed into the Open-Meteo yield forecast.
 *
 * @param entities - all configured entities
 */
export function selectForecastableEntities(entities: EntityDefinition[]): ForecastableEntity[] {
	return entities.filter(
		(e): e is ForecastableEntity => e.category === "producer" && e.peakPowerKWp !== undefined && e.tiltDeg !== undefined && e.azimuthDeg !== undefined,
	);
}

/**
 * Groups entities by which "parent" (aggregate/Sammelmessung) entity they belong to.
 *
 * @param entities - all configured entities
 */
export function groupChildrenByParent(entities: EntityDefinition[]): Map<string, EntityDefinition[]> {
	const map = new Map<string, EntityDefinition[]>();
	for (const entity of entities) {
		if (!entity.parentId) {
			continue;
		}
		const list = map.get(entity.parentId) ?? [];
		list.push(entity);
		map.set(entity.parentId, list);
	}
	return map;
}

/** Which side of a producer/storage entity's own reading a synthesized loss entity models. */
export type LossKind = "producerLoss" | "chargeLoss" | "dischargeLoss" | "inverterLoss";

/** Default display color for auto-synthesized loss entities - a muted red, distinct from every real category's palette. */
export const LOSS_COLOR = "#b23a48";

/**
 * A `loss`-category entity synthesized from a producer's/storage's own `efficiencyPercent`
 * (or `chargeEfficiencyPercent`/`dischargeEfficiencyPercent`) field - never user-configured
 * directly, see EntityCategory. Its id is derived deterministically from the source entity's id
 * plus its kind, so it stays stable across restarts and safe to use as an ioBroker object id
 * segment (inherits the source entity's already-validated `[a-z0-9_-]` id pattern).
 */
export interface LossDefinition {
	/** Deterministic, source-derived id, e.g. "pv_string1_loss" / "batterie_chargeloss" */
	entityId: string;
	/** Display name in all languages, e.g. { en: "PV east (loss)", de: "PV east (Verlust)", ... } */
	name: Translated;
	/** The producer/storage entity this loss is modeled from */
	sourceEntityId: string;
	kind: LossKind;
	/** The efficiency percent (0-100) used to compute this loss - see EntityDefinition.efficiencyPercent et al. (unused for inverterLoss) */
	efficiencyPercent: number;
	color: string;
	/** inverterLoss only: the hybrid inverter's AC output state */
	acStateId?: string;
	/** inverterLoss only: producer entity ids on the inverter's DC side */
	inputIds?: string[];
}

const LOSS_SUFFIX: Record<LossKind, string> = {
	producerLoss: "_loss",
	chargeLoss: "_chargeloss",
	dischargeLoss: "_dischargeloss",
	inverterLoss: "_inverterloss",
};

/**
 * Synthesizes the `loss`-category entities implied by every producer's/storage's own efficiency
 * field(s) - one per producer with `efficiencyPercent` below 100, and up to two per storage entity
 * (charge/discharge modeled separately, see the flow-diagram widget's arrow layout). An efficiency
 * of exactly 100 (or left unset) means "no loss modeled", not "100% loss" - it's filtered out
 * entirely rather than producing a zero-valued entity nobody asked for.
 *
 * @param entities - all configured entities
 */
export function deriveLossDefinitions(entities: EntityDefinition[]): LossDefinition[] {
	const losses: LossDefinition[] = [];
	// A measured inverter loss already contains the conversion losses of its DC inputs and of the
	// battery - their estimated losses would be counted twice.
	const measuredByInverter = new Set<string>();
	for (const entity of entities) {
		if (entity.category === "storage" && entity.inverterAcStateId) {
			measuredByInverter.add(entity.entityId);
			for (const id of entity.inverterPvIds ?? []) {
				measuredByInverter.add(id);
			}
			losses.push({
				entityId: `${entity.entityId}${LOSS_SUFFIX.inverterLoss}`,
				name: tAll("Inverter (loss, measured)"),
				sourceEntityId: entity.entityId,
				kind: "inverterLoss",
				efficiencyPercent: 0,
				color: LOSS_COLOR,
				acStateId: entity.inverterAcStateId,
				inputIds: entity.inverterPvIds ?? [],
			});
		}
	}
	for (const entity of entities) {
		if (measuredByInverter.has(entity.entityId)) {
			continue;
		}
		if (entity.category === "producer" && entity.efficiencyPercent !== undefined && entity.efficiencyPercent > 0 && entity.efficiencyPercent < 100) {
			losses.push({
				entityId: `${entity.entityId}${LOSS_SUFFIX.producerLoss}`,
				name: tAll("{name} (loss)", { name: entity.name }),
				sourceEntityId: entity.entityId,
				kind: "producerLoss",
				efficiencyPercent: entity.efficiencyPercent,
				color: LOSS_COLOR,
			});
		}
		if (entity.category === "storage") {
			if (entity.chargeEfficiencyPercent !== undefined && entity.chargeEfficiencyPercent > 0 && entity.chargeEfficiencyPercent < 100) {
				losses.push({
					entityId: `${entity.entityId}${LOSS_SUFFIX.chargeLoss}`,
					name: tAll("{name} (charge loss)", { name: entity.name }),
					sourceEntityId: entity.entityId,
					kind: "chargeLoss",
					efficiencyPercent: entity.chargeEfficiencyPercent,
					color: LOSS_COLOR,
				});
			}
			if (entity.dischargeEfficiencyPercent !== undefined && entity.dischargeEfficiencyPercent > 0 && entity.dischargeEfficiencyPercent < 100) {
				losses.push({
					entityId: `${entity.entityId}${LOSS_SUFFIX.dischargeLoss}`,
					name: tAll("{name} (discharge loss)", { name: entity.name }),
					sourceEntityId: entity.entityId,
					kind: "dischargeLoss",
					efficiencyPercent: entity.dischargeEfficiencyPercent,
					color: LOSS_COLOR,
				});
			}
		}
	}
	return losses;
}

/**
 * The live power (Watt) a loss definition should currently report, given its source entity's
 * current normalized power - `chargeLoss`/`dischargeLoss` are zero whenever the source isn't
 * currently flowing in their direction (see the flow-diagram widget's charge/discharge sign
 * convention: positive = charging).
 *
 * @param loss - the loss definition to evaluate
 * @param sourcePower - the source entity's current normalized power in Watt
 */
export function computeLossPower(loss: Pick<LossDefinition, "kind" | "efficiencyPercent">, sourcePower: number): number {
	const factor = 1 - loss.efficiencyPercent / 100;
	switch (loss.kind) {
		case "producerLoss":
			return Math.max(0, sourcePower) * factor;
		case "chargeLoss":
			return sourcePower > 0 ? sourcePower * factor : 0;
		case "dischargeLoss":
			return sourcePower < 0 ? -sourcePower * factor : 0;
		case "inverterLoss":
			// needs the AC output - see computeInverterLoss
			return 0;
	}
}

/**
 * Measured loss of a hybrid inverter: what goes in on the DC side (PV inputs + battery discharge,
 * or PV minus battery charging) minus what comes out on the AC side. Includes the inverter's own
 * standby consumption (on real systems often a constant 100-150 W).
 * Clamped at 0: a negative value is measurement/timing noise, not a gain.
 *
 * @param pvDcW - sum of the DC producer inputs in W
 * @param storageW - battery power in W, positive = charging (app convention)
 * @param acOutW - inverter AC output in W, positive = feeding the house
 */
export function computeInverterLoss(pvDcW: number, storageW: number, acOutW: number): number {
	return Math.max(0, pvDcW - storageW - acOutW);
}

/** Category totals (power in W, or energy in kWh - the arithmetic is the same) the balance is built from. */
export interface CategoryTotals {
	/** Producer total */
	producer: number;
	/** Consumer total (with parent rest values) */
	consumer: number;
	/** Storage total, positive = charging */
	storage: number;
	/** Grid total, positive = import */
	grid: number;
	/** Modeled conversion losses total */
	loss: number;
}

/**
 * The energy balance: what grid and storage would have to be if every other measurement were
 * right, plus the signed residual of the measurements as they are.
 *
 * - `gridBalance` = consumption − production + storage (storage positive = charging)
 * - `storageBalance` = production + grid − consumption
 * - `residual` = production + grid − storage − consumption − losses: positive = more measured
 *   supply than measured use, i.e. something is missing on the sink side (e.g. the inverter's/
 *   battery's own unmeasured consumption, or a storage register reading too low); negative = the
 *   other way round. Exactly the "Messabweichung" branch of the arrow diagram.
 *
 * @param t - category totals
 */
export function computeBalance(t: CategoryTotals): { gridBalance: number; storageBalance: number; residual: number } {
	return {
		gridBalance: t.consumer - t.producer + t.storage,
		storageBalance: t.producer + t.grid - t.consumer,
		residual: t.producer + t.grid - t.storage - t.consumer - t.loss,
	};
}

/**
 * Whether a `measuredWithFallback` source counts as stale: no update of ANY of its source states
 * (import or export - a meter may only rewrite the one that changed) for `staleAfterS`.
 *
 * @param lastUpdateTs - newest `ts` of the entity's source states (ms), undefined = never seen
 * @param now - current time (ms)
 * @param staleAfterS - threshold in seconds
 */
export function isSourceStale(lastUpdateTs: number | undefined, now: number, staleAfterS: number): boolean {
	return lastUpdateTs === undefined || now - lastUpdateTs > staleAfterS * 1000;
}

/** Which source an entity's `power` currently comes from. */
export type EffectiveSource = "measured" | "fallback" | "balance";

/**
 * Picks the source of a grid/storage entity's power: `measured`/`balance` mode are fixed;
 * `measuredWithFallback` uses the primary measurement while it is fresh, then the fallback state
 * (if configured and fresh), and only then the energy balance.
 *
 * @param mode - the entity's power-source mode
 * @param primaryFresh - primary source has a value and is not stale
 * @param fallbackFresh - fallback source is configured, has a value and is not stale
 */
export function resolveSource(mode: PowerSourceMode, primaryFresh: boolean, fallbackFresh: boolean): EffectiveSource {
	if (mode === "measured") {
		return "measured";
	}
	if (mode === "balance") {
		return "balance";
	}
	return primaryFresh ? "measured" : fallbackFresh ? "fallback" : "balance";
}
