/** Type declarations so the route-type selection can be unit-tested. */

import type { City } from '../src/lib/city.ts'
import type { TransitMode } from '../src/lib/transit-mode.ts'

export function routeTypesForCity(city: City): Record<TransitMode, Set<string>>
