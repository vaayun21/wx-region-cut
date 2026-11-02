/**
 * Minimal GRIB2 reader for the one thing this app needs: the regular
 * lat/lon wind fields the NCEP GRIB filter serves for an India subset.
 *
 * The sample file (dev-team/qa/wxmap0/download-notice.txt) was inspected
 * before writing this: every message in it uses data representation
 * template 5.0 (simple packing) and grid definition template 3.0
 * (regular lat/lon). Anything else raises a plain error rather than being
 * guessed at -- a silently wrong wind field is a safety problem.
 */
import { decodeAec } from './aec.ts'

export interface Grib2Packing {
  /** IEEE32 reference value R (octets 12-15 of section 5). */
  refValue: number
  /** Binary scale E. */
  binaryScale: number
  /** Decimal scale D. */
  decimalScale: number
  /** Bit width NB of each packed value (0 = every value equals R / 10^D). */
  bitsPerValue: number
  /** Data representation template (0 for simple packing, 42 for CCSDS AEC). */
  template?: number
  /** CCSDS compression parameters when template is 42. */
  aec?: {
    flags: number
    blockSize: number
    rsi: number
  }
}

export interface Grib2Field {
  /** Analysis time of the run (section 1 reference time), ISO-8601 UTC. */
  referenceTimeIso: string
  /** Forecast step from the reference time, hours (time unit 1 only). */
  forecastTimeHours: number
  /** Valid time = reference time + forecast step, ISO-8601 UTC. */
  validTimeIso: string
  /** GRIB2 parameter category (2 = momentum). */
  paramCategory: number
  /** GRIB2 parameter number (2 = U, 3 = V). */
  paramNumber: number
  /** Type of first fixed surface (1 = ground, 100 = isobaric, 103 = height above ground). */
  levelType: number
  /** The level as stored, in the template's own units (Pa for type 100, m for type 103). */
  levelValue: number
  /** user-facing level label: "sfc", "10 m", or "925 hPa" style pressure. */
  levelLabel: string
  ni: number
  nj: number
  /** Latitude of grid point (1, 1), degrees. */
  la1: number
  /** Longitude of grid point (1, 1), degrees. */
  lo1: number
  /** Latitude of grid point (ni, nj), degrees. */
  la2: number
  /** Longitude of grid point (ni, nj), degrees. */
  lo2: number
  scanningMode: number
  packing: Grib2Packing
  /** Decoded physical values in packed order (i fastest when i-consecutive). */
  values: Float32Array
}

export interface Grib2DecodeResult {
  fields: Grib2Field[]
  /** File size in bytes, echoed so a caller can report it. */
  byteLength: number
}

/** GRIB2 stores template 3.0 latitudes and longitudes as sign-and-magnitude, not two's complement. */
function signMag32(b: Uint8Array, o: number): number {
  const v = u32(b, o)
  return v >= 0x80000000 ? -(v - 0x80000000) : v
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1]
}

function u32(b: Uint8Array, o: number): number {
  // Multiplying keeps the result exact for every size a grid can reach here.
  return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])
}

/** GRIB2 scale factors (binary and decimal) are 16-bit sign-and-magnitude, not two's complement. */
function signMag16(b: Uint8Array, o: number): number {
  const v = (b[o] << 8) | b[o + 1]
  return v & 0x8000 ? -(v & 0x7fff) : v
}

function i16(b: Uint8Array, o: number): number {
  const v = u16(b, o)
  return v > 0x7fff ? v - 0x10000 : v
}

function i32(b: Uint8Array, o: number): number {
  const v = u32(b, o)
  return v > 0x7fffffff ? v - 0x100000000 : v
}

function f32(b: Uint8Array, o: number): number {
  const view = new DataView(b.buffer, b.byteOffset + o, 4)
  return view.getFloat32(0, false)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** "Level" as the user sees it, from the template's own surface type and value. */
function levelLabel(levelType: number, levelValue: number): string {
  if (levelType === 100) return `${Math.round(levelValue / 100)} hPa`
  if (levelType === 103) return levelValue === 0 ? 'sfc' : `${levelValue} m`
  if (levelType === 1) return 'sfc'
  return `type${levelType}:${levelValue}`
}

/**
 * Unpacks template 5.0 (simple packing): Y = (R + X * 2^E) / 10^D,
 * X = NB-bit unsigned big-endian integers packed continuously from `data`.
 */
function unpackSimple(
  data: Uint8Array,
  offset: number,
  ndpts: number,
  packing: Grib2Packing,
): Float32Array {
  const out = new Float32Array(ndpts)
  const { refValue, binaryScale, decimalScale, bitsPerValue } = packing
  // Y = (R + X * 2^E) * 10^(-D) -- the decimal scale applies to R as well.
  const binaryFactor = Math.pow(2, binaryScale)
  const decimalFactor = Math.pow(10, -decimalScale)
  if (bitsPerValue === 0) {
    out.fill(refValue * decimalFactor)
    return out
  }
  const totalBits = ndpts * bitsPerValue
  const available = (data.length - offset) * 8
  if (totalBits > available) {
    throw new Error(`GRIB2 section 7 too short: need ${totalBits} bits, have ${available}`)
  }
  let bitPos = 0
  for (let n = 0; n < ndpts; n++) {
    let acc = 0
    let left = bitsPerValue
    while (left > 0) {
      const byteIndex = offset + (bitPos >> 3)
      const skip = bitPos & 7
      const take = Math.min(8 - skip, left)
      const chunk = (data[byteIndex] >> (8 - skip - take)) & ((1 << take) - 1)
      acc = (acc << take) | chunk
      bitPos += take
      left -= take
    }
    out[n] = (refValue + acc * binaryFactor) * decimalFactor
  }
  return out
}

function decodeMessage(b: Uint8Array, msgStart: number, totalLength: number): Grib2Field {
  let pos = msgStart + 16
  const end = msgStart + totalLength - 4
  let refTimeIso = ''
  let forecastTimeHours = 0
  let paramCategory = -1
  let paramNumber = -1
  let levelType = -1
  let levelValue = 0
  let ni = 0
  let nj = 0
  let la1 = 0
  let lo1 = 0
  let la2 = 0
  let lo2 = 0
  let scanningMode = -1
  let packing: Grib2Packing | null = null
  let values: Float32Array | null = null
  let packedCount = 0
  let bitmap: Uint8Array | null = null

  while (pos < end) {
    const len = u32(b, pos)
    if (len < 5 || pos + len > b.length) throw new Error(`bad GRIB2 section length ${len} at ${pos}`)
    const id = b[pos + 4]
    if (id === 1) {
      const year = u16(b, pos + 12)
      const month = b[pos + 14]
      const day = b[pos + 15]
      const hour = b[pos + 16]
      const minute = b[pos + 17]
      const second = b[pos + 18]
      refTimeIso = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}Z`
    } else if (id === 3) {
      const tmpl = u16(b, pos + 12)
      if (tmpl !== 0) throw new Error(`unsupported grid definition template ${tmpl}`)
      ni = u32(b, pos + 30)
      nj = u32(b, pos + 34)
      la1 = signMag32(b, pos + 46) / 1e6
      lo1 = signMag32(b, pos + 50) / 1e6
      la2 = signMag32(b, pos + 55) / 1e6
      lo2 = signMag32(b, pos + 59) / 1e6
      scanningMode = b[pos + 71]
    } else if (id === 4) {
      const tmpl = u16(b, pos + 7)
      // 4.0 = instant values; 4.8 = statistics over a time interval (accumulations, maxima): same leading octets.
      if (tmpl !== 0 && tmpl !== 8) throw new Error(`unsupported product definition template ${tmpl}`)
      paramCategory = b[pos + 9]
      paramNumber = b[pos + 10]
      const timeUnit = b[pos + 17]
      const forecastTime = u32(b, pos + 18)
      if (timeUnit !== 1) throw new Error(`unsupported time unit ${timeUnit} (only hours)`)
      forecastTimeHours = forecastTime
      if (tmpl === 8) {
        // The value belongs to the END of the interval (octets 35-41: year, month, day, hour, minute, second).
        const endMs = Date.UTC(u16(b, pos + 34), b[pos + 36] - 1, b[pos + 37], b[pos + 38], b[pos + 39], b[pos + 40])
        const refMs = Date.parse(refTimeIso)
        if (Number.isFinite(endMs) && Number.isFinite(refMs) && endMs >= refMs) forecastTimeHours = (endMs - refMs) / 3_600_000
      }
      levelType = b[pos + 22]
      levelValue = i32(b, pos + 24) * Math.pow(10, -b[pos + 23])
    } else if (id === 5) {
      packedCount = u32(b, pos + 5)
      const tmpl = u16(b, pos + 9)
      if (tmpl !== 0 && tmpl !== 42) {
        throw new Error(`unsupported data representation template ${tmpl} (only 5.0 simple packing or 5.42 lossless compression)`)
      }
      packing = {
        template: tmpl,
        refValue: f32(b, pos + 11),
        binaryScale: signMag16(b, pos + 15),
        decimalScale: signMag16(b, pos + 17),
        bitsPerValue: b[pos + 19],
      }
      if (tmpl === 42) {
        packing.aec = {
          flags: b[pos + 21],
          blockSize: b[pos + 22],
          rsi: u16(b, pos + 23),
        }
      }
    } else if (id === 6) {
      const indicator = b[pos + 5]
      // The NOMADS-filtered GFS sample writes indicator 255 with a zero-octet
      // section 6 (length 6) and packs every point; the count check in
      // section 7 proves it. Only a real bitmap body is parsed as one.
      const bitmapOctets = len - 6
      if (indicator === 0 || bitmapOctets === 0) {
        bitmap = null
      } else if (indicator === 255) {
        bitmap = b.subarray(pos + 6, pos + len)
      } else {
        throw new Error(`unsupported bitmap indicator ${indicator} (only 0 or 255)`)
      }
    } else if (id === 7) {
      if (!packing) throw new Error('GRIB2 section 7 before section 5')
      const gridPoints = ni * nj
      if (bitmap) {
        let set = 0
        for (let k = 0; k < gridPoints; k++) {
          if ((bitmap[k >> 3] >> (7 - (k & 7))) & 1) set++
        }
        if (set !== packedCount) {
          throw new Error(`section 5 packed count ${packedCount} != bitmap set bits ${set}`)
        }
      } else if (packedCount !== gridPoints) {
        throw new Error(`section 5 ndpts ${packedCount} != ni*nj ${gridPoints}`)
      }
      let packed: Float32Array
      if (packing.bitsPerValue === 0) {
        packed = new Float32Array(packedCount)
        packed.fill(packing.refValue * Math.pow(10, -packing.decimalScale))
      } else if (packing.template === 42) {
        if (!packing.aec) throw new Error('GRIB2 template 5.42 is missing its compression parameters')
        const sec7Payload = b.subarray(pos + 5, pos + len)
        const aecInts = decodeAec(sec7Payload, {
          bitsPerSample: packing.bitsPerValue,
          blockSize: packing.aec.blockSize,
          rsi: packing.aec.rsi,
          flags: packing.aec.flags,
        }, packedCount)
        packed = new Float32Array(packedCount)
        const binaryFactor = Math.pow(2, packing.binaryScale)
        const decimalFactor = Math.pow(10, -packing.decimalScale)
        for (let n = 0; n < packedCount; n++) {
          packed[n] = (packing.refValue + aecInts[n] * binaryFactor) * decimalFactor
        }
      } else {
        packed = unpackSimple(b, pos + 5, packedCount, packing)
      }
      values = new Float32Array(gridPoints)
      if (bitmap) {
        let p = 0
        for (let k = 0; k < gridPoints; k++) {
          values[k] = (bitmap[k >> 3] >> (7 - (k & 7))) & 1 ? packed[p++] : NaN
        }
      } else {
        values.set(packed)
      }
    }
    pos += len
  }

  if (!values || !packing) throw new Error('GRIB2 message without decodable section 5/7')
  if (values.length !== ni * nj) {
    throw new Error(`GRIB2 value count ${values.length} != ni*nj ${ni * nj}`)
  }
  // i-consecutive (typical) only: values[j * ni + i], point (1,1) at (la1, lo1).
  if ((scanningMode & 0x20) !== 0) {
    throw new Error(`unsupported scanning mode 0x${scanningMode.toString(16)} (j-consecutive)`)
  }

  const referenceMs = Date.parse(refTimeIso)
  const validMs = referenceMs + forecastTimeHours * 3600_000
  const valid = new Date(validMs)
  const validTimeIso = `${valid.getUTCFullYear()}-${pad2(valid.getUTCMonth() + 1)}-${pad2(
    valid.getUTCDate(),
  )}T${pad2(valid.getUTCHours())}:${pad2(valid.getUTCMinutes())}:${pad2(valid.getUTCSeconds())}Z`
  return {
    referenceTimeIso: refTimeIso,
    forecastTimeHours,
    validTimeIso,
    paramCategory,
    paramNumber,
    levelType,
    levelValue,
    levelLabel: levelLabel(levelType, levelValue),
    ni,
    nj,
    la1,
    lo1,
    la2,
    lo2,
    scanningMode,
    packing,
    values,
  }
}

/** Decodes every message in a GRIB2 file, in file order. */
export function decodeGrib2(bytes: Uint8Array): Grib2DecodeResult {
  const fields: Grib2Field[] = []
  let off = 0
  while (off + 16 <= bytes.length) {
    if (bytes[off] !== 0x47 || bytes[off + 1] !== 0x52 || bytes[off + 2] !== 0x49 || bytes[off + 3] !== 0x42) {
      off += 1
      continue
    }
    const edition = bytes[off + 7]
    if (edition !== 2) throw new Error(`unsupported GRIB edition ${edition}`)
    // Total length is an 8-byte big-endian count in octets 9-16.
    const hi = u32(bytes, off + 8)
    const lo = u32(bytes, off + 12)
    const total = hi * 0x100000000 + lo
    if (total <= 0 || off + total > bytes.length) throw new Error(`bad GRIB2 total length ${total}`)
    fields.push(decodeMessage(bytes, off, total))
    off += total
  }
  return { fields, byteLength: bytes.length }
}
