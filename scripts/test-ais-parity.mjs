#!/usr/bin/env node
/**
 * Parity test: the PHP AIS extraction (server/api/ais.php --selftest)
 * must distill the captured aisstream messages into exactly the state
 * src/lib/ais-extract.ts produces – same vessels, same fields, same
 * order. Runs locally and in CI (requires php in PATH). The TS side is
 * imported directly (Node strips the types since 22.18), so this always
 * tests the real implementation, never a copy of it.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aisStateVessels, mergeAisMessage } from '../src/lib/ais-extract.ts'

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
