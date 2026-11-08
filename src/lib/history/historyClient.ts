/**
 * Database-neutral read access to ioBroker's history: every hourly series the adapter needs (ML
 * training ground truth, load profile, today/yesterday/7-day energy, actual-yield comparison) is
 * fetched through the standard `getHistory` message any history adapter answers - `history`,
 * `influxdb` (1.x/2.x) and `sql` alike - so users are not tied to one database.
 *
 * Timestamp convention: every HourlyActual
 * carries the END of the hour it averages - the same "preceding hour" convention as Open-Meteo's
 * hourly values, which is why forecast and actual series line up 1:1 by timestamp. History
 * adapters stamp aggregated buckets differently (see normalizeHourlyHistory), so the result is
 * normalized here, in one place.
 */

const HOUR_MS = 3600 * 1000;
/** getHistory over 28 days with many entities can take a while on a small host. */
const GET_HISTORY_TIMEOUT_MS = 60_000;

/** One hourly reading. */
export interface HourlyActual {
	/** Absolute Unix timestamp in milliseconds, END of the averaged hour */
	ts: number;
	/** Mean (or max) value over that hour, in the state's own unit (W for power states) */
	powerW: number;
}

/** Minimal adapter surface needed to talk to a history instance - keeps this module testable. */
export interface HistoryMessenger {
	sendToAsync(instanceName: string, command: string, message: ioBroker.MessagePayload, options?: { timeout?: number }): Promise<ioBroker.Message | undefined>;
}

/** Where history is read from. */
export interface HistorySource {
	/** ioBroker history instance, e.g. "influxdb.0", "history.0", "sql.0" - empty = not configured */
	instance: string;
	messenger: HistoryMessenger;
}

/** Adapter config fields this module reads (io-package.json native). */
export interface AdapterHistorySettings {
	historyInstance?: string;
}

/**
 * Reads the history source out of the adapter config.
 *
 * @param adapter - the adapter instance (config + sendToAsync)
 * @param adapter.config - native config
 */
export function getHistorySourceFromAdapter(adapter: HistoryMessenger & { config: AdapterHistorySettings }): HistorySource {
	const c = adapter.config;
	return {
		instance: (c.historyInstance || "").trim(),
		messenger: adapter,
	};
}

/**
 * True if any history source is configured - history is optional (no ML correction, load profile or
 * energy history without it), so callers skip those features instead of failing.
 *
 * @param source - the history source
 */
export function isHistoryConfigured(source: HistorySource): boolean {
	return !!source.instance;
}

/**
 * Start of the hour a HourlyActual (or Open-Meteo hourly) timestamp averages over.
 *
 * @param ts - window-end timestamp in ms
 */
export function hourStartOf(ts: number): number {
	return ts - HOUR_MS;
}

/**
 * Normalizes a getHistory answer (aggregate average/max, step 1 h) to hour-END timestamps.
 *
 * The adapters stamp a bucket differently - `@iobroker/aggregate` (history, sql, influxdb when it
 * aggregates itself) and influxdb 2 `mean`: the bucket's middle; influxdb 2 `max`: the time of the
 * maximum sample; influxdb 1 (InfluxQL GROUP BY time): the bucket's start. Since the requested
 * start is hour-aligned, all of them lie inside [hourStart, hourStart + 1 h), so
 * `floor(ts / 1 h) * 1 h + 1 h` yields the hour end for every one of them.
 *
 * Drops null values, border buckets outside [alignedStart, end) and - should an adapter ever return
 * two values for one hour - keeps the first.
 *
 * @param result - raw getHistory result entries
 * @param alignedStart - hour-aligned start of the requested range (ms)
 * @param end - end of the requested range (ms, exclusive)
 */
export function normalizeHourlyHistory(result: { ts: number; val: unknown }[], alignedStart: number, end: number): HourlyActual[] {
	const byHourEnd = new Map<number, number>();
	for (const entry of result) {
		if (typeof entry.val !== "number" || !Number.isFinite(entry.val) || typeof entry.ts !== "number") {
			continue;
		}
		const hourStart = Math.floor(entry.ts / HOUR_MS) * HOUR_MS;
		if (hourStart < alignedStart || hourStart >= end) {
			continue;
		}
		const hourEnd = hourStart + HOUR_MS;
		if (!byHourEnd.has(hourEnd)) {
			byHourEnd.set(hourEnd, entry.val);
		}
	}
	return [...byHourEnd.entries()].sort((a, b) => a[0] - b[0]).map(([ts, powerW]) => ({ ts, powerW }));
}

/**
 * Fetches hourly-aggregated values of one ioBroker state over a date range. Timestamps are hour
 * ENDS (see HourlyActual); a partial hour at `end` is included, like before.
 *
 * @param source - the history source
 * @param stateId - the ioBroker state id (must be logged by the history instance)
 * @param start - start of the range (inclusive; rounded down to the full hour)
 * @param end - end of the range (exclusive)
 * @param fn - aggregate per hour (default mean; max e.g. for "was the battery full in this hour")
 */
export async function queryHourlyActual(source: HistorySource, stateId: string, start: Date, end: Date, fn: "mean" | "max" = "mean"): Promise<HourlyActual[]> {
	if (!source.instance) {
		return [];
	}
	return queryViaGetHistory(source, stateId, start, end, fn);
}

/**
 * The getHistory path (see queryHourlyActual).
 *
 * @param source - the history source (instance must be set)
 * @param stateId - state id
 * @param start - range start
 * @param end - range end (exclusive)
 * @param fn - mean or max
 */
async function queryViaGetHistory(source: HistorySource, stateId: string, start: Date, end: Date, fn: "mean" | "max"): Promise<HourlyActual[]> {
	const alignedStart = Math.floor(start.getTime() / HOUR_MS) * HOUR_MS;
	const endMs = end.getTime();
	const hours = Math.max(1, Math.ceil((endMs - alignedStart) / HOUR_MS));
	const response = (await source.messenger.sendToAsync(
		source.instance,
		"getHistory",
		{
			id: stateId,
			options: {
				start: alignedStart,
				end: endMs,
				step: HOUR_MS,
				aggregate: fn === "max" ? "max" : "average",
				// count/limit only bound the number of buckets; with an explicit step they must not
				// shrink it (@iobroker/aggregate widens the step once buckets exceed `limit`)
				count: hours + 2,
				limit: hours + 2,
				removeBorderValues: true,
				ignoreNull: true,
			},
		},
		{ timeout: GET_HISTORY_TIMEOUT_MS },
	)) as unknown as { result?: { ts: number; val: unknown }[]; error?: string } | undefined;
	if (!response) {
		throw new Error(`getHistory on ${source.instance} for ${stateId}: no answer`);
	}
	if (response.error) {
		throw new Error(`getHistory on ${source.instance} for ${stateId}: ${response.error}`);
	}
	return normalizeHourlyHistory(Array.isArray(response.result) ? response.result : [], alignedStart, endMs);
}
