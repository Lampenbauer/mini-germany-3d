/**
 * The airfield lighting a city's box holds, from OpenStreetMap: the
 * runway edge, centre line, threshold and touchdown-zone lights, the
 * approach lighting, the PAPIs, the taxiway edge and centre-line lights,
 * the stop bars and the runway guard lights – mapped one node each as
 * aeroway=navigationaid with navigationaid=<kind>, at the big airports
 * by the thousand (Frankfurt ~10 000, Berlin ~6 000, Hamburg ~3 500,
 * counted 2026-09-13). The colour is the one ICAO Annex 14 gives the
 * kind, unless the node says otherwise (light:colour – a threshold seen
 * from the runway is red: the runway end). The apron's floodlight masts
 * come along as the kind `flood`: man_made=mast (or tower) with
 * tower:type=lighting, which the fetch script asks for inside the
 * aerodrome polygons only – a stadium's masts burn on match nights, an
 * airport's every night.
 *
 * Pure (no I/O), so scripts/fetch-airfield-lights.mjs stays a thin
 * fetch-and-write wrapper and this part is unit tested.
 */

/** The kinds the map draws, with the colour each wears by the book. */
export const AIRFIELD_LIGHT_KINDS = {
  /** Runway edge lights. */
  rwe: 'white',
  /** Runway centre-line lights. */
  rwc: 'white',
  /** Runway threshold lights – green; the same bar seen from the runway is the red end. */
  rwt: 'green',
  /** Touchdown-zone lights. */
  tdz: 'white',
  /** Approach lighting system. */
  als: 'white',
  /** Precision approach path indicator – red or white by the glide angle; white from above. */
  papi: 'white',
  /** Visual approach slope indicator, the PAPI's older sibling. */
  vasi: 'white',
  /** Taxiway edge lights. */
  txe: 'blue',
  /** Taxiway centre-line lights. */
  txc: 'green',
  /** Stop bars. */
  sbl: 'red',
  /** Clearance bars. */
  cbl: 'yellow',
  /** Runway guard lights (wig-wags). */
  rgl: 'yellow',
  /** An apron floodlight mast – drawn as a pool on the apron, not as a point. */
  flood: 'white',
}

/** The colours a light can wear, as the file names them. */
export const AIRFIELD_LIGHT_COLOURS = ['white', 'green', 'red', 'blue', 'yellow']

/** OSM's colour words as the map's – `amber` is the guard lights' yellow. */
const COLOUR_ALIASES = { amber: 'yellow', orange: 'yellow' }

/**
 * What a node is on the map: its kind and colour, or null for a node the
 * map has no light for – a radio aid (VOR, DME, NDB, ILS antennas), an
 * unknown kind, a kind without a colour of its own, a mast that is not
 * a lighting mast.
 */
export function classifyAirfieldLight(tags) {
  if (!tags) return null
  if (tags.aeroway !== 'navigationaid') {
    const mast = tags.man_made === 'mast' || tags.man_made === 'tower'
    return mast && tags['tower:type'] === 'lighting' ? { kind: 'flood', colour: 'white' } : null
  }
  const kind = typeof tags.navigationaid === 'string' ? tags.navigationaid.trim().toLowerCase() : ''
  if (!(kind in AIRFIELD_LIGHT_KINDS)) return null
  const raw = typeof tags['light:colour'] === 'string' ? tags['light:colour'].trim().toLowerCase() : ''
  const named = COLOUR_ALIASES[raw] ?? raw
  const colour = AIRFIELD_LIGHT_COLOURS.includes(named) ? named : AIRFIELD_LIGHT_KINDS[kind]
  return { kind, colour }
}

/** 5 decimals ≈ 1 m – runway lights stand 60 m apart, taxiway lights 15. */
const round5 = (v) => Math.round(v * 1e5) / 1e5

/**
 * The lights of a box out of an Overpass answer: every navigationaid
 * node and lighting mast inside it that the map has a light for, as
 * [lon, lat, kind, colour], one per position (two nodes on one spot
 * are one light), in a fixed order so the file is byte-stable across
 * runs – by kind, then longitude, then latitude. Which masts are
 * offered is the query's business (the aerodrome polygons).
 */
export function selectAirfieldLights(elements, box) {
  const byPosition = new Map()
  for (const el of elements ?? []) {
    if (el?.type !== 'node' || typeof el.lon !== 'number' || typeof el.lat !== 'number') continue
    if (el.lon < box.west || el.lon > box.east || el.lat < box.south || el.lat > box.north) continue
    const light = classifyAirfieldLight(el.tags)
    if (!light) continue
    const lon = round5(el.lon)
    const lat = round5(el.lat)
    const key = `${lon}:${lat}`
    if (!byPosition.has(key)) byPosition.set(key, [lon, lat, light.kind, light.colour])
  }
  return [...byPosition.values()].sort(
    (a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]),
  )
}

/** How many lights of each kind – for the run's log and the tests. */
export function countByKind(lights) {
  const counts = {}
  for (const light of lights) counts[light[2]] = (counts[light[2]] ?? 0) + 1
  return counts
}
