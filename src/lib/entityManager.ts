import { tAll, type Translated } from "./i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import {
	computeBalance,
	computeInverterLoss,
	computeLossPower,
	deriveLossDefinitions,
	ENTITY_CATEGORIES,
	groupChildrenByParent,
	isSourceStale,
	normalizePower,
	parseEntities,
	resolveSource,
	usesBalance,
	type EffectiveSource,
	type EntityCategory,
	type EntityDefinition,
	type EntityRowConfig,
	type LossDefinition,
} from "./entityModel.js";
import { runSafely } from "./safeAsync.js";

const CATEGORY_NAMES: Record<EntityCategory, Translated> = {
	producer: tAll("Producer"),
	consumer: tAll("Consumer"),
	storage: tAll("Storage"),
	grid: tAll("Grid"),
	loss: tAll("Loss"),
	other: tAll("Other"),
};

/** How often `measuredWithFallback` sources are checked for staleness (a dead feed sends no events). */
const STALE_CHECK_INTERVAL_MS = 15 * 1000;

/**
 * Owns the runtime object tree under `entities.*` and `summary.*`, keeps a live cache of the
 * latest normalized power reading per entity, and recomputes per-entity "rest power"
 * (aggregate measurement minus its assigned individual measurements), per-category sums, the
 * energy balance (balance-derived/fallback entities, `balancePower` diagnostics, the signed
 * `summary.balanceResidual.power`) whenever a subscribed source state changes.
 */
export class EntityManager {
	private readonly adapter: utils.AdapterInstance;
	private entities: EntityDefinition[] = [];
	/** loss-category entities synthesized from producer/storage efficiency fields - never subscribed to a source state, see recomputeLossPowers */
	private lossDefinitions: LossDefinition[] = [];
	private childrenByParent = new Map<string, EntityDefinition[]>();
	/** entityId -> latest normalized power in Watt (what `entities.<id>.power` shows) */
	private readonly powerCache = new Map<string, number>();
	/** entityId -> latest normalized import reading (powerStateId) */
	private readonly importCache = new Map<string, number>();
	/** entityId -> latest normalized export reading (exportStateId) */
	private readonly exportCache = new Map<string, number>();
	/** entityId -> newest `ts` of any of its power source states (ms) */
	private readonly sourceTsCache = new Map<string, number>();
	/** entityId -> latest normalized fallback reading (fallbackStateId) */
	private readonly fallbackCache = new Map<string, number>();
	/** entityId -> `ts` of its fallback state (ms) */
	private readonly fallbackTsCache = new Map<string, number>();
	/** loss entityId -> latest inverter AC output in W (inverterLoss only) */
	private readonly acCache = new Map<string, number>();
	/** entityId -> currently used source of a balance-capable entity */
	private readonly effectiveSource = new Map<string, EffectiveSource>();
	/** parent entityId -> latest restPower in Watt (aggregate corrected for its assigned children) */
	private readonly restPowerCache = new Map<string, number>();
	/** category -> latest summary power in Watt */
	private readonly categorySumCache = new Map<EntityCategory, number>();
	/** external state id -> entityIds that read their (import) power from it */
	private readonly powerStateSubscribers = new Map<string, string[]>();
	/** external state id -> entityIds that read their export power from it */
	private readonly exportStateSubscribers = new Map<string, string[]>();
	/** external state id -> entityIds that use it as fallback source */
	private readonly fallbackStateSubscribers = new Map<string, string[]>();
	/** external state id -> inverterLoss entityIds that read the inverter AC output from it */
	private readonly acStateSubscribers = new Map<string, string[]>();
	private readonly energyStateSubscribers = new Map<string, string[]>();
	private readonly socStateSubscribers = new Map<string, string[]>();
	private staleTimer: ioBroker.Interval | undefined;

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
	}

	/**
	 * (Re-)builds the object tree from the current adapter configuration: validates the
	 * configured entities, creates/updates their ioBroker objects, removes objects for
	 * entities that were deleted from the config, and subscribes to all referenced source
	 * states.
	 */
	public async init(): Promise<void> {
		const rawList = (this.adapter.config.EntitiesList as EntityRowConfig[] | undefined) ?? [];
		const { entities, warnings } = parseEntities(rawList);
		for (const warning of warnings) {
			this.adapter.log.warn(warning);
		}
		this.entities = entities;
		this.lossDefinitions = deriveLossDefinitions(entities);
		this.childrenByParent = groupChildrenByParent(entities);

		await this.createCategoryObjects();
		await this.syncEntityObjects();
		await this.subscribeSources();

		// Prime every mirrored state with whatever its source currently holds. Subscriptions
		// only notify on future changes, so without this a slowly-changing source (e.g. a
		// battery's state of charge) would keep showing the object's initial default value
		// until it happens to change for the first time after adapter start.
		for (const entity of this.entities) {
			const powerState = await this.adapter.getForeignStateAsync(entity.powerStateId);
			if (powerState && typeof powerState.val === "number") {
				this.importCache.set(entity.entityId, normalizePower(powerState.val, entity));
				this.noteSourceTs(entity.entityId, powerState.ts);
			}
			if (entity.exportStateId) {
				const exportState = await this.adapter.getForeignStateAsync(entity.exportStateId);
				if (exportState && typeof exportState.val === "number") {
					this.exportCache.set(entity.entityId, normalizePower(exportState.val, entity));
					this.noteSourceTs(entity.entityId, exportState.ts);
				}
			}
			if (entity.fallbackStateId) {
				const fallbackState = await this.adapter.getForeignStateAsync(entity.fallbackStateId);
				if (fallbackState && typeof fallbackState.val === "number") {
					this.noteFallback(entity, fallbackState.val, fallbackState.ts);
				}
			}
			await this.applyMeasured(entity);
			if (entity.energyStateId) {
				const energyState = await this.adapter.getForeignStateAsync(entity.energyStateId);
				if (energyState && typeof energyState.val === "number") {
					await this.adapter.setStateAsync(`entities.${entity.entityId}.energy`, { val: energyState.val, ack: true });
				}
			}
			if (entity.socStateId) {
				const socState = await this.adapter.getForeignStateAsync(entity.socStateId);
				if (socState && typeof socState.val === "number") {
					await this.adapter.setStateAsync(`entities.${entity.entityId}.soc`, { val: socState.val, ack: true });
				}
			}
		}
		for (const loss of this.lossDefinitions) {
			if (loss.acStateId) {
				const acState = await this.adapter.getForeignStateAsync(loss.acStateId);
				if (acState && typeof acState.val === "number") {
					this.acCache.set(loss.entityId, acState.val);
				}
			}
		}
		await this.recomputeAll();

		if (this.entities.some(e => e.powerSource === "measuredWithFallback")) {
			this.staleTimer = this.adapter.setInterval(() => {
				runSafely(this.adapter, "Stale source check", () => this.onStaleCheck());
			}, STALE_CHECK_INTERVAL_MS);
		}
	}

	/** Stops the staleness check timer. Call this from the adapter's unload handler. */
	public stop(): void {
		if (this.staleTimer) {
			this.adapter.clearInterval(this.staleTimer);
			this.staleTimer = undefined;
		}
	}

	/**
	 * Handles a change of any subscribed foreign state (power/export/energy/SOC source) and
	 * recomputes the affected mirrored states, parent rest-power, category summaries and the balance.
	 *
	 * @param id - full id of the foreign state that changed
	 * @param state - the new state value
	 */
	public async onForeignStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
		if (!state || state.val === null || state.val === undefined) {
			return;
		}

		const affectedParents = new Set<string>();
		const categoriesToRecompute = new Set<EntityCategory>();
		const touched = new Set<string>();

		for (const [map, cache] of [
			[this.powerStateSubscribers, this.importCache],
			[this.exportStateSubscribers, this.exportCache],
		] as const) {
			for (const entityId of map.get(id) ?? []) {
				const entity = this.entities.find(e => e.entityId === entityId);
				if (!entity || typeof state.val !== "number") {
					continue;
				}
				cache.set(entityId, normalizePower(state.val, entity));
				this.noteSourceTs(entityId, state.ts);
				touched.add(entityId);
			}
		}

		for (const entityId of this.fallbackStateSubscribers.get(id) ?? []) {
			const entity = this.entities.find(e => e.entityId === entityId);
			if (!entity || typeof state.val !== "number") {
				continue;
			}
			this.noteFallback(entity, state.val, state.ts);
			// Only affects `power` while the fallback is the source in use.
			if (this.effectiveSource.get(entityId) === "fallback") {
				touched.add(entityId);
			}
		}

		let acChanged = false;
		for (const lossId of this.acStateSubscribers.get(id) ?? []) {
			if (typeof state.val === "number") {
				this.acCache.set(lossId, state.val);
				acChanged = true;
			}
		}

		for (const entityId of touched) {
			const entity = this.entities.find(e => e.entityId === entityId);
			if (!entity) {
				continue;
			}
			const changedPower = await this.applyMeasured(entity);
			if (!changedPower) {
				continue;
			}
			categoriesToRecompute.add(entity.category);
			if (entity.parentId) {
				affectedParents.add(entity.parentId);
			}
			if (this.childrenByParent.has(entityId)) {
				affectedParents.add(entityId);
			}
		}

		const energyEntityIds = this.energyStateSubscribers.get(id);
		if (energyEntityIds && typeof state.val === "number") {
			for (const entityId of energyEntityIds) {
				await this.adapter.setStateAsync(`entities.${entityId}.energy`, { val: state.val, ack: true });
			}
		}

		const socEntityIds = this.socStateSubscribers.get(id);
		if (socEntityIds && typeof state.val === "number") {
			for (const entityId of socEntityIds) {
				await this.adapter.setStateAsync(`entities.${entityId}.soc`, { val: state.val, ack: true });
			}
		}

		if (touched.size === 0) {
			if (acChanged) {
				await this.recomputeLossPowers();
				await this.recomputeBalance();
			}
			return;
		}
		for (const parentId of affectedParents) {
			await this.recomputeRestPower(parentId);
			// A parent's restPower now feeds its own category's sum, so a change to any child -
			// even one in a different category, e.g. a netted producer like a balcony power plant -
			// must also refresh the parent's category, not just the changed entity's own category.
			const parentEntity = this.entities.find(e => e.entityId === parentId);
			if (parentEntity) {
				categoriesToRecompute.add(parentEntity.category);
			}
		}
		for (const category of categoriesToRecompute) {
			await this.recomputeCategorySum(category);
		}
		if (acChanged || ["producer", "storage"].some(c => categoriesToRecompute.has(c as EntityCategory))) {
			await this.recomputeLossPowers();
		}
		await this.recomputeBalance();
	}

	/** Returns the currently configured entities (post-validation), e.g. for the forecast manager. */
	public getEntities(): EntityDefinition[] {
		return this.entities;
	}

	/** Returns the loss entities synthesized from producer/storage efficiency fields, e.g. for the history manager. */
	public getLossDefinitions(): LossDefinition[] {
		return this.lossDefinitions;
	}

	/** Returns the ids of all foreign states this manager needs to subscribe to. */
	public getSubscribedForeignIds(): string[] {
		return [
			...new Set([
				...this.powerStateSubscribers.keys(),
				...this.exportStateSubscribers.keys(),
				...this.fallbackStateSubscribers.keys(),
				...this.acStateSubscribers.keys(),
				...this.energyStateSubscribers.keys(),
				...this.socStateSubscribers.keys(),
			]),
		];
	}

	/**
	 * Records the newest update time of an entity's power source(s).
	 *
	 * @param entityId - the entity
	 * @param ts - the source state's ts (ms)
	 */
	private noteSourceTs(entityId: string, ts: number | undefined): void {
		if (typeof ts !== "number") {
			return;
		}
		this.sourceTsCache.set(entityId, Math.max(ts, this.sourceTsCache.get(entityId) ?? 0));
	}

	/**
	 * The measured reading (import − export) of an entity, or undefined if its source has no value yet.
	 *
	 * @param entityId - the entity
	 */
	private measuredPower(entityId: string): number | undefined {
		const imp = this.importCache.get(entityId);
		if (imp === undefined) {
			return undefined;
		}
		return imp - (this.exportCache.get(entityId) ?? 0);
	}

	/**
	 * Records a fallback reading (normalized: Watt, optional sign flip).
	 *
	 * @param entity - the entity
	 * @param raw - raw fallback value
	 * @param ts - its ts (ms)
	 */
	private noteFallback(entity: EntityDefinition, raw: number, ts: number | undefined): void {
		this.fallbackCache.set(entity.entityId, entity.fallbackInvertSign ? -raw : raw);
		if (typeof ts === "number") {
			this.fallbackTsCache.set(entity.entityId, ts);
		}
	}

	/**
	 * Which source a grid/storage entity's power currently comes from (see entityModel.resolveSource).
	 *
	 * @param entity - the entity
	 */
	private currentSource(entity: EntityDefinition): EffectiveSource {
		const now = Date.now();
		const primaryFresh =
			this.measuredPower(entity.entityId) !== undefined && !isSourceStale(this.sourceTsCache.get(entity.entityId), now, entity.staleAfterS);
		const fallbackFresh =
			!!entity.fallbackStateId &&
			this.fallbackCache.has(entity.entityId) &&
			!isSourceStale(this.fallbackTsCache.get(entity.entityId), now, entity.staleAfterS);
		return resolveSource(entity.powerSource, primaryFresh, fallbackFresh);
	}

	/**
	 * Publishes an entity's measured reading: as `power` for measured entities (and fallback
	 * entities with a fresh source - the primary one, or else the fallback state), as the
	 * `rawPower` diagnostic for balance-capable ones.
	 *
	 * @param entity - the entity
	 * @returns true if `power` (and thus downstream sums) changed
	 */
	private async applyMeasured(entity: EntityDefinition): Promise<boolean> {
		const measured = this.measuredPower(entity.entityId);
		if (!usesBalance(entity)) {
			if (measured === undefined) {
				return false;
			}
			this.powerCache.set(entity.entityId, measured);
			await this.adapter.setStateAsync(`entities.${entity.entityId}.power`, { val: measured, ack: true });
			return true;
		}
		if (measured !== undefined) {
			await this.adapter.setStateAsync(`entities.${entity.entityId}.rawPower`, { val: measured, ack: true });
		}
		const source = this.currentSource(entity);
		if (source === "balance") {
			return false; // power comes from recomputeBalance()
		}
		const value = source === "fallback" ? this.fallbackCache.get(entity.entityId) : measured;
		if (value === undefined) {
			return false;
		}
		this.powerCache.set(entity.entityId, value);
		await this.adapter.setStateAsync(`entities.${entity.entityId}.power`, { val: value, ack: true });
		return true;
	}

	/** Periodic check: a dead feed sends no events, so staleness has to be polled. */
	private async onStaleCheck(): Promise<void> {
		for (const entity of this.entities) {
			if (entity.powerSource !== "measuredWithFallback") {
				continue;
			}
			const want = this.currentSource(entity);
			if (this.effectiveSource.get(entity.entityId) !== want) {
				// Re-applies the measurement/fallback (if available) or lets recomputeBalance take over.
				if (want !== "balance") {
					await this.applyMeasured(entity);
					await this.recomputeCategorySum(entity.category);
				}
				await this.recomputeBalance();
			}
		}
	}

	private async subscribeSources(): Promise<void> {
		this.powerStateSubscribers.clear();
		this.exportStateSubscribers.clear();
		this.fallbackStateSubscribers.clear();
		this.acStateSubscribers.clear();
		this.energyStateSubscribers.clear();
		this.socStateSubscribers.clear();

		for (const entity of this.entities) {
			this.addSubscriber(this.powerStateSubscribers, entity.powerStateId, entity.entityId);
			if (entity.exportStateId) {
				this.addSubscriber(this.exportStateSubscribers, entity.exportStateId, entity.entityId);
			}
			if (entity.energyStateId) {
				this.addSubscriber(this.energyStateSubscribers, entity.energyStateId, entity.entityId);
			}
			if (entity.socStateId) {
				this.addSubscriber(this.socStateSubscribers, entity.socStateId, entity.entityId);
			}
			if (entity.fallbackStateId) {
				this.addSubscriber(this.fallbackStateSubscribers, entity.fallbackStateId, entity.entityId);
			}
		}
		for (const loss of this.lossDefinitions) {
			if (loss.acStateId) {
				this.addSubscriber(this.acStateSubscribers, loss.acStateId, loss.entityId);
			}
		}

		const ids = this.getSubscribedForeignIds();
		if (ids.length > 0) {
			await this.adapter.subscribeForeignStatesAsync(ids);
		}
	}

	private addSubscriber(map: Map<string, string[]>, sourceId: string, entityId: string): void {
		const list = map.get(sourceId) ?? [];
		list.push(entityId);
		map.set(sourceId, list);
	}

	private async recomputeAll(): Promise<void> {
		for (const parentId of this.childrenByParent.keys()) {
			await this.recomputeRestPower(parentId);
		}
		for (const category of ENTITY_CATEGORIES) {
			await this.recomputeCategorySum(category);
		}
		await this.recomputeLossPowers();
		await this.recomputeBalance();
	}

	/**
	 * Writes `entities.<parentId>.restPower` = parent's own power minus the sum of the power
	 * of all entities assigned to it as children (the Sammelmessung/Einzelmessung model).
	 * A child with `invertInParent` set contributes with an inverted sign instead - for a
	 * producer that is already netted into the parent's own reading (e.g. a balcony power
	 * plant feeding into the house wiring downstream of a house consumption meter), this adds
	 * its production back instead of subtracting it, reconstructing the true gross value.
	 *
	 * @param parentId - entity id of the aggregate/collective measurement
	 */
	private async recomputeRestPower(parentId: string): Promise<void> {
		const children = this.childrenByParent.get(parentId);
		if (!children || children.length === 0) {
			return;
		}
		const parentPower = this.powerCache.get(parentId);
		if (parentPower === undefined) {
			return;
		}
		const childrenSum = children.reduce((sum, child) => {
			const childPower = this.powerCache.get(child.entityId) ?? 0;
			return sum + (child.invertInParent ? -childPower : childPower);
		}, 0);
		const restPower = parentPower - childrenSum;
		this.restPowerCache.set(parentId, restPower);
		await this.adapter.setStateAsync(`entities.${parentId}.restPower`, { val: restPower, ack: true });
	}

	/**
	 * Category sums use `restPower` instead of the raw reading for any entity that has children
	 * assigned to it - otherwise a producer netted into the parent's reading (e.g. a balcony
	 * power plant) would be undercounted, and an individually measured child would be counted
	 * twice (once via the parent's raw meter reading, once via its own line item).
	 *
	 * @param category - the category to sum
	 */
	private async recomputeCategorySum(category: EntityCategory): Promise<void> {
		const sum = this.entities
			.filter(e => e.category === category)
			.reduce(
				(total, e) =>
					total +
					(this.childrenByParent.has(e.entityId)
						? (this.restPowerCache.get(e.entityId) ?? this.powerCache.get(e.entityId) ?? 0)
						: (this.powerCache.get(e.entityId) ?? 0)),
				0,
			);
		this.categorySumCache.set(category, sum);
		await this.adapter.setStateAsync(`summary.${category}.power`, { val: sum, ack: true });
	}

	/**
	 * The energy balance (see entityModel.computeBalance): sets the power of a balance-derived
	 * entity (`balance`, or `measuredWithFallback` with a stale source), publishes the balance
	 * value of every grid/storage entity as `balancePower` (diagnostic: what it would have to be
	 * if all other measurements were right) and the signed measurement residual. Some grid
	 * connections don't have a register that reflects the real post-battery exchange, and battery
	 * registers can be off as well - the residual makes such inconsistencies visible.
	 */
	private async recomputeBalance(): Promise<void> {
		const totals = (): { producer: number; consumer: number; storage: number; grid: number; loss: number } => ({
			producer: this.categorySumCache.get("producer") ?? 0,
			consumer: this.categorySumCache.get("consumer") ?? 0,
			storage: this.categorySumCache.get("storage") ?? 0,
			grid: this.categorySumCache.get("grid") ?? 0,
			loss: this.categorySumCache.get("loss") ?? 0,
		});

		// A balance-derived entity's own category does not enter its own formula, so one pass suffices.
		const balance = computeBalance(totals());
		for (const entity of this.entities) {
			if (entity.category !== "grid" && entity.category !== "storage") {
				continue;
			}
			const value = entity.category === "grid" ? balance.gridBalance : balance.storageBalance;
			await this.adapter.setStateAsync(`entities.${entity.entityId}.balancePower`, { val: value, ack: true });
			if (!usesBalance(entity)) {
				continue;
			}
			const source = this.currentSource(entity);
			const previous = this.effectiveSource.get(entity.entityId);
			if (previous !== source) {
				this.effectiveSource.set(entity.entityId, source);
				await this.adapter.setStateAsync(`entities.${entity.entityId}.source`, { val: source, ack: true });
				if (entity.powerSource === "measuredWithFallback" && previous !== undefined) {
					this.adapter.log.info(
						source === "balance"
							? `"${entity.name}": no source updated for over ${entity.staleAfterS} s - using the energy balance until one is back`
							: source === "fallback"
								? `"${entity.name}": source not updated for over ${entity.staleAfterS} s - using the fallback state ${entity.fallbackStateId}`
								: `"${entity.name}": source updates again - back to the measured value`,
					);
				}
			}
			if (source === "balance") {
				this.powerCache.set(entity.entityId, value);
				await this.adapter.setStateAsync(`entities.${entity.entityId}.power`, { val: value, ack: true });
				await this.recomputeCategorySum(entity.category);
				if (entity.category === "storage") {
					await this.recomputeLossPowers();
				}
			}
		}

		await this.adapter.setStateAsync("summary.balanceResidual.power", { val: computeBalance(totals()).residual, ack: true });
		const gridSources = this.entities.filter(e => e.category === "grid").map(e => this.effectiveSource.get(e.entityId));
		const gridSource = gridSources.includes("balance") ? "balance" : gridSources.includes("fallback") ? "fallback" : "measured";
		await this.adapter.setStateAsync("summary.grid.source", { val: gridSource, ack: true });
	}

	/**
	 * Recomputes every synthesized loss entity's power from its source entity's current
	 * (already-normalized) power - see EntityDefinition.efficiencyPercent and
	 * `entityModel.computeLossPower`. Loss entities aren't subscribed to any source state
	 * themselves (there is nothing to subscribe to, they're a physically-motivated estimate, not
	 * a measurement), so this runs explicitly
	 * whenever a producer's or storage's own power might have changed instead.
	 */
	private async recomputeLossPowers(): Promise<void> {
		if (this.lossDefinitions.length === 0) {
			return;
		}
		let lossSum = 0;
		for (const loss of this.lossDefinitions) {
			const sourcePower = this.powerCache.get(loss.sourceEntityId) ?? 0;
			let lossPower: number;
			if (loss.kind === "inverterLoss") {
				const ac = this.acCache.get(loss.entityId);
				const pv = (loss.inputIds ?? []).reduce((sum, id) => sum + (this.powerCache.get(id) ?? 0), 0);
				lossPower = ac === undefined ? 0 : computeInverterLoss(pv, sourcePower, ac);
			} else {
				lossPower = computeLossPower(loss, sourcePower);
			}
			this.powerCache.set(loss.entityId, lossPower);
			await this.adapter.setStateAsync(`entities.${loss.entityId}.power`, { val: lossPower, ack: true });
			lossSum += lossPower;
		}
		this.categorySumCache.set("loss", lossSum);
		await this.adapter.setStateAsync("summary.loss.power", { val: lossSum, ack: true });
	}

	private async createCategoryObjects(): Promise<void> {
		await this.adapter.extendObjectAsync("summary", { type: "channel", common: { name: tAll("Category summaries") }, native: {} });
		for (const category of ENTITY_CATEGORIES) {
			await this.adapter.extendObjectAsync(`summary.${category}`, { type: "channel", common: { name: CATEGORY_NAMES[category] }, native: {} });
			await this.adapter.extendObjectAsync(`summary.${category}.power`, {
				type: "state",
				common: {
					name: tAll("{category} total power", { category: CATEGORY_NAMES[category] }),
					role: "value.power",
					type: "number",
					unit: "W",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		}
		await this.adapter.extendObjectAsync("summary.grid.source", {
			type: "state",
			common: {
				name: tAll("Grid value source: measured, fallback (second measured state) or balance while a grid entity runs on the energy balance"),
				role: "text",
				type: "string",
				read: true,
				write: false,
				def: "measured",
				states: { measured: "measured", fallback: "fallback", balance: "balance" },
			},
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.balanceResidual", {
			type: "channel",
			common: { name: tAll("Measurement residual") },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.balanceResidual.power", {
			type: "state",
			common: {
				name: tAll(
					"Measurement residual: production + grid − storage − consumption − losses (positive = more measured supply than use; includes unmeasured inverter/battery self-consumption)",
				),
				role: "value.power",
				type: "number",
				unit: "W",
				read: true,
				write: false,
				def: 0,
			},
			native: {},
		});
	}

	/**
	 * Creates/updates the object tree for every currently configured entity and deletes the
	 * object tree for any entity that used to exist but is no longer part of the config.
	 */
	private async syncEntityObjects(): Promise<void> {
		await this.adapter.extendObjectAsync("entities", { type: "channel", common: { name: tAll("Entities") }, native: {} });

		const existing = await this.adapter.getChannelsOfAsync("entities");
		const configuredIds = new Set([...this.entities.map(e => e.entityId), ...this.lossDefinitions.map(l => l.entityId)]);
		for (const obj of existing ?? []) {
			const shortId = obj._id.slice(obj._id.lastIndexOf(".") + 1);
			if (obj._id === `${this.adapter.namespace}.entities` || shortId === "entities") {
				continue;
			}
			if (!configuredIds.has(shortId)) {
				this.adapter.log.info(`Removing entity "${shortId}" (no longer configured)`);
				await this.adapter.delObjectAsync(`entities.${shortId}`, { recursive: true });
			}
		}

		const optionalState = async (entity: EntityDefinition, suffix: string, present: boolean, common: Partial<ioBroker.StateCommon>): Promise<void> => {
			if (present) {
				await this.adapter.extendObjectAsync(`entities.${entity.entityId}.${suffix}`, {
					type: "state",
					common: { read: true, write: false, ...common },
					native: {},
				});
			} else {
				// Config may have changed since the previous run - drop a stale optional state.
				await this.adapter.delObjectAsync(`entities.${entity.entityId}.${suffix}`).catch(() => undefined);
			}
		};

		for (const entity of this.entities) {
			const hasChildren = this.childrenByParent.has(entity.entityId);
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}`, {
				type: "channel",
				// common.color is a standard ioBroker object property - widgets (e.g. the flow-diagram
				// widget) read it directly via getObject instead of needing a duplicate color state.
				common: { name: entity.name, color: entity.color },
				native: { category: entity.category, parentId: entity.parentId ?? "", powerSource: entity.powerSource },
			});
			await this.adapter.extendObjectAsync(`entities.${entity.entityId}.power`, {
				type: "state",
				common: { name: tAll("{name} power", { name: entity.name }), role: "value.power", type: "number", unit: "W", read: true, write: false, def: 0 },
				native: {},
			});
			await optionalState(entity, "rawPower", usesBalance(entity), {
				name: tAll("{name} measured source reading (diagnostic - power may come from the balance)", { name: entity.name }),
				role: "value.power",
				type: "number",
				unit: "W",
				def: 0,
			});
			await optionalState(entity, "source", usesBalance(entity), {
				name: tAll("{name}: currently used source (measured / fallback / balance)", { name: entity.name }),
				role: "text",
				type: "string",
				def: "",
				states: { measured: "measured", fallback: "fallback", balance: "balance" },
			});
			await optionalState(entity, "balancePower", entity.category === "grid" || entity.category === "storage", {
				name: tAll("{name} power according to the energy balance (diagnostic, compare with power)", { name: entity.name }),
				role: "value.power",
				type: "number",
				unit: "W",
				def: 0,
			});
			await optionalState(entity, "energy", !!entity.energyStateId, {
				name: tAll("{name} energy", { name: entity.name }),
				role: "value.energy",
				type: "number",
				unit: "kWh",
				def: 0,
			});
			await optionalState(entity, "soc", !!entity.socStateId, {
				name: tAll("{name} state of charge", { name: entity.name }),
				role: "value.battery",
				type: "number",
				unit: "%",
				min: 0,
				max: 100,
				def: 0,
			});
			await optionalState(entity, "restPower", hasChildren, {
				name: tAll("{name} rest power (aggregate minus assigned individual measurements)", { name: entity.name }),
				role: "value.power",
				type: "number",
				unit: "W",
				def: 0,
			});
		}

		for (const loss of this.lossDefinitions) {
			await this.adapter.extendObjectAsync(`entities.${loss.entityId}`, {
				type: "channel",
				common: { name: loss.name, color: loss.color },
				// lossKind lets the flow-diagram widget tell a producer's inverter-loss apart from a
				// storage's charge-/discharge-loss without guessing from the id/name - see the widget's
				// EntityMeta lookup.
				native: { category: "loss", parentId: "", lossKind: loss.kind, lossSourceEntityId: loss.sourceEntityId },
			});
			await this.adapter.extendObjectAsync(`entities.${loss.entityId}.power`, {
				type: "state",
				common: { name: tAll("{name} power", { name: loss.name }), role: "value.power", type: "number", unit: "W", read: true, write: false, def: 0 },
				native: {},
			});
		}
	}
}
