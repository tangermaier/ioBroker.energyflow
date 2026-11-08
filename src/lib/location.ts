import type * as utils from "@iobroker/adapter-core";

/**
 * Reads the installation's location from system.config (Admin > System Settings), the same
 * source used throughout the project for anything geography-dependent (yield forecast, sun
 * position, building shadows).
 *
 * @param adapter - the adapter instance to read the foreign object from
 */
export async function getSystemLocation(adapter: utils.AdapterInstance): Promise<{ latitude: number; longitude: number } | undefined> {
	const systemConfig = await adapter.getForeignObjectAsync("system.config");
	const latitude = systemConfig?.common?.latitude;
	const longitude = systemConfig?.common?.longitude;
	if (typeof latitude !== "number" || typeof longitude !== "number") {
		return undefined;
	}
	return { latitude, longitude };
}
