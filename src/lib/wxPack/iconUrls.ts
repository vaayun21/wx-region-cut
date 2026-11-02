/**
 * src/lib/wxPack/iconUrls.ts
 *
 * Pure URL builder, step/run formatters, and fallback fetch logic for DWD ICON model data.
 * Supports both DWD's v1 layout (operational since late 2026) and legacy layout (discontinued after 2026-11-30).
 *
 * Shared between laptop pack builder (server/wxPackIcon.mjs) and device (src/lib/wxPack/iconDownloader.ts).
 * Pure: no Node-only imports (fs, path, Buffer).
 */

export interface BuildIconUrlsOptions {
  cycleUtc: string
  varName: string
  varDir?: string
  stepHours?: number
}

export interface IconUrls {
  newUrl: string
  oldUrl: string
}

/**
 * Format cycle UTC timestamp into DWD v1 ISO run format with colon URL-encoded as %3A.
 * E.g. '2026-11-02T00:00:00Z' -> '2026-11-02T00%3A00'
 */
export function formatIconRunIso(cycleUtc: string): string {
  if (cycleUtc.includes('%3A')) {
    return cycleUtc.slice(0, 18)
  }
  const datePart = cycleUtc.slice(0, 10)
  const hourPart = cycleUtc.slice(11, 13)
  return `${datePart}T${hourPart}%3A00`
}

/**
 * Format forecast step hours to 3-digit zero-padded string.
 * E.g. 0 -> '000', 24 -> '024', 120 -> '120'
 */
export function formatIconStep(stepHours: number = 0): string {
  const h = Math.max(0, Math.round(Number.isFinite(stepHours) ? stepHours : 0))
  return String(h).padStart(3, '0')
}

/**
 * Builds both the new DWD OpenData URL (v1) and legacy URL for a variable or coordinate file.
 */
export function buildIconUrls({
  cycleUtc,
  varName,
  varDir,
  stepHours = 0,
}: BuildIconUrlsOptions): IconUrls {
  const isCoord = varName === 'CLAT' || varName === 'CLON'
  const effectiveVarDir = varDir || varName.toLowerCase()
  const sss = formatIconStep(stepHours)
  const runIso = formatIconRunIso(cycleUtc)

  const newUrl = isCoord
    ? `https://opendata.dwd.de/weather/nwp/v1/m/icon/p/${varName}/r/${runIso}/s/PT000H00M.grib2`
    : `https://opendata.dwd.de/weather/nwp/v1/m/icon/p/${varName}/r/${runIso}/s/PT${sss}H00M.grib2`

  let oldUrl: string
  if (isCoord) {
    const tag00 = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}00`
    oldUrl = `https://opendata.dwd.de/weather/nwp/icon/grib/00/${effectiveVarDir}/icon_global_icosahedral_time-invariant_${tag00}_${varName}.grib2.bz2`
  } else {
    const hh = cycleUtc.slice(11, 13)
    const tag = `${cycleUtc.slice(0, 4)}${cycleUtc.slice(5, 7)}${cycleUtc.slice(8, 10)}${hh}`
    oldUrl = `https://opendata.dwd.de/weather/nwp/icon/grib/${hh}/${effectiveVarDir}/icon_global_icosahedral_single-level_${tag}_${sss}_${varName}.grib2.bz2`
  }

  return { newUrl, oldUrl }
}

/**
 * Detects whether payload is bzip2 compressed.
 * If first 4 bytes are 'GRIB', it is uncompressed GRIB2 (not bzip2).
 * If first 3 bytes are 'BZh', it is bzip2.
 * If url ends with .bz2 and payload is not GRIB, it is bzip2.
 */
export function isBzip2(bytes: Uint8Array, url?: string): boolean {
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x52 && bytes[2] === 0x49 && bytes[3] === 0x42) {
    return false
  }
  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return true
  }
  if (url && (url.endsWith('.bz2') || url.includes('.bz2?'))) {
    return true
  }
  return false
}

export interface FetchIconWithFallbackOptions<T = Response> {
  newUrl: string
  oldUrl: string
  fetchFn: (url: string) => Promise<T>
  isOk?: (res: T) => boolean
}

export interface FetchIconWithFallbackResult<T = Response> {
  res: T
  url: string
  usedFallback: boolean
}

/**
 * Attempts fetch on newUrl first. If it responds with !ok or throws an error,
 * falls back to oldUrl. If both fail, throws an error detailing both failures.
 */
export async function fetchIconWithFallback<T = Response>({
  newUrl,
  oldUrl,
  fetchFn,
  isOk = (r: T) => (r && typeof (r as { ok?: boolean }).ok === 'boolean' ? Boolean((r as { ok?: boolean }).ok) : Boolean(r)),
}: FetchIconWithFallbackOptions<T>): Promise<FetchIconWithFallbackResult<T>> {
  let newErr: unknown = null
  try {
    const res = await fetchFn(newUrl)
    if (isOk(res)) {
      return { res, url: newUrl, usedFallback: false }
    }
    const status = (res as { status?: number })?.status
    newErr = new Error(`HTTP ${status ?? 'unknown'}`)
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err
    newErr = err
  }

  try {
    const res = await fetchFn(oldUrl)
    if (isOk(res)) {
      return { res, url: oldUrl, usedFallback: true }
    }
    const status = (res as { status?: number })?.status
    const newErrMsg = newErr instanceof Error ? newErr.message : String(newErr)
    throw new Error(`new address failed (${newErrMsg}), fallback HTTP ${status ?? 'unknown'}`)
  } catch (oldErr) {
    if (oldErr instanceof DOMException && oldErr.name === 'AbortError') throw oldErr
    const newErrMsg = newErr instanceof Error ? newErr.message : String(newErr)
    const oldErrMsg = oldErr instanceof Error ? oldErr.message : String(oldErr)
    throw new Error(`fetchIconWithFallback failed: new address ${newUrl} (${newErrMsg}); fallback ${oldUrl} (${oldErrMsg})`)
  }
}
