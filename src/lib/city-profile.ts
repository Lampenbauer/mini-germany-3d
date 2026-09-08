/**
 * The facts about a city's network, gathered the way line-profile.ts
 * gathers them for one line: from the route geometry in network.json and
 * the day's departures in schedule.json, nothing from the simulation.
 * Speeds, travel times and vehicle-kilometres are absent for the same
 * reason they are absent from the line card – the app invents them.
 *
 * Two measures need naming carefully. The stops are stop POSITIONS, one
 * per OSM platform node, not stations: Doberaner Platz is eight of them
 * (see interchange.ts). And the kilometres are LINE kilometres – every
 * line's own length, a shared corridor counted once per line that uses
 * it – not the length of the track network.
 *
 * Pure functions over prepared data – unit tested in
 * tests/city-profile.test.ts.
 */

import type { VehicleSnapshot } from '@/engine/simulation'
import type { PreparedLine, PreparedNetwork, TransitMode } from '@/data/network-types'
import { getLanguage } from '@/lib/i18n'
import type { ScheduleJson } from '@/lib/timetable'
import { TRANSIT_MODES } from '@/lib/transit-mode'

/**
 * A service day whose longest pause is this short or shorter is round the
 * clock. The pause, not the earliest and latest departure: a feed codes a
 * night bus's 00:30 as 24:30 of the day before and another line's 00:03
 * as 00:03 of the day itself, so the smallest and largest departure of a
 * day span 28 hours in Rostock and read as a quarter of an hour in Berlin
 * ("03:00–03:15"). What the day actually has is a gap somewhere – or
 * none, and then it is a day without a night.
 */
export const ROUND_THE_CLOCK_GAP_SECONDS = 3600

export interface CityModeCount {
  mode: TransitMode
  /** Lines of this mode in the network. */
  lines: number
  /**
   * Lines of this mode with at least one departure in the timetable –
   * Munich's U8 is Saturday-only and counts against its mode on a
   * weekday. Null without a timetable, when the app runs every line on
   * a synthetic headway and the question has no honest answer.
   */
  running: number | null
}

export interface CityProfile {
  /** Lines and how many of them run, per mode in display order. */
  modes: CityModeCount[]
  lines: { total: number; running: number | null }
  /** Distinct stop positions any direction of any line serves. */
  stopPositions: number
  /**
   * Line kilometres in metres: each line's length, the two directions
   * averaged, summed over the lines.
   */
  lineMeters: number
  /** Of the line metres, the ones in tunnel – the same measure. */
  tunnelMeters: number
  /** The longest line by the same per-line length. */
  longest: { lineId: string; mode: TransitMode; meters: number } | null
  /**
   * Lowest and highest stop position in metres NHN, with the highest
   * one's name – Stuttgart climbs 300 m between the two. Null where the
   * stops carry no heights.
   */
  elevation: { min: number; max: number; highestStop: string } | null
  /** Departures in the timetable's day, and how many serve part of a route. */
  trips: { total: number; shortWorkings: number } | null
  /**
   * Where the day's service starts and ends, seconds of day in [0, 86400):
   * the two ends of the longest pause between departures over every line,
   * so `first` can be later in the clock than `last` (Rostock's night
   * ends at 04:06 and its day begins at 03:50 – see isRoundTheClock).
   */
  service: { first: number; last: number } | null
}

/** A line's length as the profile counts it: the two directions averaged. */
function lineLength(line: PreparedLine): number {
  return (line.directions[0].totalLength + line.directions[1].totalLength) / 2
}

function tunnelLength(line: PreparedLine): number {
  return (
    line.directions.reduce(
      (sum, d) => sum + d.tunnels.reduce((acc, [start, end]) => acc + (end - start), 0),
      0,
    ) / 2
  )
}

/** Every departure of a line in the schedule, over both directions. */
function lineDepartures(schedule: ScheduleJson | undefined, lineId: string): number[] {
  const dirs = schedule?.lines?.[lineId]
  if (!dirs) return []
  return Object.values(dirs).flatMap((d) => d.departures ?? [])
}

function shortWorkings(schedule: ScheduleJson | undefined, lineId: string): number {
  const dirs = schedule?.lines?.[lineId]
  if (!dirs) return 0
  return Object.values(dirs).reduce(
    (sum, d) => sum + (d.spans ?? []).filter((span) => span !== null).length,
    0,
  )
}

export function buildCityProfile(
  network: PreparedNetwork,
  schedule: ScheduleJson | undefined,
): CityProfile {
  const hasSchedule = Boolean(schedule?.lines)
  const running = (line: PreparedLine) => lineDepartures(schedule, line.id).length > 0

  const modes: CityModeCount[] = TRANSIT_MODES.map((mode) => {
    const own = network.lines.filter((line) => line.mode === mode)
    return {
      mode,
      lines: own.length,
      running: hasSchedule ? own.filter(running).length : null,
    }
  }).filter((entry) => entry.lines > 0)

  const stopIds = new Set<string>()
  let lineMeters = 0
  let tunnelMeters = 0
  let longest: CityProfile['longest'] = null
  let elevation: CityProfile['elevation'] = null
  const departures: number[] = []
  let trips = 0
  let short = 0

  for (const line of network.lines) {
    const length = lineLength(line)
    lineMeters += length
    tunnelMeters += tunnelLength(line)
    if (!longest || length > longest.meters)
      longest = { lineId: line.id, mode: line.mode, meters: length }
    for (const direction of line.directions) {
      for (const stop of direction.stops) {
        stopIds.add(stop.id)
        if (stop.nhn === undefined) continue
        if (!elevation) elevation = { min: stop.nhn, max: stop.nhn, highestStop: stop.name }
        else {
          if (stop.nhn < elevation.min) elevation.min = stop.nhn
          if (stop.nhn > elevation.max) {
            elevation.max = stop.nhn
            elevation.highestStop = stop.name
          }
        }
      }
    }
    const own = lineDepartures(schedule, line.id)
    trips += own.length
    short += shortWorkings(schedule, line.id)
    for (const t of own) departures.push(((t % 86400) + 86400) % 86400)
  }

  return {
    modes,
    lines: {
      total: network.lines.length,
      running: hasSchedule ? network.lines.filter(running).length : null,
    },
    stopPositions: stopIds.size,
    lineMeters,
    tunnelMeters,
    longest,
    elevation,
    trips: trips > 0 ? { total: trips, shortWorkings: short } : null,
    service: trips > 0 ? serviceSpan(departures) : null,
  }
}

/**
 * The two ends of the longest pause in a day of departures (seconds of
 * day, wrapped): the service runs from the pause's end to its start.
 */
function serviceSpan(departures: number[]): { first: number; last: number } {
  const sorted = [...new Set(departures)].sort((a, b) => a - b)
  // The pause over midnight, from the day's last departure round to its first
  let last = sorted[sorted.length - 1]
  let first = sorted[0]
  let longest = first + 86400 - last
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1]
    if (gap > longest) {
      longest = gap
      last = sorted[i - 1]
      first = sorted[i]
    }
  }
  return { first, last }
}

/**
 * What the whole fleet is doing right now – the counts the control panel
 * carries beside its group headers, recomputed on the app's UI tick from
 * the snapshot list the app already holds.
 */
export interface CityActivity {
  /** Vehicles on the map at this instant. */
  total: number
  /** The same per mode; a mode with nothing out is absent. */
  byMode: Partial<Record<TransitMode, number>>
  /**
   * Median delay over the vehicles GTFS-RT actually covers, and how many
   * that is – null when the feed covers none, which is the case away
   * from real time and offline.
   */
  delay: { medianSeconds: number; vehicles: number } | null
}

export function buildCityActivity(snapshots: readonly VehicleSnapshot[]): CityActivity {
  const byMode: Partial<Record<TransitMode, number>> = {}
  const delays: number[] = []
  for (const s of snapshots) {
    byMode[s.mode] = (byMode[s.mode] ?? 0) + 1
    if (s.realtime) delays.push(s.delaySeconds)
  }
  let delay: CityActivity['delay'] = null
  if (delays.length) {
    delays.sort((a, b) => a - b)
    delay = {
      medianSeconds: delays[Math.floor(delays.length / 2)],
      vehicles: delays.length,
    }
  }
  return { total: snapshots.length, byMode, delay }
}

/**
 * Whether two readings say the same – so the app can keep the old state
 * object and spare the panel a re-render on the ticks where no vehicle
 * came or went, which at real-time speed is most of them.
 */
export function sameActivity(a: CityActivity | null, b: CityActivity | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.total !== b.total) return false
  if ((a.delay === null) !== (b.delay === null)) return false
  if (
    a.delay &&
    b.delay &&
    (a.delay.medianSeconds !== b.delay.medianSeconds || a.delay.vehicles !== b.delay.vehicles)
  )
    return false
  const modes = new Set([...Object.keys(a.byMode), ...Object.keys(b.byMode)]) as Set<TransitMode>
  for (const mode of modes) if ((a.byMode[mode] ?? 0) !== (b.byMode[mode] ?? 0)) return false
  return true
}

/**
 * "1.164 km" / "1,164 km" – whole kilometres in the reader's digits, one
 * decimal below ten where a whole number would be too coarse. A line's
 * own length asks for the decimal at any size (`decimals` = 1), the way
 * the line card writes it.
 */
export function formatKilometres(meters: number, decimals?: number): string {
  const km = meters / 1000
  const digits = decimals ?? (km < 10 ? 1 : 0)
  const format = new Intl.NumberFormat(getLanguage(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${format.format(km)} km`
}

/** "20.459" / "20,459" – a count with the reader's grouping. */
export function formatCount(count: number): string {
  return new Intl.NumberFormat(getLanguage()).format(count)
}

/** The tunnel share as a whole percentage; 0 below half a percent. */
export function tunnelPercent(profile: Pick<CityProfile, 'lineMeters' | 'tunnelMeters'>): number {
  return profile.lineMeters > 0 ? Math.round((profile.tunnelMeters / profile.lineMeters) * 100) : 0
}

/** Whether the service day has no night – see ROUND_THE_CLOCK_GAP_SECONDS. */
export function isRoundTheClock(service: { first: number; last: number }): boolean {
  const pause = (((service.first - service.last) % 86400) + 86400) % 86400
  return pause <= ROUND_THE_CLOCK_GAP_SECONDS
}
