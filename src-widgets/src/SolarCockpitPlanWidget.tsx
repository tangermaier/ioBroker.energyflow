import { syncLanguage, tr } from "./lib/i18n";
import React from "react";

import type { RxRenderWidgetProps, RxWidgetInfo, VisRxWidgetState } from "@iobroker/types-vis-2";
import type VisRxWidget from "@iobroker/types-vis-2/visRxWidget";
import Card from "@mui/material/Card";

import { EnergyPlanChart, type PlanLayers } from "./lib/EnergyPlanChart";
import { EnergyPlanDialog } from "./lib/EnergyPlanDialog";
import { de, hhmm, levelLabel, MODE_STYLE, modeLabel, parsePlan, relativeTime } from "./lib/plan";

interface SolarCockpitPlanRxData {
	oidPlan: string;
	oidStatus: string;
	oidFlexStart: string;
	oidFlexEnd: string;
	oidText: string;
	showPrice: boolean;
	showPvLoad: boolean;
	showSoc: boolean;
	showModes: boolean;
	showMarginal: boolean;
	showFlex: boolean;
	compact: boolean;
}

/**
 * "Energieplan" widget: the adapter's advisory energy plan (plan.json) drawn directly in the
 * tile - prices, PV forecast vs. load profile, planned SoC and mode band - with a one-line
 * header (current mode + price). Clicking opens the fullscreen dialog with layer toggles and the
 * recommendation text. Layers and a compact mode for small tiles are configurable.
 */
export default class SolarCockpitPlanWidget extends (window.visRxWidget as typeof VisRxWidget)<SolarCockpitPlanRxData, VisRxWidgetState> {
	static adapter: string;

	private fullscreen = false;

	private readonly openFullscreen = (): void => {
		if (!this.props.editMode) {
			this.fullscreen = true;
			this.forceUpdate();
		}
	};

	private readonly closeFullscreen = (): void => {
		this.fullscreen = false;
		this.forceUpdate();
	};

	/** Static widget description for the vis-2 palette and attribute editor. */
	static getWidgetInfo(): RxWidgetInfo {
		return {
			id: "tplSolarCockpitPlan",
			visSet: "solarcockpit",
			visSetLabel: "set_label",
			visSetColor: "#ff9800",
			visName: "SolarCockpitPlanWidget",
			visWidgetLabel: "widget_label_plan",
			visAttrs: [
				{
					name: "plan",
					label: "solarcockpit_group_plan",
					fields: [
						{ name: "oidPlan", type: "id", label: "solarcockpit_oid_plan", default: "solarcockpit.0.plan.json" },
						{ name: "oidStatus", type: "id", label: "solarcockpit_oid_plan_status", default: "solarcockpit.0.plan.status" },
						{ name: "oidFlexStart", type: "id", label: "solarcockpit_oid_flex_start", default: "solarcockpit.0.recommendation.flexWindowStart" },
						{ name: "oidFlexEnd", type: "id", label: "solarcockpit_oid_flex_end", default: "solarcockpit.0.recommendation.flexWindowEnd" },
						{ name: "oidText", type: "id", label: "solarcockpit_oid_recommendation", default: "solarcockpit.0.recommendation.text" },
					],
				},
				{
					name: "layers",
					label: "solarcockpit_group_plan_layers",
					fields: [
						{ name: "showPrice", type: "checkbox", label: "solarcockpit_plan_show_price", default: true },
						{ name: "showPvLoad", type: "checkbox", label: "solarcockpit_plan_show_pvload", default: true },
						{ name: "showSoc", type: "checkbox", label: "solarcockpit_plan_show_soc", default: true },
						{ name: "showModes", type: "checkbox", label: "solarcockpit_plan_show_modes", default: true },
						{ name: "showMarginal", type: "checkbox", label: "solarcockpit_plan_show_marginal", default: false },
						{ name: "showFlex", type: "checkbox", label: "solarcockpit_plan_show_flex", default: true },
						{ name: "compact", type: "checkbox", label: "solarcockpit_plan_compact", default: false },
					],
				},
			],
			visDefaultStyle: { width: 520, height: 300 },
			visPrev: "widgets/solarcockpit/img/vis-solarcockpit-forecast.png",
		};
	}

	/** Instance accessor required by vis-2 - delegates to the static widget info. */
	getWidgetInfo(): RxWidgetInfo {
		return SolarCockpitPlanWidget.getWidgetInfo();
	}

	/** Translation key prefix (adapter name + "_"), prepended by vis-2 to every label key. */
	static getI18nPrefix(): string {
		return `${SolarCockpitPlanWidget.adapter}_`;
	}

	/**
	 * Renders the plan tile (header line + chart) and, when opened, the fullscreen dialog.
	 *
	 * @param props - render props from vis-2
	 */
	renderWidgetBody(props: RxRenderWidgetProps): React.JSX.Element {
		super.renderWidgetBody(props);
		syncLanguage(this.props.context);
		const d = this.state.rxData;
		const val = (oid: string): unknown => (oid ? this.state.values[`${oid}.val`] : undefined);
		const slots = parsePlan(val(d.oidPlan));
		const status = typeof val(d.oidStatus) === "string" ? (val(d.oidStatus) as string) : undefined;
		const flexStart = typeof val(d.oidFlexStart) === "number" ? (val(d.oidFlexStart) as number) : undefined;
		const flexEnd = typeof val(d.oidFlexEnd) === "number" ? (val(d.oidFlexEnd) as number) : undefined;
		const text = typeof val(d.oidText) === "string" ? (val(d.oidText) as string) : undefined;
		// rxData checkboxes are undefined until first saved in the editor -> treat undefined as the field default.
		const on = (v: boolean | undefined, def: boolean): boolean => (v === undefined ? def : !!v);
		const layers: PlanLayers = {
			price: on(d.showPrice, true),
			pvLoad: on(d.showPvLoad, true),
			soc: on(d.showSoc, true),
			modes: on(d.showModes, true),
			marginal: on(d.showMarginal, false),
			flex: on(d.showFlex, true),
		};
		const compact = !!d.compact;
		const now = Date.now();
		const current = slots.find(s => s.start <= now && now < s.end) ?? slots[0];

		return (
			<>
				<Card
					sx={{
						width: "100%",
						height: "100%",
						display: "flex",
						flexDirection: "column",
						p: 1,
						boxSizing: "border-box",
						cursor: this.props.editMode ? "default" : "pointer",
					}}
					elevation={2}
					onClick={this.openFullscreen}
					title={tr("solarcockpit_rt_open_fullscreen")}
				>
					{current && (
						<div
							style={{
								display: "flex",
								justifyContent: "space-between",
								flexWrap: "wrap",
								gap: "0 8px",
								fontSize: compact ? 10 : 12,
								padding: "0 4px 4px",
								color: "var(--solarcockpit-label, #37474f)",
							}}
						>
							<span>
								<span style={{ color: MODE_STYLE[current.mode].color }}>■</span> {modeLabel(current.mode)}
								{!compact && ` · ${tr("solarcockpit_rt_soc_value", { soc: de(current.soc, 0) })}`}
							</span>
							{layers.flex && flexStart && flexEnd ? (
								<span style={{ color: "#4cc9f0", whiteSpace: "nowrap" }}>
									{tr("solarcockpit_rt_appliance_window_colon", { start: relativeTime(flexStart), end: hhmm(flexEnd) })}
								</span>
							) : null}
							<span style={{ whiteSpace: "nowrap" }}>
								{de(current.price, 1)} ct/kWh{current.level && !compact ? ` · ${levelLabel(current.level)}` : ""}
							</span>
						</div>
					)}
					<div style={{ flex: 1, minHeight: 0 }}>
						<EnergyPlanChart
							slots={slots}
							layers={layers}
							flexStart={flexStart}
							flexEnd={flexEnd}
							compact={compact}
						/>
					</div>
				</Card>
				{this.fullscreen && (
					<EnergyPlanDialog
						open
						onClose={this.closeFullscreen}
						slots={slots}
						initialLayers={layers}
						flexStart={flexStart}
						flexEnd={flexEnd}
						text={text}
						status={status}
					/>
				)}
			</>
		);
	}
}
