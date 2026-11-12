import { nameOf, syncLanguage, tr } from "./lib/i18n";
import React from "react";

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetState } from "@iobroker/types-vis-2";
import type VisRxWidget from "@iobroker/types-vis-2/visRxWidget";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";

import { formatEnergy, formatPower } from "./lib/format";

/**
 * A very loose shape for the vis-2 socket connection, just covering the two calls this widget
 * needs. The real `Connection` type (from `@iobroker/gui-components`) isn't installed in this
 * repo, so typing against it would make every call site depend on a module that can't resolve.
 */
interface LooseSocket {
	getObject(id: string): Promise<ioBroker.Object | null | undefined>;
	getState(id: string): Promise<ioBroker.State | null | undefined>;
	subscribeState(id: string, cb: (id: string, state: ioBroker.State | null | undefined) => void): void;
	unsubscribeState(id: string, cb: (id: string, state: ioBroker.State | null | undefined) => void): void;
}

const MAX_PARTICIPANTS = 12;
/** Distinct "Sammelmesspunkt" parents rarely number more than a couple per installation. */
const MAX_REST_ICONS = 6;
const DEADBAND = 5;
/** Deadband for the history views (kWh) - 5 W would hide almost every daily total, so this is a separate, much smaller threshold. */
const ENERGY_DEADBAND = 0.05;
/**
 * The "Messabweichung" branch (formerly "Rest-Diagnose", see renderDiagram) gets its OWN, higher deadband than every other
 * item - it's a widget-side arithmetic residual, not a measured value, so it needs to stay hidden
 * through the small jitter that's normal between independently-sampled sensors and only appear
 * once it represents a real, currently-undiagnosed gap.
 */
const DIAGNOSTIC_DEADBAND = 20;
const DIAGNOSTIC_ENERGY_DEADBAND = 0.2;
/**
 * Mirrors entityModel.LOSS_COLOR (backend lib, not importable from this separately-built widget
 * bundle) - keep the two in sync by hand if either changes.
 */
const LOSS_COLOR = "#b23a48";

type ViewMode = "live" | "today" | "yesterday" | "last7days";

/**
 * Live power state suffix -> the matching HistoryManager-written energy state suffix for that view mode.
 *
 * @param mode
 */
function historySuffix(mode: ViewMode): "energyToday" | "energyYesterday" | "energyLast7Days" {
	return mode === "today" ? "energyToday" : mode === "yesterday" ? "energyYesterday" : "energyLast7Days";
}

function restHistorySuffix(mode: ViewMode): "restEnergyToday" | "restEnergyYesterday" | "restEnergyLast7Days" {
	return mode === "today" ? "restEnergyToday" : mode === "yesterday" ? "restEnergyYesterday" : "restEnergyLast7Days";
}

/**
 * `entities.<id>.power` -> `entities.<id>.energyToday` (etc.) - HistoryManager writes its totals as siblings
 * of the live power state, so every already-bound participant oid doubles as the history lookup key.
 *
 * @param powerOid
 * @param mode
 */
function historyOidFor(powerOid: string, mode: ViewMode): string {
	return powerOid.replace(/\.power$/, `.${historySuffix(mode)}`);
}

/** Fallback radius used only for position math (e.g. where the battery WOULD sit) while no storage participant is configured. */
const STORAGE_R = 30;
const ARC_R_MIN = 50;
const LEFT_ICON_X = 110;
const RIGHT_ICON_X = 850;
const MERGE_X = 290;
const TAP_X = 480;
const SPLIT_X = 670;
const ICON_TOP = 60;
const ICON_BOTTOM = 600;
const FULL_SPAN = ICON_BOTTOM - ICON_TOP;
const STORAGE_X = TAP_X + ARC_R_MIN;
const VIEW_W = 960;
const VIEW_H = 800;

const REST_COLOR_FALLBACK = "#94a1ad";

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * `decodeSvgIcon` is pure per input string, but every participant's icon is re-decoded (base64 +
 * two regexes over what can be a ~10 KB SVG) on every single render - including every animation
 * frame of `tickAnimation`'s easing loop, across every configured participant at once. Without this
 * cache that redone work was enough to noticeably stall the tab. Keyed on the raw data URI itself,
 * which only ever changes when a widget is reconfigured (a fresh `MaterialIconPickerField` pick).
 */
const svgIconCache = new Map<string, { viewBox: string; markup: string } | null>();

/**
 * If `dataUri` is an SVG icon as produced by the Material Icon Selector (see `MaterialIconPickerField`
 * above), every glyph path in it is filled with `fill:currentColor` - the same convention vis-2's own
 * navigation icons use to inherit the current theme's text color via CSS. Returns its viewBox and inner
 * markup so it can be re-rendered as a real inline `<svg>` (not an `<image href>`, which would load the
 * data URI as an opaque embedded document and never see our CSS `color`) and pick up the theme the same
 * way. A plain raster image (PNG/JPEG) or a manually uploaded custom image doesn't match and keeps using
 * a plain `<image>` reference instead - there is no color to swap on those.
 *
 * @param dataUri
 */
function decodeSvgIcon(dataUri: string): { viewBox: string; markup: string } | null {
	const cached = svgIconCache.get(dataUri);
	if (cached !== undefined) {
		return cached;
	}
	const result = decodeSvgIconUncached(dataUri);
	svgIconCache.set(dataUri, result);
	return result;
}

function decodeSvgIconUncached(dataUri: string): { viewBox: string; markup: string } | null {
	const match = /^data:image\/svg\+xml;base64,(.+)$/.exec(dataUri);
	if (!match) {
		return null;
	}
	let svgText: string;
	try {
		svgText = atob(match[1]);
	} catch {
		return null;
	}
	const viewBoxMatch = /<svg[^>]*\sviewBox="([^"]+)"/i.exec(svgText);
	const innerMatch = /<svg[^>]*>([\s\S]*)<\/svg>/i.exec(svgText);
	if (!viewBoxMatch || !innerMatch) {
		return null;
	}
	return { viewBox: viewBoxMatch[1], markup: innerMatch[1] };
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Vis-2's icon library exports every icon from the same handful of design tools, which all reuse the
 * same generic ids/classes across completely unrelated icon files ("layer1", "defs165", ".st0".."st9",
 * ...) - harmless as long as each icon lives in its own isolated `<image>` document, but inlining several
 * of them into ONE page (see `decodeSvgIcon`/`renderIcon`) turns every one of those into a DOM-wide
 * collision: `url(#id)`/`href="#id"` resolve to whichever element with that id happens to occur FIRST in
 * the whole document (not necessarily this icon's own), and a `<style>` block's `.st0{...}` rule applies
 * to every element with that class anywhere on the page - including a completely different icon that
 * happens to reuse the same generic class name with a conflicting definition. Prefixing every id/class
 * this markup defines, and every internal reference to them, with something unique to this one icon
 * INSTANCE (not just this icon's content - the same icon can be picked for several participants at once)
 * keeps it self-contained.
 *
 * @param markup
 * @param instanceId
 */
function namespaceSvgMarkup(markup: string, instanceId: string): string {
	const prefix = `efi-${instanceId.replace(/[^a-zA-Z0-9_-]/g, "_")}-`;

	const ids = new Set<string>();
	for (const m of markup.matchAll(/\bid="([^"]+)"/g)) {
		ids.add(m[1]);
	}
	const classes = new Set<string>();
	for (const m of markup.matchAll(/\bclass="([^"]+)"/g)) {
		for (const c of m[1].split(/\s+/)) {
			if (c) {
				classes.add(c);
			}
		}
	}

	let result = markup
		.replace(/\bid="([^"]+)"/g, (_all, id: string) => `id="${prefix}${id}"`)
		.replace(/url\(#([^)]+)\)/g, (_all, id: string) => `url(#${prefix}${id})`)
		.replace(/((?:xlink:)?href)="#([^"]+)"/g, (_all, attr: string, id: string) => `${attr}="#${prefix}${id}"`)
		.replace(
			/\bclass="([^"]+)"/g,
			(_all, cls: string) =>
				`class="${cls
					.split(/\s+/)
					.filter(Boolean)
					.map(c => prefix + c)
					.join(" ")}"`,
		);

	for (const cls of classes) {
		result = result.replace(new RegExp(`\\.${escapeRegExp(cls)}\\b`, "g"), `.${prefix}${cls}`);
	}
	for (const id of ids) {
		result = result.replace(new RegExp(`#${escapeRegExp(id)}\\b`, "g"), `#${prefix}${id}`);
	}
	return result;
}

/**
 * Per-(icon, on-page instance) cache for the namespaced markup - namespacing itself is a handful of
 * regex passes over the (already-decoded, already-cached) SVG text, cheap once but still worth not
 * redoing on every animation frame for every icon.
 */
const namespacedSvgCache = new Map<string, string>();

/**
 * `decodeSvgIcon` plus `namespaceSvgMarkup`, cached per `instanceId` (a stable per-icon-slot key, e.g.
 * `renderIcon`'s `clipId`) - see `namespaceSvgMarkup` for why the SAME icon content still needs a
 * different namespace for every place it's used on the page at once.
 *
 * @param dataUri
 * @param instanceId
 */
function getNamespacedSvgIcon(dataUri: string, instanceId: string): { viewBox: string; markup: string } | null {
	const decoded = decodeSvgIcon(dataUri);
	if (!decoded) {
		return null;
	}
	const cacheKey = `${instanceId}|${dataUri}`;
	let markup = namespacedSvgCache.get(cacheKey);
	if (markup === undefined) {
		markup = namespaceSvgMarkup(decoded.markup, instanceId);
		namespacedSvgCache.set(cacheKey, markup);
	}
	return { viewBox: decoded.viewBox, markup };
}

interface SolarCockpitFlowArrowRxData {
	participantCount: number;
	[key: string]: unknown;
}

/** Static per-entity metadata fetched once (and on config change) via the object tree, not a live state binding. */
interface EntityMeta {
	color: string;
	category: string;
	parentId: string;
	name: string;
	/** ioBroker id of the entity's own channel (`entities.<id>`), derived from the bound state's own id. */
	channelId: string;
}

/**
 * Static metadata for a synthesized loss entity (`entities.<id>_loss` / `_chargeloss` / `_dischargeloss`,
 * see entityModel.deriveLossDefinitions), discovered the same way as a parent's "Sonstiges" item -
 * these are never user-bound participants, so there is no `oid<N>` config field for them either.
 */
interface LossMeta {
	channelId: string;
	kind: "producerLoss" | "chargeLoss" | "dischargeLoss" | "inverterLoss";
	color: string;
	name: string;
}

interface ParticipantConfig {
	oid: string;
	icon: string;
	image: string;
	size: number;
}

interface FlowItem {
	key: string;
	label: string;
	iconSrc: string;
	size: number;
	color: string;
	value: number;
}

interface FlowSlice extends FlowItem {
	top: number;
	bottom: number;
	center: number;
	th: number;
}

/**
 * `size` is the participant's configured circle DIAMETER in px - halved wherever geometry needs a radius.
 *
 * @param item
 */
function radiusOf(item: Pick<FlowItem, "size">): number {
	return item.size / 2;
}

function ribbonH(x0: number, y0: number, w0: number, x1: number, y1: number, w1: number): string {
	const h0 = w0 / 2,
		h1 = w1 / 2,
		mx = (x0 + x1) / 2;
	return `M ${x0} ${y0 - h0} C ${mx} ${y0 - h0}, ${mx} ${y1 - h1}, ${x1} ${y1 - h1}
		L ${x1} ${y1 + h1} C ${mx} ${y1 + h1}, ${mx} ${y0 + h0}, ${x0} ${y0 + h0} Z`;
}

/**
 * Trunk segment with a flat top edge (fixed at `topY`, matching how every icon stack is top-aligned)
 * and a smoothly tapering bottom edge - from thickness `h0` at `x0` to `h1` at `x1`. Used to bridge
 * whatever the merged trunk's thickness needs to be at each end without ever presenting a hard
 * right-angle step where a rect's edge would otherwise just stop short.
 *
 * @param x0
 * @param x1
 * @param topY
 * @param h0
 * @param h1
 */
function topTaper(x0: number, x1: number, topY: number, h0: number, h1: number): string {
	const mx = (x0 + x1) / 2;
	return `M ${x0} ${topY} L ${x1} ${topY}
		L ${x1} ${topY + h1} C ${mx} ${topY + h1}, ${mx} ${topY + h0}, ${x0} ${topY + h0} Z`;
}

/**
 * A bend radius smaller than the branch's own thickness reads as a hard corner rather than a curve.
 *
 * @param thickness
 */
function bendRadius(thickness: number): number {
	return Math.max(ARC_R_MIN, thickness * 1.1);
}

function arrowLen(refRadius: number): number {
	return refRadius * 2 * 0.6;
}

/**
 * Flared arrowhead (30% wider than the band it caps) - only ever used at a true destination, never at a merge.
 * Length comes from `arrowLen(refRadius)`, the SAME function the caller must use to shorten the ribbon feeding
 * this arrowhead - otherwise the ribbon's end and the arrowhead's base land at different points.
 *
 * @param tipX
 * @param tipY
 * @param angleDeg
 * @param thickness
 * @param refRadius
 */
function flaredArrowPoints(tipX: number, tipY: number, angleDeg: number, thickness: number, refRadius: number): string {
	const len = arrowLen(refRadius);
	const baseHalf = (thickness * 1.3) / 2;
	const rad = (angleDeg * Math.PI) / 180;
	const dx = Math.cos(rad),
		dy = Math.sin(rad);
	const px = -dy,
		py = dx;
	const bx = tipX - dx * len,
		by = tipY - dy * len;
	const p1: [number, number] = [bx + px * baseHalf, by + py * baseHalf];
	const p2: [number, number] = [bx - px * baseHalf, by - py * baseHalf];
	return `${tipX},${tipY} ${p1.join(",")} ${p2.join(",")}`;
}

/** Upper bound for a peel-off band's drawn thickness - its value label stays exact, the band only hints at magnitude. */
const PEEL_OFF_MAX_THICKNESS = 16;
/** Peel-off arrowhead: this much wider than the band (total, not per side) ... */
const PEEL_OFF_HEAD_EXTRA = 8;
/** ... and this long, independent of the band's thickness - a thick band must not grow a huge head. */
const PEEL_OFF_HEAD_LEN = 12;
/** Gap between the arrowhead's tip and the target icon's circle outline. */
const PEEL_OFF_TIP_GAP = 2;
/** Vertical offset of the loss/residual icons above the trunk's top edge. */
const PEEL_OFF_RISE = 70;
/** Radius of a peel-off icon (pushPeelOff's default). */
const PEEL_OFF_RADIUS = 22;
/**
 * Room needed above a peel-off icon's center for its label (renderIcon draws the label baseline
 * at y - r - 20; plus ~14 for the cap height of the 12.5 px font and a little air).
 */
const PEEL_OFF_LABEL_ROOM = PEEL_OFF_RADIUS + 20 + 16;

/**
 * Geometry of a peel-off branch: a straight band whose foot sits flat (horizontal edge) on the
 * trunk at (fromX, fromY) and whose far end is perpendicular to its direction, plus a fixed-size
 * arrowhead whose tip stops at the edge of the target icon's circle (not at its center, where the
 * icon would cover half of it).
 *
 * @param fromX
 * @param fromY
 * @param iconX
 * @param iconY
 * @param thickness - proportional band thickness, clamped to [1.5, PEEL_OFF_MAX_THICKNESS]
 * @param radius - target icon radius
 */
function peelOffGeometry(fromX: number, fromY: number, iconX: number, iconY: number, thickness: number, radius: number): { band: string; head: string } {
	const t = Math.min(PEEL_OFF_MAX_THICKNESS, Math.max(1.5, thickness));
	const dist = Math.hypot(iconX - fromX, iconY - fromY) || 1;
	const ux = (iconX - fromX) / dist,
		uy = (iconY - fromY) / dist;
	// unit normal
	const nx = -uy,
		ny = ux;
	const tipX = iconX - ux * (radius + PEEL_OFF_TIP_GAP),
		tipY = iconY - uy * (radius + PEEL_OFF_TIP_GAP);
	const baseX = tipX - ux * PEEL_OFF_HEAD_LEN,
		baseY = tipY - uy * PEEL_OFF_HEAD_LEN;
	const h = t / 2;
	const hh = (t + PEEL_OFF_HEAD_EXTRA) / 2;
	const f = (x: number, y: number): string => `${x.toFixed(2)},${y.toFixed(2)}`;
	// Foot: horizontal edge on the trunk's top line (the trunk is horizontal), so a slanted branch
	// doesn't poke a corner into the trunk or leave a wedge-shaped gap. The band overlaps the head's
	// base by 1 px so no hairline seam shows between the two shapes.
	const band = [f(fromX - h, fromY), f(fromX + h, fromY), f(baseX + nx * h + ux, baseY + ny * h + uy), f(baseX - nx * h + ux, baseY - ny * h + uy)];
	// keep a consistent winding regardless of direction (normal may point either way)
	const head = [f(tipX, tipY), f(baseX + nx * hh, baseY + ny * hh), f(baseX - nx * hh, baseY - ny * hh)];
	return { band: orderFoot(band, nx).join(" "), head: head.join(" ") };
}

/**
 * The band polygon's foot corners are given left-then-right; the far-end corners must follow in the
 * matching order (right side first), otherwise the quadrilateral self-intersects into a bow-tie.
 * Which normal side is "right" depends on the branch's direction.
 *
 * @param pts - [footLeft, footRight, farPlusNormal, farMinusNormal]
 * @param nx - x component of the unit normal used for the far corners
 */
function orderFoot(pts: string[], nx: number): string[] {
	return nx >= 0 ? [pts[0], pts[1], pts[2], pts[3]] : [pts[0], pts[1], pts[3], pts[2]];
}

/**
 * A small offshoot branch used for the loss/diagnostic items (see renderDiagram): a straight band
 * from a point on the main trunk to its own small labeled icon, with a fixed-size arrowhead ending
 * at the icon's circle (see peelOffGeometry). Drawn in a flat diagnostic color rather than the shared gradient - these represent a
 * physically-motivated ESTIMATE or an arithmetic residual, not a measured contributor to the
 * gradient's own color mix.
 *
 * @param flow
 * @param icons
 * @param key
 * @param fromX
 * @param fromY
 * @param iconX
 * @param iconY
 * @param thickness
 * @param color
 * @param label
 * @param value
 * @param keyPrefix
 * @param formatValue
 * @param iconColor
 * @param radius
 */
function pushPeelOff(
	flow: React.JSX.Element[],
	icons: React.JSX.Element[],
	key: string,
	fromX: number,
	fromY: number,
	iconX: number,
	iconY: number,
	thickness: number,
	color: string,
	label: string,
	value: number,
	keyPrefix: string,
	formatValue: (v: number) => string,
	iconColor: string,
	radius = PEEL_OFF_RADIUS,
): void {
	const { band, head } = peelOffGeometry(fromX, fromY, iconX, iconY, thickness, radius);
	flow.push(
		<polygon
			key={`${key}-ribbon`}
			points={band}
			fill={color}
			stroke={color}
			strokeWidth={1}
			strokeLinejoin="round"
		/>,
	);
	flow.push(
		<polygon
			key={`${key}-arrow`}
			points={head}
			fill={color}
			stroke={color}
			strokeWidth={1}
			strokeLinejoin="round"
		/>,
	);
	icons.push(renderIcon(iconX, iconY, { key, label, iconSrc: "", size: radius * 2, color, value }, false, keyPrefix, formatValue, iconColor));
}

/**
 * Quarter-circle elbow for CHARGING: bar (12 o'clock) bends clockwise through the NE quadrant to the battery (3 o'clock).
 *
 * @param xTurn
 * @param yTop
 * @param yBottom
 * @param yEnd
 * @param r
 */
function elbowDown(xTurn: number, yTop: number, yBottom: number, yEnd: number, r: number): string {
	const thickness = yBottom - yTop,
		center = (yTop + yBottom) / 2;
	const rOuter = r + thickness / 2,
		rInner = r - thickness / 2;
	const cx = xTurn,
		cy = center + r;
	const outerStart = [cx, cy - rOuter];
	const outerArcEnd = [cx + rOuter, cy];
	const innerArcEnd = [cx + rInner, cy];
	const innerStart = [cx, cy - rInner];
	return `M ${outerStart.join(",")} A ${rOuter} ${rOuter} 0 0 1 ${outerArcEnd.join(",")}
		L ${outerArcEnd[0]} ${yEnd} L ${innerArcEnd[0]} ${yEnd} L ${innerArcEnd.join(",")}
		A ${rInner} ${rInner} 0 0 0 ${innerStart.join(",")} Z`;
}

/**
 * Mirror image for DISCHARGING: battery pipe's LEFT edge tangent at 9 o'clock, clockwise to the bar at 12 o'clock.
 *
 * @param storageX
 * @param yTop
 * @param yBottom
 * @param yEnd
 * @param r
 */
function elbowUpLeft(storageX: number, yTop: number, yBottom: number, yEnd: number, r: number): { xTurn: number; d: string } {
	const thickness = yBottom - yTop;
	const rOuter = r + thickness / 2,
		rInner = r - thickness / 2;
	const xTurn = storageX + r;
	const pipeY = (yTop + yBottom) / 2 + r;
	const p1 = [xTurn, yTop];
	const p2 = [storageX - thickness / 2, pipeY];
	const p3 = [storageX - thickness / 2, yEnd];
	const p4 = [storageX + thickness / 2, yEnd];
	const p5 = [storageX + thickness / 2, pipeY];
	const p6 = [xTurn, yBottom];
	const d = `M ${p1.join(",")} A ${rOuter} ${rOuter} 0 0 0 ${p2.join(",")}
		L ${p3.join(",")} L ${p4.join(",")} L ${p5.join(",")}
		A ${rInner} ${rInner} 0 0 1 ${p6.join(",")} Z`;
	return { xTurn, d };
}

function iconY(index: number, count: number): number {
	if (count <= 0) {
		return (ICON_TOP + ICON_BOTTOM) / 2;
	}
	return ICON_TOP + ((index + 0.5) / count) * FULL_SPAN;
}

/**
 * Color stops for the shared gradient, one per contributor at the center of its own share of `total`.
 *
 * @param items
 * @param total
 */
function sliceGradientStops(items: { color: string; value: number }[], total: number): { offset: string; color: string }[] {
	if (total <= 0) {
		return [
			{ offset: "0%", color: REST_COLOR_FALLBACK },
			{ offset: "100%", color: REST_COLOR_FALLBACK },
		];
	}
	const stops: { offset: string; color: string }[] = [];
	let cum = 0;
	items.forEach((it, i) => {
		const share = it.value / total;
		const mid = `${((cum + share / 2) * 100).toFixed(1)}%`;
		if (i === 0) {
			stops.push({ offset: "0%", color: it.color });
		}
		stops.push({ offset: mid, color: it.color });
		cum += share;
		if (i === items.length - 1) {
			stops.push({ offset: "100%", color: it.color });
		}
	});
	return stops;
}

/**
 * Admin-editor field for the participant `icon`: opens vis-2's own Material Icon Selector
 * (`window.VisMaterialIconSelector`, all icon sets incl. any admin-configured additional ones)
 * instead of the built-in `type: "icon"` field, whose picker only offers a small fixed set.
 * The dialog returns a ready-to-use image URL/data-URI - same format the built-in field stored,
 * so it can still be used directly as `iconSrc` (an SVG `<image href>`, see `renderIcon`).
 *
 * @param props
 * @param props.value
 * @param props.onChange
 * @param props.context
 */
function MaterialIconPickerField(props: { value: string; onChange: (value: string) => void; context: unknown }): React.JSX.Element {
	const [open, setOpen] = React.useState(false);
	const ctx = props.context as { theme?: { palette?: { mode?: string } }; additionalSets?: Record<string, unknown> };
	const Selector = (window as unknown as { VisMaterialIconSelector?: React.ComponentType<Record<string, unknown>> }).VisMaterialIconSelector;

	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				title={props.value || undefined}
				style={{
					width: 36,
					height: 36,
					padding: 0,
					border: "1px solid rgba(128, 128, 128, 0.4)",
					borderRadius: 4,
					background: props.value ? `url("${props.value}") center / 70% no-repeat` : undefined,
					cursor: "pointer",
				}}
			/>
			{open && Selector ? (
				<Selector
					value={props.value}
					theme={ctx.theme}
					themeType={ctx.theme?.palette?.mode === "dark" ? "dark" : "light"}
					additionalSets={ctx.additionalSets ?? {}}
					onClose={(icon: string | null) => {
						setOpen(false);
						if (icon !== null) {
							props.onChange(icon);
						}
					}}
				/>
			) : null}
		</>
	);
}

/**
 * Energy-flow arrow diagram: producers/grid-import on the left, consumers/grid-export on the
 * right, one storage branch below, all rendered as a single flowing body (shared gradient, no
 * per-participant stroke, no arrowheads at merge points). Participants are bound directly as
 * power-state OIDs (indexed/counted field group below) - category, color and parent/child
 * grouping are then read once from each state's own parent channel object (`entities.<id>`,
 * written by EntityManager), not re-entered here.
 */
export default class SolarCockpitFlowArrowWidget extends (window.visRxWidget as typeof VisRxWidget)<SolarCockpitFlowArrowRxData, VisRxWidgetState> {
	static adapter: string;

	/** oid -> fetched object metadata (color/category/parentId), refreshed on mount and whenever the configured oids change. */
	private entityMeta: Record<string, EntityMeta> = {};
	/**
	 * parentId -> fetched metadata of the PARENT entity itself (not a bound participant, so not in entityMeta) - the
	 * auto "Sonstiges" item's own name/color/category (e.g. a producer child must not make the rest item a producer).
	 */
	private parentMeta: Record<string, { color: string; name: string; category: string; channelId: string }> = {};
	/** parentId -> live value of `<parent channel>.restPower`, manually subscribed since it's derived, not a bound field. */
	private restValues: Record<string, number> = {};
	private restSubscriptions: { id: string; cb: (id: string, state: ioBroker.State | null | undefined) => void }[] = [];
	/** channelId (`entities.<id>_loss` etc.) -> its discovered metadata, see refreshParticipantMeta. */
	private lossMeta: Record<string, LossMeta> = {};
	/** channelId -> live value of `<loss channel>.power`, manually subscribed - same reasoning as restValues. */
	private lossValues: Record<string, number> = {};
	private lossSubscriptions: { id: string; cb: (id: string, state: ioBroker.State | null | undefined) => void }[] = [];
	/** Adapter namespace ("solarcockpit.0") of the bound participants - for the summary.* states below. */
	private namespace = "";
	/** Live value of `summary.balanceResidual.power` (signed), undefined until the state exists - see renderDiagram's "Messabweichung". */
	private residualLive: number | undefined;
	/** Whether the grid participant currently runs on the balance instead of its measurement (`entities.<grid>.source`). */
	private gridEstimated = false;
	private summarySubscriptions: { id: string; cb: (id: string, state: ioBroker.State | null | undefined) => void }[] = [];
	/** Smoothed (animated) copy of the live values, tweened towards the real ones on every change. */
	private displayValues: Record<string, number> = {};
	private animationFrame: number | null = null;
	/** Ephemeral UI state (not persisted rxData, like SolarCockpitForecastWidget's scrub position) - whether the fullscreen dialog is open. */
	private fullscreen = false;

	private openFullscreen = (): void => {
		this.fullscreen = true;
		this.forceUpdate();
	};

	private closeFullscreen = (): void => {
		this.fullscreen = false;
		this.forceUpdate();
	};

	/** Only meaningful/visible inside the fullscreen dialog - the compact card always shows live power. */
	private viewMode: ViewMode = "live";
	/**
	 * Historical-oid -> its last-fetched kWh value. One-shot fetch per mode switch, not a live subscription -
	 * HistoryManager only recomputes every 15 minutes, so there is nothing to animate towards in between.
	 */
	private historyValues: Record<string, number> = {};

	private setViewMode = (mode: ViewMode): void => {
		this.viewMode = mode;
		if (mode !== "live") {
			void this.refreshHistoryValues();
		}
		this.forceUpdate();
	};

	/** Fetches every participant's (and every distinct parent's rest-) historical value for the current view mode. */
	private async refreshHistoryValues(): Promise<void> {
		const socket = this.getSocket();
		const mode = this.viewMode;
		if (!socket || mode === "live") {
			return;
		}
		const configs = this.getParticipantConfigs();
		const parentIds = new Set(Object.keys(this.parentMeta));
		await Promise.all([
			...configs.map(async cfg => {
				const historyOid = historyOidFor(cfg.oid, mode);
				try {
					const state = await socket.getState(historyOid);
					this.historyValues[historyOid] = typeof state?.val === "number" ? state.val : 0;
				} catch {
					this.historyValues[historyOid] = 0;
				}
			}),
			...[...parentIds].map(async parentId => {
				const channelId = this.parentMeta[parentId]?.channelId;
				if (!channelId) {
					return;
				}
				const historyOid = `${channelId}.${restHistorySuffix(mode)}`;
				try {
					const state = await socket.getState(historyOid);
					this.historyValues[historyOid] = typeof state?.val === "number" ? state.val : 0;
				} catch {
					this.historyValues[historyOid] = 0;
				}
			}),
			(async () => {
				if (!this.namespace) {
					return;
				}
				const historyOid = `${this.namespace}.summary.balanceResidual.${historySuffix(mode)}`;
				try {
					const state = await socket.getState(historyOid);
					if (typeof state?.val === "number") {
						this.historyValues[historyOid] = state.val;
					}
				} catch {
					// older adapter version without the residual states - widget falls back to its own arithmetic
				}
			})(),
			...Object.keys(this.lossMeta).map(async channelId => {
				const historyOid = historyOidFor(`${channelId}.power`, mode);
				try {
					const state = await socket.getState(historyOid);
					this.historyValues[historyOid] = typeof state?.val === "number" ? state.val : 0;
				} catch {
					this.historyValues[historyOid] = 0;
				}
			}),
		]);
		// the view mode may have changed again while these requests were in flight - only repaint if it's still current
		if (this.viewMode === mode) {
			this.forceUpdate();
		}
	}

	/** vis-2 widget metadata (editor attributes and preview) */
	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplSolarCockpitFlowArrow",
			visSet: "solarcockpit",
			visSetLabel: "set_label",
			visSetColor: "#ff9800",
			visName: "SolarCockpitFlowArrowWidget",
			visWidgetLabel: "widget_label_arrow",
			visAttrs: [
				{
					name: "count",
					label: "solarcockpit_group_participants",
					fields: [
						{
							name: "participantCount",
							type: "number",
							label: "solarcockpit_participant_count",
							min: 0,
							max: MAX_PARTICIPANTS,
							default: 6,
						},
					],
				},
				{
					name: "restCount",
					label: "solarcockpit_group_rest_icons",
					fields: [
						{
							name: "restIconCount",
							type: "number",
							label: "solarcockpit_rest_icon_count",
							min: 0,
							max: MAX_REST_ICONS,
							default: 0,
						},
					],
				},
				{
					name: "restIcon",
					label: "solarcockpit_group_rest_icon",
					indexFrom: 1,
					indexTo: "restIconCount",
					fields: [
						{ name: "parentId", type: "text", label: "solarcockpit_rest_icon_parent_id" },
						{
							// Named "restIconValue", not "icon" - an indexed field's data key is just
							// `${name}${index}` with no per-group namespacing, and the participant group
							// below already owns `icon1..iconN` for its own (differently-indexed) icons.
							name: "restIconValue",
							type: "custom",
							label: "solarcockpit_participant_icon",
							component: (field, data, onDataChange, props) => {
								const fieldName = (field as { name?: string }).name ?? "restIconValue";
								return (
									<MaterialIconPickerField
										key={fieldName}
										value={asString((data as Record<string, unknown>)[fieldName])}
										onChange={newValue => onDataChange({ [fieldName]: newValue })}
										context={props.context}
									/>
								);
							},
						},
					],
				},
				{
					name: "participant",
					label: "solarcockpit_group_participant",
					indexFrom: 1,
					indexTo: "participantCount",
					fields: [
						{ name: "oid", type: "id", label: "solarcockpit_participant_oid", filter: "state" },
						{
							name: "icon",
							type: "custom",
							label: "solarcockpit_participant_icon",
							component: (field, data, onDataChange, props) => {
								const fieldName = (field as { name?: string }).name ?? "icon";
								return (
									<MaterialIconPickerField
										key={fieldName}
										value={asString((data as Record<string, unknown>)[fieldName])}
										onChange={newValue => onDataChange({ [fieldName]: newValue })}
										context={props.context}
									/>
								);
							},
						},
						{ name: "image", type: "image", label: "solarcockpit_participant_image" },
						{ name: "size", type: "number", label: "solarcockpit_participant_size", default: 60, min: 16, max: 128 },
					],
				},
			],
			visPrev: "widgets/solarcockpit/img/vis-solarcockpit-flowarrow.png",
		};
	}

	getWidgetInfo(): RxWidgetInfo {
		return SolarCockpitFlowArrowWidget.getWidgetInfo();
	}

	/** Prefix vis-2 prepends to this widget set's dictionary keys */
	static getI18nPrefix(): string {
		return `${SolarCockpitFlowArrowWidget.adapter}_`;
	}

	private getSocket(): LooseSocket {
		return (this.props as unknown as { context: { socket: LooseSocket } }).context.socket;
	}

	/**
	 * Theme-appropriate icon color, matching how vis-2's own navigation icons pick up `theme.palette.
	 * text.primary` (white on a dark theme, near-black on light) - applied to every `currentColor`-based
	 * icon via `decodeSvgIcon`/`renderIcon` instead of leaving them at whatever color they had when picked.
	 */
	private getIconColor(): string {
		const theme = (this.props as unknown as { context?: { theme?: { palette?: { text?: { primary?: string }; mode?: string } } } }).context?.theme;
		return theme?.palette?.text?.primary || (theme?.palette?.mode === "dark" ? "#ffffff" : "#000000");
	}

	private getParticipantConfigs(): ParticipantConfig[] {
		const data = this.state.rxData;
		const count = Math.min(MAX_PARTICIPANTS, Number(data.participantCount) || 0);
		const list: ParticipantConfig[] = [];
		for (let i = 1; i <= count; i++) {
			const oid = asString(data[`oid${i}`]);
			if (!oid) {
				continue;
			}
			list.push({
				oid,
				icon: asString(data[`icon${i}`]),
				image: asString(data[`image${i}`]),
				size: Number(data[`size${i}`]) || 60,
			});
		}
		return list;
	}

	/**
	 * User-configured icon overrides for the auto "Sonstiges"/rest arrow, keyed by parent entity ID (the
	 * same ID used as "Parent (aggregate) ID" for that parent's children in the admin entity list) - that
	 * arrow isn't a directly configured participant, so it has no `icon<N>` field of its own to piggyback
	 * on.
	 */
	private getRestIconOverrides(): Record<string, string> {
		const data = this.state.rxData;
		const count = Math.min(MAX_REST_ICONS, Number(data.restIconCount) || 0);
		const map: Record<string, string> = {};
		for (let i = 1; i <= count; i++) {
			const parentId = asString(data[`parentId${i}`]).trim();
			const icon = asString(data[`restIconValue${i}`]);
			if (parentId && icon) {
				map[parentId] = icon;
			}
		}
		return map;
	}

	/** Subscribes the participants' states once the widget is mounted */
	componentDidMount(): void {
		super.componentDidMount();
		void this.refreshParticipantMeta();
	}

	/** Releases subscriptions and the animation frame */
	componentWillUnmount(): void {
		this.clearRestSubscriptions();
		this.clearLossSubscriptions();
		this.clearSummarySubscriptions();
		if (this.animationFrame !== null) {
			cancelAnimationFrame(this.animationFrame);
		}
		super.componentWillUnmount();
	}

	/** Re-reads participant metadata when the widget configuration changes */
	onRxDataChanged(prevRxData: typeof this.state.rxData): void {
		super.onRxDataChanged(prevRxData);
		void this.refreshParticipantMeta();
	}

	private clearRestSubscriptions(): void {
		const socket = this.getSocket();
		for (const sub of this.restSubscriptions) {
			socket.unsubscribeState(sub.id, sub.cb);
		}
		this.restSubscriptions = [];
	}

	private clearSummarySubscriptions(): void {
		const socket = this.getSocket();
		for (const sub of this.summarySubscriptions) {
			socket.unsubscribeState(sub.id, sub.cb);
		}
		this.summarySubscriptions = [];
	}

	/**
	 * Subscribes the backend's measurement residual and the grid participant's current source
	 * (measured / balance) - both live in the adapter, so the widget doesn't recompute them.
	 *
	 * @param meta - the bound participants' metadata
	 */
	private async refreshSummarySubscriptions(meta: Record<string, EntityMeta>): Promise<void> {
		const socket = this.getSocket();
		this.clearSummarySubscriptions();
		const first = Object.values(meta)[0];
		this.namespace = first ? first.channelId.split(".entities.")[0] : "";
		this.residualLive = undefined;
		this.gridEstimated = false;
		if (!this.namespace) {
			return;
		}
		const watch = async (id: string, apply: (state: ioBroker.State | null | undefined) => void): Promise<void> => {
			try {
				apply(await socket.getState(id));
			} catch {
				// state not present (older adapter / no balance-capable grid) - nothing to show
			}
			const cb = (_id: string, state: ioBroker.State | null | undefined): void => {
				apply(state);
				this.tickAnimation();
			};
			socket.subscribeState(id, cb);
			this.summarySubscriptions.push({ id, cb });
		};
		await watch(`${this.namespace}.summary.balanceResidual.power`, state => {
			this.residualLive = typeof state?.val === "number" ? state.val : this.residualLive;
		});
		const grid = Object.values(meta).find(m => m.category === "grid");
		if (grid) {
			await watch(`${grid.channelId}.source`, state => {
				this.gridEstimated = state?.val === "balance";
			});
		}
	}

	private clearLossSubscriptions(): void {
		const socket = this.getSocket();
		for (const sub of this.lossSubscriptions) {
			socket.unsubscribeState(sub.id, sub.cb);
		}
		this.lossSubscriptions = [];
	}

	/**
	 * Fetches each bound state's parent channel object once (color/category/parentId), then wires up the
	 * one manual subscription per distinct parent group needed for the automatic "Sonstiges" rest arrow.
	 */
	private async refreshParticipantMeta(): Promise<void> {
		syncLanguage(this.props.context);
		const socket = this.getSocket();
		if (!socket) {
			return;
		}
		const configs = this.getParticipantConfigs();
		const meta: Record<string, EntityMeta> = {};
		await Promise.all(
			configs.map(async cfg => {
				const channelId = cfg.oid.slice(0, cfg.oid.lastIndexOf("."));
				try {
					const obj = await socket.getObject(channelId);
					if (obj) {
						const name = obj.common?.name;
						meta[cfg.oid] = {
							color: (obj.common as { color?: string })?.color || REST_COLOR_FALLBACK,
							category: asString((obj.native as { category?: string })?.category),
							parentId: asString((obj.native as { parentId?: string })?.parentId),
							name: nameOf(name, channelId),
							channelId,
						};
					}
				} catch {
					// entity object not (yet) reachable - participant is simply skipped until it is
				}
			}),
		);
		this.entityMeta = meta;
		await this.refreshSummarySubscriptions(meta);

		this.clearLossSubscriptions();
		// Candidate loss channel ids, derived the same way entityModel.deriveLossDefinitions names them
		// on the backend - most of these won't exist (efficiency left at the 100% default), which is
		// the expected, silent default case, not an error.
		const lossCandidates: { channelId: string; kind: LossMeta["kind"] }[] = [];
		for (const m of Object.values(meta)) {
			if (m.category === "producer") {
				lossCandidates.push({ channelId: `${m.channelId}_loss`, kind: "producerLoss" });
			} else if (m.category === "storage") {
				lossCandidates.push({ channelId: `${m.channelId}_chargeloss`, kind: "chargeLoss" });
				lossCandidates.push({ channelId: `${m.channelId}_dischargeloss`, kind: "dischargeLoss" });
				// measured hybrid-inverter loss (DC in − AC out), replaces the estimated ones above
				lossCandidates.push({ channelId: `${m.channelId}_inverterloss`, kind: "inverterLoss" });
			}
		}
		const lossMeta: Record<string, LossMeta> = {};
		await Promise.all(
			lossCandidates.map(async ({ channelId, kind }) => {
				try {
					const obj = await socket.getObject(channelId);
					if (obj) {
						const name = obj.common?.name;
						lossMeta[channelId] = {
							channelId,
							kind,
							color: (obj.common as { color?: string })?.color || LOSS_COLOR,
							name: nameOf(name, channelId),
						};
					}
				} catch {
					// no loss entity at this channel id - not configured (efficiency at 100%/unset), the default case
				}
			}),
		);
		this.lossMeta = lossMeta;
		await Promise.all(
			Object.keys(lossMeta).map(async channelId => {
				const powerId = `${channelId}.power`;
				try {
					const state = await socket.getState(powerId);
					this.lossValues[channelId] = typeof state?.val === "number" ? state.val : 0;
				} catch {
					this.lossValues[channelId] = 0;
				}
				const cb = (_id: string, state: ioBroker.State | null | undefined): void => {
					this.lossValues[channelId] = typeof state?.val === "number" ? state.val : 0;
					this.tickAnimation();
				};
				socket.subscribeState(powerId, cb);
				this.lossSubscriptions.push({ id: powerId, cb });
			}),
		);

		this.clearRestSubscriptions();
		// namespace ("solarcockpit.0") per parentId, taken from a child that actually points at it -
		// avoids assuming every bound participant lives under the same adapter instance.
		const namespaceByParent = new Map<string, string>();
		for (const m of Object.values(meta)) {
			if (m.parentId && !namespaceByParent.has(m.parentId)) {
				namespaceByParent.set(m.parentId, m.channelId.split(".entities.")[0]);
			}
		}
		const parentMeta: Record<string, { color: string; name: string; category: string; channelId: string }> = {};
		await Promise.all(
			[...namespaceByParent.entries()].map(async ([parentId, namespace]) => {
				try {
					const parentObj = await socket.getObject(`${namespace}.entities.${parentId}`);
					if (parentObj) {
						const name = parentObj.common?.name;
						parentMeta[parentId] = {
							color: (parentObj.common as { color?: string })?.color || REST_COLOR_FALLBACK,
							name: nameOf(name, parentId),
							category: asString((parentObj.native as { category?: string })?.category),
							channelId: `${namespace}.entities.${parentId}`,
						};
					}
				} catch {
					// parent object not (yet) reachable - rest item falls back to generic label/color below
				}
			}),
		);
		this.parentMeta = parentMeta;

		await Promise.all(
			[...namespaceByParent.entries()].map(async ([parentId, namespace]) => {
				const restId = `${namespace}.entities.${parentId}.restPower`;
				try {
					const state = await socket.getState(restId);
					this.restValues[parentId] = typeof state?.val === "number" ? state.val : 0;
				} catch {
					this.restValues[parentId] = 0;
				}
				const cb = (_id: string, state: ioBroker.State | null | undefined): void => {
					this.restValues[parentId] = typeof state?.val === "number" ? state.val : 0;
					this.tickAnimation();
				};
				socket.subscribeState(restId, cb);
				this.restSubscriptions.push({ id: restId, cb });
			}),
		);
		this.forceUpdate();
	}

	private readStateValue(oid: string): number {
		const raw = this.state.values[`${oid}.val`];
		return typeof raw === "number" ? raw : 0;
	}

	/**
	 * Smoothly eases `displayValues` towards the real live values on every render trigger - event-driven,
	 * no polling: a new animation frame is only scheduled while a tracked value is still meaningfully off.
	 */
	private tickAnimation(): void {
		if (this.animationFrame !== null) {
			return;
		}
		const step = (): void => {
			let stillMoving = false;
			for (const key of Object.keys(this.targetValues())) {
				const target = this.targetValues()[key];
				const current = this.displayValues[key] ?? target;
				const next = current + (target - current) * 0.25;
				this.displayValues[key] = Math.abs(target - next) < 0.5 ? target : next;
				if (this.displayValues[key] !== target) {
					stillMoving = true;
				}
			}
			this.forceUpdate();
			if (stillMoving) {
				this.animationFrame = requestAnimationFrame(step);
			} else {
				this.animationFrame = null;
			}
		};
		this.animationFrame = requestAnimationFrame(step);
	}

	private targetValues(): Record<string, number> {
		const targets: Record<string, number> = {};
		for (const cfg of this.getParticipantConfigs()) {
			targets[cfg.oid] = this.readStateValue(cfg.oid);
		}
		for (const parentId of Object.keys(this.restValues)) {
			targets[`rest:${parentId}`] = this.restValues[parentId];
		}
		for (const channelId of Object.keys(this.lossValues)) {
			targets[`loss:${channelId}`] = this.lossValues[channelId];
		}
		if (this.residualLive !== undefined) {
			targets.residual = this.residualLive;
		}
		return targets;
	}

	/**
	 * The value to show for a bound participant, live (animated) or historical depending on the current view mode.
	 *
	 * @param oid
	 */
	private participantValue(oid: string): number {
		if (this.viewMode === "live") {
			return this.displayValues[oid] ?? 0;
		}
		return this.historyValues[historyOidFor(oid, this.viewMode)] ?? 0;
	}

	/**
	 * The value to show for the automatic "Sonstiges" rest arrow, live or historical.
	 *
	 * @param parentId
	 */
	private restValueFor(parentId: string): number {
		if (this.viewMode === "live") {
			return this.displayValues[`rest:${parentId}`] ?? 0;
		}
		const channelId = this.parentMeta[parentId]?.channelId;
		if (!channelId) {
			return 0;
		}
		return this.historyValues[`${channelId}.${restHistorySuffix(this.viewMode)}`] ?? 0;
	}

	/**
	 * The value to show for a discovered loss item (see LossMeta), live or historical.
	 *
	 * @param channelId
	 */
	private lossValueFor(channelId: string): number {
		if (this.viewMode === "live") {
			return this.displayValues[`loss:${channelId}`] ?? 0;
		}
		return this.historyValues[historyOidFor(`${channelId}.power`, this.viewMode)] ?? 0;
	}

	/** The adapter's signed measurement residual for the current view mode, or undefined if the adapter doesn't provide it. */
	private residualValue(): number | undefined {
		if (this.viewMode === "live") {
			return this.residualLive === undefined ? undefined : (this.displayValues.residual ?? this.residualLive);
		}
		return this.namespace ? this.historyValues[`${this.namespace}.summary.balanceResidual.${historySuffix(this.viewMode)}`] : undefined;
	}

	/** Restarts the value animation when bound values change */
	componentDidUpdate(prevProps: Readonly<this["props"]>, prevState: Readonly<this["state"]>): void {
		super.componentDidUpdate(prevProps, prevState);
		this.tickAnimation();
	}

	/**
	 * Builds the SVG diagram itself - called twice per render (once for the compact card, once for
	 * the fullscreen dialog), so every generated DOM id is namespaced with `keyPrefix` to keep the
	 * two copies from clashing while both sit in the DOM at once (the dialog overlays the card,
	 * it doesn't replace it).
	 *
	 * @param keyPrefix
	 */
	private renderDiagram(keyPrefix: string): React.JSX.Element | null {
		const configs = this.getParticipantConfigs();
		if (configs.length === 0) {
			return null;
		}
		const iconColor = this.getIconColor();

		const targets = this.targetValues();
		for (const key of Object.keys(targets)) {
			if (!(key in this.displayValues)) {
				this.displayValues[key] = targets[key];
			}
		}

		type Candidate = FlowItem & { category: string; parentId: string };
		const candidates: Candidate[] = [];
		for (const cfg of configs) {
			const meta = this.entityMeta[cfg.oid];
			if (!meta) {
				continue;
			}
			candidates.push({
				key: cfg.oid,
				// While the grid measurement is down the value is the (much less reliable) balance - say so.
				label: meta.category === "grid" && this.gridEstimated ? tr("solarcockpit_rt_grid_estimated", { name: meta.name }) : meta.name,
				iconSrc: cfg.image || cfg.icon,
				size: cfg.size,
				color: meta.color,
				value: this.participantValue(cfg.oid),
				category: meta.category,
				parentId: meta.parentId,
			});
		}

		// Auto "Sonstiges" arrow for every distinct parent that has at least one selected child -
		// same category/side as its children, sourced from the parent's own restPower + color, with an
		// optional icon override (keyed by parent ID) from the "solarcockpit_group_rest_icon" field group -
		// this arrow isn't a directly configured participant, so it has no `icon<N>` field of its own.
		const restIconOverrides = this.getRestIconOverrides();
		const handledParents = new Set<string>();
		const restItems: Candidate[] = [];
		for (const c of candidates) {
			if (c.parentId && !handledParents.has(c.parentId)) {
				handledParents.add(c.parentId);
				const parent = this.parentMeta[c.parentId];
				restItems.push({
					key: `rest:${c.parentId}`,
					label: parent ? tr("solarcockpit_rt_other_of", { name: parent.name }) : tr("solarcockpit_rt_other"),
					iconSrc: restIconOverrides[c.parentId] || "",
					size: 40,
					color: parent?.color || REST_COLOR_FALLBACK,
					value: this.restValueFor(c.parentId),
					// The rest item's category is the PARENT's own (e.g. "consumer" for a house-consumption
					// meter) - never a child's, since a netted-in producer child (invertInParent) sharing the
					// same parent as consumer children would otherwise randomly flip the rest item's side.
					category: parent?.category || c.category,
					parentId: "",
				});
			}
		}
		const all = [...candidates, ...restItems];
		const deadband = this.viewMode === "live" ? DEADBAND : ENERGY_DEADBAND;
		const formatValue = this.viewMode === "live" ? formatPower : formatEnergy;

		const gridItem = all.find(c => c.category === "grid");
		const storageItem = all.find(c => c.category === "storage");
		const producers = all.filter(c => c.category === "producer");
		const consumers = all.filter(c => c.category === "consumer");

		// Loss items (see LossMeta/entityModel.deriveLossDefinitions): PV/inverter losses are tracked
		// per-producer on the backend but shown as ONE combined branch here; charge-/discharge-loss stay separate since they can differ in size and
		// are shown independently of whichever direction the main battery arrow's NET reading points.
		const lossEntries = Object.values(this.lossMeta);
		// A measured inverter loss (DC in − AC out) joins the same branch: it covers PV conversion,
		// battery conversion and the inverter's own standby consumption in one value.
		const producerLossTotal = lossEntries
			.filter(m => m.kind === "producerLoss" || m.kind === "inverterLoss")
			.reduce((sum, m) => sum + this.lossValueFor(m.channelId), 0);
		const producerLossLabel = lossEntries.some(m => m.kind === "inverterLoss") ? tr("solarcockpit_rt_inverter_loss") : tr("solarcockpit_rt_loss");
		const chargeLossMeta = lossEntries.find(m => m.kind === "chargeLoss");
		const dischargeLossMeta = lossEntries.find(m => m.kind === "dischargeLoss");
		const chargeLossValue = chargeLossMeta ? this.lossValueFor(chargeLossMeta.channelId) : 0;
		const dischargeLossValue = dischargeLossMeta ? this.lossValueFor(dischargeLossMeta.channelId) : 0;

		const gridImportActive = !!gridItem && gridItem.value > deadband;
		const gridExportActive = !!gridItem && gridItem.value < -deadband;

		const leftItems: FlowItem[] = [];
		if (gridItem && gridImportActive) {
			leftItems.push({ ...gridItem, value: gridItem.value });
		}
		for (const p of producers) {
			if (Math.abs(p.value) > deadband) {
				leftItems.push(p);
			}
		}

		const rightItems: FlowItem[] = [];
		if (gridItem && gridExportActive) {
			rightItems.push({ ...gridItem, value: -gridItem.value });
		}
		for (const c of consumers) {
			if (Math.abs(c.value) > deadband) {
				rightItems.push(c);
			}
		}

		const totalPre = leftItems.reduce((s, i) => s + i.value, 0);
		// The right side's own measured total (consumers + grid export) - NOT derived from the left side.
		// Real sensors (producer/battery registers vs. the separate house meter) never balance exactly, so
		// using a left-derived expectation here would make the right-side ribbons claim more/less height
		// than the merged flow actually delivers at SPLIT_X, showing up as a visible step at the handoff.
		const totalPost = rightItems.reduce((s, i) => s + i.value, 0);
		const storageSigned = storageItem ? storageItem.value : 0;
		const charging = !!storageItem && storageSigned > deadband;
		const discharging = !!storageItem && storageSigned < -deadband;

		const storageR = storageItem ? radiusOf(storageItem) : STORAGE_R;
		const edges: number[] = [];
		leftItems.forEach((it, i) => {
			const y = iconY(i, leftItems.length);
			const r = radiusOf(it);
			edges.push(y - r, y + r);
		});
		rightItems.forEach((it, i) => {
			const y = iconY(i, rightItems.length);
			const r = radiusOf(it);
			edges.push(y - r, y + r);
		});
		const barTopY = edges.length ? Math.min(...edges) : ICON_TOP;
		const bottomEdge = edges.length ? Math.max(...edges) : ICON_BOTTOM;
		const envelope = (bottomEdge - barTopY) * 0.7;
		const storageY = bottomEdge + 20 + storageR;

		const ref = Math.max(totalPre, totalPost, 1);
		const dyn = envelope / ref;
		const thicknessPre = totalPre * dyn;
		const thicknessPost = totalPost * dyn;

		let cum = 0;
		const leftSlices: FlowSlice[] = leftItems.map(it => {
			const th = totalPre > 0 ? thicknessPre * (it.value / totalPre) : 0;
			const top = barTopY + cum,
				bottom = top + th;
			cum += th;
			return { ...it, top, bottom, center: (top + bottom) / 2, th };
		});
		cum = 0;
		const rightSlices: FlowSlice[] = rightItems.map(it => {
			const th = totalPost > 0 ? thicknessPost * (it.value / totalPost) : 0;
			const top = barTopY + cum,
				bottom = top + th;
			cum += th;
			return { ...it, top, bottom, center: (top + bottom) / 2, th };
		});

		const gradStops = sliceGradientStops(leftItems.length ? leftItems : rightItems, totalPre || totalPost);
		const gradId = `solarcockpit-arrow-grad-${keyPrefix}`;

		// Every flow shape below also strokes itself with its own fill (1px) - adjacent shapes that
		// share an edge (e.g. the elbow path meeting the extra-post rect) otherwise render a visible
		// hairline seam where the browser anti-aliases each shape's border independently.
		const flow: React.JSX.Element[] = [];
		const icons: React.JSX.Element[] = [];

		leftItems.forEach((it, i) => {
			const y = iconY(i, leftItems.length);
			const slice = leftSlices[i];
			flow.push(
				<path
					key={`l-${it.key}`}
					d={ribbonH(LEFT_ICON_X + radiusOf(it) + 1, y, slice.th, MERGE_X, slice.center, slice.th)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			icons.push(renderIcon(LEFT_ICON_X, y, it, false, keyPrefix, formatValue, iconColor));
		});

		// Independent meters (Modbus battery vs. the separate Shelly house meter) never balance exactly,
		// and over a whole day/week the gap is usually dominated by inverter DC/AC conversion loss, not
		// battery activity - so it can point either way regardless of whether the battery is net charging
		// or discharging over that period (a small net charge/discharge can sit on top of a much bigger,
		// unrelated pre/post gap). The trunk is therefore built directly from the real thicknessPre/
		// thicknessPost boundary values rather than from "whichever side is bigger", with the elbow
		// peeling off (charging) or adding (discharging) only the real storage reading at its own
		// position, and everything else - conversion loss and sensor noise alike - absorbed by a single
		// smooth taper on either side of it. That taper is what used to be a flat, abruptly-ending rect
		// (previously sized off `Math.min`/`Math.max` of the two sides), which is what produced a visible
		// right-angle step wherever it stopped short of the thickness the neighboring ribbons actually need.
		const diff = Math.abs(thicknessPre - thicknessPost);
		const storageThickness = storageItem ? Math.min(diff, Math.abs(storageSigned) * dyn) : 0;

		if (charging && storageItem && storageThickness > 0.01) {
			const preBlockBottom = barTopY + thicknessPre;
			const storageTop = preBlockBottom - storageThickness;
			const tipY = storageY - storageR;
			const yEnd = tipY - arrowLen(storageR);
			const r = bendRadius(storageThickness);
			const xTurn = Math.max(MERGE_X + 10, STORAGE_X - r);
			if (xTurn > MERGE_X) {
				flow.push(
					<rect
						key="pre-block"
						x={MERGE_X}
						y={barTopY}
						width={xTurn - MERGE_X}
						height={thicknessPre}
						fill={`url(#${gradId})`}
						stroke={`url(#${gradId})`}
						strokeWidth={3}
					/>,
				);
			}
			flow.push(
				<path
					key="elbow"
					d={elbowDown(xTurn, storageTop, preBlockBottom, yEnd, r)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			flow.push(
				<polygon
					key="arrow-storage"
					points={flaredArrowPoints(STORAGE_X, tipY, 90, storageThickness, storageR)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			if (xTurn < SPLIT_X) {
				flow.push(
					<path
						key="taper"
						d={topTaper(xTurn, SPLIT_X, barTopY, thicknessPre - storageThickness, thicknessPost)}
						fill={`url(#${gradId})`}
						stroke={`url(#${gradId})`}
						strokeWidth={3}
					/>,
				);
			}
			icons.push(renderIcon(STORAGE_X, storageY, storageItem, true, keyPrefix, formatValue, iconColor));
		} else if (discharging && storageItem && storageThickness > 0.01) {
			const elbowTop = barTopY + thicknessPre;
			const elbowBottom = elbowTop + storageThickness;
			const yEnd = storageY - storageR - 1;
			const r = Math.min(bendRadius(storageThickness), SPLIT_X - 10 - STORAGE_X);
			const elbow = elbowUpLeft(STORAGE_X, elbowTop, elbowBottom, yEnd, r);
			if (elbow.xTurn > MERGE_X) {
				flow.push(
					<rect
						key="pre-block"
						x={MERGE_X}
						y={barTopY}
						width={elbow.xTurn - MERGE_X}
						height={thicknessPre}
						fill={`url(#${gradId})`}
						stroke={`url(#${gradId})`}
						strokeWidth={3}
					/>,
				);
			}
			flow.push(
				<path
					key="elbow"
					d={elbow.d}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			if (elbow.xTurn < SPLIT_X) {
				flow.push(
					<path
						key="taper"
						d={topTaper(elbow.xTurn, SPLIT_X, barTopY, thicknessPre + storageThickness, thicknessPost)}
						fill={`url(#${gradId})`}
						stroke={`url(#${gradId})`}
						strokeWidth={3}
					/>,
				);
			}
			icons.push(renderIcon(STORAGE_X, storageY, storageItem, true, keyPrefix, formatValue, iconColor));
		} else if (thicknessPre > 0 || thicknessPost > 0) {
			// No active storage branch to explain the pre/post mismatch (no storage participant configured,
			// or its net reading is below the deadband) - a single taper still bridges thicknessPre at
			// MERGE_X to thicknessPost at SPLIT_X without claiming any of that gap as battery flow.
			flow.push(
				<path
					key="core-taper"
					d={topTaper(MERGE_X, SPLIT_X, barTopY, thicknessPre, thicknessPost)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
		}

		// Top of the drawing: the loss/residual icons sit ABOVE the trunk, which itself starts close to
		// y=0 - without extending the viewBox their labels end up at negative y and are clipped
		// wherever the SVG doesn't overflow visibly (e.g. the full-screen dialog).
		let contentTop = 0;
		const peelOffTop = barTopY - PEEL_OFF_RISE - PEEL_OFF_LABEL_ROOM;

		if (producerLossTotal > deadband) {
			contentTop = Math.min(contentTop, peelOffTop);
			const lossThickness = Math.max(1.5, producerLossTotal * dyn);
			const fromX = Math.min(MERGE_X + 20, TAP_X - 10);
			pushPeelOff(
				flow,
				icons,
				"pv-loss",
				fromX,
				barTopY,
				fromX + 40,
				barTopY - PEEL_OFF_RISE,
				lossThickness,
				LOSS_COLOR,
				producerLossLabel,
				producerLossTotal,
				keyPrefix,
				formatValue,
				iconColor,
			);
		}

		// Charge-/discharge-loss are shown independently of the main battery arrow's NET direction
		// (charging vs. discharging above) - a historical period can contain both, and each is shown
		// on its own whenever it individually clears the deadband, not only whichever direction
		// happens to be net for the period.
		if (storageItem) {
			const anchorY = storageY - storageR - 15;
			if (chargeLossValue > deadband) {
				const thickness = Math.max(1.5, chargeLossValue * dyn);
				pushPeelOff(
					flow,
					icons,
					"charge-loss",
					STORAGE_X,
					anchorY,
					STORAGE_X - 90,
					storageY - 70,
					thickness,
					LOSS_COLOR,
					tr("solarcockpit_rt_charge_loss"),
					chargeLossValue,
					keyPrefix,
					formatValue,
					iconColor,
				);
			}
			if (dischargeLossValue > deadband) {
				const thickness = Math.max(1.5, dischargeLossValue * dyn);
				pushPeelOff(
					flow,
					icons,
					"discharge-loss",
					STORAGE_X,
					anchorY,
					STORAGE_X + 90,
					storageY - 70,
					thickness,
					LOSS_COLOR,
					tr("solarcockpit_rt_discharge_loss"),
					dischargeLossValue,
					keyPrefix,
					formatValue,
					iconColor,
				);
			}
		}

		// "Messabweichung" (formerly "Rest-Diagnose"): what the measurements together don't explain -
		// meaningful since the grid is measured independently (Tibber Pulse, 2026-10-31); while the grid
		// itself comes from the balance it is ~0 by construction. Positioned neutrally in the trunk's
		// own center (TAP_X) rather than near the battery so it doesn't visually imply a cause.
		// Prefer the adapter's own signed residual (summary.balanceResidual.*, one formula for live,
		// history and InfluxDB - see entityModel.computeBalance); the widget-side arithmetic remains
		// only as the fallback for an older adapter without those states.
		const explainedThickness = storageThickness + producerLossTotal * dyn + chargeLossValue * dyn + dischargeLossValue * dyn;
		const backendResidual = this.residualValue();
		const residualValue = backendResidual !== undefined ? Math.abs(backendResidual) : dyn > 0 ? Math.max(0, diff - explainedThickness) / dyn : 0;
		const residualThickness = residualValue * dyn;
		const diagnosticDeadband = this.viewMode === "live" ? DIAGNOSTIC_DEADBAND : DIAGNOSTIC_ENERGY_DEADBAND;
		if (residualValue > diagnosticDeadband) {
			contentTop = Math.min(contentTop, peelOffTop);
			const direction =
				backendResidual === undefined ? "" : backendResidual > 0 ? tr("solarcockpit_rt_residual_more_supply") : tr("solarcockpit_rt_residual_more_use");
			pushPeelOff(
				flow,
				icons,
				"rest-diagnose",
				TAP_X,
				barTopY,
				TAP_X,
				barTopY - PEEL_OFF_RISE,
				Math.max(1.5, residualThickness),
				REST_COLOR_FALLBACK,
				tr("solarcockpit_rt_residual"),
				residualValue,
				keyPrefix,
				formatValue,
				iconColor,
			);
			const residualIcon = icons.pop();
			icons.push(
				<g key={`${keyPrefix}-residual-tip`}>
					<title>{`${tr("solarcockpit_rt_residual_explained")}${direction ? `\n${direction}` : ""}\n${tr("solarcockpit_rt_residual_selfuse")}`}</title>
					{residualIcon}
				</g>,
			);
		}

		rightItems.forEach((it, i) => {
			const y = iconY(i, rightItems.length);
			const slice = rightSlices[i];
			const r = radiusOf(it);
			const tipX = RIGHT_ICON_X - r;
			flow.push(
				<path
					key={`r-${it.key}`}
					d={ribbonH(SPLIT_X, slice.center, slice.th, tipX - arrowLen(r), y, slice.th)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			flow.push(
				<polygon
					key={`ra-${it.key}`}
					points={flaredArrowPoints(tipX, y, 0, slice.th, r)}
					fill={`url(#${gradId})`}
					stroke={`url(#${gradId})`}
					strokeWidth={3}
				/>,
			);
			icons.push(renderIcon(RIGHT_ICON_X, y, it, false, keyPrefix, formatValue, iconColor));
		});

		return (
			<svg
				viewBox={`0 ${contentTop} ${VIEW_W} ${VIEW_H - contentTop}`}
				style={{ width: "100%", height: "100%", display: "block" }}
			>
				<defs>
					<linearGradient
						id={gradId}
						gradientUnits="userSpaceOnUse"
						x1={LEFT_ICON_X}
						y1={0}
						x2={RIGHT_ICON_X}
						y2={0}
					>
						{gradStops.map((s, i) => (
							<stop
								key={i}
								offset={s.offset}
								stopColor={s.color}
							/>
						))}
					</linearGradient>
				</defs>
				<g>{flow}</g>
				<g>{icons}</g>
			</svg>
		);
	}

	/** Renders the widget */
	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
		super.renderWidgetBody(props);
		syncLanguage(this.props.context);

		const compactDiagram = this.renderDiagram(props.id);
		if (!compactDiagram) {
			return (
				<Card sx={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", p: 2, boxSizing: "border-box" }}>
					<span style={{ opacity: 0.6, textAlign: "center" }}>{tr("solarcockpit_rt_configure_participants")}</span>
				</Card>
			);
		}

		return (
			<>
				<Card
					sx={{ width: "100%", height: "100%" }}
					elevation={2}
				>
					<CardActionArea
						onClick={this.openFullscreen}
						disabled={this.props.editMode}
						title={tr("solarcockpit_rt_open_fullscreen")}
						sx={{ width: "100%", height: "100%", "&.Mui-disabled": { opacity: 1 } }}
					>
						{compactDiagram}
					</CardActionArea>
				</Card>
				<Dialog
					fullScreen
					open={this.fullscreen}
					onClose={this.closeFullscreen}
				>
					<IconButton
						onClick={this.closeFullscreen}
						title={tr("solarcockpit_rt_close_fullscreen")}
						sx={{ position: "absolute", top: 8, right: 8, zIndex: 1, fontSize: 22, color: "text.primary" }}
					>
						✕
					</IconButton>
					<div style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
						<ToggleButtonGroup
							value={this.viewMode}
							exclusive
							size="small"
							onChange={(_e, mode: ViewMode | null) => {
								if (mode) {
									this.setViewMode(mode);
								}
							}}
							sx={{ alignSelf: "center" }}
						>
							<ToggleButton value="live">{tr("solarcockpit_rt_now")}</ToggleButton>
							<ToggleButton value="today">{tr("solarcockpit_rt_today")}</ToggleButton>
							<ToggleButton value="yesterday">{tr("solarcockpit_rt_yesterday")}</ToggleButton>
							<ToggleButton value="last7days">{tr("solarcockpit_rt_7days")}</ToggleButton>
						</ToggleButtonGroup>
						<div style={{ flex: 1, minHeight: 0 }}>{this.renderDiagram(`${props.id}-fs`)}</div>
					</div>
				</Dialog>
			</>
		);
	}
}

function renderIcon(
	x: number,
	y: number,
	item: FlowItem,
	big: boolean,
	keyPrefix: string,
	formatValue: (v: number) => string,
	iconColor: string,
): React.JSX.Element {
	const r = radiusOf(item);
	const labelY = big ? y + r + 16 : y - r - 20;
	const valueY = big ? labelY + 14 : y - r - 6;
	const clipId = `ef-arrow-clip-${keyPrefix}-${item.key}`;
	const svgIcon = item.iconSrc ? getNamespacedSvgIcon(item.iconSrc, clipId) : null;
	return (
		<g key={item.key}>
			<circle
				cx={x}
				cy={y}
				r={r}
				fill={item.color}
				fillOpacity={0.18}
				stroke={item.color}
				strokeWidth={1.5}
			/>
			{item.iconSrc ? (
				<>
					<clipPath id={clipId}>
						<circle
							cx={x}
							cy={y}
							r={r - 2}
						/>
					</clipPath>
					{svgIcon ? (
						// `clip-path` is applied on a wrapping <g>, not on the nested <svg> directly - a nested
						// `<svg>` establishes its own viewport (via `viewBox`), and Chrome doesn't apply a
						// `userSpaceOnUse` clip-path to that combination the way it does for a plain `<g>` or an
						// `<image>` (used below) - it silently suppresses the whole element's rendering instead.
						<g clipPath={`url(#${clipId})`}>
							<svg
								x={x - r + 2}
								y={y - r + 2}
								width={(r - 2) * 2}
								height={(r - 2) * 2}
								viewBox={svgIcon.viewBox}
								preserveAspectRatio="xMidYMid slice"
								style={{ color: iconColor }}
								// Trusted content: an admin-configured icon from vis-2's own Material Icon Selector, not end-user input
								dangerouslySetInnerHTML={{ __html: svgIcon.markup }}
							/>
						</g>
					) : (
						<image
							href={item.iconSrc}
							x={x - r + 2}
							y={y - r + 2}
							width={(r - 2) * 2}
							height={(r - 2) * 2}
							clipPath={`url(#${clipId})`}
							preserveAspectRatio="xMidYMid slice"
						/>
					)}
				</>
			) : null}
			<text
				x={x}
				y={labelY}
				textAnchor="middle"
				fontSize={12.5}
				fontWeight={700}
				fill="var(--solarcockpit-label, #37474f)"
			>
				{item.label}
			</text>
			<text
				x={x}
				y={valueY}
				textAnchor="middle"
				fontSize={11.5}
				fill="var(--solarcockpit-value, #607083)"
			>
				{formatValue(item.value)}
			</text>
		</g>
	);
}
