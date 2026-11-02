// Small mtime+size keyed caches for server-side work that used to run on every
// request. Each helper is pure with respect to its arguments, so it can be
// tested without starting the HTTP server.

const MAX_ENTRIES = 64
const MAX_CACHED_BYTES = 8 * 1024 * 1024

const gzipCache = new Map()
const jsonCache = new Map()
const hashCache = new Map()

function remember(cache, key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    cache.delete(oldest)
  }
}

function unchanged(entry, stat) {
  return entry !== undefined && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size
}

/**
 * Gzipped bytes for a static file, reused while its mtime and size are
 * unchanged. Files over 8 MB are compressed but never cached.
 */
export function getGzipped(filePath, stat, readFile, gzip) {
  const cached = gzipCache.get(filePath)
  if (unchanged(cached, stat)) return cached.gz
  const gz = gzip(readFile(filePath))
  if (stat.size <= MAX_CACHED_BYTES) {
    remember(gzipCache, filePath, { mtimeMs: stat.mtimeMs, size: stat.size, gz })
  } else {
    gzipCache.delete(filePath)
  }
  return gz
}

/**
 * Parsed JSON reused while the file's mtime and size are unchanged. A read or
 * parse error is thrown and nothing is cached.
 */
export function readJsonCached(filePath, stat, readFile, parse) {
  const cached = jsonCache.get(filePath)
  if (unchanged(cached, stat)) return cached.value
  const value = parse(readFile(filePath))
  remember(jsonCache, filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value })
  return value
}

/**
 * Content hash for an ETag, reused while mtime and size are unchanged. The
 * file bytes are kept too when small, so repeat requests read nothing.
 */
export function hashFileCached(filePath, stat, readFile, hash) {
  const cached = hashCache.get(filePath)
  if (unchanged(cached, stat)) {
    return { hash: cached.hash, bytes: cached.bytes ?? readFile(filePath) }
  }
  const bytes = readFile(filePath)
  const value = hash(bytes)
  remember(hashCache, filePath, {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: value,
    bytes: stat.size <= MAX_CACHED_BYTES ? bytes : null,
  })
  return { hash: value, bytes }
}
