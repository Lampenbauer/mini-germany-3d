#!/usr/bin/env node
/**
 * Parity test: the PHP AIS extraction (server/api/ais.php --selftest)
 * must distill the captured aisstream messages into exactly the state
 * src/lib/ais-extract.ts produces – same vessels, same fields, same
 * order. Runs locally and in CI (requires php in PATH). The TS side is
 * imported directly (Node strips the types since 22.18), so this always
 * tests the real implementation, never a copy of it.
 *
 * Second check: the bounding boxes PHP subscribes with (php ais.php --bbox)
 * must be the ones the city definitions carry – from the repository's
 * src/cities folders, and from copies next to the script, the layout the
 * deploy leaves behind (dist/api/cities/<slug>/city.json).
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aisStateVessels, mergeAisMessage } from '../src/lib/ais-extract.ts'
import { CITIES } from '../src/cities/definitions.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tests/fixtures/ais-messages.json')
const NOW = 1_800_000_000_000

const state = new Map()
for (const message of JSON.parse(readFileSync(fixture, 'utf8'))) {
  mergeAisMessage(state, message, NOW)
}
const expected = JSON.parse(
  JSON.stringify({ timestamp: NOW, vessels: aisStateVessels(state, NOW) }),
)

const output = execFileSync(
  'php',
  [join(root, 'server/api/ais.php'), '--selftest', fixture, String(NOW)],
  { encoding: 'utf8' },
)
const actual = JSON.parse(output)

if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  console.error('❌ PHP AIS extraction deviates from ais-extract.ts!')
  console.error('Expected vessels:', expected.vessels.length)
  console.error('Actual vessels:', actual.vessels?.length)
  for (let i = 0; i < Math.max(expected.vessels.length, actual.vessels?.length ?? 0); i++) {
    const a = JSON.stringify(expected.vessels[i])
    const b = JSON.stringify(actual.vessels?.[i])
    if (a !== b) {
      console.error('First difference at index', i)
      console.error('  TS :', a)
      console.error('  PHP:', b)
      break
    }
  }
  process.exit(1)
}
console.log(`✅ PHP AIS extraction matches ais-extract.ts: ${expected.vessels.length} vessels identical`)

// --- Bounding boxes --------------------------------------------------------
// One subscription for every city with AIS – aisstream allows three
// connections per account, so one per city would not scale. PHP walks the
// cities/ folders in alphabetical order, so the expectation does too.
const aisCities = CITIES.filter((city) => city.ais.enabled).sort((a, b) =>
  a.slug.localeCompare(b.slug),
)
const expectedBbox = JSON.stringify(
  aisCities.map(({ boundingBox: { west, south, east, north } }) => [
    [south, west],
    [north, east],
  ]),
)
const phpBbox = (script) =>
  JSON.stringify(JSON.parse(execFileSync('php', [script, '--bbox'], { encoding: 'utf8' })))

const fromRepo = phpBbox(join(root, 'server/api/ais.php'))
if (fromRepo !== expectedBbox) {
  console.error(`❌ ais.php subscribes with ${fromRepo}, the city definitions say ${expectedBbox}`)
  process.exit(1)
}

// Deployed layout: script and city.json copies side by side, no src/ around.
const deployDir = mkdtempSync(join(tmpdir(), 'mrt-ais-deploy-'))
try {
  copyFileSync(join(root, 'server/api/ais.php'), join(deployDir, 'ais.php'))
  for (const city of CITIES) {
    mkdirSync(join(deployDir, 'cities', city.slug), { recursive: true })
    copyFileSync(
      join(root, 'src/cities', city.slug, 'city.json'),
      join(deployDir, 'cities', city.slug, 'city.json'),
    )
  }
  const deployed = phpBbox(join(deployDir, 'ais.php'))
  if (deployed !== expectedBbox) {
    console.error(`❌ Deployed ais.php subscribes with ${deployed}, expected ${expectedBbox}`)
    process.exit(1)
  }
} finally {
  rmSync(deployDir, { recursive: true, force: true })
}
console.log(
  `✅ PHP AIS proxy subscribes with the shared city boxes (${aisCities.map((c) => c.slug).join(', ')}): ${fromRepo}`,
)
