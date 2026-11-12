/**
 * Parsing and display helpers for the adapter's `plan.json` state (see
 * src/lib/planner/planText.ts serializePlan on the adapter side - keep both in sync).
 */

import { dayLabel, num, tr } from "./i18n";

export type PlanMode = "selfConsumption" | "chargeFromGrid" | "holdBattery" | "exportFirst";

/** One slot of the advisory energy plan as serialized by the adapter. */
export interface PlanSlot {
	/** Slot start (ms) */
	start: number;
	/** Slot end (ms) */
	end: number;
	/** Planned mode */
	mode: PlanMode;
	/** Planned SoC at the slot end (%) */
	soc: number;
	/** Gross purchase price (ct/kWh) */
	price: number;
	/** Feed-in remuneration (ct/kWh) */
	feedIn: number;
	/** Tibber price level */
	level: string;
	/** Forecast PV power (W) */
	pv: number;
	/** Forecast household load (W) */
	load: number;
	/** Grid exchange (W, + import / - export) */
	grid: number;
	/** Battery AC power (W, + charging) */
	battery: number;
	/** Curtailed PV (W) */
	curtailed: number;
	/** Cost of one more kWh consumed (ct/kWh) */
	marginal: number;
	/** Explanation (written by the adapter in the ioBroker system language) */
	reason: string;
}

const MODES: PlanMode[] = ["selfConsumption", "chargeFromGrid", "holdBattery", "exportFirst"];

/** Color per mode. */
export const MODE_STYLE: Record<PlanMode, { color: string }> = {
	selfConsumption: { color: "#90a4ae" },
	chargeFromGrid: { color: "#e63946" },
	holdBattery: { color: "#8e7dbe" },
	exportFirst: { color: "#ffb703" },
};

/**
 * Display label of a plan mode (current language).
 *
 * @param mode - plan mode
 */
export function modeLabel(mode: PlanMode): string {
	return tr(`solarcockpit_rt_mode_${mode}`);
}

const LEVELS = ["VERY_CHEAP", "CHEAP", "NORMAL", "EXPENSIVE", "VERY_EXPENSIVE"];

/**
 * Display label of a Tibber price level (current language); unknown levels are shown as-is.
 *
 * @param level - Tibber level
 */
export function levelLabel(level: string): string {
	return LEVELS.includes(level) ? tr(`solarcockpit_rt_level_${level}`) : level;
}

/**
 * Parses the plan.json state value, tolerating unset/invalid values (returns []).
 *
 * @param raw - the raw state value
 */
export function parsePlan(raw: unknown): PlanSlot[] {
	if (typeof raw !== "string" || !raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter(
			(s): s is PlanSlot =>
				typeof s === "object" &&
				s !== null &&
				typeof s.start === "number" &&
				typeof s.end === "number" &&
				typeof s.price === "number" &&
				MODES.includes(s.mode),
		);
	} catch {
		return [];
	}
}

/**
 * Number with fixed decimals in the current language's format.
 *
 * @param v - value
 * @param decimals - decimals
 */
export function de(v: number, decimals: number): string {
	return num(v, decimals);
}

/**
 * "HH:MM" in local time.
 *
 * @param ts - timestamp (ms)
 */
export function hhmm(ts: number): string {
	const d = new Date(ts);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * "today 12:15" / "tomorrow 03:00" / "Mon, 11/02 12:15" (current language).
 *
 * @param ts - timestamp (ms)
 */
export function relativeTime(ts: number): string {
	const dayStart = (x: number): number => {
		const d = new Date(x);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	};
	const days = Math.round((dayStart(ts) - dayStart(Date.now())) / 86400000);
	if (days === 0) {
		return tr("solarcockpit_rt_today_at", { time: hhmm(ts) });
	}
	if (days === 1) {
		return tr("solarcockpit_rt_tomorrow_at", { time: hhmm(ts) });
	}
	return `${dayLabel(ts)} ${hhmm(ts)}`;
}
