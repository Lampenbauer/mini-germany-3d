#!/usr/bin/env node
/**
 * Enriches src/data/network.json with terrain heights from the official
 * digital terrain model of Mecklenburg-Vorpommern (open WCS at
 * geodaten-mv.de, © GeoBasis-DE/M-V):
 *   - per direction a `heights` array (meters NHN/DHHN2016, one entry per
 *     path vertex, bridge sections interpolated between their end points)
 *   - per stop an `nhn` height – the runtime calibrates the offset between
 *     NHN and the Google 3D tiles' ellipsoidal heights against these
 *
 * The heights let the app draw route polylines at absolute heights instead
 * of clamping them onto the 3D tiles, which avoids Cesium's per-frame
 * ground-classification passes (measurable, permanent GPU load).
 *
 * Run AFTER data:update + data:simplify (heights are per final vertex):
 *   npm run data:heights
 *
 * Environment variables:
 *   NETWORK_OUT   – alternative network.json path
 *   PREV_NETWORK  – previously enriched network.json (e.g. the git HEAD
 *                   version in CI): directions with identical geometry and
 *                   stops with identical coordinates reuse their heights,
 *                   so unchanged networks cause zero WCS requests
 *   DGM_WCS_URL   – alternative WCS endpoint
 *   DGM_COVERAGE  – coverage id (default mv_dgm5, the 5 m grid)
 *
 * Data license: © GeoBasis-DE/M-V (source attribution required, no fees).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DgmSampler } from './lib/dgm.mjs'
import {
  applyBridgeProfile,
  cumulativeDistances,
  fillHeightGaps,
  indexPreviousHeights,
  normalizeRanges,
} from './lib/route-heights.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.NETWORK_OUT
  ? resolve(process.env.NETWORK_OUT)
  : resolve(__dirname, '../src/data/network.json')

const HEIGHTS_ATTRIBUTION =
  'Terrain heights © GeoBasis-DE/M-V (DGM via WCS, geodaten-mv.de).'

const round1 = (v) => Math.round(v * 10) / 10

async function main() {
  const network = JSON.parse(readFileSync(FILE, 'utf8'))
  const sampler = new DgmSampler()

  let prev = null
  if (process.env.PREV_NETWORK) {
    try {
      prev = JSON.parse(readFileSync(resolve(process.env.PREV_NETWORK), 'utf8'))
    } catch (err) {
      console.warn(`⚠ PREV_NETWORK not usable (${err.message}) – sampling everything fresh`)
    }
  }
  const { heightsByPath, nhnByStop } = indexPreviousHeights(prev)

  let vertexCount = 0
  let filledCount = 0
  let reusedDirs = 0
  let minH = Infinity
  let maxH = -Infinity

  for (const line of network.lines) {
    for (const dir of line.directions) {
      const reused = heightsByPath.get(JSON.stringify(dir.path))
      if (reused) {
        dir.heights = reused
        reusedDirs++
        vertexCount += reused.length
        for (const h of reused) {
          if (h < minH) minH = h
          if (h > maxH) maxH = h
        }
        continue
      }
      if (line.mode === 'ferry') {
        // Water: the DGM has no meaningful height mid-river; ferries ride
        // at sea level (0 m NHN – the Unterwarnow is tidal Baltic water).
        dir.heights = dir.path.map(() => 0)
        continue
      }
      const cum = cumulativeDistances(dir.path)
      const heights = []
      for (const [lon, lat] of dir.path) {
        heights.push(await sampler.heightAt(lon, lat))
      }
      const missing = heights.filter((h) => h === undefined).length
      const filled = fillHeightGaps(heights, cum)
      if (filled === -1) {
        throw new Error(
          `Line ${line.id} (${dir.from} → ${dir.to}): no DGM heights at all – ` +
            'WCS unreachable or outside coverage; network.json left unchanged',
        )
      }
      if (missing > 0) {
        const pct = ((missing / heights.length) * 100).toFixed(1)
        console.warn(
          `  ⚠ Line ${line.id} (${dir.from} → ${dir.to}): ` +
            `${missing} of ${heights.length} vertices without DGM data (${pct} %) – interpolated`,
        )
      }
      applyBridgeProfile(heights, cum, normalizeRanges(dir.bridges, cum[cum.length - 1]))
      dir.heights = heights.map(round1)
      vertexCount += heights.length
      filledCount += filled
      for (const h of dir.heights) {
        if (h < minH) minH = h
        if (h > maxH) maxH = h
      }
    }
  }

  let stopCount = 0
  let reusedStops = 0
  for (const [id, stop] of Object.entries(network.stops)) {
    const reused = nhnByStop.get(`${id}:${stop.coord[0]}:${stop.coord[1]}`)
    if (reused !== undefined) {
      stop.nhn = reused
      stopCount++
      reusedStops++
      continue
    }
    const h = await sampler.heightAt(stop.coord[0], stop.coord[1])
    if (h !== undefined) {
      stop.nhn = round1(h)
      stopCount++
    } else {
      delete stop.nhn
    }
  }

  if (!network.meta.attribution.includes('GeoBasis-DE/M-V')) {
    network.meta.attribution = `${network.meta.attribution} ${HEIGHTS_ATTRIBUTION}`
  }

  writeFileSync(FILE, JSON.stringify(network, null, 2) + '\n', 'utf8')
  const { tiles, bytes, failedTiles } = sampler.stats
  console.log(
    `\n✅ ${FILE}: heights for ${vertexCount} route vertices ` +
      `(${filledCount} interpolated) and ${stopCount} stops, ` +
      `range ${minH.toFixed(1)}–${maxH.toFixed(1)} m NHN`,
  )
  if (reusedDirs > 0 || reusedStops > 0) {
    console.log(
      `   Reused from PREV_NETWORK: ${reusedDirs} direction(s), ${reusedStops} stop(s) (unchanged geometry)`,
    )
  }
  console.log(
    `   DGM: ${tiles} WCS tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB` +
      (failedTiles > 0 ? `, ${failedTiles} tile(s) FAILED` : ''),
  )
  console.log('Tip: npm test validates the enriched dataset.')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
