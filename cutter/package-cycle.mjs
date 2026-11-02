// Package one laptop-format cycle folder into the public release layout:
// one <field>.wgrz per field plus manifest.json. The wgr1 files are copied
// unchanged inside each container; only the packaging and hashing happen here.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { packField, unpackField } from './wgrz.mjs'

const FORMAT = 'wx-cut-1'

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function listSteps(fieldDir) {
  return fs
    .readdirSync(fieldDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+\.wgr1$/.test(entry.name))
    .map((entry) => Number(entry.name.slice(0, -'.wgr1'.length)))
    .sort((a, b) => a - b)
}

/**
 * Package one cycle folder.
 * @param {{
 *   cycleDir: string,
 *   outDir: string,
 *   modelId: string,
 *   modelTitle: string,
 *   attribution: string,
 *   clock?: () => number,
 *   builtAtMs?: number,
 * }} options
 * @returns {{ manifest: object, files: string[], bytes: number, rawBytes: number }}
 */
export function packageCycle({
  cycleDir,
  outDir,
  modelId,
  modelTitle,
  attribution,
  clock = () => Date.now(),
  builtAtMs,
}) {
  if (!cycleDir || !outDir) throw new Error('packageCycle needs cycleDir and outDir')
  const indexPath = path.join(cycleDir, 'index.json')
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
  if (!index || typeof index !== 'object') throw new Error(`bad pack index: ${indexPath}`)
  if (!index.cycleUtc) throw new Error(`pack index has no cycleUtc: ${indexPath}`)
  if (!index.bbox || !index.grid) throw new Error(`pack index has no box or grid: ${indexPath}`)

  fs.mkdirSync(outDir, { recursive: true })

  const fieldDirs = fs
    .readdirSync(cycleDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const fields = []
  const allSteps = new Set()
  let totalBytes = 0
  let totalRawBytes = 0

  for (const id of fieldDirs) {
    const fieldDir = path.join(cycleDir, id)
    const steps = listSteps(fieldDir)
    if (steps.length === 0) continue

    const files = steps.map((stepHours) => ({
      stepHours,
      bytes: fs.readFileSync(path.join(fieldDir, `${stepHours}.wgr1`)),
    }))
    const asset = `${id}.wgrz`
    const packed = packField(files)
    const assetPath = path.join(outDir, asset)
    fs.writeFileSync(assetPath, packed)

    const rawBytes = files.reduce((sum, file) => sum + file.bytes.length, 0)
    for (const step of steps) allSteps.add(step)
    totalBytes += packed.length
    totalRawBytes += rawBytes
    fields.push({
      id,
      asset,
      bytes: packed.length,
      sha256: sha256(packed),
      stepHours: steps,
      rawBytes,
    })
  }

  if (fields.length === 0) throw new Error(`no field folders in ${cycleDir}`)

  const { minLat, maxLat, minLon, maxLon } = index.bbox
  const manifest = {
    format: FORMAT,
    modelId,
    modelTitle,
    cycleUtc: index.cycleUtc,
    builtAtMs: Number.isFinite(builtAtMs) ? builtAtMs : clock(),
    box: [minLon, minLat, maxLon, maxLat],
    grid: index.grid,
    steps: [...allSteps].sort((a, b) => a - b),
    fields,
    packIndex: index,
    attribution,
    modified: 'Cropped to the box above and re-quantised to 16-bit; values otherwise as published.',
  }

  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

  return {
    manifest,
    files: fields.map((field) => field.asset),
    bytes: totalBytes,
    rawBytes: totalRawBytes,
  }
}

/**
 * Re-read a package and check every asset's size and sha256 from the manifest.
 * Never throws for a bad package; the caller decides what to do with `ok`.
 */
export function verifyPackage(outDir) {
  const errors = []
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return { ok: false, errors: [`cannot read manifest: ${err?.message || err}`], fields: 0, bytes: 0 }
  }
  if (manifest.format !== FORMAT) errors.push(`format is ${manifest.format}, expected ${FORMAT}`)
  if (!Array.isArray(manifest.fields) || manifest.fields.length === 0) {
    errors.push('manifest lists no fields')
    return { ok: false, errors, fields: 0, bytes: 0 }
  }

  let bytes = 0
  for (const field of manifest.fields) {
    if (!field.asset || typeof field.bytes !== 'number' || typeof field.sha256 !== 'string') {
      errors.push(`field ${field.id ?? '?'} has an incomplete manifest entry`)
      continue
    }
    const assetPath = path.join(outDir, field.asset)
    let data
    try {
      data = fs.readFileSync(assetPath)
    } catch {
      errors.push(`${field.asset}: missing`)
      continue
    }
    if (data.length !== field.bytes) {
      errors.push(`${field.asset}: ${data.length} bytes, manifest says ${field.bytes}`)
    }
    const actual = sha256(data)
    if (actual !== field.sha256) {
      errors.push(`${field.asset}: sha256 ${actual}, manifest says ${field.sha256}`)
    }
    bytes += data.length
  }

  return { ok: errors.length === 0, errors, fields: manifest.fields.length, bytes }
}

export { unpackField }
