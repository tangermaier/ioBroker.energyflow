// Portions derived from Helios (https://github.com/ReikanYsora/Helios), (c) ReikanYsora, GPL-3.0-only.
/**
 * Minimal Mapbox Vector Tile (MVT 2.1) decoder, zero-dependency. Ported near-verbatim from
 * Helios (https://github.com/ReikanYsora/Helios, src/scene/vector-tile.ts, GPL-3.0-only - same
 * license as this project, chosen specifically to allow this kind of reuse). Decodes only what
 * the building-shadow pipeline needs: named layers, each feature's type, rings (tile-local
 * integer coordinates 0..extent) and resolved string/number tags.
 *
 * Wire format (protobuf proto2): each field is a varint tag = fieldNumber * 8 + wireType,
 * followed by the payload. wireType 0 = varint, 1 = 64-bit, 2 = length-delimited
 * (string/bytes/embedded message), 5 = 32-bit. Hand-rolled varint/zigzag readers walk the
 * Tile -> Layer -> Feature nesting, skipping every field not consumed.
 */

/**
 * ZigZag decode: unsigned n back to the signed value protobuf encoded it from (0,1,2,3 -> 0,-1,1,-2).
 *
 * @param n
 */
function zigzag(n: number): number {
	return n % 2 === 0 ? n / 2 : -(n + 1) / 2;
}

const textDecoder = new TextDecoder();

export interface MvtFeature {
	/** 1 = point, 2 = linestring, 3 = polygon. */
	type: number;
	/** Rings in tile-local integer units [0, extent]. */
	rings: number[][][];
	tags: Record<string, string | number>;
}

export interface MvtLayer {
	name: string;
	extent: number;
	features: MvtFeature[];
}

/** Cursor over a Uint8Array with the protobuf primitives the decoder needs. */
class Reader {
	public pos = 0;

	public constructor(private readonly buf: Uint8Array) {}

	public get end(): number {
		return this.buf.length;
	}

	/** Unsigned base-128 varint. */
	public varint(): number {
		let result = 0;
		let shift = 0;
		for (;;) {
			if (this.pos >= this.buf.length) {
				throw new Error("mvt: varint past end of buffer");
			}
			const byte = this.buf[this.pos++];
			result += (byte % 128) * 2 ** shift;
			if (byte < 128) {
				return result;
			}
			shift += 7;
		}
	}

	public bytes(): Uint8Array {
		const len = this.varint();
		const slice = this.buf.subarray(this.pos, this.pos + len);
		this.pos += len;
		return slice;
	}

	public string(): string {
		return textDecoder.decode(this.bytes());
	}

	/** IEEE-754 little-endian, for MVT Value float/double columns. */
	public float(): number {
		const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
		this.pos += 4;
		return v;
	}

	public double(): number {
		const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
		this.pos += 8;
		return v;
	}

	/**
	 * Skip a field's payload given its wire type, so unknown fields never derail the walk.
	 *
	 * @param wireType
	 */
	public skip(wireType: number): void {
		switch (wireType) {
			case 0:
				this.varint();
				break;
			case 1:
				this.pos += 8;
				break;
			case 2: {
				const len = this.varint();
				this.pos += len;
				break;
			}
			case 5:
				this.pos += 4;
				break;
			default:
				throw new Error(`mvt: unknown wire type ${wireType} at pos ${this.pos}`);
		}
	}
}

/**
 * Decode one MVT Value message into its string or number.
 *
 * @param r
 */
function readValue(r: Reader): string | number {
	const msgLen = r.varint();
	const end = r.pos + msgLen;
	let out: string | number = "";
	while (r.pos < end) {
		const tag = r.varint();
		const field = Math.floor(tag / 8);
		switch (field) {
			case 1:
				out = r.string();
				break;
			case 2:
				out = r.float();
				break;
			case 3:
				out = r.double();
				break;
			case 4:
				out = r.varint();
				break;
			case 5:
				out = r.varint();
				break;
			case 6:
				out = zigzag(r.varint());
				break;
			case 7:
				out = r.varint() ? 1 : 0;
				break;
			default:
				r.skip(tag % 8);
				break;
		}
	}
	return out;
}

/**
 * Decode a feature's packed geometry commands into rings of [x, y] integer points (tile-local).
 * Command integer = id + count * 8; id 1 = MoveTo, 2 = LineTo, 7 = ClosePath. Params are zigzag deltas.
 *
 * @param data
 */
function decodeGeometry(data: number[]): number[][][] {
	const rings: number[][][] = [];
	let ring: number[][] = [];
	let x = 0;
	let y = 0;
	let i = 0;
	while (i < data.length) {
		const cmd = data[i++];
		const id = cmd % 8;
		const count = Math.floor(cmd / 8);
		if (id === 1) {
			if (ring.length) {
				rings.push(ring);
			}
			ring = [];
			for (let c = 0; c < count; c++) {
				x += zigzag(data[i]);
				i++;
				y += zigzag(data[i]);
				i++;
				ring.push([x, y]);
			}
		} else if (id === 2) {
			for (let c = 0; c < count; c++) {
				x += zigzag(data[i]);
				i++;
				y += zigzag(data[i]);
				i++;
				ring.push([x, y]);
			}
		}
		// id 7 = ClosePath: no params; the ring closes implicitly, caller treats it as an open ring.
	}
	if (ring.length) {
		rings.push(ring);
	}
	return rings;
}

/**
 * Read a packed repeated-varint field (tags, geometry) into a number array.
 *
 * @param r
 */
function readPacked(r: Reader): number[] {
	const msgLen = r.varint();
	const end = r.pos + msgLen;
	const out: number[] = [];
	while (r.pos < end) {
		out.push(r.varint());
	}
	return out;
}

/**
 * Decode a Feature message: type (field 3), packed tags (field 2), packed geometry (field 4).
 * Tags are resolved against the layer's keys/values tables into a plain record.
 *
 * @param r
 * @param keys
 * @param values
 */
function readFeature(r: Reader, keys: string[], values: (string | number)[]): MvtFeature {
	const msgLen = r.varint();
	const end = r.pos + msgLen;
	let type = 0;
	let tagInts: number[] = [];
	let geomInts: number[] = [];
	while (r.pos < end) {
		const tag = r.varint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (field === 3) {
			type = r.varint();
		} else if (field === 2) {
			tagInts = readPacked(r);
		} else if (field === 4) {
			geomInts = readPacked(r);
		} else {
			r.skip(wire);
		}
	}
	const tags: Record<string, string | number> = {};
	for (let i = 0; i + 1 < tagInts.length; i += 2) {
		const k = keys[tagInts[i]];
		const v = values[tagInts[i + 1]];
		if (k !== undefined && v !== undefined) {
			tags[k] = v;
		}
	}
	return { type, rings: decodeGeometry(geomInts), tags };
}

/**
 * Decode a Layer message: name (1), features (2), keys (3), values (4), extent (5, default 4096).
 *
 * @param r
 */
function readLayer(r: Reader): MvtLayer {
	const msgLen = r.varint();
	const end = r.pos + msgLen;
	let name = "";
	let extent = 4096;
	const keys: string[] = [];
	const values: (string | number)[] = [];
	// keys/values can appear after features in the stream, so each feature's start offset is recorded and
	// decoded in a second pass once the tables are complete.
	const featureSlices: { pos: number }[] = [];
	while (r.pos < end) {
		const tag = r.varint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		switch (field) {
			case 1:
				name = r.string();
				break;
			case 2:
				featureSlices.push({ pos: r.pos });
				r.skip(wire);
				break;
			case 3:
				keys.push(r.string());
				break;
			case 4:
				values.push(readValue(r));
				break;
			case 5:
				extent = r.varint();
				break;
			default:
				r.skip(wire);
				break;
		}
	}
	const features: MvtFeature[] = [];
	for (const slice of featureSlices) {
		r.pos = slice.pos;
		features.push(readFeature(r, keys, values));
	}
	r.pos = end;
	return { name, extent, features };
}

/**
 * Decode a whole tile: repeated Layer at field 3. Returns every layer; the caller filters by name.
 *
 * @param buf
 */
export function decodeVectorTile(buf: Uint8Array): MvtLayer[] {
	const r = new Reader(buf);
	const layers: MvtLayer[] = [];
	while (r.pos < r.end) {
		const tag = r.varint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (field === 3) {
			layers.push(readLayer(r));
		} else {
			r.skip(wire);
		}
	}
	return layers;
}
