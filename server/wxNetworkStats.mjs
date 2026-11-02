// Pure verification maths for the India-wide network skill table. No network,
// no storage, no clock reads -- every input is passed in. Shared by
// server/wxNetworkCollector.mjs (folding live pairs) and server/wxModelChoice.mjs
// (ranking and the held-out proof).
//
// Convention (same as server/wxLearning.mjs): error e = observed - forecast,
// so bias = mean(e) is what you ADD to the model value. Continuous cells keep
// running bias / MAE / MSE; categorical cells keep contingency counts.
// A missing value is always null and is never scored -- it is never 0.

export const NETWORK_MODELS = [
  'ecmwf_ifs025',
  'gfs_seamless',
  'icon_seamless',
  'ukmo_seamless',
  'meteofrance_seamless',
  'gem_seamless',
  // Two further free models the same API offers (task: at most two extras).
  'jma_seamless',
  'kma_seamless',
]

// Continuous parameters: verified with bias / MAE / RMSE (direction is
// circular -- errors are wrapped to (-180, 180] degrees first).
export const NET_CONT_PARAMS = ['tempC', 'dewC', 'qnhHpa', 'windKts', 'windDirDeg', 'gustKts']
// Categorical parameters: verified with hit rate, false-alarm ratio and CSI.
// 'ceilingBand' is included so the structure is ready, but Open-Meteo exposes
// no ceiling height, so no forecast value ever fills it (see the report).
export const NET_CAT_PARAMS = ['visBand', 'cloudBand', 'ceilingBand', 'precip']
export const NET_PARAMS = [...NET_CONT_PARAMS, ...NET_CAT_PARAMS]

// Seasons by month (ASSUMED boundaries -- the user may change them):
// winter Dec-Feb, pre-monsoon Mar-May, SW monsoon Jun-Sep, post-monsoon Oct-Nov.
export const SEASONS = ['winter', 'pre-monsoon', 'sw-monsoon', 'post-monsoon']
const SEASON_OF_MONTH = {
  12: 'winter', 1: 'winter', 2: 'winter',
  3: 'pre-monsoon', 4: 'pre-monsoon', 5: 'pre-monsoon',
  6: 'sw-monsoon', 7: 'sw-monsoon', 8: 'sw-monsoon', 9: 'sw-monsoon',
  10: 'post-monsoon', 11: 'post-monsoon',
}
const IST_OFFSET_MS = 19_800_000

export const LEAD_BUCKETS = ['D0', 'D1', 'D2', 'D3']

const finite = v => typeof v === 'number' && Number.isFinite(v)

/** Season of a timestamp, months read in IST (the network's local time). */
export function seasonOf(tMs) {
  if (!finite(tMs)) return null
  return SEASON_OF_MONTH[new Date(tMs + IST_OFFSET_MS).getUTCMonth() + 1] ?? null
}

/** Same lead-bucket windows as server/wxLearning.mjs. */
export function leadBucketOf(leadHours) {
  if (!finite(leadHours) || leadHours < 18) return 'D0'
  if (leadHours < 36) return 'D1'
  if (leadHours < 60) return 'D2'
  return 'D3'
}

/** Wrap a direction difference into (-180, 180] so circular errors stay small. */
export function wrapDeg(d) {
  if (!finite(d)) return null
  let x = d % 360
  if (x > 180) x -= 360
  if (x <= -180) x += 360
  return x
}

// ---- Categorical bands ----------------------------------------------------
// Band edges are ASSUMED (the task gave example visibility bands and left the
// rest to us); every edge is half-open on the low side: [a, b).

export const VIS_BANDS = ['<1km', '1-3km', '3-5km', '5-8km', '>8km']
export const CLOUD_BANDS = ['clear', 'few', 'scattered', 'broken', 'overcast']
export const CEILING_BANDS = ['none', '<300ft', '300-1000ft', '1000-3000ft', '>3000ft']
export const PRECIP_BANDS = ['no', 'yes']

/** Visibility band from kilometres; null (missing) stays null. */
export function visBandOf(km) {
  if (!finite(km) || km < 0) return null
  if (km < 1) return '<1km'
  if (km < 3) return '1-3km'
  if (km < 5) return '3-5km'
  if (km < 8) return '5-8km'
  return '>8km'
}

/** Sky-cover band from a METAR cloud-cover code. */
export function cloudBandOfCode(code) {
  if (typeof code !== 'string' || !code) return null
  const c = code.toUpperCase()
  if (c === 'CLR' || c === 'SKC' || c === 'NSC' || c === 'NSW' || c === 'NCD') return 'clear'
  if (c === 'FEW') return 'few'
  if (c === 'SCT') return 'scattered'
  if (c === 'BKN') return 'broken'
  if (c === 'OVC' || c === 'VV') return 'overcast'
  return null
}

/**
 * Sky-cover band from a 0-100 % sky-cover figure (Open-Meteo's cloud_cover),
 * through octas (1 okta = 12.5 %): 0 clear, 1-2 few, 3-4 scattered, 5-7 broken,
 * 8 overcast. ASSUMED edges.
 */
export function cloudBandOfPct(pct) {
  if (!finite(pct) || pct < 0) return null
  if (pct < 6.25) return 'clear'
  if (pct < 25) return 'few'
  if (pct < 50) return 'scattered'
  if (pct < 87.5) return 'broken'
  return 'overcast'
}

/** Ceiling band from the lowest BKN/OVC/VV base in feet; null when no ceiling. */
export function ceilingBandOf(ft, hasCeiling) {
  if (hasCeiling === false) return 'none'
  if (!finite(ft) || ft < 0) return null
  if (ft < 300) return '<300ft'
  if (ft < 1000) return '300-1000ft'
  if (ft < 3000) return '1000-3000ft'
  return '>3000ft'
}

/** Precipitation occurrence: any RA / DZ / SH / TS in the present-weather group. */
export function precipBandOf(present) {
  if (present === true) return 'yes'
  if (present === false) return 'no'
  return null
}

/**
 * Sea-level altimeter setting in hPa, or null when the figure cannot be one.
 * The archive has held values like 2.95 (a misplaced decimal in inches) whose
 * conversion to hPa gave 99.9, which was then scored as an observation;
 * anything outside the physically possible band below is missing, never 0.
 * ASSUMED band (widest recorded sea-level pressures): the user may change it.
 */
export const QNH_MIN_HPA = 870
export const QNH_MAX_HPA = 1085

export function plausibleQnhHpa(v) {
  return finite(v) && v >= QNH_MIN_HPA && v <= QNH_MAX_HPA ? v : null
}

// Bands used as the "event" a categorical score is computed on: what matters
// for flying. ASSUMED thresholds.
export const PRIMARY_EVENT = {
  visBand: b => b === '<1km' || b === '1-3km',
  cloudBand: b => b === 'overcast',
  ceilingBand: b => b === '<300ft' || b === '300-1000ft',
  precip: b => b === 'yes',
}

export function bandsOf(param) {
  if (param === 'visBand') return VIS_BANDS
  if (param === 'cloudBand') return CLOUD_BANDS
  if (param === 'ceilingBand') return CEILING_BANDS
  if (param === 'precip') return PRECIP_BANDS
  return []
}

// ---- Cells ---------------------------------------------------------------

// Errors are kept in a bounded ring so the bootstrap can resample real
// errors without storing the whole history.
export const SAMPLE_CAP = 200

export function emptyContCell() {
  return { n: 0, bias: 0, mae: 0, mse: 0, samples: [], lastMs: 0 }
}

export function emptyCatCell() {
  return {
    n: 0,
    bandHits: 0,
    byBand: {},
    hits: 0,
    misses: 0,
    falseAlarms: 0,
    correctNegatives: 0,
    samples: [],
    lastMs: 0,
  }
}

/**
 * Fold one continuous verification pair. `e` is observed - forecast.
 * Non-finite error is ignored (a missing value is never scored as 0).
 */
export function addCont(cell, e, tMs) {
  if (!finite(e)) return cell
  const c = cell ?? emptyContCell()
  const n = c.n + 1
  c.bias += (e - c.bias) / n
  c.mae += (Math.abs(e) - c.mae) / n
  c.mse += (e * e - c.mse) / n
  c.n = n
  if (c.samples.length >= SAMPLE_CAP) c.samples.shift()
  c.samples.push(Math.round(e * 1000) / 1000)
  if (finite(tMs)) c.lastMs = Math.max(c.lastMs, tMs)
  return c
}

/**
 * Fold one categorical pair (predicted band vs observed band). Both must be
 * present; either being null means the pair is skipped, never counted as 0.
 */
export function addCat(cell, pred, obs, param, tMs) {
  if (typeof pred !== 'string' || typeof obs !== 'string') return cell
  const c = cell ?? emptyCatCell()
  const isEvent = PRIMARY_EVENT[param]
  const predEvent = isEvent(pred)
  const obsEvent = isEvent(obs)
  c.n++
  if (pred === obs) c.bandHits++
  // One-vs-rest contingency for every band of this parameter.
  for (const band of bandsOf(param)) {
    const cellB = (c.byBand[band] ??= { hits: 0, misses: 0, falseAlarms: 0, correctNegatives: 0 })
    const p = pred === band
    const o = obs === band
    if (p && o) cellB.hits++
    else if (!p && o) cellB.misses++
    else if (p && !o) cellB.falseAlarms++
    else cellB.correctNegatives++
  }
  // Primary event contingency (the score models are ranked by).
  if (predEvent && obsEvent) c.hits++
  else if (!predEvent && obsEvent) c.misses++
  else if (predEvent && !obsEvent) c.falseAlarms++
  else c.correctNegatives++
  if (c.samples.length >= SAMPLE_CAP) c.samples.shift()
  c.samples.push({ p: pred, o: obs })
  if (finite(tMs)) c.lastMs = Math.max(c.lastMs, tMs)
  return c
}

// ---- Metrics -------------------------------------------------------------

export function contMetrics(cell) {
  const n = cell?.n ?? 0
  if (!n) return { n: 0, bias: null, mae: null, rmse: null }
  return {
    n,
    bias: cell.bias,
    mae: cell.mae,
    rmse: Math.sqrt(cell.mse),
  }
}

function ratio(a, b) {
  return b > 0 ? a / b : null
}

/**
 * Categorical scores for the primary event: hit rate (POD), false-alarm ratio
 * and critical success index. Null when the denominator is 0 -- never 0 by
 * default. `exactRate` is the fraction of exact band matches.
 */
export function catMetrics(cell) {
  const n = cell?.n ?? 0
  const { hits = 0, misses = 0, falseAlarms = 0, correctNegatives = 0, bandHits = 0 } = cell ?? {}
  return {
    n,
    hitRate: ratio(hits, hits + misses),
    far: ratio(falseAlarms, falseAlarms + hits),
    csi: ratio(hits, hits + misses + falseAlarms),
    exactRate: ratio(bandHits, n),
    hits,
    misses,
    falseAlarms,
    correctNegatives,
  }
}

/** One-vs-rest scores for a single band of a categorical parameter. */
export function bandMetrics(cell, band) {
  const b = cell?.byBand?.[band]
  if (!b) return { n: cell?.n ?? 0, hitRate: null, far: null, csi: null, hits: 0, misses: 0, falseAlarms: 0, correctNegatives: 0 }
  return { n: cell?.n ?? 0, ...catMetrics({ ...b, bandHits: 0, n: cell.n }) }
}

/** Metric used to rank models for a parameter (task: RMSE, or CSI). */
export function rankingMetric(cell, param) {
  if (NET_CAT_PARAMS.includes(param)) {
    const m = catMetrics(cell)
    return { name: 'csi', value: m.csi, higherIsBetter: true }
  }
  const m = contMetrics(cell)
  return { name: 'rmse', value: m.rmse, higherIsBetter: false }
}
