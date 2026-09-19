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
 * its service day, was exactly that at 08:30:00 (the nightly run of
 * 2026-09-19 failed on it). Five minutes is fine enough for any
 * headway a pinned line runs at by day.
 */
export function linesOutInTheMorning(sim: Simulation): Set<string> {
  const lines = new Set<string>()
  for (let sec = 8 * 3600; sec <= 9 * 3600; sec += 5 * 60) {
    for (const snapshot of sim.snapshotsAt(sec)) lines.add(snapshot.lineId)
  }
  return lines
}
