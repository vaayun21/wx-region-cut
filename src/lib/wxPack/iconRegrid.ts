/**
 * Pure functions for regridding the DWD ICON icosahedral grid to a regular
 * latitude/longitude grid over the India box, and decoding ICON GRIB2 messages.
 *
 * Safety note: Weather model data is advisory. Regridding preserves physical
 * values; coordinates and row order must match the GFS pack exactly so layers
 * align on the Weather map.
 */

import { decodeAec } from '../windGrid/aec.ts'

export interface ForecastGrid {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
  dLat: number
  dLon: number
  nx: number
  ny: number
}

/** Forecast box: latitude 0 (equator) to 45 N, longitude 20 E to 155 E. Preserved for backward compatibility. */
export const FORECAST_GRID: Readonly<ForecastGrid> = Object.freeze({
  minLat: 0.0,
  maxLat: 45.0,
  minLon: 20.0,
  maxLon: 155.0,
  dLat: 0.125,
  dLon: 0.125,
  nx: Math.round((155.0 - 20.0) / 0.125) + 1, // 1081
  ny: Math.round((45.0 - 0.0) / 0.125) + 1,   // 361
})

export const DEG_TO_RAD = Math.PI / 180.0
export const RAD_TO_DEG = 180.0 / Math.PI
export const LOOKUP_MAGIC = 'ICLK'
export const LOOKUP_VERSION = 1

export interface SpatialIndexBounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

export interface SpatialIndex {
  bounds: SpatialIndexBounds
  minLatBin: number
  maxLatBin: number
  minLonBin: number
  maxLonBin: number
  numLatBins: number
  numLonBins: number
  candCell: Int32Array
  candX: Float32Array
  candY: Float32Array
  candZ: Float32Array
  next: Int32Array
  head: Int32Array
  candidateCount: number
}

/**
 * Spatial bucket index for fast nearest-cell queries on the unit sphere.
 * Bins cell centres into 1-degree buckets over a bounding box.
 */
export function buildSpatialIndex(
  cellLats: Float32Array,
  cellLons: Float32Array,
  bounds: SpatialIndexBounds = { minLat: -2.0, maxLat: 47.0, minLon: 18.0, maxLon: 157.0 }
): SpatialIndex {
  const { minLat, maxLat, minLon, maxLon } = bounds
  const minLatBin = Math.floor(minLat)
  const maxLatBin = Math.floor(maxLat)
  const minLonBin = Math.floor(minLon)
  const maxLonBin = Math.floor(maxLon)

  const numLatBins = maxLatBin - minLatBin + 1
  const numLonBins = maxLonBin - minLonBin + 1
  const totalBins = numLatBins * numLonBins

  // First pass: count candidate cells in the bounding box
  const totalCells = cellLats.length
  let candidateCount = 0
  for (let c = 0; c < totalCells; c++) {
    const lat = cellLats[c]
    const lon = cellLons[c]
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      candidateCount++
    }
  }

  const candCell = new Int32Array(candidateCount)
  const candX = new Float32Array(candidateCount)
  const candY = new Float32Array(candidateCount)
  const candZ = new Float32Array(candidateCount)
  const next = new Int32Array(candidateCount)
  const head = new Int32Array(totalBins).fill(-1)

  let p = 0
  for (let c = 0; c < totalCells; c++) {
    const lat = cellLats[c]
    const lon = cellLons[c]
    if (lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon) {
      const bLat = Math.floor(lat) - minLatBin
      const bLon = Math.floor(lon) - minLonBin
      const binIdx = bLat * numLonBins + bLon

      const phi = lat * DEG_TO_RAD
      const theta = lon * DEG_TO_RAD
      const cosPhi = Math.cos(phi)

      candCell[p] = c
      candX[p] = cosPhi * Math.cos(theta)
      candY[p] = cosPhi * Math.sin(theta)
      candZ[p] = Math.sin(phi)

      next[p] = head[binIdx]
      head[binIdx] = p
      p++
    }
  }

  return {
    bounds,
    minLatBin,
    maxLatBin,
    minLonBin,
    maxLonBin,
    numLatBins,
    numLonBins,
    candCell,
    candX,
    candY,
    candZ,
    next,
    head,
    candidateCount,
  }
}

/**
 * Finds the nearest ICON cell for a target coordinate (lat, lon) in degrees.
 * Searches the 3x3 neighbourhood of 1-degree bins, widening if needed.
 */
export function findNearestCell(lat: number, lon: number, spatialIndex: SpatialIndex): number {
  const {
    minLatBin,
    maxLatBin,
    minLonBin,
    maxLonBin,
    numLonBins,
    candCell,
    candX,
    candY,
    candZ,
    next,
    head,
  } = spatialIndex

  const phi = lat * DEG_TO_RAD
  const theta = lon * DEG_TO_RAD
  const cosPhi = Math.cos(phi)
  const tx = cosPhi * Math.cos(theta)
  const ty = cosPhi * Math.sin(theta)
  const tz = Math.sin(phi)

  const cLat = Math.floor(lat)
  const cLon = Math.floor(lon)

  let bestCell = -1
  let minDist2 = Infinity

  // Search expanding neighbourhood: radius 1 (3x3), radius 2 if empty
  for (let rad = 1; rad <= 3; rad++) {
    const latStart = Math.max(minLatBin, cLat - rad)
    const latEnd = Math.min(maxLatBin, cLat + rad)
    const lonStart = Math.max(minLonBin, cLon - rad)
    const lonEnd = Math.min(maxLonBin, cLon + rad)

    for (let bL = latStart; bL <= latEnd; bL++) {
      const rowOffset = (bL - minLatBin) * numLonBins
      for (let bO = lonStart; bO <= lonEnd; bO++) {
        const binIdx = rowOffset + (bO - minLonBin)
        let ptr = head[binIdx]
        while (ptr !== -1) {
          const dx = tx - candX[ptr]
          const dy = ty - candY[ptr]
          const dz = tz - candZ[ptr]
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 < minDist2) {
            minDist2 = d2
            bestCell = candCell[ptr]
          }
          ptr = next[ptr]
        }
      }
    }
    if (bestCell !== -1) break
  }

  return bestCell
}

/**
 * Brute force nearest-cell search (for tests and verification).
 */
export function findNearestBruteForce(
  lat: number,
  lon: number,
  cellLats: Float32Array,
  cellLons: Float32Array,
  bounds: SpatialIndexBounds | null = null
): number {
  const phi = lat * DEG_TO_RAD
  const theta = lon * DEG_TO_RAD
  const cosPhi = Math.cos(phi)
  const tx = cosPhi * Math.cos(theta)
  const ty = cosPhi * Math.sin(theta)
  const tz = Math.sin(phi)

  let bestCell = -1
  let minDist2 = Infinity

  const total = cellLats.length
  for (let c = 0; c < total; c++) {
    const cLat = cellLats[c]
    const cLon = cellLons[c]
    if (bounds) {
      if (cLat < bounds.minLat || cLat > bounds.maxLat || cLon < bounds.minLon || cLon > bounds.maxLon) {
        continue
      }
    }
    const cPhi = cLat * DEG_TO_RAD
    const cTheta = cLon * DEG_TO_RAD
    const cosCPhi = Math.cos(cPhi)
    const cx = cosCPhi * Math.cos(cTheta)
    const cy = cosCPhi * Math.sin(cTheta)
    const cz = Math.sin(cPhi)

    const dx = tx - cx
    const dy = ty - cy
    const dz = tz - cz
    const d2 = dx * dx + dy * dy + dz * dz
    if (d2 < minDist2) {
      minDist2 = d2
      bestCell = c
    }
  }

  return bestCell
}

/**
 * Builds the nearest-cell regrid lookup for the target grid.
 * Output row order: row 0 is minLat (South) -> maxLat (North),
 * matching the GFS pack convention where j=0 has lat0 = minLat.
 */
export function buildRegridLookup(
  cellLats: Float32Array,
  cellLons: Float32Array,
  targetGrid: ForecastGrid = FORECAST_GRID
): Uint32Array {
  const bounds: SpatialIndexBounds = {
    minLat: targetGrid.minLat - 2.0,
    maxLat: targetGrid.maxLat + 2.0,
    minLon: targetGrid.minLon - 2.0,
    maxLon: targetGrid.maxLon + 2.0,
  }
  const spatialIndex = buildSpatialIndex(cellLats, cellLons, bounds)
  const total = targetGrid.nx * targetGrid.ny
  const lookup = new Uint32Array(total)

  let idx = 0
  for (let j = 0; j < targetGrid.ny; j++) {
    const lat = targetGrid.minLat + j * targetGrid.dLat
    for (let i = 0; i < targetGrid.nx; i++) {
      const lon = targetGrid.minLon + i * targetGrid.dLon
      lookup[idx++] = findNearestCell(lat, lon, spatialIndex)
    }
  }
  return lookup
}

/**
 * Encodes the lookup and metadata into binary format with an ICLK header.
 */
export function encodeLookup(lookup: Uint32Array, meta: any): Uint8Array {
  const metaJson = JSON.stringify(meta)
  const metaBytes = new TextEncoder().encode(metaJson)
  const headerLen = 4 + 2 + 2 + metaBytes.length
  const totalLen = headerLen + lookup.byteLength

  const out = new Uint8Array(totalLen)
  out[0] = 0x49 // 'I'
  out[1] = 0x43 // 'C'
  out[2] = 0x4c // 'L'
  out[3] = 0x4b // 'K'

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint16(4, LOOKUP_VERSION, true)
  view.setUint16(6, metaBytes.length, true)
  out.set(metaBytes, 8)
  out.set(new Uint8Array(lookup.buffer, lookup.byteOffset, lookup.byteLength), headerLen)

  return out
}

/**
 * Decodes the lookup binary buffer.
 */
export function decodeLookup(bytes: Uint8Array): { meta: any; lookup: Uint32Array } {
  if (bytes.length < 8) throw new Error('invalid lookup file: too short')
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])
  if (magic !== LOOKUP_MAGIC) throw new Error(`invalid lookup magic: ${magic}`)

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint16(4, true)
  if (version !== LOOKUP_VERSION) throw new Error(`unsupported lookup version: ${version}`)

  const metaLen = view.getUint16(6, true)
  if (8 + metaLen > bytes.length) throw new Error('corrupt lookup header length')

  const metaJson = new TextDecoder().decode(bytes.subarray(8, 8 + metaLen))
  const meta = JSON.parse(metaJson)
  const dataOffset = 8 + metaLen

  const lookupBytes = bytes.subarray(dataOffset)
  // Ensure alignment for Uint32Array
  const lookup = new Uint32Array(lookupBytes.buffer.slice(lookupBytes.byteOffset, lookupBytes.byteOffset + lookupBytes.byteLength))

  return { meta, lookup }
}

/**
 * Regrids a 1D unstructured ICON field to the regular target grid using the lookup.
 */
export function regridField(
  iconValues: Float32Array,
  lookup: Uint32Array,
  outArray: Float32Array | null = null
): Float32Array {
  const n = lookup.length
  const out = outArray || new Float32Array(n)
  for (let k = 0; k < n; k++) {
    out[k] = iconValues[lookup[k]]
  }
  return out
}

/** Helpers for reading GRIB2 octets */
function u16(b: Uint8Array, o: number): number { return (b[o] << 8) | b[o + 1] }
function u32(b: Uint8Array, o: number): number { return b[o] * 0x1000000 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) }
function signMag16(b: Uint8Array, o: number): number { const v = (b[o] << 8) | b[o + 1]; return v & 0x8000 ? -(v & 0x7fff) : v }
function f32(b: Uint8Array, o: number): number { const view = new DataView(b.buffer, b.byteOffset + o, 4); return view.getFloat32(0, false) }
function pad2(n: number): string { return String(n).padStart(2, '0') }

/**
 * Hours in one unit of GRIB2 table 4.4; unknown units are refused, never guessed.
 */
export function timeUnitHours(code: number): number {
  switch (code) {
    case 0: return 1 / 60 // minute
    case 1: return 1 // hour
    case 2: return 24 // day
    case 10: return 3
    case 11: return 6
    case 12: return 12
    case 13: return 1 / 3600 // second
    default: throw new Error(`unsupported forecast time unit ${code}`)
  }
}

export interface DecodedIconGrib2 {
  refTimeIso: string
  forecastTimeHours: number
  validTimeIso: string
  paramCategory: number
  paramNumber: number
  levelType: number
  levelValue: number
  npoints: number
  values: Float32Array
}

/**
 * Decodes an ICON GRIB2 message (grid template 101, data template 42 CCSDS/AEC).
 */
export function decodeIconGrib2(
  bytes: Uint8Array,
  { aecDecoder = decodeAec }: { aecDecoder?: (input: Uint8Array, options: any, sampleCount: number) => Uint32Array | Int32Array } = {}
): DecodedIconGrib2 {
  const b = bytes
  if (b.length < 16) throw new Error('file too short for GRIB2')
  if (b[0] !== 0x47 || b[1] !== 0x52 || b[2] !== 0x49 || b[3] !== 0x42) {
    throw new Error('not a GRIB2 file')
  }

  let pos = 16
  let npoints = 0
  let packing: any = null
  let paramCategory = -1
  let paramNumber = -1
  let levelType = -1
  let levelValue = 0
  let refTimeIso = ''
  let forecastTimeHours = 0
  let values: Float32Array | null = null
  let bitmap: Uint8Array | null = null

  while (pos < b.length - 4) {
    const len = u32(b, pos)
    if (len < 5 || pos + len > b.length) throw new Error(`bad section length ${len} at ${pos}`)
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
      if (tmpl !== 101 && tmpl !== 0) {
        throw new Error(`unsupported grid template ${tmpl} (expected 101 for ICON)`)
      }
      npoints = u32(b, pos + 6)
    } else if (id === 4) {
      paramCategory = b[pos + 9]
      paramNumber = b[pos + 10]
      // Octet 18 is the unit of the forecast time (GRIB2 table 4.4). DWD writes
      // minutes for some steps: reading the number as hours put step 6 at +15 days.
      forecastTimeHours = u32(b, pos + 18) * timeUnitHours(b[pos + 17])
      levelType = b[pos + 22]
      levelValue = u32(b, pos + 24) * Math.pow(10, -b[pos + 23])
    } else if (id === 5) {
      const tmpl = u16(b, pos + 9)
      if (tmpl !== 42 && tmpl !== 0) {
        throw new Error(`unsupported packing template ${tmpl} (expected 42)`)
      }
      packing = {
        template: tmpl,
        refValue: f32(b, pos + 11),
        binaryScale: signMag16(b, pos + 15),
        decimalScale: signMag16(b, pos + 17),
        bitsPerValue: b[pos + 19],
        aec: tmpl === 42 ? {
          flags: b[pos + 21],
          blockSize: b[pos + 22],
          rsi: u16(b, pos + 23),
        } : null,
      }
    } else if (id === 6) {
      const indicator = b[pos + 5]
      if (indicator === 0) {
        bitmap = b.subarray(pos + 6, pos + len)
      } else {
        bitmap = null
      }
    } else if (id === 7) {
      if (!packing) throw new Error('GRIB2 section 7 before section 5')
      const binaryFactor = Math.pow(2, packing.binaryScale)
      const decimalFactor = Math.pow(10, -packing.decimalScale)

      if (packing.bitsPerValue === 0) {
        values = new Float32Array(npoints)
        values.fill(packing.refValue * decimalFactor)
      } else if (packing.template === 42) {
        const sec7Payload = b.subarray(pos + 5, pos + len)
        const aecInts = aecDecoder(sec7Payload, {
          bitsPerSample: packing.bitsPerValue,
          blockSize: packing.aec.blockSize,
          rsi: packing.aec.rsi,
          flags: packing.aec.flags,
        }, npoints)
        values = new Float32Array(npoints)
        for (let n = 0; n < npoints; n++) {
          values[n] = (packing.refValue + aecInts[n] * binaryFactor) * decimalFactor
        }
      } else {
        throw new Error('simple packing not supported for ICON')
      }
    }
    pos += len
  }

  if (!values) throw new Error('no decoded field data in GRIB2 message')

  const refMs = Date.parse(refTimeIso)
  const validMs = refMs + forecastTimeHours * 3600_000
  const validDate = new Date(validMs)
  const validTimeIso = `${validDate.getUTCFullYear()}-${pad2(validDate.getUTCMonth() + 1)}-${pad2(
    validDate.getUTCDate(),
  )}T${pad2(validDate.getUTCHours())}:${pad2(validDate.getUTCMinutes())}:${pad2(validDate.getUTCSeconds())}Z`

  return {
    refTimeIso,
    forecastTimeHours,
    validTimeIso,
    paramCategory,
    paramNumber,
    levelType,
    levelValue,
    npoints,
    values,
  }
}
