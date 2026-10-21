/** Type declarations so the route-type selection, the thin-schedule guard and the idle reasons can be unit-tested. */

import type { City } from '../src/lib/city.ts'
import type { IdleReason } from '../src/lib/timetable.ts'
import type { TransitMode } from '../src/lib/transit-mode.ts'

export function routeTypesForCity(city: City): Record<TransitMode, Set<string>>
export function tooFewLinesRunning(networkLineCount: number, linesWithTrips: number): boolean
export function idleReasons(
  networkLineIds: string[],
  lines: Record<string, unknown>,
  tripCounts: Map<string, { all: number; thatDay: number }>,
): Record<string, IdleReason>
