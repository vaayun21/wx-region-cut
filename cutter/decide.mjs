// Decide which models need a build. The workflow writes its release list to a
// file and runs this once; the output is a JSON list of model ids. No heavy
// download happens here: only the cheap last-step probe.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decideWork, retentionDeletes } from './plan-run.mjs'
import { findNewestCompleteCycle } from './run.mjs'

const TAG_RE = /^(ecmwf|icon)-(\d{4})(\d{2})(\d{2})T(\d{2})Z$/

/** Turn release tags such as ecmwf-20261103T00Z into cycle ISO strings. */
export function publishedCyclesFromReleases(releases) {
  const published = { ecmwf: [], icon: [] }
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.isDraft === true) continue // a draft is an unfinished or failed build, not a published run
    const tag = release?.tagName ?? release?.tag
    if (typeof tag !== 'string') continue
    const match = tag.match(TAG_RE)
    if (!match) continue
    published[match[1]].push(`${match[2]}-${match[3]}-${match[4]}T${match[5]}:00:00Z`)
  }
  return published
}

/**
 * The rolling pointer (latest.json), computed from the published releases themselves: the newest
 * cycle per model. Drafts never count. No previous pointer file is read, so two jobs cannot erase
 * each other's entry.
 */
export function latestPointerFromReleases({ releases, nowMs = Date.now() }) {
  const models = {}
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release?.isDraft === true) continue
    const tag = release?.tagName ?? release?.tag
    const match = typeof tag === 'string' ? tag.match(TAG_RE) : null
    if (!match) continue
    const cycleUtc = `${match[2]}-${match[3]}-${match[4]}T${match[5]}:00:00Z`
    const builtAtMs = Date.parse(release.createdAt)
    const best = models[match[1]]
    if (!best || Date.parse(cycleUtc) > Date.parse(best.cycleUtc)) {
      models[match[1]] = { tag, cycleUtc, builtAtMs: Number.isFinite(builtAtMs) ? builtAtMs : null }
    }
  }
  return { updatedAtMs: nowMs, models }
}

function sameCycle(a, b) {
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right
  return a === b
}

/**
 * Choose models for this run.
 * `auto` follows the published list; an explicit model is built when its newest
 * complete cycle exists, and `force` ignores the published check.
 */
export async function decideModels({
  releases,
  nowMs = Date.now(),
  fetchImpl,
  model = 'auto',
  force = false,
}) {
  const published = publishedCyclesFromReleases(releases)
  const newestComplete = { ecmwf: null, icon: null }

  if (model === 'auto' || model === 'ecmwf') {
    newestComplete.ecmwf = await findNewestCompleteCycle({ nowMs, fetchImpl })
  }
  if (model === 'icon') {
    // The ICON side of the cutter is not part of this stage.
    newestComplete.icon = null
  }

  let models
  if (model === 'auto') {
    models = decideWork({ nowMs, published, newestComplete })
  } else if (!newestComplete[model]) {
    models = []
  } else if (force || !published[model].some((cycle) => sameCycle(cycle, newestComplete[model]))) {
    models = [model]
  } else {
    models = []
  }

  return { models, cycles: newestComplete, published }
}

/** Retention tags from a gh release list. Never includes `latest`. */
export function retentionFromReleases({ releases, nowMs = Date.now(), keepDays = 3 }) {
  const rows = []
  for (const release of Array.isArray(releases) ? releases : []) {
    const tag = release?.tagName ?? release?.tag
    const createdAtMs = Number.isFinite(release?.createdAtMs)
      ? release.createdAtMs
      : Date.parse(release?.createdAt)
    if (typeof tag === 'string') rows.push({ tag, createdAtMs })
  }
  // Never delete the newest published run of a model, even when it is older than keepDays: the
  // rolling pointer must always have something to point at if the cutter stalls for a few days.
  const newest = latestPointerFromReleases({ releases, nowMs }).models
  const protectedTags = new Set(Object.values(newest).map((m) => m.tag))
  return retentionDeletes({ nowMs, releases: rows, keepDays }).filter((tag) => !protectedTags.has(tag))
}

function parseNow(value) {
  if (value == null) return Date.now()
  const ms = /^\d+$/.test(value) ? Number(value) : Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`not a usable time: ${value}`)
  return ms
}

function parseArgs(argv) {
  const args = { releases: null, model: 'auto', force: false, nowMs: null, retention: false, keepDays: 3 }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--releases') args.releases = argv[++i]
    else if (arg === '--model') args.model = argv[++i]
    else if (arg === '--force') {
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args.force = true
      } else {
        args.force = String(next).toLowerCase() === 'true'
        i++
      }
    } else if (arg === '--now') args.nowMs = parseNow(argv[++i])
    else if (arg === '--retention') args.retention = true
    else if (arg === '--latest') args.latest = true
    else if (arg === '--keep-days') args.keepDays = Number(argv[++i])
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

function readReleases(file) {
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8')
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed
  if (Array.isArray(parsed?.releases)) return parsed.releases
  throw new Error('release list is not an array')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const releases = readReleases(args.releases)
  const nowMs = args.nowMs ?? Date.now()

  if (args.latest) {
    process.stdout.write(`${JSON.stringify(latestPointerFromReleases({ releases, nowMs }))}\n`)
    return
  }

  if (args.retention) {
    const tags = retentionFromReleases({ releases, nowMs, keepDays: args.keepDays })
    process.stdout.write(`${JSON.stringify({ delete: tags })}\n`)
    return
  }

  const result = await decideModels({
    releases,
    nowMs,
    fetchImpl: globalThis.fetch,
    model: args.model,
    force: args.force,
  })
  process.stdout.write(`${JSON.stringify({ models: result.models, cycles: result.cycles })}\n`)
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

if (isMain) {
  main().catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
}
