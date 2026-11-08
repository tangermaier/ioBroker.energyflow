/**
 * Pure helpers for reading tibberlink's price states - kept free of any ioBroker dependency so
 * they can be unit-tested against real JSON samples.
 *
 * Verified 2026-10-31 against Energy-Charts/SMARD day-ahead prices (96 quarter-hour slots,
 * max deviation 0.005 ct): tibberlink's `energy` field IS the net day-ahead spot price, `tax`
 * holds VAT on it plus every fixed component (grid fee, levies, electricity tax, Tibber margin),
 * and `total = energy + tax` is the gross consumer price. All three are in EUR/kWh.
 */

/** One price slot as used throughout EnergyFlow - all prices in ct/kWh. */
export interface PriceSlot {
	/** Slot start, absolute Unix timestamp in ms (inclusive) */
	startTs: number;
	/** Slot end, absolute Unix timestamp in ms (exclusive) */
	endTs: number;
	/** Gross consumer price in ct/kWh */
	totalCt: number;
	/** Net day-ahead spot price in ct/kWh - negative means a negative-price period (§51 EEG) */
	energyCt: number;
	/** Tibber's own price level classification (VERY_CHEAP ... VERY_EXPENSIVE), if supplied */
	level: string;
}

/** Default slot length if a price list has only one entry and no successor to measure against. */
const DEFAULT_SLOT_MS = 15 * 60 * 1000;

/**
 * Parses one tibberlink `PricesToday.json`/`PricesTomorrow.json` value into price slots, sorted
 * by start time. Malformed entries are skipped, a malformed/empty document yields []. Each
 * slot's end is the next slot's start; the last slot gets the same length as its predecessor
 * (tibberlink switched from hourly to quarter-hourly prices, so the length is not hardcoded).
 *
 * @param json - the raw state value (a JSON array string)
 */
export function parseTibberPriceJson(json: unknown): PriceSlot[] {
	if (typeof json !== "string" || json.length === 0) {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) {
		return [];
	}
	const raw: Array<Omit<PriceSlot, "endTs">> = [];
	for (const entry of parsed) {
		if (typeof entry !== "object" || entry === null) {
			continue;
		}
		const e = entry as Record<string, unknown>;
		const startTs = typeof e.startsAt === "string" ? Date.parse(e.startsAt) : NaN;
		if (!Number.isFinite(startTs) || typeof e.total !== "number" || !Number.isFinite(e.total)) {
			continue;
		}
		raw.push({
			startTs,
			totalCt: e.total * 100,
			energyCt: typeof e.energy === "number" && Number.isFinite(e.energy) ? e.energy * 100 : NaN,
			level: typeof e.level === "string" ? e.level : "",
		});
	}
	raw.sort((a, b) => a.startTs - b.startTs);
	return raw.map((slot, i) => {
		const next = raw[i + 1];
		const prev = raw[i - 1];
		const len = next ? next.startTs - slot.startTs : prev ? slot.startTs - prev.startTs : DEFAULT_SLOT_MS;
		return { ...slot, endTs: slot.startTs + len };
	});
}

/**
 * Merges price lists (e.g. a cached older list plus freshly read today/tomorrow lists): later
 * lists win for identical start times, the result is sorted, and slots that ended before
 * `dropBeforeTs` are discarded so the cache doesn't grow forever.
 *
 * @param lists - price lists in ascending priority order
 * @param dropBeforeTs - discard slots whose end lies at or before this timestamp (ms)
 */
export function mergePriceSlots(lists: PriceSlot[][], dropBeforeTs: number): PriceSlot[] {
	const byStart = new Map<number, PriceSlot>();
	for (const list of lists) {
		for (const slot of list) {
			byStart.set(slot.startTs, slot);
		}
	}
	return [...byStart.values()].filter(s => s.endTs > dropBeforeTs).sort((a, b) => a.startTs - b.startTs);
}

/**
 * Finds the slot containing `ts`, or undefined if no known slot covers it.
 *
 * @param slots - a sorted price list
 * @param ts - absolute timestamp in ms
 */
export function findSlotAt(slots: PriceSlot[], ts: number): PriceSlot | undefined {
	return slots.find(s => s.startTs <= ts && ts < s.endTs);
}

/**
 * Feed-in remuneration for one slot: the configured fixed tariff, except 0 during negative
 * day-ahead price periods (§51 EEG - no remuneration for plants commissioned since 2025-02-25).
 * A slot without a known spot price (NaN) keeps the regular tariff.
 *
 * @param slot - the price slot
 * @param feedInTariffCt - the fixed feed-in tariff in ct/kWh
 */
export function feedInForSlot(slot: PriceSlot, feedInTariffCt: number): number {
	return slot.energyCt < 0 ? 0 : feedInTariffCt;
}

/** Address/naming states of one tibberlink home, as read from `<instance>.Homes.<id>.*`. */
export interface TibberHomeInfo {
	/** Tibber home id (GUID) - what gets stored in the adapter config */
	id: string;
	/** Street address (Address.address1) */
	address1?: string;
	/** Address.PostalCode */
	postalCode?: string;
	/** Address.City */
	city?: string;
	/** General.NameInApp - the home's name in the Tibber app */
	nameInApp?: string;
}

/**
 * Builds the admin dropdown label for a tibberlink home: "address1, PLZ City (NameInApp)",
 * leaving out whatever parts are missing; falls back to the bare id.
 *
 * @param home - the home's address/naming info
 */
export function formatTibberHomeLabel(home: TibberHomeInfo): string {
	const place = [home.postalCode, home.city].filter(Boolean).join(" ");
	const address = [home.address1, place].filter(Boolean).join(", ");
	const base = address || home.id;
	return home.nameInApp ? `${base} (${home.nameInApp})` : base;
}

/**
 * Normalizes whatever the admin "instance" selector stored ("tibberlink.0" or
 * "system.adapter.tibberlink.0") to the plain "tibberlink.0" namespace.
 *
 * @param value - the configured instance value
 */
export function normalizeInstance(value: string | undefined): string {
	return (value ?? "").replace(/^system\.adapter\./, "").trim();
}

/**
 * Median of a list of numbers (NaN-free), or undefined for an empty list.
 *
 * @param values - the numbers
 */
export function median(values: number[]): number | undefined {
	const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
	if (sorted.length === 0) {
		return undefined;
	}
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
