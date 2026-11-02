/**
 * WGR1 extended compact grid: what the model-weather pack writes and the
 * client loads. Same wire layout as the windGrid prototype (magic, uint16
 * header length, JSON meta, little-endian planes) so the two codecs can read
 * each other's two-plane wind files; this one adds a scale/offset pair, a
 * one-plane scalar form and a uint8 form for cloud percent.
 *
 * Layout (little-endian throughout):
 *   0..3   magic "WGR1"
 *   4..5   uint16 headerJsonLength
 *   6..    header JSON (UTF-8)
 *   then   plane 0, plane 1 (Int16 or Uint8, nx*ny each)
 *
 * Value on the wire: value = raw / scale + offset  (raw = (value - offset) * scale).
 * Classic prototype files are readable here: no offset (0), always two Int16
 * planes, units under "units" instead of "unit".
 */

export const WGR1_MAGIC = 'WGR1'
export const WGR1_HEADER_OFFSET = 6

/** m/s are stored as Int16 at this scale: 0.01 m/s resolution, +/-327.67 m/s. */
export const DEFAULT_SCALE = 100

export type Wgr1Pack = 'int16' | 'uint8'

export interface Wgr1Meta {
  /** Model name shown to the user, e.g. "GFS 0.25". */
  model: string
  /** Pack field id, e.g. "wind925". */
  fieldId: string
  /** "2 m" | "925 hPa" | "entire atmosphere" | ... */
  level: string
  /** Unit of the decoded value: "m/s" | "K" | "Pa" | "%" | ... */
  unit: string
  /** Analysis time of the run (ISO-8601 UTC). */
  referenceTimeIso: string
  /** Valid time of this field (ISO-8601 UTC). */
  validTimeIso: string
  /** Where the data came from, for the advisory label. */
  source: string
  nx: number
  ny: number
  /** Latitude of the j = 0 row (degrees). */
  lat0: number
  /** Latitude step between rows (degrees; negative when rows run north to south). */
  dLat: number
  lon0: number
  dLon: number
  /** Number of planes: 1 scalar, 2 wind (u then v). */
  planes: number
  pack: Wgr1Pack
  /** Int16/Uint8 -> value divisor. */
  scale: number
  /** Value of raw 0. */
  offset: number
  min: number
  max: number
}

export interface Wgr1Grid {
  meta: Wgr1Meta
  /** Decoded planes, row-major j * nx + i. */
  planes: Float32Array[]
}

/** The scale and offset that keep every value of [min, max] inside the pack. */
export function pickScaleOffset(min: number, max: number): { scale: number; offset: number } {
  const offset = min
  const span = max - min
  if (!(span > 0)) return { scale: DEFAULT_SCALE, offset }
  // Largest power-of-10 divisor whose raws (span * scale) still fit in Int16.
  const scale = 10 ** Math.floor(Math.log10(32767 / span))
  return { scale, offset }
}

function quantize(value: number, meta: Wgr1Meta): number {
  // Missing data keeps an explicit marker, never a valid value: -32768 for
  // Int16 planes, 255 for uint8 planes (valid uint8 data clamps to 254).
  if (!Number.isFinite(value)) return meta.pack === 'uint8' ? 255 : -32768
  const raw = Math.round((value - meta.offset) * meta.scale)
  if (meta.pack === 'uint8') return raw > 254 ? 254 : raw < 0 ? 0 : raw
  return raw > 32767 ? 32767 : raw < -32768 ? -32768 : raw
}

/** Builds the on-disk bytes for one (field, step) grid. */
export function encodeWgr1(meta: Wgr1Meta, planes: Float32Array[]): Uint8Array {
  const n = meta.nx * meta.ny
  const count = meta.planes
  if (planes.length !== count) {
    throw new Error(`wgr1 plane count mismatch: meta says ${count}, got ${planes.length}`)
  }
  for (let p = 0; p < count; p++) {
    if (planes[p].length !== n) {
      throw new Error(`wgr1 length mismatch: expected ${n}, got ${planes[p].length}`)
    }
  }
  const headerJson = new TextEncoder().encode(JSON.stringify(meta))
  if (headerJson.length > 0xffff) throw new Error('wgr1 header too long')
  const bytesPer = meta.pack === 'uint8' ? 1 : 2
  const total = WGR1_HEADER_OFFSET + headerJson.length + n * count * bytesPer
  const out = new Uint8Array(total)
  out[0] = 0x57
  out[1] = 0x47
  out[2] = 0x52
  out[3] = 0x31
  out[4] = headerJson.length & 0xff
  out[5] = (headerJson.length >> 8) & 0xff
  out.set(headerJson, WGR1_HEADER_OFFSET)
  const payload = WGR1_HEADER_OFFSET + headerJson.length
  // DataView, not Int16Array: the header length is not guaranteed even.
  const view = new DataView(out.buffer, out.byteOffset + payload, n * count * bytesPer)
  for (let p = 0; p < count; p++) {
    for (let i = 0; i < n; i++) {
      const raw = quantize(planes[p][i], meta)
      if (meta.pack === 'uint8') view.setUint8(p * n + i, raw)
      else view.setInt16((p * n + i) * 2, raw, true)
    }
  }
  return out
}

/**
 * Reads back one (field, step) grid; throws on a wrong magic or short buffer.
 * Classic windGrid files (no offset / planes / pack / fieldId) decode with
 * their historical defaults: offset 0, two Int16 planes, units under "units".
 */
export function decodeWgr1(bytes: Uint8Array): Wgr1Grid {
  if (
    bytes.length < WGR1_HEADER_OFFSET ||
    bytes[0] !== 0x57 ||
    bytes[1] !== 0x47 ||
    bytes[2] !== 0x52 ||
    bytes[3] !== 0x31
  ) {
    throw new Error('not a WGR1 compact grid')
  }
  const headerLen = bytes[4] | (bytes[5] << 8)
  const headerEnd = WGR1_HEADER_OFFSET + headerLen
  if (bytes.length < headerEnd) throw new Error('wgr1 truncated before header')
  const raw = JSON.parse(new TextDecoder().decode(bytes.subarray(WGR1_HEADER_OFFSET, headerEnd))) as Record<string, unknown>
  const planes = typeof raw.planes === 'number' ? (raw.planes as number) : 2
  const pack: Wgr1Pack = raw.pack === 'uint8' ? 'uint8' : 'int16'
  const scale = typeof raw.scale === 'number' ? (raw.scale as number) : DEFAULT_SCALE
  const offset = typeof raw.offset === 'number' ? (raw.offset as number) : 0
  const meta: Wgr1Meta = {
    model: String(raw.model ?? ''),
    fieldId: String(raw.fieldId ?? ''),
    level: String(raw.level ?? ''),
    unit: String(raw.unit ?? raw.units ?? ''),
    referenceTimeIso: String(raw.referenceTimeIso ?? ''),
    validTimeIso: String(raw.validTimeIso ?? ''),
    source: String(raw.source ?? ''),
    nx: Number(raw.nx),
    ny: Number(raw.ny),
    lat0: Number(raw.lat0),
    dLat: Number(raw.dLat),
    lon0: Number(raw.lon0),
    dLon: Number(raw.dLon),
    planes,
    pack,
    scale,
    offset,
    min: 0,
    max: 0,
  }
  const n = meta.nx * meta.ny
  const bytesPer = pack === 'uint8' ? 1 : 2
  const need = headerEnd + n * planes * bytesPer
  if (bytes.length < need) throw new Error(`wgr1 truncated: need ${need} bytes, have ${bytes.length}`)
  const view = new DataView(bytes.buffer, bytes.byteOffset + headerEnd, n * planes * bytesPer)
  const out: Float32Array[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (let p = 0; p < planes; p++) {
    const plane = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const at = p * n + i
      const rawV = pack === 'uint8' ? view.getUint8(at) : view.getInt16(at * 2, true)
      // Missing markers decode to NaN ("no data"): -32768 for Int16, 255 for uint8.
      const missing = pack === 'uint8' ? rawV === 255 : rawV === -32768
      const value = missing ? NaN : rawV / scale + offset
      plane[i] = value
      if (value < min) min = value
      if (value > max) max = value
    }
    out.push(plane)
  }
  meta.min = typeof raw.min === 'number' ? (raw.min as number) : (Number.isFinite(min) ? min : 0)
  meta.max = typeof raw.max === 'number' ? (raw.max as number) : (Number.isFinite(max) ? max : 0)
  return { meta, planes: out }
}
