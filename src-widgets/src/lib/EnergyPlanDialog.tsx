import { tr } from "./i18n";
import React from "react";

import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";

import { EnergyPlanChart, PlanLayerToggles, type PlanLayers } from "./EnergyPlanChart";
import type { PlanSlot } from "./plan";

/**
 * Fullscreen view of the energy plan: layer toggles, the chart and the recommendation text.
 * Shared by EnergyPlanWidget and EnergyFlowWidget.
 *
 * @param props - dialog state and plan data
 * @param props.open - whether the dialog is shown
 * @param props.onClose - close handler
 * @param props.slots - parsed plan slots
 * @param props.initialLayers - layers enabled when the dialog opens
 * @param props.flexStart - recommended flexible-load start (ms)
 * @param props.flexEnd - recommended flexible-load end (ms)
 * @param props.text - recommendation text shown under the chart
 * @param props.status - plan.status value (shown when not "ok")
 */
export function EnergyPlanDialog(props: {
	open: boolean;
	onClose: () => void;
	slots: PlanSlot[];
	initialLayers: PlanLayers;
	flexStart?: number;
	flexEnd?: number;
	text?: string;
	status?: string;
}): React.JSX.Element {
	// Callers mount this only while open, so the layers reset to the widget's configuration on every open.
	const [layers, setLayers] = React.useState<PlanLayers>(props.initialLayers);

	return (
		<Dialog
			fullScreen
			open={props.open}
			onClose={props.onClose}
		>
			<IconButton
				onClick={props.onClose}
				title={tr("energyflow_rt_close_fullscreen")}
				sx={{ position: "absolute", top: 8, right: 8, zIndex: 1, fontSize: 22, color: "text.primary" }}
			>
				✕
			</IconButton>
			<div
				style={{ width: "100%", height: "100%", boxSizing: "border-box", padding: "24px 24px 16px", display: "flex", flexDirection: "column", gap: 12 }}
			>
				<div style={{ fontSize: 16, fontWeight: 600, textAlign: "center" }}>{tr("energyflow_rt_energy_plan")}</div>
				<PlanLayerToggles
					layers={layers}
					onChange={setLayers}
				/>
				<div style={{ flex: 1, minHeight: 0 }}>
					<EnergyPlanChart
						slots={props.slots}
						layers={layers}
						flexStart={props.flexStart}
						flexEnd={props.flexEnd}
					/>
				</div>
				{props.status && props.status !== "ok" && (
					<div style={{ fontSize: 12, textAlign: "center", opacity: 0.7 }}>
						{props.status === "noBattery" ? tr("energyflow_rt_no_battery") : tr("energyflow_rt_no_prices")}
					</div>
				)}
				{props.text && <div style={{ fontSize: 13, lineHeight: 1.45, textAlign: "center", maxWidth: 900, alignSelf: "center" }}>{props.text}</div>}
			</div>
		</Dialog>
	);
}
