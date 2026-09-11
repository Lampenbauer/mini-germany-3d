#!/usr/bin/env node
/**
 * Parity test: the PHP aircraft extraction (server/api/aircraft.php
 * --selftest) must distill a captured adsb.fi answer into exactly the
 * state src/lib/aircraft-extract.ts produces – same aircraft, same
 * fields, same order. Runs locally and in CI (requires php in PATH). The
 * TS side is imported directly (Node strips the types since 22.18), so
 * this always tests the real implementation, never a copy of it.
 *
 * Second check: the circle PHP asks adsb.fi for (php aircraft.php
 * --queries) must be the one the city definitions give – from the
 * repository's src/cities folders, and from copies next to the script,
 * the layout the deploy leaves behind (dist/api/cities/<slug>/city.json).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { adsbQuery, aircraftStateList, mergeAdsbResponse, withinQuery } from '../src/lib/aircraft-extract.ts'
import { CITIES } from '../src/cities/definitions.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tests/fixtures/adsb-aircraft.json')
const NOW = 1_800_000_000_000

const state = new Map()
mergeAdsbResponse(state, JSON.parse(readFileSync(fixture, 'utf8')), NOW)
const expected = JSON.parse(JSON.stringify({ timestamp: NOW, aircraft: aircraftStateList(state, NOW) }))

const output = execFileSync(
  'php',
  [join(root, 'server/api/aircraft.php'), '--selftest', fixture, String(NOW)],
  { encoding: 'utf8' },
)
const actual = JSON.parse(output)

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('❌ PHP aircraft extraction deviates from aircraft-extract.ts!')
  console.error('Expected aircraft:', expected.aircraft.length)
  console.error('Actual aircraft:', actual.aircraft?.length)
  for (let i = 0; i < Math.max(expected.aircraft.length, actual.aircraft?.length ?? 0); i++) {
    const a = JSON.stringify(expected.aircraft[i])
    const b = JSON.stringify(actual.aircraft?.[i])
    if (a !== b) {
      console.error('First difference at index', i)
      console.error('  TS :', a)
      console.error('  PHP:', b)
      break
    }
  }
  process.exit(1)
}
console.log(
  `✅ PHP aircraft extraction matches aircraft-extract.ts: ${expected.aircraft.length} aircraft identical`,
)

// --- The circle a city is served: the fixture cut to Frankfurt's ------------
const frankfurt = CITIES.find((city) => city.slug === 'frankfurt')
const query = adsbQuery(frankfurt.boundingBox)
const expectedCut = expected.aircraft.filter((a) => withinQuery(a.lat, a.lon, query))
const actualCut = JSON.parse(
  execFileSync(
    'php',
    [join(root, 'server/api/aircraft.php'), '--selftest', fixture, String(NOW), 'frankfurt'],
    { encoding: 'utf8' },
  ),
)
if (JSON.stringify(actualCut.aircraft) !== JSON.stringify(expectedCut)) {
  console.error(`❌ PHP serves ${actualCut.aircraft?.length} aircraft for Frankfurt's circle, aircraft-extract.ts ${expectedCut.length}`)
  process.exit(1)
}
if (expectedCut.length === expected.aircraft.length || expectedCut.length === 0) {
  console.error(`❌ The fixture should straddle Frankfurt's circle (${expectedCut.length} of ${expected.aircraft.length} inside)`)
  process.exit(1)
}
console.log(`✅ PHP cuts the sky to the city's circle as aircraft-extract.ts does: ${expectedCut.length} of ${expected.aircraft.length} aircraft inside Frankfurt's`)

// --- The circles asked for ---------------------------------------------------
// PHP walks the cities/ folders in alphabetical order, so the expectation does too.
const expectedQueries = JSON.stringify(
  Object.fromEntries(
    [...CITIES]
      .sort((a, b) => a.slug.localeCompare(b.slug))
      .map((city) => [city.slug, adsbQuery(city.boundingBox)]),
  ),
)
const phpQueries = (script) =>
  JSON.stringify(JSON.parse(execFileSync('php', [script, '--queries'], { encoding: 'utf8' })))

const fromRepo = phpQueries(join(root, 'server/api/aircraft.php'))
if (fromRepo !== expectedQueries) {
  console.error(`❌ aircraft.php asks for ${fromRepo}, the city definitions say ${expectedQueries}`)
  process.exit(1)
}

// Deployed layout: script and city.json copies side by side, no src/ around.
const deployDir = mkdtempSync(join(tmpdir(), 'mg3d-aircraft-deploy-'))
try {
  copyFileSync(join(root, 'server/api/aircraft.php'), join(deployDir, 'aircraft.php'))
  for (const city of CITIES) {
    mkdirSync(join(deployDir, 'cities', city.slug), { recursive: true })
    copyFileSync(
      join(root, 'src/cities', city.slug, 'city.json'),
      join(deployDir, 'cities', city.slug, 'city.json'),
    )
  }
  const deployed = phpQueries(join(deployDir, 'aircraft.php'))
  if (deployed !== expectedQueries) {
    console.error(`❌ Deployed aircraft.php asks for ${deployed}, expected ${expectedQueries}`)
    process.exit(1)
  }
} finally {
  rmSync(deployDir, { recursive: true, force: true })
}
console.log(`✅ PHP aircraft proxy asks adsb.fi for the shared city circles: ${fromRepo}`)
