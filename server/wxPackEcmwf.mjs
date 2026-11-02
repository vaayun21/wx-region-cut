import { encodeWgr1, pickScaleOffset, decodeWgr1 } from '../src/lib/wxPack/wgr1.ts'
import { packFieldById, buildPackIndex, cycleDirName, buildForecastSteps } from './wxPack.mjs'
import { decodeGrib2 } from '../src/lib/windGrid/grib2.ts'
import { deaccumulateEcmwfStep, computeThunderGrid } from '../src/lib/wxPack/thunderRule.ts'
import {
  ECMWF_FIELDS,
  FORECAST_BOX,
  cropIfsToGfs,
  fetchEcmwfIndex,
  getCandidateCycles,
  ECMWF_MAX_AVAILABLE_STEP,
  ECMWF_DEFAULT_MAX_STEP,
  ECMWF_DEFAULT_STEPS,
  convertEcmwfFieldPlanes,
  synthesizeEcmwfStep0,
  computeEcmwfThunder,
} from '../src/lib/wxPack/ecmwfPack.ts'
import fs from 'node:fs'
import path from 'node:path'

export {
  ECMWF_FIELDS,
  FORECAST_BOX,
  cropIfsToGfs,
  fetchEcmwfIndex,
  ECMWF_MAX_AVAILABLE_STEP,
  ECMWF_DEFAULT_MAX_STEP,
  ECMWF_DEFAULT_STEPS,
  convertEcmwfFieldPlanes,
  synthesizeEcmwfStep0,
  computeEcmwfThunder,
}

const GFS_NI = Math.round((FORECAST_BOX.maxLon - FORECAST_BOX.minLon) / 0.25) + 1 // 541
const GFS_NJ = Math.round((FORECAST_BOX.maxLat - FORECAST_BOX.minLat) / 0.25) + 1 // 261
const GFS_LA1 = FORECAST_BOX.minLat
const GFS_LO1 = FORECAST_BOX.minLon

function atomicWrite(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, file)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const ECMWF_BASE = 'https://data.ecmwf.int/forecasts'
const KEEP_CYCLES = 2

async function fetchWithRetry(url, range, fetchImpl, maxRetries = 3) {
  let attempt = 0
  while (attempt <= maxRetries) {
    try {
      const headers = {
        'User-Agent': 'wx-region-cut/1 (personal weather tool)'
      }
      if (range) headers['Range'] = `bytes=${range}`

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 60000)

      const res = await fetchImpl(url, { headers, signal: controller.signal })
      clearTimeout(timeoutId)

      if (res.ok || res.status === 206) {
        return res
      }
      if (res.status === 404 || res.status === 403) return res
    } catch (err) {
      if (attempt === maxRetries) throw err
    }
    attempt++
    await sleep(Math.pow(2, attempt) * 1000)
  }
}

export async function refreshCycle(pack, fetchImpl) {
  const envMax = process.env.WXREGIONCUT_ECMWF_MAX_STEP ? parseInt(process.env.WXREGIONCUT_ECMWF_MAX_STEP, 10) : ECMWF_DEFAULT_MAX_STEP
  const maxStep = Math.min(envMax, ECMWF_MAX_AVAILABLE_STEP)
  const steps = buildForecastSteps(maxStep)

  const cycles = getCandidateCycles()
  let cycleUtc = null

  const probeStep = steps.length > 0 ? steps[steps.length - 1] : 0
  for (const c of cycles) {
    const dateStr = `${c.slice(0, 4)}${c.slice(5, 7)}${c.slice(8, 10)}`
    const runStr = c.slice(11, 13)
    const baseUrl = `${ECMWF_BASE}/${dateStr}/${runStr}z/ifs/0p25/oper`
    const maxStepUrl = `${baseUrl}/${dateStr}${runStr}0000-${probeStep}h-oper-fc.grib2`

    try {
      const res = await fetchWithRetry(maxStepUrl, '0-0', fetchImpl)
      if (res && (res.ok || res.status === 206)) {
        cycleUtc = c
        break
      }
    } catch (e) {
      // Ignore
    }
  }

  if (!cycleUtc) return

  const dir = cycleDirName(cycleUtc)
  const outDir = path.join(pack.root, dir)
  if (fs.existsSync(path.join(outDir, 'index.json'))) return

  fs.mkdirSync(outDir, { recursive: true })

  let totalBytes = 0
  let totalRequests = 0
  const convertedFiles = []
  let cycleOk = true

  // Track fields required across all steps
  const seenFields = new Set()
  let lastTp = null
  let lastCp = null

  for (const step of steps) {
    const indexEntries = await fetchEcmwfIndex(cycleUtc, step, fetchImpl)
    totalRequests++
    if (!indexEntries) {
      cycleOk = false; break
    }

    const dateStr = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}`
    const runStr = cycleUtc.slice(11, 13)
    const fileBase = `${dateStr}${runStr}0000-${step}h-oper-fc.grib2`
    const grib2Url = `${ECMWF_BASE}/${dateStr}/${runStr}z/ifs/0p25/oper/${fileBase}`

    // Group fields
    const stepFiles = []

    // Unique list of target fields avoiding dupes for wind pairs
    const uniqueFields = []
    for (const fm of ECMWF_FIELDS) {
      if (!uniqueFields.find(f => f.id === fm.id)) {
        uniqueFields.push(fm)
      }
    }

    for (const fieldMap of uniqueFields) {
      if (fieldMap.id === 'gust' && step === 0) continue

      const def = packFieldById(fieldMap.id)
      const outFile = path.join(outDir, fieldMap.id, `${step}.wgr1`)

      if (fs.existsSync(outFile)) {
        const buf = fs.readFileSync(outFile)
        const grid = decodeWgr1(buf)
        if (fieldMap.id === 'rain3') lastTp = grid.planes[0]
        if (fieldMap.id === 'conv3') lastCp = grid.planes[0]
        stepFiles.push({
          fieldId: fieldMap.id,
          stepHours: step,
          bytes: buf.length,
          min: grid.meta.min,
          max: grid.meta.max,
          ...(grid.meta.rainWindowH != null ? { rainWindowH: grid.meta.rainWindowH } : {}),
        })
        seenFields.add(fieldMap.id)
        continue
      }

      const targetEntries = []
      if (fieldMap.pairWith) {
         const param1 = ECMWF_FIELDS.find(f => f.id === fieldMap.id && f.number === 2).param // u component
         const param2 = ECMWF_FIELDS.find(f => f.id === fieldMap.id && f.number === 3).param // v component
         const levTypeKey = fieldMap.levelType === 103 ? 'sfc' : 'pl'
         const levVal = fieldMap.levelValue / 100

         const entryU = indexEntries.find(e => e.param === param1 && e.levtype === levTypeKey && (levTypeKey === 'pl' ? e.levelist == levVal : true))
         const entryV = indexEntries.find(e => e.param === param2 && e.levtype === levTypeKey && (levTypeKey === 'pl' ? e.levelist == levVal : true))

         if (entryU) targetEntries.push({ ...ECMWF_FIELDS.find(f => f.id === fieldMap.id && f.param === param1), entry: entryU })
         if (entryV) targetEntries.push({ ...ECMWF_FIELDS.find(f => f.id === fieldMap.id && f.param === param2), entry: entryV })
      } else {
         const levTypeKey = fieldMap.levelType === 100 ? 'pl' : 'sfc'
         const levVal = fieldMap.levelValue / 100
         const entry = indexEntries.find(e => e.param === fieldMap.param && e.levtype === levTypeKey && (levTypeKey === 'pl' ? e.levelist == levVal : true))
         if (entry) targetEntries.push({ ...fieldMap, entry })
      }

      if (targetEntries.length === 0 || (fieldMap.pairWith && targetEntries.length < 2)) {
         continue
      }

      const planes = []
      let validTimeIso = null
      let referenceTimeIso = null

      for (const t of targetEntries) {
         const range = `${t.entry._offset}-${t.entry._offset + t.entry._length - 1}`
         await sleep(1000)
         const gribRes = await fetchWithRetry(grib2Url, range, fetchImpl)
         totalRequests++
         if (!gribRes || !gribRes.ok) continue

         const buf = new Uint8Array(await gribRes.arrayBuffer())
         totalBytes += buf.length

         let decoded
         try {
           decoded = decodeGrib2(buf)
         } catch (e) {
           console.error(`[ECMWF] Decode failed for field ${fieldMap.id} (param ${t.entry.param} step ${step}):`, e?.message || e)
           throw e
         }
         if (!decoded || !decoded.fields || decoded.fields.length === 0) continue

         const field = decoded.fields[0]

         const { values } = cropIfsToGfs(field, t.conversion)
         planes.push(values)
         validTimeIso = field.validTimeIso
         referenceTimeIso = field.referenceTimeIso
      }

      if (planes.length !== def.planes) continue

      const convRes = convertEcmwfFieldPlanes({
        fieldId: fieldMap.id,
        stepHours: step,
        planes,
        referenceTimeIso,
        validTimeIso,
        lastTp,
        lastCp,
        box: FORECAST_BOX,
      })
      if (!convRes) continue
      if (convRes.lastTp !== undefined) lastTp = convRes.lastTp
      if (convRes.lastCp !== undefined) lastCp = convRes.lastCp

      atomicWrite(outFile, convRes.wgr1)

      stepFiles.push({
        fieldId: def.id,
        stepHours: step,
        unit: def.unit,
        levelLabel: def.levelLabel,
        bytes: convRes.wgr1.length,
        min: convRes.min,
        max: convRes.max,
        ...(convRes.rainWindowH != null ? { rainWindowH: convRes.rainWindowH } : {}),
      })
      seenFields.add(fieldMap.id)
    }

    // If both conv3 and cape are available at this step, compute thunder diagnostic
    const hasConv3 = stepFiles.some(f => f.fieldId === 'conv3' && f.stepHours === step)
    const hasCape = stepFiles.some(f => f.fieldId === 'cape' && f.stepHours === step)
    if (hasConv3 && hasCape) {
      const thundrOut = path.join(outDir, 'thundr', `${step}.wgr1`)
      if (fs.existsSync(thundrOut)) {
        const buf = fs.readFileSync(thundrOut)
        const grid = decodeWgr1(buf)
        stepFiles.push({
          fieldId: 'thundr',
          stepHours: step,
          bytes: buf.length,
          min: grid.meta.min,
          max: grid.meta.max,
        })
        seenFields.add('thundr')
      } else {
        const convBuf = fs.readFileSync(path.join(outDir, 'conv3', `${step}.wgr1`))
        const capeBuf = fs.readFileSync(path.join(outDir, 'cape', `${step}.wgr1`))
        const convDec = decodeWgr1(convBuf)
        const capeDec = decodeWgr1(capeBuf)
        const thundrRes = computeEcmwfThunder({
          conv3Decoded: convDec,
          capeDecoded: capeDec,
          box: FORECAST_BOX,
        })
        const thundrDef = packFieldById('thundr')
        atomicWrite(thundrOut, thundrRes.wgr1)
        stepFiles.push({
          fieldId: 'thundr',
          stepHours: step,
          unit: thundrDef.unit,
          levelLabel: thundrDef.levelLabel,
          bytes: thundrRes.bytes,
          min: thundrRes.min,
          max: thundrRes.max,
        })
        seenFields.add('thundr')
      }
    }

    if (!seenFields.has('wind10') || !seenFields.has('temp2')) {
      cycleOk = false
      break
    }

    for (const f of stepFiles) convertedFiles.push(f)
  }

  if (!cycleOk || convertedFiles.length === 0) return

  // If subsequent steps produced rain3/conv3/thundr but step 0 lacks them,
  // synthesize zero-filled step 0 entries for consistency.
  const hasRain3 = convertedFiles.some((f) => f.fieldId === 'rain3')
  const hasStep0Rain3 = convertedFiles.some((f) => f.fieldId === 'rain3' && f.stepHours === 0)
  if (hasRain3 && !hasStep0Rain3) {
    const sample0 = convertedFiles.find((f) => f.stepHours === 0)
    if (sample0) {
      const decoded0 = decodeWgr1(fs.readFileSync(path.join(outDir, sample0.fieldId, '0.wgr1')))
      const synth = synthesizeEcmwfStep0({
        sampleMeta: decoded0.meta,
        hasRain3,
        hasThundr: convertedFiles.some((f) => f.fieldId === 'thundr'),
      })
      for (const item of synth) {
        atomicWrite(path.join(outDir, item.fieldId, '0.wgr1'), item.wgr1)
        convertedFiles.push(item)
      }
    }
  }

  // Publish
  const index = buildPackIndex({
    modelId: pack.modelId,
    cycleUtc,
    generatedAtMs: Date.now(),
    bbox: { minLat: FORECAST_BOX.minLat, maxLat: FORECAST_BOX.maxLat, minLon: FORECAST_BOX.minLon, maxLon: FORECAST_BOX.maxLon },
    grid: { nx: GFS_NI, ny: GFS_NJ, dx: 0.25, dy: 0.25 },
    steps,
    fields: convertedFiles
  })

  atomicWrite(path.join(outDir, 'index.json'), JSON.stringify(index, null, 2))

  // Cleanup old cycles
  const published = pack.listCycleDirs().filter((d) => fs.existsSync(path.join(pack.root, d, 'index.json')))
  for (const old of published.slice(0, Math.max(0, published.length - KEEP_CYCLES))) {
    fs.rmSync(path.join(pack.root, old), { recursive: true, force: true })
  }

  console.log(`[ECMWF] Published cycle ${cycleUtc}, ${totalRequests} requests, ${totalBytes} bytes`)
}

export function startEcmwfRefresh(pack, fetchImpl = globalThis.fetch) {
  let running = false
  async function tick() {
    if (process.env.WXREGIONCUT_ECMWF === '0') return
    if (running) return
    running = true
    try {
      await refreshCycle(pack, fetchImpl)
    } catch (e) {
      console.error('[ECMWF Refresh] Failed:', e)
    } finally {
      running = false
    }
  }
  setInterval(tick, 30 * 60 * 1000)
  setTimeout(tick, 5000)
}
