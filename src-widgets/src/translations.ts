// Widget-set translations for the vis-2 editor. Keys are looked up with the i18n prefix returned by
// getI18nPrefix() (adapter name + "_") automatically prepended by vis-2.
// `prefix: true` is required - without it vis-2 never activates prefix-based lookup for this
// dictionary and every SolarCockpitForecastWidget.t(...) call falls back to showing the raw key.
// The dictionaries live in ./i18n/<lang>.json and are shared with the runtime lookup (lib/i18n.ts).
import { DICTIONARIES } from "./lib/i18n";

const translations: Record<string, Record<string, string> | boolean> = {
	prefix: true,
	...DICTIONARIES,
};

export default translations;
