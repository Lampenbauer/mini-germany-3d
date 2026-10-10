/** Type declarations so the route-type selection and the thin-schedule guard can be unit-tested. */

import type { City } from '../src/lib/city.ts'
import type { TransitMode } from '../src/lib/transit-mode.ts'

export function routeTypesForCity(city: City): Record<TransitMode, Set<string>>
export function tooFewLinesRunning(networkLineCount: number, linesWithTrips: number): boolean
