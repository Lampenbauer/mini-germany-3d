/**
 * The facts about a transit line, gathered from the data the app already
 * carries: the route geometry from network.json and the day's departures
 * from schedule.json.
 *
 * Interchanges are deliberately not among them. Per stop they are the
 * useful thing the stop card shows; per LINE they degenerate – an 18.7 km
 * tram crossing the city walks past 29 of the 36 lines, which is a badge
 * row that says "the network".
 *
 * Everything here is a fact the sources state, not a simulation result.
 * Travel time and speed are deliberately absent: the feed carries no
 * running times, the app invents them from a per-mode cruise speed and a
 * fixed dwell (see config.simulation), and a card claiming "41 min" would
 * present that assumption as timetable.
 *
 * Pure functions over prepared data – unit tested in
 * tests/line-profile.test.ts.
 */

import type { VehicleSnapshot } from '@/engine/simulation'
import type { PreparedLine, TransitMode } from '@/data/network-types'
import { getLanguage } from '@/lib/i18n'
import type { ScheduleJson } from '@/lib/timetable'

/** Morning peak the headway is additionally measured over (seconds of day). */
const PEAK_FROM = 7 * 3600
const PEAK_TO = 9 * 3600

/**
 * Below this relative difference the two directions count as the same
 * length and the card shows one number. Above it they genuinely differ –
 * line 22 runs 8.8 km out and 6.1 km back – and hiding that behind an
 * average would describe neither direction.
 */
export const DIRECTION_SPREAD = 0.1

export interface LineProfile {
  lineId: string
  mode: TransitMode
  /** Termini of direction 0 – the card's subtitle. */
  from: string
  to: string
  /** Route length per direction in meters. */
  lengthMeters: [number, number]
  /** Stops served per direction. */
  stopCount: [number, number]
  /** Mean distance between consecutive stops over both directions. */
  meanStopSpacing: number
  /** First and last departure of the day, seconds of day. */
  service: { first: number; last: number } | null
  /**
   * Median gap between departures in seconds, measured WITHIN each
   * direction and pooled. Merging both directions first would halve it:
   * line 1 came out as "every 6 min" for a line everyone calls a
   * 10-minute service, because outbound and inbound interleave. `peak`
   * is the same over the morning peak, null when the line does not run
   * then (the night lines do not).
   */
  headway: { median: number; peak: number | null } | null
  /**
   * Departures in the day, and how many of them are short workings –
   * trips that serve only part of the route (schedule.json's spans).
   * Line 1 runs 72 of its 111 trips short, which is why not every tram
   * reaches the terminus the card names.
   */
  trips: { total: number; shortWorkings: number } | null
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** Gaps between consecutive departures, given a sorted list. */
function gaps(departures: number[]): number[] {
  return departures.slice(1).map((t, i) => t - departures[i])
}

/** Each direction's departure list, sorted. */
function departuresByDirection(schedule: ScheduleJson | undefined, lineId: string): number[][] {
  const dirs = schedule?.lines?.[lineId]
  if (!dirs) return []
  return Object.values(dirs).map((d) => [...(d.departures ?? [])].sort((a, b) => a - b))
}

export function buildLineProfile(
  line: PreparedLine,
  schedule: ScheduleJson | undefined,
): LineProfile {
  const [d0, d1] = line.directions
  const lengthMeters: [number, number] = [d0.totalLength, d1.totalLength]
  const stopCount: [number, number] = [d0.stops.length, d1.stops.length]

  // Spacing over both directions together: a line whose return leg skips
  // stops should read as the mix it is.
  const spans = line.directions.reduce((sum, d) => sum + Math.max(0, d.stops.length - 1), 0)
  const meanStopSpacing = spans > 0 ? (d0.totalLength + d1.totalLength) / spans : 0

  const perDirection = departuresByDirection(schedule, line.id)
  const departures = perDirection.flat().sort((a, b) => a - b)
  const service = departures.length ? { first: departures[0], last: departures[departures.length - 1] } : null
  // Gaps within a direction, pooled – see the headway field's note.
  const allGaps = perDirection.flatMap(gaps)
  const peakGaps = perDirection.flatMap((list) =>
    gaps(list.filter((t) => t >= PEAK_FROM && t < PEAK_TO)),
  )
  const headway = allGaps.length
    ? { median: median(allGaps), peak: peakGaps.length ? median(peakGaps) : null }
    : null

  const dirData = Object.values(schedule?.lines?.[line.id] ?? {})
  const trips = departures.length
    ? {
        total: departures.length,
        shortWorkings: dirData.reduce(
          (sum, d) => sum + (d.spans ?? []).filter((span) => span !== null).length,
          0,
        ),
      }
    : null

  return {
    lineId: line.id,
    mode: line.mode,
    from: d0.from,
    to: d0.to,
    lengthMeters,
    stopCount,
    meanStopSpacing,
    service,
    headway,
    trips,
  }
}

/**
 * "18.7 km", or "8.8 / 6.1 km" where the directions genuinely differ –
 * with the reader's decimal separator, since the rest of the German UI
 * is German too.
 */
export function formatLength([a, b]: [number, number]): string {
  const format = new Intl.NumberFormat(getLanguage(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  const km = (m: number) => format.format(m / 1000)
  const longer = Math.max(a, b)
  if (longer === 0) return '0 km'
  return Math.abs(a - b) / longer > DIRECTION_SPREAD ? `${km(a)} / ${km(b)} km` : `${km(longer)} km`
}

/** "39", or "39 / 34" where the directions serve different stops. */
export function formatStopCount([a, b]: [number, number]): string {
  return a === b ? String(a) : `${a} / ${b}`
}

/** Seconds of day → "03:24", wrapping the after-midnight tail. */
export function formatServiceTime(seconds: number): string {
  const wrapped = ((seconds % 86400) + 86400) % 86400
  const h = Math.floor(wrapped / 3600)
  const m = Math.floor((wrapped % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * What the line is doing right now, as opposed to what it is. Recomputed
 * on the app's UI tick, so it stays a filter and a median over lists the
 * app already holds – no lookups, no allocation beyond the result.
 */
/** One of the line's vehicles, as the card lists it. */
export interface LineVehicle {
  /** Simulation trip id – what selecting the vehicle needs. */
  id: string
  direction: 0 | 1
  destination: string
  nextStopName: string
  status: 'dwell' | 'moving'
  inTunnel: boolean
  delaySeconds: number
  realtime: boolean
}

export interface LineActivity {
  /**
   * The line's vehicles on the map at this instant, grouped by direction
   * and ordered by how far along the route they are – the order they
   * would appear to someone following the line on the map.
   */
  vehicles: LineVehicle[]
  /**
   * Next scheduled departure per direction in seconds of day, null once
   * that direction is done for the day. Index matches the directions, so
   * [0] heads for the profile's `to` and [1] for its `from`.
   *
   * Taken from the schedule rather than by querying the terminus stop:
   * a terminus is not reliably where a trip starts. Line 1 runs 139 of
   * its 217 trips short and had no departure at all from Mecklenburger
   * Allee in the queried hour, and line 25's direction-1 stop list
   * begins at Maxim-Gorki-Straße although the direction is named for
   * Thomas-Morus-Straße.
   */
  nextDeparture: [number | null, number | null]
  /**
   * Median delay over the line's vehicles that GTFS-RT actually covers,
   * and how many that is. Null when the feed says nothing about this
   * line – which is not the same as the line being on time.
   */
  delay: { medianSeconds: number; vehicles: number } | null
}

export function buildLineActivity(
  line: PreparedLine,
  schedule: ScheduleJson | undefined,
  snapshots: readonly VehicleSnapshot[],
  nowSeconds: number,
): LineActivity {
  const lineId = line.id
  const own = snapshots.filter((s) => s.lineId === lineId)

  // Progress along the route, cheaply: the next stop's position in the
  // direction's own stop list. A vehicle heading for stop 3 is ahead of
  // one heading for stop 12, without asking the simulation for either.
  const stopOrder = line.directions.map(
    (d) => new Map(d.stops.map((stop, index) => [stop.name, index])),
  )
  const vehicles: LineVehicle[] = own
    .map((s) => ({
      id: s.id,
      direction: s.direction,
      destination: s.destination,
      nextStopName: s.nextStopName,
      status: s.status,
      inTunnel: s.inTunnel,
      delaySeconds: s.delaySeconds,
      realtime: s.realtime,
    }))
    .sort(
      (a, b) =>
        a.direction - b.direction ||
        (stopOrder[a.direction].get(a.nextStopName) ?? 0) -
          (stopOrder[b.direction].get(b.nextStopName) ?? 0),
    )
  // After-midnight service is encoded past 24:00, so a plain ">= now"
  // finds it while the day is still running; once the clock has wrapped
  // past the last departure the direction is done.
  const perDirection = departuresByDirection(schedule, lineId)
  const nextDeparture = [0, 1].map((i) => {
    const next = (perDirection[i] ?? []).find((t) => t >= nowSeconds)
    return next ?? null
  }) as [number | null, number | null]

  // Only the vehicles the feed actually covers: averaging a matched +4 min
  // together with the zeros of unmatched trips would report the line as
  // punctual because most of it is invisible to the feed.
  const realtimeDelays = own.filter((s) => s.realtime).map((s) => s.delaySeconds)
  const delay = realtimeDelays.length
    ? { medianSeconds: median(realtimeDelays), vehicles: realtimeDelays.length }
    : null

  return { vehicles, nextDeparture, delay }
}
