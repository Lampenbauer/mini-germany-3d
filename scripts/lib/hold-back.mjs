/**
 * The pure half of scripts/hold-back-cities.mjs: which cities a refresh
 * changed, which failures a Vitest JSON report holds, and which city a
 * failure belongs to by its name alone.
 */

import { relative } from 'node:path'

/** The city slugs among paths under src/cities/, sorted. */
export function citiesOfPaths(paths) {
  const slugs = new Set()
  for (const path of paths) {
    const match = /^src\/cities\/([^/]+)\//.exec(path)
    if (match) slugs.add(match[1])
  }
  return [...slugs].sort()
}

/** The first line of a failure message, short enough for an annotation. */
function firstLine(message) {
  const line = String(message ?? '').trim().split('\n')[0].trim()
  return line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/**
 * The failures a Vitest JSON report holds: one per failed test, and one
 * per file that failed without a failed test – an import that threw, an
 * error outside every test – with no titles. `root` makes the report's
 * absolute file names relative (tests/hamburg.test.ts).
 */
export function failuresOfReport(report, root) {
  const failures = []
  for (const file of report.testResults ?? []) {
    const path = relative(root, file.name)
    const failed = (file.assertionResults ?? []).filter((test) => test.status === 'failed')
    for (const test of failed) {
      failures.push({
        file: path,
        titles: [...(test.ancestorTitles ?? []), test.title],
        message: firstLine(test.failureMessages?.[0]),
      })
    }
    if (failed.length === 0 && file.status === 'failed') {
      failures.push({ file: path, titles: [], message: firstLine(file.message) })
    }
  }
  return failures
}

/**
 * The city a failure belongs to by its name alone, among `slugs` (the
 * cities the refresh changed), or null: a test in tests/<slug>.test.ts,
 * or one whose titles name exactly one of them as a word – "Network
 * dataset of hamburg", the slug groups in cities.test.ts, "the Rostock
 * dataset". A file that failed outside its tests is nobody's by name:
 * tests/cities.ts loads every city's network, and one broken network
 * fails every file that imports it.
 */
export function cityOfFailure(failure, slugs) {
  if (failure.titles.length === 0) return null
  const own = /^tests\/([a-z]+)\.test\.tsx?$/.exec(failure.file)?.[1]
  if (own && slugs.includes(own)) return own
  const named = slugs.filter((slug) =>
    failure.titles.some((title) => new RegExp(`\\b${slug}\\b`, 'i').test(title)),
  )
  return named.length === 1 ? named[0] : null
}

/** A failure as one line: file › titles: message. */
export function describeFailure(failure) {
  const where = [failure.file, ...failure.titles].join(' › ')
  return failure.message ? `${where}: ${failure.message}` : where
}

/** A service-day log without the lines of the cities held back. */
export function withoutCities(log, slugs) {
  return log
    .split('\n')
    .filter((line) => !slugs.some((slug) => line.startsWith(`${slug}:`)))
    .join('\n')
}
