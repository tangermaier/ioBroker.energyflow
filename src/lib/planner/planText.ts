/**
 * Pure helpers turning planner results into dashboard text and into the slot inputs the
 * optimizer needs - kept ioBroker-free for unit testing.
 */

import { fmtDay, fmtNum, fmtTime, t } from "../i18n/i18n.js";
import type { FlexWindow, PlanMode, PlanSlot } from "./optimizer.js";

/**
 * Display label of a plan mode in the current language.
 *
 * @param mode - the plan mode
 */
export function modeLabel(mode: PlanMode): string {
	switch (mode) {
		case "chargeFromGrid":
			return t("Charge battery from grid");
		case "holdBattery":
			return t("Hold battery");
		case "exportFirst":
			return t("Export before charging");
		default:
			return t("Self-consumption");
	}
}

const MS_PER_HOUR = 3600 * 1000;

/**
 * Formats a point in time relative to `now` in the current language: "today 12:15",
 * "tomorrow 03:00", or "Sat, 11/01 12:15" further out - the date is always explicit once it's not today (live-test finding 2026-09-08).
 *
 * @param ts - the point in time (ms)
 * @param now - current time (ms)
 */
export function formatWhen(ts: number, now: number): string {
	const time = fmtTime(ts);
	const dayStart = (x: number): number => {
		const y = new Date(x);
		y.setHours(0, 0, 0, 0);
		return y.getTime();
	};
	const days = Math.round((dayStart(ts) - dayStart(now)) / (24 * MS_PER_HOUR));
	if (days === 0) {
		return t("today {time}", { time });
	}
	if (days === 1) {
		return t("tomorrow {time}", { time });
	}
	return `${fmtDay(ts)} ${time}`;
}

/**
 * Display label of a flexible-load window's main energy source.
 *
 * @param source - the source kind
 */
function sourceLabel(source: FlexWindow["mainSource"]): string {
	return source === "pv" ? t("PV surplus") : source === "battery" ? t("battery") : t("grid");
}

/**
 * The dashboard recommendation sentence built from the plan.
 *
 * @param params - the inputs
 * @param params.current - the plan's current slot
 * @param params.flex - the cheapest flexible-load window, if any
 * @param params.flexDurationH - configured flexible-load duration
 * @param params.flexPowerKW - configured flexible-load power
 * @param params.expectedSavingsCt - plan vs. pure self-consumption, in ct
 * @param params.now - current time (ms)
 */
export function buildPlanText(params: {
	current: PlanSlot;
	flex: FlexWindow | undefined;
	flexDurationH: number;
	flexPowerKW: number;
	expectedSavingsCt: number;
	now: number;
}): string {
	const { current, flex, flexDurationH, flexPowerKW, expectedSavingsCt, now } = params;
	const parts: string[] = [
		t("Now: {mode} – {reason} (electricity {price} ct/kWh).", { mode: modeLabel(current.mode), reason: current.reason, price: fmtNum(current.priceCt, 1) }),
	];
	if (flex) {
		parts.push(
			t("Cheapest start for the flexible load ({hours} h, {kw} kW): {when}, approx. {eur} € (avg. {avg} ct/kWh, {source}).", {
				hours: fmtNum(flexDurationH, flexDurationH % 1 ? 2 : 0),
				kw: fmtNum(flexPowerKW, flexPowerKW % 1 ? 1 : 0),
				when: formatWhen(flex.startTs, now),
				eur: fmtNum(flex.costCt / 100, 2),
				avg: fmtNum(flex.avgCtPerKWh, 1),
				source: sourceLabel(flex.mainSource),
			}),
		);
	}
	if (expectedSavingsCt >= 5) {
		parts.push(t("Expected advantage of the plan over pure self-consumption: {eur} €.", { eur: fmtNum(expectedSavingsCt / 100, 2) }));
	}
	return parts.join(" ");
}

/**
 * PV power at a point in time from an hourly forecast series whose points are means over the
 * PRECEDING hour (Open-Meteo convention) - linearly interpolated between the hour centers.
 * Outside the series: 0 (no forecast = no production assumed).
 *
 * @param points - hourly forecast points, sorted
 * @param ts - point in time (ms)
 */
export function pvAt(points: Array<{ ts: number; powerW: number }>, ts: number): number {
	if (points.length === 0) {
		return 0;
	}
	const centers = points.map(p => ({ t: p.ts - MS_PER_HOUR / 2, v: p.powerW }));
	if (ts < centers[0].t - MS_PER_HOUR / 2 || ts > centers[centers.length - 1].t + MS_PER_HOUR / 2) {
		return 0;
	}
	if (ts <= centers[0].t) {
		return centers[0].v;
	}
	for (let i = 0; i < centers.length - 1; i++) {
		const a = centers[i];
		const b = centers[i + 1];
		if (ts >= a.t && ts <= b.t) {
			const f = (ts - a.t) / (b.t - a.t);
			return Math.max(0, a.v * (1 - f) + b.v * f);
		}
	}
	return centers[centers.length - 1].v;
}

/**
 * Compact serialization of the plan for the `plan.json` state / widgets (rounded numbers).
 *
 * @param slots - plan slots
 */
export function serializePlan(slots: PlanSlot[]): string {
	const r = (v: number, d = 1): number => Math.round(v * 10 ** d) / 10 ** d;
	return JSON.stringify(
		slots.map(s => ({
			start: s.startTs,
			end: s.endTs,
			mode: s.mode,
			soc: r(s.socEndPercent),
			price: r(s.priceCt, 2),
			feedIn: r(s.feedInCt, 2),
			level: s.level,
			pv: Math.round(s.pvW),
			load: Math.round(s.loadW),
			grid: Math.round(s.gridW),
			battery: Math.round(s.batteryW),
			curtailed: Math.round(s.curtailedW),
			marginal: r(s.marginalCostCt, 2),
			reason: s.reason,
		})),
	);
}
