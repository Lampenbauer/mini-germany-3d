import { describe, expect, it } from 'vitest'
import rawFixtures from './fixtures/ais-messages.json'
import {
  AIS_MESSAGE_TIME_AHEAD_MS,
  AIS_MESSAGE_TIME_BEHIND_MS,
  AIS_PLAYBACK_DELAY_MS,
  AIS_TRACK_KEEP_MS,
  AIS_TRACK_MAX_POINTS,
  aisFixTimeMs,
  aisMessageTimeMs,
  aisStateVessels,
  mergeAisMessage,
  playbackSample,
  type AisRawMessage,
  type AisState,
  type AisTrackPoint,
  type AisVessel,
} from '@/lib/ais-extract'
import { curvePoint } from '@/lib/track-curve'

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
    lastCourseDeg: null,
    navStatus: 0,
    typeCode: 0,
    lengthM: null,
    widthM: null,
    draughtM: null,
    positionAt: NOW,
    track: [],
    ...overrides,
  }
}

/**
 * A track point in the helper vessel's neighborhood, offsets in degrees.
 * Two in a row under way with the same speed and courses are a static
 * report's copy and the fix it repeats (isStaticCopy) – a test of plain
 * fixes gives them a course each.
 */
function point(
  t: number,
  latOff = 0,
  lonOff = 0,
  kinematics: { sog?: number | null; cog?: number | null; hdg?: number | null } = {},
): AisTrackPoint {
  return [
    t,
    54.1 + latOff,
    12.1 + lonOff,
    kinematics.sog !== undefined ? kinematics.sog : 8,
    kinematics.cog !== undefined ? kinematics.cog : 90,
    kinematics.hdg !== undefined ? kinematics.hdg : null,
  ]
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

  it('keeps the course a ship last held under way while she lies still', () => {
    const state: AisState = new Map()
    const report = (sog: number, cog: number, t: number) =>
      mergeAisMessage(
        state,
        {
          MessageType: 'PositionReport',
          MetaData: { MMSI: 7, latitude: 54.1, longitude: 12.1 },
          Message: { PositionReport: { Latitude: 54.1, Longitude: 12.1, Sog: sog, Cog: cog, TrueHeading: 511 } },
        },
        t,
      )
    report(6.2, 200, NOW)
    expect(state.get(7)!.lastCourseDeg).toBe(200)
    report(1.1, 245, NOW + 1)
    expect(state.get(7)!.lastCourseDeg).toBe(245)
    // Below AIS_UNDER_WAY_SOG_KN the course is drift and leaves no trace,
    // and "not available" none either
    report(0.3, 17, NOW + 2)
    report(0, 360, NOW + 3)
    expect(state.get(7)!.cogDeg).toBeNull()
    expect(state.get(7)!.lastCourseDeg).toBe(245)
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

describe('track recording', () => {
  it('appends one point per fix, with the kinematics of that moment', () => {
    const state: AisState = new Map()
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 9 },
        Message: {
          PositionReport: { Latitude: 54.1, Longitude: 12.1, Sog: 8, Cog: 90, TrueHeading: 92 },
        },
      },
      NOW,
    )
    // A static report between fixes: MetaData coordinates count as a fix
    // and must carry the LAST KNOWN speed and course, not nulls – the
    // copy keeps her listed, and the playback knows it by them
    mergeAisMessage(
      state,
      {
        MetaData: { MMSI: 9, latitude: 54.101, longitude: 12.102 },
        Message: { ShipStaticData: { Name: 'T', Type: 70, Dimension: { A: 1, B: 1, C: 1, D: 1 } } },
      },
      NOW + 60_000,
    )
    const v = state.get(9)!
    expect(v.track).toEqual([
      [NOW, 54.1, 12.1, 8, 90, 92],
      [NOW + 60_000, 54.101, 12.102, 8, 90, 92],
    ])
  })

  it('prunes old points and caps the length', () => {
    const state: AisState = new Map()
    const fix = (t: number): void =>
      mergeAisMessage(
        state,
        { MetaData: { MMSI: 9 }, Message: { PositionReport: { Latitude: 54.1, Longitude: 12.1 } } },
        t,
      )
    fix(NOW - AIS_TRACK_KEEP_MS - 1000)
    fix(NOW)
    expect(state.get(9)!.track.map((p) => p[0])).toEqual([NOW])
    for (let i = 1; i <= AIS_TRACK_MAX_POINTS + 10; i++) fix(NOW + i)
    expect(state.get(9)!.track).toHaveLength(AIS_TRACK_MAX_POINTS)
  })
})

describe('playbackSample', () => {
  const REN = NOW - AIS_PLAYBACK_DELAY_MS

  it('interpolates position and bearing between two fixes', () => {
    const v = vessel({
      track: [point(REN - 30_000, 0, 0, { hdg: 350 }), point(REN + 30_000, 0.001, 0.002, { hdg: 10 })],
    })
    const s = playbackSample(v, REN)
    expect(s.lat).toBeCloseTo(54.1005, 6)
    expect(s.lon).toBeCloseTo(12.101, 6)
    expect(s.bearingDeg).toBeCloseTo(0, 6) // 350 → 10 over the short arc
    expect(s.underWay).toBe(true)
  })

  it('clamps to the track ends – no extrapolation past the last fix', () => {
    const track = [point(REN - 90_000), point(REN - 60_000, 0.001, 0.001, { cog: 40 })]
    const stalled = playbackSample(vessel({ track }), REN)
    expect(stalled.lat).toBeCloseTo(54.101, 6) // waits at the last fix
    expect(stalled.underWay).toBe(false)
    const early = playbackSample(vessel({ track }), REN - 120_000)
    expect(early.lat).toBeCloseTo(54.1, 6)
  })

  it('falls back to the top-level fix with an empty track', () => {
    const s = playbackSample(vessel({ headingDeg: 163 }), REN)
    expect(s.lat).toBeCloseTo(54.1, 6)
    expect(s.bearingDeg).toBe(163)
    expect(s.underWay).toBe(false)
  })

  it('derives the bearing from the segment when no heading is reported', () => {
    const v = vessel({
      track: [
        point(REN - 30_000, 0, 0, { cog: null }),
        point(REN + 30_000, 0.001, 0, { sog: 9, cog: null }), // due north
      ],
    })
    expect(playbackSample(v, REN).bearingDeg).toBeCloseTo(0, 4)
  })

  it('lays the hull along the drawn motion where no heading is reported', () => {
    // Due east over 1 km, both courses 60°: the curve leaves and meets
    // the chord north of east and runs south of east in the middle. The
    // course eased from fix to fix said 60° throughout, and the hull went
    // sideways; it lies along the curve now
    const lonPerKm = 1 / ((111_320 * Math.cos((54.1 * Math.PI) / 180)) / 1000)
    const v = vessel({
      track: [point(REN - 60_000, 0, 0, { cog: 60 }), point(REN + 60_000, 0, lonPerKm, { sog: 9, cog: 60 })],
    })
    const motion = (t: number): number => {
      const a = playbackSample(v, t - 500)
      const b = playbackSample(v, t + 500)
      const east = (b.lon - a.lon) * 111_320 * Math.cos((54.1 * Math.PI) / 180)
      return ((Math.atan2(east, (b.lat - a.lat) * 111_320) * 180) / Math.PI + 360) % 360
    }
    for (const t of [REN - 45_000, REN - 20_000, REN, REN + 20_000, REN + 45_000]) {
      expect(Math.abs(playbackSample(v, t).bearingDeg - motion(t))).toBeLessThan(0.5)
    }
    expect(playbackSample(v, REN).bearingDeg).toBeGreaterThan(95)
    // A heading at one fix is the bow there; its angle to the motion
    // eases out toward the fix that reports none
    const crabbing = vessel({
      track: [point(REN - 60_000, 0, 0, { cog: 60, hdg: 75 }), point(REN + 60_000, 0, lonPerKm, { sog: 9, cog: 60 })],
    })
    expect(playbackSample(crabbing, REN - 60_000 + 1).bearingDeg).toBeCloseTo(75, 1)
    expect(playbackSample(crabbing, REN).bearingDeg - motion(REN)).toBeCloseTo(7.5, 1)
    expect(playbackSample(crabbing, REN + 60_000 - 1).bearingDeg).toBeCloseTo(60, 1)
    // Courses pointing back (a ship going astern): the hull turns from the
    // one to the other the short way, as the chord runs east under it
    const astern = vessel({
      track: [point(REN - 60_000, 0, 0, { cog: 250 }), point(REN + 60_000, 0, lonPerKm, { sog: 9, cog: 290 })],
    })
    expect(playbackSample(astern, REN).bearingDeg).toBeCloseTo(270, 6)
  })

  it('lays a ship with a gyro along the curve while she sails bow first, and eases her gyro where she does not', () => {
    // The motion at an instant, from the positions a second around it
    const motion = (v: AisVessel, t: number): number => {
      const a = playbackSample(v, t - 500)
      const b = playbackSample(v, t + 500)
      const east = (b.lon - a.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180)
      return ((Math.atan2(east, (b.lat - a.lat) * 111_320) * 180) / Math.PI + 360) % 360
    }
    const off = (a: number, b: number): number => ((b - a + 540) % 360) - 180
    // The KAEPP'N BRASS on the Unterwarnow, 7 October 2026: six minutes
    // unheard through a turn from 270° to 342°, her gyro within 2° of her
    // course at either fix. Her heading eased evenly from fix to fix ran
    // her 28° off the curve, which makes most of the turn early
    const t0 = Date.UTC(2026, 9, 7, 10, 49, 38, 187)
    const brass = vessel({
      track: [
        [t0, 54.16029666666667, 12.110805, 7.8, 269.7, 268],
        [Date.UTC(2026, 9, 7, 10, 55, 38, 162), 54.17030666666667, 12.099741666666667, 8.3, 342.3, 341],
      ],
    })
    for (let t = t0 + 15_000; t < brass.track[1][0]; t += 15_000) {
      expect(Math.abs(off(motion(brass, t), playbackSample(brass, t).bearingDeg))).toBeLessThan(2.5)
    }
    // Making 20 m in a minute she pivots on the spot: her gyro turns her
    const pivot = vessel({
      track: [
        point(REN - 30_000, 0, 0, { sog: 0.6, cog: 40, hdg: 0 }),
        point(REN + 30_000, 0.00018, 0, { sog: 0.6, cog: 0, hdg: 90 }),
      ],
    })
    expect(playbackSample(pivot, REN).bearingDeg).toBeCloseTo(45, 6)
    // The ALTENWERDER backing to a stop (Hamburg, the same morning), her
    // bow 160° off her course at the second fix: along the curve she
    // turned 313° round, her gyro says 47° the short way
    const t1 = Date.UTC(2026, 9, 7, 10, 49, 41, 193)
    const altenwerder = vessel({
      track: [
        [t1, 53.54433166666667, 9.95889, 7.6, 55.8, 32],
        [t1 + 60_000, 53.54531333333333, 9.959025, 1.4, 278.7, 79],
      ],
    })
    let turned = 0
    let before = playbackSample(altenwerder, t1).bearingDeg
    for (let t = t1 + 1_000; t <= t1 + 60_000; t += 1_000) {
      const now = playbackSample(altenwerder, t).bearingDeg
      turned += off(before, now)
      before = now
    }
    expect(turned).toBeCloseTo(47, 6)
  })

  it('plays a static report’s copy of a fix under way as the point on her way it is', () => {
    // The SOLAR on the Elbe off the Burchardkai, 7 October 2026: two
    // position reports four minutes apart with nothing between them but
    // a static report, whose MetaData placed her where aisstream had last
    // heard her – a report this keeper never got – with the speed and
    // course of the fix before, stamped with its own time. Played as a
    // fix, it held her bow on 56° for four minutes while the curve ran
    // to 97°, and then sent her 121 m in five seconds
    const t0 = Date.UTC(2026, 9, 7, 10, 39, 34, 819)
    const solar = vessel({
      track: [
        [t0, 53.540078333333334, 9.905056666666667, 5.5, 56.3, null],
        [Date.UTC(2026, 9, 7, 10, 43, 29, 913), 53.54081, 9.91735, 5.5, 56.3, null],
        [Date.UTC(2026, 9, 7, 10, 43, 35, 82), 53.54083, 9.919176666666667, 7.8, 90.3, null],
      ],
    })
    const metersPerDegreeLon = 111_320 * Math.cos((53.5408 * Math.PI) / 180)
    let previous = playbackSample(solar, t0)
    for (let t = t0 + 5_000; t <= Date.UTC(2026, 9, 7, 10, 43, 35); t += 5_000) {
      const s = playbackSample(solar, t)
      const north = (s.lat - previous.lat) * 111_320
      const east = (s.lon - previous.lon) * metersPerDegreeLon
      const track = ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360
      // A steady 7–8 kn, the bow on the track
      expect(Math.hypot(north, east)).toBeGreaterThan(15)
      expect(Math.hypot(north, east)).toBeLessThan(22)
      expect(Math.abs(((s.bearingDeg - track + 540) % 360) - 180)).toBeLessThan(4)
      previous = s
    }
    // She passes the copy's position at her share of the way between the
    // fixes, half a minute before its stamp: 816 of the 937 m
    const at = playbackSample(solar, Date.UTC(2026, 9, 7, 10, 43, 4))
    expect(at.lon).toBeCloseTo(9.91735, 4)

    // A copy where the fix before it stood says only that she was heard:
    // she sails on instead of standing for a minute (LA PALOMA, 10:52)
    const paloma = vessel({
      track: [
        [t0, 53.536275, 9.951641666666665, 7.4, 124, 124],
        [t0 + 55_973, 53.53628, 9.95164, 7.4, 124, 124],
        [t0 + 119_942, 53.53946, 9.950355, 9.9, 344.5, null],
      ],
    })
    const a = playbackSample(paloma, t0 + 20_000)
    const b = playbackSample(paloma, t0 + 40_000)
    expect(Math.hypot((b.lat - a.lat) * 111_320, (b.lon - a.lon) * metersPerDegreeLon)).toBeGreaterThan(40)

    // Beyond the last fix a copy keeps its stamp until the next fix comes in
    const ahead = vessel({ track: [solar.track[0], solar.track[1]] })
    expect(playbackSample(ahead, solar.track[1][0]).lon).toBeCloseTo(9.91735, 6)
    expect(playbackSample(ahead, solar.track[1][0] - 60_000).lon).toBeLessThan(9.9165)

    // At rest a copy is a fix: she was still at her berth when it came,
    // and leaves only after it
    const moored = vessel({
      track: [
        point(REN - 600_000, 0, 0, { sog: 0, cog: null }),
        point(REN - 60_000, 0, 0, { sog: 0, cog: null }),
        point(REN + 60_000, 0.002, 0, { sog: 6, cog: 0 }),
      ],
    })
    expect(playbackSample(moored, REN - 120_000).lat).toBeCloseTo(54.1, 7)
    expect(playbackSample(moored, REN).lat).toBeGreaterThan(54.1005)
  })

  it('lays a ship at rest along the course she came in on, not along her drift', () => {
    // No gyro: the heading is never reported. The last fix under way said
    // 245; at the berth the receiver reports 17 one minute and nothing the next
    const moored = vessel({
      sogKn: 0,
      cogDeg: 17,
      lastCourseDeg: 245,
      track: [point(REN - 30_000, 0, 0, { sog: 0, cog: 17 }), point(REN + 30_000, 0, 0, { sog: 0, cog: null })],
    })
    expect(playbackSample(moored, REN).bearingDeg).toBe(245)
    expect(playbackSample(moored, REN + 60_000).bearingDeg).toBe(245)
    // Never heard moving: her own course is the best there is, north the last resort
    expect(playbackSample(vessel({ ...moored, lastCourseDeg: null }), REN).bearingDeg).toBe(17)
    expect(playbackSample(vessel({ ...moored, lastCourseDeg: null }), REN + 60_000).bearingDeg).toBe(0)
    // A reported heading wins over all of it, at rest as under way
    const gyro = vessel({ ...moored, track: [point(REN - 30_000, 0, 0, { sog: 0, cog: 17, hdg: 90 })] })
    expect(playbackSample(gyro, REN).bearingDeg).toBe(90)
    // Coming in: the course under way eases into the resting bearing
    // without a turn – the last fix under way is the course she keeps
    const arriving = vessel({
      lastCourseDeg: 245,
      track: [point(REN - 30_000, 0, 0, { sog: 2, cog: 245 }), point(REN + 30_000, 0.00001, 0, { sog: 0, cog: 17 })],
    })
    expect(playbackSample(arriving, REN).bearingDeg).toBe(245)
  })

  it('does not report berth wobble as under way', () => {
    const v = vessel({
      track: [point(REN - 30_000), point(REN + 30_000, 0.000001, 0.000001, { cog: 91 })],
    })
    expect(playbackSample(v, REN).underWay).toBe(false)
  })
})

describe('the message’s own time (time_utc)', () => {
  const stampAt = (ms: number) => {
    const d = new Date(ms)
    const two = (n: number) => String(n).padStart(2, '0')
    return (
      `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ` +
      `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}` +
      `.${String(d.getUTCMilliseconds()).padStart(3, '0')}456789 +0000 UTC`
    )
  }

  it('parses aisstream’s stamp to the millisecond and nothing else', () => {
    expect(aisMessageTimeMs('2026-08-27 11:15:39.673431615 +0000 UTC')).toBe(
      Date.UTC(2026, 7, 27, 11, 15, 39, 673),
    )
    expect(aisMessageTimeMs('2026-08-27 11:15:39 +0000 UTC')).toBe(Date.UTC(2026, 7, 27, 11, 15, 39))
    expect(aisMessageTimeMs('2026-08-27T11:15:39Z')).toBeNull()
    expect(aisMessageTimeMs(undefined)).toBeNull()
  })

  it('stamps a fix with its message’s time within the window, the clock outside it', () => {
    const raw = (ms: number | null): AisRawMessage => ({
      MetaData: { MMSI: 5, time_utc: ms === null ? undefined : stampAt(ms) },
      Message: { PositionReport: { Latitude: 54.1, Longitude: 12.1, Sog: 8, Cog: 90 } },
    })
    expect(aisFixTimeMs(raw(NOW - 20_000), NOW)).toBe(NOW - 20_000)
    expect(aisFixTimeMs(raw(NOW + 2_000), NOW)).toBe(NOW + 2_000)
    expect(aisFixTimeMs(raw(NOW + AIS_MESSAGE_TIME_AHEAD_MS + 1), NOW)).toBe(NOW)
    expect(aisFixTimeMs(raw(NOW - AIS_MESSAGE_TIME_BEHIND_MS - 1), NOW)).toBe(NOW)
    expect(aisFixTimeMs(raw(null), NOW)).toBe(NOW)

    // The track carries the message's time, and a message older than the
    // fix held is late, not news: its position is left alone
    const state: AisState = new Map()
    mergeAisMessage(state, raw(NOW - 20_000), NOW)
    mergeAisMessage(state, raw(NOW - 5_000), NOW + 1000)
    const v = state.get(5)!
    expect(v.track.map((p) => p[0])).toEqual([NOW - 20_000, NOW - 5_000])
    expect(v.positionAt).toBe(NOW - 5_000)
    const late: AisRawMessage = {
      MetaData: { MMSI: 5, time_utc: stampAt(NOW - 10_000), ShipName: 'LATE' },
      Message: { PositionReport: { Latitude: 54.2, Longitude: 12.2, Sog: 1, Cog: 180 } },
    }
    mergeAisMessage(state, late, NOW + 2000)
    expect(v.track).toHaveLength(2)
    expect(v.lat).toBe(54.1)
    expect(v.cogDeg).toBe(90)
    expect(v.name).toBe('LATE')
  })

  it('reads the capture’s stamps when the clock stands a minute after it', () => {
    const state: AisState = new Map()
    const clock = Date.UTC(2026, 7, 27, 11, 19, 30)
    for (const message of fixtureLines) mergeAisMessage(state, message, clock)
    const vessels = aisStateVessels(state, clock)
    expect(vessels.length).toBeGreaterThan(50)
    expect(vessels.every((v) => v.positionAt <= clock && v.positionAt >= clock - 5 * 60_000)).toBe(true)
    expect(vessels.filter((v) => v.positionAt !== clock).length).toBe(vessels.length)
  })
})

describe('the curve between two fixes', () => {
  const REN = NOW - AIS_PLAYBACK_DELAY_MS
  const fix = (t: number, lat: number, lon: number, cog: number | null, sog = 8): AisTrackPoint => [
    t,
    lat,
    lon,
    sog,
    cog,
    null,
  ]

  it('bulges toward the courses reported at the fixes and runs along the curve’s tangent', () => {
    // Due east over 1 km, the courses turning from 60° to 120° – the
    // curve bows north of the chord, and in the middle it runs east
    const lonPerKm = 1 / (111_320 * Math.cos((54.1 * Math.PI) / 180) / 1000)
    const v = vessel({ track: [fix(REN - 60_000, 54.1, 12.1, 60), fix(REN + 60_000, 54.1, 12.1 + lonPerKm, 120)] })
    const mid = playbackSample(v, REN)
    expect(mid.lon).toBeCloseTo(12.1 + lonPerKm / 2, 6)
    expect(mid.lat).toBeGreaterThan(54.1 + 50 / 111_320)
    expect(mid.lat).toBeLessThan(54.1 + 300 / 111_320)
    expect(mid.bearingDeg).toBeCloseTo(90, 3)
    // A quarter of the way the ship still heads north of east
    const quarter = playbackSample(v, REN - 30_000)
    expect(quarter.bearingDeg).toBeGreaterThan(60)
    expect(quarter.bearingDeg).toBeLessThan(90)
  })

  it('is the chord where no course is reported, and never leaves it for a course pointing back', () => {
    const lonPerKm = 1 / (111_320 * Math.cos((54.1 * Math.PI) / 180) / 1000)
    const plain = vessel({ track: [fix(REN - 60_000, 54.1, 12.1, null), fix(REN + 60_000, 54.1, 12.1 + lonPerKm, null, 9)] })
    expect(playbackSample(plain, REN).lat).toBeCloseTo(54.1, 8)
    // Courses pointing west on an eastward chord: a ship going astern, or
    // stale numbers – the chord stands
    const astern = vessel({ track: [fix(REN - 60_000, 54.1, 12.1, 250), fix(REN + 60_000, 54.1, 12.1 + lonPerKm, 290)] })
    expect(playbackSample(astern, REN).lat).toBeCloseTo(54.1, 8)
  })

  it('stands on the point itself at the ends', () => {
    expect(curvePoint(100, 0, 45, 135, 0)).toEqual({ eastM: 0, northM: 0, tangentDeg: 45 })
    const end = curvePoint(100, 0, 45, 135, 1)
    expect(end.eastM).toBeCloseTo(100, 9)
    expect(end.northM).toBeCloseTo(0, 9)
    expect(end.tangentDeg).toBeCloseTo(135, 9)
  })
})
