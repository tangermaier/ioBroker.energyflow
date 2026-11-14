import { tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import {
	feedInForSlot,
	findSlotAt,
	formatTibberHomeLabel,
	mergePriceSlots,
	normalizeInstance,
	parseTibberPriceJson,
	type PriceSlot,
	type TibberHomeInfo,
} from "./tibber.js";
import { runSafely } from "../safeAsync.js";

/**
 * Own default datapoints under 0_userdata.0, created if the corresponding admin config field is
 * left empty. The idea: SolarCockpit reads its own two "starter" datapoints out of the box, and
 * users without a dynamic tariff simply keep a hand-maintained value there.
 */
const DEFAULT_GRID_PURCHASE_PRICE_OID = "0_userdata.0.solarcockpit_gridPurchasePriceCtPerKWh";
const DEFAULT_FEED_IN_TARIFF_OID = "0_userdata.0.solarcockpit_feedInTariffCtPerKWh";

/** Quality code "substitute value from device or instance" - marks a held-over last known price. */
const Q_SUBSTITUTE = 0x40;
/** Slot length used to synthesize a flat price series from a fixed price. */
const FIXED_SLOT_MS = 15 * 60 * 1000;
/** Horizon of the synthesized flat price series in fixed-price mode. */
const FIXED_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Where the current prices come from - mirrored into `prices.source`. */
export type PriceSource = "tibber" | "fixed" | "none";

/**
 * Provides grid purchase price and feed-in tariff to the rest of the adapter and mirrors them
 * into `prices.*`. Two modes:
 *
 * - **fixed** (default): purchase price and feed-in tariff are read from two configurable object
 *   ids (falling back to self-created starter datapoints under 0_userdata.0).
 * - **tibber** (`native.useTibber`): the purchase price comes from tibberlink's
 *   `PricesToday.json`/`PricesTomorrow.json` for the configured home. The list is cached, so a
 *   short tibberlink outage doesn't interrupt anything as long as the cached list still covers
 *   "now"; the current price is always taken from the cached list's current slot (not from
 *   `CurrentPrice.total`), so it is consistent with the planner's price series by construction.
 *   The feed-in tariff stays the configured fixed value, except 0 in negative-spot-price slots.
 *
 * A missing source value never turns into 0: the last known value is held with quality
 * Q_SUBSTITUTE and `prices.source` reports "none" instead.
 */
export class PriceManager {
	private readonly adapter: utils.AdapterInstance;
	private readonly useTibber: boolean;
	private gridPurchasePriceOid = "";
	private feedInTariffOid = "";
	private tibberTodayOid = "";
	private tibberTomorrowOid = "";
	/** tibberlink's own running cost of today's grid import (LiveMeasurement.accumulatedCost), mirrored for comparison */
	private tibberCostOid = "";
	private cachedSlots: PriceSlot[] = [];
	private feedInTariffCt: number | undefined;
	private fixedPurchaseCt: number | undefined;
	private source: PriceSource = "none";
	private slotTimer: ioBroker.Timeout | undefined;
	private warnedMissing = false;
	private readonly listeners: Array<() => void> = [];

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
		this.useTibber = !!adapter.config.useTibber;
	}

	/** Resolves the configured sources, ensures the default datapoints exist, subscribes, and does an initial computation. */
	public async init(): Promise<void> {
		await this.createObjects();

		this.feedInTariffOid = this.adapter.config.oidFeedInTariff || DEFAULT_FEED_IN_TARIFF_OID;
		await this.ensureOwnDefaultDatapoint(
			this.feedInTariffOid,
			DEFAULT_FEED_IN_TARIFF_OID,
			"SolarCockpit feed-in tariff (ct/kWh) - edit by hand or repoint the adapter's oidFeedInTariff setting",
		);

		if (this.useTibber) {
			const instance = normalizeInstance(this.adapter.config.tibberInstance);
			const homeId = (this.adapter.config.tibberHomeId ?? "").trim();
			if (!instance || !homeId) {
				this.adapter.log.warn("Tibber prices enabled, but no tibberlink instance/home selected - no purchase price available");
			} else {
				this.tibberTodayOid = `${instance}.Homes.${homeId}.PricesToday.json`;
				this.tibberTomorrowOid = `${instance}.Homes.${homeId}.PricesTomorrow.json`;
				this.tibberCostOid = `${instance}.Homes.${homeId}.LiveMeasurement.accumulatedCost`;
			}
		} else {
			this.gridPurchasePriceOid = this.adapter.config.oidGridPurchasePrice || DEFAULT_GRID_PURCHASE_PRICE_OID;
			await this.ensureOwnDefaultDatapoint(
				this.gridPurchasePriceOid,
				DEFAULT_GRID_PURCHASE_PRICE_OID,
				"SolarCockpit grid purchase price (ct/kWh) - edit by hand, or enable Tibber prices in the adapter settings",
			);
		}

		for (const oid of this.getSubscribedForeignIds()) {
			await this.adapter.subscribeForeignStatesAsync(oid);
		}

		await this.reloadSources();
		await this.recompute();
		await this.mirrorTibberCost();
		this.scheduleSlotTick();
	}

	/** Stops the slot-boundary timer. Call this from the adapter's unload handler. */
	public stop(): void {
		if (this.slotTimer) {
			this.adapter.clearTimeout(this.slotTimer);
			this.slotTimer = undefined;
		}
	}

	/**
	 * Registers a callback fired whenever the price data changed (new Tibber list, changed fixed
	 * price) - not on every slot tick.
	 *
	 * @param listener - the callback
	 */
	public onPricesChanged(listener: () => void): void {
		this.listeners.push(listener);
	}

	/**
	 * @param id - full id of a foreign state that changed
	 */
	public isRelevant(id: string): boolean {
		return this.getSubscribedForeignIds().includes(id);
	}

	/**
	 * Re-reads the price sources and recomputes prices.* - call after isRelevant(id) confirms the change.
	 *
	 * @param id - the changed foreign state (a Tibber cost update is only mirrored, no recompute)
	 */
	public async onForeignStateChange(id?: string): Promise<void> {
		if (id && id === this.tibberCostOid) {
			await this.mirrorTibberCost();
			return;
		}
		await this.reloadSources();
		await this.recompute();
		for (const listener of this.listeners) {
			listener();
		}
	}

	/** Returns the oids this manager subscribes to. */
	public getSubscribedForeignIds(): string[] {
		return [this.gridPurchasePriceOid, this.tibberTodayOid, this.tibberTomorrowOid, this.tibberCostOid, this.feedInTariffOid].filter(Boolean);
	}

	/** Where the current price comes from. */
	public getSource(): PriceSource {
		return this.source;
	}

	/** The fixed feed-in tariff in ct/kWh, or undefined if its source has no numeric value. */
	public getFeedInTariffCt(): number | undefined {
		return this.feedInTariffCt;
	}

	/**
	 * The known price series from the slot containing `now` onward: the cached Tibber list in
	 * tibber mode, a flat 24 h series of 15-minute slots in fixed mode. Empty if no price is
	 * known for `now` - the caller (planner) must then treat prices as unavailable.
	 *
	 * @param now - absolute timestamp in ms
	 */
	public getPriceSeries(now: number): PriceSlot[] {
		if (this.useTibber) {
			if (!findSlotAt(this.cachedSlots, now)) {
				return [];
			}
			return this.cachedSlots.filter(s => s.endTs > now);
		}
		if (this.fixedPurchaseCt === undefined) {
			return [];
		}
		const start = Math.floor(now / FIXED_SLOT_MS) * FIXED_SLOT_MS;
		const slots: PriceSlot[] = [];
		for (let ts = start; ts < start + FIXED_HORIZON_MS; ts += FIXED_SLOT_MS) {
			slots.push({ startTs: ts, endTs: ts + FIXED_SLOT_MS, totalCt: this.fixedPurchaseCt, energyCt: NaN, level: "" });
		}
		return slots;
	}

	/**
	 * Feed-in remuneration for a slot (fixed tariff, 0 during negative spot prices), or undefined
	 * if no feed-in tariff is known.
	 *
	 * @param slot - a slot from getPriceSeries()
	 */
	public getFeedInForSlot(slot: PriceSlot): number | undefined {
		return this.feedInTariffCt === undefined ? undefined : feedInForSlot(slot, this.feedInTariffCt);
	}

	/**
	 * Lists the homes of a tibberlink instance for the admin UI's home dropdown (selectSendTo).
	 *
	 * @param adapter - the adapter instance (used for state access)
	 * @param instanceValue - the tibberlink instance as stored by the admin instance selector
	 */
	public static async listTibberHomes(adapter: utils.AdapterInstance, instanceValue: string): Promise<Array<{ label: string; value: string }>> {
		const instance = normalizeInstance(instanceValue);
		if (!instance) {
			return [];
		}
		// Plain trailing-wildcard pattern only - never character classes (js-controller 7.2.2 crash risk).
		const states = await adapter.getForeignStatesAsync(`${instance}.Homes.*`);
		const homes = new Map<string, TibberHomeInfo>();
		const prefix = `${instance}.Homes.`;
		const fields: Record<string, keyof TibberHomeInfo> = {
			"Address.address1": "address1",
			"Address.PostalCode": "postalCode",
			"Address.City": "city",
			"General.NameInApp": "nameInApp",
		};
		for (const [id, state] of Object.entries(states)) {
			const rest = id.slice(prefix.length);
			const dot = rest.indexOf(".");
			if (dot <= 0) {
				continue;
			}
			const homeId = rest.slice(0, dot);
			const field = fields[rest.slice(dot + 1)];
			const home = homes.get(homeId) ?? { id: homeId };
			homes.set(homeId, home);
			if (field && field !== "id" && typeof state?.val === "string" && state.val) {
				home[field] = state.val;
			}
		}
		return [...homes.values()].map(home => ({ label: formatTibberHomeLabel(home), value: home.id }));
	}

	/**
	 * Mirrors Tibber's own running cost of today's grid import into `costs.tibberToday` - the
	 * billed value, as a cross-check for SolarCockpit's own `costs.today` (which integrates the grid
	 * entity x slot price and also subtracts feed-in revenue, so the two only match on days without
	 * export). Tibber resets it at local midnight.
	 */
	private async mirrorTibberCost(): Promise<void> {
		if (!this.tibberCostOid) {
			return;
		}
		const val = await this.readNumber(this.tibberCostOid);
		if (val !== undefined) {
			await this.adapter.setStateAsync("costs.tibberToday", { val: Math.round(val * 10000) / 10000, ack: true });
		}
	}

	/** Re-reads the configured sources into the in-memory cache. */
	private async reloadSources(): Promise<void> {
		this.feedInTariffCt = await this.readNumber(this.feedInTariffOid);
		if (this.useTibber) {
			if (!this.tibberTodayOid) {
				return;
			}
			const today = parseTibberPriceJson((await this.adapter.getForeignStateAsync(this.tibberTodayOid))?.val);
			const tomorrow = parseTibberPriceJson((await this.adapter.getForeignStateAsync(this.tibberTomorrowOid))?.val);
			// Keep the cached list as lowest priority - covers a tibberlink restart that briefly empties the json states.
			this.cachedSlots = mergePriceSlots([this.cachedSlots, today, tomorrow], Date.now());
		} else {
			this.fixedPurchaseCt = await this.readNumber(this.gridPurchasePriceOid);
		}
	}

	/** Mirrors the current-slot prices into prices.*. Never writes 0 for an unknown price. */
	private async recompute(): Promise<void> {
		const now = Date.now();
		let purchase: number | undefined;
		let feedIn = this.feedInTariffCt;
		let level = "";
		if (this.useTibber) {
			const slot = findSlotAt(this.cachedSlots, now);
			if (slot) {
				purchase = slot.totalCt;
				level = slot.level;
				feedIn = this.getFeedInForSlot(slot);
			}
		} else {
			purchase = this.fixedPurchaseCt;
		}

		const source: PriceSource = purchase === undefined ? "none" : this.useTibber ? "tibber" : "fixed";
		if (source === "none" && !this.warnedMissing) {
			this.adapter.log.warn(
				this.useTibber
					? "No Tibber price known for the current time slot - holding the last known price, plan suspended until prices are available again"
					: `Grid purchase price source ${this.gridPurchasePriceOid} has no numeric value - holding the last known price`,
			);
			this.warnedMissing = true;
		} else if (source !== "none") {
			this.warnedMissing = false;
		}
		this.source = source;

		// Rounded to 0.01 ct: avoids float noise like 40.889999999 from the EUR -> ct conversion.
		const round = (v: number): number => Math.round(v * 100) / 100;
		await this.writeOrHold("prices.gridPurchasePrice", purchase === undefined ? undefined : round(purchase));
		await this.writeOrHold("prices.feedInTariff", feedIn === undefined ? undefined : round(feedIn));
		await this.writeOrHold("prices.selfConsumptionValue", purchase === undefined || feedIn === undefined ? undefined : round(purchase - feedIn));
		await this.adapter.setStateAsync("prices.source", { val: source, ack: true });
		await this.adapter.setStateAsync("prices.level", { val: level, ack: true });
	}

	/**
	 * Writes a value, or - if it is unknown - re-acknowledges the last known value with quality
	 * Q_SUBSTITUTE instead of falling back to 0.
	 *
	 * @param id - own state id
	 * @param value - the new value, or undefined if unknown
	 */
	private async writeOrHold(id: string, value: number | undefined): Promise<void> {
		if (value !== undefined) {
			await this.adapter.setStateAsync(id, { val: value, ack: true });
			return;
		}
		const last = await this.adapter.getStateAsync(id);
		if (last && typeof last.val === "number" && last.q !== Q_SUBSTITUTE) {
			await this.adapter.setStateAsync(id, { val: last.val, ack: true, q: Q_SUBSTITUTE });
		}
	}

	/** Re-evaluates the current slot at every quarter-hour boundary (Tibber prices change per slot). */
	private scheduleSlotTick(): void {
		const now = Date.now();
		const next = Math.floor(now / FIXED_SLOT_MS) * FIXED_SLOT_MS + FIXED_SLOT_MS + 2000;
		this.slotTimer = this.adapter.setTimeout(() => {
			runSafely(this.adapter, "Price slot update", async () => {
				try {
					if (this.useTibber) {
						this.cachedSlots = mergePriceSlots([this.cachedSlots], Date.now());
					}
					await this.recompute();
				} finally {
					this.scheduleSlotTick(); // keep ticking even if one update failed
				}
			});
		}, next - now);
	}

	/**
	 * Creates the given oid as a plain writable number datapoint if it doesn't already exist -
	 * but ONLY when it is SolarCockpit's own suggested default id. An oid the user explicitly
	 * pointed at some other (possibly foreign-adapter-owned) state is never touched.
	 *
	 * @param oid - the oid actually configured (or defaulted to) for this price
	 * @param ownDefaultOid - SolarCockpit's own suggested default oid for this price
	 * @param name - description to give the datapoint if it needs to be created
	 */
	private async ensureOwnDefaultDatapoint(oid: string, ownDefaultOid: string, name: string): Promise<void> {
		if (oid !== ownDefaultOid) {
			return;
		}
		await this.adapter.setForeignObjectNotExistsAsync(oid, {
			type: "state",
			common: { name, type: "number", role: "value", unit: "ct/kWh", read: true, write: true, def: 0 },
			native: {},
		});
	}

	private async createObjects(): Promise<void> {
		if (this.useTibber) {
			await this.adapter.extendObjectAsync("costs", { type: "channel", common: { name: tAll("Grid electricity cost") }, native: {} });
			await this.adapter.extendObjectAsync("costs.tibberToday", {
				type: "state",
				common: {
					name: tAll("Tibber's own cost of today's grid import (LiveMeasurement.accumulatedCost) - comparison for costs.today"),
					role: "value",
					type: "number",
					unit: "€",
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		} else {
			await this.adapter.delObjectAsync("costs.tibberToday").catch(() => undefined);
		}
		await this.adapter.extendObjectAsync("prices.source", {
			type: "state",
			common: {
				name: tAll("Origin of the current prices (tibber / fixed / none = unknown, last value held)"),
				role: "text",
				type: "string",
				read: true,
				write: false,
				states: { tibber: "Tibber", fixed: "fixed", none: "none" },
			},
			native: {},
		});
		await this.adapter.extendObjectAsync("prices.level", {
			type: "state",
			common: {
				name: tAll("Tibber price level of the current slot (empty without Tibber)"),
				role: "text",
				type: "string",
				read: true,
				write: false,
				def: "",
			},
			native: {},
		});
		await this.adapter.extendObjectAsync("prices.gridPurchasePrice", {
			type: "state",
			common: {
				name: tAll("Grid purchase price of the current slot (gross)"),
				role: "value",
				type: "number",
				unit: "ct/kWh",
				read: true,
				write: false,
				def: 0,
			},
			native: {},
		});
	}

	/**
	 * Reads a numeric foreign state - undefined (not 0) if missing or non-numeric.
	 *
	 * @param oid - foreign state id
	 */
	private async readNumber(oid: string): Promise<number | undefined> {
		if (!oid) {
			return undefined;
		}
		const state = await this.adapter.getForeignStateAsync(oid);
		const val = typeof state?.val === "string" ? Number(state.val) : state?.val;
		return typeof val === "number" && Number.isFinite(val) ? val : undefined;
	}
}
