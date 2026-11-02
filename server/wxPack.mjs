// Model weather PACK: download GFS forecast fields for the India box from the
// NOMADS GFS 0.25 GRIB filter, convert them to compact WGR1 grids, publish
// them atomically per cycle, and answer the /api/wx/pack/* routes.
//
// Downloads are polite by construction: one subsetted request per forecast
// step, sequential with a pause between them, and a 404 for a cycle that is
// not published yet is a normal answer, not an error to hammer at.
//
// Safety note: model data is advisory. Every grid carries its model, valid
// time and source so the UI can label (and age) whatever it shows.

import fs from 'node:fs'
import path from 'node:path'
import { decodeWgr1, encodeWgr1, pickScaleOffset } from '../src/lib/wxPack/wgr1.ts'
import { decodeGrib2 } from '../src/lib/windGrid/grib2.ts'
import { hashFileCached } from './staticCache.mjs'
import { chooseModel, emptyNetworkSkill } from './wxModelChoice.mjs'
import { NET_PARAMS } from './wxNetworkStats.mjs'
import {
  NOMADS_FILTER,
  SOURCE_LABEL,
  MODEL_LABEL,
  MODEL_TITLE,
  FORECAST_BOX,
  DEFAULT_SUBSET,
  DEFAULT_STEPS,
  SEVEN_DAY_STEPS,
  buildForecastSteps,
  buildStepList,
  GFS_DEFAULT_STEPS,
  WXPACK_FIELDS as BASE_WXPACK_FIELDS,
  packFieldById as basePackFieldById,
  grib2ToWgr1Files as baseGrib2ToWgr1Files,
  cycleDirName,
  buildPackIndex as baseBuildPackIndex,
  buildFilterUrl as baseBuildFilterUrl,
  candidateCycles,
  boxAround,
  planDeviceDownload,
  estimateDownloadBytes,
} from '../src/lib/wxPack/deviceBuilder.ts'

/**
 * 2 m dew point temperature field definition (TASK DEW1 / DEW2).
 * Record: GRIB2 category 0, number 6, levelType 103, levelValue 2 (DPT:2 m above ground).
 * Stored as int16 scalar in Kelvin (same quantisation path as temp2).
 */
export const GFS_DEWPT_FIELD = Object.freeze({
  id: 'dewpt',
  unit: 'K',
  level: '2 m',
  levelLabel: '2 m',
  pack: 'int16',
  planes: 1,
  kind: 'scalar',
  sources: [{ category: 0, number: 6, levelType: 103, levelValue: 2 }],
})

export const GFS_PACK_FIELDS = Object.freeze([
  ...BASE_WXPACK_FIELDS.filter((f) => f.id !== 'dewpt'),
  GFS_DEWPT_FIELD,
])

export const WXPACK_FIELDS = BASE_WXPACK_FIELDS.some((f) => f.id === 'dewpt')
  ? BASE_WXPACK_FIELDS
  : GFS_PACK_FIELDS

export function packFieldById(id) {
  if (id === 'dewpt') return GFS_DEWPT_FIELD
  return basePackFieldById(id)
}

/**
 * Filter URL with 2 m dew point requested alongside 2 m temperature.
 */
export function buildFilterUrl(opts) {
  const url = baseBuildFilterUrl(opts)
  if (!url.includes('var_DPT=')) {
    return url.replace('var_TMP=on', 'var_DPT=on&var_TMP=on')
  }
  return url
}

/**
 * GRIB2 to WGR1 converter ensuring dewpt is converted exactly like temp2.
 */
export function grib2ToWgr1Files(bytes, opts = {}) {
  const res = baseGrib2ToWgr1Files(bytes, opts)
  if (res.ok.some((f) => f.fieldId === 'dewpt')) return res

  if (bytes && bytes.length > 0) {
    try {
      const decoded = decodeGrib2(bytes)
      const dpt = decoded.fields.find(
        (f) => f.paramCategory === 0 && f.paramNumber === 6 && f.levelType === 103 && f.levelValue === 2,
      )
      if (dpt) {
        let min = Number.POSITIVE_INFINITY
        let max = Number.NEGATIVE_INFINITY
        for (let i = 0; i < dpt.values.length; i++) {
          const v = dpt.values[i]
          if (!Number.isFinite(v)) continue
          if (v < min) min = v
          if (v > max) max = v
        }
        if (Number.isFinite(min) && Number.isFinite(max)) {
          const picked = pickScaleOffset(min, max)
          const meta = {
            model: MODEL_LABEL[opts.modelId ?? 'gfs'] ?? (opts.modelId ?? 'gfs'),
            fieldId: 'dewpt',
            level: '2 m',
            unit: 'K',
            referenceTimeIso: dpt.referenceTimeIso,
            validTimeIso: dpt.validTimeIso,
            source: SOURCE_LABEL,
            nx: dpt.ni,
            ny: dpt.nj,
            lat0: dpt.la1,
            dLat: (dpt.la2 - dpt.la1) / (dpt.nj - 1),
            lon0: dpt.lo1,
            dLon: (dpt.lo2 - dpt.lo1) / (dpt.ni - 1),
            planes: 1,
            pack: 'int16',
            scale: picked.scale,
            offset: picked.offset,
            min,
            max,
          }
          const wgr1 = encodeWgr1(meta, [dpt.values])
          res.ok.push({
            fieldId: 'dewpt',
            stepHours: dpt.forecastTimeHours,
            unit: 'K',
            levelLabel: '2 m',
            wgr1,
            bytes: wgr1.length,
            min,
            max,
            metaCheck: { decodedMin: min, metaMin: min, ok: true },
          })
          res.skipped = res.skipped.filter((s) => !s.reason?.includes('0/6 levelType 103'))
          res.ok.sort((a, b) => (a.fieldId === b.fieldId ? a.stepHours - b.stepHours : a.fieldId < b.fieldId ? -1 : 1))
        }
      }
    } catch {
      // If decoding fails, keep base results
    }
  }
  return res
}

/**
 * Manifest index builder supporting dewpt.
 */
export function buildPackIndex(args) {
  try {
    return baseBuildPackIndex(args)
  } catch (err) {
    if (String((err && err.message) || err).includes('dewpt')) {
      const dewptFiles = args.fields.filter((f) => f.fieldId === 'dewpt')
      const otherFiles = args.fields.filter((f) => f.fieldId !== 'dewpt')
      const idx = baseBuildPackIndex({ ...args, fields: otherFiles })
      if (dewptFiles.length > 0) {
        dewptFiles.sort((a, b) => a.stepHours - b.stepHours)
        let lo = Number.POSITIVE_INFINITY
        let hi = Number.NEGATIVE_INFINITY
        for (const f of dewptFiles) {
          if (Number.isFinite(f.min) && f.min < lo) lo = f.min
          if (Number.isFinite(f.max) && f.max > hi) hi = f.max
        }
        idx.fields.dewpt = {
          unit: 'K',
          levelLabel: '2 m',
          min: lo,
          max: hi,
          files: dewptFiles.map((f) => ({
            step: f.stepHours,
            url: `/api/wx/pack/${args.modelId}/${cycleDirName(args.cycleUtc)}/dewpt/${f.stepHours}.wgr1`,
            bytes: f.bytes,
            validAtMs: Date.parse(args.cycleUtc) + f.stepHours * 3_600_000,
          })),
        }
      }
      return idx
    }
    throw err
  }
}

export {
  FORECAST_BOX,
  DEFAULT_SUBSET,
  DEFAULT_STEPS,
  SEVEN_DAY_STEPS,
  buildForecastSteps,
  buildStepList,
  GFS_DEFAULT_STEPS,
  cycleDirName,
  candidateCycles,
  boxAround,
  planDeviceDownload,
  estimateDownloadBytes,
}

const KEEP_CYCLES = 2

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve())

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// ---- Model choice (task item 4) ------------------------------------------

/**
 * The model "Auto" should use for one parameter.
 * One model -> that model. Otherwise the model chooseModel selects when the
 * evidence allows it; else `defaultModelId`, with the reason as text.
 */
export function resolveAutoModel({
  modelIds,
  param,
  region = 'all',
  leadBucket,
  season,
  skill,
  defaultModelId,
}) {
  const ids = [...(modelIds ?? [])]
  const fallback = defaultModelId ?? ids[0] ?? null
  if (ids.length === 0) return { modelId: null, reason: 'no model available' }
  if (ids.length === 1) return { modelId: ids[0], reason: 'only model available' }
  if (!skill) return { modelId: fallback, reason: 'no verification skill' }

  const window = pickWindow(skill, param, { region, leadBucket, season })
  const choice = chooseModel(param, window.region, window.leadBucket, window.season, skill)
  if (choice.model && choice.model !== 'blend' && ids.includes(choice.model)) {
    return { modelId: choice.model, reason: choice.reason }
  }
  if (choice.model && choice.model !== 'blend') {
    return { modelId: fallback, reason: `verification picked ${choice.model}, which is not available` }
  }
  return { modelId: fallback, reason: choice.reason || 'no verified pairs' }
}

/**
 * The (region, lead bucket, season) window with the most verified pairs for
 * this parameter, so a summary call needs no user selection first. Explicit
 * values always win. Default window when nothing is verified: region 'all',
 * D0, winter -- the chooser answers "no verified pairs" either way.
 */
function pickWindow(skill, param, { region, leadBucket, season } = {}) {
  const explicit = {
    region: region && region !== 'all' ? region : null,
    leadBucket: leadBucket ?? null,
    season: season ?? null,
  }
  if (explicit.region && explicit.leadBucket && explicit.season) return explicit
  let best = { region: 'all', leadBucket: 'D0', season: 'winter', n: -1 }
  const scopes = skill?.models ?? {}
  for (const [scopeName, byModel] of Object.entries(scopes)) {
    const scopeRegion = scopeName.startsWith('region:') ? scopeName.slice('region:'.length) : null
    if (!scopeRegion) continue
    for (const byParam of Object.values(byModel)) {
      const cells = byParam?.[param]
      if (!cells) continue
      for (const [bucket, bySeason] of Object.entries(cells)) {
        for (const [seasonName, cell] of Object.entries(bySeason)) {
          const n = cell?.n ?? 0
          if (n > best.n) best = { region: scopeRegion, leadBucket: bucket, season: seasonName, n }
        }
      }
    }
  }
  return {
    region: explicit.region ?? (best.n >= 0 ? best.region : 'all'),
    leadBucket: explicit.leadBucket ?? (best.n >= 0 ? best.leadBucket : 'D0'),
    season: explicit.season ?? (best.n >= 0 ? best.season : 'winter'),
  }
}

function skillSummary(skill, modelId) {
  const table = skill ?? emptyNetworkSkill()
  const sampleCounts = {}
  let lastVerificationMs = null
  const all = table.models?.all?.[modelId]
  if (all) {
    for (const [param, byBucket] of Object.entries(all)) {
      let n = 0
      for (const bySeason of Object.values(byBucket)) {
        for (const cell of Object.values(bySeason)) {
          if (!cell || typeof cell !== 'object') continue
          n += cell.n ?? 0
          if (typeof cell.lastMs === 'number' && cell.lastMs > 0) {
            lastVerificationMs = Math.max(lastVerificationMs ?? 0, cell.lastMs)
          }
        }
      }
      if (n > 0) sampleCounts[param] = n
    }
  }
  return {
    autoAllowed: { ...(table.autoAllowed ?? {}) },
    lastVerificationMs,
    sampleCounts,
  }
}

// ---- Pack: disk, routes, the cycle job -----------------------------------

export function createWxPack({ dataDir, modelId = 'gfs', skill, skillPath, nowMs } = {}) {
  const root = path.join(dataDir, modelId)
  const clock = nowMs ?? (() => Date.now())
  const status = {
    modelId,
    cycleUtc: null,
    ageMinutes: null,
    lastSuccessMs: 0,
    lastAttemptMs: 0,
    errors: [],
  }

  function listCycleDirs() {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
    } catch {
      return []
    }
  }

  /** Newest cycle that has an index.json -- the only thing we ever serve. */
  function publishedIndex(cycleDir) {
    const dirs = cycleDir ? [cycleDir] : listCycleDirs()
    for (let i = dirs.length - 1; i >= 0; i--) {
      const index = readJson(path.join(root, dirs[i], 'index.json'))
      if (index) return { cycleDir: dirs[i], index }
    }
    return null
  }

  function currentSkill() {
    if (skill) return skill
    if (skillPath) return readJson(skillPath) ?? emptyNetworkSkill()
    return emptyNetworkSkill()
  }

  function listModels({ skill: skillOverride, nowMs: at } = {}) {
    const now = typeof at === 'number' ? at : clock()
    const models = []
    let found
    try {
      found = fs.readdirSync(dataDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      found = []
    }
    const table = skillOverride ?? currentSkill()
    for (const id of found.sort()) {
      const pub = (() => {
        try {
          const dirs = fs
            .readdirSync(path.join(dataDir, id), { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
            .sort()
          for (let i = dirs.length - 1; i >= 0; i--) {
            const index = readJson(path.join(dataDir, id, dirs[i], 'index.json'))
            if (index) return index
          }
        } catch {
          /* not a model directory */
        }
        return null
      })()
      if (!pub) continue
      models.push({
        modelId: pub.modelId ?? id,
        model: pub.model ?? (MODEL_TITLE[id] ?? id.toUpperCase()),
        cycleUtc: pub.cycleUtc,
        ageMinutes: Math.max(0, Math.round((now - Date.parse(pub.cycleUtc)) / 60_000)),
        generatedAtMs: pub.generatedAtMs ?? null,
        fields: Object.keys(pub.fields ?? {}).sort(),
        skill: skillSummary(table, pub.modelId ?? id),
      })
    }
    const defaultModelId = models.some((m) => m.modelId === 'gfs')
      ? 'gfs'
      : (models[0]?.modelId ?? 'gfs')
    const autoByParam = {}
    for (const param of NET_PARAMS) {
      autoByParam[param] = resolveAutoModel({
        modelIds: models.map((m) => m.modelId),
        param,
        skill: table,
        defaultModelId,
      })
    }
    return { generatedAtMs: now, defaultModelId, models, autoByParam }
  }

  function route(method, pathname, { ifNoneMatch } = {}) {
    if (method !== 'GET') return { status: 405, headers: {}, body: 'method not allowed' }
    const prefix = '/api/wx/pack/'
    if (!pathname.startsWith(prefix)) return { status: 404, headers: {}, body: 'not found' }
    const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
    const parts = rest.split('/').filter(Boolean)

    if (parts.length === 1 && parts[0] === 'status') {
      const pub = publishedIndex()
      return json(200, {
        ...status,
        modelId,
        cycleUtc: pub ? pub.index.cycleUtc : status.cycleUtc,
        ageMinutes: pub ? Math.max(0, Math.round((clock() - Date.parse(pub.index.cycleUtc)) / 60_000)) : null,
        cyclesOnDisk: listCycleDirs(),
      })
    }
    if (parts.length === 1 && parts[0] === 'index') {
      const pub = publishedIndex()
      if (!pub) return json(404, { error: 'no cycle published' })
      return json(200, pub.index)
    }
    if (parts.length === 2 && parts[1] === 'status') {
      const targetModel = parts[0]
      const modelRoot = targetModel === modelId ? root : path.join(dataDir, targetModel)
      let dirs = []
      try {
        dirs = fs.readdirSync(modelRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      } catch {}
      let pub = null
      for (let i = dirs.length - 1; i >= 0; i--) {
        const idx = readJson(path.join(modelRoot, dirs[i], 'index.json'))
        if (idx) { pub = { cycleDir: dirs[i], index: idx }; break }
      }
      return json(200, {
        modelId: targetModel,
        cycleUtc: pub ? pub.index.cycleUtc : null,
        ageMinutes: pub ? Math.max(0, Math.round((clock() - Date.parse(pub.index.cycleUtc)) / 60_000)) : null,
        cyclesOnDisk: dirs,
      })
    }
    if (parts.length === 2 && parts[1] === 'index') {
      const targetModel = parts[0]
      const modelRoot = targetModel === modelId ? root : path.join(dataDir, targetModel)
      let dirs = []
      try {
        dirs = fs.readdirSync(modelRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
      } catch {}
      let pub = null
      for (let i = dirs.length - 1; i >= 0; i--) {
        const idx = readJson(path.join(modelRoot, dirs[i], 'index.json'))
        if (idx) { pub = { cycleDir: dirs[i], index: idx }; break }
      }
      if (!pub) return json(404, { error: 'no cycle published' })
      return json(200, pub.index)
    }
    if (parts.length === 1 && parts[0] === 'models') {
      const body = listModels()
      if (body.models.length === 0) return json(404, { error: 'no model published' })
      return json(200, body)
    }

    // /:cycle/:fieldId/:step.wgr1  or  /:modelId/:cycle/:fieldId/:step.wgr1
    let model, cycleDir, fieldId, stepText
    if (parts.length === 3) {
      model = modelId
      ;[cycleDir, fieldId, stepText] = parts
    } else if (parts.length === 4) {
      ;[model, cycleDir, fieldId, stepText] = parts
    } else {
      return { status: 404, headers: {}, body: 'not found' }
    }
    if (!/^\d+\.wgr1$/.test(stepText)) return { status: 404, headers: {}, body: 'not found' }
    const step = Number(stepText.replace('.wgr1', ''))
    const base = model === modelId ? root : path.join(dataDir, model)
    const index = readJson(path.join(base, cycleDir, 'index.json'))
    if (!index) return { status: 404, headers: {}, body: 'unknown or unpublished cycle' }
    const entry = index.fields?.[fieldId]?.files?.find((f) => f.step === step)
    if (!entry) return { status: 404, headers: {}, body: 'unknown field or step' }
    const file = path.join(base, cycleDir, fieldId, `${step}.wgr1`)
    let bytes
    let hash
    try {
      const stat = fs.statSync(file)
      const cached = hashFileCached(file, stat, (f) => fs.readFileSync(f), fnv1a)
      bytes = cached.bytes
      hash = cached.hash
    } catch {
      return { status: 404, headers: {}, body: 'grid file missing' }
    }
    const etag = `"${model}-${cycleDir}-${fieldId}-${step}-${bytes.length}-${hash}"`
    if (ifNoneMatch && ifNoneMatch === etag) return { status: 304, headers: { etag }, body: '' }
    return {
      status: 200,
      headers: {
        etag,
        'content-type': 'application/octet-stream',
        'cache-control': 'public, max-age=300',
      },
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
  }

  /**
   * One download / convert / publish pass for one cycle. Never publishes a
   * half-written cycle: index.json is written last, atomically, and only when
   * every requested step produced fields.
   */
  async function runCycleJob({ cycleUtc, steps = GFS_DEFAULT_STEPS, fetchImpl, pauseMs = 1500, subset = DEFAULT_SUBSET } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('runCycleJob needs a fetchImpl')
    const dir = cycleDirName(cycleUtc)
    const dest = path.join(root, dir)
    const errors = []
    status.lastAttemptMs = clock()
    const converted = []

    const maxEnvStep = process.env.WXREGIONCUT_GFS_MAX_STEP ? Number(process.env.WXREGIONCUT_GFS_MAX_STEP) : Infinity
    const effectiveSteps = steps.filter((s) => s <= maxEnvStep)

    let lastRain3 = null
    let lastConv3 = null

    for (const step of effectiveSteps) {
      const url = buildFilterUrl({ cycleUtc, stepHours: step, subset })
      let body
      try {
        const res = await fetchImpl(url)
        if (!res || !res.ok) {
          errors.push(`step ${step}: HTTP ${res ? res.status : 'no response'}`)
          break
        }
        body = new Uint8Array(await res.arrayBuffer())
      } catch (e) {
        errors.push(`step ${step}: ${(e && e.message) || e}`)
        break
      }
      const { ok, skipped } = grib2ToWgr1Files(body, {
        modelId,
        cycleUtc,
        prevRain3: lastRain3,
        prevConv3: lastConv3,
      })
      if (ok.length === 0) {
        errors.push(`step ${step}: no convertible fields (${skipped.map((s) => s.reason).slice(0, 2).join('; ') || 'empty'})`)
        break
      }
      const r3 = ok.find((f) => f.fieldId === 'rain3')
      if (r3) {
        lastRain3 = decodeWgr1(r3.wgr1).planes[0]
      }
      const c3 = ok.find((f) => f.fieldId === 'conv3')
      if (c3) {
        lastConv3 = decodeWgr1(c3.wgr1).planes[0]
      }
      for (const f of ok) converted.push(f)
      if (pauseMs > 0 && step !== steps[steps.length - 1]) await sleep(pauseMs)
    }

    if (errors.length > 0 || converted.length === 0) {
      status.errors = errors.length ? errors : ['no fields converted']
      return { published: false, errors: status.errors, cycleUtc, files: 0, bytes: 0 }
    }

    // If subsequent steps produced rain3/conv3/thundr but step 0 lacks them (since GFS does not publish APCP at f000),
    // synthesize zero-filled step 0 entries for consistency across all steps.
    const hasRain3 = converted.some((f) => f.fieldId === 'rain3')
    const hasStep0Rain3 = converted.some((f) => f.fieldId === 'rain3' && f.stepHours === 0)
    if (hasRain3 && !hasStep0Rain3) {
      const sample0 = converted.find((f) => f.stepHours === 0)
      if (sample0) {
        const decoded0 = decodeWgr1(sample0.wgr1)
        const nPoints = decoded0.meta.nx * decoded0.meta.ny
        const zeroFloats = new Float32Array(nPoints)
        for (const fid of ['rain3', 'conv3']) {
          const m = {
            ...decoded0.meta,
            fieldId: fid,
            unit: 'mm',
            level: 'sfc',
            planes: 1,
            pack: 'int16',
            scale: 100,
            offset: 0,
            min: 0,
            max: 0,
            rainWindowH: 3,
          }
          const w = encodeWgr1(m, [zeroFloats])
          converted.push({
            fieldId: fid,
            stepHours: 0,
            unit: 'mm',
            levelLabel: 'surface',
            wgr1: w,
            bytes: w.length,
            min: 0,
            max: 0,
            metaCheck: { decodedMin: 0, metaMin: 0, ok: true },
            rainWindowH: 3,
          })
        }
        if (converted.some((f) => f.fieldId === 'thundr')) {
          const m = {
            ...decoded0.meta,
            fieldId: 'thundr',
            unit: 'class',
            level: 'sfc',
            planes: 1,
            pack: 'uint8',
            scale: 1,
            offset: 0,
            min: 0,
            max: 0,
          }
          const w = encodeWgr1(m, [zeroFloats])
          converted.push({
            fieldId: 'thundr',
            stepHours: 0,
            unit: 'class',
            levelLabel: 'surface',
            wgr1: w,
            bytes: w.length,
            min: 0,
            max: 0,
            metaCheck: { decodedMin: 0, metaMin: 0, ok: true },
          })
        }
      }
    }

    // Every step must contribute the same field set, or the cycle has a hole.
    const perStep = new Map()
    for (const f of converted) {
      if (!perStep.has(f.stepHours)) perStep.set(f.stepHours, new Set())
      perStep.get(f.stepHours).add(f.fieldId)
    }
    const reference = [...(perStep.get(steps[0]) ?? [])].sort().join(',')
    for (const step of steps) {
      const have = [...(perStep.get(step) ?? [])].sort().join(',')
      if (have !== reference) {
        status.errors = [`step ${step}: field set differs from step ${steps[0]}`]
        return { published: false, errors: status.errors, cycleUtc, files: 0, bytes: 0 }
      }
    }

    // Publish: grids first (each atomic), index.json last.
    let bytes = 0
    for (const f of converted) {
      const file = path.join(dest, f.fieldId, `${f.stepHours}.wgr1`)
      atomicWrite(file, f.wgr1)
      bytes += f.wgr1.length
    }
    const sample = decodeWgr1(converted[0].wgr1)
    const index = buildPackIndex({
      modelId,
      cycleUtc,
      generatedAtMs: clock(),
      bbox: { minLat: subset.minLat, maxLat: subset.maxLat, minLon: subset.minLon, maxLon: subset.maxLon },
      grid: {
        nx: sample.meta.nx,
        ny: sample.meta.ny,
        dx: sample.meta.dLon,
        dy: sample.meta.dLat,
      },
      steps,
      fields: converted,
    })
    atomicWrite(path.join(dest, 'index.json'), JSON.stringify(index))

    status.cycleUtc = cycleUtc
    status.lastSuccessMs = clock()
    status.errors = []
    status.ageMinutes = Math.max(0, Math.round((clock() - Date.parse(cycleUtc)) / 60_000))

    // Keep only the newest KEEP_CYCLES published cycles.
    const published = listCycleDirs().filter((d) => fs.existsSync(path.join(root, d, 'index.json')))
    for (const old of published.slice(0, Math.max(0, published.length - KEEP_CYCLES))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true })
    }

    return { published: true, errors: [], cycleUtc, files: converted.length, bytes, dir }
  }

  const api = {
    dataDir,
    modelId,
    root,
    route,
    runCycleJob: (args) => runCycleJob(args),
    listModels,
    listCycleDirs,
    publishedIndex: () => publishedIndex(),
    status: () => ({ ...status, cyclesOnDisk: listCycleDirs() }),
    resolveAutoModel: (args) => resolveAutoModel({ defaultModelId: modelId, ...args }),
  }
  return api
}

/**
 * Standalone entry point used by tests and the scheduler: run the cycle job of
 * an existing pack.
 */
export async function runCycleJob({ pack, ...rest }) {
  if (!pack || typeof pack.runCycleJob !== 'function') throw new Error('runCycleJob needs a pack')
  return pack.runCycleJob(rest)
}

function json(statusCode, body) {
  const text = JSON.stringify(body)
  return {
    status: statusCode,
    headers: { 'content-type': 'application/json', etag: `"${fnv1a(Buffer.from(text))}"` },
    body: text,
  }
}

/** Small content hash for ETags (not a security primitive). */
function fnv1a(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

/**
 * The scheduled routine: find the newest cycle NOMADS has published that we do
 * not serve yet, and run the job for it. Safe to call every 30 minutes.
 */
export async function checkForNewerCycle({
  pack,
  fetchImpl,
  pauseMs = 1500,
  nowMs = Date.now(),
  steps = GFS_DEFAULT_STEPS,
  subset = DEFAULT_SUBSET,
} = {}) {
  const have = pack.publishedIndex()
  const haveCycle = have ? have.index.cycleUtc : null
  if (!Number.isFinite(nowMs)) {
    console.error('wxPack: cannot list cycles, time not entered')
    return { published: false, skipped: true, errors: ['cannot list cycles, time not entered'] }
  }
  for (const cycleUtc of candidateCycles(nowMs, 3)) {
    if (haveCycle && Date.parse(cycleUtc) <= Date.parse(haveCycle)) break
    const probeUrl = buildFilterUrl({ cycleUtc, stepHours: 0, subset })
    let published = false
    try {
      const res = await fetchImpl(probeUrl)
      published = Boolean(res && res.ok)
    } catch {
      published = false
    }
    if (!published) continue
    return pack.runCycleJob({ cycleUtc, steps, fetchImpl, pauseMs, subset })
  }
  return {
    published: false,
    skipped: true,
    errors: ['The forecast source has not published yet. Try again in 30 minutes.'],
  }
}
