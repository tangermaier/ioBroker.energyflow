/**
 * Turns the producer yield forecast into a consumption/sell recommendation: given a (naive,
 * see computeSurplusSeries) consumption baseline, where is there expected PV surplus worth
 * timing a flexible load to, and what is that worth economically at the currently configured
 * (fixed) prices? Deliberately advisory-only - no write access, no device control (that is a
 * later phase per the project's own autonomy rules).
 */

import { fmtNum, fmtTime, t } from "../i18n/i18n.js";
import type { ForecastPoint } from "../forecast/pvModel.js";

/** One point of the surplus series: forecasted production minus the baseline consumption. */
export interface SurplusPoint {
	/** Absolute Unix timestamp in milliseconds */
	ts: number;
	/** Producer forecast minus baseline consumption, in Watt - negative means a forecasted deficit */
	surplusW: number;
}

/** A contiguous stretch of forecasted surplus above the recommendation threshold. */
export interface SurplusWindow {
	/** Start of the window (inclusive), absolute Unix timestamp in milliseconds */
	startTs: number;
	/** End of the window (exclusive), absolute Unix timestamp in milliseconds */
	endTs: number;
	/** Mean surplus power across the window, in Watt */
	avgSurplusW: number;
	/** Total surplus energy across the window, in kWh */
	totalKWh: number;
}

/** Points per day at the forecast's hourly resolution - used to slice "today"/"tomorrow". */
const HOURS_PER_DAY = 24;

/**
 * Subtracts a baseline consumption from a producer forecast series to get expected surplus
 * (or deficit) per hour. The baseline is deliberately just the current live consumption held
 * constant across the whole horizon - a real consumption forecast is out of scope for now, but
 * this is still a useful, clearly-bounded approximation for "is there roughly going to be more
 * production than the house typically draws".
 *
 * @param forecast - the producer yield forecast series (see ForecastManager)
 * @param baselineConsumptionW - the consumption level to compare against, in Watt
 */
export function computeSurplusSeries(forecast: ForecastPoint[], baselineConsumptionW: number): SurplusPoint[] {
	return forecast.map(p => ({ ts: p.ts, surplusW: p.powerW - baselineConsumptionW }));
}

/**
 * Sums only the positive surplus in a slice of the series into a total kWh figure (each point
 * represents one hour of average power, matching the forecast's hourly resolution) - "how much
 * free energy is expected", ignoring hours with a forecasted deficit.
 *
 * @param points - a surplus series, or a slice of one
 */
export function positiveSurplusKWh(points: SurplusPoint[]): number {
	return points.reduce((sum, p) => sum + Math.max(0, p.surplusW) / 1000, 0);
}

/**
 * Slices a surplus series (assumed to start at the current hour, like the underlying forecast)
 * into today's and tomorrow's points by position rather than calendar date - Open-Meteo's
 * hourly forecast always starts at local midnight of the current day, so the first
 * HOURS_PER_DAY points are today's regardless of what time "now" actually is.
 *
 * @param points - a surplus series starting at today's local midnight
 */
export function splitTodayTomorrow(points: SurplusPoint[]): { today: SurplusPoint[]; tomorrow: SurplusPoint[] } {
	return { today: points.slice(0, HOURS_PER_DAY), tomorrow: points.slice(HOURS_PER_DAY, HOURS_PER_DAY * 2) };
}

/**
 * Finds the most valuable contiguous stretch of forecasted surplus from `now` onward: among
 * all runs where surplus stays above `thresholdW`, the one with the highest total kWh (not
 * necessarily the longest, nor the highest peak) - the window that captures the most usable
 * "free" energy, which is what actually matters for deciding when to run a flexible load.
 *
 * @param points - a surplus series
 * @param now - only consider points at or after this absolute timestamp (ms)
 * @param thresholdW - minimum surplus power for a point to count as part of a window
 */
export function findBestSurplusWindow(points: SurplusPoint[], now: number, thresholdW: number): SurplusWindow | undefined {
	const upcoming = points.filter(p => p.ts >= now);

	let best: SurplusWindow | undefined;
	let runStart = -1;
	for (let i = 0; i <= upcoming.length; i++) {
		const inRun = i < upcoming.length && upcoming[i].surplusW > thresholdW;
		if (inRun && runStart === -1) {
			runStart = i;
		} else if (!inRun && runStart !== -1) {
			const run = upcoming.slice(runStart, i);
			const totalKWh = positiveSurplusKWh(run);
			if (!best || totalKWh > best.totalKWh) {
				best = {
					startTs: run[0].ts,
					endTs: run[run.length - 1].ts,
					avgSurplusW: run.reduce((sum, p) => sum + p.surplusW, 0) / run.length,
					totalKWh,
				};
			}
			runStart = -1;
		}
	}
	return best;
}

/**
 * Assembles a short advisory sentence (current language) from the computed recommendation figures, for
 * direct display on a dashboard.
 *
 * @param params - the computed recommendation figures
 * @param params.nowSurplusW - current surplus/deficit in Watt (positive = exporting)
 * @param params.todaySurplusKWh - total expected surplus energy today, in kWh
 * @param params.bestWindow - the best upcoming surplus window, if any
 * @param params.selfConsumptionValueCtPerKWh - value of self-consuming instead of exporting, in ct/kWh
 */
export function buildRecommendationText(params: {
	nowSurplusW: number;
	todaySurplusKWh: number;
	bestWindow: SurplusWindow | undefined;
	selfConsumptionValueCtPerKWh: number;
}): string {
	const { nowSurplusW, todaySurplusKWh, bestWindow, selfConsumptionValueCtPerKWh } = params;
	const parts: string[] = [];

	if (nowSurplusW > 100) {
		parts.push(t("{kw} kW surplus right now - a good time to run appliances.", { kw: fmtNum(nowSurplusW / 1000, 1) }));
	} else {
		parts.push(t("Currently no significant surplus."));
	}

	if (bestWindow) {
		parts.push(
			t("Best time window: {start}–{end} (avg. {kw} kW, {kwh} kWh).", {
				start: fmtTime(bestWindow.startTs),
				end: fmtTime(bestWindow.endTs),
				kw: fmtNum(bestWindow.avgSurplusW / 1000, 1),
				kwh: fmtNum(bestWindow.totalKWh, 1),
			}),
		);
	}

	if (todaySurplusKWh > 0.1 && selfConsumptionValueCtPerKWh > 0) {
		const valueEur = (todaySurplusKWh * selfConsumptionValueCtPerKWh) / 100;
		parts.push(
			t("About {kwh} kWh surplus expected today in total (~{eur} € advantage from self-consumption instead of export).", {
				kwh: fmtNum(todaySurplusKWh, 1),
				eur: fmtNum(valueEur, 2),
			}),
		);
	}

	return parts.join(" ");
}
