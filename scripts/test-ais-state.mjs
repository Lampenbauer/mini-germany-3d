#!/usr/bin/env node
/**
 * State migration test for server/api/ais.php.
 *
 * The AIS state file lives in the system temp directory and outlives
 * deploys, so a record written by an earlier version is missing whatever
 * fields have been added since. Absent is not the same as null: it slips
 * through a `=== null` guard in the browser and throws on the first method
 * call. That reached production once - 134 of 143 vessels served without
 * draughtM, and clicking any of them blanked the view - so the loader
 * completes every record from the default shape, and this insists on it.
 *
 * Runs locally and in CI (requires php in PATH).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOW = 1_800_000_000_000

/** Every field the browser expects on a vessel. */
const REQUIRED = [
  'mmsi', 'name', 'lat', 'lon', 'sogKn', 'cogDeg', 'headingDeg',
  'navStatus', 'typeCode', 'lengthM', 'widthM', 'draughtM', 'positionAt', 'track',
]

/**
 * A record as the FIRST AIS release wrote it: no track, no draughtM. Both
 * were added later, and both are the shape of the next such field too.
 */
const legacyState = {
  listenedAt: NOW - 10_000,
  state: {
    211222290: {
      mmsi: 211222290,
      name: 'DENEB',
      lat: 54.0982,
      lon: 12.106,
      sogKn: 8.4,
      cogDeg: 90,
      headingDeg: 92,
      navStatus: 0,
      typeCode: 70,
      lengthM: 52,
      widthM: 12,
      positionAt: NOW - 30_000,
    },
    // A record whose track is present but the wrong type – completing a
    // missing key would not catch this one.
    211222291: { mmsi: 211222291, name: 'X', lat: 54.1, lon: 12.1, positionAt: NOW - 30_000, track: 'nonsense' },
  },
}

const dir = mkdtempSync(join(tmpdir(), 'mg3d-ais-state-'))
const stateFile = join(dir, 'state.json')
writeFileSync(stateFile, JSON.stringify(legacyState))

const output = execFileSync(
  'php',
  [join(root, 'server/api/ais.php'), '--selftest-state', stateFile, String(NOW)],
  { encoding: 'utf8' },
)
const served = JSON.parse(output)

let failed = false
if (served.vessels.length !== 2) {
  console.error(`❌ Expected 2 vessels from the legacy state, got ${served.vessels.length}`)
  failed = true
}
for (const vessel of served.vessels) {
  for (const field of REQUIRED) {
    if (!(field in vessel)) {
      console.error(`❌ ${vessel.mmsi}: field "${field}" missing from the served record`)
      failed = true
    }
  }
  if (!Array.isArray(vessel.track)) {
    console.error(`❌ ${vessel.mmsi}: track is ${JSON.stringify(vessel.track)}, not a list`)
    failed = true
  }
}
// The fields that were already there must survive the completion untouched
const deneb = served.vessels.find((v) => v.mmsi === 211222290)
if (deneb?.name !== 'DENEB' || deneb?.lengthM !== 52 || deneb?.sogKn !== 8.4) {
  console.error('❌ Completing the record overwrote values it already had:', deneb)
  failed = true
}
if (deneb?.draughtM !== null) {
  console.error(`❌ A field the record predates must come back as null, got ${deneb?.draughtM}`)
  failed = true
}

if (failed) process.exit(1)
console.log(`✅ PHP completes a legacy AIS state: ${REQUIRED.length} fields on every vessel`)
