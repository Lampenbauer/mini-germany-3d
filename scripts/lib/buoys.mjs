/**
 * The buoys a city's box holds, from OpenStreetMap's seamark tagging
 * (OpenSeaMap's, inside OSM): the lateral marks of the fairways –
 * red to port, green to starboard coming in from sea (IALA region A,
 * which every German water is in) – and the yellow special-purpose
 * marks around them, each a node with seamark:type=buoy_* and its
 * colour, shape and light under seamark:<type>:colour, :shape and
 * seamark:light:*.
 *
 * For now only the buoys of one colour – red, green or yellow all over
 * (a first cut). The banded marks stay out: the
 * cardinal buoys (yellow and black), the isolated-danger and safe-water
 * marks (black and red, red and white), the preferred-channel laterals
 * (green;red;green), the yellow;red;yellow special marks and the white
 * bathing-area spheres – each is its own picture and none is a plain
 * red, green or yellow buoy. Beacons (seamark:type=beacon_*) are fixed
 * structures, not buoys, and stay out as well.
 *
 * Every buoy keeps its light where it has one – colour, character and
 * period – so the lit ones can be lit at night. No height: a buoy floats
 * on the tiles' water, which the map clamps it to at runtime (see
 * src/map/BuoysLayer.ts), so the file carries nothing that could go
 * stale with the terrain.
 *
 * Pure (no I/O), so scripts/fetch-buoys.mjs stays a thin fetch-and-write
 * wrapper and this part is unit tested (tests/buoys.test.ts).
 */

/** The colours the map has a buoy for, as OSM spells them. */
export const BUOY_COLOURS = ['red', 'green', 'yellow']

/**
 * The shapes the map has a model for, as OSM spells them
 * (seamark:<type>:shape). A shape OSM does not name, or one the map has
 * no model for (super-buoy, ice-buoy), is drawn as the pillar buoy where
 * the buoy is lit – a light sits on a tower – and as the spar buoy
 * otherwise, the commonest unlit mark in German waters.
 */
export const BUOY_SHAPES = ['can', 'conical', 'spar', 'pillar', 'spherical', 'barrel']

/** The light colours a buoy's lantern can show, as the file names them. */
export const BUOY_LIGHT_COLOURS = ['red', 'green', 'yellow', 'white']

/** OSM's colour words as the map's. */
const COLOUR_ALIASES = { amber: 'yellow', orange: 'yellow' }

/** The seamark types that are buoys. */
const BUOY_TYPE = /^buoy_[a-z_]+$/

const clean = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/**
 * What a node is on the map: colour, shape and light, or null for a node
 * the map has no buoy for – not a buoy, a banded or a white one, a
 * colour or a tag the map does not read.
 */
export function classifyBuoy(tags) {
  if (!tags) return null
  const type = clean(tags['seamark:type'])
  if (!BUOY_TYPE.test(type)) return null
  const colour = COLOUR_ALIASES[clean(tags[`seamark:${type}:colour`])] ?? clean(tags[`seamark:${type}:colour`])
  if (!BUOY_COLOURS.includes(colour)) return null
  const light = classifyLight(tags, colour)
  const named = clean(tags[`seamark:${type}:shape`])
  const shape = BUOY_SHAPES.includes(named) ? named : light ? 'pillar' : 'spar'
  return { colour, shape, light }
}

/**
 * The buoy's light, or null where it has none: the colour it shows
 * (seamark:light:colour, or the first of a sectored light's; a lantern
 * without a colour shows the buoy's own), its character (Fl, Q, Oc, Iso,
 * LFl, VQ … – kept as OSM has it, for a flashing rule to read one day)
 * and its period in seconds where given.
 */
export function classifyLight(tags, buoyColour) {
  const raw = clean(tags['seamark:light:colour'] ?? tags['seamark:light:1:colour'])
  const characterTag = tags['seamark:light:character'] ?? tags['seamark:light:1:character']
  const character = typeof characterTag === 'string' ? characterTag.trim() : ''
  if (!raw && !character) return null
  const first = COLOUR_ALIASES[raw.split(';')[0]] ?? raw.split(';')[0]
  const colour = BUOY_LIGHT_COLOURS.includes(first) ? first : buoyColour
  const periodText = clean(tags['seamark:light:period'] ?? tags['seamark:light:1:period'])
  const period = Number(periodText)
  return {
    colour,
    character: character || null,
    period: periodText !== '' && Number.isFinite(period) && period > 0 ? period : null,
  }
}

/** 6 decimals ≈ 10 cm – buoys in a fairway stand a hundred metres apart, two on one spot are one. */
const round6 = (v) => Math.round(v * 1e6) / 1e6

/**
 * The buoys of a box out of an Overpass answer: every buoy node inside
 * it that the map has a model for, as
 * [lon, lat, colour, shape, lightColour, lightCharacter, lightPeriod]
 * (the three light fields null for an unlit buoy), one per position, in
 * a fixed order so the file is byte-stable across runs – by colour,
 * then longitude, then latitude.
 */
export function selectBuoys(elements, box) {
  const byPosition = new Map()
  for (const el of elements ?? []) {
    if (el?.type !== 'node' || typeof el.lon !== 'number' || typeof el.lat !== 'number') continue
    if (el.lon < box.west || el.lon > box.east || el.lat < box.south || el.lat > box.north) continue
    const buoy = classifyBuoy(el.tags)
    if (!buoy) continue
    const lon = round6(el.lon)
    const lat = round6(el.lat)
    const key = `${lon}:${lat}`
    if (byPosition.has(key)) continue
    byPosition.set(key, [
      lon,
      lat,
      buoy.colour,
      buoy.shape,
      buoy.light?.colour ?? null,
      buoy.light?.character ?? null,
      buoy.light?.period ?? null,
    ])
  }
  return [...byPosition.values()].sort(
    (a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]),
  )
}

/** How many buoys of each colour, and how many of them lit – for the run's log and the tests. */
export function countBuoys(buoys) {
  const counts = {}
  let lit = 0
  for (const buoy of buoys) {
    counts[buoy[2]] = (counts[buoy[2]] ?? 0) + 1
    if (buoy[4] !== null) lit++
  }
  return { byColour: counts, lit }
}
