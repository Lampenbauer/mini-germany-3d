/**
 * Which lines a passenger can change to at a stop – including the ones
 * calling a short walk away.
 *
 * A transit "stop" is several stops in the data: OSM has one node per
 * platform, and at an interchange those carry different lines and often
 * different names (Doberaner Platz is eight nodes up to 91 m apart;
 * Rostock Hbf mixes "Hauptbahnhof (U)", "Rostock Hauptbahnhof" and
 * "Hauptbahnhof Nord"). Matching on the stop id alone therefore misses
 * exactly the connections that matter, and matching on the name misses
 * them too. What holds is walking distance.
 */

import type { PreparedNetwork } from '@/data/network-types'

/** A line a passenger can change to. */
export interface InterchangeOption {
  /** Line id and color – what the badge shows. */
  id: string
  color: string
}

/** Local metric scale [x, y] in meters per degree at a latitude. */
function metersPerDegree(lat: number): [number, number] {
  return [111_320 * Math.cos((lat * Math.PI) / 180), 111_132]
}

interface StopEntry {
  id: string
  lon: number
  lat: number
  lines: { id: string; color: string }[]
}

/** Every stop of the network with the lines calling at it. */
function stopsWithLines(network: PreparedNetwork): StopEntry[] {
  const byId = new Map<string, StopEntry>()
  for (const line of network.lines) {
    for (const dir of line.directions) {
      for (const stop of dir.stops) {
        let entry = byId.get(stop.id)
        if (!entry) {
          entry = { id: stop.id, lon: stop.coord[0], lat: stop.coord[1], lines: [] }
          byId.set(stop.id, entry)
        }
        if (!entry.lines.some((l) => l.id === line.id)) {
          entry.lines.push({ id: line.id, color: line.color })
        }
      }
    }
  }
  return [...byId.values()]
}

/**
 * Stop id → the lines reachable from it, nearest platform first, one entry
 * per line. The walking distance itself does not leave this function: it
 * only decides that order and, for a line calling at several platforms
 * nearby, which of them counts.
 *
 * `radiusMeters` is the walk a connection may be away. Kept deliberately
 * short: a wider radius starts claiming interchanges that no passenger
 * would recognize as one.
 */
export function buildInterchangeIndex(
  network: PreparedNetwork,
  radiusMeters: number,
): Map<string, InterchangeOption[]> {
  const stops = stopsWithLines(network)
  const radiusSq = radiusMeters * radiusMeters
  // Degrees of latitude the radius spans – a cheap pre-filter before the
  // metric distance (stops are sorted by nothing, so this is per pair).
  const latSpan = radiusMeters / 111_132

  const index = new Map<string, InterchangeOption[]>()
  for (const stop of stops) {
    const [mx, my] = metersPerDegree(stop.lat)
    /** Line id → its color and the shortest walk found to it so far. */
    const best = new Map<string, { color: string; distance: number }>()
    for (const other of stops) {
      if (Math.abs(other.lat - stop.lat) > latSpan) continue
      const dx = (other.lon - stop.lon) * mx
      const dy = (other.lat - stop.lat) * my
      const distSq = dx * dx + dy * dy
      if (distSq > radiusSq) continue
      const distance = other.id === stop.id ? 0 : Math.sqrt(distSq)
      for (const line of other.lines) {
        const current = best.get(line.id)
        if (current && current.distance <= distance) continue
        best.set(line.id, { color: line.color, distance })
      }
    }
    index.set(
      stop.id,
      [...best.entries()]
        .sort(([idA, a], [idB, b]) => a.distance - b.distance || idA.localeCompare(idB, 'en'))
        .map(([id, { color }]) => ({ id, color })),
    )
  }
  return index
}
