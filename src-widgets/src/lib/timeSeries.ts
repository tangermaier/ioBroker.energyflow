/** Shared helper for any hourly series keyed by an absolute timestamp (forecast power, weather). */

/**
 * Finds the point in a timestamp-ordered series closest to a target instant - used to look up
 * "what was forecast/weather at this scrubbed time" from an hourly series that may not have an
 * exact match for an arbitrary scrub position.
 *
 * @param points - a series ordered by ascending `ts`
 * @param targetTs - the instant to find the closest point for, as a Unix timestamp in milliseconds
 */
export function nearestPointByTs<T extends { ts: number }>(points: T[], targetTs: number): T | undefined {
	if (points.length === 0) {
		return undefined;
	}
	let closest = points[0];
	let closestDiff = Math.abs(points[0].ts - targetTs);
	for (let i = 1; i < points.length; i++) {
		const diff = Math.abs(points[i].ts - targetTs);
		if (diff < closestDiff) {
			closest = points[i];
			closestDiff = diff;
		}
	}
	return closest;
}
