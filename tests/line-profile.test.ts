import { afterEach, describe, expect, it } from 'vitest'
import { loadBundledNetwork } from '@/data/network'
import schedule from '@/data/schedule.json'
import type { PreparedLine } from '@/data/network-types'
import {
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

  it('calls a flat route flat instead of reporting 0–0 m', () => {
    const flat = line()
    flat.directions[0].heights = [0.2, 0.1, 0.3]
    expect(buildLineProfile(flat, undefined).heightRange).toBeNull()

    const hilly = line()
    hilly.directions[0].heights = [2, 31, 12]
    expect(buildLineProfile(hilly, undefined).heightRange).toEqual({ min: 2, max: 31 })
  })

  it('measures the underground share over the whole line', () => {
    const withTunnel = line()
    withTunnel.directions[0].tunnels = [[0, 500]]
    // 500 m of 2000 m across both directions
    expect(buildLineProfile(withTunnel, undefined).tunnelShare).toBeCloseTo(0.25, 6)
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
  const network = loadBundledNetwork()

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
