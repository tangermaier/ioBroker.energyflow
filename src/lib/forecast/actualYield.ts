/**
 * Fetches real historical production from InfluxDB for the producer entities, normalized and
 * summed the same way the live entity manager sums summary.producer.power - the counterpart to
 * the physics/ML forecast series, used by the widget to compare "what we predicted" against
 * "what actually happened" for the last day or two.
 */

import { normalizePower, type EntityDefinition } from "../entityModel.js";
import { queryHourlyActual, type HistorySource } from "../history/historyClient.js";
import type { ForecastPoint } from "./pvModel.js";

/**
 * Fetches and sums the last `hours` of actual hourly production across all given producer
 * entities. Entities are queried independently and merged by timestamp (rather than assumed to
 * share the same index range) since one entity's InfluxDB history can have gaps another's
 * doesn't - a broken sensor should not shift or drop otherwise-good hours from the others.
 *
 * @param entities - the producer entities to sum (any category works, but this is meant for producers)
 * @param historySource - InfluxDB connection details
 * @param hours - how many hours back from now to fetch
 */
export async function fetchActualProducerSeries(entities: EntityDefinition[], historySource: HistorySource, hours: number): Promise<ForecastPoint[]> {
	const end = new Date();
	const start = new Date(end.getTime() - hours * 3600000);

	const totals = new Map<number, number>();
	for (const entity of entities) {
		try {
			const actual = await queryHourlyActual(historySource, entity.powerStateId, start, end);
			for (const point of actual) {
				const normalized = normalizePower(point.powerW, entity);
				totals.set(point.ts, (totals.get(point.ts) ?? 0) + normalized);
			}
		} catch {
			// A single entity's InfluxDB measurement being unavailable (not logged, renamed, ...)
			// shouldn't take down the whole comparison - it just won't contribute to the sum.
		}
	}

	return [...totals.entries()].sort(([a], [b]) => a - b).map(([ts, powerW]) => ({ ts, powerW }));
}
