/**
 * The one Rostock rectangle everything in this project works with, read
 * from src/data/rostock-bounding-box.json: the bounds of the city limits –
 * OSM relation 62405, the Kreisfreie Stadt Rostock – widened by 15 km on
 * all four sides. The JSON is the definition; this module types it and
 * adds the two helpers its readers need.
 *
 * Who reads the box (each derives its own shape from `rostockBoundingBox`):
 *   - the Overpass queries of the data pipeline (scripts/lib/overpass.mjs)
 *   - the camera fence of the map (src/map/camera-limits.ts) and the E2E
 *     tests that push against it
 *   - the aisstream.io subscription: vite.config.ts in dev, and
 *     server/api/ais.php in production, which reads the JSON itself
 *     (ci.yml copies it next to the script; scripts/test-ais-parity.mjs
 *     checks that PHP and this module subscribe alike)
 *   - the GTFS import (scripts/fetch-gtfs-schedule.mjs), which takes the
 *     unpadded `rostockCityBounds`: it reads a trip's departure time at
 *     its first stop inside the rectangle, and with the padding that
 *     would be Schwaan or Laage for the S-Bahn instead of Rostock Hbf
 *   - the live weather (config.weather), queried for the box's center
 *
 * `boundingBox` in the JSON is what `cityBounds` and `paddingMeters` give
 * through padBoundingBox below; tests/rostock-bounding-box.test.ts
 * recomputes it and names the right numbers when the JSON is off.
 *
 * Node runs the pipeline scripts against this file directly (type
 * stripping, Node ≥ 22.18 – the same way scripts/test-ais-parity.mjs
 * imports ais-extract.ts), so it stays free of path aliases and
 * non-erasable TypeScript syntax, and the JSON import carries the
 * `with { type: 'json' }` attribute Node's ESM loader insists on.
 */

import definition from '../data/rostock-bounding-box.json' with { type: 'json' }

/** A geographic rectangle in WGS84 degrees. */
export interface BoundingBox {
  west: number
  south: number
  east: number
  north: number
}

/**
 * Bounds of OSM relation 62405 (boundary=administrative, admin_level=6,
 * name=Rostock) as Overpass reported them on the date the JSON names. A
 * city limit changes about never – when it does, look the bounds up again
 * rather than querying them at build time:
 *   [out:json];rel(62405);out bb;
 */
export const rostockCityBounds: BoundingBox = definition.cityBounds

/** How far beyond the city limits the box reaches, on every side. */
export const ROSTOCK_BOUNDING_BOX_PADDING_METERS: number = definition.paddingMeters

/**
 * THE Rostock bounding box: the city limits plus 15 km on every side.
 * Currently 11.7666–12.5272 °E / 53.9158–54.3795 °N.
 */
export const rostockBoundingBox: BoundingBox = definition.boundingBox

/**
 * Mean length of a degree of latitude on WGS84 (110.57 km at the equator,
 * 111.69 km at the pole). A box margin does not care about the ~0.5 % spread.
 */
const METERS_PER_DEGREE_LATITUDE = 111_132

const floor4 = (value: number): number => Math.floor(value * 1e4) / 1e4
const ceil4 = (value: number): number => Math.ceil(value * 1e4) / 1e4

/**
 * Widens a box by `meters` on all four sides. The longitude padding is
 * converted at the padded box's outermost latitude, so the margin is at
 * least that wide everywhere inside it – meridians converge toward the
 * poles. The edges are rounded outward to four decimals (about 10 m):
 * numbers short enough for a JSON file that still never fall short of the
 * requested distance.
 */
export function padBoundingBox(box: BoundingBox, meters: number): BoundingBox {
  const latPadding = meters / METERS_PER_DEGREE_LATITUDE
  const outermostLat = Math.min(
    89,
    Math.max(Math.abs(box.south), Math.abs(box.north)) + latPadding,
  )
  const lonPadding = latPadding / Math.cos((outermostLat * Math.PI) / 180)
  return {
    west: Math.max(-180, floor4(box.west - lonPadding)),
    south: Math.max(-90, floor4(box.south - latPadding)),
    east: Math.min(180, ceil4(box.east + lonPadding)),
    north: Math.min(90, ceil4(box.north + latPadding)),
  }
}

/** Whether a WGS84 point lies inside the box (edges included). */
export function containsLonLat(box: BoundingBox, lon: number, lat: number): boolean {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north
}

/**
 * The box's midpoint in degrees, rounded to four decimals (about 10 m) so
 * it reads cleanly wherever it ends up – in a request URL, for one.
 */
export function boundingBoxCenter(box: BoundingBox): { longitude: number; latitude: number } {
  const round4 = (value: number): number => Math.round(value * 1e4) / 1e4
  return {
    longitude: round4((box.west + box.east) / 2),
    latitude: round4((box.south + box.north) / 2),
  }
}
