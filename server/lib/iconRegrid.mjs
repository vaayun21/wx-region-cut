/**
 * Node wrapper for pure iconRegrid functions, providing disk-cached lookup generation.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  FORECAST_GRID,
  DEG_TO_RAD,
  RAD_TO_DEG,
  LOOKUP_MAGIC,
  LOOKUP_VERSION,
  buildSpatialIndex,
  findNearestCell,
  findNearestBruteForce,
  buildRegridLookup,
  encodeLookup,
  decodeLookup,
  regridField,
  timeUnitHours,
  decodeIconGrib2,
} from '../../src/lib/wxPack/iconRegrid.ts'

export {
  FORECAST_GRID,
  DEG_TO_RAD,
  RAD_TO_DEG,
  LOOKUP_MAGIC,
  LOOKUP_VERSION,
  buildSpatialIndex,
  findNearestCell,
  findNearestBruteForce,
  buildRegridLookup,
  encodeLookup,
  decodeLookup,
  regridField,
  timeUnitHours,
  decodeIconGrib2,
}

/**
 * Loads lookup from cache if present and valid; otherwise builds, caches, and returns it.
 * @param {{cachePath: string, cellLats?: Float32Array, cellLons?: Float32Array, gridIdentity: string, targetGrid?: import('../../src/lib/wxPack/iconRegrid.ts').ForecastGrid}} options
 * @returns {Uint32Array}
 */
export function getOrBuildLookup({ cachePath, cellLats, cellLons, gridIdentity, targetGrid = FORECAST_GRID }) {
  if (cachePath && fs.existsSync(cachePath)) {
    try {
      const bytes = fs.readFileSync(cachePath)
      const { meta, lookup } = decodeLookup(bytes)
      if (
        meta.gridIdentity === gridIdentity &&
        meta.nx === targetGrid.nx &&
        meta.ny === targetGrid.ny &&
        meta.minLat === targetGrid.minLat &&
        meta.minLon === targetGrid.minLon
      ) {
        return lookup
      }
    } catch {
      // Cache invalid or corrupt, rebuild
    }
  }

  const lookup = buildRegridLookup(cellLats, cellLons, targetGrid)
  if (cachePath) {
    const meta = {
      gridIdentity,
      nx: targetGrid.nx,
      ny: targetGrid.ny,
      minLat: targetGrid.minLat,
      maxLat: targetGrid.maxLat,
      minLon: targetGrid.minLon,
      maxLon: targetGrid.maxLon,
      dLat: targetGrid.dLat,
      dLon: targetGrid.dLon,
      builtAtMs: Date.now(),
    }
    const encoded = encodeLookup(lookup, meta)
    const tmp = `${cachePath}.tmp-${process.pid}-${Date.now()}`
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    fs.writeFileSync(tmp, encoded)
    fs.renameSync(tmp, cachePath)
  }
  return lookup
}
