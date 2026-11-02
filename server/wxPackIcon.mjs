/**
 * server/wxPackIcon.mjs
 * Model weather pack for the German weather service's ICON global model (~13 km),
 * regridded to a regular 0.125-degree lat/lon grid over the India box.
 *
 * Downloads single-level icosahedral GRIB2 files (template 101, packing 5.42 AEC),
 * decompresses with bzip2 in memory, decodes, regrids, and publishes compact WGR1 grids.
 *
 * Safety note: Weather model data is advisory. Positions, times, and physical values
 * are verified against published data and ground truth.
 */

import fs from 'node:fs'
import path from 'node:path'
import { bunzip2 } from './lib/bzip2.mjs'
import { encodeWgr1, decodeWgr1, pickScaleOffset } from '../src/lib/wxPack/wgr1.ts'
import { buildForecastSteps } from '../src/lib/wxPack/deviceBuilder.ts'
import { deaccumulateIconStep, computeThunderGrid } from '../src/lib/wxPack/thunderRule.ts'
import {
  getOrBuildLookup,
  regridField,
  decodeIconGrib2,
} from './lib/iconRegrid.mjs'
import {
  FORECAST_BOX,
  FORECAST_GRID,
  SOURCE_LABEL,
  MODEL_LABEL,
  MODEL_ID,
  ICON_MAX_AVAILABLE_STEP,
  ICON_MAX_STEP,
  ICON_DEFAULT_STEPS,
  KEEP_CYCLES,
  ICON_PACK_FIELDS,
  pickValidTimeIso,
  cycleDirName,
  dwdCycleTag,
  buildIconUrl,
  candidateIconCycles,
  convertIconFieldBuffers,
} from '../src/lib/wxPack/iconPack.ts'
import {
  buildIconUrls,
  formatIconRunIso,
  formatIconStep,
  isBzip2,
  fetchIconWithFallback,
} from '../src/lib/wxPack/iconUrls.ts'

export {
  FORECAST_BOX,
  FORECAST_GRID,
  MODEL_LABEL,
  MODEL_ID,
  ICON_MAX_AVAILABLE_STEP,
  ICON_MAX_STEP,
  ICON_DEFAULT_STEPS,
  KEEP_CYCLES,
  ICON_PACK_FIELDS,
  pickValidTimeIso,
  cycleDirName,
  dwdCycleTag,
  buildIconUrl,
  buildIconUrls,
  formatIconRunIso,
  formatIconStep,
  isBzip2,
  fetchIconWithFallback,
  candidateIconCycles,
  convertIconFieldBuffers,
}

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

function fnv1a(bytes) {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function jsonResponse(statusCode, body) {
  const text = JSON.stringify(body)
  return {
    status: statusCode,
    headers: { 'content-type': 'application/json', etag: `"${fnv1a(Buffer.from(text))}"` },
    body: text,
  }
}

/**
 * Fetch with timeout, user-agent, and polite retry backoff.
 */
async function fetchWithRetry(url, { method = 'GET', retries = 3, timeoutMs = 60000, userAgent, fetchImpl }) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await sleep(1000 * Math.pow(2, attempt - 1))
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetchImpl(url, {
        method,
        headers: { 'User-Agent': userAgent },
        signal: controller.signal,
      })
      clearTimeout(timer)
      return res
    } catch (e) {
      clearTimeout(timer)
      lastError = e
    }
  }
  throw lastError || new Error(`failed after ${retries} retries`)
}

/**
 * The pack manager and cycle worker for ICON.
 */
export function createWxPackIcon({
  dataDir,
  modelId = MODEL_ID,
  modelLabel = MODEL_LABEL,
  nowMs,
  lookup = null,
  lookupPath = null,
  pauseMs = 1000,
  timeoutMs = 60000,
  retries = 3,
  userAgent = 'wx-region-cut/1 (personal weather tool)',
} = {}) {
  const root = path.join(dataDir, modelId)
  const clock = typeof nowMs === 'function' ? nowMs : () => (nowMs ? Number(nowMs) : Date.now())
  const resolvedLookupPath = lookupPath || path.join(dataDir, modelId, 'regrid-lookup.bin')

  const status = {
    modelId,
    cycleUtc: null,
    ageMinutes: null,
    lastSuccessMs: 0,
    lastAttemptMs: 0,
    errors: [],
  }

  let activeLookup = lookup

  function ensureLookup(cellLats, cellLons, gridIdentity = 'icon-global') {
    if (activeLookup) return activeLookup
    activeLookup = getOrBuildLookup({
      cachePath: resolvedLookupPath,
      cellLats,
      cellLons,
      gridIdentity,
      targetGrid: FORECAST_GRID,
    })
    return activeLookup
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

  function publishedIndex(cycleDir = null) {
    const dirs = cycleDir ? [cycleDir] : listCycleDirs()
    for (let i = dirs.length - 1; i >= 0; i--) {
      const index = readJson(path.join(root, dirs[i], 'index.json'))
      if (index) return { cycleDir: dirs[i], index }
    }
    return null
  }

  function route(method, pathname, { ifNoneMatch } = {}) {
    if (method !== 'GET') return { status: 405, headers: {}, body: 'method not allowed' }
    const prefix = '/api/wx/pack/'
    if (!pathname.startsWith(prefix)) return { status: 404, headers: {}, body: 'not found' }
    const rest = pathname.slice(prefix.length).replace(/\/+$/, '')
    const parts = rest.split('/').filter(Boolean)

    if (parts.length === 2 && parts[0] === modelId && parts[1] === 'status') {
      const pub = publishedIndex()
      return jsonResponse(200, {
        ...status,
        modelId,
        cycleUtc: pub ? pub.index.cycleUtc : status.cycleUtc,
        ageMinutes: pub ? Math.max(0, Math.round((clock() - Date.parse(pub.index.cycleUtc)) / 60_000)) : null,
        cyclesOnDisk: listCycleDirs(),
      })
    }
    if (parts.length === 2 && parts[0] === modelId && parts[1] === 'index') {
      const pub = publishedIndex()
      if (!pub) return jsonResponse(404, { error: 'no cycle published' })
      return jsonResponse(200, pub.index)
    }

    // /:modelId/:cycle/:fieldId/:step.wgr1
    if (parts.length === 4 && parts[0] === modelId) {
      const [, cycleDir, fieldId, stepText] = parts
      if (!/^\d+\.wgr1$/.test(stepText)) return { status: 404, headers: {}, body: 'not found' }
      const step = Number(stepText.replace('.wgr1', ''))
      const index = readJson(path.join(root, cycleDir, 'index.json'))
      if (!index) return { status: 404, headers: {}, body: 'unknown or unpublished cycle' }
      const entry = index.fields?.[fieldId]?.files?.find((f) => f.step === step)
      if (!entry) return { status: 404, headers: {}, body: 'unknown field or step' }
      const file = path.join(root, cycleDir, fieldId, `${step}.wgr1`)
      let bytes
      try {
        bytes = fs.readFileSync(file)
      } catch {
        return { status: 404, headers: {}, body: 'grid file missing' }
      }
      const etag = `"${modelId}-${cycleDir}-${fieldId}-${step}-${bytes.length}-${fnv1a(bytes)}"`
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

    return { status: 404, headers: {}, body: 'not found' }
  }

  /**
   * Run download, regrid, and publish for one complete cycle.
   */
  async function runCycleJob({
    cycleUtc,
    steps = ICON_DEFAULT_STEPS,
    fields = ICON_PACK_FIELDS,
    fetchImpl = fetch,
    pauseBetweenReqMs = pauseMs,
    cellLats = null,
    cellLons = null,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('runCycleJob needs a fetchImpl')
    const dir = cycleDirName(cycleUtc)
    const dest = path.join(root, dir)
    const errors = []
    status.lastAttemptMs = clock()

    // Determine maxStep allowed
    const maxEnvStep = process.env.WXREGIONCUT_ICON_MAX_STEP ? Number(process.env.WXREGIONCUT_ICON_MAX_STEP) : Infinity
    const effectiveSteps = steps.filter((s) => s <= maxEnvStep)

    // Ensure regrid lookup is ready
    let lk = activeLookup
    if (!lk && cellLats && cellLons) {
      lk = ensureLookup(cellLats, cellLons)
    } else if (!lk && fs.existsSync(resolvedLookupPath)) {
      try {
        lk = getOrBuildLookup({ cachePath: resolvedLookupPath, targetGrid: FORECAST_GRID })
        activeLookup = lk
      } catch {
        // needs cell coordinates
      }
    }

    if (!lk) {
      // Need to fetch CLAT and CLON
      try {
        const clatUrls = buildIconUrls({ cycleUtc, varName: 'CLAT', varDir: 'clat' })
        const { res: clatRes, url: clatUsedUrl } = await fetchIconWithFallback({
          newUrl: clatUrls.newUrl,
          oldUrl: clatUrls.oldUrl,
          fetchFn: (u) => fetchWithRetry(u, { timeoutMs, userAgent, fetchImpl, retries }),
        })
        if (!clatRes.ok) throw new Error(`HTTP ${clatRes.status} fetching CLAT`)
        const rawClat = new Uint8Array(await clatRes.arrayBuffer())
        const clatBytes = isBzip2(rawClat, clatUsedUrl) ? bunzip2(rawClat) : rawClat
        const dLat = decodeIconGrib2(clatBytes)

        if (pauseBetweenReqMs > 0) await sleep(pauseBetweenReqMs)

        const clonUrls = buildIconUrls({ cycleUtc, varName: 'CLON', varDir: 'clon' })
        const { res: clonRes, url: clonUsedUrl } = await fetchIconWithFallback({
          newUrl: clonUrls.newUrl,
          oldUrl: clonUrls.oldUrl,
          fetchFn: (u) => fetchWithRetry(u, { timeoutMs, userAgent, fetchImpl, retries }),
        })
        if (!clonRes.ok) throw new Error(`HTTP ${clonRes.status} fetching CLON`)
        const rawClon = new Uint8Array(await clonRes.arrayBuffer())
        const clonBytes = isBzip2(rawClon, clonUsedUrl) ? bunzip2(rawClon) : rawClon
        const dLon = decodeIconGrib2(clonBytes)

        const tag00 = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}00`
        lk = ensureLookup(dLat.values, dLon.values, `icon-global-${tag00}`)
      } catch (err) {
        errors.push(`lookup init failed: ${(err && err.message) || err}`)
        status.errors = errors
        return { published: false, errors, cycleUtc, files: 0, bytes: 0 }
      }
    }

    const converted = []
    let totalBytesWritten = 0
    let lastTotPrec = null
    let lastConv = null

    // Process each step
    for (const step of effectiveSteps) {
      for (const fieldDef of fields) {
        if (typeof fieldDef.minStep === 'number' && step < fieldDef.minStep) {
          continue
        }

        const outFilePath = path.join(dest, fieldDef.id, `${step}.wgr1`)

        // Resume partial cycles: reuse existing on-disk grid file if valid
        if (fs.existsSync(outFilePath)) {
          try {
            const existingBytes = fs.readFileSync(outFilePath)
            const decoded = decodeWgr1(existingBytes)
            if (fieldDef.id === 'rain3') lastTotPrec = decoded.planes[0]
            if (fieldDef.id === 'conv3') lastConv = decoded.planes[0]
            converted.push({
              fieldId: fieldDef.id,
              stepHours: step,
              unit: fieldDef.unit,
              levelLabel: fieldDef.levelLabel,
              wgr1: existingBytes,
              bytes: existingBytes.length,
              min: decoded.meta.min,
              max: decoded.meta.max,
              ...(decoded.meta.rainWindowH != null ? { rainWindowH: decoded.meta.rainWindowH } : {}),
            })
            continue
          } catch {
            // invalid existing file, re-download
          }
        }

        const rawBz2Buffers = []
        let fetchFailed = false

        for (const v of fieldDef.vars) {
          const urls = buildIconUrls({
            cycleUtc,
            varDir: v.dir,
            varName: v.fileSuffix,
            stepHours: step,
          })

          let res
          let usedUrl
          try {
            const fallbackResult = await fetchIconWithFallback({
              newUrl: urls.newUrl,
              oldUrl: urls.oldUrl,
              fetchFn: (u) => fetchWithRetry(u, { timeoutMs, userAgent, fetchImpl, retries }),
            })
            res = fallbackResult.res
            usedUrl = fallbackResult.url
            if (!res || !res.ok) {
              errors.push(`step ${step} ${fieldDef.id}: HTTP ${res ? res.status : 'no response'}`)
              fetchFailed = true
              break
            }
          } catch (e) {
            errors.push(`step ${step} ${fieldDef.id}: ${(e && e.message) || e}`)
            fetchFailed = true
            break
          }

          try {
            const rawBytes = new Uint8Array(await res.arrayBuffer())
            const decompressed = isBzip2(rawBytes, usedUrl) ? bunzip2(rawBytes) : rawBytes
            rawBz2Buffers.push(decompressed)
          } catch (e) {
            errors.push(`step ${step} ${fieldDef.id}: read error: ${(e && e.message) || e}`)
            fetchFailed = true
            break
          }

          if (pauseBetweenReqMs > 0) await sleep(pauseBetweenReqMs)
        }

        if (fetchFailed || rawBz2Buffers.length !== fieldDef.vars.length) {
          break
        }

        let convRes
        try {
          convRes = convertIconFieldBuffers({
            fieldDef,
            stepHours: step,
            cycleUtc,
            rawBz2Buffers,
            lookup: lk,
            lastTotPrec,
            lastConv,
            targetGrid: FORECAST_GRID,
            modelLabel,
          })
          if (convRes.lastTotPrec !== undefined) lastTotPrec = convRes.lastTotPrec
          if (convRes.lastConv !== undefined) lastConv = convRes.lastConv
        } catch (e) {
          errors.push(`step ${step} ${fieldDef.id}: conversion error: ${(e && e.message) || e}`)
          break
        }

        atomicWrite(outFilePath, convRes.wgr1)
        totalBytesWritten += convRes.wgr1.length

        converted.push({
          fieldId: fieldDef.id,
          stepHours: step,
          unit: fieldDef.unit,
          levelLabel: fieldDef.levelLabel,
          wgr1: convRes.wgr1,
          bytes: convRes.wgr1.length,
          min: convRes.min,
          max: convRes.max,
          ...(convRes.rainWindowH != null ? { rainWindowH: convRes.rainWindowH } : {}),
        })
      }

      if (errors.length > 0) break
    }

    if (errors.length > 0) {
      status.errors = errors
      return { published: false, errors, cycleUtc, files: 0, bytes: 0 }
    }

    // Safety rule: Never publish without wind10 and temp2 for all steps
    for (const step of effectiveSteps) {
      const hasWind = converted.some((c) => c.fieldId === 'wind10' && c.stepHours === step)
      const hasTemp = converted.some((c) => c.fieldId === 'temp2' && c.stepHours === step)
      if (!hasWind || !hasTemp) {
        status.errors = [`missing essential fields (wind10 or temp2) at step ${step}`]
        return { published: false, errors: status.errors, cycleUtc, files: 0, bytes: 0 }
      }
    }

    // Build pack index
    const byField = new Map()
    for (const f of converted) {
      if (!byField.has(f.fieldId)) byField.set(f.fieldId, [])
      byField.get(f.fieldId).push(f)
    }

    const fieldsMap = {}
    for (const [fId, list] of byField) {
      list.sort((a, b) => a.stepHours - b.stepHours)
      const def = ICON_PACK_FIELDS.find((d) => d.id === fId)
      fieldsMap[fId] = {
        unit: def.unit,
        levelLabel: def.levelLabel,
        min: Math.min(...list.map((f) => f.min)),
        max: Math.max(...list.map((f) => f.max)),
        files: list.map((f) => ({
          step: f.stepHours,
          url: `/api/wx/pack/${modelId}/${dir}/${fId}/${f.stepHours}.wgr1`,
          bytes: f.bytes,
          validAtMs: Date.parse(cycleUtc) + f.stepHours * 3_600_000,
          ...(f.rainWindowH != null
            ? { rainWindowH: f.rainWindowH }
            : fId === 'rain3' || fId === 'conv3'
              ? { rainWindowH: f.stepHours > 72 ? 6 : 3 }
              : {}),
        })),
      }
    }

    const packIndex = {
      model: modelLabel,
      modelId,
      cycleUtc,
      generatedAtMs: clock(),
      bbox: { minLat: FORECAST_GRID.minLat, maxLat: FORECAST_GRID.maxLat, minLon: FORECAST_GRID.minLon, maxLon: FORECAST_GRID.maxLon },
      grid: {
        nx: FORECAST_GRID.nx,
        ny: FORECAST_GRID.ny,
        dx: FORECAST_GRID.dLon,
        dy: FORECAST_GRID.dLat,
      },
      steps: effectiveSteps,
      fields: fieldsMap,
    }

    // Publish index atomically
    atomicWrite(path.join(dest, 'index.json'), JSON.stringify(packIndex))

    status.cycleUtc = cycleUtc
    status.lastSuccessMs = clock()
    status.errors = []
    status.ageMinutes = Math.max(0, Math.round((clock() - Date.parse(cycleUtc)) / 60_000))

    // Keep only the newest KEEP_CYCLES published cycles
    const published = listCycleDirs().filter((d) => fs.existsSync(path.join(root, d, 'index.json')))
    for (const old of published.slice(0, Math.max(0, published.length - KEEP_CYCLES))) {
      fs.rmSync(path.join(root, old), { recursive: true, force: true })
    }

    return {
      published: true,
      errors: [],
      cycleUtc,
      files: converted.length,
      bytes: totalBytesWritten,
      dir,
    }
  }

  return {
    dataDir,
    modelId,
    root,
    route,
    runCycleJob,
    listCycleDirs,
    publishedIndex: () => publishedIndex(),
    status: () => ({ ...status, cyclesOnDisk: listCycleDirs() }),
    ensureLookup,
  }
}

/**
 * Scheduled check for newer complete ICON cycle (00z or 12z).
 * HEADs the last needed file (maxStep of temp2) before downloading.
 */
export async function checkForNewerIconCycle({
  pack,
  fetchImpl = fetch,
  nowMs = Date.now(),
  pauseMs = 1000,
  maxStep = ICON_DEFAULT_STEPS[ICON_DEFAULT_STEPS.length - 1],
  userAgent = 'wx-region-cut/1 (personal weather tool)',
} = {}) {
  const have = pack.publishedIndex()
  const haveCycle = have ? have.index.cycleUtc : null
  const candidates = candidateIconCycles(nowMs, 3)

  for (const cycleUtc of candidates) {
    if (haveCycle && Date.parse(cycleUtc) <= Date.parse(haveCycle)) break

    // Probe completeness: HEAD the last needed step file (t_2m at maxStep)
    // DWD moves ICON to a new address scheme; the old one stops after 30 November 2026. Ask the
    // new address first, then the old one, so the check works before and after the switch.
    const probe = buildIconUrls({ cycleUtc, varDir: 't_2m', varName: 'T_2M', stepHours: maxStep })

    let complete = false
    for (const probeUrl of [probe.newUrl, probe.oldUrl]) {
      try {
        const res = await fetchImpl(probeUrl, {
          method: 'HEAD',
          headers: { 'User-Agent': userAgent },
        })
        complete = Boolean(res && res.ok)
      } catch {
        complete = false
      }
      if (complete) break
    }

    if (!complete) continue

    return pack.runCycleJob({
      cycleUtc,
      fetchImpl,
      pauseBetweenReqMs: pauseMs,
    })
  }

  return { published: false, skipped: true, errors: [] }
}
