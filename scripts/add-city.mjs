#!/usr/bin/env node
/**
 * Starts a new city: asks Overpass for the city limits relation, derives
 * the rectangle every part of the project works with, and writes a
 * city.json skeleton to src/cities/<slug>/ – the pipeline
 * (data:update, data:gtfs, …) takes it from there.
 *
 *   node scripts/add-city.mjs <slug> <osm-relation-id> [--name "Name"] [--padding 15000]
 *   node scripts/add-city.mjs kiel 27021
 *   node scripts/add-city.mjs kiel 27021 --limits-only    (refresh limits.json only)
 *
 * Next to city.json it writes limits.json: the largest outer ring itself,
 * thinned to a few hundred points. The pipeline cuts routes and anchors
 * timetables at that polygon rather than at the rectangle – a rectangle
 * around a city reaches the neighbouring towns, and a route is meant to
 * end where the city does.
 *
 * The bounds are those of the relation's LARGEST outer ring, not the
 * relation's own bounding box: an administrative boundary can include
 * exclaves far away (an island 100 km out at sea), and `out bb` would
 * stretch the box across the
 * water – the camera leash, the AIS subscription and the Overpass
 * queries with it.
 *
 * What the skeleton cannot know is left for the maintainer: the home
 * view (it opens on the box's center), which modes and operators to
 * fetch (every mode, no operator filter), the fleet, the terrain
 * attribution the state's license asks for, and the ferries' AIS twins. An existing city.json is
 * never overwritten – delete it first, or edit it.
 *
 * Environment variables:
 *   OVERPASS_URL  – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE – a saved `rel(<id>);out geom;` answer (no network)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { boundingBoxCenter, padBoundingBox } from '../src/lib/city.ts'
import { CITIES_DIR } from './lib/city.mjs'
import { postOverpass } from './lib/overpass.mjs'
import { compactPath } from './lib/simplify.mjs'

const DEFAULT_PADDING_METERS = 15000
/** Douglas–Peucker tolerance for the stored limits ring, in meters. */
const LIMITS_TOLERANCE_METERS = 15

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--name' || arg === '--padding') {
      options[arg.slice(2)] = argv[++i]
    } else if (arg === '--limits-only') {
      options.limitsOnly = true
    } else {
      positional.push(arg)
    }
  }
  return { positional, options }
}

/**
 * Joins the outer ways of a boundary relation into closed rings. Ways come
 * in any order and either orientation; a ring is closed when its ends
 * meet. Ways that never find a partner are dropped with a note.
 */
export function stitchRings(ways) {
  const key = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`
  const used = new Array(ways.length).fill(false)
  const rings = []
  for (let i = 0; i < ways.length; i++) {
    if (used[i]) continue
    used[i] = true
    let ring = [...ways[i]]
    let changed = true
    while (changed && key(ring[0]) !== key(ring[ring.length - 1])) {
      changed = false
      for (let k = 0; k < ways.length; k++) {
        if (used[k]) continue
        const way = ways[k]
        const head = key(ring[0])
        const tail = key(ring[ring.length - 1])
        if (key(way[0]) === tail) ring = ring.concat(way.slice(1))
        else if (key(way[way.length - 1]) === tail) ring = ring.concat([...way].reverse().slice(1))
        else if (key(way[way.length - 1]) === head) ring = way.slice(0, -1).concat(ring)
        else if (key(way[0]) === head) ring = [...way].reverse().slice(0, -1).concat(ring)
        else continue
        used[k] = true
        changed = true
        break
      }
    }
    if (key(ring[0]) === key(ring[ring.length - 1])) rings.push(ring)
    else console.warn(`  ⚠ an outer ring of ${ring.length} points does not close – ignored`)
  }
  return rings
}

/** Area of a ring in km², flat-earth at the ring's own latitude. */
export function ringAreaKm2(ring) {
  const latMid = ring.reduce((sum, p) => sum + p[1], 0) / ring.length
  const kx = 111.32 * Math.cos((latMid * Math.PI) / 180)
  const ky = 111.132
  let twice = 0
  for (let i = 0; i < ring.length - 1; i++) {
    twice += ring[i][0] * kx * ring[i + 1][1] * ky - ring[i + 1][0] * kx * ring[i][1] * ky
  }
  return Math.abs(twice / 2)
}

export function ringBounds(ring) {
  return {
    west: Math.min(...ring.map((p) => p[0])),
    south: Math.min(...ring.map((p) => p[1])),
    east: Math.max(...ring.map((p) => p[0])),
    north: Math.max(...ring.map((p) => p[1])),
  }
}

/**
 * The bounds of a boundary relation's largest outer ring (see the header)
 * and the relation's name, from a `rel(<id>);out geom;` answer.
 */
export function cityBoundsFromRelation(data, relationId) {
  const relation = (data.elements ?? []).find(
    (el) => el.type === 'relation' && el.id === relationId,
  )
  if (!relation) throw new Error(`Relation ${relationId} is not in the Overpass answer`)
  const outerWays = relation.members
    .filter((m) => m.type === 'way' && m.role === 'outer' && Array.isArray(m.geometry))
    .map((m) => m.geometry.map((p) => [p.lon, p.lat]))
  if (outerWays.length === 0) throw new Error(`Relation ${relationId} has no outer ways`)
  const rings = stitchRings(outerWays)
    .map((ring) => ({ ring, areaKm2: ringAreaKm2(ring) }))
    .sort((a, b) => b.areaKm2 - a.areaKm2)
  if (rings.length === 0) throw new Error(`Relation ${relationId}: no closed outer ring`)
  return {
    name: relation.tags?.name,
    adminLevel: relation.tags?.admin_level,
    rings: rings.map(({ ring, areaKm2 }) => ({ areaKm2, bounds: ringBounds(ring), ring })),
  }
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2))
  const [slug, relationArg] = positional
  const relationId = Number(relationArg)
  if (!slug || !/^[a-z][a-z0-9-]*$/.test(slug) || !Number.isInteger(relationId)) {
    console.error('Usage: node scripts/add-city.mjs <slug> <osm-relation-id> [--name "Name"] [--padding 15000]')
    process.exit(2)
  }
  const dir = resolve(CITIES_DIR, slug)
  const file = resolve(dir, 'city.json')
  const limitsFile = resolve(dir, 'limits.json')
  if (existsSync(file) && !options.limitsOnly) {
    throw new Error(`${file} exists – edit it, delete it to start over, or pass --limits-only`)
  }
  if (!existsSync(file) && options.limitsOnly) {
    throw new Error(`${file} does not exist – --limits-only refreshes an existing city`)
  }
  const padding = Number(options.padding ?? DEFAULT_PADDING_METERS)

  let data
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    data = JSON.parse(readFileSync(resolve(process.env.OVERPASS_FILE), 'utf8'))
  } else {
    data = await postOverpass(`[out:json][timeout:120];rel(${relationId});out geom;`, {
      validate: (answer) => (answer?.elements?.length ?? 0) > 0,
    })
  }
  const { name, adminLevel, rings } = cityBoundsFromRelation(data, relationId)
  const [largest, ...others] = rings
  console.log(
    `Relation ${relationId}: ${name ?? '(unnamed)'} (admin_level ${adminLevel ?? '?'}), ` +
      `${rings.length} outer ring(s)`,
  )
  console.log(`  largest ring ${largest.areaKm2.toFixed(0)} km² → ${JSON.stringify(largest.bounds)}`)
  for (const other of others) {
    console.log(`  ignored ring ${other.areaKm2.toFixed(0)} km² at ${JSON.stringify(other.bounds)}`)
  }
  const round7 = (v) => Math.round(v * 1e7) / 1e7
  const cityBounds = Object.fromEntries(
    Object.entries(largest.bounds).map(([edge, value]) => [edge, round7(value)]),
  )
  const boundingBox = padBoundingBox(cityBounds, padding)
  const center = boundingBoxCenter(boundingBox)

  // The limits ring, thinned: the pipeline's point-in-city test walks it
  // per stop, and 15 m is well below the distance at which a stop could
  // change sides of a border.
  const ring = compactPath(largest.ring, LIMITS_TOLERANCE_METERS).map(([lon, lat]) => [
    Math.round(lon * 1e6) / 1e6,
    Math.round(lat * 1e6) / 1e6,
  ])
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    limitsFile,
    JSON.stringify(
      {
        description: `City limits of ${options.name ?? name ?? slug}: the largest outer ring of OSM relation ${relationId}, thinned to ${LIMITS_TOLERANCE_METERS} m. Read by the data pipeline only (scripts/lib/city.mjs).`,
        osmRelation: relationId,
        queriedOn: new Date().toISOString().slice(0, 10),
        ring,
      },
      null,
      0,
    ).replace('"ring":[', '\n"ring":[\n') + '\n',
    'utf8',
  )
  console.log(`✅ Wrote ${limitsFile} (${ring.length} points)`)
  if (options.limitsOnly) return

  const city = {
    slug,
    name: options.name ?? name ?? slug,
    osmRelation: relationId,
    cityBoundsQueriedOn: new Date().toISOString().slice(0, 10),
    cityBounds,
    paddingMeters: padding,
    boundingBox,
    home: { longitude: center.longitude, latitude: center.latitude, height: 7400, heading: 0, pitch: -40 },
    weather: center,
    network: {
      modes: ['tram', 'subway', 'train', 'bus', 'ferry'],
      overpass: {
        tram: {},
        subway: {},
        train: { service: 'commuter', ref: '^S[0-9]+$' },
        bus: {},
        ferry: {},
      },
      fixedLines: [],
      clip: 'city',
    },
    gtfs: { nameStrip: (options.name ?? name ?? slug).toLowerCase(), trainBranches: [] },
    fleet: {},
    terrain: { zoom: 15, geoidOffsetFallback: 40, waterLevelNhn: 0 },
    ais: { enabled: true, simulatedByMmsi: {} },
  }
  writeFileSync(file, JSON.stringify(city, null, 2) + '\n', 'utf8')
  console.log(`\n✅ Wrote ${file}`)
  console.log('Next: set the home view, narrow the modes/operators, pick the fleet, then')
  console.log(`  npm run data:update -- --city ${slug} && npm run data:simplify -- --city ${slug} && npm run data:gtfs -- --city ${slug}`)
  console.log(`and list the city in src/cities/definitions.ts.`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname
if (isMain) {
  main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
