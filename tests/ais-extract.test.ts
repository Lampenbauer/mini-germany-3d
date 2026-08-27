import { describe, expect, it } from 'vitest'
import rawFixtures from './fixtures/ais-messages.json'
import {
  AIS_RECKON_CAP_MS,
  aisStateVessels,
  deadReckon,
  mergeAisMessage,
  type AisRawMessage,
  type AisState,
  type AisVessel,
} from '@/lib/ais-extract'

/**
 * The fixture is a real 3-minute capture from aisstream.io over the
 * Rostock bounding box (2026-08-27, 139 messages, 92 vessels) – the same
 * file scripts/test-ais-parity.mjs replays through the PHP twin, so both
 * implementations face identical reality.
 */
const fixtureLines = rawFixtures as AisRawMessage[]

const NOW = 1_800_000_000_000

function vessel(overrides: Partial<AisVessel> = {}): AisVessel {
  return {
    mmsi: 1,
    name: '',
    lat: 54.1,
    lon: 12.1,
    sogKn: 8,
    cogDeg: 90,
    headingDeg: null,
    navStatus: 0,
    typeCode: 0,
    lengthM: null,
    widthM: null,
    positionAt: NOW,
    ...overrides,
  }
}

describe('mergeAisMessage', () => {
  it('builds a vessel from a class A position report', () => {
    const state: AisState = new Map()
    const report = fixtureLines.find(
      (m) => m.MessageType === 'PositionReport' && m.MetaData?.ShipName?.trim() === 'VAERMLAND',
    )!
    mergeAisMessage(state, report, NOW)
    const v = state.get(304031000)!
    expect(v.name).toBe('VAERMLAND')
    expect(v.lat).toBeCloseTo(54.1557, 3)
    expect(v.navStatus).toBe(5) // moored at the Stena berth
    expect(v.sogKn).toBe(0)
    expect(v.positionAt).toBe(NOW)
  })

  it('maps the AIS not-available sentinels to null', () => {
    const state: AisState = new Map()
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 42, ShipName: 'X' },
        Message: {
          StandardClassBPositionReport: {
            Latitude: 54.1,
            Longitude: 12.1,
            Sog: 102.3,
            Cog: 360,
            TrueHeading: 511,
          },
        },
      },
      NOW,
    )
    const v = state.get(42)!
    expect(v.sogKn).toBeNull()
    expect(v.cogDeg).toBeNull()
    expect(v.headingDeg).toBeNull()
  })

  it('adds name, type, and dimensions from static data', () => {
    const state: AisState = new Map()
    const staticMsg = fixtureLines.find(
      (m) => m.MessageType === 'ShipStaticData' && m.MetaData?.ShipName?.trim() === 'DENEB',
    )!
    mergeAisMessage(state, staticMsg, NOW)
    const v = state.get(211222290)!
    expect(v.name).toBe('DENEB')
    expect(v.lengthM).toBe(52) // Dimension A 20 + B 32
    expect(v.widthM).toBe(12)
    // Static reports still carry the last known position via MetaData
    expect(v.lat).toBeCloseTo(54.098, 2)
  })

  it('ignores an invalid ReportB instead of zeroing type and size', () => {
    const state: AisState = new Map()
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 7, ShipName: 'Y', latitude: 54.1, longitude: 12.1 },
        Message: {
          StaticDataReport: {
            ReportA: { Name: 'NAMED', Valid: true },
            ReportB: { ShipType: 60, Dimension: { A: 5, B: 5, C: 2, D: 2 }, Valid: false },
          },
        },
      },
      NOW,
    )
    const v = state.get(7)!
    expect(v.name).toBe('NAMED')
    expect(v.typeCode).toBe(0)
    expect(v.lengthM).toBeNull()
  })

  it('digests the full capture into one record per vessel', () => {
    const state: AisState = new Map()
    for (const message of fixtureLines) mergeAisMessage(state, message, NOW)
    const vessels = aisStateVessels(state, NOW)
    expect(vessels.length).toBe(92)
    const mmsis = vessels.map((v) => v.mmsi)
    expect(mmsis).toEqual([...mmsis].sort((a, b) => a - b))
    // The city ferries are all in the picture
    const names = new Set(vessels.map((v) => v.name))
    expect(names).toContain('WARNOWSTROMER')
    expect(names).toContain('BREITLING')
    expect(names).toContain('MF WARNOW')
  })
})

describe('aisStateVessels', () => {
  it('hides stale positions but keeps the record as memory', () => {
    const state: AisState = new Map([
      [1, vessel({ mmsi: 1, positionAt: NOW - 31 * 60_000 })],
      [2, vessel({ mmsi: 2, positionAt: NOW - 60_000 })],
      [3, vessel({ mmsi: 3, positionAt: NOW - 72 * 3600_000 })],
    ])
    const vessels = aisStateVessels(state, NOW)
    expect(vessels.map((v) => v.mmsi)).toEqual([2])
    // 31 min: off the list, still remembered; 72 h: gone for good
    expect(state.has(1)).toBe(true)
    expect(state.has(3)).toBe(false)
  })

  it('gives a returning ferry her size back from memory', () => {
    // The Gedser run: BERLIN learns her static data, sails out of the
    // box for two hours, and comes back with nothing but a position
    // report – the model must be the 169 m ferry again immediately.
    const state: AisState = new Map()
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 211331640, ShipName: 'BERLIN', latitude: 54.15, longitude: 12.1 },
        Message: {
          ShipStaticData: { Name: 'BERLIN', Type: 60, Dimension: { A: 90, B: 79, C: 13, D: 12 } },
        },
      },
      NOW,
    )
    const away = NOW + 2 * 3600_000
    expect(aisStateVessels(state, away)).toEqual([]) // out of the box
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 211331640, ShipName: 'BERLIN' },
        Message: {
          PositionReport: { Latitude: 54.2, Longitude: 12.09, Sog: 15, Cog: 180, TrueHeading: 181 },
        },
      },
      away,
    )
    const back = aisStateVessels(state, away)
    expect(back).toHaveLength(1)
    expect(back[0].lengthM).toBe(169)
    expect(back[0].typeCode).toBe(60)
    expect(back[0].name).toBe('BERLIN')
  })
})

describe('deadReckon', () => {
  it('moves a vessel along its course', () => {
    // 8 kn ≈ 4.12 m/s due east for 30 s ≈ 123 m
    const moved = deadReckon(vessel({ positionAt: NOW - 30_000 }), NOW)
    expect(moved.lat).toBeCloseTo(54.1, 6)
    const meters = (moved.lon - 12.1) * 111_320 * Math.cos((54.1 * Math.PI) / 180)
    expect(meters).toBeGreaterThan(115)
    expect(meters).toBeLessThan(130)
    expect(moved.bearingDeg).toBe(90)
  })

  it('stops extrapolating past the cap', () => {
    const capped = deadReckon(vessel({ positionAt: NOW - 10 * 60_000 }), NOW)
    const atCap = deadReckon(vessel({ positionAt: NOW - AIS_RECKON_CAP_MS }), NOW)
    expect(capped.lon).toBeCloseTo(atCap.lon, 10)
  })

  it('keeps slow and course-less vessels in place', () => {
    const anchored = deadReckon(vessel({ sogKn: 0.1, positionAt: NOW - 60_000 }), NOW)
    expect(anchored.lon).toBe(12.1)
    const noCourse = deadReckon(vessel({ cogDeg: null, headingDeg: 45, positionAt: NOW - 60_000 }), NOW)
    expect(noCourse.lon).toBe(12.1)
    expect(noCourse.bearingDeg).toBe(45)
  })
})
