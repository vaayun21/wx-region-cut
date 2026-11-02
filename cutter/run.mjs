// Command-line entry for one cutter run:
//   node cutter/run.mjs --model ecmwf|icon --out ./out [--cycle auto|<ISO>] [--dry-run]
//
// The heavy build is the laptop's own cycle builder, given a temporary data
// folder. This file only chooses the cycle, runs that builder, packages the
// result and checks it. Every network call goes through an injectable fetch so
// tests never touch the real network.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWxPack } from '../server/wxPack.mjs'
import {
  refreshCycle,
  ECMWF_DEFAULT_MAX_STEP,
  ECMWF_MAX_AVAILABLE_STEP,
} from '../server/wxPackEcmwf.mjs'
import { createWxPackIcon } from '../server/wxPackIcon.mjs'
import { getCandidateCycles } from '../src/lib/wxPack/ecmwfPack.ts'
import { candidateIconCycles, ICON_DEFAULT_STEPS } from '../src/lib/wxPack/iconPack.ts'
import { buildIconUrls, fetchIconWithFallback } from '../src/lib/wxPack/iconUrls.ts'
import { buildForecastSteps } from '../server/wxPack.mjs'
import { packageCycle, verifyPackage } from './package-cycle.mjs'
import { ECMWF_MODEL_TITLE, ICON_MODEL_TITLE, ecmwfAttribution, DWD_ATTRIBUTION } from './attribution.mjs'

const ECMWF_BASE = 'https://data.ecmwf.int/forecasts'

const MODELS = {
  ecmwf: {
    title: ECMWF_MODEL_TITLE,
    attribution: () => ecmwfAttribution(),
  },
  icon: {
    title: ICON_MODEL_TITLE,
    attribution: () => DWD_ATTRIBUTION,
  },
}

export function tagForCycle(modelId, cycleUtc) {
  const ms = Date.parse(cycleUtc)
  if (!Number.isFinite(ms)) throw new Error(`not a cycle time: ${cycleUtc}`)
  const d = new Date(ms)
  const yyyy = String(d.getUTCFullYear())
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  return `${modelId}-${yyyy}${mm}${dd}T${hh}Z`
}

function effectiveMaxStep() {
  const envMax = process.env.WXREGIONCUT_ECMWF_MAX_STEP
    ? parseInt(process.env.WXREGIONCUT_ECMWF_MAX_STEP, 10)
    : ECMWF_DEFAULT_MAX_STEP
  return Math.min(envMax, ECMWF_MAX_AVAILABLE_STEP)
}

async function fetchWithTimeout(fetchImpl, url, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60000)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Cheap completeness probe, the same check the laptop makes before it starts
 * a build: the last forecast file of the cycle must exist.
 */
export async function probeCycleComplete(cycleUtc, fetchImpl) {
  const maxStep = effectiveMaxStep()
  const steps = buildForecastSteps(maxStep)
  const probeStep = steps.length > 0 ? steps[steps.length - 1] : 0
  const dateStr = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}`
  const runStr = cycleUtc.slice(11, 13)
  const url = `${ECMWF_BASE}/${dateStr}/${runStr}z/ifs/0p25/oper/${dateStr}${runStr}0000-${probeStep}h-oper-fc.grib2`
  try {
    const res = await fetchWithTimeout(fetchImpl, url, { headers: { Range: 'bytes=0-0' } })
    return Boolean(res && (res.ok || res.status === 206))
  } catch {
    return false
  }
}

/** The newest candidate cycle whose last forecast file is present. */
export async function findNewestCompleteCycle({ nowMs = Date.now(), fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('findNewestCompleteCycle needs a fetch')
  for (const cycle of getCandidateCycles(nowMs)) {
    if (await probeCycleComplete(cycle, fetchImpl)) return cycle
  }
  return null
}

/**
 * Cheap completeness probe for one ICON cycle, the same check the laptop makes:
 * HEAD the last needed file (2 m temperature at the last forecast step), trying
 * DWD's current address first and its older address second.
 */
export async function probeIconCycleComplete(cycleUtc, fetchImpl) {
  const maxStep = ICON_DEFAULT_STEPS[ICON_DEFAULT_STEPS.length - 1]
  const urls = buildIconUrls({ cycleUtc, varDir: 't_2m', varName: 'T_2M', stepHours: maxStep })
  try {
    const { res } = await fetchIconWithFallback({
      newUrl: urls.newUrl,
      oldUrl: urls.oldUrl,
      fetchFn: (url) => fetchWithTimeout(fetchImpl, url, { method: 'HEAD' }),
    })
    return Boolean(res && res.ok)
  } catch {
    return false
  }
}

/** The newest candidate ICON cycle whose last forecast file is present. */
export async function findNewestCompleteIconCycle({ nowMs = Date.now(), fetchImpl }) {
  if (typeof fetchImpl !== 'function') throw new Error('findNewestCompleteIconCycle needs a fetch')
  for (const cycle of candidateIconCycles(nowMs, 3)) {
    if (await probeIconCycleComplete(cycle, fetchImpl)) return cycle
  }
  return null
}

/**
 * Wrap a fetch so the laptop builder sees only the requested cycle as newest:
 * probes for later cycles answer 404. Data requests pass through unchanged.
 */
export function cycleSelectionFetch(cycleUtc, fetchImpl) {
  const targetMs = Date.parse(cycleUtc)
  if (!Number.isFinite(targetMs)) throw new Error(`not a cycle time: ${cycleUtc}`)
  return async (url, init) => {
    const range = init?.headers?.Range
    if (range === 'bytes=0-0') {
      const match = String(url).match(/\/(\d{4})(\d{2})(\d{2})\/(\d{2})z\/ifs/)
      if (match) {
        const candidate = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:00:00Z`
        if (Date.parse(candidate) > targetMs) {
          return { ok: false, status: 404, text: async () => '' }
        }
      }
    }
    return fetchImpl(url, init)
  }
}

function withBuildOutputOnStderr(fn) {
  const originalLog = console.log
  const originalError = console.error
  const toStderr = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`)
  console.log = toStderr
  console.error = toStderr
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog
      console.error = originalError
    })
}

function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Run the laptop cycle builder into a temporary data folder.
 * @returns {Promise<{ cycleUtc: string, cycleDir: string, index: object }>}
 */
export async function buildCycle({ model = 'ecmwf', cycleUtc, dataDir, fetchImpl }) {
  if (model === 'icon') return buildIconCycle({ cycleUtc, dataDir, fetchImpl })

  const pack = createWxPack({ dataDir, modelId: 'ecmwf' })
  const selectedFetch = cycleUtc ? cycleSelectionFetch(cycleUtc, fetchImpl) : fetchImpl
  await withBuildOutputOnStderr(() => refreshCycle(pack, selectedFetch))

  let found = null
  for (const dirName of pack.listCycleDirs()) {
    const index = readIndex(path.join(pack.root, dirName))
    if (index) found = { cycleUtc: index.cycleUtc, cycleDir: path.join(pack.root, dirName), index }
  }
  if (!found) {
    throw new Error(`no complete cycle was built${cycleUtc ? ` for ${cycleUtc}` : ''}`)
  }
  if (cycleUtc && Date.parse(found.cycleUtc) !== Date.parse(cycleUtc)) {
    throw new Error(`requested ${cycleUtc} but the builder produced ${found.cycleUtc}`)
  }
  return found
}

/**
 * Run the laptop ICON builder for one named cycle. The builder derives the
 * regrid lookup from the cycle's CLAT and CLON files; no lookup file is passed.
 */
async function buildIconCycle({ cycleUtc, dataDir, fetchImpl }) {
  const pack = createWxPackIcon({ dataDir })
  const built = await withBuildOutputOnStderr(() => pack.runCycleJob({ cycleUtc, fetchImpl }))
  if (!built.published) {
    const detail = built.errors?.length ? `: ${built.errors.join('; ')}` : ''
    throw new Error(`no complete cycle was built${cycleUtc ? ` for ${cycleUtc}` : ''}${detail}`)
  }
  if (cycleUtc && Date.parse(built.cycleUtc) !== Date.parse(cycleUtc)) {
    throw new Error(`requested ${cycleUtc} but the builder produced ${built.cycleUtc}`)
  }
  const cycleDir = path.join(pack.root, built.dir)
  const index = readIndex(cycleDir)
  if (!index) throw new Error(`icon pack has no index in ${cycleDir}`)
  return { cycleUtc: built.cycleUtc, cycleDir, index }
}

/**
 * Run one model end to end.
 * @param {{
 *   model: string,
 *   outDir: string,
 *   cycle?: string,
 *   dryRun?: boolean,
 *   nowMs?: number,
 *   fetchImpl?: (url: string, init?: object) => Promise<any>,
 * }} options
 */
export async function runCut({
  model,
  outDir,
  cycle = 'auto',
  dryRun = false,
  nowMs = Date.now(),
  fetchImpl = globalThis.fetch,
}) {
  const info = MODELS[model]
  if (!info) throw new Error(`model ${model} is not part of this cutter stage`)

  if (dryRun) {
    if (cycle !== 'auto' && !Number.isFinite(Date.parse(cycle))) {
      throw new Error(`not a cycle time: ${cycle}`)
    }
    return {
      model,
      cycleUtc: cycle === 'auto' ? null : cycle,
      tag: cycle === 'auto' ? null : tagForCycle(model, cycle),
      outDir,
      bytes: null,
      dryRun: true,
    }
  }

  if (typeof fetchImpl !== 'function') throw new Error('runCut needs a fetch')

  let cycleUtc = cycle
  if (cycleUtc === 'auto') {
    cycleUtc =
      model === 'icon'
        ? await findNewestCompleteIconCycle({ nowMs, fetchImpl })
        : await findNewestCompleteCycle({ nowMs, fetchImpl })
    if (!cycleUtc) throw new Error('no complete cycle is available yet')
  } else if (!Number.isFinite(Date.parse(cycleUtc))) {
    throw new Error(`not a cycle time: ${cycleUtc}`)
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxcut-data-'))
  try {
    const built = await buildCycle({ model, cycleUtc, dataDir, fetchImpl })

    const result = packageCycle({
      cycleDir: built.cycleDir,
      outDir,
      modelId: model,
      modelTitle: info.title,
      attribution: info.attribution(),
    })
    const check = verifyPackage(outDir)
    if (!check.ok) throw new Error(`package check failed: ${check.errors.join('; ')}`)

    return {
      model,
      cycleUtc: built.cycleUtc,
      tag: tagForCycle(model, built.cycleUtc),
      outDir,
      bytes: result.bytes,
    }
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
}

export function parseArgs(argv) {
  const args = { model: 'ecmwf', out: './out', cycle: 'auto', dryRun: false, nowMs: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--model') args.model = argv[++i]
    else if (arg === '--out') args.out = argv[++i]
    else if (arg === '--cycle') args.cycle = argv[++i]
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--now') {
      const value = argv[++i]
      const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
      if (!Number.isFinite(ms)) throw new Error(`not a usable time: ${value}`)
      args.nowMs = ms
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (!args.model) throw new Error('--model needs a value')
  if (!args.out) throw new Error('--out needs a value')
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = await runCut({
    model: args.model,
    outDir: path.resolve(args.out),
    cycle: args.cycle,
    dryRun: args.dryRun,
    nowMs: args.nowMs ?? Date.now(),
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

if (isMain) {
  main().catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
}
