#!/usr/bin/env node
/**
 * Fetches a city's airfield lighting from OpenStreetMap (Overpass API) –
 * every aeroway=navigationaid node inside the box that the map has a
 * light for (see lib/airfield-lights.mjs for the kinds and their
 * colours) – and writes it to src/cities/<slug>/airfield-lights.json,
 * the source for the runway and taxiway lights at night (see
 * src/map/AirfieldLightsLayer.ts).
 *
 * Every city gets the file, however much or little OSM holds: Frankfurt's
 * ten thousand lights and Rostock-Laage's twenty-one are both the real
 * lighting as far as it is mapped, and a city whose box holds no airfield
 * at all (Schwerin – Parchim lies outside it) gets an empty list rather
 * than no file, so the app does not have to tell the two apart.
 *
 * Each light keeps a terrain height in meters NHN from the same terrain
 * tiles the route heights use (lib/terrain.mjs): a runway lies on the
 * ground, and the bare-earth model is that ground to within a few
 * decimeters.
 *
 *   npm run data:airfield-lights -- --city hamburg     (no --city: every city)
 *
 * Environment variables:
 *   CITY                  – the city, like --city
 *   OVERPASS_URL          – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE         – local JSON file with a saved Overpass response
 *   AIRFIELD_LIGHTS_OUT   – alternative output path (one city only)
 *   PREV_AIRFIELD_LIGHTS  – previously generated airfield-lights.json (e.g.
 *                           the git HEAD version in CI): lights with identical
 *                           coordinates reuse their height, so an unchanged set
 *                           fetches no tiles at all – as long as the file names
 *                           the same terrain source
 *
 * Data licenses: © OpenStreetMap contributors, ODbL 1.0 (light positions
 * and kinds); the city's terrain attribution (heights).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { createTerrainSampler, terrainAttribution, terrainSummary } from './lib/terrain.mjs'
import { sameTerrainSource } from './lib/route-heights.mjs'
import { countByKind, selectAirfieldLights } from './lib/airfield-lights.mjs'

const round1 = (v) => Math.round(v * 10) / 10

/**
 * The navigationaid nodes of the box, tags included. An empty answer is
 * not taken as a mirror failure here – a box without an airfield has no
 * lights – so a half-synced answer is caught only by the comparison with
 * the previous run further down.
 */
async function fetchLightNodes(city) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  const query =
    `[out:json][timeout:300];node["aeroway"="navigationaid"](${overpassBbox(city.boundingBox)});out qt;`
  return postOverpass(query, {
    validate: (data) => Array.isArray(data?.elements),
  })
}

/** The previously generated airfield-lights.json (PREV_AIRFIELD_LIGHTS), or null. */
function loadPrevious() {
  if (!process.env.PREV_AIRFIELD_LIGHTS) return null
  try {
    return JSON.parse(readFileSync(resolve(process.env.PREV_AIRFIELD_LIGHTS), 'utf8'))
  } catch (err) {
    console.warn(`⚠ PREV_AIRFIELD_LIGHTS not usable (${err.message}) – sampling everything fresh`)
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
    console.log('PREV_AIRFIELD_LIGHTS holds heights from another terrain source – sampling everything fresh')
    return index
  }
  for (const [lon, lat, nhn] of prev.lights ?? []) index.set(`${lon}:${lat}`, nhn)
  return index
}

async function main(city, paths) {
  const OUT = process.env.AIRFIELD_LIGHTS_OUT ? resolve(process.env.AIRFIELD_LIGHTS_OUT) : paths.airfieldLights
  const TERRAIN_ATTRIBUTION = terrainAttribution(city)
  const ATTRIBUTION = `Airfield lighting © OpenStreetMap contributors (ODbL). ${TERRAIN_ATTRIBUTION}`
  const data = await fetchLightNodes(city)
  const selected = selectAirfieldLights(data.elements ?? [], city.boundingBox)
  console.log(`${selected.length} airfield lights in the ${city.name} bounding box`)
  const counts = countByKind(selected)
  if (selected.length > 0) {
    console.log(
      '   ' +
        Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([kind, n]) => `${kind} ${n}`)
          .join(', '),
    )
  }
  // A mirror that is overloaded or half-synced answers with a fraction of
  // the lights; taken at face value that would quietly wipe most of the
  // set. Measured against the previous run rather than a fixed number –
  // Rostock-Laage's twenty-one are as welcome as Frankfurt's ten thousand.
  const prevFile = loadPrevious()
  const prevCount = prevFile?.lights?.length ?? 0
  if (prevCount > 0 && selected.length < prevCount / 2) {
    throw new Error(
      `Only ${selected.length} airfield lights where the previous run had ${prevCount} – ` +
        'an incomplete Overpass answer, airfield-lights.json left unchanged',
    )
  }

  const sampler = createTerrainSampler(city)
  const previous = indexPreviousHeights(prevFile, TERRAIN_ATTRIBUTION)
  const lights = []
  let reused = 0
  let withoutHeight = 0
  let minH = Infinity
  let maxH = -Infinity
  for (const [lon, lat, kind, colour] of selected) {
    const cached = previous.get(`${lon}:${lat}`)
    let nhn = cached
    if (nhn === undefined) {
      const sampled = await sampler.heightAt(lon, lat)
      nhn = sampled === undefined ? undefined : round1(sampled)
    } else {
      reused++
    }
    // No terrain height means no idea where the ground is – a light at a
    // guessed height sinks into the runway or floats over it, so it is
    // dropped instead.
    if (nhn === undefined) {
      withoutHeight++
      continue
    }
    lights.push([lon, lat, nhn, kind, colour])
    if (nhn < minH) minH = nhn
    if (nhn > maxH) maxH = nhn
  }

  const meta = {
    attribution: ATTRIBUTION,
    terrainAttribution: TERRAIN_ATTRIBUTION,
  }
  // One light per line: a 10 000-entry file stays diffable, and the
  // nightly commit shows which lights actually changed.
  const body =
    '{\n' +
    `  "meta": ${JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')},\n` +
    (lights.length === 0
      ? '  "lights": []\n}\n'
      : '  "lights": [\n' + lights.map((l) => `    ${JSON.stringify(l)}`).join(',\n') + '\n  ]\n}\n')
  writeFileSync(OUT, body, 'utf8')

  console.log(
    `\n✅ ${OUT}: ${lights.length} airfield lights` +
      (lights.length > 0 ? `, heights ${minH.toFixed(1)}–${maxH.toFixed(1)} m NHN` : ''),
  )
  if (reused > 0) console.log(`   Reused from PREV_AIRFIELD_LIGHTS: ${reused} height(s)`)
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
