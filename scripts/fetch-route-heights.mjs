#!/usr/bin/env node
/**
 * Enriches src/cities/<slug>/network.json with terrain heights from
 * Mapterhorn (see lib/terrain.mjs – Terrarium tiles built from the open
 * 1 m terrain models of the German states):
 *   - per direction a `heights` array (meters NHN/DHHN2016, one entry per
 *     path vertex; bridge sections become a straight deck interpolated
 *     between anchors just outside the span, plus ~1 m feathered deck
 *     clearance – see BRIDGE_PROFILE_DEFAULTS in lib/route-heights.mjs)
 *   - per stop an `nhn` height – the runtime calibrates the offset between
 *     NHN and the Google 3D tiles' ellipsoidal heights against these
 *
 * The heights let the app draw route polylines at absolute heights instead
 * of clamping them onto the 3D tiles, which avoids Cesium's per-frame
 * ground-classification passes (measurable, permanent GPU load).
 *
 * Run AFTER data:update + data:simplify (heights are per final vertex):
 *   npm run data:heights -- --city rostock     (no --city: every city)
 *
 * Environment variables:
 *   CITY          – the city, like --city
 *   NETWORK_OUT   – alternative network.json path (one city only)
 *   PREV_NETWORK  – previously enriched network.json (e.g. the git HEAD
 *                   version in CI): directions with identical geometry and
 *                   stops with identical coordinates reuse their heights,
 *                   so an unchanged network fetches no tiles at all – as
 *                   long as the file names the same terrain source; after
 *                   a source change the whole city is sampled afresh once
 *
 * Data license: the city's terrain attribution (city.json) – Mapterhorn
 * and the state model it is built from (attribution required, no fees).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { createTerrainSampler, terrainAttribution, terrainSummary } from './lib/terrain.mjs'
import {
  applyBridgeProfile,
  cumulativeDistances,
  fillHeightGaps,
  indexPreviousHeights,
  normalizeRanges,
  sameTerrainSource,
  withTerrainAttribution,
} from './lib/route-heights.mjs'

const round1 = (v) => Math.round(v * 10) / 10

async function main(city, paths) {
  const FILE = process.env.NETWORK_OUT ? resolve(process.env.NETWORK_OUT) : paths.network
  const HEIGHTS_ATTRIBUTION = terrainAttribution(city)
  const network = JSON.parse(readFileSync(FILE, 'utf8'))
  const sampler = createTerrainSampler(city)

  let prev = null
  if (process.env.PREV_NETWORK) {
    try {
      prev = JSON.parse(readFileSync(resolve(process.env.PREV_NETWORK), 'utf8'))
    } catch (err) {
      console.warn(`⚠ PREV_NETWORK not usable (${err.message}) – sampling everything fresh`)
    }
  }
  if (prev && !sameTerrainSource(prev, HEIGHTS_ATTRIBUTION)) {
    console.log('PREV_NETWORK holds heights from another terrain source – sampling everything fresh')
    prev = null
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
        // Water: the terrain model has no meaningful height mid-river; ferries ride
        // at the city's water level (0 m NHN on tidal Baltic or Elbe water).
        dir.heights = dir.path.map(() => city.terrain.waterLevelNhn)
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
          `Line ${line.id} (${dir.from} → ${dir.to}): no terrain heights at all – ` +
            'terrain source unreachable or outside coverage; network.json left unchanged',
        )
      }
      if (missing > 0) {
        const pct = ((missing / heights.length) * 100).toFixed(1)
        console.warn(
          `  ⚠ Line ${line.id} (${dir.from} → ${dir.to}): ` +
            `${missing} of ${heights.length} vertices without terrain data (${pct} %) – interpolated`,
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

  network.meta = withTerrainAttribution(network.meta, HEIGHTS_ATTRIBUTION)

  writeFileSync(FILE, JSON.stringify(network, null, 2) + '\n', 'utf8')
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
  console.log(`   Terrain: ${terrainSummary(sampler)}`)
  console.log('Tip: npm test validates the enriched dataset.')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity(main).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
