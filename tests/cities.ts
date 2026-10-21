/**
 * The bundled Rostock data for the tests, loaded synchronously: the app
 * fetches a city's data lazily (src/cities/index.ts), the tests want it
 * in hand before the first `it`.
 */

import { CITIES, cityBySlug } from '@/cities/definitions'
import { prepareNetwork } from '@/data/network'
import type { Simulation } from '@/engine/simulation'
import type { NetworkJson, PreparedNetwork } from '@/data/network-types'
import type { StreetLampData } from '@/data/street-lamps'
import type { City } from '@/lib/city'
import type { ScheduleJson } from '@/lib/timetable'
import rostockNetworkJson from '@/cities/rostock/network.json'
import rostockScheduleJson from '@/cities/rostock/schedule.json'
import rostockLampsJson from '@/cities/rostock/street-lamps.json'

export const rostock: City = cityBySlug('rostock')!

/** THE Rostock rectangle: the city limits plus 20 km on every side. */
export const rostockBoundingBox = rostock.boundingBox

export const rostockNetwork = rostockNetworkJson as unknown as NetworkJson
export const rostockSchedule = rostockScheduleJson as ScheduleJson
export const rostockLamps = rostockLampsJson as StreetLampData

/** The prepared Rostock network, as the app runs it. */
export function loadRostockNetwork(): PreparedNetwork {
  return prepareNetwork(rostockNetwork, rostock)
}

/** Every committed data file, by path – the nightly refresh rewrites these. */
export const committedDataFiles = import.meta.glob<unknown>(
  '../src/cities/*/{network,schedule,street-lamps,airfield-lights,buoys,lighthouses}.json',
  { eager: true, import: 'default' },
)

const networkFiles = import.meta.glob<NetworkJson>('../src/cities/*/network.json', {
  eager: true,
  import: 'default',
})

/** Every city with a network, prepared as the app runs it. */
export const cityNetworks: { city: City; json: NetworkJson; network: PreparedNetwork }[] =
  CITIES.flatMap((city) => {
    const json = networkFiles[`../src/cities/${city.slug}/network.json`]
    return json ? [{ city, json, network: prepareNetwork(json, city) }] : []
  })

/**
 * The lines with a vehicle on the map in the morning peak – the hour
 * from 08:00, sampled every five minutes. What a city test pins with it
 * is that a line runs that day, not that one of its vehicles is on the
 * road at one particular second: a short working on a 15-minute headway
 * is between trips for four minutes of every fifteen, and Berlin's 100,
 * cut to a 3 km shuttle for the Marathon weekend the feed had chosen as
 * its service day, was exactly that at 08:30:00 (a nightly run failed
 * on it). Five minutes is fine enough for any
 * headway a pinned line runs at by day.
 */
export function linesOutInTheMorning(sim: Simulation): Set<string> {
  const lines = new Set<string>()
  for (let sec = 8 * 3600; sec <= 9 * 3600; sec += 5 * 60) {
    for (const snapshot of sim.snapshotsAt(sec)) lines.add(snapshot.lineId)
  }
  return lines
}

/*
 * A line that stands still on the schedule's day is the feed's business
 * when the feed says so: the GTFS step writes why every line without a
 * departure has none (`meta.idle`, see idleReasons in
 * scripts/fetch-gtfs-schedule.mjs), and a line the feed runs on other days
 * but not on that one (`not-that-day` – works, school holidays, a weekend
 * or night line, a season over) neither counts against a city nor breaks
 * a pin. Before, a city test could not tell that from a line the pipeline
 * lost, and every red night ended in a hand-kept list of lines to let be:
 * Cologne's weekend night rings, Berlin's part-week ferries, Kiel's beach
 * lines – until the nights of 20 and 21 October 2026 failed on Hanover's
 * line 10, closed in the autumn holidays, and held back every city's data
 * with it.
 */

/**
 * The share of a city's lines that may stand still without the feed's
 * calendar saying why. Chosen on the feed of 20 October 2026, the first
 * the reasons were written from: Hanover (49 lines) and Kiel (42) had three
 * lines each that the feed does not carry – Hanover's 16, 267 and S8,
 * Kiel's 72 and its two beach lines after the season – which 5 % would
 * have allowed and not one more; 8 % leaves every city a line to spare.
 */
export const UNEXPLAINED_IDLE_SHARE = 0.08

/**
 * How many lines of a network may stand still for a reason other than the
 * feed's calendar – one rule for every city, two lines at least: the
 * lines the feed does not carry and the odd line whose trips cannot be
 * placed (Hamburg's S7 in the autumn holidays of 2026, 90 trips on a
 * route the network does not follow).
 */
export function unexplainedIdleAllowed(network: PreparedNetwork): number {
  return Math.max(2, Math.ceil(network.lines.length * UNEXPLAINED_IDLE_SHARE))
}

/**
 * The lines without a departure on the schedule's day that the feed's
 * calendar does not explain: `not-in-feed` (a feed that lost an operator
 * and a route_type the script no longer finds look alike), `unplaced`, and
 * a line the file gives no reason for.
 */
export function idleUnexplained(network: PreparedNetwork, schedule: ScheduleJson): string[] {
  const idle = schedule.meta?.idle ?? {}
  return network.lines
    .map((line) => line.id)
    .filter((id) => !schedule.lines?.[id] && idle[id] !== 'not-that-day')
}

/**
 * The pinned lines missing from `present` – the lines with departures, out
 * in the morning, out at night – that the feed's calendar does not excuse.
 * A pin holds the lines a city cannot be without; one that vanished from
 * the feed or could not be placed is not excused.
 */
export function pinnedLinesMissing(
  ids: string[],
  present: Iterable<string>,
  schedule: ScheduleJson,
): string[] {
  const have = new Set(present)
  return ids.filter((id) => !have.has(id) && schedule.meta?.idle?.[id] !== 'not-that-day')
}
