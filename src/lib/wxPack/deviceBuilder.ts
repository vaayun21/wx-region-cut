/**
 * Pure on-device weather pack builder.
 *
 * Extracts and decodes NOAA GFS GRIB2 filter subsets and converts them into
 * compact WGR1 grids suitable for mobile device storage and in-browser / Web Worker
 * consumption without any server dependency.
 *
 * No Node.js filesystem (node:fs), path (node:path), or Buffer-only APIs are used.
 */

import { decodeGrib2, type Grib2Field } from '../windGrid/grib2.ts'
import { encodeWgr1, pickScaleOffset, decodeWgr1 } from './wgr1.ts'
import { deaccumulateGfsStep, computeThunderGrid } from './thunderRule.ts'

export const NOMADS_FILTER = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl'

/** Shown to the user; never a publication or manual name. */
export const SOURCE_LABEL = 'NOMADS GFS 0.25 GRIB filter (advisory model data)'
export const MODEL_LABEL: Record<string, string> = { gfs: 'GFS 0.25', icon: 'ICON 13 km (DWD)', ecmwf: 'ECMWF IFS 0.25' }
export const MODEL_TITLE: Record<string, string> = { gfs: 'GFS', icon: 'ICON 13 km (DWD)', ecmwf: 'ECMWF IFS 0.25' }

export interface RegionBox {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

/** Forecast box: latitude -20 (20 S) to 45 N, longitude 20 E to 155 E. user requirement 2026-10-19. */
export const FORECAST_BOX: Readonly<RegionBox> = Object.freeze({ minLat: -20, maxLat: 45, minLon: 20, maxLon: 155 })
export const DEFAULT_SUBSET: Readonly<RegionBox> = FORECAST_BOX

/**
 * Pure generator of forecast step hours: 3-hourly from 0 to 72, then 6-hourly from 78 to maxHour.
 */
export function buildForecastSteps(maxHour: number = 168): number[] {
  if (maxHour < 0) return []
  const steps: number[] = []
  const cap3 = Math.min(maxHour, 72)
  for (let h = 0; h <= cap3; h += 3) {
    steps.push(h)
  }
  for (let h = 78; h <= maxHour; h += 6) {
    steps.push(h)
  }
  return steps
}

export const buildStepList = buildForecastSteps

/** 7-day forecast step list: 41 steps (0..72 every 3 h, 78..168 every 6 h). */
export const SEVEN_DAY_MAX_HOUR = 168
export const SEVEN_DAY_STEPS: readonly number[] = Object.freeze(buildForecastSteps(SEVEN_DAY_MAX_HOUR))
export const DEFAULT_7DAY_STEPS = SEVEN_DAY_STEPS
export const GFS_DEFAULT_STEPS = SEVEN_DAY_STEPS

/** Legacy 72-hour steps (25 steps) kept for existing callers. */
export const DEFAULT_STEPS = [0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72]
export const DEFAULT_STEPS_72H = DEFAULT_STEPS

export interface WxPackSource {
  category: number
  number: number
  levelType: number
  levelValue: number
}

export interface WxPackFieldDef {
  id: string
  unit: string
  level: string
  levelLabel: string
  pack: 'int16' | 'uint8'
  planes: 1 | 2
  kind: 'wind' | 'scalar'
  sources: WxPackSource[]
}

// GRIB2 sources verified against live NOMADS filter output (probe files
// .research/wxpack1/probe/p01..p15): category/number, first surface type and
// the level value as the template stores it. Every one of these decoded with
// data representation template 5.0 (simple packing) -- no JPEG2000 or complex
// packing anywhere in the set, so nothing is excluded on packing grounds.
export const WXPACK_FIELDS: WxPackFieldDef[] = [
  // Wind: u then v in one two-plane file.
  { id: 'wind10', unit: 'm/s', level: '10 m', levelLabel: '10 m', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 103, levelValue: 10 }, { category: 2, number: 3, levelType: 103, levelValue: 10 }] },
  { id: 'wind925', unit: 'm/s', level: '925 hPa', levelLabel: '925 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 92500 }, { category: 2, number: 3, levelType: 100, levelValue: 92500 }] },
  { id: 'wind850', unit: 'm/s', level: '850 hPa', levelLabel: '850 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 85000 }, { category: 2, number: 3, levelType: 100, levelValue: 85000 }] },
  { id: 'wind700', unit: 'm/s', level: '700 hPa', levelLabel: '700 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 70000 }, { category: 2, number: 3, levelType: 100, levelValue: 70000 }] },
  { id: 'wind500', unit: 'm/s', level: '500 hPa', levelLabel: '500 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 50000 }, { category: 2, number: 3, levelType: 100, levelValue: 50000 }] },
  { id: 'wind400', unit: 'm/s', level: '400 hPa', levelLabel: '400 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 40000 }, { category: 2, number: 3, levelType: 100, levelValue: 40000 }] },
  { id: 'wind300', unit: 'm/s', level: '300 hPa', levelLabel: '300 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 30000 }, { category: 2, number: 3, levelType: 100, levelValue: 30000 }] },
  { id: 'wind250', unit: 'm/s', level: '250 hPa', levelLabel: '250 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 25000 }, { category: 2, number: 3, levelType: 100, levelValue: 25000 }] },
  { id: 'wind200', unit: 'm/s', level: '200 hPa', levelLabel: '200 hPa', pack: 'int16', planes: 2, kind: 'wind',
    sources: [{ category: 2, number: 2, levelType: 100, levelValue: 20000 }, { category: 2, number: 3, levelType: 100, levelValue: 20000 }] },
  // Scalars.
  { id: 'gust', unit: 'm/s', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 2, number: 22, levelType: 1, levelValue: 0 }] },
  { id: 'temp2', unit: 'K', level: '2 m', levelLabel: '2 m', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 103, levelValue: 2 }] },
  { id: 'temp925', unit: 'K', level: '925 hPa', levelLabel: '925 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 92500 }] },
  { id: 'temp850', unit: 'K', level: '850 hPa', levelLabel: '850 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 85000 }] },
  { id: 'temp700', unit: 'K', level: '700 hPa', levelLabel: '700 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 70000 }] },
  { id: 'temp500', unit: 'K', level: '500 hPa', levelLabel: '500 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 50000 }] },
  { id: 'temp400', unit: 'K', level: '400 hPa', levelLabel: '400 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 40000 }] },
  { id: 'temp300', unit: 'K', level: '300 hPa', levelLabel: '300 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 30000 }] },
  { id: 'temp250', unit: 'K', level: '250 hPa', levelLabel: '250 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 25000 }] },
  { id: 'temp200', unit: 'K', level: '200 hPa', levelLabel: '200 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 0, levelType: 100, levelValue: 20000 }] },
  { id: 'rh2', unit: '%', level: '2 m', levelLabel: '2 m', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 1, levelType: 103, levelValue: 2 }] },
  { id: 'rh850', unit: '%', level: '850 hPa', levelLabel: '850 hPa', pack: 'uint8', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 1, levelType: 100, levelValue: 85000 }] },
  { id: 'rh700', unit: '%', level: '700 hPa', levelLabel: '700 hPa', pack: 'uint8', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 1, levelType: 100, levelValue: 70000 }] },
  { id: 'mslp', unit: 'Pa', level: 'msl', levelLabel: 'mean sea level', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 1, levelType: 101, levelValue: 0 }] },
  { id: 'cloud', unit: '%', level: 'entire atmosphere', levelLabel: 'entire atmosphere', pack: 'uint8', planes: 1, kind: 'scalar',
    sources: [{ category: 6, number: 1, levelType: 10, levelValue: 0 }] },
  // Precipitation rate: APCP (1/8, product template 4.8) is deliberately not
  // used -- see the report. PRATE (1/7, template 4.0) is present at every step.
  { id: 'precip', unit: 'kg/m^2/s', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 7, levelType: 1, levelValue: 0 }] },
  { id: 'cape', unit: 'J/kg', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 7, number: 6, levelType: 1, levelValue: 0 }] },
  { id: 'vis', unit: 'm', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 19, number: 0, levelType: 1, levelValue: 0 }] },
  // Geopotential height: what turns "925 hPa" into an honest feet figure.
  { id: 'hgt925', unit: 'm', level: '925 hPa', levelLabel: '925 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 92500 }] },
  { id: 'hgt850', unit: 'm', level: '850 hPa', levelLabel: '850 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 85000 }] },
  { id: 'hgt700', unit: 'm', level: '700 hPa', levelLabel: '700 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 70000 }] },
  { id: 'hgt500', unit: 'm', level: '500 hPa', levelLabel: '500 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 50000 }] },
  { id: 'hgt400', unit: 'm', level: '400 hPa', levelLabel: '400 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 40000 }] },
  { id: 'hgt300', unit: 'm', level: '300 hPa', levelLabel: '300 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 30000 }] },
  { id: 'hgt250', unit: 'm', level: '250 hPa', levelLabel: '250 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 25000 }] },
  { id: 'hgt200', unit: 'm', level: '200 hPa', levelLabel: '200 hPa', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 100, levelValue: 20000 }] },
  // Freezing level: geopotential metres of the 0°C isotherm.
  { id: 'freezelvl', unit: 'm', level: '0C isotherm', levelLabel: '0°C isotherm', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 4, levelValue: 0 }] },
  // Cloud ceiling: height above ground of cloud ceiling, in metres (TASK AGY-ALT1).
  { id: 'ceiling', unit: 'm', level: 'cloud ceiling', levelLabel: 'cloud ceiling', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 3, number: 5, levelType: 215, levelValue: 0 }] },
  // 3-hour / 6-hour rain accumulation and convective rain (TASK RAIN3H)
  { id: 'rain3', unit: 'mm', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 8, levelType: 1, levelValue: 0 }] },
  { id: 'conv3', unit: 'mm', level: 'sfc', levelLabel: 'surface', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 1, number: 10, levelType: 1, levelValue: 0 }] },
  { id: 'thundr', unit: 'class', level: 'sfc', levelLabel: 'surface', pack: 'uint8', planes: 1, kind: 'scalar',
    sources: [] },
  // Dew point temperature at 2 m (TASK DEW1)
  { id: 'dewpt', unit: 'K', level: '2 m', levelLabel: '2 m', pack: 'int16', planes: 1, kind: 'scalar',
    sources: [{ category: 0, number: 6, levelType: 103, levelValue: 2 }] },
]

const FIELD_BY_ID = new Map<string, WxPackFieldDef>(WXPACK_FIELDS.map((f) => [f.id, f]))

export function packFieldById(id: string): WxPackFieldDef {
  const f = FIELD_BY_ID.get(id)
  if (!f) throw new Error(`unknown pack field ${id}`)
  return f
}

function sourceKey(s: { category: number; number: number; levelType: number; levelValue: number }): string {
  return `${s.category}/${s.number}/${s.levelType}/${s.levelValue}`
}

const SOURCE_TO_FIELD = new Map<string, { field: WxPackFieldDef; source: WxPackSource }>()
for (const f of WXPACK_FIELDS) {
  for (const s of f.sources) SOURCE_TO_FIELD.set(sourceKey(s), { field: f, source: s })
}

// ---- GRIB2 -> WGR1 -------------------------------------------------------

/** Split a byte stream into complete GRIB2 messages (and ignore stray bytes). */
function splitMessages(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let off = 0
  while (off + 16 <= bytes.length) {
    if (!(bytes[off] === 0x47 && bytes[off + 1] === 0x52 && bytes[off + 2] === 0x49 && bytes[off + 3] === 0x42)) {
      off += 1
      continue
    }
    const hi = bytes[off + 8] * 0x1000000 + ((bytes[off + 9] << 16) | (bytes[off + 10] << 8) | bytes[off + 11])
    const lo = bytes[off + 12] * 0x1000000 + ((bytes[off + 13] << 16) | (bytes[off + 14] << 8) | bytes[off + 15])
    const total = hi * 0x100000000 + lo
    if (total <= 0 || off + total > bytes.length) break
    out.push(bytes.subarray(off, off + total))
    off += total
  }
  return out
}

/** Product identity of a message without decoding its packing (for skip reasons). */
function peekProduct(msg: Uint8Array): { productTemplate: number; category: number; number: number; levelType: number; levelValue: number } | null {
  let pos = 16
  const end = msg.length - 4
  while (pos < end) {
    const len = msg[pos] * 0x1000000 + ((msg[pos + 1] << 16) | (msg[pos + 2] << 8) | msg[pos + 3])
    if (len < 5 || pos + len > msg.length) break
    const id = msg[pos + 4]
    if (id === 4) {
      return {
        productTemplate: (msg[pos + 7] << 8) | msg[pos + 8],
        category: msg[pos + 9],
        number: msg[pos + 10],
        levelType: msg[pos + 22],
        levelValue: msg[pos + 24] * 0x1000000 + ((msg[pos + 25] << 16) | (msg[pos + 26] << 8) | msg[pos + 27]),
      }
    }
    pos += len
  }
  return null
}

function fieldIdOf(peek: ReturnType<typeof peekProduct>): string | undefined {
  if (!peek) return undefined
  const hit = SOURCE_TO_FIELD.get(sourceKey(peek))
  return hit ? hit.field.id : undefined
}

export interface WxPackConvertedFile {
  fieldId: string
  stepHours: number
  unit: string
  levelLabel: string
  wgr1: Uint8Array
  bytes: number
  min: number
  max: number
  metaCheck: { decodedMin: number; metaMin: number; ok: boolean }
  rainWindowH?: number
}

export interface WxPackSkip {
  fieldId?: string
  reason: string
}

interface PendingEntry {
  def: WxPackFieldDef
  parts: Map<string, { values: Float32Array; metaMin: number; productTemplate?: number }>
}

export interface Grib2ToWgr1Options {
  modelId?: string
  cycleUtc?: string
  prevRain3?: Float32Array | number[] | null
  prevConv3?: Float32Array | number[] | null
}

/**
 * Convert every recognised message of one GRIB2 download into WGR1 files.
 * Returns { ok, skipped } -- `skipped` always carries a reason, so an excluded
 * message is visible rather than silently dropped.
 */
export function grib2ToWgr1Files(
  bytes: Uint8Array,
  {
    modelId = 'gfs',
    cycleUtc,
    prevRain3,
    prevConv3,
  }: Grib2ToWgr1Options = {},
): { ok: WxPackConvertedFile[]; skipped: WxPackSkip[] } {
  const ok: WxPackConvertedFile[] = []
  const skipped: WxPackSkip[] = []
  if (!bytes || bytes.length === 0) {
    skipped.push({ reason: 'truncated data: empty download' })
    return { ok, skipped }
  }
  /** fieldId|step -> { def, parts: Map<sourceKey, {values, metaMin, productTemplate}> } */
  const pending = new Map<string, PendingEntry>()
  const gridOf = new Map<string, Grib2Field>()

  for (const msg of splitMessages(bytes)) {
    let decoded
    const peek = peekProduct(msg)
    try {
      decoded = decodeGrib2(msg)
    } catch (e: any) {
      skipped.push({ fieldId: fieldIdOf(peek), reason: String((e && e.message) || e) })
      continue
    }
    const productTemplate = peek ? peek.productTemplate : undefined
    for (const gfield of decoded.fields) {
      const key = sourceKey({ category: gfield.paramCategory, number: gfield.paramNumber, levelType: gfield.levelType, levelValue: gfield.levelValue })
      const hit = SOURCE_TO_FIELD.get(key)
      if (!hit) {
        skipped.push({
          fieldId: undefined,
          reason: `no pack field for ${gfield.paramCategory}/${gfield.paramNumber} levelType ${gfield.levelType} level ${gfield.levelValue}`,
        })
        continue
      }
      const step = gfield.forecastTimeHours
      const slot = `${hit.field.id}|${step}`
      if (!pending.has(slot)) pending.set(slot, { def: hit.field, parts: new Map() })
      const entry = pending.get(slot)!
      if (entry.parts.has(key)) {
        const existing = entry.parts.get(key)!
        // Deterministic preference: instantaneous (product template 4.0) over interval/stat (4.8 or other)
        if (existing.productTemplate !== 0 && productTemplate === 0) {
          skipped.push({
            fieldId: hit.field.id,
            reason: `duplicate message for ${key} at step ${step}: replaced template 4.${existing.productTemplate ?? 'x'} with instantaneous 4.0`,
          })
          entry.parts.set(key, {
            values: gfield.values,
            metaMin: gfield.packing.refValue * Math.pow(10, -gfield.packing.decimalScale),
            productTemplate,
          })
          gridOf.set(slot, gfield)
          continue
        }
        skipped.push({ fieldId: hit.field.id, reason: `duplicate message for ${key} at step ${step}` })
        continue
      }
      entry.parts.set(key, {
        values: gfield.values,
        metaMin: gfield.packing.refValue * Math.pow(10, -gfield.packing.decimalScale),
        productTemplate,
      })
      gridOf.set(slot, gfield)
    }
  }

  // Garbage with no GRIB2 message at all still says why: truncated data.
  if (pending.size === 0 && skipped.length === 0) {
    skipped.push({ reason: 'truncated data: no GRIB2 messages' })
  }

  for (const [slot, entry] of pending) {
    const { def } = entry
    const step = Number(slot.split('|')[1])
    const needed = def.sources.map(sourceKey)
    const missing = needed.filter((k) => !entry.parts.has(k))
    if (missing.length > 0) {
      skipped.push({ fieldId: def.id, reason: `unpaired wind component: missing ${missing.join(', ')} at step ${step}` })
      continue
    }
    const g = gridOf.get(slot)!
    const planes = needed.map((k) => entry.parts.get(k)!.values)

    let rainWindowH: number | undefined = undefined
    if (def.id === 'rain3') {
      const deaccum = deaccumulateGfsStep({
        stepHours: step,
        currentAccum: planes[0],
        prevStepAmount: prevRain3,
      })
      planes[0] = deaccum.values
      rainWindowH = deaccum.rainWindowH
    } else if (def.id === 'conv3') {
      const deaccum = deaccumulateGfsStep({
        stepHours: step,
        currentAccum: planes[0],
        prevStepAmount: prevConv3,
      })
      planes[0] = deaccum.values
      rainWindowH = deaccum.rainWindowH
    }

    if (def.id === 'ceiling') {
      for (const p of planes) {
        for (let i = 0; i < p.length; i++) {
          if (p[i] >= 1e9) p[i] = NaN
        }
      }
    }

    // Loop, never spread: huge grids overflow the call stack, and NaN
    // corners must not poison the range. No finite value means corrupt data.
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const p of planes) {
      for (let i = 0; i < p.length; i++) {
        const v = p[i]
        if (!Number.isFinite(v)) continue
        if (v < min) min = v
        if (v > max) max = v
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      if (def.id === 'ceiling') {
        min = 0
        max = 0
      } else {
        skipped.push({ fieldId: def.id, reason: `no finite values for ${def.id} at step ${step}` })
        continue
      }
    }
    const picked = def.pack === 'uint8' ? { scale: 1, offset: 0 } : pickScaleOffset(min, max)
    let metaMin = Number.POSITIVE_INFINITY
    for (const k of needed) {
      const v = entry.parts.get(k)!.metaMin
      if (Number.isFinite(v) && v < metaMin) metaMin = v
    }
    if (!Number.isFinite(metaMin)) metaMin = min
    const meta = {
      model: MODEL_LABEL[modelId] ?? modelId,
      fieldId: def.id,
      level: def.level,
      unit: def.unit,
      referenceTimeIso: g.referenceTimeIso,
      validTimeIso: g.validTimeIso,
      source: SOURCE_LABEL,
      nx: g.ni,
      ny: g.nj,
      lat0: g.la1,
      dLat: (g.la2 - g.la1) / (g.nj - 1),
      lon0: g.lo1,
      dLon: (g.lo2 - g.lo1) / (g.ni - 1),
      planes: def.planes,
      pack: def.pack,
      scale: picked.scale,
      offset: picked.offset,
      min,
      max,
      ...(rainWindowH != null ? { rainWindowH } : {}),
    }
    const wgr1 = encodeWgr1(meta, planes)
    ok.push({
      fieldId: def.id,
      stepHours: step,
      unit: def.unit,
      levelLabel: def.levelLabel,
      wgr1,
      bytes: wgr1.length,
      min,
      max,
      metaCheck: {
        decodedMin: min,
        metaMin,
        ok: Math.abs(min - metaMin) <= 1e-3 * Math.max(1, Math.abs(metaMin)),
      },
      ...(rainWindowH != null ? { rainWindowH } : {}),
    })
  }

  // Generate thunder risk diagnostic for GFS if both conv3 and cape are present
  const conv3File = ok.find((f) => f.fieldId === 'conv3')
  const capeFile = ok.find((f) => f.fieldId === 'cape')
  if (conv3File && capeFile) {
    const step = conv3File.stepHours
    const slot = `conv3|${step}`
    const g = gridOf.get(slot) || gridOf.get(`cape|${step}`)
    if (g) {
      const convPlanes = decodeWgr1(conv3File.wgr1).planes[0]
      const capePlanes = decodeWgr1(capeFile.wgr1).planes[0]
      const thundrGrid = computeThunderGrid({
        model: modelId,
        conv3Mm: convPlanes,
        capeJkg: capePlanes,
        length: g.ni * g.nj,
      })
      let thundrMax = 0
      for (let i = 0; i < thundrGrid.length; i++) {
        if (thundrGrid[i] > thundrMax) thundrMax = thundrGrid[i]
      }
      const thundrMeta = {
        model: MODEL_LABEL[modelId] ?? modelId,
        fieldId: 'thundr',
        level: 'sfc',
        unit: 'class',
        referenceTimeIso: g.referenceTimeIso,
        validTimeIso: g.validTimeIso,
        source: SOURCE_LABEL,
        nx: g.ni,
        ny: g.nj,
        lat0: g.la1,
        dLat: (g.la2 - g.la1) / (g.nj - 1),
        lon0: g.lo1,
        dLon: (g.lo2 - g.lo1) / (g.ni - 1),
        planes: 1,
        pack: 'uint8' as const,
        scale: 1,
        offset: 0,
        min: 0,
        max: thundrMax,
      }
      const thundrWgr1 = encodeWgr1(thundrMeta, [new Float32Array(thundrGrid)])
      ok.push({
        fieldId: 'thundr',
        stepHours: step,
        unit: 'class',
        levelLabel: 'surface',
        wgr1: thundrWgr1,
        bytes: thundrWgr1.length,
        min: 0,
        max: thundrMax,
        metaCheck: { decodedMin: 0, metaMin: 0, ok: true },
      })
    }
  }
  ok.sort((a, b) => (a.fieldId === b.fieldId ? a.stepHours - b.stepHours : a.fieldId < b.fieldId ? -1 : 1))
  return { ok, skipped }
}

// ---- Manifest ------------------------------------------------------------

/** 2026-10-02T06:00:00Z -> 20261002T06Z (the on-disk cycle directory). */
export function cycleDirName(cycleUtc: string): string {
  return `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}T${cycleUtc.slice(11, 13)}Z`
}

export interface WxPackFileEntry {
  step: number
  url: string
  bytes: number
  validAtMs: number
  rainWindowH?: number
}

export interface WxPackFieldEntry {
  unit: string
  levelLabel: string
  min: number
  max: number
  files: WxPackFileEntry[]
}

export interface WxPackGridMeta {
  nx: number
  ny: number
  dx: number
  dy: number
}

export interface WxPackIndex {
  model: string
  modelId: string
  cycleUtc: string
  generatedAtMs: number
  bbox: RegionBox
  grid: WxPackGridMeta
  steps: number[]
  fields: Record<string, WxPackFieldEntry>
}

/**
 * The index.json of one cycle. `fields` is the list of converted files from
 * grib2ToWgr1Files (one entry per field and step).
 */
export function buildPackIndex({
  modelId,
  cycleUtc,
  generatedAtMs,
  bbox,
  grid,
  steps,
  fields,
  modelTitle,
}: {
  modelId: string
  cycleUtc: string
  generatedAtMs: number
  bbox: RegionBox
  grid: WxPackGridMeta
  steps: number[]
  fields: WxPackConvertedFile[]
  modelTitle?: string
}): WxPackIndex {
  const byField = new Map<string, WxPackConvertedFile[]>()
  for (const f of fields) {
    if (!byField.has(f.fieldId)) byField.set(f.fieldId, [])
    byField.get(f.fieldId)!.push(f)
  }
  const out: Record<string, WxPackFieldEntry> = {}
  for (const [fieldId, list] of byField) {
    list.sort((a, b) => a.stepHours - b.stepHours)
    const def = packFieldById(fieldId)
    // Loops, never spread: long step lists overflow the call stack.
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (const f of list) {
      if (Number.isFinite(f.min) && f.min < lo) lo = f.min
      if (Number.isFinite(f.max) && f.max > hi) hi = f.max
    }
    out[fieldId] = {
      unit: def.unit,
      levelLabel: def.levelLabel,
      min: lo,
      max: hi,
      files: list.map((f) => ({
        step: f.stepHours,
        url: `/api/wx/pack/${modelId}/${cycleDirName(cycleUtc)}/${fieldId}/${f.stepHours}.wgr1`,
        bytes: f.bytes ?? (f.wgr1 ? f.wgr1.length : 0),
        validAtMs: Date.parse(cycleUtc) + f.stepHours * 3_600_000,
        ...(f.rainWindowH != null
          ? { rainWindowH: f.rainWindowH }
          : fieldId === 'rain3' || fieldId === 'conv3'
            ? { rainWindowH: f.stepHours > 72 ? 6 : 3 }
            : {}),
      })),
    }
  }
  return {
    model: modelTitle ?? MODEL_TITLE[modelId] ?? String(modelId).toUpperCase(),
    modelId,
    cycleUtc,
    generatedAtMs,
    bbox,
    grid,
    steps: [...steps],
    fields: out,
  }
}

// ---- NOMADS download -----------------------------------------------------

/** The GFS 0.25 filter URL for one subsetted forecast step. */
export function buildFilterUrl({
  cycleUtc,
  stepHours,
  subset = DEFAULT_SUBSET,
}: {
  cycleUtc: string
  stepHours: number
  subset?: RegionBox
}): string {
  const y = cycleUtc.slice(0, 4)
  const mo = cycleUtc.slice(5, 7)
  const d = cycleUtc.slice(8, 10)
  const h = cycleUtc.slice(11, 13)
  const file = `gfs.t${h}z.pgrb2.0p25.f${String(stepHours).padStart(3, '0')}`
  const params = new URLSearchParams()
  params.set('file', file)
  params.set('lev_0C_isotherm', 'on')
  params.set('lev_cloud_ceiling', 'on')
  params.set('lev_10_m_above_ground', 'on')
  params.set('lev_2_m_above_ground', 'on')
  params.set('lev_925_mb', 'on')
  params.set('lev_850_mb', 'on')
  params.set('lev_700_mb', 'on')
  params.set('lev_500_mb', 'on')
  params.set('lev_400_mb', 'on')
  params.set('lev_300_mb', 'on')
  params.set('lev_250_mb', 'on')
  params.set('lev_200_mb', 'on')
  params.set('lev_mean_sea_level', 'on')
  params.set('lev_entire_atmosphere', 'on')
  params.set('lev_surface', 'on')
  params.set('var_ACPCP', 'on')
  params.set('var_APCP', 'on')
  params.set('var_CAPE', 'on')
  params.set('var_DPT', 'on')
  params.set('var_GUST', 'on')
  params.set('var_HGT', 'on')
  params.set('var_PRATE', 'on')
  params.set('var_PRMSL', 'on')
  params.set('var_RH', 'on')
  params.set('var_TCDC', 'on')
  params.set('var_TMP', 'on')
  params.set('var_UGRD', 'on')
  params.set('var_VIS', 'on')
  params.set('var_VGRD', 'on')
  params.set('subregion', '')
  params.set('leftlon', String(subset.minLon))
  params.set('rightlon', String(subset.maxLon))
  params.set('toplat', String(subset.maxLat))
  params.set('bottomlat', String(subset.minLat))
  params.set('dir', `/gfs.${y}${mo}${d}/${h}/atmos`)
  return `${NOMADS_FILTER}?${params.toString()}`
}

/** The cycles (00/06/12/18 UTC) that should be downloadable at `nowMs`. */
export function candidateCycles(nowMs: number, count = 3): string[] {
  // No usable time means no cycles, never "NaN-NaN-NaN".
  if (!Number.isFinite(nowMs)) return []
  const out: string[] = []
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const day = d.getUTCDate()
  const hour = d.getUTCHours()
  const latest = Math.floor(hour / 6) * 6
  for (let i = 0; i < count; i++) {
    const t = Date.UTC(y, mo, day, latest) - i * 6 * 3_600_000
    const c = new Date(t)
    out.push(
      `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}T${String(c.getUTCHours()).padStart(2, '0')}:00:00Z`,
    )
  }
  return out
}

// ---- On-device download planner & size estimation ------------------------

export const GLOBAL_LIMITS: Readonly<RegionBox> = Object.freeze({
  minLat: -90,
  maxLat: 90,
  minLon: -180,
  maxLon: 180,
})

/**
 * Build a lat/lon region box around a given centre coordinate, clamped to global limits
 * and snapped to the 0.25 degree grid.
 */
export function boxAround(
  lat: number,
  lon: number,
  degrees = 15,
  limits: RegionBox = GLOBAL_LIMITS,
): RegionBox {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error('boxAround requires finite lat and lon')
  }
  const half = degrees / 2
  const snap = (v: number) => Math.round(v * 4) / 4

  const rawMinLat = snap(lat - half)
  const rawMaxLat = snap(lat + half)
  const rawMinLon = snap(lon - half)
  const rawMaxLon = snap(lon + half)

  const minLat = Math.max(limits.minLat, Math.min(limits.maxLat, rawMinLat))
  const maxLat = Math.max(limits.minLat, Math.min(limits.maxLat, rawMaxLat))
  const minLon = Math.max(limits.minLon, Math.min(limits.maxLon, rawMinLon))
  const maxLon = Math.max(limits.minLon, Math.min(limits.maxLon, rawMaxLon))

  return { minLat, maxLat, minLon, maxLon }
}

export interface DeviceDownloadPlanItem {
  url: string
  step: number
}

export interface PlanDeviceDownloadArgs {
  box?: RegionBox
  lat?: number
  lon?: number
  degrees?: number
  stepHours?: number[] | readonly number[]
  fieldIds?: string[]
  cycleUtc: string
}

/**
 * Plan the download steps and URLs for on-device weather pack creation.
 * Returns the list of { url, step } the device must fetch for a CHOSEN region box.
 */
export function planDeviceDownload({
  box,
  lat,
  lon,
  degrees = 15,
  stepHours = SEVEN_DAY_STEPS,
  fieldIds,
  cycleUtc,
}: PlanDeviceDownloadArgs): DeviceDownloadPlanItem[] {
  if (!cycleUtc) throw new Error('planDeviceDownload requires cycleUtc')

  const chosenBox: RegionBox =
    box ??
    (lat !== undefined && lon !== undefined
      ? boxAround(lat, lon, degrees)
      : FORECAST_BOX)

  const steps = stepHours ?? SEVEN_DAY_STEPS
  return steps.map((step) => ({
    url: buildFilterUrl({ cycleUtc, stepHours: step, subset: chosenBox }),
    step,
  }))
}

/** Reference box from repository measured data: 135 x 45 degrees (lat 0-45, lon 20-155). */
const REF_BOX_WIDTH = 135
const REF_BOX_HEIGHT = 45
const REF_BOX_AREA = REF_BOX_WIDTH * REF_BOX_HEIGHT // 6075 deg^2
/** Measured GFS filter download bytes for a single field over the 135x45 degree box. */
const REF_BYTES_PER_FIELD = 184_000

/**
 * Estimate the total download bytes for an on-device weather pack download.
 *
 * Note: this is an estimate based on measured NOAA GFS filter output (184,000 bytes per
 * field for the 135x45° box). Actual GRIB2 download size varies with atmospheric complexity
 * due to simple packing representation.
 */
export function estimateDownloadBytes(
  box: RegionBox,
  steps: number | number[] = 1,
  fieldCount: number = WXPACK_FIELDS.length,
): number {
  const latSpan = Math.abs(box.maxLat - box.minLat)
  const lonSpan = Math.abs(box.maxLon - box.minLon)
  const area = latSpan * lonSpan
  const stepCount = Array.isArray(steps) ? steps.length : (typeof steps === 'number' ? steps : 1)
  const fields = typeof fieldCount === 'number' ? fieldCount : WXPACK_FIELDS.length

  const bytesPerField = (area / REF_BOX_AREA) * REF_BYTES_PER_FIELD
  return Math.round(bytesPerField * stepCount * fields)
}
