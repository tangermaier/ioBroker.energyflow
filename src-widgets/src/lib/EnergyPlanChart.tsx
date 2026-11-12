import { tr } from "./i18n";
import React from "react";

import { de, hhmm, levelLabel, MODE_STYLE, modeLabel, relativeTime, type PlanSlot } from "./plan";

/** Which layers of the plan chart are drawn. */
export interface PlanLayers {
	/** Price step line (+ feed-in) */
	price: boolean;
	/** PV forecast area + load line */
	pvLoad: boolean;
	/** Planned SoC line */
	soc: boolean;
	/** Mode color band */
	modes: boolean;
	/** Marginal cost line (inside the price band) */
	marginal: boolean;
	/** Recommended flexible-load window */
	flex: boolean;
}

export const ALL_LAYERS: PlanLayers = { price: true, pvLoad: true, soc: true, modes: true, marginal: false, flex: true };

const LAYER_LABELS: Record<keyof PlanLayers, string> = {
	price: "solarcockpit_rt_layer_price",
	pvLoad: "solarcockpit_rt_layer_pvLoad",
	soc: "solarcockpit_rt_layer_soc",
	modes: "solarcockpit_rt_layer_modes",
	marginal: "solarcockpit_rt_layer_marginal",
	flex: "solarcockpit_rt_layer_flex",
};

/** Colors - chosen to stay readable on light and dark vis-2 themes. */
const C = {
	price: "#f4a261",
	feedIn: "#2a9d8f",
	marginal: "#e76f51",
	pv: "#ffb703",
	load: "#8892a0",
	soc: "#06d6a0",
	flex: "#4cc9f0",
	axis: "var(--solarcockpit-label, #8892a0)",
	text: "var(--solarcockpit-label, #37474f)",
	now: "var(--solarcockpit-value, #102027)",
};

interface Props {
	slots: PlanSlot[];
	layers: PlanLayers;
	/** Recommended flexible-load window (ms), if any */
	flexStart?: number;
	flexEnd?: number;
	/** Small tiles: no legend, fewer labels, smaller fonts */
	compact?: boolean;
}

/** Measures a container element's size (ResizeObserver), so the SVG can draw in real pixels. */
function useSize(): [React.RefObject<HTMLDivElement>, { w: number; h: number }] {
	const ref = React.useRef<HTMLDivElement>(null);
	const [size, setSize] = React.useState({ w: 0, h: 0 });
	React.useEffect(() => {
		const el = ref.current;
		if (!el) {
			return undefined;
		}
		const update = (): void => setSize({ w: el.clientWidth, h: el.clientHeight });
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return [ref, size];
}

/**
 * "Nice" axis maximum (1, 2, 2.5, 5 x 10^n) at or above `v`.
 *
 * @param v - value to round up
 */
function niceMax(v: number): number {
	if (v <= 0) {
		return 1;
	}
	const exp = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 2, 2.5, 5, 10]) {
		if (m * exp >= v) {
			return m * exp;
		}
	}
	return 10 * exp;
}

/**
 * The advisory energy plan as a stacked-band SVG chart: prices (step line, feed-in, optional
 * marginal cost), PV forecast vs. expected load, planned SoC and a mode color band, sharing one
 * time axis with "now" and midnight markers. Hover/tap on a slot shows its details including the
 * planner's reason. Shared by SolarCockpitPlanWidget and SolarCockpitForecastWidget's fullscreen dialog.
 *
 * @param props - slots, enabled layers, optional flex window, compact flag
 */
export function EnergyPlanChart(props: Props): React.JSX.Element {
	const { slots, layers, flexStart, flexEnd, compact = false } = props;
	// Measures ONLY the plot area (the legend lives outside it), and the measured element is the
	// same in every render branch - otherwise the ResizeObserver stays attached to a stale element.
	const [ref, { w, h }] = useSize();
	const [hover, setHover] = React.useState<number | undefined>(undefined);

	if (slots.length === 0 || w === 0 || h === 0) {
		return (
			<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
				<div
					ref={ref}
					style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, opacity: 0.6 }}
				>
					{slots.length === 0 ? tr("solarcockpit_rt_no_plan") : ""}
				</div>
			</div>
		);
	}

	const font = compact ? 9 : 11;
	const padL = compact ? 26 : 40;
	const padR = compact ? 26 : 44;
	const padT = 6;
	const axisH = compact ? 12 : 16;

	// Vertical bands, proportional weights; hidden layers give their space to the others.
	const bands: Array<{ key: "price" | "pvLoad" | "soc" | "modes"; weight: number }> = [];
	if (layers.price) {
		bands.push({ key: "price", weight: 3 });
	}
	if (layers.pvLoad) {
		bands.push({ key: "pvLoad", weight: 3 });
	}
	if (layers.soc) {
		bands.push({ key: "soc", weight: 2.4 });
	}
	if (layers.modes) {
		bands.push({ key: "modes", weight: 0.5 });
	}
	const gap = compact ? 4 : 8;
	const plotH = Math.max(0, h - padT - axisH - gap * Math.max(0, bands.length - 1));
	const totalWeight = bands.reduce((s, b) => s + b.weight, 0) || 1;
	const bandPos: Record<string, { y: number; h: number }> = {};
	let cursorY = padT;
	for (const b of bands) {
		const bh = (plotH * b.weight) / totalWeight;
		bandPos[b.key] = { y: cursorY, h: bh };
		cursorY += bh + gap;
	}

	const t0 = slots[0].start;
	const t1 = slots[slots.length - 1].end;
	const plotW = Math.max(1, w - padL - padR);
	const x = (ts: number): number => padL + ((ts - t0) / (t1 - t0)) * plotW;

	const elements: React.JSX.Element[] = [];

	// Flex window shading behind everything.
	if (layers.flex && flexStart && flexEnd && flexEnd > t0 && flexStart < t1) {
		const fx = x(Math.max(t0, flexStart));
		const fw = x(Math.min(t1, flexEnd)) - fx;
		elements.push(
			<rect
				key="flex"
				x={fx}
				y={padT}
				width={Math.max(1, fw)}
				height={cursorY - padT - gap}
				fill={C.flex}
				opacity={0.14}
			/>,
		);
		// Always label the window with its time - left of the shading if it sits near the right edge.
		const label = compact ? `${hhmm(flexStart)}–${hhmm(flexEnd)}` : tr("solarcockpit_rt_appliance_window", { start: hhmm(flexStart), end: hhmm(flexEnd) });
		const labelW = label.length * font * 0.55;
		const rightAligned = fx + labelW + 4 > w - padR;
		elements.push(
			<line
				key="flexs"
				x1={fx}
				y1={padT}
				x2={fx}
				y2={cursorY - gap}
				stroke={C.flex}
				strokeWidth={1.2}
				opacity={0.8}
			/>,
			<text
				key="flexl"
				x={rightAligned ? fx + fw - 3 : fx + 3}
				y={padT + font}
				fontSize={font}
				fontWeight={600}
				fill={C.flex}
				textAnchor={rightAligned ? "end" : "start"}
			>
				{label}
			</text>,
		);
	}

	// Price band: step lines.
	const pb = bandPos.price;
	if (pb) {
		const values = slots.flatMap(s => [s.price, s.feedIn, ...(layers.marginal ? [s.marginal] : [])]);
		const vMax = niceMax(Math.max(...values, 1));
		const vMin = Math.min(0, ...values);
		const y = (v: number): number => pb.y + pb.h - ((v - vMin) / (vMax - vMin)) * pb.h;
		const step = (get: (s: PlanSlot) => number): string =>
			slots
				.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.start).toFixed(1)},${y(get(s)).toFixed(1)} L${x(s.end).toFixed(1)},${y(get(s)).toFixed(1)}`)
				.join(" ");
		elements.push(
			<path
				key="price"
				d={step(s => s.price)}
				fill="none"
				stroke={C.price}
				strokeWidth={1.6}
			/>,
		);
		elements.push(
			<path
				key="feedin"
				d={step(s => s.feedIn)}
				fill="none"
				stroke={C.feedIn}
				strokeWidth={1.2}
				strokeDasharray="4 3"
			/>,
		);
		if (layers.marginal) {
			elements.push(
				<path
					key="marg"
					d={step(s => s.marginal)}
					fill="none"
					stroke={C.marginal}
					strokeWidth={1}
					strokeDasharray="1 2"
				/>,
			);
		}
		elements.push(
			<text
				key="pax"
				x={w - padR + 3}
				y={pb.y + font}
				fontSize={font - 1}
				fill={C.axis}
			>
				{de(vMax, 0)}
			</text>,
			<text
				key="pax0"
				x={w - padR + 3}
				y={pb.y + pb.h}
				fontSize={font - 1}
				fill={C.axis}
			>
				{de(vMin, 0)}
			</text>,
		);
		if (!compact) {
			elements.push(
				<text
					key="pal"
					x={w - padR + 3}
					y={pb.y + pb.h / 2 + 4}
					fontSize={font - 2}
					fill={C.axis}
				>
					ct/kWh
				</text>,
			);
		}
	}

	// PV / load band.
	const lb = bandPos.pvLoad;
	if (lb) {
		const vMax = niceMax(Math.max(...slots.map(s => Math.max(s.pv, s.load)), 100) / 1000);
		const y = (wv: number): number => lb.y + lb.h - (wv / 1000 / vMax) * lb.h;
		const mid = (s: PlanSlot): number => x((s.start + s.end) / 2);
		const pvLine = slots.map((s, i) => `${i === 0 ? "M" : "L"}${mid(s).toFixed(1)},${y(s.pv).toFixed(1)}`).join(" ");
		const pvArea = `${pvLine} L${mid(slots[slots.length - 1]).toFixed(1)},${(lb.y + lb.h).toFixed(1)} L${mid(slots[0]).toFixed(1)},${(lb.y + lb.h).toFixed(1)} Z`;
		const loadLine = slots.map((s, i) => `${i === 0 ? "M" : "L"}${mid(s).toFixed(1)},${y(s.load).toFixed(1)}`).join(" ");
		elements.push(
			<path
				key="pva"
				d={pvArea}
				fill={C.pv}
				opacity={0.25}
			/>,
		);
		elements.push(
			<path
				key="pvl"
				d={pvLine}
				fill="none"
				stroke={C.pv}
				strokeWidth={1.4}
			/>,
		);
		elements.push(
			<path
				key="load"
				d={loadLine}
				fill="none"
				stroke={C.load}
				strokeWidth={1.3}
			/>,
		);
		elements.push(
			<text
				key="lax"
				x={padL - 3}
				y={lb.y + font}
				fontSize={font - 1}
				fill={C.axis}
				textAnchor="end"
			>
				{de(vMax, vMax < 10 ? 1 : 0)}
			</text>,
			<text
				key="lax0"
				x={padL - 3}
				y={lb.y + lb.h}
				fontSize={font - 1}
				fill={C.axis}
				textAnchor="end"
			>
				0
			</text>,
		);
		if (!compact) {
			elements.push(
				<text
					key="lal"
					x={padL - 3}
					y={lb.y + lb.h / 2 + 4}
					fontSize={font - 2}
					fill={C.axis}
					textAnchor="end"
				>
					kW
				</text>,
			);
		}
	}

	// SoC band.
	const sb = bandPos.soc;
	if (sb) {
		const y = (soc: number): number => sb.y + sb.h - (Math.max(0, Math.min(100, soc)) / 100) * sb.h;
		const line = slots.map((s, i) => `${i === 0 ? "M" : "L"}${x(s.end).toFixed(1)},${y(s.soc).toFixed(1)}`).join(" ");
		const area = `M${x(slots[0].end).toFixed(1)},${(sb.y + sb.h).toFixed(1)} ${line.replace(/^M/, "L")} L${x(slots[slots.length - 1].end).toFixed(1)},${(sb.y + sb.h).toFixed(1)} Z`;
		elements.push(
			<rect
				key="socbg"
				x={padL}
				y={sb.y}
				width={plotW}
				height={sb.h}
				fill="none"
				stroke={C.axis}
				strokeWidth={0.5}
				opacity={0.4}
			/>,
			<line
				key="soc50"
				x1={padL}
				y1={y(50)}
				x2={padL + plotW}
				y2={y(50)}
				stroke={C.axis}
				strokeWidth={0.5}
				strokeDasharray="2 3"
				opacity={0.4}
			/>,
		);
		elements.push(
			<path
				key="soca"
				d={area}
				fill={C.soc}
				opacity={0.22}
			/>,
			<path
				key="soc"
				d={line}
				fill="none"
				stroke={C.soc}
				strokeWidth={2.2}
			/>,
		);
		if (!compact) {
			// Current and lowest planned SoC as direct labels on the curve.
			const lowest = slots.reduce((m, s) => (s.soc < m.soc ? s : m), slots[0]);
			const first = slots[0];
			elements.push(
				<text
					key="socnow"
					x={x(first.end) + 3}
					y={Math.max(sb.y + font, y(first.soc) - 3)}
					fontSize={font - 1}
					fontWeight={600}
					fill={C.soc}
				>
					{de(first.soc, 0)} %
				</text>,
			);
			if (lowest !== first && x(lowest.end) - x(first.end) > 40) {
				elements.push(
					<text
						key="socmin"
						x={x(lowest.end)}
						y={Math.min(sb.y + sb.h - 2, y(lowest.soc) + font)}
						fontSize={font - 1}
						fill={C.soc}
						textAnchor="middle"
					>
						min {de(lowest.soc, 0)} %
					</text>,
				);
			}
		}
		elements.push(
			<text
				key="sax"
				x={padL - 3}
				y={sb.y + font}
				fontSize={font - 1}
				fill={C.axis}
				textAnchor="end"
			>
				100
			</text>,
			<text
				key="sax0"
				x={padL - 3}
				y={sb.y + sb.h}
				fontSize={font - 1}
				fill={C.axis}
				textAnchor="end"
			>
				0
			</text>,
		);
		if (!compact) {
			elements.push(
				<text
					key="sal"
					x={w - padR + 3}
					y={sb.y + sb.h / 2 + 4}
					fontSize={font - 2}
					fill={C.axis}
				>
					% SoC
				</text>,
			);
		}
	}

	// Mode band.
	const mb = bandPos.modes;
	if (mb) {
		slots.forEach((s, i) => {
			elements.push(
				<rect
					key={`m${i}`}
					x={x(s.start)}
					y={mb.y}
					width={Math.max(0.5, x(s.end) - x(s.start))}
					height={mb.h}
					fill={MODE_STYLE[s.mode].color}
				/>,
			);
		});
	}

	// Time axis: midnight separators + hour labels, "now" marker.
	const bottom = cursorY - gap;
	// Label every N hours, N the smallest of 1/2/3/6/12 that keeps labels at least ~40-50 px apart.
	const pxPerHour = plotW / ((t1 - t0) / 3600000);
	const labelStepH = [1, 2, 3, 6, 12].find(n => n * pxPerHour >= (compact ? 36 : 48)) ?? 24;
	const firstHour = Math.ceil(t0 / 3600000) * 3600000;
	for (let ts = firstHour; ts <= t1; ts += 3600000) {
		const d = new Date(ts);
		if (d.getHours() === 0) {
			elements.push(
				<line
					key={`mid${ts}`}
					x1={x(ts)}
					y1={padT}
					x2={x(ts)}
					y2={bottom}
					stroke={C.axis}
					strokeWidth={1}
					opacity={0.5}
				/>,
			);
		}
		if (d.getHours() % labelStepH === 0) {
			elements.push(
				<text
					key={`tl${ts}`}
					x={x(ts)}
					y={bottom + axisH - 3}
					fontSize={font - 1}
					fill={C.axis}
					textAnchor="middle"
				>
					{d.getHours() === 0 && !compact ? `${["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"][d.getDay()]} 00` : String(d.getHours()).padStart(2, "0")}
				</text>,
			);
		}
	}
	const now = Date.now();
	if (now >= t0 && now <= t1) {
		elements.push(
			<line
				key="now"
				x1={x(now)}
				y1={padT}
				x2={x(now)}
				y2={bottom}
				stroke={C.now}
				strokeWidth={1}
				strokeDasharray="3 2"
				opacity={0.7}
			/>,
			<text
				key="nowl"
				x={x(now)}
				y={bottom + axisH - 3}
				fontSize={font - 1}
				fontWeight={600}
				fill={C.now}
				textAnchor="middle"
			>
				jetzt
			</text>,
		);
	}

	// Hover cursor + tooltip.
	const hovered = hover !== undefined ? slots[hover] : undefined;
	if (hovered) {
		elements.push(
			<rect
				key="hov"
				x={x(hovered.start)}
				y={padT}
				width={Math.max(1, x(hovered.end) - x(hovered.start))}
				height={bottom - padT}
				fill={C.now}
				opacity={0.08}
				pointerEvents="none"
			/>,
		);
	}
	const onMove = (event: React.PointerEvent<SVGRectElement>): void => {
		const rect = (event.currentTarget.ownerSVGElement ?? event.currentTarget).getBoundingClientRect();
		const ts = t0 + ((event.clientX - rect.left - padL) / plotW) * (t1 - t0);
		const idx = slots.findIndex(s => s.start <= ts && ts < s.end);
		setHover(idx >= 0 ? idx : undefined);
	};

	const tooltipLeft = hovered ? Math.min(Math.max(0, x(hovered.start) - 90), Math.max(0, w - 230)) : 0;

	// Only modes that actually occur in the plan go into the legend (keeps it to one line in tiles).
	const usedModes = (Object.keys(MODE_STYLE) as Array<keyof typeof MODE_STYLE>).filter(m => slots.some(s => s.mode === m));

	return (
		<div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
			<div
				ref={ref}
				style={{ flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
			>
				<svg
					width={w}
					height={h}
					style={{ display: "block", position: "absolute", left: 0, top: 0 }}
				>
					{elements}
					<rect
						x={padL}
						y={padT}
						width={plotW}
						height={Math.max(0, bottom - padT)}
						fill="transparent"
						onPointerMove={onMove}
						onPointerDown={onMove}
						onPointerLeave={() => setHover(undefined)}
					/>
				</svg>
				{hovered && (
					<div
						style={{
							position: "absolute",
							top: padT + 4,
							left: tooltipLeft,
							width: 220,
							padding: "6px 8px",
							fontSize: 11,
							lineHeight: 1.35,
							borderRadius: 6,
							background: "rgba(16, 32, 39, 0.92)",
							color: "#fff",
							pointerEvents: "none",
							boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
						}}
					>
						<div style={{ fontWeight: 600 }}>{tr("solarcockpit_rt_slot_time", { from: relativeTime(hovered.start), to: hhmm(hovered.end) })}</div>
						<div>
							<span style={{ color: MODE_STYLE[hovered.mode].color }}>■</span> {modeLabel(hovered.mode)} ·{" "}
							{tr("solarcockpit_rt_soc_value", { soc: de(hovered.soc, 0) })}
						</div>
						<div>
							{tr("solarcockpit_rt_price_value", { price: de(hovered.price, 1) })}
							{hovered.level ? ` (${levelLabel(hovered.level)})` : ""} · {tr("solarcockpit_rt_feedin_value", { price: de(hovered.feedIn, 1) })}
						</div>
						<div>{tr("solarcockpit_rt_marginal_value", { price: de(hovered.marginal, 1) })}</div>
						<div>
							{tr("solarcockpit_rt_flows_value", {
								pv: de(hovered.pv / 1000, 1),
								load: de(hovered.load / 1000, 1),
								grid: de(hovered.grid / 1000, 1),
							})}
						</div>
						<div style={{ marginTop: 3, opacity: 0.85 }}>{hovered.reason}</div>
					</div>
				)}
			</div>
			{!compact && (
				<div
					style={{ display: "flex", flexWrap: "wrap", gap: "2px 10px", fontSize: 10, color: C.text, padding: "3px 0 0 0", justifyContent: "center" }}
				>
					{layers.price && (
						<Legend
							color={C.price}
							label={tr("solarcockpit_rt_layer_price")}
						/>
					)}
					{layers.price && (
						<Legend
							color={C.feedIn}
							label={tr("solarcockpit_rt_legend_feedin")}
							dashed
						/>
					)}
					{layers.price && layers.marginal && (
						<Legend
							color={C.marginal}
							label={tr("solarcockpit_rt_layer_marginal")}
							dashed
						/>
					)}
					{layers.pvLoad && (
						<Legend
							color={C.pv}
							label="PV"
						/>
					)}
					{layers.pvLoad && (
						<Legend
							color={C.load}
							label={tr("solarcockpit_rt_legend_load")}
						/>
					)}
					{layers.soc && (
						<Legend
							color={C.soc}
							label={tr("solarcockpit_rt_layer_soc")}
						/>
					)}
					{layers.modes &&
						usedModes.map(m => (
							<Legend
								key={m}
								color={MODE_STYLE[m].color}
								label={modeLabel(m)}
								box
							/>
						))}
				</div>
			)}
		</div>
	);
}

/**
 * One legend entry.
 *
 * @param props - color, label and marker style
 * @param props.color - marker color
 * @param props.label - legend text
 * @param props.dashed - dashed line marker
 * @param props.box - filled box marker instead of a line
 */
function Legend(props: { color: string; label: string; dashed?: boolean; box?: boolean }): React.JSX.Element {
	return (
		<span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
			<svg
				width={14}
				height={8}
			>
				{props.box ? (
					<rect
						x={1}
						y={0}
						width={12}
						height={8}
						fill={props.color}
						opacity={0.8}
					/>
				) : (
					<line
						x1={0}
						y1={4}
						x2={14}
						y2={4}
						stroke={props.color}
						strokeWidth={2}
						strokeDasharray={props.dashed ? "3 2" : undefined}
					/>
				)}
			</svg>
			{props.label}
		</span>
	);
}

/**
 * Layer toggle chips for the fullscreen view.
 *
 * @param props - current layers and change handler
 * @param props.layers - currently enabled layers
 * @param props.onChange - called with the new layer set
 */
export function PlanLayerToggles(props: { layers: PlanLayers; onChange: (layers: PlanLayers) => void }): React.JSX.Element {
	return (
		<div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
			{(Object.keys(LAYER_LABELS) as Array<keyof PlanLayers>).map(key => (
				<button
					key={key}
					type="button"
					onClick={() => props.onChange({ ...props.layers, [key]: !props.layers[key] })}
					style={{
						fontSize: 12,
						padding: "3px 10px",
						borderRadius: 12,
						border: "1px solid rgba(128,128,128,0.5)",
						background: props.layers[key] ? "rgba(76, 201, 240, 0.25)" : "transparent",
						color: "inherit",
						cursor: "pointer",
					}}
				>
					{tr(LAYER_LABELS[key])}
				</button>
			))}
		</div>
	);
}
