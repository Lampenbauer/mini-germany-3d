import { describe, expect, it } from 'vitest'
import { config } from '@/config'
import { tooFewLinesRunning } from '../scripts/fetch-gtfs-schedule.mjs'
import { committedDataFiles, loadRostockNetwork, rostockSchedule } from './cities'
import {
  buildAllTrips,
  normalizeSpan,
  simTripId,
  tripStateAt,
  type ScheduleJson,
  type TimetableOptions,
} from '@/lib/timetable'

/**
 * Integration checks on the BUNDLED network + schedule (the data the app
 * actually ships). Regression guards for two observed mismatches with
 * reality: two ferries on the Kabutzenhof–Gehlsdorf crossing where the
 * real service is one vessel going back and forth, and line-5 short
 * workings simulated as full-route trips (three trams bunched within a few
 * hundred meters in the city center).
 */

const network = loadRostockNetwork()
const schedule: ScheduleJson = rostockSchedule
const opts: TimetableOptions = {
  cruiseSpeedMps: config.simulation.cruiseSpeedMps,
  dwellSeconds: config.simulation.dwellSeconds,
  cruiseSpeedByMode: config.simulation.cruiseSpeedByMode,
}
const trips = buildAllTrips(network, opts, schedule)

describe('bundled schedule data', () => {
  it('puts at most one vessel on the Gehlsdorf ferry crossing at any time', () => {
    const ferryTrips = trips.filter((t) => t.lineId === 'FG')
    const ferry = network.lineById.get('FG')!
    expect(ferryTrips.length).toBeGreaterThan(0)
    let maxActive = 0
    for (let t = 4 * 3600; t <= 24 * 3600; t += 30) {
      let active = 0
      for (const trip of ferryTrips) {
        if (tripStateAt(trip, ferry.directions[trip.direction], t)) active++
      }
      maxActive = Math.max(maxActive, active)
    }
    // The real service is a single vessel shuttling between the two piers.
    expect(maxActive).toBe(1)
  })

  it('keeps every short working within its section of the route', () => {
    let partialTrips = 0
    for (const [lineId, dirs] of Object.entries(schedule.lines ?? {})) {
      const line = network.lineById.get(lineId)
      if (!line) continue
      for (const [dirKey, data] of Object.entries(dirs)) {
        if (!data.spans) continue
        const direction = dirKey === '1' ? 1 : 0
        const dir = line.directions[direction]
        data.departures.forEach((dep, i) => {
          const span = normalizeSpan(data.spans![i])
          if (!span) return
          const trip = trips.find((t) => t.id === simTripId(lineId, direction, dep, span))
          if (!trip) return
          partialTrips++
          const dists = trip.stopTimes.map((st) => dir.stops[st.stopIndex].dist)
          // Served stops stay inside the span (plus the projection slack
          // the runtime allows) – a vehicle must never run on sections its
          // trip does not serve.
          expect(Math.min(...dists)).toBeGreaterThanOrEqual(span[0] - 150)
          expect(Math.max(...dists)).toBeLessThanOrEqual(span[1] + 150)
          // Real origin/destination names are shown on the tram card
          expect(trip.origin).toBe(dir.stops[trip.stopTimes[0].stopIndex].name)
          expect(trip.destination).toBe(
            dir.stops[trip.stopTimes[trip.stopTimes.length - 1].stopIndex].name,
          )
        })
      }
    }
    // The current feed models the construction-split line 5 entirely as
    // short workings – if this ever drops to 0 the span pipeline is broken.
    expect(partialTrips).toBeGreaterThan(100)
  })

  it('never runs more vehicles on line 5 than its schedule has concurrent trips', () => {
    const line5 = network.lineById.get('5')!
    const line5Trips = trips.filter((t) => t.lineId === '5')
    // At 15:00 the old full-route interpretation put ~24 vehicles on the
    // line (515 trips × ~28 min full-route runtime). With spans the trips
    // only cover their real sections.
    let peak = 0
    for (let t = 14 * 3600; t <= 16 * 3600; t += 60) {
      let active = 0
      for (const trip of line5Trips) {
        if (tripStateAt(trip, line5.directions[trip.direction], t)) active++
      }
      peak = Math.max(peak, active)
    }
    // Both construction sections together are ~14.6 km served at an
    // effective ~10-min headway per section and direction → ~12 vehicles.
    // Guard with head-room against re-inflation (the bug showed ~2×).
    expect(peak).toBeGreaterThan(4)
    expect(peak).toBeLessThan(18)
  })
})

/**
 * The nightly CI regenerates these files and commits them only when they
 * actually differ (see .github/workflows/ci.yml). A field carrying the
 * generation date defeats that guard: the file would differ on every run,
 * so an unchanged timetable would still produce a commit, a push to main
 * and a deploy. Provenance is not lost by leaving it out – the commit
 * date records when the data was fetched, and more reliably. The
 * schedule's chosen service day was such a field in GTFS's own dashless
 * shape (meta.serviceDate, "20260910"), and slipped past the first
 * version of this test for four weeks of nightly pipelines.
 */
describe('the committed data files', () => {
  it('carry no generation timestamp or service date in their meta', () => {
    expect(Object.keys(committedDataFiles).length).toBeGreaterThan(0)
    for (const [name, data] of Object.entries(committedDataFiles)) {
      const meta = (data as { meta?: Record<string, unknown> }).meta ?? {}
      expect(Object.keys(meta), name).not.toContain('generated')
      expect(Object.keys(meta), name).not.toContain('serviceDate')
      for (const [key, value] of Object.entries(meta)) {
        expect(String(value), `${name} meta.${key}`).not.toMatch(/^\d{4}-?\d{2}-?\d{2}$/)
      }
    }
  })

  it('are not replaced by a schedule that lost most of the city', () => {
    // Hanover from gtfs.de's export of 10 October 2026: its S-Bahn alone
    expect(tooFewLinesRunning(49, 9)).toBe(true)
    // An ordinary day's gaps: Cologne's weekend night rings, Kiel's beach lines
    expect(tooFewLinesRunning(80, 75)).toBe(false)
    expect(tooFewLinesRunning(42, 39)).toBe(false)
    // Half is enough
    expect(tooFewLinesRunning(14, 7)).toBe(false)
    expect(tooFewLinesRunning(14, 6)).toBe(true)
  })
})
