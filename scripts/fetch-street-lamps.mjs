#!/usr/bin/env node
/**
 * Fetches a city's street lamps from OpenStreetMap (Overpass API) and
 * writes the ones standing along the transit routes to
 * src/cities/<slug>/street-lamps.json – the source for the night-time
 * light pools on the map (see src/map/StreetLampsLayer.ts).
 *
 * Every city gets the layer, however sparse its lamps: Rostock's come
 * from an official open-data import (source=OpenData.HRO,
 * lamp_operator=Hansestadt Rostock, sixteen per kilometer of line),
 * Kiel's from community mapping (two per kilometer) – sparse light is
 * still the real light, not a decorative sprinkle.
 *
 * Each lamp keeps a terrain height in meters NHN from the same terrain
 * tiles the route heights use (lib/terrain.mjs), so the pools sit on the
 * ground the routes run on.
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
 *                    reuse their height, so an unchanged set fetches no
 *                    tiles at all – as long as the file names the same
 *                    terrain source; after a source change every lamp is
 *                    sampled afresh once
 *
 * Data licenses: © OpenStreetMap contributors, ODbL 1.0 (lamp positions);
 * the city's terrain attribution (heights).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { createTerrainSampler, terrainAttribution, terrainSummary } from './lib/terrain.mjs'
import { sameTerrainSource } from './lib/route-heights.mjs'
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
 * An empty answer is a mirror failure, not a city without lamps (the
 * next mirror is tried); a half-synced answer is caught further down by
 * comparing with the previous run.
 */
async function fetchLampNodes(city) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  const query =
    `[out:json][timeout:300];node["highway"="street_lamp"](${overpassBbox(city.boundingBox)});out skel qt;`
  return postOverpass(query, {
    validate: (data) => (data?.elements?.length ?? 0) > 0,
  })
}

/** The previously generated street-lamps.json (PREV_LAMPS), or null. */
function loadPreviousLamps() {
  if (!process.env.PREV_LAMPS) return null
  try {
    return JSON.parse(readFileSync(resolve(process.env.PREV_LAMPS), 'utf8'))
  } catch (err) {
    console.warn(`⚠ PREV_LAMPS not usable (${err.message}) – sampling everything fresh`)
    return null
  }
}

/**
 * "lon:lat" → height, from the previous file – provided it was sampled
 * from the terrain source this run uses.
 */
function indexPreviousHeights(prev, attribution) {
  const index = new Map()
  if (!prev) return index
  if (!sameTerrainSource(prev, attribution)) {
    console.log('PREV_LAMPS holds heights from another terrain source – sampling everything fresh')
    return index
  }
  for (const [lon, lat, nhn] of prev.lamps ?? []) index.set(`${lon}:${lat}`, nhn)
  return index
}

async function main(city, paths) {
  const NETWORK = process.env.NETWORK_OUT ? resolve(process.env.NETWORK_OUT) : paths.network
  const OUT = process.env.LAMPS_OUT ? resolve(process.env.LAMPS_OUT) : paths.lamps
  const TERRAIN_ATTRIBUTION = terrainAttribution(city)
  const ATTRIBUTION = `Street lamps © OpenStreetMap contributors (ODbL). ${TERRAIN_ATTRIBUTION}`
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
  // A mirror that is overloaded or half-synced answers with a fraction of
  // the lamps; taken at face value that would quietly wipe most of the
  // set. Measured against the previous run rather than a fixed number, so
  // a city with few lamps is as welcome as one with an import.
  const prevFile = loadPreviousLamps()
  const prevCount = prevFile?.lamps?.length ?? 0
  if (prevCount > 0 && selected.length < prevCount / 2) {
    throw new Error(
      `Only ${selected.length} lamps along the routes where the previous run had ${prevCount} – ` +
        'an incomplete Overpass answer, street-lamps.json left unchanged',
    )
  }

  const sampler = createTerrainSampler(city)
  const previous = indexPreviousHeights(prevFile, TERRAIN_ATTRIBUTION)
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
      terrainAttribution: TERRAIN_ATTRIBUTION,
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
    console.log(`   Dropped without terrain height: ${withoutHeight}`)
  }
  console.log(`   Terrain: ${terrainSummary(sampler)}`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity(main).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
