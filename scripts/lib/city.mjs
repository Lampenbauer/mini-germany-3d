/**
 * Which city a pipeline script works on, and where its files live.
 *
 *   node scripts/<script>.mjs --city kiel     one city
 *   CITY=kiel node scripts/<script>.mjs       the same
 *   node scripts/<script>.mjs                    every city under src/cities/
 *
 * The definition is read through src/lib/city.ts (Node strips the types
 * since 22.18), so a script sees the same validated shape the app does.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cityFromJson, containsLonLat, pointInRing } from '../../src/lib/city.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
/** src/cities/ – one folder per city. */
export const CITIES_DIR = resolve(__dirname, '../../src/cities')

/** Every slug that has a city.json, in folder order. */
export function allCitySlugs() {
  return readdirSync(CITIES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(CITIES_DIR, entry.name, 'city.json')))
    .map((entry) => entry.name)
    .sort()
}

/** The validated definition of a city. */
export function loadCity(slug) {
  const file = resolve(CITIES_DIR, slug, 'city.json')
  if (!existsSync(file)) {
    throw new Error(`Unknown city "${slug}" – no ${file}`)
  }
  return cityFromJson(JSON.parse(readFileSync(file, 'utf8')))
}

/** The generated data files of a city. */
export function cityPaths(slug) {
  const dir = resolve(CITIES_DIR, slug)
  return {
    dir,
    definition: resolve(dir, 'city.json'),
    network: resolve(dir, 'network.json'),
    schedule: resolve(dir, 'schedule.json'),
    lamps: resolve(dir, 'street-lamps.json'),
    airfieldLights: resolve(dir, 'airfield-lights.json'),
    /** The city limits as a polygon (written by add-city); optional. */
    limits: resolve(dir, 'limits.json'),
  }
}

/**
 * The city limits as a ring of [lon, lat] pairs, from limits.json – or
 * null for a city that only has its rectangle (Rostock's box lies wholly
 * inside its state, so the rectangle never mattered there).
 */
export function loadCityLimits(slug) {
  const file = cityPaths(slug).limits
  if (!existsSync(file)) return null
  const data = JSON.parse(readFileSync(file, 'utf8'))
  return Array.isArray(data.ring) && data.ring.length >= 4 ? data.ring : null
}

/**
 * "Is this point in the city?" as the pipeline decides it: inside the
 * limits polygon where the city has one, inside `cityBounds` otherwise.
 * The network cut (data:update) and the GTFS anchoring (data:gtfs) both
 * use this, so a trip departs the network where the route really ends.
 */
export function cityInsidePredicate(city) {
  const ring = loadCityLimits(city.slug)
  if (ring) return (lon, lat) => pointInRing(ring, lon, lat)
  return (lon, lat) => containsLonLat(city.cityBounds, lon, lat)
}

/**
 * "Is this point on the map?" as the network is cut (city.json
 * `network.clip`): the city limits, the padded box (Kiel – Laboe and
 * Strande are part of the Förde), or everything. The network cut
 * (data:update) and the GTFS anchoring (data:gtfs) share it, so a trip
 * departs the network where its route really ends.
 */
export function networkInsidePredicate(city) {
  switch (city.network.clip) {
    case 'city':
      return cityInsidePredicate(city)
    case 'box':
      return (lon, lat) => containsLonLat(city.boundingBox, lon, lat)
    default:
      return () => true
  }
}

/**
 * The slugs a script run addresses: the --city argument or CITY variable,
 * else every city. `--city a,b` names several.
 */
export function requestedCitySlugs(argv = process.argv, env = process.env) {
  const index = argv.indexOf('--city')
  const fromArgs = index >= 0 ? argv[index + 1] : undefined
  const fromEnv = env.CITY
  const raw = fromArgs ?? fromEnv
  if (!raw) return allCitySlugs()
  return raw
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean)
}

/** Runs `job(city, paths)` for every requested city, one after the other. */
export async function forEachRequestedCity(job, argv = process.argv) {
  const slugs = requestedCitySlugs(argv)
  for (const slug of slugs) {
    const city = loadCity(slug)
    if (slugs.length > 1) console.log(`\n══════ ${city.name} (${slug}) ══════`)
    await job(city, cityPaths(slug))
  }
}
