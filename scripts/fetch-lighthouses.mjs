#!/usr/bin/env node
/**
 * Fetches a city's lighthouses and lesser fixed lights from OpenStreetMap
 * (Overpass API) – every man_made=lighthouse and every
 * seamark:type=light_major/light_minor node or way inside the box that
 * names a lit sector (see lib/lighthouses.mjs) – and writes them to
 * src/cities/<slug>/lighthouses.json, the source for the lights on the
 * towers at night (see src/map/LighthousesLayer.ts).
 *
 * Every city gets the file, however much or little coast it has: an
 * empty list rather than no file spares the app the difference. No
 * heights: the map sets each light on the top of its tower as Google's
 * tiles have it, with OSM's elevation over the water as the floor.
 *
 *   npm run data:lighthouses -- --city rostock     (no --city: every city)
 *
 * Environment variables:
 *   CITY             – the city, like --city
 *   OVERPASS_URL     – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE    – local JSON file with a saved Overpass response
 *   LIGHTHOUSES_OUT  – alternative output path (one city only)
 *   PREV_LIGHTHOUSES – previously generated lighthouses.json (e.g. the git
 *                      HEAD version in CI): a half-synced mirror answering
 *                      with a fraction of the lights is caught against it
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { countLighthouses, selectLighthouses } from './lib/lighthouses.mjs'

const ATTRIBUTION = 'Lighthouses © OpenStreetMap contributors (ODbL)'

/**
 * The light towers of the box, tags included, a way's centre standing
 * for the building. An empty answer is not taken as a mirror failure –
 * an inland box has no lighthouse – so a half-synced answer is caught
 * only by the comparison with the previous run further down.
 */
async function fetchLightNodes(city) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  const bbox = overpassBbox(city.boundingBox)
  const query =
    `[out:json][timeout:300];(` +
    `node["seamark:type"~"^light_(major|minor)$"](${bbox});` +
    `way["seamark:type"~"^light_(major|minor)$"](${bbox});` +
    `node["man_made"="lighthouse"](${bbox});` +
    `way["man_made"="lighthouse"](${bbox});` +
    `);out center qt;`
  return postOverpass(query, {
    validate: (data) => Array.isArray(data?.elements),
  })
}

/** The previously generated lighthouses.json (PREV_LIGHTHOUSES), or null. */
function loadPrevious() {
  if (!process.env.PREV_LIGHTHOUSES) return null
  try {
    return JSON.parse(readFileSync(resolve(process.env.PREV_LIGHTHOUSES), 'utf8'))
  } catch (err) {
    console.warn(`⚠ PREV_LIGHTHOUSES not usable (${err.message})`)
    return null
  }
}

async function main(city, paths) {
  const OUT = process.env.LIGHTHOUSES_OUT ? resolve(process.env.LIGHTHOUSES_OUT) : paths.lighthouses
  const data = await fetchLightNodes(city)
  const lights = selectLighthouses(data.elements ?? [], city.boundingBox)
  const counts = countLighthouses(lights)
  console.log(
    `${lights.length} lights in the ${city.name} bounding box: ${counts.major} major, ${counts.minor} minor, ${counts.sectored} of them sector lights, ${counts.rotating} turning beams`,
  )
  const prevCount = loadPrevious()?.lights?.length ?? 0
  if (prevCount > 0 && lights.length < prevCount / 2) {
    throw new Error(
      `Only ${lights.length} lights where the previous run had ${prevCount} – ` +
        'an incomplete Overpass answer, lighthouses.json left unchanged',
    )
  }
  const meta = { attribution: ATTRIBUTION }
  const body =
    '{\n' +
    `  "meta": ${JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')},\n` +
    (lights.length === 0
      ? '  "lights": []\n}\n'
      : '  "lights": [\n' + lights.map((l) => `    ${JSON.stringify(l)}`).join(',\n') + '\n  ]\n}\n')
  writeFileSync(OUT, body, 'utf8')
  console.log(`\n✅ ${OUT}: ${lights.length} lights`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity(main).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
