#!/usr/bin/env node
/**
 * Parity test for the AIS archive: the PHP writer (server/api/ais.php
 * --selftest-archive) must record the captured aisstream messages into
 * exactly the files src/lib/ais-archive.ts writes – the same hours per
 * city, the same lines in the same order, the snapshot that opens each
 * hour included, and the same files gone once the retention passes.
 * Runs locally and in CI (requires php in PATH). The TS side is imported
 * directly (Node strips the types), so this always tests the real
 * implementation, never a copy of it.
 *
 * The fixture's messages are spread 90 s apart from a fixed instant, so
 * the run crosses three hour boundaries; a last batch 73½ hours later
 * opens an hour whose creation prunes the first one (72 hours kept).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AisArchiveWriter } from '../src/lib/ais-archive.ts'
import { archiveFileStore } from '../src/lib/ais-archive-fs.ts'
import { CITIES } from '../src/cities/definitions.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'tests/fixtures/ais-messages.json')
const NOW = 1_800_000_000_000

const messages = JSON.parse(readFileSync(fixture, 'utf8'))
const entries = messages.map((message, i) => ({ atMs: NOW + i * 90_000, message }))
const LATE = NOW + 73.5 * 3_600_000
for (const [i, message] of messages.slice(0, 10).entries()) {
  entries.push({ atMs: LATE + i * 90_000, message })
}

// PHP walks the cities/ folders in alphabetical order – so does the writer here
const cities = CITIES.filter((city) => city.ais.enabled)
  .sort((a, b) => a.slug.localeCompare(b.slug))
  .map(({ slug, boundingBox }) => ({ slug, box: boundingBox }))

const tsDir = mkdtempSync(join(tmpdir(), 'mrt-ais-archive-ts-'))
const phpDir = mkdtempSync(join(tmpdir(), 'mrt-ais-archive-php-'))
const entriesFile = join(tsDir, 'entries.json')
/** Reports a mismatch and leaves through the cleanup below – process.exit would skip it. */
const fail = (...lines) => {
  for (const line of lines) console.error(line)
  return false
}
const ok = (() => {
  const writer = new AisArchiveWriter(archiveFileStore(tsDir), cities)
  const state = new Map()
  for (const { atMs, message } of entries) writer.record(state, message, atMs)

  writeFileSync(entriesFile, JSON.stringify(entries))
  execFileSync('php', [join(root, 'server/api/ais.php'), '--selftest-archive', entriesFile, phpDir], {
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
      '❌ PHP wrote different archive files than ais-archive.ts!',
      `  TS : ${expectedNames.join(', ')}`,
      `  PHP: ${actualNames.join(', ')}`,
    )
  }
  // Hours 1–3 of the run and the late hour survive; hour 0 fell to the retention
  const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13)
  const survivors = [1, 2, 3].map((h) => `rostock/${hourKey(NOW + h * 3_600_000)}`)
  survivors.push(`rostock/${hourKey(LATE)}`)
  if (JSON.stringify(expectedNames) !== JSON.stringify(survivors.sort())) {
    return fail(`❌ Expected the hour files ${survivors.join(', ')}, got ${expectedNames.join(', ')}`)
  }
  let lineCount = 0
  for (const name of expectedNames) {
    const a = expected.get(name)
    const b = actual.get(name)
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        return fail(
          `❌ ${name}: line ${i + 1} differs (${a.length} vs ${b.length} lines)`,
          `  TS : ${a[i]}`,
          `  PHP: ${b[i]}`,
        )
      }
    }
    lineCount += a.length
  }
  console.log(
    `✅ PHP AIS archive matches ais-archive.ts: ${expectedNames.length} hour files, ${lineCount} lines identical`,
  )
  return true
})()
rmSync(tsDir, { recursive: true, force: true })
rmSync(phpDir, { recursive: true, force: true })
if (!ok) process.exit(1)
