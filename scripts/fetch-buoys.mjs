#!/usr/bin/env node
/**
 * Fetches a city's buoys from OpenStreetMap (Overpass API) – every
 * seamark:type=buoy_* node inside the box that the map has a buoy for
 * (see lib/buoys.mjs: the red, green and yellow ones, with their shape
 * and their light) – and writes them to src/cities/<slug>/buoys.json,
 * the source for the marks on the water (see src/map/BuoysLayer.ts).
 *
 * Every city gets the file, however much or little water it has: the
 * Warnow's two hundred and a landlocked box's none are both the marks
 * as far as they are mapped, and an empty list rather than no file
 * spares the app the difference.
 *
 * No heights: a buoy floats on the tiles' own water, which the map
 * clamps it to at runtime, so there is nothing here to sample and
 * nothing to reuse from a previous run.
 *
 *   npm run data:buoys -- --city rostock     (no --city: every city)
 *
 * Environment variables:
 *   CITY           – the city, like --city
 *   OVERPASS_URL   – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE  – local JSON file with a saved Overpass response
 *   BUOYS_OUT      – alternative output path (one city only)
 *   PREV_BUOYS     – previously generated buoys.json (e.g. the git HEAD
 *                    version in CI): a half-synced mirror answering with a
 *                    fraction of the marks is caught against it
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { countBuoys, selectBuoys } from './lib/buoys.mjs'

const ATTRIBUTION = 'Buoys © OpenStreetMap contributors (ODbL)'

/**
 * The buoy nodes of the box, tags included. An empty answer is not taken
 * as a mirror failure here – a box without water has no buoys – so a
 * half-synced answer is caught only by the comparison with the previous
 * run further down.
 */
async function fetchBuoyNodes(city) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    return JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  }
  const bbox = overpassBbox(city.boundingBox)
  const query = `[out:json][timeout:300];node["seamark:type"~"^buoy_"](${bbox});out qt;`
  return postOverpass(query, {
    validate: (data) => Array.isArray(data?.elements),
  })
}

/** The previously generated buoys.json (PREV_BUOYS), or null. */
function loadPrevious() {
  if (!process.env.PREV_BUOYS) return null
  try {
    return JSON.parse(readFileSync(resolve(process.env.PREV_BUOYS), 'utf8'))
  } catch (err) {
    console.warn(`⚠ PREV_BUOYS not usable (${err.message})`)
    return null
  }
}

async function main(city, paths) {
  const OUT = process.env.BUOYS_OUT ? resolve(process.env.BUOYS_OUT) : paths.buoys
  const data = await fetchBuoyNodes(city)
  const buoys = selectBuoys(data.elements ?? [], city.boundingBox)
  const counts = countBuoys(buoys)
  console.log(`${buoys.length} buoys in the ${city.name} bounding box, ${counts.lit} of them lit`)
  if (buoys.length > 0) {
    console.log(
      '   ' +
        Object.entries(counts.byColour)
          .sort((a, b) => b[1] - a[1])
          .map(([colour, n]) => `${colour} ${n}`)
          .join(', '),
    )
  }
  // A mirror that is overloaded or half-synced answers with a fraction of
  // the marks; taken at face value that would quietly wipe most of the
  // set. Measured against the previous run rather than a fixed number.
  const prevCount = loadPrevious()?.buoys?.length ?? 0
  if (prevCount > 0 && buoys.length < prevCount / 2) {
    throw new Error(
      `Only ${buoys.length} buoys where the previous run had ${prevCount} – ` +
        'an incomplete Overpass answer, buoys.json left unchanged',
    )
  }

  const meta = { attribution: ATTRIBUTION }
  // One buoy per line: the file stays diffable, and the nightly commit
  // shows which marks actually moved.
  const body =
    '{\n' +
    `  "meta": ${JSON.stringify(meta, null, 2).replace(/\n/g, '\n  ')},\n` +
    (buoys.length === 0
      ? '  "buoys": []\n}\n'
      : '  "buoys": [\n' + buoys.map((b) => `    ${JSON.stringify(b)}`).join(',\n') + '\n  ]\n}\n')
  writeFileSync(OUT, body, 'utf8')
  console.log(`\n✅ ${OUT}: ${buoys.length} buoys`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity(main).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
