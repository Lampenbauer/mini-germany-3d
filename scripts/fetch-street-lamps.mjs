#!/usr/bin/env node
/**
 * Fetches Rostock's street lamps from OpenStreetMap (Overpass API) and
 * writes the ones standing along the transit routes to
 * src/data/street-lamps.json – the source for the night-time light pools
 * on the map (see src/map/StreetLampsLayer.ts).
 *
 * Rostock's lamps come from an official open-data import
 * (source=OpenData.HRO, lamp_operator=Hansestadt Rostock), so this is the
 * real lighting of the real streets, not a decorative sprinkle.
 *
 * Each lamp keeps a terrain height in meters NHN from the same DGM the
 * route heights use, so the pools sit on the ground the routes run on.
 * Lamps beside a bridge or tunnel section are skipped: there the route's
 * height profile is the deck (or the surface above the tube) and not the
 * ground a lamp beside it stands on.
 *
 *   npm run data:lamps
 *
 * Run AFTER data:update + data:simplify (the selection is relative to the
 * final route geometry).
 *
 * Environment variables:
 *   OVERPASS_URL   – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE  – local JSON file with a saved Overpass response
 *   NETWORK_OUT    – alternative network.json path
 *   LAMPS_OUT      – alternative output path
 *   PREV_LAMPS     – previously generated street-lamps.json (e.g. the git
 *                    HEAD version in CI): lamps with identical coordinates
 *                    reuse their height, so an unchanged set causes zero
 *                    WCS requests
 *   DGM_WCS_URL    – alternative WCS endpoint
 *   DGM_COVERAGE   – coverage id (default mv_dgm5, the 5 m grid)
 *
 * Data licenses: © OpenStreetMap contributors, ODbL 1.0 (lamp positions);
 * © GeoBasis-DE/M-V (terrain heights).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DgmSampler } from './lib/dgm.mjs'
import { BBOX, postOverpass } from './lib/overpass.mjs'
import { selectLampsAlongRoutes } from './lib/street-lamps.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const NETWORK = process.env.NETWORK_OUT
  ? resolve(process.env.NETWORK_OUT)
  : resolve(__dirname, '../src/data/network.json')
const OUT = process.env.LAMPS_OUT
  ? resolve(process.env.LAMPS_OUT)
  : resolve(__dirname, '../src/data/street-lamps.json')

/**
 * How far beside a route path a lamp may stand to count as lighting it.
 * 25 m covers both sides of a wide street plus its parking lanes without
 * pulling in the lamps of the next street over.
 */
const MAX_DISTANCE_METERS = 25

/**
 * Minimum spacing between two kept lamps. Rostock's import has both sides
 * of a street, often offset, which puts lamps ~15 m apart along the route;
 * that is the real lighting and it stays.
 */
const MIN_SPACING_METERS = 0

const ATTRIBUTION =
  'Street lamps © OpenStreetMap contributors (ODbL). ' +
  'Terrain heights © GeoBasis-DE/M-V (DGM via WCS, geodaten-mv.de).'

/** 5 decimals ≈ 1 m – far below what a light pool on the ground resolves. */
const round5 = (v) => Math.round(v * 1e5) / 1e5
const round1 = (v) => Math.round(v * 10) / 10

const QUERY =
  `[out:json][timeout:300];node["highway"="street_lamp"](${BBOX});out skel qt;`

async function fetchLampNodes() {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  return postOverpass(QUERY)
}

/** "lon:lat" → height, from a previously generated file. */
function indexPreviousHeights() {
  const index = new Map()
  if (!process.env.PREV_LAMPS) return index
  try {
    const prev = JSON.parse(readFileSync(resolve(process.env.PREV_LAMPS), 'utf8'))
    for (const [lon, lat, nhn] of prev.lamps ?? []) index.set(`${lon}:${lat}`, nhn)
  } catch (err) {
    console.warn(`⚠ PREV_LAMPS not usable (${err.message}) – sampling everything fresh`)
  }
  return index
}

async function main() {
  const network = JSON.parse(readFileSync(NETWORK, 'utf8'))
  const data = await fetchLampNodes()
  const nodes = (data.elements ?? []).filter((el) => el.type === 'node')
  console.log(`${nodes.length} street lamps in the Rostock bounding box`)

  const selected = selectLampsAlongRoutes(
    nodes.map((n) => [round5(n.lon), round5(n.lat)]),
    network,
    { maxDistanceMeters: MAX_DISTANCE_METERS, minSpacingMeters: MIN_SPACING_METERS },
  )
  console.log(
    `${selected.length} of them stand within ${MAX_DISTANCE_METERS} m of a route`,
  )
  if (selected.length === 0) {
    throw new Error('No lamp matched a route – is network.json up to date?')
  }

  const sampler = new DgmSampler()
  const previous = indexPreviousHeights()
  const lamps = []
  let reused = 0
  let withoutHeight = 0
  let minH = Infinity
  let maxH = -Infinity
  for (const [lon, lat] of selected) {
    const cached = previous.get(`${lon}:${lat}`)
    let nhn = cached
    if (nhn === undefined) {
      const sampled = await sampler.heightAt(lon, lat)
      nhn = sampled === undefined ? undefined : round1(sampled)
    } else {
      reused++
    }
    // No terrain height means no idea where the ground is – a pool at a
    // guessed height cuts into the street or floats above it, so the lamp
    // is dropped instead.
    if (nhn === undefined) {
      withoutHeight++
      continue
    }
    lamps.push([lon, lat, nhn])
    if (nhn < minH) minH = nhn
    if (nhn > maxH) maxH = nhn
  }

  const out = {
    meta: {
      generated: new Date().toISOString().slice(0, 10),
      attribution: ATTRIBUTION,
      maxDistanceMeters: MAX_DISTANCE_METERS,
      minSpacingMeters: MIN_SPACING_METERS,
    },
    lamps,
  }
  // One lamp per line: a 7000-entry file stays diffable, and the nightly
  // commit shows which lamps actually changed.
  const body =
    '{\n' +
    `  "meta": ${JSON.stringify(out.meta, null, 2).replace(/\n/g, '\n  ')},\n` +
    '  "lamps": [\n' +
    lamps.map((l) => `    ${JSON.stringify(l)}`).join(',\n') +
    '\n  ]\n}\n'
  writeFileSync(OUT, body, 'utf8')

  const { tiles, bytes, failedTiles } = sampler.stats
  console.log(
    `\n✅ ${OUT}: ${lamps.length} street lamps, ` +
      `heights ${minH.toFixed(1)}–${maxH.toFixed(1)} m NHN`,
  )
  if (reused > 0) console.log(`   Reused from PREV_LAMPS: ${reused} height(s)`)
  if (withoutHeight > 0) {
    console.log(`   Dropped without DGM height: ${withoutHeight}`)
  }
  console.log(
    `   DGM: ${tiles} WCS tiles, ${(bytes / 1024 / 1024).toFixed(1)} MB` +
      (failedTiles > 0 ? `, ${failedTiles} tile(s) FAILED` : ''),
  )
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
