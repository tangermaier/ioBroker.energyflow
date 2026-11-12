import { num, syncLanguage, tr } from "./lib/i18n";
import React from "react";

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetState } from "@iobroker/types-vis-2";
import type VisRxWidget from "@iobroker/types-vis-2/visRxWidget";
import Card from "@mui/material/Card";

import { weatherLayers, type WeatherCondition } from "./lib/weather";
import { nearestPointByTs } from "./lib/timeSeries";
import { formatPower } from "./lib/format";
import { ALL_LAYERS } from "./lib/EnergyPlanChart";
import { EnergyPlanDialog } from "./lib/EnergyPlanDialog";
import { de, levelLabel, MODE_STYLE, modeLabel, parsePlan } from "./lib/plan";

interface SolarCockpitForecastRxData {
	oidForecastToday: string;
	oidForecastTomorrow: string;
	oidForecastSeries: string;
	oidRecommendation: string;
	oidWeatherTemperature: string;
	oidWeatherCloudCover: string;
	oidWeatherPrecipitation: string;
	oidWeatherSnowfall: string;
	oidWeatherCode: string;
	oidWeatherSeries: string;
	oidProducerActualSeries: string;
	oidColorForecast: string;
	oidColorActual: string;
	oidPlan: string;
	oidPlanStatus: string;
	oidFlexStart: string;
	oidFlexEnd: string;
}

interface ForecastSeriesPoint {
	ts: number;
	powerW: number;
}

interface WeatherSeriesPoint {
	ts: number;
	temperatureC: number;
	cloudCoverPct: number;
	precipitationMm: number;
	snowfallCm: number;
	weatherCode: number;
}

/**
 * Parses the forecast series state's JSON string value (see ForecastManager) into points,
 * tolerating an unset/invalid value instead of throwing (the OID may not be configured, or the
 * state may not have been written yet on a freshly started adapter).
 *
 * @param raw - the raw state value, expected to be a JSON string of {ts, powerW} objects
 */
function parseForecastSeries(raw: unknown): ForecastSeriesPoint[] {
	if (typeof raw !== "string" || !raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter((p): p is ForecastSeriesPoint => typeof p === "object" && p !== null && typeof p.ts === "number" && typeof p.powerW === "number");
	} catch {
		return [];
	}
}

/**
 * Parses the weather series state's JSON string value into points, tolerating an unset/invalid
 * value the same way parseForecastSeries does.
 *
 * @param raw - the raw state value, expected to be a JSON string of WeatherSeriesPoint objects
 */
function parseWeatherSeries(raw: unknown): WeatherSeriesPoint[] {
	if (typeof raw !== "string" || !raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			return [];
		}
		return parsed.filter(
			(p): p is WeatherSeriesPoint => typeof p === "object" && p !== null && typeof p.ts === "number" && typeof p.cloudCoverPct === "number",
		);
	} catch {
		return [];
	}
}

/**
 * Formats a scrubbed timeline position as "<day> HH:00" in German, using relative day names for
 * the next/previous couple of days (matching the "Heute"/"Morgen" wording already used for the
 * forecast totals) and falling back to a day count further out in either direction.
 *
 * @param date - the scrubbed instant to format
 */
function formatScrubLabel(date: Date): string {
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const target = new Date(date);
	target.setHours(0, 0, 0, 0);
	const dayOffset = Math.round((target.getTime() - today.getTime()) / 86400000);
	const dayLabel =
		dayOffset === 0
			? tr("solarcockpit_rt_today")
			: dayOffset === 1
				? tr("solarcockpit_rt_tomorrow")
				: dayOffset === 2
					? tr("solarcockpit_rt_day_after_tomorrow")
					: dayOffset === -1
						? tr("solarcockpit_rt_yesterday")
						: dayOffset === -2
							? tr("solarcockpit_rt_day_before_yesterday")
							: dayOffset > 0
								? tr("solarcockpit_rt_in_days", { n: dayOffset })
								: tr("solarcockpit_rt_days_ago", { n: -dayOffset });
	return `${dayLabel} ${date.getHours().toString().padStart(2, "0")}:00`;
}

/** Layout box for the forecast sparkline, the sole SVG content of this widget. */
const FORECAST_BOX = { x: 20, y: 12, width: 260, height: 56 };
/** How many hours of the forecast series to show before "now", for the timeline scrubback and the forecast-vs-actual comparison. */
const WINDOW_HOURS_BACK = 48;
/** How many hours of the forecast series to show after "now". */
const WINDOW_HOURS_FORWARD = 48;

/**
 * Renders the yield forecast (the summary.producer.forecastPower JSON series) as a small filled
 * area sparkline centered on "now", so the widget gives an at-a-glance sense of "how much sun is
 * coming" (and, for the last day or two, "how much sun came"). When actual production history is
 * bound (`actualSeries`), it is drawn as a second solid line over the same past window, so the
 * forecast and what really happened can be compared at a glance. An optional `markerTs` (the
 * scrub position) draws a dashed drop-line + bead on the forecast curve at that point.
 * Deliberately just a sparkline - the full interactive timeline lives in the standalone 2.5D
 * scene (src-scene), reachable via the separate SolarCockpitYieldWidget's clickable hub.
 *
 * @param props
 * @param props.series
 * @param props.actualSeries
 * @param props.markerTs
 * @param props.colorForecast
 * @param props.colorActual
 */
function ForecastSparkline(props: {
	series: ForecastSeriesPoint[];
	actualSeries?: ForecastSeriesPoint[];
	markerTs?: number;
	colorForecast?: string;
	colorActual?: string;
}): React.JSX.Element | null {
	const { series, actualSeries = [], markerTs, colorForecast = "#ffb703", colorActual = "#2a9d8f" } = props;
	if (series.length < 2) {
		return null;
	}

	const { x, y, width, height } = FORECAST_BOX;
	const firstTs = series[0].ts;
	const lastTs = series[series.length - 1].ts;
	// Time-proportional x, not index-based - actualSeries isn't guaranteed to share the forecast's
	// exact hourly grid (a gap in InfluxDB history shouldn't misalign it against the forecast line).
	const xForTs = (ts: number): number => (lastTs > firstTs ? x + ((ts - firstTs) / (lastTs - firstTs)) * width : x);
	const visibleActual = actualSeries.filter(p => p.ts >= firstTs && p.ts <= lastTs);
	const maxPower = Math.max(...series.map(p => p.powerW), ...visibleActual.map(p => p.powerW), 1);
	const yForPower = (watts: number): number => y + height - (watts / maxPower) * height;

	const coords = series.map(p => [xForTs(p.ts), yForPower(p.powerW)] as const);
	const linePath = coords.map(([px, py], i) => `${i === 0 ? "M" : "L"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
	const areaPath = `${linePath} L ${(x + width).toFixed(1)} ${(y + height).toFixed(1)} L ${x.toFixed(1)} ${(y + height).toFixed(1)} Z`;

	const actualLinePath =
		visibleActual.length >= 2
			? visibleActual.map((p, i) => `${i === 0 ? "M" : "L"} ${xForTs(p.ts).toFixed(1)} ${yForPower(p.powerW).toFixed(1)}`).join(" ")
			: undefined;

	// The timeline scrubber's current position, projected onto the forecast curve by time (not
	// index) - points are hourly but this stays correct even if a gap ever appears in the series.
	const marker = markerTs !== undefined && lastTs > firstTs ? nearestPointByTs(series, markerTs) : undefined;
	const markerX = marker ? xForTs(markerTs!) : undefined;
	const markerY = marker ? yForPower(marker.powerW) : undefined;

	return (
		<g>
			<path
				d={areaPath}
				fill={colorForecast}
				opacity={0.18}
			/>
			<path
				d={linePath}
				fill="none"
				stroke={colorForecast}
				strokeWidth={1.5}
			/>
			{actualLinePath && (
				<path
					d={actualLinePath}
					fill="none"
					stroke={colorActual}
					strokeWidth={1.5}
				/>
			)}
			{markerX !== undefined && markerY !== undefined && (
				<g>
					<line
						x1={markerX}
						y1={y}
						x2={markerX}
						y2={y + height}
						stroke="var(--solarcockpit-value, #102027)"
						strokeWidth={1}
						strokeDasharray="2 2"
						opacity={0.6}
					/>
					<circle
						cx={markerX}
						cy={markerY}
						r={3}
						fill="var(--solarcockpit-value, #102027)"
					/>
				</g>
			)}
		</g>
	);
}

/**
 * A small pixel-art weather glyph (cloud + condition-specific accents, nothing for "clear")
 * shown next to the forecast caption when a weather state is bound. Ported from the standalone
 * scene's identical icon (see src-scene/src/main.ts's overlay), kept deliberately simple for a
 * compact card widget.
 *
 * @param props - placement and the condition to draw
 * @param props.condition - which weather condition to render an icon for
 * @param props.x - left edge of the icon
 * @param props.y - top edge of the icon
 */
function WeatherIcon(props: { condition: WeatherCondition; x: number; y: number }): React.JSX.Element | null {
	const { condition, x, y } = props;
	if (condition === "clear") {
		return null;
	}

	const cloudOpacity = condition === "overcast" ? 0.85 : condition === "partly-cloudy" ? 0.5 : 0.65;
	const cloud = (
		<g
			fill="var(--solarcockpit-label, #8892a0)"
			opacity={cloudOpacity}
		>
			<circle
				cx={x + 3}
				cy={y - 4}
				r={2.2}
			/>
			<circle
				cx={x + 6}
				cy={y - 6}
				r={2.8}
			/>
			<circle
				cx={x + 9}
				cy={y - 4}
				r={2.2}
			/>
			<rect
				x={x + 1}
				y={y - 5}
				width={10}
				height={3}
				rx={1.5}
			/>
		</g>
	);

	return (
		<g>
			{cloud}
			{condition === "rain" && (
				<g
					stroke="#8ecae6"
					strokeWidth={1.2}
					strokeLinecap="round"
				>
					<line
						x1={x + 3}
						y1={y - 1}
						x2={x + 2.3}
						y2={y + 1.5}
					/>
					<line
						x1={x + 6}
						y1={y - 1}
						x2={x + 5.3}
						y2={y + 1.5}
					/>
					<line
						x1={x + 9}
						y1={y - 1}
						x2={x + 8.3}
						y2={y + 1.5}
					/>
				</g>
			)}
			{condition === "snow" && (
				<g
					fill="#ffffff"
					opacity={0.9}
				>
					<circle
						cx={x + 3}
						cy={y + 0.5}
						r={0.9}
					/>
					<circle
						cx={x + 6}
						cy={y + 1.5}
						r={0.9}
					/>
					<circle
						cx={x + 9}
						cy={y + 0.5}
						r={0.9}
					/>
				</g>
			)}
			{condition === "storm" && (
				<path
					d={`M ${x + 7} ${y - 2} L ${x + 5} ${y + 1.5} L ${x + 6.5} ${y + 1.5} L ${x + 5.5} ${y + 4} L ${x + 9} ${y} L ${x + 7.2} ${y} Z`}
					fill="#ffb703"
				/>
			)}
		</g>
	);
}

/**
 * Compact forecast-at-a-glance card: yield sparkline, current weather, recommendation text and
 * a timeline scrub slider. The live four-node flow diagram used to live in this same widget, but
 * was split out into its own SolarCockpitYieldWidget so the two concerns can be placed on a
 * dashboard independently - see that file for the diagram + the 2.5D scene's entry point.
 *
 * By minimal implementation of a vis-2 widget, only getWidgetInfo (static + instance) and
 * renderWidgetBody are required. See DemoWidget in ioBroker.vis-2-widgets-react-template for
 * the annotated reference this is based on.
 */
export default class SolarCockpitForecastWidget extends (window.visRxWidget as typeof VisRxWidget)<SolarCockpitForecastRxData, VisRxWidgetState> {
	static adapter: string;

	/**
	 * Timeline scrubback position, in hours from now (0 = live). Deliberately a plain class field
	 * with forceUpdate rather than typed component state - it is pure ephemeral UI state (not
	 * persisted, not part of rxData/values), so extending the base widget's typed state shape for
	 * it would be more machinery than the one number needs.
	 */
	private scrubHours = 0;

	private readonly handleScrubChange = (event: React.ChangeEvent<HTMLInputElement>): void => {
		this.scrubHours = Number(event.target.value);
		this.forceUpdate();
	};

	/** Whether the energy-plan fullscreen dialog is open (ephemeral UI state, see scrubHours). */
	private planOpen = false;

	private readonly openPlan = (): void => {
		if (!this.props.editMode) {
			this.planOpen = true;
			this.forceUpdate();
		}
	};

	private readonly closePlan = (): void => {
		this.planOpen = false;
		this.forceUpdate();
	};

	private readonly openScene = (): void => {
		if (!this.props.editMode) {
			window.location.hash = "SolarCockpit3D";
		}
	};

	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplSolarCockpitForecast",
			visSet: "solarcockpit",
			visSetLabel: "set_label",
			visSetColor: "#ff9800",
			visName: "SolarCockpitForecastWidget",
			visWidgetLabel: "widget_label_forecast",
			visAttrs: [
				{
					name: "forecast",
					label: "solarcockpit_group_forecast",
					fields: [
						{
							name: "oidForecastToday",
							type: "id",
							label: "solarcockpit_oid_forecast_today",
							default: "solarcockpit.0.summary.producer.forecastToday",
						},
						{
							name: "oidForecastTomorrow",
							type: "id",
							label: "solarcockpit_oid_forecast_tomorrow",
							default: "solarcockpit.0.summary.producer.forecastTomorrow",
						},
						{
							name: "oidForecastSeries",
							type: "id",
							label: "solarcockpit_oid_forecast_series",
							default: "solarcockpit.0.summary.producer.forecastPower",
						},
						{
							name: "oidProducerActualSeries",
							type: "id",
							label: "solarcockpit_oid_producer_actual_series",
							default: "solarcockpit.0.summary.producer.actualPower",
						},
						{
							name: "oidColorForecast",
							type: "id",
							label: "solarcockpit_oid_color_forecast",
							default: "solarcockpit.0.summary.settings.colorForecast",
						},
						{ name: "oidColorActual", type: "id", label: "solarcockpit_oid_color_actual", default: "solarcockpit.0.summary.settings.colorActual" },
					],
				},
				{
					name: "recommendation",
					label: "solarcockpit_group_recommendation",
					fields: [
						{ name: "oidRecommendation", type: "id", label: "solarcockpit_oid_recommendation", default: "solarcockpit.0.recommendation.text" },
					],
				},
				{
					name: "plan",
					label: "solarcockpit_group_plan_optional",
					fields: [
						{ name: "oidPlan", type: "id", label: "solarcockpit_oid_plan", default: "solarcockpit.0.plan.json" },
						{ name: "oidPlanStatus", type: "id", label: "solarcockpit_oid_plan_status", default: "solarcockpit.0.plan.status" },
						{ name: "oidFlexStart", type: "id", label: "solarcockpit_oid_flex_start", default: "solarcockpit.0.recommendation.flexWindowStart" },
						{ name: "oidFlexEnd", type: "id", label: "solarcockpit_oid_flex_end", default: "solarcockpit.0.recommendation.flexWindowEnd" },
					],
				},
				{
					name: "weather",
					label: "solarcockpit_group_weather",
					fields: [
						{
							name: "oidWeatherTemperature",
							type: "id",
							label: "solarcockpit_oid_weather_temperature",
							default: "solarcockpit.0.summary.weather.temperature",
						},
						{
							name: "oidWeatherCloudCover",
							type: "id",
							label: "solarcockpit_oid_weather_cloud_cover",
							default: "solarcockpit.0.summary.weather.cloudCoverPct",
						},
						{
							name: "oidWeatherPrecipitation",
							type: "id",
							label: "solarcockpit_oid_weather_precipitation",
							default: "solarcockpit.0.summary.weather.precipitationMm",
						},
						{
							name: "oidWeatherSnowfall",
							type: "id",
							label: "solarcockpit_oid_weather_snowfall",
							default: "solarcockpit.0.summary.weather.snowfallCm",
						},
						{ name: "oidWeatherCode", type: "id", label: "solarcockpit_oid_weather_code", default: "solarcockpit.0.summary.weather.weatherCode" },
						{
							name: "oidWeatherSeries",
							type: "id",
							label: "solarcockpit_oid_weather_series",
							default: "solarcockpit.0.summary.weather.forecastSeries",
						},
					],
				},
			],
			visPrev: "widgets/solarcockpit/img/vis-solarcockpit-forecast.png",
		};
	}

	/** vis-2 widget metadata (editor attributes and preview) */
	getWidgetInfo(): RxWidgetInfo {
		return SolarCockpitForecastWidget.getWidgetInfo();
	}

	static getI18nPrefix(): string {
		return `${SolarCockpitForecastWidget.adapter}_`;
	}

	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
		super.renderWidgetBody(props);
		syncLanguage(this.props.context);

		const {
			oidForecastToday,
			oidForecastTomorrow,
			oidForecastSeries,
			oidProducerActualSeries,
			oidColorForecast,
			oidColorActual,
			oidRecommendation,
			oidWeatherTemperature,
			oidWeatherCloudCover,
			oidWeatherPrecipitation,
			oidWeatherSnowfall,
			oidWeatherCode,
			oidWeatherSeries,
			oidPlan,
			oidPlanStatus,
			oidFlexStart,
			oidFlexEnd,
		} = this.state.rxData;

		const valueOf = (oid: string): number => {
			const raw = this.state.values[`${oid}.val`];
			return typeof raw === "number" ? raw : 0;
		};

		const forecastToday = oidForecastToday ? valueOf(oidForecastToday) : undefined;
		const forecastTomorrow = oidForecastTomorrow ? valueOf(oidForecastTomorrow) : undefined;
		const forecastSeries = oidForecastSeries ? parseForecastSeries(this.state.values[`${oidForecastSeries}.val`]) : [];
		const hasForecast = forecastToday !== undefined || forecastTomorrow !== undefined || forecastSeries.length > 0;
		const actualSeries = oidProducerActualSeries ? parseForecastSeries(this.state.values[`${oidProducerActualSeries}.val`]) : [];
		const colorForecast = oidColorForecast ? this.state.values[`${oidColorForecast}.val`] : undefined;
		const colorActual = oidColorActual ? this.state.values[`${oidColorActual}.val`] : undefined;

		const recommendationText = oidRecommendation ? this.state.values[`${oidRecommendation}.val`] : undefined;
		const hasRecommendation = typeof recommendationText === "string" && recommendationText.length > 0;

		const planSlots = oidPlan ? parsePlan(this.state.values[`${oidPlan}.val`]) : [];
		const planNow = Date.now();
		const currentPlanSlot = planSlots.find(s => s.start <= planNow && planNow < s.end) ?? planSlots[0];
		const planStatus = oidPlanStatus ? this.state.values[`${oidPlanStatus}.val`] : undefined;
		const flexStartRaw = oidFlexStart ? this.state.values[`${oidFlexStart}.val`] : undefined;
		const flexEndRaw = oidFlexEnd ? this.state.values[`${oidFlexEnd}.val`] : undefined;

		const hasWeather = Boolean(oidWeatherCloudCover) && typeof this.state.values[`${oidWeatherCloudCover}.val`] === "number";
		const liveWeather = hasWeather
			? {
					temperature: oidWeatherTemperature ? valueOf(oidWeatherTemperature) : 0,
					cloudCoverPct: valueOf(oidWeatherCloudCover),
					precipitationMm: oidWeatherPrecipitation ? valueOf(oidWeatherPrecipitation) : 0,
					snowfallCm: oidWeatherSnowfall ? valueOf(oidWeatherSnowfall) : 0,
					weatherCode: oidWeatherCode ? valueOf(oidWeatherCode) : 0,
				}
			: undefined;
		const weatherSeries = oidWeatherSeries ? parseWeatherSeries(this.state.values[`${oidWeatherSeries}.val`]) : [];

		// Timeline scrubback: lets the user drag through the forecast horizon (both ways - a day or
		// two into the past to compare against actual production, or ahead to see what's coming) to
		// see the forecast curve/weather at that hour, not just "now". The range caps at the first/
		// last point the sparkline actually draws (visibleForecast) so the marker on the sparkline is
		// always reachable.
		const nowMs = Date.now();
		const windowStartMs = nowMs - WINDOW_HOURS_BACK * 3600000;
		const windowEndMs = nowMs + WINDOW_HOURS_FORWARD * 3600000;
		const visibleForecast = forecastSeries.filter(p => p.ts >= windowStartMs && p.ts <= windowEndMs);
		const minScrubHours = visibleForecast.length > 0 ? Math.min(0, Math.floor((visibleForecast[0].ts - nowMs) / 3600000)) : -WINDOW_HOURS_BACK;
		const maxScrubHours =
			visibleForecast.length > 0 ? Math.max(0, Math.round((visibleForecast[visibleForecast.length - 1].ts - nowMs) / 3600000)) : WINDOW_HOURS_FORWARD;
		const effectiveScrubHours = Math.min(Math.max(minScrubHours, this.scrubHours), maxScrubHours);
		const isScrubbing = effectiveScrubHours !== 0;
		const scrubDate = isScrubbing ? new Date(nowMs + effectiveScrubHours * 3600000) : new Date();
		const scrubLabel = isScrubbing ? formatScrubLabel(scrubDate) : undefined;

		const scrubbedWeatherPoint = isScrubbing ? nearestPointByTs(weatherSeries, scrubDate.getTime()) : undefined;
		const effectiveWeather = isScrubbing
			? scrubbedWeatherPoint && {
					temperature: scrubbedWeatherPoint.temperatureC,
					cloudCoverPct: scrubbedWeatherPoint.cloudCoverPct,
					precipitationMm: scrubbedWeatherPoint.precipitationMm,
					snowfallCm: scrubbedWeatherPoint.snowfallCm,
					weatherCode: scrubbedWeatherPoint.weatherCode,
				}
			: liveWeather;
		const weatherLayer = effectiveWeather
			? weatherLayers({
					...effectiveWeather,
					// The widget no longer renders its own sun position (that moved to the 2.5D scene,
					// see the hub icon's link) - sunAltitudeDeg only feeds weatherLayers' sun-glow
					// strength, which nothing here reads, so a fixed daytime value is fine.
					sunAltitudeDeg: 45,
				})
			: undefined;
		const weatherTemperature = effectiveWeather?.temperature;

		// Scrubbed into the past with actual production history for that hour: show a forecast-vs-
		// actual comparison instead of the today/tomorrow totals (which describe "now", not the
		// scrubbed hour). Scrubbing forward keeps the existing totals - there is no "actual" for the
		// future.
		const scrubbedActual = isScrubbing && effectiveScrubHours < 0 ? nearestPointByTs(actualSeries, scrubDate.getTime()) : undefined;
		const scrubbedForecast = scrubbedActual ? nearestPointByTs(visibleForecast, scrubDate.getTime()) : undefined;

		const showForecastRow = hasForecast || hasWeather;

		if (!showForecastRow && !hasRecommendation && !currentPlanSlot) {
			return (
				<Card sx={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", p: 2, boxSizing: "border-box" }}>
					<span style={{ opacity: 0.6, textAlign: "center", fontSize: 12 }}>
						Bitte in den Widget-Einstellungen Prognose-, Wetter- oder Empfehlungs-States verknüpfen.
					</span>
				</Card>
			);
		}

		return (
			<Card
				sx={{
					width: "100%",
					height: "100%",
					display: "flex",
					flexDirection: "column",
					alignItems: "center",
					justifyContent: "center",
					gap: 0.5,
					p: 1,
					boxSizing: "border-box",
				}}
				elevation={2}
			>
				{showForecastRow && (
					<svg
						viewBox="0 0 300 80"
						style={{ width: "100%", maxWidth: 420, maxHeight: 112, cursor: this.props.editMode ? "default" : "pointer" }}
						onClick={this.openScene}
					>
						<title>{tr("solarcockpit_rt_open_3d")}</title>
						<ForecastSparkline
							series={visibleForecast}
							actualSeries={actualSeries}
							markerTs={scrubDate.getTime()}
							colorForecast={colorForecast}
							colorActual={colorActual}
						/>
						{weatherLayer && (
							<WeatherIcon
								condition={weatherLayer.condition}
								x={FORECAST_BOX.x}
								y={FORECAST_BOX.y - 6}
							/>
						)}
						<text
							x={weatherLayer && weatherLayer.condition !== "clear" ? FORECAST_BOX.x + 14 : FORECAST_BOX.x}
							y={FORECAST_BOX.y - 6}
							fontSize={10}
							fill="var(--solarcockpit-label, #37474f)"
						>
							{weatherLayer
								? `${weatherLayer.label}${weatherTemperature !== undefined ? ` · ${weatherTemperature.toFixed(0)}°C` : ""}`
								: tr("solarcockpit_rt_forecast")}
						</text>
						{scrubbedActual ? (
							<text
								x={FORECAST_BOX.x + FORECAST_BOX.width}
								y={FORECAST_BOX.y - 6}
								textAnchor="end"
								fontSize={10}
								fill="var(--solarcockpit-value, #102027)"
							>
								{tr("solarcockpit_rt_forecast_vs_actual", {
									forecast: formatPower(scrubbedForecast?.powerW ?? 0),
									actual: formatPower(scrubbedActual.powerW),
								})}
							</text>
						) : (
							forecastToday !== undefined && (
								<text
									x={FORECAST_BOX.x + FORECAST_BOX.width}
									y={FORECAST_BOX.y - 6}
									textAnchor="end"
									fontSize={10}
									fill="var(--solarcockpit-value, #102027)"
								>
									{tr("solarcockpit_rt_today_kwh", { kwh: num(forecastToday, 1) })}
									{forecastTomorrow !== undefined ? ` · ${tr("solarcockpit_rt_tomorrow_kwh", { kwh: num(forecastTomorrow, 1) })}` : ""}
								</text>
							)
						)}
					</svg>
				)}
				{showForecastRow && (
					<div style={{ width: "100%", maxWidth: 420, padding: "0 10px", boxSizing: "border-box", display: "flex", alignItems: "center", gap: 8 }}>
						<input
							type="range"
							min={minScrubHours}
							max={maxScrubHours}
							step={1}
							value={effectiveScrubHours}
							onChange={this.handleScrubChange}
							style={{ flex: 1 }}
						/>
						<span style={{ fontSize: 10, color: "var(--solarcockpit-label, #37474f)", minWidth: 82, textAlign: "right" }}>
							{scrubLabel ?? tr("solarcockpit_rt_now")}
						</span>
					</div>
				)}
				{currentPlanSlot && (
					<button
						type="button"
						onClick={this.openPlan}
						title={tr("solarcockpit_rt_open_plan")}
						style={{
							width: "100%",
							maxWidth: 420,
							display: "flex",
							justifyContent: "space-between",
							gap: 8,
							padding: "3px 10px",
							fontSize: 11,
							border: "1px solid rgba(128,128,128,0.35)",
							borderRadius: 6,
							background: "transparent",
							color: "var(--solarcockpit-label, #37474f)",
							cursor: this.props.editMode ? "default" : "pointer",
						}}
					>
						<span>
							<span style={{ color: MODE_STYLE[currentPlanSlot.mode].color }}>■</span> {modeLabel(currentPlanSlot.mode)}
						</span>
						<span>
							{de(currentPlanSlot.price, 1)} ct/kWh
							{currentPlanSlot.level ? ` · ${levelLabel(currentPlanSlot.level)}` : ""} ›
						</span>
					</button>
				)}
				{hasRecommendation && (
					<div
						style={{
							width: "100%",
							maxWidth: 420,
							padding: "4px 10px",
							fontSize: 11,
							lineHeight: 1.4,
							textAlign: "center",
							color: "var(--solarcockpit-label, #37474f)",
							boxSizing: "border-box",
						}}
					>
						{recommendationText}
					</div>
				)}
				{this.planOpen && (
					<EnergyPlanDialog
						open
						onClose={this.closePlan}
						slots={planSlots}
						initialLayers={ALL_LAYERS}
						flexStart={typeof flexStartRaw === "number" ? flexStartRaw : undefined}
						flexEnd={typeof flexEndRaw === "number" ? flexEndRaw : undefined}
						text={hasRecommendation ? recommendationText : undefined}
						status={typeof planStatus === "string" ? planStatus : undefined}
					/>
				)}
			</Card>
		);
	}
}
