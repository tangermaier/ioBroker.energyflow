// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
import { tAll } from "../i18n/i18n.js";
import type * as utils from "@iobroker/adapter-core";
import { getSystemLocation } from "../location.js";
import { toLocalBuildings } from "./buildingGeometry.js";
import { fetchOfmBuildingRings } from "./openFreeMap.js";
import { runSafely } from "../safeAsync.js";

/** How far around the home to fetch building footprints, in meters - matches Helios' MAX_DISPLAY_RADIUS_M. */
const RADIUS_M = 250;
/** Buildings don't move: a daily refresh is enough to eventually pick up new construction, not for freshness. */
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetches nearby building footprints (from OpenFreeMap, see openFreeMap.ts) once at startup and
 * on a daily timer, converts them to local flat-earth geometry relative to the home (see
 * buildingGeometry.ts), and writes them as a state for the widget's shadow math and mini site
 * plan to consume. A fetch failure (network outage, no buildings mapped in the area) leaves the
 * previous state in place rather than clearing it - stale building geometry is still useful,
 * buildings essentially never move.
 */
export class BuildingManager {
	private readonly adapter: utils.AdapterInstance;
	private refreshTimer: ioBroker.Interval | undefined;

	/**
	 * @param adapter - the adapter instance to create/update objects and states on
	 */
	public constructor(adapter: utils.AdapterInstance) {
		this.adapter = adapter;
	}

	/** Creates the building object tree, runs an initial fetch, and schedules the daily refresh. */
	public async init(): Promise<void> {
		await this.createObjects();
		await this.refresh();
		this.refreshTimer = this.adapter.setInterval(() => {
			runSafely(this.adapter, "Building footprint refresh", () => this.refresh());
		}, REFRESH_INTERVAL_MS);
	}

	/** Stops the periodic refresh timer. */
	public stop(): void {
		if (this.refreshTimer) {
			this.adapter.clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private async refresh(): Promise<void> {
		const location = await getSystemLocation(this.adapter);
		if (!location) {
			this.adapter.log.warn("Cannot fetch building footprints: no latitude/longitude configured in system.config (Admin > System Settings)");
			return;
		}

		try {
			const rings = await fetchOfmBuildingRings(location.latitude, location.longitude, RADIUS_M);
			if (rings === null) {
				this.adapter.log.warn("Building footprint fetch from OpenFreeMap failed (network/outage) - keeping previous data, if any");
				return;
			}
			const buildings = toLocalBuildings(rings, location.latitude, location.longitude, RADIUS_M);
			await this.adapter.setStateAsync("summary.buildings.footprints", { val: JSON.stringify(buildings), ack: true });
			await this.adapter.setStateAsync("summary.buildings.fetchedAt", { val: Date.now(), ack: true });
			this.adapter.log.info(`Fetched ${buildings.length} nearby building footprint(s) for shadow calculation`);
		} catch (error) {
			this.adapter.log.warn(`Building footprint fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async createObjects(): Promise<void> {
		await this.adapter.extendObjectAsync("summary.buildings", {
			type: "channel",
			common: { name: tAll("Nearby building footprints (for shadow calculation)") },
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.buildings.footprints", {
			type: "state",
			common: {
				name: tAll("Nearby building footprints (JSON) - local meters relative to home, from OpenStreetMap/OpenFreeMap"),
				role: "json",
				type: "string",
				read: true,
				write: false,
			},
			native: {},
		});
		await this.adapter.extendObjectAsync("summary.buildings.fetchedAt", {
			type: "state",
			common: { name: tAll("When the building footprints were last fetched"), role: "date", type: "number", read: true, write: false, def: 0 },
			native: {},
		});
	}
}
