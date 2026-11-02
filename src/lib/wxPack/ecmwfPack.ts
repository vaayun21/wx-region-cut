/**
 * Pure conversion, index lookup, and grid cropping functions for ECMWF IFS 0.25 open data.
 *
 * SAFETY CRITICAL: Physical values and geographic bounds are preserved.
 * No Node-only imports (fs, path, Buffer).
 */

import { encodeWgr1, pickScaleOffset } from './wgr1.ts'
import { packFieldById } from './deviceBuilder.ts'
import { decodeGrib2 } from '../windGrid/grib2.ts'
import { deaccumulateEcmwfStep, computeThunderGrid } from './thunderRule.ts'
import { buildForecastSteps } from './deviceBuilder.ts'

export interface EcmwfFieldMapping {
  id: string
  param: string
  category: number
  number: number
  levelType: number
  levelValue?: number
  pairWith?: string
  conversion: (v: number) => number
}

export const ECMWF_FIELDS: readonly EcmwfFieldMapping[] = Object.freeze([
  { id: 'wind10', param: '10u', category: 2, number: 2, levelType: 103, levelValue: 10, pairWith: '10v', conversion: (v: number) => v },
  { id: 'wind10', param: '10v', category: 2, number: 3, levelType: 103, levelValue: 10, pairWith: '10u', conversion: (v: number) => v },
  { id: 'wind925', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 92500, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind925', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 92500, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind850', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 85000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind850', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 85000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind700', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 70000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind700', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 70000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind500', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 50000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind500', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 50000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind400', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 40000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind400', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 40000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind300', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 30000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind300', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 30000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind250', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 25000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind250', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 25000, pairWith: 'u', conversion: (v: number) => v },
  { id: 'wind200', param: 'u', category: 2, number: 2, levelType: 100, levelValue: 20000, pairWith: 'v', conversion: (v: number) => v },
  { id: 'wind200', param: 'v', category: 2, number: 3, levelType: 100, levelValue: 20000, pairWith: 'u', conversion: (v: number) => v },

  { id: 'gust', param: '10fg', category: 2, number: 22, levelType: 1, levelValue: 0, conversion: (v: number) => v },

  { id: 'temp2', param: '2t', category: 0, number: 0, levelType: 103, levelValue: 2, conversion: (v: number) => v },
  { id: 'dewpt', param: '2d', category: 0, number: 6, levelType: 103, levelValue: 2, conversion: (v: number) => v },
  { id: 'temp925', param: 't', category: 0, number: 0, levelType: 100, levelValue: 92500, conversion: (v: number) => v },
  { id: 'temp850', param: 't', category: 0, number: 0, levelType: 100, levelValue: 85000, conversion: (v: number) => v },
  { id: 'temp700', param: 't', category: 0, number: 0, levelType: 100, levelValue: 70000, conversion: (v: number) => v },
  { id: 'temp500', param: 't', category: 0, number: 0, levelType: 100, levelValue: 50000, conversion: (v: number) => v },
  { id: 'temp400', param: 't', category: 0, number: 0, levelType: 100, levelValue: 40000, conversion: (v: number) => v },
  { id: 'temp300', param: 't', category: 0, number: 0, levelType: 100, levelValue: 30000, conversion: (v: number) => v },
  { id: 'temp250', param: 't', category: 0, number: 0, levelType: 100, levelValue: 25000, conversion: (v: number) => v },
  { id: 'temp200', param: 't', category: 0, number: 0, levelType: 100, levelValue: 20000, conversion: (v: number) => v },

  { id: 'mslp', param: 'msl', category: 3, number: 0, levelType: 101, conversion: (v: number) => v },

  { id: 'cloud', param: 'tcc', category: 6, number: 1, levelType: 10, levelValue: 0, conversion: (v: number) => v * 100 },

  { id: 'precip', param: 'tprate', category: 1, number: 7, levelType: 1, levelValue: 0, conversion: (v: number) => v },
  { id: 'cape', param: 'mucape', category: 7, number: 6, levelType: 1, levelValue: 0, conversion: (v: number) => v },
  { id: 'rain3', param: 'tp', category: 1, number: 8, levelType: 1, levelValue: 0, conversion: (v: number) => v },
  { id: 'conv3', param: 'cp', category: 1, number: 10, levelType: 1, levelValue: 0, conversion: (v: number) => v },

  // IFS 'gh' is already geopotential height in gpm (not m2/s2): verified against GFS (5880 m at 500 hPa)
  { id: 'hgt925', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 92500, conversion: (v: number) => v },
  { id: 'hgt850', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 85000, conversion: (v: number) => v },
  { id: 'hgt700', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 70000, conversion: (v: number) => v },
  { id: 'hgt500', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 50000, conversion: (v: number) => v },
  { id: 'hgt400', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 40000, conversion: (v: number) => v },
  { id: 'hgt300', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 30000, conversion: (v: number) => v },
  { id: 'hgt250', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 25000, conversion: (v: number) => v },
  { id: 'hgt200', param: 'gh', category: 3, number: 4, levelType: 100, levelValue: 20000, conversion: (v: number) => v },
])

/** Forecast box: latitude -20 (20 S) to 45 N, longitude 20 E to 155 E. user requirement 2026-10-19. */
export const FORECAST_BOX = Object.freeze({ minLat: -20, maxLat: 45, minLon: 20, maxLon: 155 })

export const ECMWF_BASE = 'https://data.ecmwf.int/forecasts'
/**
 * The ECMWF open-data copy on Google Cloud (same files; the Amazon copy answered 'slow down' on 2026-11-02). It serves the .index list as plain
 * bytes; data.ecmwf.int labels it application/json, and the device's native HTTP stack then
 * keeps only the first line of that list (found on the device 2026-11-02).
 */
export const ECMWF_INDEX_MIRROR = 'https://storage.googleapis.com/ecmwf-open-data'
export const ECMWF_MAX_AVAILABLE_STEP = 240
export const ECMWF_DEFAULT_MAX_STEP = 168
export const ECMWF_DEFAULT_STEPS = Object.freeze(buildForecastSteps(ECMWF_DEFAULT_MAX_STEP))

export interface IfsFieldLike {
  la1: number
  la2: number
  lo1: number
  lo2: number
  ni: number
  nj: number
  values: Float32Array
}

export function cropIfsToGfs(
  ifsField: IfsFieldLike,
  conversion: (v: number) => number = (v) => v,
  box: { minLat: number; maxLat: number; minLon: number; maxLon: number } = FORECAST_BOX
): { values: Float32Array; min: number; max: number } {
  const GFS_NI = Math.round((box.maxLon - box.minLon) / 0.25) + 1
  const GFS_NJ = Math.round((box.maxLat - box.minLat) / 0.25) + 1
  const GFS_LA1 = box.minLat
  const GFS_LO1 = box.minLon
  const gfsDj = 0.25
  const gfsDi = 0.25
  const ifsDj = (ifsField.la2 - ifsField.la1) / (ifsField.nj - 1)
  const ifsDi = 360 / ifsField.ni

  const out = new Float32Array(GFS_NI * GFS_NJ)
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (let gj = 0; gj < GFS_NJ; gj++) {
    const lat = GFS_LA1 + gj * gfsDj
    const ij = Math.round((lat - ifsField.la1) / ifsDj)

    for (let gi = 0; gi < GFS_NI; gi++) {
      const lon = GFS_LO1 + gi * gfsDi
      let dLon = lon - ifsField.lo1
      while (dLon < 0) dLon += 360
      while (dLon >= 360) dLon -= 360
      const ii = Math.round(dLon / ifsDi) % ifsField.ni

      const val = conversion(ifsField.values[ij * ifsField.ni + ii])
      out[gj * GFS_NI + gi] = val
      if (val < min) min = val
      if (val > max) max = val
    }
  }
  return { values: out, min, max }
}

export interface EcmwfIndexEntry {
  param: string
  levtype: string
  levelist?: string | number
  _offset: number
  _length: number
  [key: string]: any
}

export async function fetchEcmwfIndex(
  cycleUtc: string,
  step: number,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
  baseOverride?: string,
): Promise<EcmwfIndexEntry[] | null> {
  const dateStr = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}`
  const runStr = cycleUtc.slice(11, 13)

  const baseUrl = `${baseOverride ?? ECMWF_BASE}/${dateStr}/${runStr}z/ifs/0p25/oper`
  const fileBase = `${dateStr}${runStr}0000-${step}h-oper-fc.grib2`
  const indexUrl = `${baseUrl}/${fileBase.replace(/\.grib2$/, '')}.index`

  try {
    const res = await fetchImpl(indexUrl, {
      headers: { 'User-Agent': 'wx-region-cut/1 (personal weather tool)' }
    })
    if (!res || !res.ok) return null
    const text = await res.text()
    const lines = text.split('\n').filter(Boolean)
    return lines.map((line) => JSON.parse(line))
  } catch {
    return null
  }
}

export function getCandidateCycles(nowMs: number = Date.now()): string[] {
  const d = new Date(nowMs)
  const cycles: string[] = []

  for (let i = 0; i < 4; i++) {
    for (const h of [12, 0]) {
      const c = new Date(d)
      c.setUTCDate(d.getUTCDate() - i)
      c.setUTCHours(h, 0, 0, 0)

      const diffHrs = (nowMs - c.getTime()) / 3600000
      if (diffHrs >= 7) {
        cycles.push(c.toISOString().replace('.000Z', 'Z'))
      }
    }
  }
  return cycles
}

export interface TargetIndexEntry extends EcmwfFieldMapping {
  entry: EcmwfIndexEntry
}

/**
 * Finds the index entry / entries needed for a field definition.
 */
export function findEcmwfEntriesForField(
  fieldMap: EcmwfFieldMapping,
  indexEntries: EcmwfIndexEntry[]
): TargetIndexEntry[] {
  const targetEntries: TargetIndexEntry[] = []
  if (fieldMap.pairWith) {
    const f1 = ECMWF_FIELDS.find((f) => f.id === fieldMap.id && f.number === 2)
    const f2 = ECMWF_FIELDS.find((f) => f.id === fieldMap.id && f.number === 3)
    if (!f1 || !f2) return []

    const levTypeKey = fieldMap.levelType === 103 ? 'sfc' : 'pl'
    const levVal = fieldMap.levelValue ? fieldMap.levelValue / 100 : undefined

    const entryU = indexEntries.find(
      (e) => e.param === f1.param && e.levtype === levTypeKey && (levTypeKey === 'pl' ? Number(e.levelist) === levVal : true)
    )
    const entryV = indexEntries.find(
      (e) => e.param === f2.param && e.levtype === levTypeKey && (levTypeKey === 'pl' ? Number(e.levelist) === levVal : true)
    )

    if (entryU && entryV) {
      targetEntries.push({ ...f1, entry: entryU })
      targetEntries.push({ ...f2, entry: entryV })
    }
  } else {
    const levTypeKey = fieldMap.levelType === 100 ? 'pl' : 'sfc'
    const levVal = fieldMap.levelValue ? fieldMap.levelValue / 100 : undefined
    const entry = indexEntries.find(
      (e) => e.param === fieldMap.param && e.levtype === levTypeKey && (levTypeKey === 'pl' ? Number(e.levelist) === levVal : true)
    )
    if (entry) targetEntries.push({ ...fieldMap, entry })
  }
  return targetEntries
}

export interface ConvertEcmwfFieldResult {
  fieldId: string
  stepHours: number
  unit: string
  levelLabel: string
  wgr1: Uint8Array
  bytes: number
  min: number
  max: number
  rainWindowH?: number
  lastTp?: Float32Array
  lastCp?: Float32Array
}

/**
 * Pure function to convert decoded planes or GRIB2 buffers for an ECMWF field into a WGR1 grid file.
 */
export function convertEcmwfFieldPlanes({
  fieldId,
  stepHours,
  planes,
  referenceTimeIso,
  validTimeIso,
  box = FORECAST_BOX,
  lastTp = null,
  lastCp = null,
}: {
  fieldId: string
  stepHours: number
  planes: Float32Array[]
  referenceTimeIso: string
  validTimeIso: string
  box?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
  lastTp?: Float32Array | null
  lastCp?: Float32Array | null
}): ConvertEcmwfFieldResult | null {
  const def = packFieldById(fieldId)
  if (planes.length !== def.planes) return null

  const GFS_NI = Math.round((box.maxLon - box.minLon) / 0.25) + 1
  const GFS_NJ = Math.round((box.maxLat - box.minLat) / 0.25) + 1
  const GFS_LA1 = box.minLat
  const GFS_LO1 = box.minLon

  const processedPlanes = [...planes]
  let rainWindowH: number | undefined = undefined
  let newLastTp = lastTp ?? undefined
  let newLastCp = lastCp ?? undefined

  if (fieldId === 'rain3') {
    const deaccum = deaccumulateEcmwfStep({
      stepHours,
      currentMetres: processedPlanes[0],
      prevMetres: lastTp,
    })
    newLastTp = processedPlanes[0]
    processedPlanes[0] = deaccum.values
    rainWindowH = deaccum.rainWindowH
  } else if (fieldId === 'conv3') {
    const deaccum = deaccumulateEcmwfStep({
      stepHours,
      currentMetres: processedPlanes[0],
      prevMetres: lastCp,
    })
    newLastCp = processedPlanes[0]
    processedPlanes[0] = deaccum.values
    rainWindowH = deaccum.rainWindowH
  }

  let gMin = Number.POSITIVE_INFINITY
  let gMax = Number.NEGATIVE_INFINITY
  for (const p of processedPlanes) {
    for (let i = 0; i < p.length; i++) {
      if (p[i] < gMin) gMin = p[i]
      if (p[i] > gMax) gMax = p[i]
    }
  }

  const picked = def.pack === 'uint8' ? { scale: 1, offset: 0 } : pickScaleOffset(gMin, gMax)

  const meta = {
    model: 'ECMWF IFS 0.25',
    fieldId: def.id,
    level: def.level,
    unit: def.unit,
    referenceTimeIso,
    validTimeIso,
    source: 'ECMWF IFS open data',
    nx: GFS_NI,
    ny: GFS_NJ,
    lat0: GFS_LA1,
    dLat: 0.25,
    lon0: GFS_LO1,
    dLon: 0.25,
    planes: def.planes,
    pack: def.pack,
    scale: picked.scale,
    offset: picked.offset,
    min: gMin,
    max: gMax,
    ...(rainWindowH != null ? { rainWindowH } : {}),
  }

  const wgr1 = encodeWgr1(meta, processedPlanes)

  return {
    fieldId: def.id,
    stepHours,
    unit: def.unit,
    levelLabel: def.levelLabel,
    wgr1,
    bytes: wgr1.length,
    min: gMin,
    max: gMax,
    ...(rainWindowH != null ? { rainWindowH } : {}),
    ...(newLastTp ? { lastTp: newLastTp } : {}),
    ...(newLastCp ? { lastCp: newLastCp } : {}),
  }
}

/**
 * Pure function to synthesize step 0 rain and thunder if step > 0 produced them but step 0 lacks them.
 */
export function synthesizeEcmwfStep0({
  sampleMeta,
  hasRain3,
  hasThundr,
}: {
  sampleMeta: any
  hasRain3: boolean
  hasThundr: boolean
}): Array<{ fieldId: string; stepHours: number; unit: string; levelLabel: string; wgr1: Uint8Array; bytes: number; min: number; max: number; rainWindowH?: number }> {
  const result: Array<{ fieldId: string; stepHours: number; unit: string; levelLabel: string; wgr1: Uint8Array; bytes: number; min: number; max: number; rainWindowH?: number }> = []
  const nPoints = sampleMeta.nx * sampleMeta.ny
  const zeroFloats = new Float32Array(nPoints)

  if (hasRain3) {
    for (const fid of ['rain3', 'conv3']) {
      const m = {
        ...sampleMeta,
        fieldId: fid,
        unit: 'mm',
        level: 'sfc',
        planes: 1,
        pack: 'int16' as const,
        scale: 100,
        offset: 0,
        min: 0,
        max: 0,
        rainWindowH: 3,
      }
      const w = encodeWgr1(m, [zeroFloats])
      result.push({
        fieldId: fid,
        stepHours: 0,
        unit: 'mm',
        levelLabel: 'surface',
        wgr1: w,
        bytes: w.length,
        min: 0,
        max: 0,
        rainWindowH: 3,
      })
    }
  }

  if (hasThundr) {
    const m = {
      ...sampleMeta,
      fieldId: 'thundr',
      unit: 'class',
      level: 'sfc',
      planes: 1,
      pack: 'uint8' as const,
      scale: 1,
      offset: 0,
      min: 0,
      max: 0,
    }
    const w = encodeWgr1(m, [zeroFloats])
    result.push({
      fieldId: 'thundr',
      stepHours: 0,
      unit: 'class',
      levelLabel: 'surface',
      wgr1: w,
      bytes: w.length,
      min: 0,
      max: 0,
    })
  }

  return result
}

/**
 * Pure function to compute the ECMWF thunder diagnostic WGR1 grid from conv3 and cape decoded grids.
 */
export function computeEcmwfThunder({
  conv3Decoded,
  capeDecoded,
  box = FORECAST_BOX,
}: {
  conv3Decoded: { meta: any; planes: Float32Array[] }
  capeDecoded: { meta: any; planes: Float32Array[] }
  box?: { minLat: number; maxLat: number; minLon: number; maxLon: number }
}): { wgr1: Uint8Array; min: number; max: number; bytes: number } {
  const GFS_NI = Math.round((box.maxLon - box.minLon) / 0.25) + 1
  const GFS_NJ = Math.round((box.maxLat - box.minLat) / 0.25) + 1
  const GFS_LA1 = box.minLat
  const GFS_LO1 = box.minLon

  const thundrGrid = computeThunderGrid({
    model: 'ecmwf',
    conv3Mm: conv3Decoded.planes[0],
    capeJkg: capeDecoded.planes[0],
    length: GFS_NI * GFS_NJ,
  })
  let thundrMax = 0
  for (let i = 0; i < thundrGrid.length; i++) {
    if (thundrGrid[i] > thundrMax) thundrMax = thundrGrid[i]
  }
  const thundrDef = packFieldById('thundr')
  const thundrMeta = {
    model: 'ECMWF IFS 0.25',
    fieldId: 'thundr',
    level: thundrDef.level,
    unit: thundrDef.unit,
    referenceTimeIso: conv3Decoded.meta.referenceTimeIso,
    validTimeIso: conv3Decoded.meta.validTimeIso,
    source: 'ECMWF IFS open data',
    nx: GFS_NI,
    ny: GFS_NJ,
    lat0: GFS_LA1,
    dLat: 0.25,
    lon0: GFS_LO1,
    dLon: 0.25,
    planes: 1,
    pack: 'uint8' as const,
    scale: 1,
    offset: 0,
    min: 0,
    max: thundrMax,
  }
  const thundrWgr1 = encodeWgr1(thundrMeta, [new Float32Array(thundrGrid)])
  return {
    wgr1: thundrWgr1,
    min: 0,
    max: thundrMax,
    bytes: thundrWgr1.length,
  }
}
