// Lists the translation keys used in the source code of one layer, so translation dictionaries
// can be checked/extended. Usage: node tools/i18n-keys.mjs <backend|widgets|scene>
// The same extraction is used by the i18n completeness test (src/lib/i18n/i18n.test.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Recursively collects source files.
 *
 * @param {string} dir - directory
 * @param {RegExp} include - file name filter
 * @param {string[]} out - result
 */
function walk(dir, include, out = []) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (name === "node_modules" || name === "build") {
			continue;
		}
		if (statSync(p).isDirectory()) {
			walk(p, include, out);
		} else if (include.test(name) && !/\.test\.tsx?$/.test(name)) {
			out.push(p);
		}
	}
	return out;
}

/** Layer -> source root and the call pattern whose first string literal argument is a key. */
export const LAYERS = {
	backend: { root: "src", include: /\.ts$/, call: /\bt(?:All)?\(\s*("(?:[^"\\]|\\.)*")/g },
	// widgets: every "solarcockpit_..." string literal (tr() keys, editor labels) plus visSetLabel/visWidgetLabel (vis-2 adds the prefix)
	widgets: { root: "src-widgets/src", include: /\.tsx?$/, call: /("solarcockpit_[A-Za-z0-9_-]+")/g, extra: /vis(?:Set|Widget)Label: "(\w+)"/g },
	scene: { root: "src-scene/src", include: /\.ts$/, call: /\bt\(\s*("(?:[^"\\]|\\.)*")/g },
};

/**
 * All literal keys of a layer, sorted.
 *
 * @param {keyof typeof LAYERS} layer - layer name
 * @param {string} [base] - repository root
 */
export function extractKeys(layer, base = ".") {
	const { root, include, call, extra } = LAYERS[layer];
	const keys = new Set();
	for (const file of walk(join(base, root), include)) {
		if (/[\\/]i18n[\\/]/.test(file) && !/[\\/]i18n[\\/].*\.tsx?$/.test(file)) {
			continue;
		}
		const src = readFileSync(file, "utf8");
		for (const m of src.matchAll(call)) {
			keys.add(JSON.parse(m[1]));
		}
		for (const m of extra ? src.matchAll(extra) : []) {
			keys.add(`solarcockpit_${m[1]}`);
		}
	}
	return [...keys].sort();
}

if (process.argv[1] && process.argv[1].endsWith("i18n-keys.mjs")) {
	const layer = process.argv[2] || "backend";
	console.log(JSON.stringify(extractKeys(layer), null, 1));
}
