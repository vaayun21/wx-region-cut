// Model choice for the India-wide network skill table: rank the models for one
// parameter / region / lead bucket / season, and pick one only when the
// evidence is strong enough. Pure maths -- every input (including the skill
// table) is passed in.
//
// The decision rule (task VERIF1, part d):
//   - metric is RMSE for continuous parameters and CSI for categorical ones;
//   - the winner must have at least MIN_PROVEN_PAIRS samples;
//   - its lead over the runner-up must exceed the bootstrap uncertainty of
//     that difference;
//   - otherwise the answer is the fixed equal-weight blend.

import {
  NETWORK_MODELS, NET_CAT_PARAMS, LEAD_BUCKETS, SEASONS,
  addCont, addCat, rankingMetric, wrapDeg, seasonOf,
} from '../../../server/wxNetworkStats.mjs'
import type {
  NetParam, NetCatParam, NetContParam, LeadBucket, Season,
  NetCell, ContCell, CatCell,
} from '../../../server/wxNetworkStats.mjs'

// Minimum verified pairs before an automatic pick is allowed. Advisory
// default, user may change.
export const MIN_PROVEN_PAIRS = 60
// Bootstrap resamples of the stored error samples when judging a difference.
export const BOOTSTRAP_ITERS = 200
// Fewer stored samples than this cannot be resampled meaningfully.
export const MIN_BOOTSTRAP_SAMPLES = 10

export interface NetworkPair {
  tMs: number
  station: string
  region: string
  season: Season
  bucket: LeadBucket
  leadH?: number
  obs: Partial<Record<NetParam, number | string | null>>
  fcst: Record<string, Partial<Record<NetParam, number | string | null>>>
}

/** scope -> model -> param -> bucket -> season -> cell */
export type NetworkSkillModels = Record<string, Record<string, Record<string, Record<string, Record<string, NetCell>>>>>

export interface NetworkSkill {
  version: number
  updatedAtMs: number
  models: NetworkSkillModels
  autoAllowed: Partial<Record<NetParam, boolean>>
  heldOut: HeldOutReport | null
}

export interface RankingRow {
  model: string
  metric: number | null
  metricName: 'rmse' | 'csi'
  higherIsBetter: boolean
  n: number
  cell: NetCell | null
}

export interface ChooseModelResult {
  param: NetParam
  region: string
  leadBucket: LeadBucket
  season: Season
  autoAllowed: boolean
  metricName: 'rmse' | 'csi'
  model: string
  reason: string
  metric: number | null
  n: number
  runnerUp: string | null
  margin: number | null
  uncertainty: number | null
}

export interface StrategyScore { n: number; rmse: number | null; csi: number | null }

export interface HeldOutParamReport {
  autoAllowed: boolean
  metric: 'rmse' | 'csi'
  bestGlobalModel: string | null
  overall: Record<'auto' | 'blend' | 'bestGlobal', StrategyScore>
  byRegion: Record<string, Record<'auto' | 'blend' | 'bestGlobal', StrategyScore>>
}

export interface HeldOutReport {
  params: Record<string, HeldOutParamReport>
  autoAllowed: Partial<Record<NetParam, boolean>>
  trainCutMs: number
  trainPairs: number
  testPairs: number
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const scopeAll = (): string => 'all'
export const regionScope = (region: string): string => `region:${region}`
export const stationScope = (station: string): string => `station:${station}`

/** One record per (station, valid time, lead bucket): obs and each model's value. */
export function foldPairIntoSkill(skill: NetworkSkill, pair: NetworkPair): NetworkSkill {
  if (!pair || !pair.obs || !pair.fcst) return skill
  const models = (skill.models ??= {})
  const scopes = [scopeAll(), regionScope(pair.region), stationScope(pair.station)]
  const bucket = pair.bucket
  const season = pair.season ?? seasonOf(pair.tMs)
  if (!bucket || !season) return skill
  for (const [model, f] of Object.entries(pair.fcst)) {
    if (!f || typeof f !== 'object') continue
    for (const [param, o] of Object.entries(pair.obs) as Array<[NetParam, number | string | null | undefined]>) {
      const v = f[param]
      if (v === null || v === undefined || o === null || o === undefined) continue
      for (const scope of scopes) {
        const byModel = (((models[scope] ??= {})[model] ??= {})[param] ??= {})
        const byBucket = (byModel[bucket] ??= {})
        if ((NET_CAT_PARAMS as readonly string[]).includes(param)) {
          byBucket[season] = addCat(byBucket[season] as CatCell | undefined, String(v), String(o), param as NetCatParam, pair.tMs)
        } else {
          const numV = Number(v)
          const numO = Number(o)
          const e = param === 'windDirDeg' ? wrapDeg(numO - numV) : numO - numV
          if (e === null) continue
          byBucket[season] = addCont(byBucket[season] as ContCell | undefined, e, pair.tMs)
        }
      }
    }
  }
  return skill
}

export function emptyNetworkSkill(): NetworkSkill {
  return { version: 1, updatedAtMs: 0, models: {}, autoAllowed: {}, heldOut: null }
}

function cellAt(table: NetworkSkill, scope: string, model: string, param: NetParam, bucket: LeadBucket, season: Season): NetCell | null {
  return table?.models?.[scope]?.[model]?.[param]?.[bucket]?.[season] ?? null
}

function modelsInScope(table: NetworkSkill, scope: string): string[] {
  const m = table?.models?.[scope]
  return m && typeof m === 'object' ? Object.keys(m) : []
}

/**
 * Every model's score for one parameter at one place and season, best first.
 * Entries with no pairs come back with a null metric so callers can see who
 * was tried (every row carries its sample size).
 */
export function modelRanking(param: NetParam, region: string, leadBucket: LeadBucket, season: Season, table: NetworkSkill): RankingRow[] {
  const scope = regionScope(region)
  let models = modelsInScope(table, scope)
  if (models.length === 0) models = modelsInScope(table, scopeAll())
  const out: RankingRow[] = []
  const tried = new Set([...models, ...NETWORK_MODELS])
  for (const model of tried) {
    const cell = cellAt(table, scope, model, param, leadBucket, season)
    const m = rankingMetric(cell, param)
    out.push({ model, metric: m.value, metricName: m.name, higherIsBetter: m.higherIsBetter, n: cell?.n ?? 0, cell })
  }
  out.sort((a, b) => {
    if (a.metric === null && b.metric === null) return b.n - a.n
    if (a.metric === null) return 1
    if (b.metric === null) return -1
    return a.higherIsBetter ? (b.metric as number) - (a.metric as number) : (a.metric as number) - (b.metric as number)
  })
  return out
}

// Deterministic PRNG so the bootstrap is reproducible and testable.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function csiOfPairs(samples: Array<{ p: string; o: string }>, param: NetParam): number | null {
  let hits = 0, misses = 0, falseAlarms = 0
  const isEvent = (b: string): boolean => {
    if (param === 'visBand') return b === '<1km' || b === '1-3km'
    if (param === 'cloudBand') return b === 'overcast'
    if (param === 'ceilingBand') return b === '<300ft' || b === '300-1000ft'
    return b === 'yes'
  }
  for (const s of samples) {
    const pe = isEvent(s.p), oe = isEvent(s.o)
    if (pe && oe) hits++
    else if (!pe && oe) misses++
    else if (pe && !oe) falseAlarms++
  }
  return hits + misses + falseAlarms > 0 ? hits / (hits + misses + falseAlarms) : null
}

function rmseOfSamples(samples: number[]): number | null {
  if (!samples.length) return null
  let s = 0
  for (const e of samples) s += e * e
  return Math.sqrt(s / samples.length)
}

/**
 * Standard deviation of the bootstrap distribution of the difference in the
 * ranking metric between two cells (best minus runner-up, signed so that a
 * positive value means the first cell is better). Null when either cell has
 * too few stored samples to resample.
 */
export function bootstrapDifferenceSd(
  param: NetParam,
  cellA: ContCell | CatCell | null | undefined,
  cellB: ContCell | CatCell | null | undefined,
  iters: number = BOOTSTRAP_ITERS,
  seedText: string = '',
): number | null {
  const a = cellA?.samples ?? []
  const b = cellB?.samples ?? []
  if (a.length < MIN_BOOTSTRAP_SAMPLES || b.length < MIN_BOOTSTRAP_SAMPLES) return null
  const cat = (NET_CAT_PARAMS as readonly string[]).includes(param)
  const rnd = mulberry32(hashSeed(`${param}|${seedText}|${a.length}|${b.length}`))
  const draw = <T>(arr: T[]): T[] => {
    const out: T[] = []
    for (let i = 0; i < arr.length; i++) out.push(arr[Math.floor(rnd() * arr.length)])
    return out
  }
  const diffs: number[] = []
  for (let i = 0; i < iters; i++) {
    if (cat) {
      const sa = draw(a as Array<{ p: string; o: string }>)
      const sb = draw(b as Array<{ p: string; o: string }>)
      const va = csiOfPairs(sa, param)
      const vb = csiOfPairs(sb, param)
      if (va === null || vb === null) continue
      diffs.push(va - vb)
    } else {
      const sa = draw(a as number[])
      const sb = draw(b as number[])
      const va = rmseOfSamples(sa)
      const vb = rmseOfSamples(sb)
      if (va === null || vb === null) continue
      diffs.push(vb - va)
    }
  }
  if (diffs.length < 10) return null
  const mean = diffs.reduce((s, v) => s + v, 0) / diffs.length
  const varr = diffs.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (diffs.length - 1)
  return Math.sqrt(varr)
}

/**
 * The model to use for one parameter / region / lead bucket / season, or the
 * equal-weight blend when the evidence is not strong enough.
 *
 * Returns { model, reason, metric, metricName, n, runnerUp, margin, uncertainty, autoAllowed }.
 * `model` is a model id, or the literal 'blend'.
 */
export function chooseModel(param: NetParam, region: string, leadBucket: LeadBucket, season: Season, table: NetworkSkill): ChooseModelResult {
  const autoAllowed = table?.autoAllowed?.[param] !== false
  const ranking = modelRanking(param, region, leadBucket, season, table)
  const best = ranking.find(r => r.metric !== null) ?? null
  const base = { param, region, leadBucket, season, autoAllowed, metricName: (best?.metricName ?? ((NET_CAT_PARAMS as readonly string[]).includes(param) ? 'csi' : 'rmse')) as 'rmse' | 'csi' }
  if (!autoAllowed) {
    return { ...base, model: 'blend', reason: 'held-out proof did not favour automatic', metric: null, n: 0, runnerUp: null, margin: null, uncertainty: null }
  }
  if (!best) {
    return { ...base, model: 'blend', reason: 'no verified pairs', metric: null, n: 0, runnerUp: null, margin: null, uncertainty: null }
  }
  if (best.n < MIN_PROVEN_PAIRS) {
    return { ...base, model: 'blend', reason: 'not enough evidence', metric: best.metric, n: best.n, runnerUp: null, margin: null, uncertainty: null }
  }
  const runnerUp = ranking.filter(r => r !== best).find(r => r.metric !== null) ?? null
  if (!runnerUp || runnerUp.n < MIN_PROVEN_PAIRS) {
    return { ...base, model: 'blend', reason: 'no proven runner-up', metric: best.metric, n: best.n, runnerUp: runnerUp?.model ?? null, margin: null, uncertainty: null }
  }
  const margin = best.higherIsBetter ? (best.metric! - runnerUp.metric!) : (runnerUp.metric! - best.metric!)
  const uncertainty = bootstrapDifferenceSd(param, best.cell, runnerUp.cell, BOOTSTRAP_ITERS, `${region}|${leadBucket}|${season}`)
  if (uncertainty === null) {
    return { ...base, model: 'blend', reason: 'cannot bootstrap the difference', metric: best.metric, n: best.n, runnerUp: runnerUp.model, margin, uncertainty: null }
  }
  if (!(margin > uncertainty)) {
    return { ...base, model: 'blend', reason: 'difference within bootstrap uncertainty', metric: best.metric, n: best.n, runnerUp: runnerUp.model, margin, uncertainty }
  }
  return { ...base, model: best.model, reason: 'best with margin over bootstrap uncertainty', metric: best.metric, n: best.n, runnerUp: runnerUp.model, margin, uncertainty }
}

// ---- Held-out proof (task part e) ----------------------------------------
// Split the backfilled pairs by time (older 70 % to fit, newest 30 % to
// score) and see whether "automatic best-model" beats the fixed equal-weight
// blend and the single best global model. If it does not for a parameter,
// autoAllowed[param] is false and automatic mode falls back to the blend.

export const HELD_OUT_TRAIN_SHARE = 0.7

// Worst-first band order, used to break ties in a categorical vote toward the
// safer (worse-weather) band. ASSUMED.
export function worseFirstBands(param: NetCatParam): string[] {
  if (param === 'visBand') return ['<1km', '1-3km', '3-5km', '5-8km', '>8km']
  if (param === 'cloudBand') return ['overcast', 'broken', 'scattered', 'few', 'clear']
  if (param === 'ceilingBand') return ['<300ft', '300-1000ft', '1000-3000ft', '>3000ft', 'none']
  return ['yes', 'no']
}

function blendValue(values: unknown[], param: NetParam): string | number | null {
  const nums = values.filter(finite)
  if ((NET_CAT_PARAMS as readonly string[]).includes(param)) {
    const votes = new Map<string, number>()
    for (const v of values) if (typeof v === 'string') votes.set(v, (votes.get(v) ?? 0) + 1)
    if (votes.size === 0) return null
    let best: { band: string; n: number } | null = null
    for (const band of worseFirstBands(param as NetCatParam)) {
      const n = votes.get(band) ?? 0
      if (n > 0 && (best === null || n > best.n)) best = { band, n }
    }
    return best?.band ?? null
  }
  if (nums.length === 0) return null
  return nums.reduce((s, v) => s + v, 0) / nums.length
}

function errOf(param: NetParam, obs: unknown, v: unknown): number | null {
  if ((NET_CAT_PARAMS as readonly string[]).includes(param)) return obs === v ? 0 : 1
  if (!finite(obs) || !finite(v)) return null
  return param === 'windDirDeg' ? wrapDeg(obs - v) : obs - v
}

/**
 * Score the three strategies on the newest 30 % of pairs, fitting the skill
 * table (and the global best model) on the older 70 %.
 *
 * pairs: [{ tMs, station, region, season, bucket, obs: {param: value}, fcst: {model: {param: value}} }]
 * Returns { params: { param: { autoAllowed, overall: {...}, byRegion: {...} } }, autoAllowed, trainCutMs, counts }.
 */
export function evaluateHeldOut(pairs: NetworkPair[], { trainShare = HELD_OUT_TRAIN_SHARE }: { trainShare?: number } = {}): HeldOutReport {
  const sorted = [...pairs].sort((a, b) => a.tMs - b.tMs)
  const cutIdx = Math.floor(sorted.length * trainShare)
  const train = sorted.slice(0, cutIdx)
  const test = sorted.slice(cutIdx)
  const trainCutMs = cutIdx > 0 ? sorted[cutIdx - 1].tMs : 0

  const fitTable = emptyNetworkSkill()
  for (const p of train) foldPairIntoSkill(fitTable, p)

  const contParamsForEval: NetContParam[] = ['tempC', 'dewC', 'qnhHpa', 'windKts', 'windDirDeg', 'gustKts']

  // Single best global model per parameter, fitted on the training half only.
  const bestGlobal: Record<string, string | null> = {}
  for (const param of [...NET_CAT_PARAMS, ...contParamsForEval]) {
    // A global pick spans regions and buckets: rank on the 'all' scope with
    // every bucket/season cell pooled together.
    const totals = new Map<string, { model: string; metric: number | null; n: number }>()
    for (const model of NETWORK_MODELS) {
      let n = 0, num = 0, den = 0
      for (const bucket of LEAD_BUCKETS) {
        for (const season of SEASONS) {
          const cell = fitTable.models?.all?.[model]?.[param]?.[bucket]?.[season]
          if (!cell?.n) continue
          n += cell.n
          if ((NET_CAT_PARAMS as readonly string[]).includes(param)) {
            const catCell = cell as CatCell
            num += catCell.hits
            den += catCell.hits + catCell.misses + catCell.falseAlarms
          } else {
            const contCell = cell as ContCell
            num += contCell.mse * contCell.n
            den += contCell.n
          }
        }
      }
      if (n === 0) continue
      const metric = (NET_CAT_PARAMS as readonly string[]).includes(param) ? (den > 0 ? num / den : null) : (den > 0 ? Math.sqrt(num / den) : null)
      totals.set(model, { model, metric, n })
    }
    const list = [...totals.values()].filter(x => x.metric !== null)
    const higher = (NET_CAT_PARAMS as readonly string[]).includes(param)
    list.sort((a, b) => (higher ? (b.metric! - a.metric!) : (a.metric! - b.metric!)))
    bestGlobal[param] = list[0]?.model ?? null
  }

  const params: Record<string, HeldOutParamReport> = {}
  const autoAllowed: Partial<Record<NetParam, boolean>> = {}
  for (const param of [...contParamsForEval, ...NET_CAT_PARAMS]) {
    const cat = (NET_CAT_PARAMS as readonly string[]).includes(param)
    // Strategy -> region -> errors (continuous) or {p, o} pairs (categorical).
    const collect: {
      auto: Record<string, any[]>
      blend: Record<string, any[]>
      bestGlobal: Record<string, any[]>
    } = { auto: {}, blend: {}, bestGlobal: {} }
    const push = (strat: 'auto' | 'blend' | 'bestGlobal', region: string, o: unknown, v: unknown): void => {
      if (v === null || v === undefined) return
      if (cat) {
        if (typeof v !== 'string' || typeof o !== 'string') return
        const r = (collect[strat][region] ??= [])
        r.push({ p: v, o })
        return
      }
      const e = errOf(param, o, v)
      if (e === null) return
      const r = (collect[strat][region] ??= [])
      r.push(e)
    }
    for (const pair of test) {
      const o = pair.obs?.[param]
      if (o === null || o === undefined) continue
      const models = Object.keys(pair.fcst ?? {})
      const available = models.filter(m => pair.fcst[m]?.[param] !== null && pair.fcst[m]?.[param] !== undefined)
      if (available.length === 0) continue
      const choice = chooseModel(param, pair.region, pair.bucket, pair.season, fitTable)
      const autoPick = choice.model !== 'blend' && available.includes(choice.model) ? pair.fcst[choice.model][param] : null
      push('auto', pair.region, o, autoPick ?? blendValue(available.map(m => pair.fcst[m][param]), param))
      push('blend', pair.region, o, blendValue(available.map(m => pair.fcst[m][param]), param))
      const g = bestGlobal[param]
      push('bestGlobal', pair.region, o, g && available.includes(g) ? pair.fcst[g][param] : blendValue(available.map(m => pair.fcst[m][param]), param))
    }
    const score = (arr: any[]): StrategyScore => {
      if (!arr || arr.length === 0) return { n: 0, rmse: null, csi: null }
      if (cat) {
        let hits = 0, misses = 0, falseAlarms = 0
        for (const s of arr) {
          const pe = isPrimaryEvent(param as NetCatParam, s.p), oe = isPrimaryEvent(param as NetCatParam, s.o)
          if (pe && oe) hits++
          else if (!pe && oe) misses++
          else if (pe && !oe) falseAlarms++
        }
        const den = hits + misses + falseAlarms
        return { n: arr.length, rmse: null, csi: den > 0 ? hits / den : null }
      }
      let s = 0
      for (const e of arr) s += e * e
      return { n: arr.length, rmse: Math.sqrt(s / arr.length), csi: null }
    }
    const byRegion: Record<string, Record<'auto' | 'blend' | 'bestGlobal', StrategyScore>> = {}
    const regions = new Set([...Object.keys(collect.auto), ...Object.keys(collect.blend), ...Object.keys(collect.bestGlobal)])
    for (const region of regions) {
      byRegion[region] = {
        auto: score(collect.auto[region]),
        blend: score(collect.blend[region]),
        bestGlobal: score(collect.bestGlobal[region]),
      }
    }
    const overall: Record<'auto' | 'blend' | 'bestGlobal', StrategyScore> = {
      auto: score(Object.values(collect.auto).flat()),
      blend: score(Object.values(collect.blend).flat()),
      bestGlobal: score(Object.values(collect.bestGlobal).flat()),
    }
    const better = (a: StrategyScore, b: StrategyScore): boolean => {
      if (cat) {
        if (a.csi === null || b.csi === null) return false
        return a.csi > b.csi
      }
      if (a.rmse === null || b.rmse === null) return false
      return a.rmse < b.rmse
    }
    // Automatic mode is allowed only if it beats BOTH alternatives overall.
    const ok = better(overall.auto, overall.blend) && better(overall.auto, overall.bestGlobal)
    autoAllowed[param] = ok
    params[param] = {
      autoAllowed: ok,
      metric: cat ? 'csi' : 'rmse',
      bestGlobalModel: bestGlobal[param],
      overall,
      byRegion,
    }
  }
  return { params, autoAllowed, trainCutMs, trainPairs: train.length, testPairs: test.length }
}

function isPrimaryEvent(param: NetCatParam, band: string): boolean {
  if (param === 'visBand') return band === '<1km' || band === '1-3km'
  if (param === 'cloudBand') return band === 'overcast'
  if (param === 'ceilingBand') return band === '<300ft' || band === '300-1000ft'
  return band === 'yes'
}
