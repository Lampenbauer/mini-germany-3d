import { afterEach, describe, expect, it } from 'vitest'
import { loadRostockNetwork, rostockSchedule as schedule } from './cities'
import type { PreparedLine } from '@/data/network-types'
import {
  buildLineActivity,
  buildLineProfile,
  formatLength,
  formatServiceTime,
  formatStopCount,
} from '@/lib/line-profile'
import { setLanguage } from '@/lib/i18n'
import type { ScheduleJson } from '@/lib/timetable'

afterEach(() => setLanguage('en'))

/**
 * The line profile: everything the line card states about a line. The
 * facts come from the network geometry and the day's departures, and the
 * cases worth pinning are the asymmetric ones – the real network has a
 * line that runs 8.8 km out and 6.1 km back, a ferry with no gradient,
 * and a night bus that never sees the morning peak.
 */

function line(overrides: Partial<PreparedLine> = {}): PreparedLine {
  const direction = (from: string, to: string, length: number, stops: number) => ({
    lineId: 'X',
    direction: 0 as const,
    from,
    to,
    path: [
      [12.1, 54.1],
      [12.11, 54.1],
    ] as [number, number][],
    cum: [0, length],
    totalLength: length,
    stops: Array.from({ length: stops }, (_, i) => ({
      id: `s${i}`,
      name: `Stop ${i}`,
      coord: [12.1, 54.1] as [number, number],
      dist: (length / Math.max(1, stops - 1)) * i,
    })),
    tunnels: [] as [number, number][],
  })
  return {
    id: 'X',
    name: 'Line X',
    color: '#abc',
    mode: 'tram',
    vehicle: { length: 32, width: 2.65, height: 3.6 },
    directions: [direction('A', 'B', 1000, 5), direction('B', 'A', 1000, 5)],
    ...overrides,
  } as PreparedLine
}

/** A schedule for one line: departures per direction, seconds of day. */
function sched(dir0: number[], dir1: number[] = dir0, spans: (number[] | null)[] = []): ScheduleJson {
  return {
    lines: { X: { 0: { departures: dir0, spans }, 1: { departures: dir1 } } },
  } as ScheduleJson
}

describe('buildLineProfile', () => {
  it('measures the route per direction', () => {
    const p = buildLineProfile(line(), undefined)
    expect(p.lengthMeters).toEqual([1000, 1000])
    expect(p.stopCount).toEqual([5, 5])
    // 2000 m over 8 inter-stop spans
    expect(p.meanStopSpacing).toBe(250)
  })

  it('reads the headway per direction, not across both', () => {
    // Outbound every 10 min, inbound offset by 5 – merging the two lists
    // first would report a 5-minute service that nobody runs.
    const p = buildLineProfile(line(), sched([0, 600, 1200, 1800], [300, 900, 1500, 2100]))
    expect(p.headway?.median).toBe(600)
  })

  it('reports the morning peak separately, and omits it for a night line', () => {
    const day = [7 * 3600, 7 * 3600 + 300, 7 * 3600 + 600, 12 * 3600, 13 * 3600]
    expect(buildLineProfile(line(), sched(day)).headway?.peak).toBe(300)

    const night = [23 * 3600, 24 * 3600 + 1800, 26 * 3600]
    expect(buildLineProfile(line(), sched(night)).headway?.peak).toBeNull()
  })

  it('spans the service day across midnight', () => {
    // After-midnight departures are encoded past 24:00 and must stay last
    const p = buildLineProfile(line(), sched([5 * 3600, 12 * 3600, 24 * 3600 + 2460]))
    expect(p.service).toEqual({ first: 5 * 3600, last: 24 * 3600 + 2460 })
    expect(formatServiceTime(p.service!.last)).toBe('00:41')
  })

  it('counts short workings, which are the trips with a span', () => {
    const p = buildLineProfile(line(), sched([0, 600, 1200], [0, 600, 1200], [null, [100, 800], [100, 800]]))
    expect(p.trips).toEqual({ total: 6, shortWorkings: 2 })
  })

  it('has no schedule facts without a schedule', () => {
    const p = buildLineProfile(line(), undefined)
    expect(p.service).toBeNull()
    expect(p.headway).toBeNull()
    expect(p.trips).toBeNull()
  })
})

describe('formatting', () => {
  it('gives one length when the directions agree, both when they do not', () => {
    expect(formatLength([18_700, 18_650])).toBe('18.7 km')
    // Line 22 really runs 8.8 km out and 6.1 km back
    expect(formatLength([8800, 6100])).toBe('8.8 / 6.1 km')
    // German reads a comma – the rest of the German UI does too
    setLanguage('de')
    expect(formatLength([18_700, 18_650])).toBe('18,7 km')
    setLanguage('en')
    expect(formatStopCount([39, 39])).toBe('39')
    expect(formatStopCount([26, 21])).toBe('26 / 21')
  })

  it('wraps the after-midnight tail into a readable clock time', () => {
    expect(formatServiceTime(3 * 3600 + 1440)).toBe('03:24')
    expect(formatServiceTime(24 * 3600 + 2460)).toBe('00:41')
  })
})

describe('against the real network', () => {
  const network = loadRostockNetwork()

  it('describes every line without throwing', () => {
    for (const l of network.lines) {
      const p = buildLineProfile(l, schedule as ScheduleJson)
      expect(p.lengthMeters[0]).toBeGreaterThan(0)
      expect(p.stopCount[0]).toBeGreaterThan(1)
      // A headway of half the real one is the merged-directions bug
      if (p.headway) expect(p.headway.median).toBeGreaterThanOrEqual(60)
    }
  })

  it('reads line 1 as the 10-minute tram it is', () => {
    const p = buildLineProfile(network.lineById.get('1')!, schedule as ScheduleJson)
    expect(Math.round(p.headway!.median / 60)).toBe(10)
    expect(p.trips!.shortWorkings).toBeGreaterThan(0)
  })
})

describe('buildLineActivity', () => {
  const vehicle = (lineId: string, extra: Record<string, unknown> = {}) =>
    ({
      id: `${lineId}-x`,
      lineId,
      direction: 0,
      destination: 'B',
      nextStopName: 'Stop 1',
      status: 'moving',
      realtime: false,
      delaySeconds: 0,
      ...extra,
    }) as never

  it("counts only this line's vehicles", () => {
    const a = buildLineActivity(line(), undefined, [vehicle('X'), vehicle('2'), vehicle('X')], 0)
    expect(a.vehicles).toHaveLength(2)
  })

  it('takes the next scheduled departure of each direction', () => {
    // Not by querying a terminus: a terminus is not reliably where a trip
    // starts. Line 1 runs 139 of 217 trips short and showed no departure
    // at all from its own Mecklenburger Allee terminus.
    const a = buildLineActivity(line(), sched([600, 1200, 1800], [900, 1500]), [], 1000)
    expect(a.nextDeparture).toEqual([1200, 1500])
  })

  it('reports no next departure once a direction is done for the day', () => {
    const a = buildLineActivity(line(), sched([600], [900]), [], 2000)
    expect(a.nextDeparture).toEqual([null, null])
  })

  it('still finds the after-midnight tail, which is encoded past 24:00', () => {
    const a = buildLineActivity(line(), sched([23 * 3600, 24 * 3600 + 1800]), [], 23 * 3600 + 60)
    expect(a.nextDeparture[0]).toBe(24 * 3600 + 1800)
  })

  it('orders the vehicles by how far along the route they are', () => {
    // Stop 3 is ahead of stop 1 in the direction's own list, and
    // direction 0 comes before direction 1
    const a = buildLineActivity(
      line(),
      undefined,
      [
        vehicle('X', { id: 'back', nextStopName: 'Stop 1' }),
        vehicle('X', { id: 'other-way', direction: 1, nextStopName: 'Stop 1' }),
        vehicle('X', { id: 'front', nextStopName: 'Stop 3' }),
      ],
      0,
    )
    expect(a.vehicles.map((v) => v.id)).toEqual(['back', 'front', 'other-way'])
  })

  it('averages the delay over the tracked vehicles only', () => {
    // Two matched at +120/+240, two the feed knows nothing about. Counting
    // the unmatched zeros would report the line as nearly punctual.
    const a = buildLineActivity(
      line(),
      undefined,
      [
        vehicle('X', { realtime: true, delaySeconds: 120 }),
        vehicle('X', { realtime: true, delaySeconds: 240 }),
        vehicle('X'),
        vehicle('X'),
      ],
      0,
    )
    expect(a.delay).toEqual({ medianSeconds: 240, vehicles: 2 })
  })

  it('says nothing about delay when the feed covers none of the line', () => {
    const a = buildLineActivity(line(), undefined, [vehicle('X'), vehicle('X')], 0)
    expect(a.delay).toBeNull()
  })
})
