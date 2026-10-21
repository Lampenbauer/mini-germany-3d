#!/usr/bin/env node
/**
 * Holds back the cities whose refreshed data fails the unit tests, so that
 * one city does not cost the others their refresh. The nightly run
 * (ci.yml) calls it when the unit tests failed over the night's data: on
 * 20 and 21 October 2026 one pin in Hanover's test and one count in
 * Hamburg's held back the data of all thirteen cities, three nights
 * running. A held city keeps its previous data – network, schedule and
 * whatever else the night rewrote in its folder, which belong together –
 * the others are committed and deployed, and the run stays green; the
 * workflow opens an issue that says which city and why.
 *
 * 1. The cities the refresh changed: the tree the refresh wrote (TREE,
 *    ci.yml's "Identify the source tree") against HEAD.
 * 2. Every failure of the report is put down to a city by its name where
 *    it can be – a test in tests/<slug>.test.ts, or one whose titles name
 *    one changed city (see cityOfFailure).
 * 3. The rest by trying: every changed city on HEAD first – if the files
 *    still fail, it is the code or the clock, not the night, and the run
 *    goes red as before – then one city's new data at a time.
 * 4. The held cities go back to HEAD and the whole suite runs again; it
 *    has to pass, or the run goes red. Nothing held and a green suite is
 *    a flake the second run did not repeat.
 *
 * For the CI runner only: it rewrites src/cities with git restore and git
 * clean. Environment:
 *   TREE            – the tree the refresh wrote, every new file in it
 *   VITEST_REPORT   – the JSON report of the failed run
 *   SERVICE_DAY_LOG – the service days for the data commit's message; a
 *                     held city's line is taken out
 *   HELD_BACK_LOG   – written: a line per held city, for the data commit's
 *                     message and the issue
 *   GITHUB_OUTPUT, GITHUB_STEP_SUMMARY – as GitHub Actions hands them over;
 *                     the outputs are `tree`, `changed` and `held`
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  citiesOfPaths,
  cityOfFailure,
  describeFailure,
  failuresOfReport,
  withoutCities,
} from './lib/hold-back.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TREE = process.env.TREE
const SCRATCH = mkdtempSync(join(tmpdir(), 'hold-back-'))
// The files the monthly tier writes – a city held back on its first
// Sunday waits a month for them
const MONTHLY_FILES = /\/(street-lamps|airfield-lights|buoys|lighthouses)\.json$/

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

function fail(message) {
  console.log(`::error::${message}`)
  process.exit(1)
}

/** Every changed city's folder as the refresh wrote it, or as HEAD has it. */
function setCities(withNewData, changed) {
  for (const slug of changed) {
    const dir = `src/cities/${slug}`
    if (withNewData.has(slug)) {
      git('restore', `--source=${TREE}`, '--worktree', '--', dir)
    } else {
      git('restore', '--source=HEAD', '--worktree', '--', dir)
      git('clean', '-fdq', '--', dir)
    }
  }
}

let runs = 0
/** Vitest over `files` (the whole suite without), with its failures. */
function runVitest(files) {
  const out = join(SCRATCH, `report-${++runs}.json`)
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=dot', '--reporter=json', `--outputFile.json=${out}`, ...files],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] },
  )
  const report = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null
  return { ok: result.status === 0, failures: report ? failuresOfReport(report, ROOT) : [] }
}

if (!TREE) fail('TREE is not set – the tree the refresh wrote is what the cities are put back from.')
const changed = citiesOfPaths(git('diff', '--name-only', 'HEAD', TREE, '--', 'src/cities').split('\n'))
if (changed.length === 0) fail('The unit tests failed, but the refresh changed no city – not the data.')
if (!process.env.VITEST_REPORT || !existsSync(process.env.VITEST_REPORT)) {
  fail('No Vitest report – the unit tests did not get as far as writing one, which is not the data.')
}
const failures = failuresOfReport(JSON.parse(readFileSync(process.env.VITEST_REPORT, 'utf8')), ROOT)
if (failures.length === 0) {
  fail('The unit tests failed without a failed test in the report (a crash, an unhandled error) – not the data.')
}
console.log(`Cities with new data: ${changed.join(', ')}`)

/** slug → the failures that hold it back */
const held = new Map()
const unplaced = []
for (const failure of failures) {
  const slug = cityOfFailure(failure, changed)
  if (slug) held.set(slug, [...(held.get(slug) ?? []), failure])
  else unplaced.push(failure)
}
for (const [slug, own] of held) console.log(`${slug}: held back by name – ${describeFailure(own[0])}`)

if (unplaced.length > 0) {
  const files = [...new Set(unplaced.map((failure) => failure.file))]
  console.log(`Not put down to a city by name: ${files.join(', ')} – trying the cities one at a time`)
  setCities(new Set(), changed)
  if (!runVitest(files).ok) {
    setCities(new Set(changed), changed)
    fail(`${files.join(', ')} fail(s) on the committed data as well – the code or the clock, not tonight's data.`)
  }
  for (const slug of changed.filter((s) => !held.has(s))) {
    setCities(new Set([slug]), changed)
    const run = runVitest(files)
    if (!run.ok) {
      held.set(slug, run.failures.length > 0 ? run.failures : unplaced)
      console.log(`${slug}: held back – its data alone fails ${files.join(', ')}`)
    }
  }
}

const kept = changed.filter((slug) => !held.has(slug))
setCities(new Set(kept), changed)
console.log(`Whole suite again, with ${held.size > 0 ? [...held.keys()].join(', ') + ' held back' : 'nothing held back'}`)
const final = runVitest([])
if (!final.ok) {
  const first = final.failures[0]
  fail(
    `The suite still fails with ${held.size > 0 ? [...held.keys()].join(', ') + ' held back' : 'nothing held back'}` +
      (first ? ` – ${describeFailure(first)}` : '') +
      '. Not one city\'s data alone: look at the code and at the night\'s data together.',
  )
}

// What the run reports – the annotations, the step summary, the lines for
// the data commit's message and the issue
const changedFiles = git('diff', '--name-only', 'HEAD', TREE, '--', 'src/cities').split('\n')
const lines = []
for (const [slug, own] of held) {
  const monthly = changedFiles.some((path) => path.startsWith(`src/cities/${slug}/`) && MONTHLY_FILES.test(path))
  const more = own.length > 1 ? ` (and ${own.length - 1} more)` : ''
  const line =
    `${slug}: ${describeFailure(own[0])}${more}` +
    (monthly ? ' – its lamps and seamarks wait for the next monthly refresh as well' : '')
  lines.push(line)
  // A workflow command's title may hold no colon or comma, its message no %
  console.log(`::warning title=${slug} keeps its previous data::${line.replace(/%/g, '%25')}`)
}
if (process.env.HELD_BACK_LOG && lines.length > 0) {
  writeFileSync(process.env.HELD_BACK_LOG, lines.join('\n') + '\n')
}
if (process.env.SERVICE_DAY_LOG && existsSync(process.env.SERVICE_DAY_LOG)) {
  const log = readFileSync(process.env.SERVICE_DAY_LOG, 'utf8')
  writeFileSync(process.env.SERVICE_DAY_LOG, withoutCities(log, [...held.keys()]))
}
if (process.env.GITHUB_STEP_SUMMARY && lines.length > 0) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      '### Held back – previous data kept',
      '',
      ...lines.map((line) => `- ${line}`),
      '',
      kept.length > 0 ? `Refreshed: ${kept.join(', ')}.` : 'No city is left with new data.',
      '',
    ].join('\n'),
  )
}
git('add', '-A')
const tree = git('write-tree').trim()
git('reset', '-q')
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tree=${tree}\nchanged=${kept.length > 0}\nheld=${[...held.keys()].join(' ')}\n`,
  )
}
console.log(held.size > 0 ? `Held back: ${[...held.keys()].join(', ')}` : 'Nothing held back.')
