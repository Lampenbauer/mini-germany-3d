import { describe, expect, it } from 'vitest'
import { overrideFerryPositions, type FerrySnapshotLike } from '@/lib/ais'
import type { AisVessel } from '@/lib/ais-extract'

/**
 * The ferry override: simulated FG/FW ferries snap onto their real AIS
 * twins – but only with a fresh fix close by, and on the two-vessel
 * Warnemünde crossing each boat must correct its own trip.
 */

const NOW = 1_800_000_000_000
const MAPPING: Record<number, string> = { 111: 'FG', 221: 'FW', 222: 'FW' }

function fix(overrides: Partial<AisVessel>): AisVessel {
  return {
    mmsi: 111,
    name: 'WARNOWSTROMER',
    lat: 54.099,
    lon: 12.114,
    sogKn: 0,
    cogDeg: null,
    headingDeg: null,
    navStatus: 0,
    typeCode: 60,
    lengthM: 20,
    widthM: 6,
    positionAt: NOW,
    ...overrides,
  }
}

function ferry(overrides: Partial<FerrySnapshotLike>): FerrySnapshotLike {
  return { lineId: 'FG', mode: 'ferry', lon: 12.115, lat: 54.0995, bearing: 40, ...overrides }
}

describe('overrideFerryPositions', () => {
  it('moves a ferry onto its nearby AIS fix, keeping the timetable bearing when moored', () => {
    const snapshot = ferry({})
    const count = overrideFerryPositions([snapshot], [fix({})], MAPPING, NOW)
    expect(count).toBe(1)
    expect(snapshot.lon).toBeCloseTo(12.114, 6)
    expect(snapshot.lat).toBeCloseTo(54.099, 6)
    expect(snapshot.bearing).toBe(40) // no course reported – GTFS bearing stands
  })

  it('takes the AIS course when the vessel reports one', () => {
    const snapshot = ferry({})
    overrideFerryPositions([snapshot], [fix({ cogDeg: 220, sogKn: 4 })], MAPPING, NOW)
    expect(snapshot.bearing).toBe(220)
  })

  it('ignores stale fixes, far fixes, unmapped vessels, and non-ferries', () => {
    const stale = ferry({})
    expect(
      overrideFerryPositions([stale], [fix({ positionAt: NOW - 4 * 60_000 })], MAPPING, NOW),
    ).toBe(0)

    const far = ferry({})
    expect(overrideFerryPositions([far], [fix({ lat: 54.11 })], MAPPING, NOW)).toBe(0)

    const unmapped = ferry({})
    expect(overrideFerryPositions([unmapped], [fix({ mmsi: 999 })], MAPPING, NOW)).toBe(0)

    const tram = ferry({ mode: 'tram' })
    expect(overrideFerryPositions([tram], [fix({})], MAPPING, NOW)).toBe(0)
    expect(tram.lon).toBe(12.115)
  })

  it('pairs the two Warnemünde boats with their own trips by distance', () => {
    // Trip A sits at the west pier, trip B mid-crossing – the fixes lie
    // right next to "their" trip and must not swap.
    const tripA = ferry({ lineId: 'FW', lon: 12.091, lat: 54.1768 })
    const tripB = ferry({ lineId: 'FW', lon: 12.095, lat: 54.177 })
    const boatA = fix({ mmsi: 221, name: 'BREITLING', lon: 12.0915, lat: 54.1768 })
    const boatB = fix({ mmsi: 222, name: 'MF WARNOW', lon: 12.0952, lat: 54.1771 })
    const count = overrideFerryPositions([tripA, tripB], [boatB, boatA], MAPPING, NOW)
    expect(count).toBe(2)
    expect(tripA.lon).toBeCloseTo(12.0915, 6)
    expect(tripB.lon).toBeCloseTo(12.0952, 6)
  })

  it('never assigns one vessel to two trips', () => {
    const tripA = ferry({ lineId: 'FW', lon: 12.091, lat: 54.1768 })
    const tripB = ferry({ lineId: 'FW', lon: 12.092, lat: 54.1768 })
    const boat = fix({ mmsi: 221, lon: 12.0912, lat: 54.1768 })
    const count = overrideFerryPositions([tripA, tripB], [boat], MAPPING, NOW)
    expect(count).toBe(1)
    // The nearer trip won; the other kept its timetable position
    expect(tripA.lon).toBeCloseTo(12.0912, 6)
    expect(tripB.lon).toBe(12.092)
  })
})
