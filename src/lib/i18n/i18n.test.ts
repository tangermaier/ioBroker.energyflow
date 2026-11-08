import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LANGUAGES, fmtNum, setLanguage, t, tAll } from "./i18n.js";
import { translations } from "./translations.js";

/**
 * i18n completeness for all layers: every key in every ioBroker language, same placeholders as
 * the English source, no empty strings. Adding a text without translating it fails here.
 */

const ROOT = join(__dirname, "..", "..", "..");

function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}

function checkDictionaries(layer: string, dicts: Record<string, Record<string, string>>, requiredKeys?: string[]): void {
	const en = dicts.en;
	assert.ok(en, `${layer}: no English dictionary`);
	for (const key of requiredKeys ?? []) {
		assert.ok(key in en, `${layer}: key used in code but missing in en: ${key}`);
	}
	for (const lang of LANGUAGES) {
		const dict = dicts[lang];
		assert.ok(dict, `${layer}: dictionary for ${lang} missing`);
		for (const key of Object.keys(en)) {
			const value = dict[key];
			assert.ok(typeof value === "string" && value.trim() !== "", `${layer}/${lang}: missing or empty "${key}"`);
			assert.deepStrictEqual(placeholders(value), placeholders(en[key]), `${layer}/${lang}: placeholders differ in "${key}"`);
		}
		const extra = Object.keys(dict).filter(k => !(k in en));
		assert.deepStrictEqual(extra, [], `${layer}/${lang}: keys not in en`);
	}
}

function readJsonDicts(dir: string): Record<string, Record<string, string>> {
	const dicts: Record<string, Record<string, string>> = {};
	for (const lang of LANGUAGES) {
		for (const file of [join(dir, lang, "translations.json"), join(dir, `${lang}.json`)]) {
			if (existsSync(file)) {
				dicts[lang] = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
			}
		}
	}
	return dicts;
}

async function codeKeys(layer: "backend" | "widgets" | "scene"): Promise<string[]> {
	const mod = (await import(join(ROOT, "tools", "i18n-keys.mjs"))) as { extractKeys: (layer: string, base: string) => string[] };
	return mod.extractKeys(layer, ROOT);
}

describe("i18n", () => {
	afterEach(() => setLanguage("en"));

	it("backend: every t()/tAll() text is translated into every language", async () => {
		const keys = await codeKeys("backend");
		assert.ok(keys.length > 50, "key extraction found suspiciously few keys");
		const dicts: Record<string, Record<string, string>> = { en: {} };
		for (const key of keys) {
			dicts.en[key] = key;
		}
		for (const lang of LANGUAGES.filter(l => l !== "en")) {
			dicts[lang] = {};
			for (const key of keys) {
				const value = translations[key]?.[lang];
				if (value !== undefined) {
					dicts[lang][key] = value;
				}
			}
		}
		checkDictionaries("backend", dicts);
		const orphans = Object.keys(translations).filter(k => !keys.includes(k));
		assert.deepStrictEqual(orphans, [], "backend: translations no longer used in code");
	});

	it("admin: every jsonConfig text is translated into every language", () => {
		const dicts = readJsonDicts(join(ROOT, "admin", "i18n"));
		const config = readFileSync(join(ROOT, "admin", "jsonConfig.json"), "utf8");
		const used = [...new Set([...config.matchAll(/"((?:LBL|TTIP|HLP|OPT)_\w+)"/g)].map(m => m[1]))];
		checkDictionaries("admin", dicts, used);
	});

	it("widgets: every widget text is translated into every language", async () => {
		const dicts = readJsonDicts(join(ROOT, "src-widgets", "src", "i18n"));
		checkDictionaries("widgets", dicts, await codeKeys("widgets"));
	});

	it("scene: every scene text is translated into every language", async () => {
		const dicts = readJsonDicts(join(ROOT, "src-scene", "src", "i18n"));
		checkDictionaries("scene", dicts, await codeKeys("scene"));
	});

	it("io-package: titleLang, desc and news cover every language", () => {
		const io = JSON.parse(readFileSync(join(ROOT, "io-package.json"), "utf8")) as { common: Record<string, unknown> };
		const blocks: [string, Record<string, string>][] = [
			["titleLang", io.common.titleLang as Record<string, string>],
			["desc", io.common.desc as Record<string, string>],
			...Object.entries(io.common.news as Record<string, Record<string, string>>).map(([v, n]) => [`news ${v}`, n] as [string, Record<string, string>]),
		];
		for (const [name, block] of blocks) {
			for (const lang of LANGUAGES) {
				assert.ok(block[lang]?.trim(), `io-package ${name}: ${lang} missing`);
			}
		}
	});

	describe("runtime", () => {
		it("translates with placeholders and falls back to English for unknown languages", () => {
			setLanguage("de");
			assert.strictEqual(t("today {time}", { time: "12:15" }), "heute 12:15");
			setLanguage("xx");
			assert.strictEqual(t("today {time}", { time: "12:15" }), "today 12:15");
		});

		it("tAll resolves translated parameters per language", () => {
			const name = tAll("{name} (loss)", { name: "PV" });
			const power = tAll("{name} power", { name });
			assert.strictEqual(power.en, "PV (loss) power");
			assert.strictEqual(power.de, "PV (Verlust) Leistung");
		});

		it("formats numbers in the current locale", () => {
			setLanguage("de");
			assert.strictEqual(fmtNum(1234.5, 1), "1234,5");
			setLanguage("en");
			assert.strictEqual(fmtNum(1234.5, 1), "1234.5");
		});
	});
});
