/**
 * Pure conversion, URL building, and packing functions for DWD ICON 13 km model.
 *
 * SAFETY CRITICAL: Physical values and geographic bounds are preserved.
 * No Node-only imports (fs, path, Buffer).
 */

import { bunzip2 } from './bzip2.ts'
import { decodeIconGrib2, regridField, type ForecastGrid } from './iconRegrid.ts'
import { encodeWgr1, pickScaleOffset } from './wgr1.ts'
import { buildForecastSteps } from './deviceBuilder.ts'
import { deaccumulateIconStep, computeThunderGrid } from './thunderRule.ts'
import {
  buildIconUrls,
  formatIconRunIso,
  formatIconStep,
  isBzip2,
  type IconUrls,
  type BuildIconUrlsOptions,
} from './iconUrls.ts'

export {
  buildIconUrls,
  formatIconRunIso,
  formatIconStep,
  isBzip2,
  type IconUrls,
  type BuildIconUrlsOptions,
}

/** Forecast box: latitude -20 (20 S) to 45 N, longitude 20 E to 155 E. user requirement 2026-10-19. */
export const FORECAST_BOX = Object.freeze({ minLat: -20, maxLat: 45, minLon: 20, maxLon: 155 })

export const FORECAST_GRID: Readonly<ForecastGrid> = Object.freeze({
  minLat: FORECAST_BOX.minLat,
  maxLat: FORECAST_BOX.maxLat,
  minLon: FORECAST_BOX.minLon,
  maxLon: FORECAST_BOX.maxLon,
  dLat: 0.125,
  dLon: 0.125,
  nx: Math.round((FORECAST_BOX.maxLon - FORECAST_BOX.minLon) / 0.125) + 1, // 1081
  ny: Math.round((FORECAST_BOX.maxLat - FORECAST_BOX.minLat) / 0.125) + 1, // 521
})

export const SOURCE_LABEL = 'DWD ICON global single-level (advisory model data)'
export const MODEL_LABEL = 'ICON 13 km (DWD)'
export const MODEL_ID = 'icon'

export const ICON_MAX_AVAILABLE_STEP = 180
export const ICON_MAX_STEP = 168
export const ICON_DEFAULT_STEPS = Object.freeze(buildForecastSteps(ICON_MAX_STEP))

export const KEEP_CYCLES = 2

export interface IconVarDef {
  dir: string
  fileSuffix: string
}

export interface IconPackFieldDef {
  id: string
  unit: string
  level: string
  levelLabel: string
  pack: 'int16' | 'uint8'
  planes: number
  kind: 'wind' | 'scalar'
  minStep?: number
  vars: IconVarDef[]
}

export const ICON_PACK_FIELDS: readonly IconPackFieldDef[] = Object.freeze([
  {
    id: 'wind10',
    unit: 'm/s',
    level: '10 m',
    levelLabel: '10 m',
    pack: 'int16',
    planes: 2,
    kind: 'wind',
    vars: [
      { dir: 'u_10m', fileSuffix: 'U_10M' },
      { dir: 'v_10m', fileSuffix: 'V_10M' },
    ],
  },
  {
    id: 'temp2',
    unit: 'K',
    level: '2 m',
    levelLabel: '2 m',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 't_2m', fileSuffix: 'T_2M' }],
  },
  {
    id: 'dewpt',
    unit: 'K',
    level: '2 m',
    levelLabel: '2 m',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'td_2m', fileSuffix: 'TD_2M' }],
  },
  {
    id: 'mslp',
    unit: 'Pa',
    level: 'msl',
    levelLabel: 'mean sea level',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'pmsl', fileSuffix: 'PMSL' }],
  },
  {
    id: 'cloud',
    unit: '%',
    level: 'entire atmosphere',
    levelLabel: 'entire atmosphere',
    pack: 'uint8',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'clct', fileSuffix: 'CLCT' }],
  },
  {
    id: 'gust',
    unit: 'm/s',
    level: 'sfc',
    levelLabel: 'surface',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    minStep: 3,
    vars: [{ dir: 'vmax_10m', fileSuffix: 'VMAX_10M' }],
  },
  {
    id: 'cape',
    unit: 'J/kg',
    level: 'sfc',
    levelLabel: 'surface',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'cape_ml', fileSuffix: 'CAPE_ML' }],
  },
  {
    id: 'rain3',
    unit: 'mm',
    level: 'sfc',
    levelLabel: 'surface',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'tot_prec', fileSuffix: 'TOT_PREC' }],
  },
  {
    id: 'conv3',
    unit: 'mm',
    level: 'sfc',
    levelLabel: 'surface',
    pack: 'int16',
    planes: 1,
    kind: 'scalar',
    vars: [
      { dir: 'rain_con', fileSuffix: 'RAIN_CON' },
      { dir: 'snow_con', fileSuffix: 'SNOW_CON' },
    ],
  },
  {
    id: 'thundr',
    unit: 'class',
    level: 'sfc',
    levelLabel: 'surface',
    pack: 'uint8',
    planes: 1,
    kind: 'scalar',
    vars: [{ dir: 'ww', fileSuffix: 'WW' }],
  },
])

/**
 * The valid time a pack file is published with: always the cycle plus the step.
 * A time decoded from the GRIB header is only a cross-check: when it differs
 * by more than an hour the header is wrong (ICON once carried dates weeks
 * ahead), the cycle plus step wins and the caller logs the mismatch.
 */
export function pickValidTimeIso(
  cycleUtc: string,
  stepHours: number,
  decodedIso?: string
): { validTimeIso: string; mismatch: boolean; decodedIso?: string } {
  const expectedMs = Date.parse(cycleUtc) + stepHours * 3_600_000
  const expectedIso = new Date(expectedMs).toISOString()
  const decodedMs = decodedIso ? Date.parse(decodedIso) : NaN
  if (!Number.isFinite(decodedMs)) return { validTimeIso: expectedIso, mismatch: false }
  const mismatch = Math.abs(decodedMs - expectedMs) > 3_600_000
  return { validTimeIso: expectedIso, mismatch, decodedIso: mismatch ? decodedIso : undefined }
}

/** 2026-10-05T00:00:00Z -> 20261005T00Z */
export function cycleDirName(cycleUtc: string): string {
  return `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}T${cycleUtc.slice(11, 13)}Z`
}

/** 2026-10-05T00:00:00Z -> 2026100500 */
export function dwdCycleTag(cycleUtc: string): string {
  return `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}${cycleUtc.slice(11, 13)}`
}

/**
 * Builds DWD OpenData download URL for one forecast field file (legacy URL pattern).
 */
export function buildIconUrl({
  cycleUtc,
  varDir,
  varName,
  stepHours,
}: {
  cycleUtc: string
  varDir: string
  varName: string
  stepHours: number
}): string {
  return buildIconUrls({ cycleUtc, varDir, varName, stepHours }).oldUrl
}

/**
 * Candidate 00z and 12z cycles for ICON.
 */
export function candidateIconCycles(nowMs: number = Date.now(), count: number = 3): string[] {
  const out: string[] = []
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const mo = d.getUTCMonth()
  const day = d.getUTCDate()
  const hour = d.getUTCHours()
  const latest12 = hour >= 12 ? 12 : 0

  for (let i = 0; i < count; i++) {
    const t = Date.UTC(y, mo, day, latest12) - i * 12 * 3_600_000
    const c = new Date(t)
    out.push(
      `${c.getUTCFullYear()}-${String(c.getUTCMonth() + 1).padStart(2, '0')}-${String(c.getUTCDate()).padStart(2, '0')}T${String(c.getUTCHours()).padStart(2, '0')}:00:00Z`,
    )
  }
  return out
}

export interface ConvertIconFieldBuffersOptions {
  fieldDef: IconPackFieldDef
  stepHours: number
  cycleUtc: string
  /** One compressed buffer per var in fieldDef.vars */
  rawBz2Buffers: Uint8Array[]
  lookup: Uint32Array
  lastTotPrec?: Float32Array | null
  lastConv?: Float32Array | null
  targetGrid?: ForecastGrid
  modelLabel?: string
}

export interface ConvertIconFieldResult {
  fieldId: string
  stepHours: number
  unit: string
  levelLabel: string
  wgr1: Uint8Array
  bytes: number
  min: number
  max: number
  rainWindowH?: number
  lastTotPrec?: Float32Array
  lastConv?: Float32Array
}

/**
 * Pure function to decompress, decode, regrid, and encode WGR1 for one ICON field at a step.
 */
export function convertIconFieldBuffers({
  fieldDef,
  stepHours,
  cycleUtc,
  rawBz2Buffers,
  lookup,
  lastTotPrec = null,
  lastConv = null,
  targetGrid = FORECAST_GRID,
  modelLabel = MODEL_LABEL,
}: ConvertIconFieldBuffersOptions): ConvertIconFieldResult {
  if (rawBz2Buffers.length !== fieldDef.vars.length) {
    throw new Error(`expected ${fieldDef.vars.length} buffers for ${fieldDef.id}, got ${rawBz2Buffers.length}`)
  }

  let planes: Float32Array[] = []
  let refTimeIso = cycleUtc
  let validTimeIso = new Date(Date.parse(cycleUtc) + stepHours * 3_600_000).toISOString()

  for (let vIdx = 0; vIdx < fieldDef.vars.length; vIdx++) {
    const rawBz2 = rawBz2Buffers[vIdx]
    const decompressed = isBzip2(rawBz2) ? bunzip2(rawBz2) : rawBz2
    const decodedMsg = decodeIconGrib2(decompressed)
    refTimeIso = decodedMsg.refTimeIso || refTimeIso
    const picked0 = pickValidTimeIso(cycleUtc, stepHours, decodedMsg.validTimeIso)
    validTimeIso = picked0.validTimeIso

    const regriddedPlane = regridField(decodedMsg.values, lookup)
    planes.push(regriddedPlane)
  }

  if (fieldDef.id === 'conv3' && planes.length === 2) {
    const combined = new Float32Array(planes[0].length)
    for (let i = 0; i < combined.length; i++) {
      combined[i] = planes[0][i] + planes[1][i]
    }
    planes = [combined]
  }

  if (planes.length !== fieldDef.planes) {
    throw new Error(`plane count mismatch for ${fieldDef.id}: got ${planes.length}, expected ${fieldDef.planes}`)
  }

  let rainWindowH: number | undefined = undefined
  let newLastTotPrec = lastTotPrec ?? undefined
  let newLastConv = lastConv ?? undefined

  if (fieldDef.id === 'rain3') {
    const deaccum = deaccumulateIconStep({
      stepHours,
      currentMm: planes[0],
      prevMm: lastTotPrec,
    })
    newLastTotPrec = planes[0]
    planes[0] = deaccum.values
    rainWindowH = deaccum.rainWindowH
  } else if (fieldDef.id === 'conv3') {
    const deaccum = deaccumulateIconStep({
      stepHours,
      currentMm: planes[0],
      prevMm: lastConv,
    })
    newLastConv = planes[0]
    planes[0] = deaccum.values
    rainWindowH = deaccum.rainWindowH
  } else if (fieldDef.id === 'thundr') {
    const thundrGrid = computeThunderGrid({
      model: 'icon',
      wwCode: planes[0],
      length: planes[0].length,
    })
    planes[0] = new Float32Array(thundrGrid)
  }

  // Pack values into WGR1
  let min = Infinity
  let max = -Infinity
  for (const p of planes) {
    for (let k = 0; k < p.length; k++) {
      const v = p[k]
      if (v < min) min = v
      if (v > max) max = v
    }
  }

  const picked = fieldDef.pack === 'uint8' ? { scale: 1, offset: 0 } : pickScaleOffset(min, max)
  const meta = {
    model: modelLabel,
    fieldId: fieldDef.id,
    level: fieldDef.level,
    unit: fieldDef.unit,
    referenceTimeIso: refTimeIso,
    validTimeIso: validTimeIso,
    source: SOURCE_LABEL,
    nx: targetGrid.nx,
    ny: targetGrid.ny,
    lat0: targetGrid.minLat,
    dLat: targetGrid.dLat,
    lon0: targetGrid.minLon,
    dLon: targetGrid.dLon,
    planes: fieldDef.planes,
    pack: fieldDef.pack,
    scale: picked.scale,
    offset: picked.offset,
    min,
    max,
    ...(rainWindowH != null ? { rainWindowH } : {}),
  }

  const wgr1 = encodeWgr1(meta, planes)

  return {
    fieldId: fieldDef.id,
    stepHours,
    unit: fieldDef.unit,
    levelLabel: fieldDef.levelLabel,
    wgr1,
    bytes: wgr1.length,
    min,
    max,
    ...(rainWindowH != null ? { rainWindowH } : {}),
    ...(newLastTotPrec ? { lastTotPrec: newLastTotPrec } : {}),
    ...(newLastConv ? { lastConv: newLastConv } : {}),
  }
}
