// Pure scheduling decisions for the cutter workflow. No network, no clock.

const MODEL_ORDER = ['ecmwf', 'icon']

function sameCycle(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Date.parse(a)
  const right = Date.parse(b)
  if (Number.isFinite(left) && Number.isFinite(right)) return left === right
  return a === b
}

/**
 * Models whose newest complete cycle is not already published.
 * Published cycles are ISO strings; a model with no complete cycle is skipped.
 * @param {{
 *   nowMs: number,
 *   published: { ecmwf?: string[], icon?: string[] },
 *   newestComplete: { ecmwf?: string | null, icon?: string | null },
 * }} input
 * @returns {string[]}
 */
export function decideWork({ nowMs, published = {}, newestComplete = {} }) {
  if (!Number.isFinite(nowMs)) return []
  const chosen = []
  for (const model of MODEL_ORDER) {
    const newest = newestComplete?.[model] ?? null
    if (!newest) continue
    const already = Array.isArray(published?.[model]) ? published[model] : []
    if (already.some((cycle) => sameCycle(cycle, newest))) continue
    chosen.push(model)
  }
  return chosen
}

/**
 * Release tags older than keepDays, never the rolling `latest` tag.
 * A release exactly at the boundary is still inside the window.
 * @param {{
 *   nowMs: number,
 *   releases: { tag: string, createdAtMs: number }[],
 *   keepDays?: number,
 * }} input
 * @returns {string[]}
 */
export function retentionDeletes({ nowMs, releases, keepDays = 3 }) {
  if (!Number.isFinite(nowMs) || !Array.isArray(releases)) return []
  const keepMs = keepDays * 24 * 60 * 60 * 1000
  const out = []
  for (const release of releases) {
    if (!release || release.tag === 'latest') continue
    if (!Number.isFinite(release.createdAtMs)) continue
    if (nowMs - release.createdAtMs > keepMs) out.push(release.tag)
  }
  return out
}
