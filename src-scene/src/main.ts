// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
import { setLanguage, t } from "./i18n";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { type CurveTexturePoint } from "./curveTexture";
import { EnergyOverlayLayer } from "./overlayLayer";
import "./style.css";
import { IobrokerSocket } from "./iobrokerSocket";
import { localToLonLat } from "./localGeo";
import { buildingShadowHull, homeIsShadowed } from "./shadow";
import { getSunPosition } from "./sunPosition";
import { weatherLayers } from "./weather";
import { WeatherFx } from "./weatherFx";

const ADAPTER = "energyflow.0";
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const DEG2RAD = Math.PI / 180;

/**
 * The Helios-style "projection surface" wrapped around the home (see Helios'
 * scene/day-curve.ts): a single cylinder at a fixed radius, onto which the background wash, the
 * sun's path, the forecast curve and the actual-value curve are ALL traced onto one shared
 * texture (see curveTexture.ts) - originally these were three/four separate MapLibre/WebGL
 * surfaces at slightly different radii (to dodge z-fighting between them), but the curve texture
 * covers its full height/angle range regardless of where the actual curve data is, so any second
 * surface sharing a nearby radius still z-fights with it wherever the two happen to overlap
 * (found live: the projection surface visibly "tore" while rotating the camera). One surface,
 * one texture removes the possibility of that entirely.
 *
 * Unlike Helios' sloped ground track (which pulls inward as the sun climbs, to keep a FIXED sky
 * radius), a real fixed-radius cylinder wall would need unbounded height at zenith (height =
 * radius * tan(altitude)) - so height here is scaled by sin(altitude) instead of tan(altitude),
 * decoupled from the wall's own radius. That keeps the curves bounded (0 at the horizon, a chosen
 * max at zenith) and the wall's height independent of how far out it stands from the house, which
 * is purely a "how close does the screen sit" choice, not a physical distance.
 */
const PROJECTION_RADIUS_M = 100;
/** Height of the sun path at zenith (sin(altitude) = 1). */
const SUN_PATH_HEIGHT_M = 60;
/** Height of the forecast/actual curves at the shown day's peak power. */
const FORECAST_HEIGHT_M = 60;
/** Height of the projection surface itself - matches the curves' max rise so they stay within it. */
const SCREEN_HEIGHT_M = 60;
/** Minutes between sun-path samples - fine enough that the traced path reads as a smooth curve. */
const SUN_PATH_SAMPLE_STEP_MIN = 6;
/** Sides of the cylindrical strip the whole projection surface is texture-mapped onto. */
const CURVE_STRIP_SIDES = 96;
/** Real-world radius of the sun's billboarded glow sprite, and the radius the sprite's own position sits at (on the projection surface, exactly where the sun path it's following is drawn). */
const SUN_SPRITE_RADIUS_M = 5;
/** Background wash color for the always-visible part of the projection surface, independent of any data (was a separate MapLibre fill-extrusion layer before everything moved onto one texture). */
const WALL_COLOR = "#4fb0ff";
/** How many hours the scrub slider can go back - matches ForecastManager's pastDays window. */
const SCRUB_HOURS_BACK = 48;
/** How many hours the scrub slider can go forward. */
const SCRUB_HOURS_FORWARD = 48;
/** Fill color for a building's cast shadow on the ground plane. */
const SHADOW_COLOR = "#0a0a14";
/**
 * Sun altitude (degrees) at/above which it's "full day" for the night-look fade - and, negated,
 * at/below which it's "full night". Between the two the map's night tint fades in/out smoothly
 * across dawn/dusk instead of snapping at the horizon.
 */
const NIGHT_FADE_ALTITUDE_DEG = 6;
/** #night-overlay's opacity at full night (sun altitude <= -NIGHT_FADE_ALTITUDE_DEG), 0 cloud cover. */
const MAX_NIGHT_OPACITY = 0.85;
/** How much #night-overlay's opacity rises for full (100%) cloud cover, independent of and additive with the night factor - same tint reused for "Bedeckt" as for night, per the user's request. */
const MAX_CLOUD_OPACITY = 0.3;
/** Hard ceiling on the combined night+cloud opacity - even a heavily overcast night should stay readable. */
const MAX_COMBINED_OPACITY = 0.93;

interface ForecastPoint {
	ts: number;
	powerW: number;
}

interface BuildingFootprint {
	points: { eastM: number; northM: number }[];
	heightM: number;
	isHome: boolean;
}

interface WeatherSeriesPoint {
	ts: number;
	temperatureC: number;
	cloudCoverPct: number;
	precipitationMm: number;
	snowfallCm: number;
	weatherCode: number;
}

interface WeatherSnapshot {
	temperature: number;
	cloudCoverPct: number;
	precipitationMm: number;
	snowfallCm: number;
	weatherCode: number;
}

function parseJsonState<T>(raw: unknown): T[] {
	if (typeof raw !== "string" || !raw) {
		return [];
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function nearestByTs<T extends { ts: number }>(points: T[], targetTs: number): T | undefined {
	if (points.length === 0) {
		return undefined;
	}
	return points.reduce((a, b) => (Math.abs(b.ts - targetTs) < Math.abs(a.ts - targetTs) ? b : a));
}

/** Empty polygon FeatureCollection, used to clear/hide a source (e.g. the sun below the horizon). */
const EMPTY_FC: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

function buildingFeature(building: BuildingFootprint, homeLat: number, homeLon: number): GeoJSON.Feature {
	const ring = building.points.map(p => {
		const ll = localToLonLat(p.eastM, p.northM, homeLat, homeLon);
		return [ll.lon, ll.lat] as [number, number];
	});
	ring.push(ring[0]);
	return { type: "Feature", properties: { height: building.heightM }, geometry: { type: "Polygon", coordinates: [ring] } };
}

class Scene {
	private readonly socket = new IobrokerSocket();
	private map: maplibregl.Map | undefined;
	private overlayLayer: EnergyOverlayLayer | undefined;
	private homeLat = 0;
	private homeLon = 0;
	private buildings: BuildingFootprint[] = [];
	private weatherSeries: WeatherSeriesPoint[] = [];
	private liveWeather: WeatherSnapshot | undefined;
	private forecastSeries: ForecastPoint[] = [];
	private actualSeries: ForecastPoint[] = [];
	private colorForecast = "#ffb703";
	private colorActual = "#2a9d8f";
	private scrubHours = 0;
	private readonly weatherFx = new WeatherFx(document.getElementById("weather-fx") as HTMLCanvasElement);

	/** Texts of the static page elements (index.html ships English defaults). */
	private applyStaticTexts(): void {
		document.title = t("title");
		const back = document.getElementById("back-button");
		if (back) {
			back.textContent = t("back");
		}
		const scrubLabel = document.getElementById("scrub-label");
		if (scrubLabel) {
			scrubLabel.textContent = t("now");
		}
	}

	public async start(): Promise<void> {
		await this.socket.ready;

		const sysConfig = (await this.socket.getObject("system.config")) as ioBroker.SystemConfigObject | null;
		// URL parameters override the system settings for this view only: ?lang=en, and ?lat=..&lon=..
		// to center the scene somewhere else (e.g. for screenshots or to try the scene elsewhere).
		const params = new URLSearchParams(window.location.search);
		setLanguage(params.get("lang") ?? sysConfig?.common.language);
		this.applyStaticTexts();
		const urlLat = Number.parseFloat(params.get("lat") ?? "");
		const urlLon = Number.parseFloat(params.get("lon") ?? "");
		const locationOverridden = Number.isFinite(urlLat) && Number.isFinite(urlLon);
		const lat = locationOverridden ? urlLat : sysConfig?.common.latitude;
		const lon = locationOverridden ? urlLon : sysConfig?.common.longitude;
		if (typeof lat !== "number" || typeof lon !== "number") {
			document.getElementById("status")!.textContent = t("no_location");
			return;
		}
		this.homeLat = lat;
		this.homeLon = lon;

		this.initMap();

		// The adapter's building footprints are local meters around the SYSTEM location - drawn at an
		// overridden location they would show the real neighborhood's shapes in the wrong place (and
		// leak them into screenshots), so shadows/home highlight are skipped then.
		if (!locationOverridden) {
			this.socket.subscribeState(`${ADAPTER}.summary.buildings.footprints`, state => {
				this.buildings = parseJsonState<BuildingFootprint>(state?.val);
				this.render();
			});
		}
		this.socket.subscribeState(`${ADAPTER}.summary.weather.forecastSeries`, state => {
			this.weatherSeries = parseJsonState<WeatherSeriesPoint>(state?.val);
			this.render();
		});
		this.socket.subscribeState(`${ADAPTER}.summary.producer.forecastPower`, state => {
			this.forecastSeries = parseJsonState<ForecastPoint>(state?.val);
			this.updateScrubRange();
			this.render();
		});
		this.socket.subscribeState(`${ADAPTER}.summary.producer.actualPower`, state => {
			this.actualSeries = parseJsonState<ForecastPoint>(state?.val);
			this.render();
		});
		this.socket.subscribeState(`${ADAPTER}.summary.settings.colorForecast`, state => {
			if (typeof state?.val === "string" && state.val) {
				this.colorForecast = state.val;
				this.render();
			}
		});
		this.socket.subscribeState(`${ADAPTER}.summary.settings.colorActual`, state => {
			if (typeof state?.val === "string" && state.val) {
				this.colorActual = state.val;
				this.render();
			}
		});
		const weatherFields: [string, keyof WeatherSnapshot][] = [
			["temperature", "temperature"],
			["cloudCoverPct", "cloudCoverPct"],
			["precipitationMm", "precipitationMm"],
			["snowfallCm", "snowfallCm"],
			["weatherCode", "weatherCode"],
		];
		const liveWeather: Partial<WeatherSnapshot> = {};
		for (const [stateName, key] of weatherFields) {
			this.socket.subscribeState(`${ADAPTER}.summary.weather.${stateName}`, state => {
				if (typeof state?.val === "number") {
					liveWeather[key] = state.val;
					if (Object.keys(liveWeather).length === weatherFields.length) {
						this.liveWeather = liveWeather as WeatherSnapshot;
						this.render();
					}
				}
			});
		}

		// The scrub slider itself needs its bounds derived from the forecast series, so a first
		// render happens once that arrives (see the forecastPower subscription above); this tick
		// just covers the case where nothing has been received yet.
		setInterval(() => this.render(), 60000);

		const slider = document.getElementById("scrub") as HTMLInputElement;
		slider.addEventListener("input", () => {
			this.scrubHours = Number(slider.value);
			this.render();
		});

		// Go back to whatever vis-2 view/project opened this iFrame, rather than a hardcoded view
		// name - vis-2 project/view names get renamed from time to time, which broke
		// a fixed href here before.
		document.getElementById("back-button")?.addEventListener("click", event => {
			event.preventDefault();
			window.top?.history.back();
		});
	}

	/**
	 * Sets the scrub slider's min/max from the forecast series' actual time range around "now" -
	 * the series includes both a couple of past days (for looking back) and the forecast horizon
	 * (for looking ahead), see ForecastManager's pastDays.
	 */
	private updateScrubRange(): void {
		const slider = document.getElementById("scrub") as HTMLInputElement;
		const nowMs = Date.now();
		const visible = this.forecastSeries.filter(p => p.ts >= nowMs - SCRUB_HOURS_BACK * 3600000 && p.ts <= nowMs + SCRUB_HOURS_FORWARD * 3600000);
		const minHours = visible.length > 0 ? Math.min(0, Math.floor((visible[0].ts - nowMs) / 3600000)) : -SCRUB_HOURS_BACK;
		const maxHours = visible.length > 0 ? Math.max(0, Math.round((visible[visible.length - 1].ts - nowMs) / 3600000)) : SCRUB_HOURS_FORWARD;
		slider.min = String(minHours);
		slider.max = String(maxHours);
	}

	private initMap(): void {
		this.map = new maplibregl.Map({
			container: "map",
			style: MAP_STYLE,
			center: [this.homeLon, this.homeLat],
			zoom: 18,
			pitch: 60,
			bearing: -20,
			antialias: true,
		});
		this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
		// Exposed for live debugging from the browser console (e.g. map.getSource('home')._data,
		// or __weatherFx.setWeather('rain', 3) to force-preview a condition) - this page has no
		// auth/sensitive state, same spirit as vis-2's own window.vis.conn.
		(window as unknown as { __map: maplibregl.Map; __weatherFx: WeatherFx }).__map = this.map;
		(window as unknown as { __map: maplibregl.Map; __weatherFx: WeatherFx }).__weatherFx = this.weatherFx;
		this.map.on("error", e => console.error("maplibre error", e.error));

		this.map.on("load", () => {
			const map = this.map!;

			// Ground-level shadow patches - added first so the buildings-extrusion layer right after
			// it paints (and correctly occludes) on top of them, rather than a shadow ever appearing
			// to float over a building that's standing on it.
			map.addSource("shadows", { type: "geojson", data: EMPTY_FC });
			map.addLayer({ id: "shadows-fill", type: "fill", source: "shadows", paint: { "fill-color": SHADOW_COLOR, "fill-opacity": 0.45 } });

			map.addLayer({
				id: "3d-buildings",
				source: "openmaptiles",
				"source-layer": "building",
				type: "fill-extrusion",
				minzoom: 13,
				paint: {
					"fill-extrusion-color": "#9aa5b1",
					"fill-extrusion-height": ["coalesce", ["get", "render_height"], 6],
					"fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
					"fill-extrusion-opacity": 0.85,
				},
			});

			map.addSource("home", { type: "geojson", data: EMPTY_FC });
			map.addLayer({
				id: "home-fill",
				type: "fill-extrusion",
				source: "home",
				paint: {
					"fill-extrusion-color": "#ef476f",
					"fill-extrusion-height": ["get", "height"],
					"fill-extrusion-base": 0,
					"fill-extrusion-opacity": 0.95,
				},
			});
			map.addLayer({ id: "home-outline", type: "line", source: "home", paint: { "line-color": "#ffffff", "line-width": 2 } });

			// The Helios-style "projection surface" - background wash, sun path, forecast curve and
			// actual curve ALL drawn onto one shared texture (see curveTexture.ts) mapped onto one
			// cylinder strip. Needs real WebGL access MapLibre's declarative style layers don't offer
			// (texturing a surface, billboarding the sun sprite), hence a custom layer instead of a
			// GeoJSON source.
			this.overlayLayer = new EnergyOverlayLayer(
				this.homeLat,
				this.homeLon,
				PROJECTION_RADIUS_M,
				SCREEN_HEIGHT_M,
				CURVE_STRIP_SIDES,
				SUN_SPRITE_RADIUS_M,
			);
			map.addLayer(this.overlayLayer);

			this.render();
		});
	}

	private render(): void {
		if (!this.map?.isStyleLoaded()) {
			return;
		}

		const nowMs = Date.now();
		const isScrubbing = this.scrubHours !== 0;
		const scrubDate = isScrubbing ? new Date(nowMs + this.scrubHours * 3600000) : new Date();

		this.renderHome();
		this.renderShadows(scrubDate);
		this.renderCylinderOverlay(scrubDate);
		this.renderOverlay(scrubDate, isScrubbing);
		this.updateNightLook(scrubDate);
		this.updateWeatherFx(scrubDate);
	}

	/**
	 * The shown instant's weather - the live snapshot when not scrubbing, or the nearest point in
	 * the forecast series when scrubbed to a past/future hour. Shared by every render step that
	 * needs "what's the weather right now" (night/cloud tint, rain/snow overlay, sun dimming, the
	 * weather label) instead of each re-implementing the same live-vs-scrubbed lookup.
	 *
	 * @param date
	 */
	private effectiveWeatherAt(date: Date): WeatherSnapshot | undefined {
		if (this.scrubHours === 0) {
			return this.liveWeather;
		}
		const point = nearestByTs(this.weatherSeries, date.getTime());
		return (
			point && {
				temperature: point.temperatureC,
				cloudCoverPct: point.cloudCoverPct,
				precipitationMm: point.precipitationMm,
				snowfallCm: point.snowfallCm,
				weatherCode: point.weatherCode,
			}
		);
	}

	/**
	 * Casts each non-home building's shadow (see shadow.ts) onto the ground plane for the shown
	 * instant, and updates the "Im Schatten"/"Volle Sonne"/"Nacht" status label - the same
	 * indicator the widget-era 2D site plan had, ported onto the real 3D building footprints.
	 *
	 * @param date
	 */
	private renderShadows(date: Date): void {
		const source = this.map?.getSource<maplibregl.GeoJSONSource>("shadows");
		const shadowLabel = document.getElementById("shadow-label");
		if (!source || !shadowLabel) {
			return;
		}
		const p = getSunPosition(date, this.homeLat, this.homeLon);
		const sun = { altitudeDeg: p.altitude, azimuthDeg: p.azimuth };

		const features: GeoJSON.Feature[] = [];
		for (const building of this.buildings) {
			if (building.isHome) {
				continue;
			}
			const hull = buildingShadowHull(building, sun);
			if (!hull || hull.length < 3) {
				continue;
			}
			const ring = hull.map(pt => {
				const ll = localToLonLat(pt.eastM, pt.northM, this.homeLat, this.homeLon);
				return [ll.lon, ll.lat] as [number, number];
			});
			ring.push(ring[0]);
			features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } });
		}
		source.setData({ type: "FeatureCollection", features });

		shadowLabel.textContent = sun.altitudeDeg <= 0 ? t("night") : homeIsShadowed(this.buildings, sun) ? t("in_shadow") : t("full_sun");
	}

	/**
	 * Fades in a dark-blue tint over the whole map (see #night-overlay) as the shown instant's sun
	 * altitude drops toward and below the horizon (smooth dawn/dusk transition, not a hard cut at
	 * 0° - see NIGHT_FADE_ALTITUDE_DEG), ADDITIONALLY darkened by cloud cover - the same tint doing
	 * double duty for "overcast" as for "night", per the user's request, rather than a second
	 * separate overlay. The two add rather than one overriding the other, so an overcast night
	 * reads as darker than either alone, capped at MAX_COMBINED_OPACITY so it never becomes
	 * unreadable.
	 *
	 * @param date
	 */
	private updateNightLook(date: Date): void {
		const overlay = document.getElementById("night-overlay");
		if (!overlay) {
			return;
		}
		const altitude = getSunPosition(date, this.homeLat, this.homeLon).altitude;
		const nightFactor = Math.max(0, Math.min(1, (NIGHT_FADE_ALTITUDE_DEG - altitude) / (2 * NIGHT_FADE_ALTITUDE_DEG)));
		const cloudFactor = Math.max(0, Math.min(1, (this.effectiveWeatherAt(date)?.cloudCoverPct ?? 0) / 100));
		const opacity = Math.min(MAX_COMBINED_OPACITY, nightFactor * MAX_NIGHT_OPACITY + cloudFactor * MAX_CLOUD_OPACITY);
		overlay.style.opacity = String(opacity);
	}

	/**
	 * Feeds the current condition/intensity to the full-screen rain/snow/storm particle overlay (see weatherFx.ts).
	 *
	 * @param date
	 */
	private updateWeatherFx(date: Date): void {
		const weather = this.effectiveWeatherAt(date);
		if (!weather) {
			this.weatherFx.setWeather("clear", 0);
			return;
		}
		const altitude = getSunPosition(date, this.homeLat, this.homeLon).altitude;
		const { condition } = weatherLayers({ ...weather, sunAltitudeDeg: altitude });
		const intensity = condition === "snow" ? weather.snowfallCm : weather.precipitationMm;
		this.weatherFx.setWeather(condition, intensity);
	}

	private renderHome(): void {
		const home = this.buildings.find(b => b.isHome);
		const source = this.map?.getSource<maplibregl.GeoJSONSource>("home");
		if (!source) {
			return;
		}
		source.setData(home ? { type: "FeatureCollection", features: [buildingFeature(home, this.homeLat, this.homeLon)] } : EMPTY_FC);
	}

	/**
	 * This shown day's forecast AND actual/historical points, sharing one peak power (>=1, so a
	 * division by it never blows up) so both curves sit on the same height scale and stay visually
	 * comparable - actualPoints is typically partial (only up to "now") for today, and empty for a
	 * future day.
	 *
	 * @param date
	 */
	private dayForecast(date: Date): { points: ForecastPoint[]; actualPoints: ForecastPoint[]; peak: number } {
		const dayStart = new Date(date);
		dayStart.setHours(0, 0, 0, 0);
		const dayEndMs = dayStart.getTime() + 24 * 3600000;
		const points = this.forecastSeries.filter(p => p.ts >= dayStart.getTime() && p.ts < dayEndMs);
		const actualPoints = this.actualSeries.filter(p => p.ts >= dayStart.getTime() && p.ts < dayEndMs);
		const peak = Math.max(1, ...points.map(p => p.powerW), ...actualPoints.map(p => p.powerW));
		return { points, actualPoints, peak };
	}

	/**
	 * The sun's daylight-only path for the shown day, as points on the shared projection surface (see curveTexture.ts).
	 *
	 * @param date
	 */
	private sunPathPoints(date: Date): CurveTexturePoint[] {
		const dayStart = new Date(date);
		dayStart.setHours(0, 0, 0, 0);
		const points: CurveTexturePoint[] = [];
		for (let m = 0; m < 24 * 60; m += SUN_PATH_SAMPLE_STEP_MIN) {
			const p = getSunPosition(new Date(dayStart.getTime() + m * 60000), this.homeLat, this.homeLon);
			if (p.altitude <= 0) {
				continue;
			}
			points.push({ angleRad: p.azimuth * DEG2RAD, valueFrac: (Math.sin(p.altitude * DEG2RAD) * SUN_PATH_HEIGHT_M) / SCREEN_HEIGHT_M });
		}
		return points;
	}

	/**
	 * The shown day's sun path, forecast curve and actual curve, all drawn as one texture onto the
	 * shared projection surface (see overlayLayer.ts/curveTexture.ts). Each hourly point sits at
	 * the azimuth the sun actually had at that hour, so a curve's angular position IS the time of
	 * day, same as the sun path itself (Helios' day-curve concept). Also places the sun's
	 * billboarded glow sprite at its current position, dimmed the same way the old disc was under
	 * cloud cover.
	 *
	 * @param date
	 */
	private renderCylinderOverlay(date: Date): void {
		if (!this.overlayLayer) {
			return;
		}
		const { points, actualPoints, peak } = this.dayForecast(date);
		const heightFrac = (watts: number): number => (watts / peak) * (FORECAST_HEIGHT_M / SCREEN_HEIGHT_M);
		const toCurvePoint = (p: ForecastPoint): CurveTexturePoint => {
			const sun = getSunPosition(new Date(p.ts), this.homeLat, this.homeLon);
			return { angleRad: sun.azimuth * DEG2RAD, valueFrac: heightFrac(p.powerW) };
		};
		const curvePoints: CurveTexturePoint[] = points.map(toCurvePoint);
		const actualCurvePoints: CurveTexturePoint[] = actualPoints.map(toCurvePoint);

		const p = getSunPosition(date, this.homeLat, this.homeLon);
		const nearest = nearestByTs(points, date.getTime());
		const marker: CurveTexturePoint | null = nearest && p.altitude > 0 ? { angleRad: p.azimuth * DEG2RAD, valueFrac: heightFrac(nearest.powerW) } : null;
		this.overlayLayer.setProjectionContent({
			wallColor: WALL_COLOR,
			sunPath: this.sunPathPoints(date),
			forecast: { points: curvePoints, color: this.colorForecast, marker },
			actual: { points: actualCurvePoints, color: this.colorActual },
		});

		if (p.altitude <= 0) {
			this.overlayLayer.setSun(false, 0, 0, 0, 1);
			return;
		}
		const az = p.azimuth * DEG2RAD;
		const alt = p.altitude * DEG2RAD;
		const eastM = Math.sin(az) * PROJECTION_RADIUS_M;
		const northM = Math.cos(az) * PROJECTION_RADIUS_M;
		const upM = Math.sin(alt) * SUN_PATH_HEIGHT_M;

		const weather = this.effectiveWeatherAt(date);
		const alpha = weather ? 0.35 + 0.65 * weatherLayers({ ...weather, sunAltitudeDeg: p.altitude }).sun : 1;
		this.overlayLayer.setSun(true, eastM, northM, upM, alpha);
	}

	private renderOverlay(scrubDate: Date, isScrubbing: boolean): void {
		const weather = this.effectiveWeatherAt(scrubDate);

		const weatherLabel = document.getElementById("weather-label")!;
		if (weather) {
			const p = getSunPosition(scrubDate, this.homeLat, this.homeLon);
			const layers = weatherLayers({ ...weather, sunAltitudeDeg: p.altitude });
			weatherLabel.textContent = `${layers.label} · ${weather.temperature.toFixed(0)}°C`;
		} else {
			weatherLabel.textContent = "";
		}

		const scrubLabel = document.getElementById("scrub-label")!;
		if (isScrubbing) {
			const today = new Date();
			today.setHours(0, 0, 0, 0);
			const target = new Date(scrubDate);
			target.setHours(0, 0, 0, 0);
			const dayOffset = Math.round((target.getTime() - today.getTime()) / 86400000);
			const dayLabel =
				dayOffset === 0
					? t("today")
					: dayOffset === 1
						? t("tomorrow")
						: dayOffset === 2
							? t("day_after_tomorrow")
							: dayOffset === -1
								? t("yesterday")
								: dayOffset === -2
									? t("day_before_yesterday")
									: dayOffset > 0
										? t("in_days", { n: dayOffset })
										: t("days_ago", { n: -dayOffset });
			scrubLabel.textContent = `${dayLabel} ${scrubDate.getHours().toString().padStart(2, "0")}:${scrubDate.getMinutes().toString().padStart(2, "0")}`;
		} else {
			scrubLabel.textContent = t("now");
		}
	}
}

void new Scene().start();
