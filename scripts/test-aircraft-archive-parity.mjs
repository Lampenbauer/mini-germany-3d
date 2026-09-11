#!/usr/bin/env node
/**
 * Parity test for the aircraft archive: the PHP writer
 * (server/api/aircraft.php --selftest-archive) must record a sequence
 * of adsb.fi answers into exactly the files src/lib/aircraft-archive.ts
 * writes – the same hours per city, the same lines in the same order,
 * the snapshot that opens each hour included, and the same files gone
 * once the retention passes. Runs locally and in CI (requires php in
 * PATH). The TS side is imported directly (Node strips the types), so
 * this always tests the real implementation, never a copy of it.
 *
 * The sequence is built from the captured Frankfurt answer
 * (tests/fixtures/adsb-aircraft.json): the same aircraft polled every
 * fifteen seconds for an hour and a quarter, flown back and forth along
 * their tracks between polls – with a second copy of the traffic over Berlin,
 * so two cities record at once, a few aircraft whose fix does not move
 * on for a while (nothing new to write), one that drops out of coverage
 * and comes back (gone from the snapshot, then a static line again),
 * and callsigns that appear late (a static line mid-hour). The polls
 * start ten minutes before an hour boundary and run across it; a last
 * batch three days later opens an hour whose creation prunes the first.
 *
 * Third check: the cover circle the keeper polls (php aircraft.php
 * --cover) must be the one aircraft-archive.ts derives from the city
 * definitions, and inside what adsb.fi answers for.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AircraftArchiveWriter, adsbCoverQuery, coverWithinLimit } from '../src/lib/aircraft-archive.ts'
import { ADSB_MAX_DIST_NM, adsbQuery, aircraftStateList } from '../src/lib/aircraft-extract.ts'
import { archiveFileStore } from '../src/lib/archive-fs.ts'
import { CITIES } from '../src/cities/definitions.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tests/fixtures/adsb-aircraft.json')
/** 2027-01-15T07:50:00Z – ten minutes before the hour, so the sequence opens three hours in a row. */
const START = 1_800_000_000_000 - 10 * 60_000
const POLL_MS = 15_000
const POLLS = 300
/** 72 h 40 min later: the hour it opens keeps the recording from 08:30 the first day on – hour 07 goes, hour 08 stays. */
const LATE = START + 72 * 3_600_000 + 40 * 60_000

// PHP walks the cities/ folders in alphabetical order – so does the writer here
const cities = [...CITIES]
  .sort((a, b) => a.slug.localeCompare(b.slug))
  .map(({ slug, boundingBox }) => ({ slug, query: adsbQuery(boundingBox) }))
const frankfurt = cities.find((city) => city.slug === 'frankfurt').query
const berlin = cities.find((city) => city.slug === 'berlin').query

const base = JSON.parse(readFileSync(fixture, 'utf8')).ac.filter((a) => typeof a.hex === 'string' && !a.hex.startsWith('~'))
const round6 = (value) => Math.round(value * 1e6) / 1e6

/** The fixture's aircraft as poll `i` would report them, over Frankfurt and shifted over Berlin. */
function answerAt(i) {
  const ac = []
  for (const [k, entry] of base.entries()) {
    for (const shifted of [false, true]) {
      const a = { ...entry }
      if (shifted) {
        a.hex = (parseInt(entry.hex, 16) ^ 0x800000).toString(16).padStart(6, '0')
        a.lat = entry.lat + (berlin.lat - frankfurt.lat)
        a.lon = entry.lon + (berlin.lon - frankfurt.lon)
      }
      // Flown back and forth along the track, a few kilometres at most –
      // an hour straight on at cruise would carry them into other cities
      const meters = Math.min(5000, (entry.gs ?? 0) * 0.514444 * 100) * Math.sin((2 * Math.PI * i) / 40)
      const rad = ((entry.track ?? 0) * Math.PI) / 180
      a.lat = round6(a.lat + (Math.cos(rad) * meters) / 111_320)
      a.lon = round6(a.lon + (Math.sin(rad) * meters) / (111_320 * Math.cos((a.lat * Math.PI) / 180)))
      // Every seventh aircraft is heard only every fourth poll: its fix
      // keeps its stamp in between, and nothing is written for it
      if (k % 7 === 3) a.seen_pos = (i % 4) * (POLL_MS / 1000) + (entry.seen_pos ?? 0)
      // One aircraft leaves coverage for ten minutes and comes back
      if (k === 5 && i >= 20 && i < 60) continue
      // A callsign that appears late – a static line in the middle of the hour
      if (k % 11 === 4) {
        if (i < 30) delete a.flight
        else a.flight = `TST${k}${shifted ? 'B' : 'F'}`
      }
      ac.push(a)
    }
  }
  return { ac }
}

const entries = []
for (let i = 0; i < POLLS; i++) entries.push({ atMs: START + i * POLL_MS, answer: answerAt(i) })
for (let i = 0; i < 10; i++) entries.push({ atMs: LATE + i * POLL_MS, answer: answerAt(POLLS + i) })

const tsDir = mkdtempSync(join(tmpdir(), 'mg3d-aircraft-archive-ts-'))
const phpDir = mkdtempSync(join(tmpdir(), 'mg3d-aircraft-archive-php-'))
const entriesFile = join(tsDir, 'entries.ndjson')
/** Reports a mismatch and leaves through the cleanup below – process.exit would skip it. */
const fail = (...lines) => {
  for (const line of lines) console.error(line)
  return false
}
const ok = (() => {
  const writer = new AircraftArchiveWriter(archiveFileStore(tsDir), cities)
  const state = new Map()
  for (const { atMs, answer } of entries) {
    writer.record(state, answer, atMs)
    aircraftStateList(state, atMs) // expiry prunes in place, as the keeper does
  }

  // One entry per line – PHP reads them one at a time
  writeFileSync(entriesFile, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  execFileSync('php', [join(root, 'server/api/aircraft.php'), '--selftest-archive', entriesFile, phpDir], {
    encoding: 'utf8',
  })

  /** Every hour file under a writer's directory, as "<slug>/<hour>" → parsed lines. */
  const collect = (dir) => {
    const files = new Map()
    for (const slug of readdirSync(dir)) {
      if (!statSync(join(dir, slug)).isDirectory()) continue
      for (const name of readdirSync(join(dir, slug))) {
        if (!name.endsWith('.ndjson')) continue
        const lines = readFileSync(join(dir, slug, name), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.stringify(JSON.parse(line)))
        files.set(`${slug}/${name.slice(0, -'.ndjson'.length)}`, lines)
      }
    }
    return files
  }
  const expected = collect(tsDir)
  const actual = collect(phpDir)

  const expectedNames = [...expected.keys()].sort()
  const actualNames = [...actual.keys()].sort()
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    return fail(
      '❌ PHP aircraft archive writes different hour files than aircraft-archive.ts!',
      `  TS : ${expectedNames.join(', ')}`,
      `  PHP: ${actualNames.join(', ')}`,
    )
  }
  // The sequence must have exercised what it claims: two cities, three
  // hours in a row, the first of them pruned by the late batch
  const wanted = [
    'berlin/2027-01-15T08',
    'berlin/2027-01-15T09',
    'berlin/2027-01-18T08',
    'frankfurt/2027-01-15T08',
    'frankfurt/2027-01-15T09',
    'frankfurt/2027-01-18T08',
  ]
  if (JSON.stringify(expectedNames) !== JSON.stringify(wanted)) {
    return fail(`❌ The sequence should leave ${wanted.join(', ')}; it left ${expectedNames.join(', ')}`)
  }
  for (const name of expectedNames) {
    const a = expected.get(name)
    const b = actual.get(name)
    if (a.length !== b.length) {
      return fail(`❌ ${name}: aircraft-archive.ts wrote ${a.length} lines, PHP ${b.length}`)
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return fail(`❌ ${name} line ${i + 1} differs`, `  TS : ${a[i]}`, `  PHP: ${b[i]}`)
      }
    }
  }
  const total = [...expected.values()].reduce((sum, lines) => sum + lines.length, 0)
  const statics = [...expected.values()].flat().filter((line) => line.startsWith('{')).length
  if (statics < 200 || total - statics < 20_000) {
    return fail(`❌ The sequence is thinner than meant: ${statics} static lines, ${total - statics} fixes`)
  }
  console.log(
    `✅ PHP aircraft archive matches aircraft-archive.ts: ${expectedNames.length} hour files, ${total} lines identical (${statics} static)`,
  )

  // --- The cover circle the keeper polls ------------------------------------
  const expectedCover = adsbCoverQuery(cities.map((city) => city.query))
  const phpCover = JSON.parse(execFileSync('php', [join(root, 'server/api/aircraft.php'), '--cover'], { encoding: 'utf8' }))
  if (JSON.stringify(phpCover) !== JSON.stringify(expectedCover)) {
    return fail(`❌ aircraft.php polls ${JSON.stringify(phpCover)}, aircraft-archive.ts says ${JSON.stringify(expectedCover)}`)
  }
  if (!coverWithinLimit(expectedCover)) {
    return fail(`❌ The cover circle (${expectedCover.distNm} nm) is more than adsb.fi answers for (${ADSB_MAX_DIST_NM} nm)`)
  }
  console.log(`✅ The keeper's cover circle is the same on both sides and within adsb.fi's reach: ${JSON.stringify(expectedCover)}`)
  return true
})()

rmSync(tsDir, { recursive: true, force: true })
rmSync(phpDir, { recursive: true, force: true })
if (!ok) process.exit(1)
