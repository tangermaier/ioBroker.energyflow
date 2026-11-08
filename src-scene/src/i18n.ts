/**
 * Scene translations. The language is the ioBroker system language (system.config), overridable
 * with the URL parameter `?lang=xx`. Dictionaries: ./i18n/<lang>.json, completeness is checked by
 * the adapter's i18n test.
 */
import de from "./i18n/de.json";
import en from "./i18n/en.json";
import es from "./i18n/es.json";
import fr from "./i18n/fr.json";
import it from "./i18n/it.json";
import nl from "./i18n/nl.json";
import pl from "./i18n/pl.json";
import pt from "./i18n/pt.json";
import ru from "./i18n/ru.json";
import uk from "./i18n/uk.json";
import zhCn from "./i18n/zh-cn.json";

const DICTIONARIES: Record<string, Record<string, string>> = { en, de, ru, pt, nl, fr, it, es, pl, uk, "zh-cn": zhCn };

let current = "en";

/**
 * Sets the language; unknown languages fall back to English.
 *
 * @param lang - ioBroker language code
 */
export function setLanguage(lang: string | undefined): void {
	current = lang && DICTIONARIES[lang] ? lang : "en";
	document.documentElement.lang = current;
}

/**
 * Translates a key into the current language, replacing {name} placeholders.
 *
 * @param key - dictionary key
 * @param params - placeholder values
 */
export function t(key: string, params?: Record<string, string | number>): string {
	const text = DICTIONARIES[current]?.[key] ?? DICTIONARIES.en[key] ?? key;
	return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}
