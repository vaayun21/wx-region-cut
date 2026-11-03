// Pure planning for the second copy of the published cut releases. No network,
// no clock: the caller supplies the tag lists and writes the result.
//
// The mirror holds the same layout as the releases: one top-level folder per
// model run plus the rolling `latest` folder. The planner keeps the mirror in
// step with the release list: new runs are uploaded, folders whose run is gone
// are removed, and `latest` is never part of either list (it is written after
// the model folders, by the caller).

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TAG_RE = /^(ecmwf|icon)-(\d{4})(\d{2})(\d{2})T(\d{2})Z$/

/** True for a model-run tag such as ecmwf-20261103T00Z. */
export function isModelRunTag(tag) {
  return typeof tag === 'string' && TAG_RE.test(tag)
}

function normaliseTag(value) {
  if (typeof value !== 'string') return null
  const tag = value.trim().replace(/\/+$/, '')
  return isModelRunTag(tag) ? tag : null
}

function validTags(tags) {
  const out = new Set()
  for (const value of Array.isArray(tags) ? tags : []) {
    const tag = normaliseTag(value)
    if (tag) out.add(tag)
  }
  return [...out]
}

/**
 * Work out what the mirror needs.
 * @param {{
 *   githubTags?: string[],
 *   mirrorTags?: string[],
 * }} input
 * @returns {{ upload: string[], remove: string[] }}
 */
export function planMirrorSync({ githubTags = [], mirrorTags = [] } = {}) {
  const github = validTags(githubTags)
  const mirror = validTags(mirrorTags)
  const githubSet = new Set(github)
  const mirrorSet = new Set(mirror)

  return {
    upload: github.filter((tag) => !mirrorSet.has(tag)).sort(),
    remove: mirror.filter((tag) => !githubSet.has(tag)).sort(),
  }
}

function readTagList(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (Array.isArray(parsed)) {
    return parsed.map((row) =>
      typeof row === 'string' ? row : row?.tagName ?? row?.tag ?? row?.name,
    )
  }
  if (Array.isArray(parsed?.releases)) return readTagListFromArray(parsed.releases)
  if (Array.isArray(parsed?.tags)) return parsed.tags
  throw new Error(`${file} does not hold a tag list`)
}

function readTagListFromArray(rows) {
  return rows.map((row) => (typeof row === 'string' ? row : row?.tagName ?? row?.tag ?? row?.name))
}

function parseArgs(argv) {
  const args = { github: null, mirror: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--github') args.github = argv[++i]
    else if (argv[i] === '--mirror') args.mirror = argv[++i]
    else throw new Error(`unknown argument: ${argv[i]}`)
  }
  if (!args.github || !args.mirror) {
    throw new Error('usage: node cutter/mirror-plan.mjs --github <releases.json> --mirror <mirror.json>')
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = planMirrorSync({
    githubTags: readTagList(args.github),
    mirrorTags: readTagList(args.mirror),
  })
  process.stdout.write(`${JSON.stringify(plan)}\n`)
}

const isMain =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])

if (isMain) {
  try {
    main()
  } catch (err) {
    console.error(err?.message || err)
    process.exit(1)
  }
}
