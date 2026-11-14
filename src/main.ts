// The adapter-core module gives you access to the core ioBroker functions you need to create an adapter
import { setLanguage, tAll } from "./lib/i18n/i18n.js";
import * as utils from "@iobroker/adapter-core";
import { BuildingManager } from "./lib/buildings/buildingManager.js";
import { EntityManager } from "./lib/entityManager.js";
import { ForecastManager } from "./lib/forecast/forecastManager.js";
import { HistoryManager } from "./lib/history/historyManager.js";
import { PriceManager } from "./lib/prices/priceManager.js";
import { RecommendationManager } from "./lib/recommendation/recommendationManager.js";
import { runSafely } from "./lib/safeAsync.js";

class SolarCockpit extends utils.Adapter {
	private entityManager!: EntityManager;
	private forecastManager!: ForecastManager;
	private historyManager!: HistoryManager;
	private priceManager!: PriceManager;
	private recommendationManager!: RecommendationManager;
	private buildingManager!: BuildingManager;

	/**
	 * Creates a new SolarCockpit adapter instance and registers all ioBroker lifecycle event handlers.
	 *
	 * @param options - Optional adapter configuration options passed through to the base class.
	 */
	public constructor(options: Partial<utils.AdapterOptions> = {}) {
		super({
			...options,
			name: "solarcockpit",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("unload", this.onUnload.bind(this));
		this.on("message", this.onMessage.bind(this));
	}

	/**
	 * Handles sendTo requests from the admin UI - currently only the Tibber home dropdown
	 * (`selectSendTo` command "getTibberHomes", data: { instance }).
	 *
	 * @param obj - the incoming message
	 */
	private async onMessage(obj: ioBroker.Message): Promise<void> {
		if (!obj?.callback) {
			return;
		}
		if (obj.command === "getTibberHomes") {
			const data = (obj.message ?? {}) as { instance?: string };
			let homes: Array<{ label: string; value: string }> = [];
			try {
				homes = await PriceManager.listTibberHomes(this, data.instance ?? "");
			} catch (err) {
				this.log.warn(`Could not list Tibber homes: ${String(err)}`);
			}
			this.sendTo(obj.from, obj.command, homes, obj.callback);
		}
	}

	/**
	 * Is called when databases are connected and the adapter has received its configuration.
	 */
	private async onReady(): Promise<void> {
		if (await this.migrateLegacyInfluxConfig()) {
			return; // object write restarts the instance
		}
		// Texts written into states (recommendation, plan reasons) follow the ioBroker system language.
		const systemConfig = await this.getForeignObjectAsync("system.config");
		setLanguage((systemConfig?.common as { language?: string } | undefined)?.language);
		this.entityManager = new EntityManager(this);
		await this.entityManager.init();

		const subscribedCount = this.entityManager.getSubscribedForeignIds().length;
		this.log.info(`Watching ${subscribedCount} source state(s) across the configured entities`);

		this.forecastManager = new ForecastManager(this);
		await this.forecastManager.init(this.entityManager.getEntities());

		this.historyManager = new HistoryManager(this);
		await this.historyManager.init(this.entityManager.getEntities(), this.entityManager.getLossDefinitions());

		this.priceManager = new PriceManager(this);
		await this.priceManager.init();
		this.log.info(`Watching price source(s): ${this.priceManager.getSubscribedForeignIds().join(", ")}`);

		await this.setupDisplaySettings();

		this.recommendationManager = new RecommendationManager(this, this.priceManager, this.entityManager.getEntities());
		await this.recommendationManager.init();
		this.priceManager.onPricesChanged(() => this.recommendationManager.requestReplan());
		// Replan as soon as a new PV forecast arrives (own state, written by ForecastManager).
		await this.subscribeStatesAsync("summary.producer.forecastPower");

		this.buildingManager = new BuildingManager(this);
		await this.buildingManager.init();

		await this.setStateAsync("info.connection", { val: true, ack: true });
	}

	/**
	 * Migration from the former direct-InfluxDB settings (influxHost/-Port/-Org/-Bucket/-Token,
	 * replaced by the database-neutral `historyInstance`): picks the only influxdb instance if
	 * historyInstance is still empty, then removes the old fields - including the stored API token -
	 * from the instance object. Writing the object restarts the adapter, so this returns true to
	 * stop the current start-up.
	 */
	private async migrateLegacyInfluxConfig(): Promise<boolean> {
		const objId = `system.adapter.${this.namespace}`;
		const obj = await this.getForeignObjectAsync(objId);
		if (!obj?.native) {
			return false;
		}
		const legacyKeys = Object.keys(obj.native).filter(k => /^influx(Host|Port|Org|Bucket|Token)$/.test(k));
		if (legacyKeys.length === 0) {
			return false;
		}
		const native = obj.native as Record<string, unknown>;
		if (!native.historyInstance && native.influxHost) {
			const view = await this.getObjectViewAsync("system", "instance", { startkey: "system.adapter.influxdb.", endkey: "system.adapter.influxdb.~" });
			const influxInstances = view.rows.map(r => r.id.replace("system.adapter.", ""));
			if (influxInstances.length === 1) {
				native.historyInstance = influxInstances[0];
				this.log.info(`Migration: history is now read via getHistory from ${influxInstances[0]} (was: direct InfluxDB connection)`);
			} else {
				this.log.warn("Migration: the direct InfluxDB connection settings were removed - please select your history instance in the adapter settings");
			}
		}
		for (const k of legacyKeys) {
			delete native[k];
		}
		this.log.info(`Migration: removed obsolete settings ${legacyKeys.join(", ")}`);
		await this.setForeignObjectAsync(objId, obj);
		return true;
	}

	/**
	 * Mirrors the configured forecast/actual-value colors into states, so the vis-2 widget and the
	 * standalone 2.5D scene - which only ever read ioBroker states, never adapter config directly -
	 * can pick up the same colors instead of each hardcoding its own. Static for the adapter's
	 * lifetime (no subscription needed): a config change restarts the adapter anyway.
	 */
	private async setupDisplaySettings(): Promise<void> {
		await this.extendObjectAsync("summary.settings", { type: "channel", common: { name: tAll("Display settings") }, native: {} });
		await this.extendObjectAsync("summary.settings.colorForecast", {
			type: "state",
			common: { name: tAll("Forecast curve color (widget/3D scene)"), role: "level.color.rgb", type: "string", read: true, write: false, def: "#ffb703" },
			native: {},
		});
		await this.extendObjectAsync("summary.settings.colorActual", {
			type: "state",
			common: {
				name: tAll("Actual-value curve color (widget/3D scene)"),
				role: "level.color.rgb",
				type: "string",
				read: true,
				write: false,
				def: "#2a9d8f",
			},
			native: {},
		});
		await this.setStateAsync("summary.settings.colorForecast", { val: this.config.colorForecast, ack: true });
		await this.setStateAsync("summary.settings.colorActual", { val: this.config.colorActual, ack: true });
	}

	/**
	 * Is called if a subscribed state changes (own states as well as the foreign states we
	 * subscribed to for the configured entities).
	 *
	 * @param id - full id of the state that changed
	 * @param state - the new state value, or null/undefined if the state was deleted
	 */
	private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
		if (!state) {
			return;
		}
		if (id.startsWith(`${this.namespace}.`)) {
			// Own mirrored/computed states - only a new PV forecast is of interest (replan).
			if (id === `${this.namespace}.summary.producer.forecastPower`) {
				this.recommendationManager?.requestReplan();
			}
			return;
		}
		if (!this.entityManager) {
			return; // still starting up
		}
		if (this.priceManager?.isRelevant(id)) {
			runSafely(this, "Price update", () => this.priceManager.onForeignStateChange(id));
			return;
		}
		runSafely(this, "Source state update", () => this.entityManager.onForeignStateChange(id, state));
	}

	/**
	 * Is called when the adapter shuts down. Stops the forecast/recommendation/building refresh
	 * timers; state subscriptions are cleaned up automatically by js-controller.
	 *
	 * @param callback - must be called once cleanup is done
	 */
	private onUnload(callback: () => void): void {
		try {
			this.entityManager?.stop();
			this.forecastManager?.stop();
			this.priceManager?.stop();
			this.historyManager?.stop();
			this.recommendationManager?.stop();
			this.buildingManager?.stop();
			callback();
		} catch {
			callback();
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new SolarCockpit(options);
} else {
	// otherwise start the instance directly
	(() => new SolarCockpit())();
}
