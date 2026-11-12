import { syncLanguage, tr } from "./lib/i18n";
import React from "react";

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetState } from "@iobroker/types-vis-2";
import type VisRxWidget from "@iobroker/types-vis-2/visRxWidget";
import Card from "@mui/material/Card";
import CardActionArea from "@mui/material/CardActionArea";

import solarcockpitIcon from "./assets/solarcockpit-icon.png";
import { formatPower } from "./lib/format";

/** The vis-2 view holding the standalone 2.5D scene (src-scene, embedded via vis-2's iFrame widget) - opened by clicking the diagram. */
const SCENE_VIEW = "SolarCockpit3D";

interface SolarCockpitYieldRxData {
	oidProducer: string;
	oidConsumer: string;
	oidStorage: string;
	oidGrid: string;
	/** "measured" | "balance" - shows the "≈ geschätzt" hint while the grid runs on the balance */
	oidGridSource: string;
}

interface NodePos {
	x: number;
	y: number;
}

/** Center-to-node geometry for the four category nodes around the house hub. */
const HUB: NodePos = { x: 150, y: 150 };
const HUB_RADIUS = 34;
const NODE_RADIUS = 26;
const NODES: Record<"producer" | "consumer" | "storage" | "grid", NodePos> = {
	producer: { x: 150, y: 36 },
	grid: { x: 36, y: 150 },
	storage: { x: 264, y: 150 },
	consumer: { x: 150, y: 264 },
};

/**
 * Pulls both ends of a segment in along its own direction, so a line drawn between two circles'
 * CENTERS stops at their RIMS instead of running underneath the circles into their middles - the
 * circles are semi-transparent (see the node fill opacity below), so a line running all the way
 * to center would visibly show through.
 *
 * @param from - the segment's start point (a circle's center)
 * @param to - the segment's end point (another circle's center)
 * @param fromRadius - how far to pull the start point in, along the segment
 * @param toRadius - how far to pull the end point in, along the segment
 */
function trimToRims(from: NodePos, to: NodePos, fromRadius: number, toRadius: number): { from: NodePos; to: NodePos } {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const dist = Math.hypot(dx, dy) || 1;
	const ux = dx / dist;
	const uy = dy / dist;
	return {
		from: { x: from.x + ux * fromRadius, y: from.y + uy * fromRadius },
		to: { x: to.x - ux * toRadius, y: to.y - uy * toRadius },
	};
}

/**
 * Node label in the current language (own runtime lookup, see lib/i18n.ts - the vis-2 host's
 * dictionary lookup proved unreliable for runtime texts across reloads).
 *
 * @param key - node key
 */
function nodeLabel(key: keyof typeof NODES): string {
	return tr(`solarcockpit_rt_node_${key}`);
}

/**
 * Number of traveling dots to render on an edge, scaled by power magnitude so a stronger
 * flow visibly looks busier rather than just faster.
 *
 * @param watts - power magnitude in Watt
 */
function dotCount(watts: number): number {
	return Math.min(6, Math.max(1, Math.round(Math.abs(watts) / 600) + 1));
}

/**
 * Animation duration in seconds for a traveling dot, scaled inversely by power magnitude
 * (more power -> faster dots), clamped to a readable range.
 *
 * @param watts - power magnitude in Watt
 */
function flowDuration(watts: number): number {
	const magnitude = Math.max(Math.abs(watts), 1);
	return Math.min(4, Math.max(0.7, 3000 / magnitude));
}

/**
 * One animated edge between the house hub and a category node. `from`/`to` are always HUB/node
 * respectively; `reversed` flips which end the dots travel FROM (e.g. grid export instead of
 * import, battery charging instead of discharging, or a producer feeding the hub) - it does not
 * change which physical circle is "from" for trimming purposes.
 *
 * @param props
 * @param props.from
 * @param props.to
 * @param props.active
 * @param props.reversed
 * @param props.watts
 * @param props.color
 * @param props.pathId
 */
function FlowEdge(props: { from: NodePos; to: NodePos; active: boolean; reversed: boolean; watts: number; color: string; pathId: string }): React.JSX.Element {
	const { from, to, active, reversed, watts, color, pathId } = props;
	const { from: rimFrom, to: rimTo } = trimToRims(from, to, HUB_RADIUS, NODE_RADIUS);
	const start = reversed ? rimTo : rimFrom;
	const end = reversed ? rimFrom : rimTo;
	const count = dotCount(watts);
	const duration = flowDuration(watts);

	return (
		<>
			<line
				x1={rimFrom.x}
				y1={rimFrom.y}
				x2={rimTo.x}
				y2={rimTo.y}
				stroke="var(--solarcockpit-edge, #8892a0)"
				strokeWidth={active ? 3 : 1.5}
				opacity={active ? 0.9 : 0.35}
			/>
			<path
				id={pathId}
				d={`M ${start.x} ${start.y} L ${end.x} ${end.y}`}
				fill="none"
				stroke="none"
			/>
			{active &&
				Array.from({ length: count }).map((_, i) => (
					<circle
						key={`${pathId}-${i}`}
						r={4}
						fill={color}
					>
						<animateMotion
							dur={`${duration}s`}
							begin={`${(i * duration) / count}s`}
							repeatCount="indefinite"
						>
							<mpath href={`#${pathId}`} />
						</animateMotion>
					</circle>
				))}
		</>
	);
}

/**
 * Standalone energy-flow card: the four-node SVG diagram only (producer/grid/storage/consumer
 * around a house hub). Split out from SolarCockpitForecastWidget (which now covers forecast/weather/
 * recommendation) so it can be placed on a dashboard independently, matching the "one focused
 * widget per concern" shape of vis-2-widgets-energy's own flow-diagram widget. The whole card is
 * clickable - it doubles as the entry point into the full 2.5D scene (src-scene), which is not a
 * vis-2 widget itself and would otherwise have no obvious way to be reached from a dashboard.
 */
export default class SolarCockpitYieldWidget extends (window.visRxWidget as typeof VisRxWidget)<SolarCockpitYieldRxData, VisRxWidgetState> {
	static adapter: string;

	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplSolarCockpitYield",
			visSet: "solarcockpit",
			visSetLabel: "set_label",
			visSetColor: "#ff9800",
			visName: "SolarCockpitYieldWidget",
			visWidgetLabel: "widget_label_yield",
			visAttrs: [
				{
					name: "oids",
					label: "solarcockpit_group_oids",
					fields: [
						{ name: "oidProducer", type: "id", label: "solarcockpit_oid_producer", default: "solarcockpit.0.summary.producer.power" },
						{ name: "oidConsumer", type: "id", label: "solarcockpit_oid_consumer", default: "solarcockpit.0.summary.consumer.power" },
						{ name: "oidStorage", type: "id", label: "solarcockpit_oid_storage", default: "solarcockpit.0.summary.storage.power" },
						{ name: "oidGrid", type: "id", label: "solarcockpit_oid_grid", default: "solarcockpit.0.summary.grid.power" },
						{ name: "oidGridSource", type: "id", label: "solarcockpit_oid_grid_source", default: "solarcockpit.0.summary.grid.source" },
					],
				},
			],
			visPrev: "widgets/solarcockpit/img/vis-solarcockpit-yield.png",
		};
	}

	/** vis-2 widget metadata (editor attributes and preview) */
	getWidgetInfo(): RxWidgetInfo {
		return SolarCockpitYieldWidget.getWidgetInfo();
	}

	static getI18nPrefix(): string {
		return `${SolarCockpitYieldWidget.adapter}_`;
	}

	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
		super.renderWidgetBody(props);
		syncLanguage(this.props.context);

		const hubClipId = `solarcockpit-hub-clip-${props.id}`;
		const { oidProducer, oidConsumer, oidStorage, oidGrid, oidGridSource } = this.state.rxData;
		const gridEstimated = !!oidGridSource && this.state.values[`${oidGridSource}.val`] === "balance";

		if (!oidProducer && !oidConsumer && !oidStorage && !oidGrid) {
			return (
				<Card sx={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", p: 2, boxSizing: "border-box" }}>
					<span style={{ opacity: 0.6, textAlign: "center" }}>{tr("solarcockpit_rt_configure_diagram")}</span>
				</Card>
			);
		}

		const valueOf = (oid: string): number => {
			const raw = this.state.values[`${oid}.val`];
			return typeof raw === "number" ? raw : 0;
		};

		const producer = valueOf(oidProducer);
		const consumer = valueOf(oidConsumer);
		const storage = valueOf(oidStorage);
		const grid = valueOf(oidGrid);

		const DEADBAND_W = 5;

		return (
			<Card
				sx={{ width: "100%", height: "100%" }}
				elevation={2}
			>
				<CardActionArea
					onClick={() => {
						window.location.hash = SCENE_VIEW;
					}}
					disabled={this.props.editMode}
					title={tr("solarcockpit_rt_open_3d")}
					sx={{
						width: "100%",
						height: "100%",
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						"&.Mui-disabled": { opacity: 1 },
					}}
				>
					<svg
						viewBox="0 0 300 300"
						style={{ width: "100%", height: "100%", maxWidth: 420, maxHeight: 420 }}
					>
						<FlowEdge
							from={HUB}
							to={NODES.producer}
							active={producer > DEADBAND_W}
							reversed={true}
							watts={producer}
							color="#ffb703"
							pathId="ef-producer"
						/>
						<FlowEdge
							from={HUB}
							to={NODES.grid}
							active={Math.abs(grid) > DEADBAND_W}
							reversed={grid > 0}
							watts={grid}
							color="#8ecae6"
							pathId="ef-grid"
						/>
						<FlowEdge
							from={HUB}
							to={NODES.storage}
							active={Math.abs(storage) > DEADBAND_W}
							reversed={storage < 0}
							watts={storage}
							color="#06d6a0"
							pathId="ef-storage"
						/>
						<FlowEdge
							from={HUB}
							to={NODES.consumer}
							active={Math.abs(consumer) > DEADBAND_W}
							reversed={false}
							watts={consumer}
							color="#ef476f"
							pathId="ef-consumer"
						/>

						<defs>
							<clipPath id={hubClipId}>
								<circle
									cx={HUB.x}
									cy={HUB.y}
									r={32}
								/>
							</clipPath>
						</defs>
						<circle
							cx={HUB.x}
							cy={HUB.y}
							r={34}
							fill="var(--solarcockpit-hub, #263238)"
						/>
						<image
							href={solarcockpitIcon}
							x={HUB.x - 32}
							y={HUB.y - 32}
							width={64}
							height={64}
							clipPath={`url(#${hubClipId})`}
							preserveAspectRatio="xMidYMid slice"
						/>

						{(
							[
								["producer", producer, "#ffb703"],
								["grid", grid, "#8ecae6"],
								["storage", storage, "#06d6a0"],
								["consumer", consumer, "#ef476f"],
							] as [keyof typeof NODES, number, string][]
						).map(([key, watts, color]) => (
							<g key={key}>
								<circle
									cx={NODES[key].x}
									cy={NODES[key].y}
									r={26}
									fill={color}
									opacity={0.15}
									stroke={color}
									strokeWidth={2}
								/>
								<text
									x={NODES[key].x}
									y={NODES[key].y - 4}
									textAnchor="middle"
									fontSize={10}
									fill="var(--solarcockpit-label, #37474f)"
								>
									{key === "grid" && gridEstimated ? `≈ ${nodeLabel(key)}` : nodeLabel(key)}
								</text>
								{key === "grid" && gridEstimated && (
									<text
										x={NODES[key].x}
										y={NODES[key].y + 38}
										textAnchor="middle"
										fontSize={8}
										fill="var(--solarcockpit-label, #37474f)"
									>
										<title>{tr("solarcockpit_rt_grid_estimated_hint")}</title>
										geschätzt
									</text>
								)}
								<text
									x={NODES[key].x}
									y={NODES[key].y + 10}
									textAnchor="middle"
									fontSize={11}
									fontWeight={600}
									fill="var(--solarcockpit-value, #102027)"
								>
									{formatPower(watts)}
								</text>
							</g>
						))}
					</svg>
				</CardActionArea>
			</Card>
		);
	}
}
