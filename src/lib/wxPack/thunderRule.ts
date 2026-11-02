/**
 * src/lib/wxPack/thunderRule.ts
 *
 * Thunder risk diagnosis and precipitation de-accumulation rules shared by
 * server pack builders and the client.
 *
 * SAFETY: Weather model data is advisory. This layer represents model forecast
 * convective potential and significant weather diagnosis -- NOT detected lightning.
 * Every threshold that is not a published official figure is marked APP_ESTIMATE.
 */

/**
 * Minimum convective precipitation threshold for model thunder risk in GFS and ECMWF.
 * APP_ESTIMATE: 1.5 mm per accumulation window.
 * Source: Lowest visible precipitation tick on Windy's "Rain, thunder" legend scale (1.5 mm/3h).
 */
export const CONV_MIN_MM = 1.5

/**
 * Minimum CAPE threshold for model thunder risk in GFS and ECMWF.
 * APP_ESTIMATE: 1000 J/kg.
 * Source: Research hypothesis attributing to IMD FDP STORM bulletin; not verified by reviewer.
 */
export const CAPE_MIN_JKG = 1000

/**
 * DWD ICON Significant Weather (ww) codes diagnosing thunderstorms (WMO Code Table 4677).
 * VERIFIED:
 * - 95: Slight or moderate thunderstorm without hail
 * - 96: Slight or moderate thunderstorm with hail
 * - 99: Heavy thunderstorm with hail
 */
export const ICON_THUNDER_WW_CODES: readonly number[] = Object.freeze([95, 96, 99])

export interface ThunderClassInput {
  model?: string | null
  conv3Mm?: number | null
  capeJkg?: number | null
  wwCode?: number | null
}

/**
 * Pure function computing the thunder risk class for a grid cell.
 *
 * Returns:
 * - 0: No thunder risk
 * - 1: Moderate model thunder risk (ECMWF & GFS convective precip + CAPE threshold)
 * - 2: High / explicit model thunder risk (DWD ICON native ww code 95, 96, 99)
 *
 * Rules:
 * - ICON: 2 where ww is 95, 96, or 99; else 0 (no CAPE rule for ICON; never 2 for other models).
 * - ECMWF & GFS: 1 where conv3 >= CONV_MIN_MM (1.5 mm) AND cape >= CAPE_MIN_JKG (1000 J/kg); else 0 (never 2).
 * - If a model lacks a needed input, returns 0.
 */
export function thunderClass({ model, conv3Mm, capeJkg, wwCode }: ThunderClassInput): number {
  const m = model?.toLowerCase()
  if (m === 'icon') {
    if (wwCode != null && Number.isFinite(wwCode)) {
      const code = Math.round(wwCode)
      if (code === 95 || code === 96 || code === 99) {
        return 2
      }
    }
    return 0
  }

  if (m === 'ecmwf' || m === 'gfs') {
    if (
      conv3Mm != null &&
      Number.isFinite(conv3Mm) &&
      conv3Mm >= CONV_MIN_MM &&
      capeJkg != null &&
      Number.isFinite(capeJkg) &&
      capeJkg >= CAPE_MIN_JKG
    ) {
      return 1
    }
    return 0
  }

  return 0
}

/**
 * Vectorized thunder class computation for a grid.
 */
export function computeThunderGrid({
  model,
  conv3Mm,
  capeJkg,
  wwCode,
  length,
}: {
  model: string
  conv3Mm?: Float32Array | number[] | null
  capeJkg?: Float32Array | number[] | null
  wwCode?: Float32Array | Uint8Array | number[] | null
  length: number
}): Uint8Array {
  const out = new Uint8Array(length)
  const m = model.toLowerCase()
  if (m === 'icon') {
    if (!wwCode) return out
    for (let i = 0; i < length; i++) {
      const c = wwCode[i]
      if (c === 95 || c === 96 || c === 99) {
        out[i] = 2
      }
    }
    return out
  }

  if (m === 'ecmwf' || m === 'gfs') {
    if (!conv3Mm || !capeJkg) return out
    for (let i = 0; i < length; i++) {
      const conv = conv3Mm[i]
      const cape = capeJkg[i]
      if (conv >= CONV_MIN_MM && cape >= CAPE_MIN_JKG) {
        out[i] = 1
      }
    }
    return out
  }

  return out
}

// ---- De-accumulation rules per model -------------------------------------

export interface DeaccumResult {
  values: Float32Array
  rainWindowH: number
}

/**
 * De-accumulate NOAA GFS precipitation (APCP or ACPCP).
 *
 * Verified GFS inventory windows:
 * - Step 0: No accumulation (0 mm, window 3 h).
 * - Step <= 72:
 *   - step % 6 === 3 (f003, f009, f015, ...): carried as 3-hour accumulation (e.g. 0-3, 6-9, 12-15).
 *     Current accumulation is already the 3-hour amount over [step - 3, step].
 *   - step % 6 === 0 (f006, f012, f018, ...): carried as 6-hour accumulation (e.g. 0-6, 6-12, 12-18).
 *     To get the 3-hour amount over [step - 3, step], subtract the previous step's 3-hour amount:
 *     max(0, currentAccum - prevStepAmount).
 * - Step > 72 (6-hourly steps: f078, f084, ...):
 *   - Carried as 6-hour accumulation over [step - 6, step] (e.g. 72-78, 78-84).
 *     Amount is over the previous 6 h: emit window 6 h without rescaling.
 *
 * No value is ever negative.
 */
export function deaccumulateGfsStep({
  stepHours,
  currentAccum,
  prevStepAmount,
}: {
  stepHours: number
  currentAccum: Float32Array | number[]
  prevStepAmount?: Float32Array | number[] | null
}): DeaccumResult {
  const n = currentAccum.length
  const out = new Float32Array(n)

  if (stepHours === 0) {
    return { values: out, rainWindowH: 3 }
  }

  const isSixHourly = stepHours > 72
  const rainWindowH = isSixHourly ? 6 : 3

  if (isSixHourly) {
    // 6-hourly steps carry the 6-hour interval accumulation directly
    for (let i = 0; i < n; i++) {
      const v = currentAccum[i]
      out[i] = Number.isFinite(v) && v > 0 ? v : 0
    }
    return { values: out, rainWindowH }
  }

  const isResetStep = stepHours % 6 === 0

  if (!isResetStep) {
    // 3-hour window in GFS (e.g. 0-3, 6-9, 12-15)
    for (let i = 0; i < n; i++) {
      const v = currentAccum[i]
      out[i] = Number.isFinite(v) && v > 0 ? v : 0
    }
  } else {
    // 6-hour window in GFS (0-6, 6-12, 12-18): subtract previous 3-hour amount
    for (let i = 0; i < n; i++) {
      const curr = currentAccum[i]
      const prev = prevStepAmount ? prevStepAmount[i] : 0
      const diff = curr - (Number.isFinite(prev) ? prev : 0)
      out[i] = Number.isFinite(diff) && diff > 0 ? diff : 0
    }
  }

  return { values: out, rainWindowH }
}

/**
 * De-accumulate ECMWF Open Data precipitation (tp or cp).
 *
 * Verified: ECMWF tp and cp are accumulated continuously from step 0 in metres.
 * Convert to mm by multiplying by 1000.
 * Difference = max(0, (current_m - prev_m) * 1000).
 *
 * Steps <= 72: 3-hourly, window 3 h.
 * Steps > 72: 6-hourly, window 6 h.
 *
 * No value is ever negative.
 */
export function deaccumulateEcmwfStep({
  stepHours,
  currentMetres,
  prevMetres,
}: {
  stepHours: number
  currentMetres: Float32Array | number[]
  prevMetres?: Float32Array | number[] | null
}): DeaccumResult {
  const n = currentMetres.length
  const out = new Float32Array(n)
  const rainWindowH = stepHours > 72 ? 6 : 3

  if (stepHours === 0) {
    return { values: out, rainWindowH: 3 }
  }

  for (let i = 0; i < n; i++) {
    const curr = currentMetres[i]
    const prev = prevMetres ? prevMetres[i] : 0
    const diff = (curr - (Number.isFinite(prev) ? prev : 0)) * 1000
    out[i] = Number.isFinite(diff) && diff > 0 ? diff : 0
  }

  return { values: out, rainWindowH }
}

/**
 * De-accumulate DWD ICON precipitation (tot_prec or rain_con + snow_con).
 *
 * Verified: ICON tot_prec, rain_con, snow_con are accumulated continuously from step 0 in kg/m^2 (mm).
 * Difference = max(0, current_mm - prev_mm).
 *
 * Steps <= 72: 3-hourly, window 3 h.
 * Steps > 72: 6-hourly, window 6 h.
 *
 * No value is ever negative.
 */
export function deaccumulateIconStep({
  stepHours,
  currentMm,
  prevMm,
}: {
  stepHours: number
  currentMm: Float32Array | number[]
  prevMm?: Float32Array | number[] | null
}): DeaccumResult {
  const n = currentMm.length
  const out = new Float32Array(n)
  const rainWindowH = stepHours > 72 ? 6 : 3

  if (stepHours === 0) {
    return { values: out, rainWindowH: 3 }
  }

  for (let i = 0; i < n; i++) {
    const curr = currentMm[i]
    const prev = prevMm ? prevMm[i] : 0
    const diff = curr - (Number.isFinite(prev) ? prev : 0)
    out[i] = Number.isFinite(diff) && diff > 0 ? diff : 0
  }

  return { values: out, rainWindowH }
}
