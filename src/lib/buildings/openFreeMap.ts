// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * OpenFreeMap buildings source: fetches the vector tiles covering a radius around the home,
 * decodes their `building` layer, and returns every footprint ring in lon/lat plus its real
 * height. Ported/adapted from Helios (https://github.com/ReikanYsora/Helios,
 * src/scene/openfreemap.ts, GPL-3.0-only - same license as this project) for a Node.js backend
 * fetch instead of a browser one - no AbortSignal/cancellation plumbing needed here, this runs
 * once at startup plus a daily refresh, not per-frame.
 *
 * OpenFreeMap (https://openfreemap.org) serves OpenStreetMap data as free, no-key, CORS-open
 * vector tiles. Data (c) OpenStreetMap contributors, ODbL.
 */

import { decodeVectorTile } from "./vectorTile.js";

const OFM_TILEJSON_URL = "https://tiles.openfreemap.org/planet";
/** Building geometry is complete at the tileset's max zoom; a whole radius fits in a handful of tiles. */
const OFM_TILE_ZOOM = 14;
const OFM_FETCH_TIMEOUT_MS = 10_000;
const METRES_PER_DEGREE = 111_320;
const DEG = Math.PI / 180;

/** One footprint ring from a tile: vertices in [lon, lat], plus the OSM render height (m) or null when untagged. */
export interface OfmRing {
	lonLat: [number, number][];
	heightM: number | null;
}

/**
 * Fetches a URL with a timeout, since fetch has no native one - a hung request would otherwise
 * stall the whole tile set.
 *
 * @param url - the URL to fetch
 */
function fetchWithTimeout(url: string): Promise<Response> {
	return fetch(url, { signal: AbortSignal.timeout(OFM_FETCH_TIMEOUT_MS) });
}

/** Resolves the current versioned tile URL template from the TileJSON (the planet snapshot rotates periodically). */
async function resolveTemplate(): Promise<string | null> {
	const res = await fetchWithTimeout(OFM_TILEJSON_URL);
	if (!res.ok) {
		return null;
	}
	const tj = (await res.json()) as { tiles?: unknown };
	const t = Array.isArray(tj.tiles) ? tj.tiles[0] : undefined;
	return typeof t === "string" && t.includes("{z}") ? t : null;
}

/**
 * Web Mercator: lon/lat -> fractional tile coordinates at the given zoom.
 *
 * @param lon
 * @param lat
 * @param zoom
 */
function lonLatToTile(lon: number, lat: number, zoom: number): { x: number; y: number } {
	const world = 2 ** zoom;
	const latRad = lat * DEG;
	const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
	return { x: ((lon + 180) / 360) * world, y: y * world };
}

/**
 * Tile-local pixel (0..extent) in tile (tx, ty) back to lon/lat (slippy-map inverse).
 *
 * @param tx
 * @param ty
 * @param px
 * @param py
 * @param extent
 * @param z
 */
function tilePixelToLonLat(tx: number, ty: number, px: number, py: number, extent: number, z: number): { lon: number; lat: number } {
	const n = 2 ** z;
	const wx = tx + px / extent;
	const wy = ty + py / extent;
	return {
		lon: (wx / n) * 360 - 180,
		lat: (Math.atan(Math.sinh(Math.PI * (1 - (2 * wy) / n))) * 180) / Math.PI,
	};
}

/**
 * Real building height from the tile tags: OFM pre-computes `render_height` (m); null when absent/non-positive.
 *
 * @param tags
 */
function ringHeight(tags: Record<string, string | number>): number | null {
	const h = tags.render_height;
	return typeof h === "number" && Number.isFinite(h) && h > 0 ? h : null;
}

/**
 * Does this tile OWN the ring (its centroid falls inside the tile's own cell, not the buffer)?
 *
 * @param ring
 * @param extent
 */
function tileOwnsRing(ring: number[][], extent: number): boolean {
	let cx = 0;
	let cy = 0;
	for (const [px, py] of ring) {
		cx += px;
		cy += py;
	}
	cx /= ring.length;
	cy /= ring.length;
	return cx >= 0 && cx < extent && cy >= 0 && cy < extent;
}

/**
 * Shoelace signed area of a ring in tile-local coordinates. Positive = exterior ring, negative = interior (hole).
 *
 * @param ring
 */
function ringSignedArea(ring: number[][]): number {
	let area = 0;
	for (let i = 0; i < ring.length; i++) {
		const n = (i + 1) % ring.length;
		area += ring[i][0] * ring[n][1] - ring[n][0] * ring[i][1];
	}
	return area;
}

/**
 * Fetches every building footprint ring within `radiusM` of the home. Returns null on a total
 * outage (no template, or no tile answered), the rings otherwise ([] = the area genuinely has
 * no mapped buildings).
 *
 * @param homeLat - home latitude in degrees
 * @param homeLon - home longitude in degrees
 * @param radiusM - how far around the home to fetch, in meters
 */
export async function fetchOfmBuildingRings(homeLat: number, homeLon: number, radiusM: number): Promise<OfmRing[] | null> {
	const template = await resolveTemplate();
	if (!template) {
		return null;
	}

	const z = OFM_TILE_ZOOM;
	const perLon = METRES_PER_DEGREE * Math.cos(homeLat * DEG);
	const dLat = radiusM / METRES_PER_DEGREE;
	const dLon = radiusM / perLon;
	const nw = lonLatToTile(homeLon - dLon, homeLat + dLat, z);
	const se = lonLatToTile(homeLon + dLon, homeLat - dLat, z);
	const x0 = Math.floor(nw.x);
	const x1 = Math.floor(se.x);
	const y0 = Math.floor(nw.y);
	const y1 = Math.floor(se.y);

	const rings: OfmRing[] = [];
	let anyOk = false;

	for (let tx = x0; tx <= x1; tx++) {
		for (let ty = y0; ty <= y1; ty++) {
			const url = template.replace("{z}", String(z)).replace("{x}", String(tx)).replace("{y}", String(ty));
			try {
				const res = await fetchWithTimeout(url);
				if (!res.ok) {
					throw new Error(String(res.status));
				}
				const buf = new Uint8Array(await res.arrayBuffer());
				const layer = decodeVectorTile(buf).find(l => l.name === "building");
				anyOk = true;
				if (layer) {
					for (const feature of layer.features) {
						const heightM = ringHeight(feature.tags);
						for (const ring of feature.rings) {
							if (ring.length < 3) {
								continue;
							}
							// Keep exterior rings only (courtyard/atrium holes have a negative signed area) - a
							// hole is not a caster, drawing it as one would litter phantom shadows.
							if (ringSignedArea(ring) <= 0) {
								continue;
							}
							// Tile ownership: every tile repeats its neighbours' geometry inside a buffer, so one
							// building arrives from up to four tiles. Keeping a ring only from the tile whose cell
							// contains its centroid delivers every building once and whole.
							if (!tileOwnsRing(ring, layer.extent)) {
								continue;
							}
							rings.push({
								lonLat: ring.map(([px, py]) => {
									const ll = tilePixelToLonLat(tx, ty, px, py, layer.extent, z);
									return [ll.lon, ll.lat] as [number, number];
								}),
								heightM,
							});
						}
					}
				}
			} catch {
				// Tile failed (timeout / HTTP error): skip it, the others still contribute their buildings.
			}
		}
	}

	return anyOk ? rings : null;
}
