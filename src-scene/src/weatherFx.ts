// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Full-screen rain/snow/storm particle overlay - the "Vollbild-Dashboard-Technik" from Helios
 * (src/scene/weather-fx.ts) that weather.ts's header comment explicitly left out of the compact
 * widget card ("out of scope for a compact card widget"). The 2.5D scene IS that full-screen
 * dashboard context, so here it earns its place. Deliberately simpler than Helios' version (no
 * full scene color grading, just the particles) - falling rain streaks or drifting snowflakes
 * over the whole viewport, an occasional flash for storms, density scaled by how much
 * precipitation/snowfall is actually forecast for the shown instant. Pure canvas + rAF, no
 * MapLibre involvement - drawn in its own canvas layered above the map (see index.html/style.css)
 * so it doesn't care what the map underneath is doing.
 */
import type { WeatherCondition } from "./weather";

interface Particle {
	x: number;
	y: number;
	/** Rain/storm: px/s falling speed. Snow: px/s falling speed (slower). */
	speed: number;
	/** Rain/storm: streak length in px. Snow: flake radius in px. */
	size: number;
	/** Snow only: sideways drift in px/s, for a gentle sway instead of a dead-straight fall. */
	driftPxPerS: number;
}

const MIN_PARTICLES = 60;
const MAX_PARTICLES = 260;
/** Rain/storm: mm/h at which particle count saturates. Snow: cm/h at which it saturates. */
const INTENSITY_SATURATION = 4;
/** How long a lightning flash takes to fade back out, in alpha per frame (~60fps). */
const FLASH_DECAY_PER_FRAME = 0.06;

/**
 * Weather conditions that actually get particles - everything else means an empty (idle) canvas.
 *
 * @param condition
 */
function isPrecipitating(condition: WeatherCondition): condition is "rain" | "snow" | "storm" {
	return condition === "rain" || condition === "snow" || condition === "storm";
}

export class WeatherFx {
	private readonly ctx: CanvasRenderingContext2D | null;
	private particles: Particle[] = [];
	private condition: WeatherCondition = "clear";
	private flashAlpha = 0;
	private nextFlashAtMs = 0;

	/**
	 * @param canvas - the full-viewport canvas to draw into (see #weather-fx in index.html)
	 */
	public constructor(private readonly canvas: HTMLCanvasElement) {
		this.ctx = canvas.getContext("2d");
		window.addEventListener("resize", () => this.resize());
		this.resize();
		requestAnimationFrame(this.tick);
	}

	private resize(): void {
		this.canvas.width = window.innerWidth;
		this.canvas.height = window.innerHeight;
	}

	/**
	 * Sets the condition/intensity to render from the next frame on. Cheap to call every render()
	 * tick - only rebuilds the particle set when the target count actually changes.
	 *
	 * @param condition - the shown instant's weather condition
	 * @param intensityPerHour - precipitation in mm/h (rain/storm) or snowfall in cm/h (snow); ignored for non-precipitating conditions
	 */
	public setWeather(condition: WeatherCondition, intensityPerHour: number): void {
		this.condition = condition;
		const targetCount = isPrecipitating(condition)
			? Math.round(MIN_PARTICLES + (MAX_PARTICLES - MIN_PARTICLES) * Math.min(1, Math.max(0, intensityPerHour) / INTENSITY_SATURATION))
			: 0;
		if (this.particles.length !== targetCount) {
			this.particles = Array.from({ length: targetCount }, () => this.spawnParticle(true));
		}
	}

	/**
	 * @param randomStartY - true to scatter the particle's initial Y across the whole canvas height (startup/resize); false to start it just above the top edge (recycled mid-animation, so it doesn't visibly "pop in" partway down)
	 */
	private spawnParticle(randomStartY: boolean): Particle {
		const snow = this.condition === "snow";
		return {
			x: Math.random() * this.canvas.width,
			y: randomStartY ? Math.random() * this.canvas.height : -10,
			speed: snow ? 40 + Math.random() * 50 : 650 + Math.random() * 350,
			size: snow ? 1.5 + Math.random() * 2.5 : 10 + Math.random() * 10,
			driftPxPerS: snow ? -20 + Math.random() * 40 : 0,
		};
	}

	private readonly tick = (): void => {
		requestAnimationFrame(this.tick);
		const ctx = this.ctx;
		if (!ctx) {
			return;
		}
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

		if (this.particles.length > 0) {
			this.drawParticles(ctx);
		}
		if (this.condition === "storm") {
			this.drawLightning(ctx);
		}
	};

	private drawParticles(ctx: CanvasRenderingContext2D): void {
		const dt = 1 / 60;
		const snow = this.condition === "snow";
		ctx.strokeStyle = "rgba(180,205,235,0.55)";
		ctx.fillStyle = "rgba(255,255,255,0.85)";
		ctx.lineWidth = 1.2;
		ctx.lineCap = "round";

		for (const p of this.particles) {
			p.y += p.speed * dt;
			p.x += p.driftPxPerS * dt;
			if (p.y - p.size > this.canvas.height) {
				Object.assign(p, this.spawnParticle(false));
			}
			if (p.x < -20) {
				p.x = this.canvas.width + 20;
			} else if (p.x > this.canvas.width + 20) {
				p.x = -20;
			}

			if (snow) {
				ctx.beginPath();
				ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
				ctx.fill();
			} else {
				ctx.beginPath();
				ctx.moveTo(p.x, p.y);
				ctx.lineTo(p.x - p.size * 0.15, p.y - p.size);
				ctx.stroke();
			}
		}
	}

	/**
	 * Occasional brief whole-canvas brightening, Helios-style, for storms - a lightning flash.
	 *
	 * @param ctx
	 */
	private drawLightning(ctx: CanvasRenderingContext2D): void {
		const now = performance.now();
		if (now >= this.nextFlashAtMs) {
			this.flashAlpha = 0.45 + Math.random() * 0.3;
			this.nextFlashAtMs = now + 2500 + Math.random() * 6000;
		}
		if (this.flashAlpha > 0) {
			ctx.fillStyle = `rgba(255,255,255,${this.flashAlpha})`;
			ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
			this.flashAlpha = Math.max(0, this.flashAlpha - FLASH_DECAY_PER_FRAME);
		}
	}
}
