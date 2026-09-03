#!/usr/bin/env node
/**
 * Parity test: the PHP AIS extraction (server/api/ais.php --selftest)
 * must distill the captured aisstream messages into exactly the state
 * src/lib/ais-extract.ts produces – same vessels, same fields, same
 * order. Runs locally and in CI (requires php in PATH). The TS side is
 * imported directly (Node strips the types since 22.18), so this always
 * tests the real implementation, never a copy of it.
 *
 * Second check: the bounding box PHP subscribes with (php ais.php --bbox)
 * must be the one rostock-bounding-box.ts reads – from the repository's
 * src/data file, and from a copy next to the script, the layout the deploy
 * leaves behind.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aisStateVessels, mergeAisMessage } from '../src/lib/ais-extract.ts'
import { rostockBoundingBox } from '../src/lib/rostock-bounding-box.ts'

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

// --- Bounding box ----------------------------------------------------------
const { west, south, east, north } = rostockBoundingBox
const expectedBbox = JSON.stringify([
  [south, west],
  [north, east],
])
const phpBbox = (script) =>
  JSON.stringify(JSON.parse(execFileSync('php', [script, '--bbox'], { encoding: 'utf8' })))

const fromRepo = phpBbox(join(root, 'server/api/ais.php'))
if (fromRepo !== expectedBbox) {
  console.error(`❌ ais.php subscribes with ${fromRepo}, rostock-bounding-box.ts says ${expectedBbox}`)
  process.exit(1)
}

// Deployed layout: script and JSON side by side, no src/ around.
const deployDir = mkdtempSync(join(tmpdir(), 'mrt-ais-deploy-'))
try {
  copyFileSync(join(root, 'server/api/ais.php'), join(deployDir, 'ais.php'))
  copyFileSync(
    join(root, 'src/data/rostock-bounding-box.json'),
    join(deployDir, 'rostock-bounding-box.json'),
  )
  const deployed = phpBbox(join(deployDir, 'ais.php'))
  if (deployed !== expectedBbox) {
    console.error(`❌ Deployed ais.php subscribes with ${deployed}, expected ${expectedBbox}`)
    process.exit(1)
  }
} finally {
  rmSync(deployDir, { recursive: true, force: true })
}
console.log(`✅ PHP AIS proxy subscribes with the shared Rostock bounding box: ${fromRepo}`)
