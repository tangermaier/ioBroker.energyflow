/**
 * Formats a Watt value as a compact, signed power label (e.g. "4.3 kW", "-150 W"). Shared between
 * SolarCockpitYieldWidget (node value labels) and SolarCockpitForecastWidget (forecast-vs-actual text).
 *
 * @param watts - power in Watt
 */
export function formatPower(watts: number): string {
	const abs = Math.abs(watts);
	return abs >= 1000 ? `${(watts / 1000).toFixed(1)} kW` : `${Math.round(watts)} W`;
}

/**
 * Formats a kWh value as a compact energy label (e.g. "160.5 kWh", "2.4 kWh") - one decimal below
 * 10 kWh for readability at small daily totals, none above (matches formatPower's kW rounding).
 *
 * @param kWh - energy in kWh
 */
export function formatEnergy(kWh: number): string {
	const abs = Math.abs(kWh);
	return abs >= 10 ? `${Math.round(kWh)} kWh` : `${kWh.toFixed(1)} kWh`;
}
