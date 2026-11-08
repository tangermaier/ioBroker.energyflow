/**
 * Widget runtime translations. The editor labels go through vis-2's own dictionary lookup (the
 * `./translations` export, see translations.ts); texts rendered by the widgets themselves use this
 * module instead, because that host lookup proved unreliable for runtime texts across reloads.
 * Both read the same dictionaries (src/i18n/<lang>.json), so every key is translated once.
 *
 * Language: each widget calls `syncLanguage(this.props.context)` at the start of its render, so
 * all helpers (and lib components rendered below it) use the vis-2 runtime language.
 */
import de from "../i18n/de.json";
import en from "../i18n/en.json";
import es from "../i18n/es.json";
import fr from "../i18n/fr.json";
import it from "../i18n/it.json";
import nl from "../i18n/nl.json";
import pl from "../i18n/pl.json";
import pt from "../i18n/pt.json";
import ru from "../i18n/ru.json";
import uk from "../i18n/uk.json";
import zhCn from "../i18n/zh-cn.json";

export const DICTIONARIES: Record<string, Record<string, string>> = { en, de, ru, pt, nl, fr, it, es, pl, uk, "zh-cn": zhCn };

let current = "en";

/**
 * Sets the language from the vis-2 widget context (falls back to the browser's system language).
 *
 * @param context - the widget's props.context (has `lang`)
 * @param context.lang - vis-2 runtime language
 */
export function syncLanguage(context?: { lang?: string }): void {
	const lang = context?.lang ?? (typeof window !== "undefined" ? (window as { systemLang?: string }).systemLang : undefined) ?? "en";
	current = DICTIONARIES[lang] ? lang : "en";
}

/** BCP-47 locale of the current language (for Intl). */
export function locale(): string {
	return current === "zh-cn" ? "zh-CN" : current;
}

/**
 * Translates a key (with the "energyflow_" prefix) into the current language, replacing {name}
 * placeholders. Missing translations fall back to English, then to the key itself.
 *
 * @param key - dictionary key
 * @param params - placeholder values
 */
export function tr(key: string, params?: Record<string, string | number>): string {
	const text = DICTIONARIES[current]?.[key] ?? DICTIONARIES.en[key] ?? key;
	return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

/**
 * Resolves an ioBroker `common.name`, which may be a plain string or a per-language object.
 *
 * @param name - common.name
 * @param fallback - used when the name is empty
 */
export function nameOf(name: unknown, fallback = ""): string {
	if (typeof name === "string") {
		return name || fallback;
	}
	if (name && typeof name === "object") {
		const n = name as Record<string, string>;
		return n[current] || n.en || Object.values(n).find(v => typeof v === "string" && v) || fallback;
	}
	return fallback;
}

/**
 * Number with fixed decimals in the current locale (no thousands separators).
 *
 * @param v - value
 * @param decimals - decimals
 */
export function num(v: number, decimals: number): string {
	return new Intl.NumberFormat(locale(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false }).format(v);
}

/**
 * Short weekday plus day and month in the current locale.
 *
 * @param ts - timestamp (ms)
 */
export function dayLabel(ts: number): string {
	return new Intl.DateTimeFormat(locale(), { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(ts));
}
