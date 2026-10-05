/**
 * The lighthouses and the lesser fixed lights a city's box holds, from
 * OpenStreetMap's seamark tagging – the harbour's light towers, the
 * mole and pier heads, the leading and sector lights on the shore.
 * They need no model of their own: Google's tiles carry the towers, and
 * the map sets each light down on the top of its tower (see
 * src/map/LighthousesLayer.ts). What the file carries is where a light
 * is and what it shows.
 *
 * The tagging is less tidy than the buoys' (surveyed in Rostock and
 * Kiel): the Warnemünde lighthouse is a building way with
 * seamark:type=landmark, the mole lights are man_made=lighthouse with
 * seamark:type=beacon_lateral, the Petersdorf leading light front is
 * man_made=beacon with light_minor, and many a light_minor node carries
 * no light tags at all. So a candidate is anything tagged
 * man_made=lighthouse or seamark:type=light_major/light_minor, and it
 * becomes a light only where OSM names at least one lit sector – a node
 * without a colour stays dark rather than guessed white. A lighthouse
 * mapped twice, as a node with the light and a building way without
 * it, is one light: the lit one, and of two lit ones within 30 m the
 * first.
 *
 * Most of them are sector lights: up to a dozen sectors, each with a
 * colour and a start and end bearing "from seaward" – the bearing from
 * the vessel to the light, clockwise from true north, as the charts
 * give it – so what a camera sees depends on where it stands (see
 * src/lib/seamark-lights.ts). A directional light with an orientation
 * and no sector is read as a narrow sector about that bearing; a
 * sector exhibited only in fog is left out, and so is a floodlight or
 * spotlight – a work light on the pier, not a mark. The light's elevation over
 * the water (seamark:light:height, metres) and its range (nautical
 * miles) come along where given – units in the value ("4 m", "2 M")
 * included. The character (Fl, Oc, Iso …) is kept as OSM has it, and
 * with it the period of the light in seconds (seamark:light:period) and
 * its group ("2", "2+1" – how many flashes the period holds): a tower
 * whose every sector flashes with one period is a rotating optic, one
 * lens per flash, and the map turns its beams (see
 * src/lib/lighthouse-beam.ts) – without a period nothing turns.
 *
 * Pure (no I/O), so scripts/fetch-lighthouses.mjs stays a thin
 * fetch-and-write wrapper and this part is unit tested
 * (tests/lighthouses.test.ts).
 */

/** The colours a light can show, as the file names them. */
export const LIGHT_COLOURS = ['white', 'red', 'green', 'yellow']

/** OSM's colour words as the map's. */
const COLOUR_ALIASES = { amber: 'yellow', orange: 'yellow' }

/** Half the width of the sector a directional light is read as, in degrees. */
const DIRECTIONAL_HALF_WIDTH_DEG = 2

/**
 * Light categories that are no navigation light: the floodlight on a
 * mole head that lights the pier, a spotlight, a strip of lights. The
 * Warnemünde mole lights carry the floodlight as their unnumbered
 * seamark:light set, ahead of the green and the red – taken along it
 * would be the colour the mole shows.
 */
const WORK_LIGHT_CATEGORIES = ['floodlight', 'spotlight', 'strip_light']

/** Two lit objects closer than this are one light mapped twice. */
const SAME_LIGHT_M = 30

/** A range in nautical miles from which a light counts as a major one – the harbour's tower, not a pier head. */
const MAJOR_RANGE_NM = 10

const clean = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '')

/** A number out of an OSM value that may carry a unit ("4 m", "2 M", "062.6"); null otherwise. */
export function leadingNumber(value) {
  if (typeof value !== 'string') return null
  const m = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(value)
  if (!m) return null
  const n = Number(m[1].replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

/** A bearing folded into 0 … 360, to a thousandth of a degree – folding leaves float noise behind. */
const bearing = (deg) => Math.round((((deg % 360) + 360) % 360) * 1000) / 1000

/**
 * The lit sectors of a light out of its tags: the unnumbered
 * seamark:light:* set and the numbered seamark:light:N:* sets, each a
 * colour with its arc (null bounds for an all-round light), character,
 * period, group, height and range. Sectors without a colour the map
 * has, and sectors exhibited only in fog, are left out.
 */
export function lightSectors(tags) {
  const sectors = []
  const prefixes = ['seamark:light:']
  for (let n = 1; n <= 20; n++) prefixes.push(`seamark:light:${n}:`)
  for (const prefix of prefixes) {
    const raw = clean(tags[`${prefix}colour`])
    if (!raw) continue
    const first = raw.split(';')[0].trim()
    const colour = COLOUR_ALIASES[first] ?? first
    if (!LIGHT_COLOURS.includes(colour)) continue
    if (clean(tags[`${prefix}exhibition`]) === 'fog') continue
    if (WORK_LIGHT_CATEGORIES.includes(clean(tags[`${prefix}category`]))) continue
    let start = leadingNumber(tags[`${prefix}sector_start`])
    let end = leadingNumber(tags[`${prefix}sector_end`])
    const orientation = leadingNumber(tags[`${prefix}orientation`])
    if ((start === null || end === null) && orientation !== null) {
      start = orientation - DIRECTIONAL_HALF_WIDTH_DEG
      end = orientation + DIRECTIONAL_HALF_WIDTH_DEG
    }
    const characterTag = tags[`${prefix}character`]
    const groupTag = tags[`${prefix}group`]
    const periodS = leadingNumber(tags[`${prefix}period`])
    sectors.push({
      colour,
      start: start !== null && end !== null ? bearing(start) : null,
      end: start !== null && end !== null ? bearing(end) : null,
      character: typeof characterTag === 'string' && characterTag.trim() ? characterTag.trim() : null,
      periodS: periodS !== null && periodS > 0 ? periodS : null,
      group: typeof groupTag === 'string' && groupTag.trim() ? groupTag.trim() : null,
      heightM: leadingNumber(tags[`${prefix}height`]),
      rangeNm: leadingNumber(tags[`${prefix}range`]),
    })
  }
  return sectors
}

/**
 * What an object is on the map: a light with its kind, elevation, range
 * and sectors – or null for an object that is no light tower, or one
 * without a lit sector.
 */
export function classifyLighthouse(tags) {
  if (!tags) return null
  const type = clean(tags['seamark:type'])
  const tower = clean(tags.man_made) === 'lighthouse' || type === 'light_major' || type === 'light_minor'
  if (!tower) return null
  const sectors = lightSectors(tags)
  if (sectors.length === 0) return null
  const heights = sectors.map((s) => s.heightM).filter((h) => h !== null)
  const ranges = sectors.map((s) => s.rangeNm).filter((r) => r !== null)
  const heightM = heights.length > 0 ? Math.max(...heights) : null
  const rangeNm = ranges.length > 0 ? Math.max(...ranges) : null
  const kind = type === 'light_major' || (rangeNm !== null && rangeNm >= MAJOR_RANGE_NM) ? 'major' : 'minor'
  return { kind, heightM, rangeNm, sectors }
}

/** 6 decimals ≈ 10 cm. */
const round6 = (v) => Math.round(v * 1e6) / 1e6

function metresApart(a, b) {
  const midLat = ((a[1] + b[1]) / 2) * (Math.PI / 180)
  return Math.hypot((a[0] - b[0]) * 111_320 * Math.cos(midLat), (a[1] - b[1]) * 111_132)
}

/**
 * The lights of a box out of an Overpass answer (`out center` – a way's
 * centre stands for the building): every lit tower inside it as
 * [lon, lat, kind, heightM, rangeNm, sectors], the sectors as
 * [colour, start, end, character, periodS, group], one per spot (a second light within
 * SAME_LIGHT_M is the same light mapped twice; nodes are taken before
 * ways), in a fixed order so the file is byte-stable across runs – by
 * kind, then longitude, then latitude.
 */
export function selectLighthouses(elements, box) {
  const candidates = []
  for (const el of elements ?? []) {
    const lon = el?.type === 'node' ? el.lon : el?.center?.lon
    const lat = el?.type === 'node' ? el.lat : el?.center?.lat
    if (typeof lon !== 'number' || typeof lat !== 'number') continue
    if (lon < box.west || lon > box.east || lat < box.south || lat > box.north) continue
    const light = classifyLighthouse(el.tags)
    if (!light) continue
    candidates.push({ node: el.type === 'node', lon: round6(lon), lat: round6(lat), light })
  }
  candidates.sort((a, b) => (a.node === b.node ? a.lon - b.lon || a.lat - b.lat : a.node ? -1 : 1))
  const kept = []
  for (const c of candidates) {
    if (kept.some((k) => metresApart([k.lon, k.lat], [c.lon, c.lat]) < SAME_LIGHT_M)) continue
    kept.push(c)
  }
  return kept
    .map(({ lon, lat, light }) => [
      lon,
      lat,
      light.kind,
      light.heightM,
      light.rangeNm,
      light.sectors.map((s) => [s.colour, s.start, s.end, s.character, s.periodS, s.group]),
    ])
    .sort((a, b) => (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : a[0] - b[0] || a[1] - b[1]))
}

/**
 * How many lights of each kind, how many of them sector lights, and how
 * many turn their optic – a major light of MAJOR_RANGE_NM and more whose
 * every sector flashes with one character and one known period, the
 * app's rule (src/lib/lighthouse-beam.ts; a leading light with a
 * flashing guide sector among fixed ones is none) – for the run's log
 * and the tests.
 */
export function countLighthouses(lights) {
  const counts = { major: 0, minor: 0, sectored: 0, rotating: 0 }
  for (const light of lights) {
    counts[light[2]] = (counts[light[2]] ?? 0) + 1
    if (light[5].some((s) => s[1] !== null)) counts.sectored++
    const tower = light[2] === 'major' && light[4] !== null && light[4] >= MAJOR_RANGE_NM
    const [first] = light[5]
    const optic =
      tower &&
      first !== undefined &&
      /^L?Fl$/.test(first[3] ?? '') &&
      typeof first[4] === 'number' &&
      first[4] > 0 &&
      light[5].every((s) => s[3] === first[3] && s[4] === first[4])
    if (optic) counts.rotating++
  }
  return counts
}
