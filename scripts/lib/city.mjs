/**
 * Which city a pipeline script works on, and where its files live.
 *
 *   node scripts/<script>.mjs --city hamburg     one city
 *   CITY=hamburg node scripts/<script>.mjs       the same
 *   node scripts/<script>.mjs                    every city under src/cities/
 *
 * The definition is read through src/lib/city.ts (Node strips the types
 * since 22.18), so a script sees the same validated shape the app does.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cityFromJson } from '../../src/lib/city.ts'

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
