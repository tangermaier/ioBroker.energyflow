/**
 * Backend translations (gettext style): the English source text in the code IS the key, so code
 * stays readable and a missing translation degrades to English instead of a raw key.
 *
 * - `t(text, params)` - one string in the ioBroker system language (texts written into states,
 *   e.g. the recommendation text and the plan's slot reasons). Set once at start-up via
 *   `setLanguage(system.config.common.language)`.
 * - `tAll(text, params)` - an object with all ioBroker languages, for `common.name` of the
 *   objects the adapter creates (admin/vis show the viewer's language).
 *
 * Placeholders: `{name}`. A parameter can itself be translated (`{ en, de, ... }`), it is then
 * resolved per language. Every literal passed to t()/tAll() must have a translation in
 * ./translations.ts for every language - enforced by i18n.test.ts.
 */

import { translations } from "./translations.js";

/** All languages ioBroker supports, English first (source language). */
export const LANGUAGES = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;
export type Lang = (typeof LANGUAGES)[number];
export type Translated = Record<Lang, string>;
export type TextParam = string | number | Partial<Record<Lang, string>>;

let current: Lang = "en";

/**
 * Sets the language for t() and number/date formatting. Unknown languages fall back to English.
 *
 * @param lang - ioBroker language code (system.config common.language)
 */
export function setLanguage(lang: string | undefined): void {
	current = (LANGUAGES as readonly string[]).includes(lang ?? "") ? (lang as Lang) : "en";
}

/** The current language. */
export function getLanguage(): Lang {
	return current;
}

/**
 * BCP-47 locale for Intl formatting of a language.
 *
 * @param lang - language (default: current)
 */
export function localeOf(lang: Lang = current): string {
	return lang === "zh-cn" ? "zh-CN" : lang;
}

function resolveParam(value: TextParam, lang: Lang): string {
	if (typeof value === "object") {
		return value[lang] ?? value.en ?? "";
	}
	return String(value);
}

function translateTo(lang: Lang, text: string, params?: Record<string, TextParam>): string {
	const template = lang === "en" ? text : (translations[text]?.[lang] ?? text);
	if (!params) {
		return template;
	}
	return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? resolveParam(params[key], lang) : match));
}

/**
 * Translates into the current language.
 *
 * @param text - English source text (literal!)
 * @param params - placeholder values
 */
export function t(text: string, params?: Record<string, TextParam>): string {
	return translateTo(current, text, params);
}

/**
 * Translates into all languages (for common.name).
 *
 * @param text - English source text (literal!)
 * @param params - placeholder values
 */
export function tAll(text: string, params?: Record<string, TextParam>): Translated {
	const result = {} as Translated;
	for (const lang of LANGUAGES) {
		result[lang] = translateTo(lang, text, params);
	}
	return result;
}

/**
 * Translated name of a history period state suffix (energyToday, balanceEnergyYesterday, ...).
 *
 * @param suffix - the state id suffix
 */
export function periodName(suffix: string): Translated {
	if (suffix.endsWith("Yesterday")) {
		return tAll("energy yesterday");
	}
	if (suffix.endsWith("Last7Days")) {
		return tAll("energy last 7 days");
	}
	return tAll("energy today");
}

/**
 * Number in the current locale with a fixed number of decimals, without thousands separators.
 *
 * @param v - the number
 * @param decimals - decimals
 */
export function fmtNum(v: number, decimals: number): string {
	return new Intl.NumberFormat(localeOf(), { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false }).format(v);
}

/**
 * Wall-clock time hh:mm in the current locale.
 *
 * @param ts - point in time (ms)
 */
export function fmtTime(ts: number): string {
	return new Intl.DateTimeFormat(localeOf(), { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ts));
}

/**
 * Short weekday plus day and month (e.g. "Sa., 01.11." / "Sat, 11/01") in the current locale.
 *
 * @param ts - point in time (ms)
 */
export function fmtDay(ts: number): string {
	return new Intl.DateTimeFormat(localeOf(), { weekday: "short", day: "2-digit", month: "2-digit" }).format(new Date(ts));
}
