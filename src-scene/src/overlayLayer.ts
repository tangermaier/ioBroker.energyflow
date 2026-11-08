/**
 * A MapLibre CustomLayerInterface that draws two things directly into the map's WebGL context,
 * in real 3D (depth-tested against the buildings like everything else in the scene):
 *
 * 1. The ENTIRE projection surface - background wash, sun path, forecast curve and actual curve -
 *    texture-mapped onto ONE cylindrical strip at a fixed radius around the home. All four used
 *    to be separate MapLibre/WebGL surfaces at slightly different radii (each nudged outward to
 *    dodge z-fighting with its neighbor); merged onto one shared texture (drawn in
 *    curveTexture.ts; this file only builds the cylinder mesh and uploads/samples it) so there is
 *    only ever one surface to z-fight with itself, not several - which is what was still visibly
 *    "tearing" while rotating the camera even after separating the two most obviously conflicting
 *    radii.
 * 2. The sun's current position, as a small billboarded glowing sprite (always turned to face
 *    the camera around the vertical axis) rather than a flat-topped extruded disc - reads as a
 *    soft little sphere instead of a "extruded cylinder".
 *
 * MapLibre's own style layers (fill-extrusion etc.) can't texture a surface or billboard a
 * sprite, hence a custom layer - see https://maplibre.org/maplibre-gl-js/docs/examples/custom-style-layer/
 * for the pattern this follows.
 */
import maplibregl from "maplibre-gl";
import { localToLonLat } from "./localGeo";
import { drawProjectionSurfaceTexture, drawSunSpriteTexture, type ProjectionSurfaceContent } from "./curveTexture";

type GL = WebGLRenderingContext | WebGL2RenderingContext;

const VERTEX_SRC = `
	attribute vec3 a_pos;
	attribute vec2 a_uv;
	uniform mat4 u_matrix;
	varying vec2 v_uv;
	void main() {
		gl_Position = u_matrix * vec4(a_pos, 1.0);
		v_uv = a_uv;
	}
`;
const FRAGMENT_SRC = `
	precision mediump float;
	uniform sampler2D u_tex;
	uniform float u_alpha;
	varying vec2 v_uv;
	void main() {
		vec4 c = texture2D(u_tex, v_uv);
		gl_FragColor = vec4(c.rgb * c.a * u_alpha, c.a * u_alpha);
	}
`;

function compileShader(gl: GL, type: number, source: string): WebGLShader {
	const shader = gl.createShader(type)!;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	return shader;
}

function toMercator(eastM: number, northM: number, altM: number, homeLat: number, homeLon: number): maplibregl.MercatorCoordinate {
	const ll = localToLonLat(eastM, northM, homeLat, homeLon);
	return maplibregl.MercatorCoordinate.fromLngLat({ lng: ll.lon, lat: ll.lat }, altM);
}

export class EnergyOverlayLayer implements maplibregl.CustomLayerInterface {
	public readonly id = "energy-overlay";
	public readonly type = "custom" as const;
	public readonly renderingMode = "3d" as const;

	private map: maplibregl.Map | undefined;
	private gl: GL | undefined;
	private program: WebGLProgram | undefined;
	private aPos = -1;
	private aUv = -1;
	private uMatrix: WebGLUniformLocation | null = null;
	private uTex: WebGLUniformLocation | null = null;
	private uAlpha: WebGLUniformLocation | null = null;

	private stripPosBuffer: WebGLBuffer | undefined;
	private stripUvBuffer: WebGLBuffer | undefined;
	private stripIndexBuffer: WebGLBuffer | undefined;
	private stripIndexCount = 0;
	private curveCanvas = document.createElement("canvas");
	private curveTexture: WebGLTexture | undefined;

	private sunPosBuffer: WebGLBuffer | undefined;
	private sunUvBuffer: WebGLBuffer | undefined;
	private sunIndexBuffer: WebGLBuffer | undefined;
	private sunTexture: WebGLTexture | undefined;
	private sunVisible = false;
	private sunEastM = 0;
	private sunNorthM = 0;
	private sunUpM = 0;
	private sunAlpha = 1;

	public constructor(
		private readonly homeLat: number,
		private readonly homeLon: number,
		private readonly radiusM: number,
		private readonly heightM: number,
		private readonly sides: number,
		private readonly sunSpriteRadiusM: number,
	) {}

	public onAdd(map: maplibregl.Map, gl: GL): void {
		this.map = map;
		this.gl = gl;

		const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SRC);
		const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
		const program = gl.createProgram()!;
		gl.attachShader(program, vertexShader);
		gl.attachShader(program, fragmentShader);
		gl.linkProgram(program);
		this.program = program;
		this.aPos = gl.getAttribLocation(program, "a_pos");
		this.aUv = gl.getAttribLocation(program, "a_uv");
		this.uMatrix = gl.getUniformLocation(program, "u_matrix");
		this.uTex = gl.getUniformLocation(program, "u_tex");
		this.uAlpha = gl.getUniformLocation(program, "u_alpha");

		this.buildStripMesh(gl);

		this.curveTexture = this.createTexture(gl);
		drawProjectionSurfaceTexture(this.curveCanvas, {
			wallColor: "#4fb0ff",
			sunPath: [],
			forecast: { points: [], color: "#ffb703", marker: null },
			actual: { points: [], color: "#2a9d8f" },
		});
		this.uploadTexture(gl, this.curveTexture, this.curveCanvas);

		this.sunPosBuffer = gl.createBuffer()!;
		this.sunUvBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.sunUvBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
		this.sunIndexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sunIndexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 1, 3, 2]), gl.STATIC_DRAW);
		this.sunTexture = this.createTexture(gl);
		const sunCanvas = document.createElement("canvas");
		drawSunSpriteTexture(sunCanvas);
		this.uploadTexture(gl, this.sunTexture, sunCanvas);
	}

	private buildStripMesh(gl: GL): void {
		const positions: number[] = [];
		const uvs: number[] = [];
		for (let i = 0; i <= this.sides; i++) {
			const angle = (i / this.sides) * 2 * Math.PI;
			const eastM = Math.sin(angle) * this.radiusM;
			const northM = Math.cos(angle) * this.radiusM;
			const bottom = toMercator(eastM, northM, 0, this.homeLat, this.homeLon);
			const top = toMercator(eastM, northM, this.heightM, this.homeLat, this.homeLon);
			positions.push(bottom.x, bottom.y, bottom.z, top.x, top.y, top.z);
			const u = i / this.sides;
			// v=0 samples the texture's first (topmost, in canvas pixel terms) row, v=1 the last -
			// WebGL uploads an HTMLCanvasElement's rows in that order without a Y-flip. The curve
			// texture draws its 0-value baseline at the BOTTOM of the canvas (see curveTexture.ts's
			// toPixel), so the ground/bottom mesh vertex must sample v=1 (canvas bottom = baseline)
			// and the wall-top vertex v=0 (canvas top = peak) - otherwise the baseline ends up
			// floating at the top of the wall instead of sitting flush on the map.
			uvs.push(u, 1, u, 0);
		}
		const indices: number[] = [];
		for (let i = 0; i < this.sides; i++) {
			const a = i * 2;
			const b = i * 2 + 1;
			const c = (i + 1) * 2;
			const d = (i + 1) * 2 + 1;
			indices.push(a, b, c, b, d, c);
		}
		this.stripPosBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.stripPosBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);
		this.stripUvBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ARRAY_BUFFER, this.stripUvBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.STATIC_DRAW);
		this.stripIndexBuffer = gl.createBuffer()!;
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.stripIndexBuffer);
		gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
		this.stripIndexCount = indices.length;
	}

	private createTexture(gl: GL): WebGLTexture {
		const texture = gl.createTexture()!;
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
		return texture;
	}

	private uploadTexture(gl: GL, texture: WebGLTexture | undefined, source: HTMLCanvasElement): void {
		if (!texture) {
			return;
		}
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
	}

	/**
	 * Redraws the whole projection surface texture (wall wash, sun path, forecast + actual curves)
	 * for the shown day and repaints. All point heights are ALREADY normalised to 0..1 of the
	 * wall's own height.
	 *
	 * @param content
	 */
	public setProjectionContent(content: ProjectionSurfaceContent): void {
		if (!this.gl || !this.curveTexture) {
			return;
		}
		drawProjectionSurfaceTexture(this.curveCanvas, content);
		this.uploadTexture(this.gl, this.curveTexture, this.curveCanvas);
		this.map?.triggerRepaint();
	}

	/**
	 * Updates the sun sprite's position (local meters) for the next frame; hides it when the sun
	 * is below the horizon. `alpha` dims the sprite under cloud cover, same idea as the old
	 * disc's opacity.
	 *
	 * @param visible
	 * @param eastM
	 * @param northM
	 * @param upM
	 * @param alpha
	 */
	public setSun(visible: boolean, eastM: number, northM: number, upM: number, alpha: number): void {
		this.sunVisible = visible;
		this.sunEastM = eastM;
		this.sunNorthM = northM;
		this.sunUpM = upM;
		this.sunAlpha = alpha;
		this.map?.triggerRepaint();
	}

	private updateSunQuad(gl: GL): void {
		const bearingRad = (this.map?.getBearing() ?? 0) * (Math.PI / 180);
		const rightE = Math.cos(bearingRad);
		const rightN = -Math.sin(bearingRad);
		const r = this.sunSpriteRadiusM;
		const corners: [number, number, number][] = [
			[this.sunEastM - rightE * r, this.sunNorthM - rightN * r, this.sunUpM - r],
			[this.sunEastM + rightE * r, this.sunNorthM + rightN * r, this.sunUpM - r],
			[this.sunEastM - rightE * r, this.sunNorthM - rightN * r, this.sunUpM + r],
			[this.sunEastM + rightE * r, this.sunNorthM + rightN * r, this.sunUpM + r],
		];
		const positions = new Float32Array(12);
		corners.forEach(([e, n, alt], i) => {
			const m = toMercator(e, n, alt, this.homeLat, this.homeLon);
			positions[i * 3] = m.x;
			positions[i * 3 + 1] = m.y;
			positions[i * 3 + 2] = m.z;
		});
		gl.bindBuffer(gl.ARRAY_BUFFER, this.sunPosBuffer!);
		gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
	}

	// Typed as maplibregl.CustomRenderMethod (rather than a regular method) so `matrix`'s type
	// (gl-matrix's `mat4`, not re-exported by name from maplibre-gl) is inferred instead of
	// needing its own import of a package we don't otherwise depend on directly.
	public readonly render: maplibregl.CustomRenderMethod = (gl, matrix) => {
		if (!this.program) {
			return;
		}
		gl.useProgram(this.program);
		gl.enable(gl.DEPTH_TEST);
		gl.depthFunc(gl.LEQUAL);
		gl.enable(gl.BLEND);
		// The fragment shader outputs premultiplied alpha (`c.rgb * c.a * u_alpha`), which needs
		// (ONE, ONE_MINUS_SRC_ALPHA) rather than the more common (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) -
		// without setting this explicitly, this layer inherits whatever blend func MapLibre's own
		// last-drawn layer happened to leave active, which varies frame to frame as tiles/layers
		// render in different order while the camera moves, causing exactly the kind of
		// rotation-dependent blending glitches this was chasing.
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
		// Translucent geometry should test against (be occluded by) opaque geometry like buildings,
		// but not write depth itself - the strip is a closed cylinder, so the camera always looks
		// through both its near and far wall at once, and both need to blend together rather than
		// have whichever one happens to rasterize first occlude the other via the depth buffer
		// (another source of view-angle-dependent flicker on top of the blend-func one above).
		gl.depthMask(false);
		gl.uniformMatrix4fv(this.uMatrix, false, matrix);
		gl.uniform1i(this.uTex, 0);
		gl.activeTexture(gl.TEXTURE0);

		gl.uniform1f(this.uAlpha, 1);
		gl.bindTexture(gl.TEXTURE_2D, this.curveTexture!);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.stripPosBuffer!);
		gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(this.aPos);
		gl.bindBuffer(gl.ARRAY_BUFFER, this.stripUvBuffer!);
		gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
		gl.enableVertexAttribArray(this.aUv);
		gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.stripIndexBuffer!);
		gl.drawElements(gl.TRIANGLES, this.stripIndexCount, gl.UNSIGNED_SHORT, 0);

		if (this.sunVisible) {
			this.updateSunQuad(gl);
			gl.uniform1f(this.uAlpha, this.sunAlpha);
			gl.bindTexture(gl.TEXTURE_2D, this.sunTexture!);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.sunPosBuffer!);
			gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ARRAY_BUFFER, this.sunUvBuffer!);
			gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, 0, 0);
			gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.sunIndexBuffer!);
			gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
		}

		// Restore - MapLibre's own layers expect the default (depth writes on) and this custom
		// layer isn't guaranteed to always be the last thing drawn in a frame.
		gl.depthMask(true);
	};
}
