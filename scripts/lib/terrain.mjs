/**
 * The terrain sampler a city's definition asks for (city.json `terrain`):
 *   wcs-geotiff  a WCS 2.0.1 serving float32 GeoTIFF tiles (Rostock: the
 *                Mecklenburg-Vorpommern DGM5 at geodaten-mv.de)
 *   xyz-zip      a downloadable zip of ASCII XYZ tiles (Hamburg: the DGM10
 *                from the Transparenzportal)
 *   none         no heights – the app clamps the routes onto the tiles
 *
 * Both samplers answer heightAt(lon, lat) in meters NHN and keep `stats`
 * for the run's summary line.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DgmSampler } from './dgm.mjs'
import { XyzZipSampler } from './xyz-terrain.mjs'

const CACHE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../.cache')

/** A sampler for the city, or null when it has no terrain provider. */
export function createTerrainSampler(city) {
  const terrain = city.terrain
  switch (terrain.provider) {
    case 'wcs-geotiff':
      return new DgmSampler({ endpoint: terrain.url, coverageId: terrain.coverage, crs: terrain.crs })
    case 'xyz-zip':
      if (!terrain.url) throw new Error(`${city.name}: terrain.url is required for the xyz-zip provider`)
      return new XyzZipSampler({
        url: terrain.url,
        cacheFile: resolve(CACHE_DIR, `terrain-${city.slug}.zip`),
        crs: terrain.crs,
        tileSizeMeters: terrain.tileSizeMeters,
        gridMeters: terrain.gridMeters,
      })
    default:
      return null
  }
}

/** One line for the run summary: what was fetched from where. */
export function terrainSummary(sampler) {
  const { tiles, bytes, failedTiles } = sampler.stats
  return (
    `${tiles} terrain tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB` +
    (failedTiles > 0 ? `, ${failedTiles} tile(s) FAILED` : '')
  )
}
