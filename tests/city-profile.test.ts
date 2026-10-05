import { afterEach, describe, expect, it } from 'vitest'
import { loadRostockNetwork, rostockSchedule } from './cities'
import type { PreparedLine, PreparedNetwork, TransitMode } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'
import {
  buildCityActivity,
  buildCityProfile,
  formatCount,
  formatKilometres,
  isRoundTheClock,
  sameActivity,
  tunnelPercent,
} from '@/lib/city-profile'
import { setLanguage } from '@/lib/i18n'
import type { ScheduleJson } from '@/lib/timetable'

afterEach(() => setLanguage('en'))

/**
 * The city profile: everything the city card states about a network. The
 * facts come from the geometry and the day's departures, the way the line
 * profile's do, and the cases worth pinning are the ones where a naive
 * sum would lie – a stop served by three lines is one stop position, a
 * line's two directions are one length, and a timetable that runs
 * through the night is not a fifteen-minute service day.
 */

function line(
  id: string,
  mode: TransitMode,
  length: number,
  stopIds: string[],
  extras: { tunnels?: [number, number][]; nhn?: number[] } = {},
): PreparedLine {
  const direction = (dir: 0 | 1) => ({
    lineId: id,
    direction: dir,
    from: dir === 0 ? 'A' : 'B',
    to: dir === 0 ? 'B' : 'A',
    path: [
      [12.1, 54.1],
      [12.11, 54.1],
    ] as [number, number][],
    cum: [0, length],
    totalLength: length,
    stops: stopIds.map((stopId, i) => ({
      id: stopId,
      name: `Stop ${stopId}`,
      coord: [12.1, 54.1] as [number, number],
      dist: (length / Math.max(1, stopIds.length - 1)) * i,
      nhn: extras.nhn?.[i],
    })),
    tunnels: extras.tunnels ?? [],
    bridges: [],
  })
  return {
    id,
    name: `Line ${id}`,
    color: '#abc',
    mode,
    vehicle: { length: 12, width: 2.5, height: 3 },
    directions: [direction(0), direction(1)],
  }
}

function network(lines: PreparedLine[]): PreparedNetwork {
  return {
    meta: { source: 'osm', attribution: '' } as PreparedNetwork['meta'],
    lines,
    lineById: new Map(lines.map((l) => [l.id, l])),
  }
}

function sched(lines: Record<string, number[][]>): ScheduleJson {
  return {
    lines: Object.fromEntries(
      Object.entries(lines).map(([id, dirs]) => [
        id,
        Object.fromEntries(dirs.map((departures, i) => [String(i), { departures }])),
      ]),
    ),
  } as ScheduleJson
}

describe('buildCityProfile', () => {
  const tram = line('1', 'tram', 10_000, ['a', 'b', 'c'], {
    tunnels: [[2_000, 4_000]],
    nhn: [4, 12, 53],
  })
  const bus = line('22', 'bus', 6_000, ['c', 'd'], { nhn: [53, 0] })
  const ferry = line('F', 'ferry', 1_000, ['e', 'f'])

  it('counts lines per mode in display order and stop positions once', () => {
    const profile = buildCityProfile(network([bus, ferry, tram]), undefined)
    expect(profile.modes.map((m) => [m.mode, m.lines])).toEqual([
      ['tram', 1],
      ['bus', 1],
      ['ferry', 1],
    ])
    // c is served by the tram and the bus – one position, not two
    expect(profile.stopPositions).toBe(6)
    expect(profile.lines).toEqual({ total: 3, running: null })
  })

  it('measures line kilometres per line, not per direction, and the tunnel share the same way', () => {
    const profile = buildCityProfile(network([tram, bus, ferry]), undefined)
    expect(profile.lineMeters).toBe(17_000)
    expect(profile.tunnelMeters).toBe(2_000)
    expect(tunnelPercent(profile)).toBe(12)
    expect(profile.longest).toEqual({ lineId: '1', mode: 'tram', meters: 10_000 })
  })

  it('spans the heights of the stops that carry one and names the highest', () => {
    const profile = buildCityProfile(network([tram, bus, ferry]), undefined)
    expect(profile.elevation).toEqual({ min: 0, max: 53, highestStop: 'Stop c' })
    // A network without heights has no row
    expect(buildCityProfile(network([ferry]), undefined).elevation).toBeNull()
  })

  it('tells lines with departures from lines the timetable leaves idle', () => {
    const profile = buildCityProfile(
      network([tram, bus, ferry]),
      sched({ '1': [[3600, 7200], [4000]], F: [[], []] }),
    )
    expect(profile.lines).toEqual({ total: 3, running: 1 })
    expect(profile.modes.map((m) => [m.mode, m.running])).toEqual([
      ['tram', 1],
      ['bus', 0],
      ['ferry', 0],
    ])
    expect(profile.trips).toEqual({ total: 3, shortWorkings: 0 })
    expect(profile.service).toEqual({ first: 3600, last: 7200 })
  })

  it('has no trips and no service without a timetable', () => {
    const profile = buildCityProfile(network([tram]), undefined)
    expect(profile.trips).toBeNull()
    expect(profile.service).toBeNull()
  })

  it('reads the real Rostock data the way the working notes describe it', () => {
    const profile = buildCityProfile(loadRostockNetwork(), rostockSchedule)
    expect(profile.modes.map((m) => m.mode)).toEqual(['tram', 'train', 'bus', 'ferry'])
    expect(profile.lines.total).toBeGreaterThan(30)
    // Whether every line runs is the feed's business: tram 2 had no departures
    // while its tracks were rebuilt and came back in a nightly refresh
    // (36 of 36), which is why the idle case is pinned on the
    // synthetic schedule above and not here
    expect(profile.lines.running).toBeGreaterThan(30)
    expect(profile.lines.running).toBeLessThanOrEqual(profile.lines.total)
    expect(profile.stopPositions).toBeGreaterThan(500)
    // ~424 line kilometres, of which a few hundred metres under the Hbf
    expect(profile.lineMeters).toBeGreaterThan(350_000)
    expect(tunnelPercent(profile)).toBeLessThanOrEqual(1)
    expect(profile.elevation!.min).toBeLessThan(5)
    expect(profile.elevation!.max).toBeGreaterThan(40)
    expect(profile.trips!.total).toBeGreaterThan(3_000)
    expect(profile.trips!.shortWorkings).toBeGreaterThan(0)
    // The night buses run hourly, so no pause of the day reaches an hour
    expect(isRoundTheClock(profile.service!)).toBe(true)
  })
})

describe('the service span', () => {
  it('is the two ends of the longest pause, whatever day the feed codes the night on', () => {
    // A tram every hour from 03:50 to 23:50, a night bus at 00:30 coded as
    // 24:30 of the day and another line's 00:03 coded as the day's own – the
    // pause is 00:30 to 03:50, not 00:03 to 24:30
    const hourly = Array.from({ length: 21 }, (_, h) => (3 + h) * 3600 + 50 * 60)
    const profile = buildCityProfile(
      network([line('1', 'tram', 1000, ['a']), line('N', 'bus', 1000, ['b'])]),
      sched({ '1': [hourly, [180]], N: [[24 * 3600 + 1800]] }),
    )
    expect(profile.service).toEqual({ first: 3 * 3600 + 50 * 60, last: 1800 })
    expect(isRoundTheClock(profile.service!)).toBe(false)
  })

  it('calls a day whose longest pause is under an hour round the clock', () => {
    // Berlin's trams: the longest gap of the night is 03:00 to 03:15
    expect(isRoundTheClock({ first: 3 * 3600 + 900, last: 3 * 3600 })).toBe(true)
    expect(isRoundTheClock({ first: 4 * 3600, last: 1 * 3600 })).toBe(false)
  })
})

function snapshot(overrides: Partial<VehicleSnapshot>): VehicleSnapshot {
  return {
    id: 'x',
    lineId: '1',
    lineName: 'Line 1',
    color: '#abc',
    mode: 'tram',
    vehicle: { length: 32, width: 2.65, height: 3.6 },
    direction: 0,
    distance: 0,
    lon: 12.1,
    lat: 54.1,
    bearing: 0,
    status: 'moving',
    inTunnel: false,
    nextStopName: '',
    destination: '',
    origin: '',
    delaySeconds: 0,
    realtime: false,
    ...overrides,
  }
}

describe('buildCityActivity', () => {
  it('counts the fleet per mode and the median delay over the covered vehicles only', () => {
    const activity = buildCityActivity([
      snapshot({ id: 'a', mode: 'tram', realtime: true, delaySeconds: 300 }),
      snapshot({ id: 'b', mode: 'tram', realtime: true, delaySeconds: 60 }),
      snapshot({ id: 'c', mode: 'bus', realtime: true, delaySeconds: 120 }),
      snapshot({ id: 'd', mode: 'bus', delaySeconds: 9_999 }),
      snapshot({ id: 'e', mode: 'ferry' }),
    ])
    expect(activity.total).toBe(5)
    expect(activity.byMode).toEqual({ tram: 2, bus: 2, ferry: 1 })
    expect(activity.delay).toEqual({ medianSeconds: 120, vehicles: 3 })
  })

  it('has no delay without live data, and an empty fleet at night', () => {
    expect(buildCityActivity([snapshot({})]).delay).toBeNull()
    expect(buildCityActivity([])).toEqual({ total: 0, byMode: {}, delay: null })
  })

  it('tells two readings apart only where a count or the delay differs', () => {
    const a = buildCityActivity([snapshot({ id: 'a' }), snapshot({ id: 'b', mode: 'bus' })])
    expect(
      sameActivity(
        a,
        buildCityActivity([snapshot({ id: 'a' }), snapshot({ id: 'b', mode: 'bus' })]),
      ),
    ).toBe(true)
    // Same total, a tram swapped for a bus
    expect(
      sameActivity(
        a,
        buildCityActivity([snapshot({ id: 'a', mode: 'bus' }), snapshot({ id: 'b', mode: 'bus' })]),
      ),
    ).toBe(false)
    expect(
      sameActivity(
        a,
        buildCityActivity([
          snapshot({ id: 'a' }),
          snapshot({ id: 'b', mode: 'bus', realtime: true }),
        ]),
      ),
    ).toBe(false)
    expect(sameActivity(null, null)).toBe(true)
    expect(sameActivity(a, null)).toBe(false)
  })
})

describe('the formats', () => {
  it('write whole kilometres above ten and one decimal below, in the reader’s digits', () => {
    expect(formatKilometres(1_164_300)).toBe('1,164 km')
    expect(formatKilometres(3_800)).toBe('3.8 km')
    expect(formatKilometres(28_900, 1)).toBe('28.9 km')
    setLanguage('de')
    expect(formatKilometres(1_164_300)).toBe('1.164 km')
    expect(formatKilometres(3_800)).toBe('3,8 km')
  })

  it('group a count the same way', () => {
    expect(formatCount(20_459)).toBe('20,459')
    setLanguage('de')
    expect(formatCount(20_459)).toBe('20.459')
  })
})
