/** Type declarations so the hold-back's attribution can be unit-tested. */

export interface TestFailure {
  /** The test file, relative to the repository (tests/hamburg.test.ts). */
  file: string
  /** The describe titles and the test's own; empty for a file that failed outside its tests. */
  titles: string[]
  message: string
}

export function citiesOfPaths(paths: string[]): string[]
export function failuresOfReport(report: unknown, root: string): TestFailure[]
export function cityOfFailure(failure: TestFailure, slugs: string[]): string | null
export function describeFailure(failure: TestFailure): string
export function withoutCities(log: string, slugs: string[]): string
