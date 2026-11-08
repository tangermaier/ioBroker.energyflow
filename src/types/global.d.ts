import type { EntityRowConfig } from "../lib/entityModel.js";

// Augments the ioBroker adapter config type with the shape of our own
// admin/jsonConfig.json (native.EntitiesList).
declare global {
	namespace ioBroker {
		interface AdapterConfig {
			EntitiesList: EntityRowConfig[];
			historyInstance: string;
			oidGridPurchasePrice: string;
			oidFeedInTariff: string;
			useTibber: boolean;
			tibberInstance: string;
			tibberHomeId: string;
			flexLoadDurationH: number;
			flexLoadPowerKW: number;
			maxGridExportW: number;
			forecastHistoryDays: number;
			colorForecast: string;
			colorActual: string;
		}
	}
}

export {};
