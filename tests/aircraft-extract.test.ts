import { describe, expect, it, vi } from 'vitest'
import rawFixture from './fixtures/adsb-aircraft.json'
import {
  AIRCRAFT_EXPIRE_MS,
  AIRCRAFT_PLAYBACK_DELAY_MS,
  AIRCRAFT_RECKON_MAX_MS,
  AIRCRAFT_STATE_KEEP_MS,
  AIRCRAFT_TRACK_KEEP_MS,
  AIRCRAFT_MARGIN_NM,
  AIRCRAFT_TRACK_MAX_POINTS,
  adsbQuery,
  aircraftPlaybackSample,
  aircraftStateList,
  mergeAdsbAircraft,
  mergeAdsbResponse,
  pressureLift,
  pressureReference,
  withinQuery,
  type AdsbRawResponse,
  type Aircraft,
  type AircraftState,
  type AircraftTrackPoint,
} from '@/lib/aircraft-extract'
import { AircraftClient } from '@/lib/aircraft'
import { aircraftTitle, formatAltitude, formatGroundSpeed, formatVerticalRate } from '@/lib/aircraft-info'

/**
 * The fixture is one real answer of adsb.fi's open data API for the
 * circle around Frankfurt (2026-09-11, 50 aircraft, from an A380 at
 * FL350 to a club aircraft at 750 ft and three on the ground) – the same
 * file scripts/test-aircraft-parity.mjs replays through the PHP twin.
 */
const fixture = rawFixture as AdsbRawResponse

const NOW = 1_800_000_000_000
/** The geoid height a pressure altitude is lifted by where nothing better is known (see pressureLift). */
const GEOID = 39

function aircraft(overrides: Partial<Aircraft> = {}): Aircraft {
  return {
    hex: '3c65a2',
    callsign: 'DLH3Y',
    registration: 'D-AIMB',
    typeCode: 'A388',
    description: 'AIRBUS A-380-800',
    category: 'A5',
    lat: 50.2,
    lon: 8.1,
    altGeomM: 10850.9,
    altBaroM: 10553.7,
    onGround: false,
    gsKn: 457.7,
    trackDeg: 291.8,
    headingDeg: 297.7,
    verticalRateMps: 5,
    rollDeg: 0,
    squawk: '0616',
    source: 'adsb',
    positionAt: NOW,
    track: [],
    ...overrides,
  }
}

/**
 * A track point near the helper aircraft, offsets in degrees; its
 * altitude geometric unless `geom` says otherwise, as the extraction
 * marks it (none on the ground).
 */
function point(
  t: number,
  latOff = 0,
  lonOff = 0,
  k: {
    alt?: number | null
    gs?: number | null
    track?: number | null
    rate?: number | null
    hdg?: number | null
    geom?: boolean
  } = {},
): AircraftTrackPoint {
  const alt = k.alt !== undefined ? k.alt : 3000
  return [
    t,
    50.2 + latOff,
    8.1 + lonOff,
    alt,
    k.gs !== undefined ? k.gs : 250,
    k.track !== undefined ? k.track : 90,
    k.rate !== undefined ? k.rate : 0,
    k.hdg !== undefined ? k.hdg : null,
    k.geom !== undefined ? k.geom : alt !== null,
  ]
}

describe('mergeAdsbAircraft', () => {
  it('builds a record from one feed entry, in metres', () => {
    const state: AircraftState = new Map()
    mergeAdsbAircraft(
      state,
      {
        hex: '3C65A2',
        type: 'adsb_icao',
        flight: 'DLH3Y   ',
        r: 'D-AIMB',
        t: 'a388',
        desc: 'AIRBUS A-380-800',
        alt_baro: 34625,
        alt_geom: 35600,
        gs: 457.7,
        track: 291.8,
        true_heading: 297.68,
        baro_rate: 1024,
        geom_rate: 992,
        roll: 0.18,
        squawk: '0616',
        category: 'A5',
        lat: 50.198959,
        lon: 8.10473,
      },
      NOW,
    )
    const a = state.get('3c65a2')!
    expect(a).toMatchObject({
      hex: '3c65a2',
      callsign: 'DLH3Y',
      registration: 'D-AIMB',
      typeCode: 'A388',
      category: 'A5',
      onGround: false,
      altBaroM: 10553.7,
      altGeomM: 10850.9,
      gsKn: 457.7,
      trackDeg: 291.8,
      headingDeg: 297.68,
      // The geometric rate where there is one: 992 ft/min
      verticalRateMps: 5,
      rollDeg: 0.18,
      squawk: '0616',
      source: 'adsb',
      positionAt: NOW,
    })
    expect(a.track).toEqual([[NOW, 50.198959, 8.10473, 10850.9, 457.7, 291.8, 5, 297.68, true]])
  })

  it('marks every fix with the kind of altitude it carries', () => {
    const state: AircraftState = new Map()
    // An older transponder: the pressure altitude alone, and the fix says so
    mergeAdsbAircraft(state, { hex: '4b1803', alt_baro: 2500, gs: 140, lat: 50.05, lon: 8.4 }, NOW)
    const fix = state.get('4b1803')!.track[0]
    expect(fix[3]).toBe(762)
    expect(fix[8]).toBe(false)
    // The same aircraft once it reports the geometric altitude too
    mergeAdsbAircraft(state, { hex: '4b1803', alt_baro: 2400, alt_geom: 3050, gs: 140, lat: 50.05, lon: 8.41 }, NOW + 4000)
    expect(state.get('4b1803')!.track[1].slice(3)).toEqual([929.6, 140, null, null, null, true])
  })

  it('reads the ground, the missing fields and the multilaterated source', () => {
    const state: AircraftState = new Map()
    mergeAdsbAircraft(
      state,
      { hex: '3d2f0c', type: 'mlat', alt_baro: 'ground', gs: 3.2, track: 180, lat: 50.03, lon: 8.57 },
      NOW,
    )
    const a = state.get('3d2f0c')!
    expect(a.onGround).toBe(true)
    expect(a.altBaroM).toBeNull()
    expect(a.altGeomM).toBeNull()
    expect(a.headingDeg).toBeNull()
    expect(a.verticalRateMps).toBeNull()
    expect(a.rollDeg).toBeNull()
    expect(a.callsign).toBe('')
    expect(a.source).toBe('mlat')
    expect(a.track[0][3]).toBeNull()
    expect(a.track[0][8]).toBe(false)
  })

  it('ignores entries without an address or a position, and the surface vehicles', () => {
    const state: AircraftState = new Map()
    mergeAdsbAircraft(state, { hex: 'xyz', lat: 50, lon: 8 }, NOW)
    mergeAdsbAircraft(state, { hex: 'abcdef' }, NOW)
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 91, lon: 8 }, NOW)
    // A follow-me car at the airport reports category C1
    mergeAdsbAircraft(state, { hex: '3c1234', lat: 50.03, lon: 8.57, category: 'C1', alt_baro: 'ground' }, NOW)
    expect(state.size).toBe(0)
    // A non-ICAO address with the '~' prefix is an address
    mergeAdsbAircraft(state, { hex: '~2a1b3c', lat: 50.03, lon: 8.57 }, NOW)
    expect(state.has('~2a1b3c')).toBe(true)
  })

  it('records a track point only for a newer fix, and keeps the static data either way', () => {
    const state: AircraftState = new Map()
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 50, lon: 8, gs: 200, track: 90 }, NOW)
    // The same fix polled again a second later: seen_pos grew by one, the stamp did not
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 50, lon: 8, gs: 200, track: 90, flight: 'EWG1AB' }, NOW)
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 50, lon: 8, gs: 200, track: 90 }, NOW - 500)
    const a = state.get('abcdef')!
    expect(a.track).toHaveLength(1)
    expect(a.callsign).toBe('EWG1AB')
    // A newer fix adds one; a later entry without a callsign keeps the one heard
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 50.01, lon: 8.01, gs: 200, track: 90 }, NOW + 4000)
    expect(a.track).toHaveLength(2)
    expect(a.callsign).toBe('EWG1AB')
    expect(a.positionAt).toBe(NOW + 4000)
  })

  it('prunes the track by age and caps its length', () => {
    const state: AircraftState = new Map()
    for (let i = 0; i < AIRCRAFT_TRACK_MAX_POINTS + 20; i++) {
      mergeAdsbAircraft(state, { hex: 'abcdef', lat: 50 + i * 0.001, lon: 8 }, NOW + i * 1000)
    }
    expect(state.get('abcdef')!.track).toHaveLength(AIRCRAFT_TRACK_MAX_POINTS)
    mergeAdsbAircraft(state, { hex: 'abcdef', lat: 51, lon: 8 }, NOW + 1_000_000 + AIRCRAFT_TRACK_KEEP_MS)
    expect(state.get('abcdef')!.track).toHaveLength(1)
  })

  it('digests the Frankfurt answer into one record per aircraft, stamped by seen_pos', () => {
    const state: AircraftState = new Map()
    mergeAdsbResponse(state, fixture, NOW)
    const list = aircraftStateList(state, NOW)
    expect(list.length).toBe(50)
    expect(list.map((a) => a.hex)).toEqual([...list.map((a) => a.hex)].sort())
    const a380 = list.find((a) => a.hex === '3c65a2')!
    expect(a380.typeCode).toBe('A388')
    // seen_pos 0.134 s before the poll
    expect(a380.positionAt).toBe(NOW - 134)
    expect(list.filter((a) => a.onGround)).toHaveLength(3)
    expect(list.filter((a) => a.source === 'mlat').length).toBeGreaterThan(0)
  })
})

describe('aircraftStateList', () => {
  it('lists fresh positions, keeps stale records a while, then forgets them', () => {
    const state: AircraftState = new Map([
      ['a', aircraft({ hex: 'a', positionAt: NOW - AIRCRAFT_EXPIRE_MS - 1 })],
      ['b', aircraft({ hex: 'b', positionAt: NOW - 1000 })],
      ['c', aircraft({ hex: 'c', positionAt: NOW - AIRCRAFT_STATE_KEEP_MS - 1 })],
    ])
    expect(aircraftStateList(state, NOW).map((a) => a.hex)).toEqual(['b'])
    expect(state.has('a')).toBe(true)
    expect(state.has('c')).toBe(false)
  })
})

describe('aircraftPlaybackSample', () => {
  it('interpolates position, altitude and kinematics between two fixes', () => {
    const a = aircraft({
      track: [point(NOW, 0, 0, { alt: 3000, gs: 200, track: 80, rate: -5 }), point(NOW + 10_000, 0, 0.02, { alt: 2900, gs: 220, track: 100, rate: -7 })],
    })
    const s = aircraftPlaybackSample(a, NOW + 5000)
    expect(s.lon).toBeCloseTo(8.11, 8)
    expect(s.lat).toBeCloseTo(50.2, 8)
    expect(s.altM).toBeCloseTo(2950, 6)
    expect(s.bearingDeg).toBeCloseTo(90, 6)
    expect(s.gsKn).toBeCloseTo(210, 6)
    expect(s.verticalRateMps).toBeCloseTo(-6, 6)
    expect(s.turnRateDegPerS).toBeCloseTo(2, 6)
    expect(s.moving).toBe(true)
    expect(s.reckoned).toBe(false)
  })

  it('eases the track the short way round', () => {
    const a = aircraft({ track: [point(NOW, 0, 0, { track: 350 }), point(NOW + 10_000, 0.02, 0, { track: 10 })] })
    expect(aircraftPlaybackSample(a, NOW + 5000).bearingDeg).toBeCloseTo(0, 6)
  })

  it('stands on the first fix before it and flies on past the last one', () => {
    const a = aircraft({ track: [point(NOW, 0, 0, { gs: 200, track: 90, rate: 10, alt: 1000 })] })
    const before = aircraftPlaybackSample(a, NOW - 1000)
    expect(before.lon).toBe(8.1)
    expect(before.moving).toBe(false)
    // Ten seconds on at 200 kn east: about a kilometre, ten metres a second up
    const on = aircraftPlaybackSample(a, NOW + 10_000)
    expect(on.reckoned).toBe(true)
    expect(on.moving).toBe(true)
    expect(on.lat).toBeCloseTo(50.2, 6)
    expect((on.lon - 8.1) * 111_320 * Math.cos((50.2 * Math.PI) / 180)).toBeCloseTo(1028.9, 0)
    expect(on.altM).toBeCloseTo(1100, 6)
    // …and no further than the reckoning window, where it freezes
    const far = aircraftPlaybackSample(a, NOW + AIRCRAFT_RECKON_MAX_MS + 60_000)
    const edge = aircraftPlaybackSample(a, NOW + AIRCRAFT_RECKON_MAX_MS)
    expect(far.lon).toBe(edge.lon)
    expect(far.moving).toBe(false)
  })

  it('does not reckon without a speed or a track', () => {
    const a = aircraft({ track: [point(NOW, 0, 0, { gs: null })] })
    const s = aircraftPlaybackSample(a, NOW + 5000)
    expect(s.lon).toBe(8.1)
    expect(s.reckoned).toBe(true)
    expect(s.moving).toBe(false)
  })

  it('takes the record itself for an aircraft without a track', () => {
    const a = aircraft({ track: [], gsKn: null })
    const s = aircraftPlaybackSample(a, NOW - AIRCRAFT_PLAYBACK_DELAY_MS)
    expect(s.lon).toBe(8.1)
    expect(s.altM).toBe(10850.9)
  })

  it('points the nose along the heading, eased on its own arc, and the bearing along the track', () => {
    // Crabbing into a crosswind: the nose 20° off the track, the whole way
    const a = aircraft({
      track: [point(NOW, 0, 0, { track: 350, hdg: 10 }), point(NOW + 10_000, 0.02, 0, { track: 10, hdg: 30 })],
    })
    const s = aircraftPlaybackSample(a, NOW + 5000)
    expect(s.bearingDeg).toBeCloseTo(0, 6)
    expect(s.noseDeg).toBeCloseTo(20, 6)
    // Without a heading the nose is the bearing
    expect(aircraftPlaybackSample(aircraft({ track: [point(NOW), point(NOW + 10_000, 0.02)] }), NOW + 5000).noseDeg).toBeCloseTo(
      90,
      6,
    )
  })

  it('keeps a parked aircraft pointing where it did, whatever its fixes wobble', () => {
    // On the apron the transponder reports the heading and no track; the
    // fixes wander a few metres. Neither their azimuth nor north is a
    // direction – the heading is, and where it goes quiet the last one known
    const parked = aircraft({
      onGround: true,
      track: [
        point(NOW, 0, 0, { alt: null, gs: 0, track: null, hdg: 285 }),
        point(NOW + 10_000, 0.00003, 0.00004, { alt: null, gs: 0, track: null, hdg: 285 }),
        point(NOW + 20_000, 0, 0, { alt: null, gs: 0, track: null, hdg: null }),
        point(NOW + 30_000, 0.00004, -0.00003, { alt: null, gs: 0, track: null, hdg: null }),
      ],
    })
    for (const t of [NOW - 1000, NOW + 5000, NOW + 15_000, NOW + 25_000, NOW + 35_000]) {
      const s = aircraftPlaybackSample(parked, t)
      expect(s.noseDeg).toBe(285)
      expect(s.bearingDeg).toBe(285)
      expect(s.moving).toBe(false)
    }
    // Nothing ever known: north, and steady
    const mute = aircraft({
      onGround: true,
      track: [point(NOW, 0, 0, { alt: null, gs: 0, track: null }), point(NOW + 10_000, 0.00003, 0.00004, { alt: null, gs: 0, track: null })],
    })
    expect(aircraftPlaybackSample(mute, NOW + 5000).noseDeg).toBe(0)
  })

  it('holds the nose through a pushback and a stale track', () => {
    // Pushed back: moving south-west tail first, the nose on its heading
    // north-east the whole way. The track a taxiing aircraft still carries
    // is the number of its last velocity message and must not swing the nose
    const pushback = aircraft({
      onGround: true,
      track: [
        point(NOW, 0, 0, { alt: null, gs: 3, track: 250, hdg: 70 }),
        point(NOW + 10_000, -0.0001, -0.0002, { alt: null, gs: 3, track: 250, hdg: 70 }),
        point(NOW + 20_000, -0.0002, -0.0004, { alt: null, gs: 3, track: 250, hdg: 70 }),
      ],
    })
    expect(aircraftPlaybackSample(pushback, NOW + 5000).noseDeg).toBe(70)
    expect(aircraftPlaybackSample(pushback, NOW + 15_000).noseDeg).toBe(70)
    // Reckoned on past the last fix: still nose first along the heading
    expect(aircraftPlaybackSample(pushback, NOW + 25_000).noseDeg).toBe(70)
    expect(aircraftPlaybackSample(pushback, NOW + 25_000).bearingDeg).toBe(250)
  })

  it('reads a track point written before the heading existed as one without', () => {
    const a = aircraft({ track: [[NOW, 50.2, 8.1, null, 0, null, null], [NOW + 10_000, 50.2, 8.1, null, 0, 40, null]] })
    expect(aircraftPlaybackSample(a, NOW + 5000).noseDeg).toBe(40)
  })

  it('carries a null altitude for an aircraft on the ground', () => {
    const a = aircraft({ onGround: true, track: [point(NOW, 0, 0, { alt: null, gs: 12 }), point(NOW + 10_000, 0, 0.001, { alt: null, gs: 12 })] })
    expect(aircraftPlaybackSample(a, NOW + 5000)).toMatchObject({ altM: null, groundShare: 1 })
  })

  it('keeps an approach on the geometric scale once the record reports the ground', () => {
    // The record is a few seconds ahead of the playback: it has landed and
    // reports no altitude of either kind, while the playback is still on
    // its final approach. Those fixes carry geometric altitudes, and stay
    // them – read off the record, they were lifted by the geoid height,
    // and the landing hovered forty metres over the runway
    const landed = aircraft({
      onGround: true,
      altGeomM: null,
      altBaroM: null,
      track: [
        point(NOW, 0, 0, { alt: 92, gs: 130, rate: -3.6 }),
        point(NOW + 5000, 0, 0.005, { alt: 74, gs: 130, rate: -3.6 }),
        point(NOW + 10_000, 0, 0.01, { alt: null, gs: 99, rate: null }),
      ],
    })
    const s = aircraftPlaybackSample(landed, NOW + 2500, GEOID)
    expect(s.altM).toBeCloseTo(83, 6)
    expect(s.groundShare).toBe(0)
  })

  it('lifts a pressure altitude by the lift given, fix by fix, and says which kind it draws', () => {
    const a = aircraft({
      altGeomM: 1000,
      track: [point(NOW, 0, 0, { alt: 900, geom: false }), point(NOW + 10_000, 0, 0.01, { alt: 1000, geom: true })],
    })
    expect(aircraftPlaybackSample(a, NOW + 5000, GEOID).altM).toBeCloseTo(969.5, 6)
    // Without a lift every altitude stays as reported
    expect(aircraftPlaybackSample(a, NOW + 5000).altM).toBeCloseTo(950, 6)
    // The kind is the nearer fix's
    expect(aircraftPlaybackSample(a, NOW + 2500, GEOID).altGeometric).toBe(false)
    expect(aircraftPlaybackSample(a, NOW + 7500, GEOID).altGeometric).toBe(true)
  })

  it('reads a fix written before the kind existed by the record', () => {
    const fix: AircraftTrackPoint = [NOW, 50.2, 8.1, 500, 140, 90, -3, null]
    const geometric = aircraft({ altGeomM: 520, altBaroM: 480, track: [fix] })
    expect(aircraftPlaybackSample(geometric, NOW - 1000, GEOID).altM).toBe(500)
    const pressure = aircraft({ altGeomM: null, altBaroM: 480, track: [fix] })
    expect(aircraftPlaybackSample(pressure, NOW - 1000, GEOID).altM).toBe(539)
    // On the ground the record reports neither – and nearly every aircraft
    // that reports the ground reported a geometric altitude in the air
    const landed = aircraft({ onGround: true, altGeomM: null, altBaroM: null, track: [fix] })
    expect(aircraftPlaybackSample(landed, NOW - 1000, GEOID).altM).toBe(500)
  })

  it('comes down from the last fix in the air at its own rate, onto the ground by the first fix on it', () => {
    // Frankfurt: the feeders lose a landing a few metres over
    // the runway and hear it again on the ground a minute on – holding
    // the last altitude, the aircraft hovered over the runway that long
    const landing = aircraft({
      onGround: true,
      altGeomM: null,
      altBaroM: null,
      track: [
        point(NOW, 0, 0, { alt: 160, gs: 120, rate: -3.5 }),
        point(NOW + 50_000, 0, 0.02, { alt: null, gs: 35, rate: null }),
      ],
    })
    const early = aircraftPlaybackSample(landing, NOW + 2000, GEOID)
    expect(early.altM).toBeCloseTo(153, 6)
    expect(early.altGeometric).toBe(true)
    expect(early.groundShare).toBeCloseTo(0.04, 6)
    // The altitude carried on that long is below any runway: the share is
    // what the layer stops it with (AircraftLayer.drawnHeight)
    const late = aircraftPlaybackSample(landing, NOW + 40_000, GEOID)
    expect(late.altM).toBeCloseTo(20, 6)
    expect(late.groundShare).toBeCloseTo(0.8, 6)
    expect(aircraftPlaybackSample(landing, NOW + 50_000, GEOID)).toMatchObject({ altM: null, groundShare: 1 })
    // A last fix that climbs is held, not flown on upwards
    const level = aircraft({
      track: [point(NOW, 0, 0, { alt: 160, rate: 1 }), point(NOW + 10_000, 0, 0.01, { alt: null })],
    })
    expect(aircraftPlaybackSample(level, NOW + 5000, GEOID).altM).toBe(160)
  })

  it('lifts off along the climb of the first fix in the air, run backwards', () => {
    const takeoff = aircraft({
      track: [
        point(NOW, 0, 0, { alt: null, gs: 30, rate: null }),
        point(NOW + 30_000, 0, 0.02, { alt: 168, gs: 159, rate: 10 }),
      ],
    })
    const rolling = aircraftPlaybackSample(takeoff, NOW + 15_000, GEOID)
    expect(rolling.altM).toBeCloseTo(18, 6)
    expect(rolling.groundShare).toBeCloseTo(0.5, 6)
    const climbing = aircraftPlaybackSample(takeoff, NOW + 27_000, GEOID)
    expect(climbing.altM).toBeCloseTo(138, 6)
    expect(climbing.groundShare).toBeCloseTo(0.1, 6)
    expect(aircraftPlaybackSample(takeoff, NOW + 30_000, GEOID)).toMatchObject({ altM: 168, groundShare: 0 })
  })
})

describe('pressureLift', () => {
  /** An aircraft in the air reporting a pressure altitude and, where given, a geometric one. */
  const flying = (hex: string, altBaroM: number, altGeomM: number | null) =>
    aircraft({ hex, altBaroM, altGeomM, onGround: false })

  it('measures the lift on the sky: the median of the aircraft nearest in pressure altitude', () => {
    const sky = [
      // Low, on the approaches: the geoid and the day's pressure, 120 m
      flying('a1', 230, 350),
      flying('a2', 275, 397),
      flying('a3', 335, 455),
      flying('a4', 350, 464),
      // One transponder off by the geoid height: outvoted
      flying('a5', 410, 484),
      // At cruise the warm air has added 190 m more
      flying('c1', 10_550, 10_860),
      flying('c2', 10_670, 10_980),
      flying('c3', 10_970, 11_290),
      // On the ground and pressure-only: nothing to measure
      aircraft({ hex: 'g1', onGround: true, altBaroM: null, altGeomM: null }),
      flying('p1', 500, null),
    ]
    const liftAt = pressureLift(sky, GEOID)
    expect(liftAt(150)).toBe(120)
    expect(liftAt(10_700)).toBe(310)
  })

  it('falls back to the geoid height where too few report both near the altitude asked about', () => {
    const two = [flying('a1', 230, 350), flying('a2', 275, 397)]
    expect(pressureLift(two, GEOID)(250)).toBe(GEOID)
    // Enough aircraft, but every one of them at cruise: none near 300 m
    const cruise = [flying('c1', 10_550, 10_860), flying('c2', 10_670, 10_980), flying('c3', 10_970, 11_290)]
    expect(pressureLift(cruise, GEOID)(300)).toBe(GEOID)
    expect(pressureLift(cruise, GEOID)(null)).toBe(GEOID)
  })

  it('lifts the Frankfurt answer’s low pressure-only aircraft by what the others measure', () => {
    // Over Frankfurt: geometric 375–450 ft over the pressure altitude
    // down low, against a geoid height of 47 m – the multilaterated
    // aircraft at 500 ft took 47 under the previous rule, and 114 is the truth
    const state: AircraftState = new Map()
    mergeAdsbResponse(state, fixture, NOW)
    const list = aircraftStateList(state, NOW)
    const low = list.find((a) => a.altGeomM === null && a.altBaroM === 152.4)!
    expect(low.source).toBe('mlat')
    expect(pressureLift(list, 47)(pressureReference(low))).toBeCloseTo(114.3, 1)
  })
})

describe('pressureReference', () => {
  it("takes the aircraft's own pressure altitude, else its last fix's, else none", () => {
    expect(pressureReference(aircraft({ altBaroM: 762 }))).toBe(762)
    // Just landed: the approach still being played carries pressure altitudes
    const landed = aircraft({
      onGround: true,
      altGeomM: null,
      altBaroM: null,
      track: [point(NOW, 0, 0, { alt: 120, geom: false }), point(NOW + 5000, 0, 0.01, { alt: 90, geom: false }), point(NOW + 10_000, 0, 0.02, { alt: null })],
    })
    expect(pressureReference(landed)).toBe(90)
    // Geometric fixes alone leave nothing to lift
    expect(pressureReference(aircraft({ onGround: true, altGeomM: null, altBaroM: null, track: [point(NOW, 0, 0, { alt: 120 })] }))).toBeNull()
  })
})

describe('adsbQuery', () => {
  it('asks for the circle around the box that reaches its corner, and a margin beyond', () => {
    // A box 53 km on a side (Frankfurt's, with the 15 km padding it once
    // had): 21 nm to the corner from its centre
    expect(
      adsbQuery({ west: 8.2648, south: 49.8811, east: 9.0083, north: 50.3615 }),
    ).toEqual({ lat: 50.1213, lon: 8.6366, distNm: 21 + AIRCRAFT_MARGIN_NM })
  })

  it('caps the radius at what the API answers for', () => {
    expect(adsbQuery({ west: 0, south: 40, east: 20, north: 60 }).distNm).toBe(250)
  })

  it('serves the sky past the box, out to the circle', () => {
    const query = adsbQuery({ west: 8.2648, south: 49.8811, east: 9.0083, north: 50.3615 })
    // The airport, inside the box
    expect(withinQuery(50.0333, 8.5706, query)).toBe(true)
    // Mainz, 25 km west of the centre: outside the box, inside the circle
    expect(withinQuery(50.0, 8.27, query)).toBe(true)
    // Koblenz, 85 km away: outside both
    expect(withinQuery(50.36, 7.6, query)).toBe(false)
  })
})

describe('AircraftClient', () => {
  it('completes a record from an older server and shifts its clock', async () => {
    const legacy = {
      hex: 'abcdef',
      callsign: 'DLH1AB',
      lat: 50.1,
      lon: 8.6,
      altGeomM: 900,
      gsKn: 150,
      positionAt: NOW - 3000,
      track: [[NOW - 3000, 50.1, 8.6, 900, 150, 90, -3]],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ timestamp: NOW, servedAt: NOW - 5000, aircraft: [legacy] }),
      })),
    )
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    try {
      const list = await new Promise<Aircraft[]>((resolve) => {
        const client = new AircraftClient('/api/aircraft', (_status, aircraft) => {
          client.stop()
          resolve(aircraft)
        })
        client.start(60_000)
      })
      const [a] = list
      // Every field, absent ones as their null or empty value
      expect(a.altBaroM).toBeNull()
      expect(a.rollDeg).toBeNull()
      expect(a.onGround).toBe(false)
      expect(a.registration).toBe('')
      expect(a.source).toBe('other')
      expect(a.callsign).toBe('DLH1AB')
      // The server's clock ran 5 s behind this browser's
      expect(a.positionAt).toBe(NOW - 3000 + 5000)
      expect(a.track[0][0]).toBe(NOW - 3000 + 5000)
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })
})

describe('the words on the card', () => {
  it('names an aircraft by callsign, registration or address', () => {
    expect(aircraftTitle(aircraft())).toBe('DLH3Y')
    expect(aircraftTitle(aircraft({ callsign: '' }))).toBe('D-AIMB')
    expect(aircraftTitle(aircraft({ callsign: '', registration: '' }))).toBe('3C65A2')
  })

  it('writes the altitude in metres with the flight level, or the ground', () => {
    expect(formatAltitude(aircraft())).toBe('10 851 m · FL346')
    expect(formatAltitude(aircraft({ altGeomM: null, altBaroM: 762 }))).toBe('762 m')
    expect(formatAltitude(aircraft({ onGround: true, altGeomM: null, altBaroM: null }))).toBe('on the ground')
    expect(formatAltitude(aircraft({ altGeomM: null, altBaroM: null }))).toBe('not reported')
  })

  it('writes speed and climb the way a reader can use them', () => {
    expect(formatGroundSpeed(457.7)).toBe('458 kn · 848 km/h')
    expect(formatGroundSpeed(0.4)).toBe('0 kn')
    expect(formatGroundSpeed(null)).toBe('not reported')
    expect(formatVerticalRate(5.2)).toBe('+5.2 m/s')
    expect(formatVerticalRate(-3)).toBe('−3.0 m/s')
    expect(formatVerticalRate(0.2)).toBe('level')
    expect(formatVerticalRate(null)).toBe('not reported')
  })
})
