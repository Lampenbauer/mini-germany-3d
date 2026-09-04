#!/usr/bin/env node
/**
 * Fetches a city's street lamps from OpenStreetMap (Overpass API) and
 * writes the ones standing along the transit routes to
 * src/cities/<slug>/street-lamps.json – the source for the night-time
 * light pools on the map (see src/map/StreetLampsLayer.ts).
 *
 * Only for cities that ask for it (city.json `lamps.enabled`) and have a
 * terrain provider: Rostock's lamps come from an official open-data
 * import (source=OpenData.HRO, lamp_operator=Hansestadt Rostock), so this
 * is the real lighting of the real streets, not a decorative sprinkle –
 * a city whose OSM lamps are patchy is better off without the layer.
 *
 * Each lamp keeps a terrain height in meters NHN from the same DGM the
 * route heights use, so the pools sit on the ground the routes run on.
 * Lamps beside a bridge or tunnel section are skipped: there the route's
 * height profile is the deck (or the surface above the tube) and not the
 * ground a lamp beside it stands on.
 *
 *   npm run data:lamps -- --city rostock     (no --city: every city)
 *
 * Run AFTER data:update + data:simplify (the selection is relative to the
 * final route geometry).
 *
 * Environment variables:
 *   CITY           – the city, like --city
 *   OVERPASS_URL   – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE  – local JSON file with a saved Overpass response
 *   NETWORK_OUT    – alternative network.json path (one city only)
 *   LAMPS_OUT      – alternative output path (one city only)
 *   PREV_LAMPS     – previously generated street-lamps.json (e.g. the git
 *                    HEAD version in CI): lamps with identical coordinates
 *                    reuse their height, so an unchanged set causes zero
 *                    WCS requests
 *   DGM_WCS_URL    – alternative WCS endpoint
 *   DGM_COVERAGE   – coverage id (default mv_dgm5, the 5 m grid)
 *
 * Data licenses: © OpenStreetMap contributors, ODbL 1.0 (lamp positions);
 * the city's terrain attribution (heights).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { createTerrainSampler, terrainSummary } from './lib/terrain.mjs'
import { selectLampsAlongRoutes } from './lib/street-lamps.mjs'

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

/** 5 decimals ≈ 1 m – far below what a light pool on the ground resolves. */
const round5 = (v) => Math.round(v * 1e5) / 1e5
const round1 = (v) => Math.round(v * 10) / 10

/**
 * Fewer lamps than the city's `lamps.minPlausible` are treated as a mirror
 * failure rather than data: Rostock's lamps come from an official
 * open-data import and number in the tens of thousands; a handful of them
 * means the instance is overloaded or half-synced, and taking that at
 * face value would quietly wipe the lamp set.
 */
async function fetchLampNodes(city) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  const query =
    `[out:json][timeout:300];node["highway"="street_lamp"](${overpassBbox(city.boundingBox)});out skel qt;`
  return postOverpass(query, {
    validate: (data) => (data?.elements?.length ?? 0) >= city.lamps.minPlausible,
  })
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

async function main(city, paths) {
  const NETWORK = process.env.NETWORK_OUT ? resolve(process.env.NETWORK_OUT) : paths.network
  const OUT = process.env.LAMPS_OUT ? resolve(process.env.LAMPS_OUT) : paths.lamps
  if (!city.lamps.enabled) {
    console.log(`${city.name}: street lamps are not enabled for this city – nothing to fetch.`)
    return
  }
  if (city.terrain.provider === 'none') {
    console.log(`${city.name}: no terrain provider – lamps need heights, skipping.`)
    return
  }
  const ATTRIBUTION =
    'Street lamps © OpenStreetMap contributors (ODbL). ' +
    (city.terrain.attribution ?? 'Terrain heights from the city\'s digital terrain model.')
  const network = JSON.parse(readFileSync(NETWORK, 'utf8'))
  const data = await fetchLampNodes(city)
  const nodes = (data.elements ?? []).filter((el) => el.type === 'node')
  console.log(`${nodes.length} street lamps in the ${city.name} bounding box`)

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

  const sampler = createTerrainSampler(city)
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

  console.log(
    `\n✅ ${OUT}: ${lamps.length} street lamps, ` +
      `heights ${minH.toFixed(1)}–${maxH.toFixed(1)} m NHN`,
  )
  if (reused > 0) console.log(`   Reused from PREV_LAMPS: ${reused} height(s)`)
  if (withoutHeight > 0) {
    console.log(`   Dropped without DGM height: ${withoutHeight}`)
  }
  console.log(`   DGM: ${terrainSummary(sampler)}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity(main).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
