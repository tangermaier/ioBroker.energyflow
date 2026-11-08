// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Draws the ENTIRE projection surface - background wall wash, sun path, forecast/yield curve and
 * actual/historical curve - as one flat image, later texture-mapped onto a single cylinder strip
 * by overlayLayer.ts. All of it used to be split across multiple surfaces (a MapLibre
 * fill-extrusion wall, a MapLibre fill-extrusion sun-path ribbon, and this texture strip for the
 * curves) at slightly different radii to dodge z-fighting between them - but the curve texture
 * strip is a full-coverage cylindrical surface (covers the whole 0..1 height range at every
 * angle, texture alpha does the rest), so any second translucent surface sharing a nearby radius
 * still visibly z-fights with it wherever the two happen to overlap, and rotating the camera makes
 * that flicker between "tears" (found live in the 2.5D scene). Rendering everything
 * onto ONE surface removes the possibility entirely - there is nothing left for it to conflict
 * with.
 *
 * X = angle around the home (0..2*PI, wrapped to the canvas width), Y = height fraction (0 at the
 * bottom, 1 at the top of the cylinder). Pure canvas drawing, no MapLibre/GL types here.
 */

export const CURVE_TEX_W = 1024;
export const CURVE_TEX_H = 256;
const SUN_SPRITE_SIZE = 128;

/**
 * The sun path used to be its own MapLibre layer painted amber (`#ffb703`) - now that it shares
 * this texture with the forecast curve (whose own default color happens to be the same amber),
 * it gets its own fixed, distinct color instead so the two remain visually distinguishable. Not
 * admin-configurable (unlike forecast/actual) - it isn't a data series a user would want to
 * recolor to match anything else.
 */
const SUN_PATH_COLOR = "#ffe066";

export interface CurveTexturePoint {
	angleRad: number;
	/** 0..1 fraction of the cylinder wall's height. */
	valueFrac: number;
}

/** Everything drawn onto the projection surface for one frame. */
export interface ProjectionSurfaceContent {
	/** "#rrggbb" background wash color - the always-visible translucent "screen", independent of any data. */
	wallColor: string;
	/** The shown day's daylight-only sun path, open polyline (doesn't wrap around to a full loop). */
	sunPath: CurveTexturePoint[];
	forecast: {
		/** The shown day's forecast samples, angle = that hour's sun azimuth, valueFrac = power/peak scaled into the wall's height. Closed loop (see catmullRomClosedPath) - the physics/ML forecast always covers the full 24h. */
		points: CurveTexturePoint[];
		/** "#rrggbb" color for the forecast curve's fill/stroke. */
		color: string;
		/** The current/scrubbed instant's position on the forecast curve, or null to omit the marker. */
		marker: CurveTexturePoint | null;
	};
	actual: {
		/** The shown day's actual/historical samples, same angle/valueFrac convention as forecast.points, sharing the same peak scale. Open polyline, NOT closed - "today" is typically only populated up to "now". Empty for a day with no actual data (e.g. a future day). */
		points: CurveTexturePoint[];
		/** "#rrggbb" color for the actual-value curve's stroke. */
		color: string;
	};
}

/**
 * One Catmull-Rom span per point, closed into a loop - the same tension-1/6 construction Helios'
 * day-curve.ts uses, so the curve actually passes through every sample instead of bowing off
 * toward a hull.
 *
 * @param ctx
 * @param pts
 */
function catmullRomClosedPath(ctx: CanvasRenderingContext2D, pts: [number, number][]): void {
	const n = pts.length;
	const at = (i: number): [number, number] => pts[((i % n) + n) % n];
	ctx.moveTo(pts[0][0], pts[0][1]);
	for (let i = 0; i < n; i++) {
		const p0 = at(i - 1);
		const p1 = at(i);
		const p2 = at(i + 1);
		const p3 = at(i + 2);
		const c1x = p1[0] + (p2[0] - p0[0]) / 6;
		const c1y = p1[1] + (p2[1] - p0[1]) / 6;
		const c2x = p2[0] - (p3[0] - p1[0]) / 6;
		const c2y = p2[1] - (p3[1] - p1[1]) / 6;
		ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2[0], p2[1]);
	}
}

/**
 * Draws an open polyline (straight segments, no spline) through the given pixel points - used for the sun path and actual-value curve, both of which can be partial.
 *
 * @param ctx
 * @param pixels
 * @param color
 * @param alpha
 * @param lineWidth
 */
function strokeOpenPolyline(ctx: CanvasRenderingContext2D, pixels: [number, number][], color: string, alpha: number, lineWidth: number): void {
	ctx.beginPath();
	pixels.forEach(([px, py], i) => (i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)));
	ctx.strokeStyle = hexToRgba(color, alpha);
	ctx.lineWidth = lineWidth;
	ctx.stroke();
}

function toPixel(p: CurveTexturePoint): [number, number] {
	const twoPi = 2 * Math.PI;
	const u = (((p.angleRad % twoPi) + twoPi) % twoPi) / twoPi;
	return [u * CURVE_TEX_W, CURVE_TEX_H * (1 - Math.max(0, Math.min(1, p.valueFrac)))];
}

/**
 * Expands a "#rrggbb" color into an "rgba(...)" string at the given alpha - lets the fill/stroke
 * colors come from configurable hex strings (admin config) while keeping the same varying-alpha
 * gradient/stroke treatment the curve has always used.
 *
 * @param hex - a "#rrggbb" color string
 * @param alpha - opacity, 0..1
 */
function hexToRgba(hex: string, alpha: number): string {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) {
		return `rgba(255,183,3,${alpha})`;
	}
	const [, r, g, b] = match;
	return `rgba(${parseInt(r, 16)},${parseInt(g, 16)},${parseInt(b, 16)},${alpha})`;
}

/**
 * Renders the whole projection surface - background wash, sun path, forecast curve (closed loop,
 * filled) and actual curve (open polyline) - into `canvas`. Clears to fully transparent first,
 * then washes in the background color, so buildings show through everywhere at the wash's low
 * alpha and more strongly wherever a curve covers it.
 *
 * @param canvas - target canvas, resized to the texture's fixed pixel dimensions
 * @param content - everything to draw this frame, see ProjectionSurfaceContent
 */
export function drawProjectionSurfaceTexture(canvas: HTMLCanvasElement, content: ProjectionSurfaceContent): void {
	canvas.width = CURVE_TEX_W;
	canvas.height = CURVE_TEX_H;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return;
	}
	ctx.clearRect(0, 0, CURVE_TEX_W, CURVE_TEX_H);

	ctx.fillStyle = hexToRgba(content.wallColor, 0.1);
	ctx.fillRect(0, 0, CURVE_TEX_W, CURVE_TEX_H);

	if (content.sunPath.length >= 2) {
		strokeOpenPolyline(ctx, content.sunPath.map(toPixel), SUN_PATH_COLOR, 0.9, 2.5);
	}

	if (content.forecast.points.length >= 3) {
		const pts = content.forecast.points.map(toPixel);

		ctx.beginPath();
		catmullRomClosedPath(ctx, pts);
		ctx.closePath();
		const fill = ctx.createLinearGradient(0, 0, 0, CURVE_TEX_H);
		fill.addColorStop(0, hexToRgba(content.forecast.color, 0.55));
		fill.addColorStop(1, hexToRgba(content.forecast.color, 0.05));
		ctx.fillStyle = fill;
		ctx.fill();

		ctx.beginPath();
		catmullRomClosedPath(ctx, pts);
		ctx.closePath();
		ctx.strokeStyle = hexToRgba(content.forecast.color, 0.95);
		ctx.lineWidth = 3;
		ctx.stroke();
	}

	if (content.actual.points.length >= 2) {
		// Open polyline, NOT the closed loop the forecast curve uses - actual data for "today" is
		// typically partial (only up to "now"), and closing the loop would draw a spurious chord
		// straight across the missing rest of the day. A straight polyline (not a spline) also
		// matches exactly how the widget's sparkline draws the same actual-value line.
		strokeOpenPolyline(ctx, content.actual.points.map(toPixel), content.actual.color, 0.95, 3);
	}

	const marker = content.forecast.marker;
	if (marker) {
		const [mx, my] = toPixel(marker);
		ctx.setLineDash([4, 4]);
		ctx.strokeStyle = "rgba(255,255,255,0.7)";
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(mx, CURVE_TEX_H);
		ctx.lineTo(mx, my);
		ctx.stroke();
		ctx.setLineDash([]);

		ctx.beginPath();
		ctx.arc(mx, my, 5, 0, 2 * Math.PI);
		ctx.fillStyle = "#ffffff";
		ctx.fill();
	}
}

/**
 * A small glowing warm sprite (radial gradient), billboarded in 3D by overlayLayer.ts to read as a soft little sphere rather than a flat disc. Static - drawn once.
 *
 * @param canvas
 */
export function drawSunSpriteTexture(canvas: HTMLCanvasElement): void {
	canvas.width = SUN_SPRITE_SIZE;
	canvas.height = SUN_SPRITE_SIZE;
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return;
	}
	const c = SUN_SPRITE_SIZE / 2;
	ctx.clearRect(0, 0, SUN_SPRITE_SIZE, SUN_SPRITE_SIZE);
	const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
	gradient.addColorStop(0, "rgba(255,255,255,1)");
	gradient.addColorStop(0.35, "rgba(255,214,102,1)");
	gradient.addColorStop(0.75, "rgba(255,183,3,0.9)");
	gradient.addColorStop(1, "rgba(255,183,3,0)");
	ctx.fillStyle = gradient;
	ctx.beginPath();
	ctx.arc(c, c, c, 0, 2 * Math.PI);
	ctx.fill();
}
