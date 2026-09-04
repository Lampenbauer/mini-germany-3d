/**
 * A city as the whole project sees it: the rectangle its data, its camera
 * leash, its AIS subscription and its weather point share, where the home
 * view looks, which lines the pipeline fetches, which fleet drives them,
 * and where the terrain heights come from. Every city is a folder
 * src/cities/<slug>/ with a city.json (this shape) next to the generated
 * network, schedule and street-lamp data.
 *
 * Who reads a city (each derives its own shape from it):
 *   - the app (src/cities/index.ts loads a city's data on demand)
 *   - the Overpass queries of the data pipeline (scripts/lib/overpass.mjs)
 *   - the camera fence of the map (src/map/camera-limits.ts) and the E2E
 *     tests that push against it
 *   - the aisstream.io subscription: vite.config.ts in dev, and
 *     server/api/ais.php in production, which reads the city.json files
 *     itself (ci.yml copies them next to the script)
 *   - the GTFS import (scripts/fetch-gtfs-schedule.mjs), which takes the
 *     unpadded `cityBounds`: it reads a trip's departure time at its first
 *     stop inside the rectangle, and with the padding that would be a
 *     station in the next town for a regional train
 *   - the live weather (config.weather), queried for `weather`
 *
 * `boundingBox` in the JSON is what `cityBounds` and `paddingMeters` give
 * through padBoundingBox below; tests/cities.test.ts recomputes it and
 * names the right numbers when a JSON is off.
 *
 * Node runs the pipeline scripts against this file directly (type
 * stripping, Node ≥ 22.18), so it stays free of path aliases and
 * non-erasable TypeScript syntax.
 */

import { isTransitMode, type TransitMode } from './transit-mode.ts'

/** A geographic rectangle in WGS84 degrees. */
export interface BoundingBox {
  west: number
  south: number
  east: number
  north: number
}

export interface LonLatPoint {
  longitude: number
  latitude: number
}

/**
 * The home view (also the "Reset camera" view): the ground point the
 * camera looks at, from `height` meters up, with this heading and pitch
 * – where the camera itself stands follows from that (see homePosition
 * in map/CesiumMap.ts). The height is the one that frames the city at
 * Cesium's 60° field of view; it is scaled to the configured angle when
 * the camera flies home.
 */
export interface CityHome extends LonLatPoint {
  height: number
  heading: number
  pitch: number
}

/** Vehicle dimensions in meters (length × width × height). */
export interface VehicleDims {
  length: number
  width: number
  height: number
}

/**
 * What runs on a mode in this city: the dimensions of the vehicle and,
 * where the map has a glTF consist for it, the consist's id (see
 * VEHICLE_CONSISTS in map/VehicleLayer.ts). Without a model the mode is
 * drawn as a colored box.
 */
export interface CityFleetEntry extends VehicleDims {
  model?: string
}

/**
 * How the pipeline picks a mode's route relations out of OSM: regular
 * expressions matched (case-insensitively) against the relation tags.
 * All optional – an empty query takes every route relation of that mode
 * inside the bounding box.
 */
export interface OverpassModeQuery {
  operator?: string
  ref?: string
  service?: string
  network?: string
}

/**
 * A line addressed by its OSM relation id rather than found by the mode
 * queries – ferries mostly, which OSM tags too inconsistently to query.
 * The fields override what the relation's tags would give.
 */
export interface FixedLine {
  osmRelation: number
  mode: TransitMode
  id: string
  name: string
  from?: string
  to?: string
  color?: string
  vehicle?: VehicleDims
  model?: string
}

/**
 * Where a route leaving the city is cut: at its last stop inside the
 * city limits ('city'), inside the padded bounding box ('box'), or not at
 * all ('none'). The GTFS import anchors departures at the same stop, so
 * the two stay consistent.
 */
export type NetworkClip = 'city' | 'box' | 'none'

export interface CityNetworkConfig {
  /** Modes the pipeline fetches, in this order. */
  modes: TransitMode[]
  overpass: Partial<Record<TransitMode, OverpassModeQuery>>
  fixedLines: FixedLine[]
  clip: NetworkClip
}

export interface CityGtfsConfig {
  /**
   * Prefix the feed puts in front of stop names ("Rostock, Hbf") that the
   * network's stop names do not carry – stripped before matching.
   */
  nameStrip?: string
  /**
   * Trains the feed lumps into one route that are told apart by a branch
   * station they serve outside the city: the first stop matching
   * `pattern` names the line. Empty for feeds that keep the lines apart.
   */
  trainBranches: { lineId: string; pattern: string }[]
}

/**
 * Where the terrain heights of the routes and lamps come from:
 * 'wcs-geotiff' is a WCS 2.0.1 serving float32 GeoTIFF tiles (the
 * Mecklenburg-Vorpommern DGM), 'xyz-zip' a downloadable zip of ASCII XYZ
 * tiles (Hamburg's DGM10), 'none' leaves the heights out and the app
 * clamps the routes onto the 3D tiles instead.
 */
export type TerrainProvider = 'wcs-geotiff' | 'xyz-zip' | 'none'

export interface CityTerrainConfig {
  provider: TerrainProvider
  /** The WCS endpoint, or the zip to download. */
  url?: string
  coverage?: string
  /** Projection the WCS is queried in, or the tiles are in (EPSG code of the UTM zone). */
  crs?: string
  /** xyz-zip: tile edge in meters (2000 for the Hamburg DGMs). */
  tileSizeMeters?: number
  /** xyz-zip: cell spacing in meters (10 for a DGM10). */
  gridMeters?: number
  /**
   * NHN→ellipsoid offset in meters until the height bootstrap has
   * measured the real one against the loaded tiles: the geoid undulation
   * over the city (36–50 m across Germany).
   */
  geoidOffsetFallback: number
  /** Height ferries and their routes ride at, in meters NHN. */
  waterLevelNhn: number
  attribution?: string
}

export interface CityLampsConfig {
  enabled: boolean
  /**
   * Fewer lamps than this in the Overpass answer count as a mirror
   * failure rather than as data (see scripts/fetch-street-lamps.mjs).
   */
  minPlausible: number
}

export interface CityAisConfig {
  enabled: boolean
  /**
   * Which real vessel sails which simulated ferry line (MMSI → line id).
   * The ferries run on their timetable – this only EXCLUDES their AIS
   * twins from the backdrop fleet, one boat per crossing.
   */
  ferryLineByMmsi: Record<string, string>
}

export interface City {
  /** URL-safe identifier: the folder name under src/cities/. */
  slug: string
  /** Display name – "Rostock" in "Mini Rostock 3D". */
  name: string
  /** OSM relation of the city limits (boundary=administrative). */
  osmRelation: number
  cityBoundsQueriedOn?: string
  /**
   * Bounds of the city limits as Overpass reported them on the date above
   * – the largest outer ring of the relation, so exclaves out at sea
   * (Hamburg's Neuwerk) do not stretch the box (see scripts/add-city.mjs).
   */
  cityBounds: BoundingBox
  /** How far beyond the city limits the box reaches, on every side. */
  paddingMeters: number
  /** THE rectangle: the city limits plus the padding. */
  boundingBox: BoundingBox
  home: CityHome
  /** Where the live weather is queried for; default: the box's center. */
  weather: LonLatPoint
  network: CityNetworkConfig
  gtfs: CityGtfsConfig
  fleet: Partial<Record<TransitMode, CityFleetEntry>>
  terrain: CityTerrainConfig
  lamps: CityLampsConfig
  ais: CityAisConfig
}

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

/** A closed polygon ring as [lon, lat] pairs (first and last point equal or not). */
export type LonLatRing = [number, number][]

/**
 * Whether a point lies inside a polygon ring (even-odd rule). The city
 * limits are such a ring – a rectangle around them reaches into the
 * neighboring towns, and a route cut at the rectangle keeps legs the
 * city's terrain model does not cover (see scripts/fetch-osm-network.mjs).
 */
export function pointInRing(ring: LonLatRing, lon: number, lat: number): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    const crosses = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    if (crosses) inside = !inside
  }
  return inside
}

/**
 * The box's midpoint in degrees, rounded to four decimals (about 10 m) so
 * it reads cleanly wherever it ends up – in a request URL, for one.
 */
export function boundingBoxCenter(box: BoundingBox): LonLatPoint {
  const round4 = (value: number): number => Math.round(value * 1e4) / 1e4
  return {
    longitude: round4((box.west + box.east) / 2),
    latitude: round4((box.south + box.north) / 2),
  }
}

/** The box as Overpass wants it in a [bbox:…] setting: south,west,north,east. */
export function overpassBbox(box: BoundingBox): string {
  return [box.south, box.west, box.north, box.east].join(',')
}

// ---------------------------------------------------------------------------
// Reading a city.json
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fail(path: string, expected: string): never {
  throw new Error(`city.json: ${path} must be ${expected}`)
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number')
  return value
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(path, 'a non-empty string')
  return value
}

function optionalStr(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : str(value, path)
}

function box(value: unknown, path: string): BoundingBox {
  if (!isObject(value)) fail(path, 'a bounding box')
  const result = {
    west: num(value.west, `${path}.west`),
    south: num(value.south, `${path}.south`),
    east: num(value.east, `${path}.east`),
    north: num(value.north, `${path}.north`),
  }
  if (result.west >= result.east || result.south >= result.north) {
    fail(path, 'a box with west < east and south < north')
  }
  return result
}

function point(value: unknown, path: string): LonLatPoint {
  if (!isObject(value)) fail(path, 'a longitude/latitude point')
  return {
    longitude: num(value.longitude, `${path}.longitude`),
    latitude: num(value.latitude, `${path}.latitude`),
  }
}

function dims(value: unknown, path: string): VehicleDims {
  if (!isObject(value)) fail(path, 'vehicle dimensions')
  return {
    length: num(value.length, `${path}.length`),
    width: num(value.width, `${path}.width`),
    height: num(value.height, `${path}.height`),
  }
}

function mode(value: unknown, path: string): TransitMode {
  if (!isTransitMode(value)) fail(path, 'a transit mode')
  return value
}

/**
 * Types a parsed city.json, fills in the optional parts and refuses the
 * broken ones with a message that names the field. Every city goes
 * through here – the app's registry, the pipeline, and the test that
 * validates the committed definitions.
 */
export function cityFromJson(raw: unknown): City {
  if (!isObject(raw)) fail('(root)', 'an object')
  const slug = str(raw.slug, 'slug')
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) fail('slug', 'lower-case letters, digits and dashes')
  const boundingBox = box(raw.boundingBox, 'boundingBox')

  const networkRaw = isObject(raw.network) ? raw.network : {}
  const modes = Array.isArray(networkRaw.modes)
    ? networkRaw.modes.map((m, i) => mode(m, `network.modes[${i}]`))
    : (['tram', 'subway', 'train', 'bus', 'ferry'] as TransitMode[])
  const overpass: Partial<Record<TransitMode, OverpassModeQuery>> = {}
  if (networkRaw.overpass !== undefined) {
    if (!isObject(networkRaw.overpass)) fail('network.overpass', 'an object keyed by mode')
    for (const [key, query] of Object.entries(networkRaw.overpass)) {
      const m = mode(key, `network.overpass.${key}`)
      if (!isObject(query)) fail(`network.overpass.${key}`, 'an object')
      overpass[m] = {
        operator: optionalStr(query.operator, `network.overpass.${key}.operator`),
        ref: optionalStr(query.ref, `network.overpass.${key}.ref`),
        service: optionalStr(query.service, `network.overpass.${key}.service`),
        network: optionalStr(query.network, `network.overpass.${key}.network`),
      }
    }
  }
  const fixedLines: FixedLine[] = []
  if (networkRaw.fixedLines !== undefined) {
    if (!Array.isArray(networkRaw.fixedLines)) fail('network.fixedLines', 'an array')
    networkRaw.fixedLines.forEach((line, i) => {
      const path = `network.fixedLines[${i}]`
      if (!isObject(line)) fail(path, 'an object')
      fixedLines.push({
        osmRelation: num(line.osmRelation, `${path}.osmRelation`),
        mode: mode(line.mode, `${path}.mode`),
        id: str(line.id, `${path}.id`),
        name: str(line.name, `${path}.name`),
        from: optionalStr(line.from, `${path}.from`),
        to: optionalStr(line.to, `${path}.to`),
        color: optionalStr(line.color, `${path}.color`),
        vehicle: line.vehicle === undefined ? undefined : dims(line.vehicle, `${path}.vehicle`),
        model: optionalStr(line.model, `${path}.model`),
      })
    })
  }
  const clipRaw = networkRaw.clip ?? 'city'
  if (clipRaw !== 'city' && clipRaw !== 'box' && clipRaw !== 'none') {
    fail('network.clip', "'city', 'box' or 'none'")
  }

  const gtfsRaw = isObject(raw.gtfs) ? raw.gtfs : {}
  const trainBranches: CityGtfsConfig['trainBranches'] = []
  if (gtfsRaw.trainBranches !== undefined) {
    if (!Array.isArray(gtfsRaw.trainBranches)) fail('gtfs.trainBranches', 'an array')
    gtfsRaw.trainBranches.forEach((branch, i) => {
      if (!isObject(branch)) fail(`gtfs.trainBranches[${i}]`, 'an object')
      trainBranches.push({
        lineId: str(branch.lineId, `gtfs.trainBranches[${i}].lineId`),
        pattern: str(branch.pattern, `gtfs.trainBranches[${i}].pattern`),
      })
    })
  }

  const fleet: Partial<Record<TransitMode, CityFleetEntry>> = {}
  if (raw.fleet !== undefined) {
    if (!isObject(raw.fleet)) fail('fleet', 'an object keyed by mode')
    for (const [key, entry] of Object.entries(raw.fleet)) {
      const m = mode(key, `fleet.${key}`)
      if (!isObject(entry)) fail(`fleet.${key}`, 'an object')
      fleet[m] = {
        ...dims(entry, `fleet.${key}`),
        model: optionalStr(entry.model, `fleet.${key}.model`),
      }
    }
  }

  const terrainRaw = isObject(raw.terrain) ? raw.terrain : {}
  const provider = terrainRaw.provider ?? 'none'
  if (provider !== 'wcs-geotiff' && provider !== 'xyz-zip' && provider !== 'none') {
    fail('terrain.provider', "'wcs-geotiff', 'xyz-zip' or 'none'")
  }
  const lampsRaw = isObject(raw.lamps) ? raw.lamps : {}
  const aisRaw = isObject(raw.ais) ? raw.ais : {}
  const ferryLineByMmsi: Record<string, string> = {}
  if (aisRaw.ferryLineByMmsi !== undefined) {
    if (!isObject(aisRaw.ferryLineByMmsi)) fail('ais.ferryLineByMmsi', 'an object')
    for (const [mmsi, lineId] of Object.entries(aisRaw.ferryLineByMmsi)) {
      if (!/^\d{9}$/.test(mmsi)) fail(`ais.ferryLineByMmsi.${mmsi}`, 'keyed by a 9-digit MMSI')
      ferryLineByMmsi[mmsi] = str(lineId, `ais.ferryLineByMmsi.${mmsi}`)
    }
  }

  return {
    slug,
    name: str(raw.name, 'name'),
    osmRelation: num(raw.osmRelation, 'osmRelation'),
    cityBoundsQueriedOn: optionalStr(raw.cityBoundsQueriedOn, 'cityBoundsQueriedOn'),
    cityBounds: box(raw.cityBounds, 'cityBounds'),
    paddingMeters: num(raw.paddingMeters, 'paddingMeters'),
    boundingBox,
    home: {
      ...point(raw.home, 'home'),
      height: num(isObject(raw.home) ? raw.home.height : undefined, 'home.height'),
      heading: num(isObject(raw.home) ? (raw.home.heading ?? 0) : undefined, 'home.heading'),
      pitch: num(isObject(raw.home) ? (raw.home.pitch ?? -40) : undefined, 'home.pitch'),
    },
    weather: raw.weather === undefined ? boundingBoxCenter(boundingBox) : point(raw.weather, 'weather'),
    network: { modes, overpass, fixedLines, clip: clipRaw },
    gtfs: { nameStrip: optionalStr(gtfsRaw.nameStrip, 'gtfs.nameStrip'), trainBranches },
    fleet,
    terrain: {
      provider,
      url: optionalStr(terrainRaw.url, 'terrain.url'),
      coverage: optionalStr(terrainRaw.coverage, 'terrain.coverage'),
      crs: optionalStr(terrainRaw.crs, 'terrain.crs'),
      tileSizeMeters:
        terrainRaw.tileSizeMeters === undefined
          ? undefined
          : num(terrainRaw.tileSizeMeters, 'terrain.tileSizeMeters'),
      gridMeters:
        terrainRaw.gridMeters === undefined ? undefined : num(terrainRaw.gridMeters, 'terrain.gridMeters'),
      geoidOffsetFallback:
        terrainRaw.geoidOffsetFallback === undefined
          ? 40
          : num(terrainRaw.geoidOffsetFallback, 'terrain.geoidOffsetFallback'),
      waterLevelNhn:
        terrainRaw.waterLevelNhn === undefined ? 0 : num(terrainRaw.waterLevelNhn, 'terrain.waterLevelNhn'),
      attribution: optionalStr(terrainRaw.attribution, 'terrain.attribution'),
    },
    lamps: {
      enabled: lampsRaw.enabled === undefined ? false : lampsRaw.enabled === true,
      minPlausible:
        lampsRaw.minPlausible === undefined ? 1000 : num(lampsRaw.minPlausible, 'lamps.minPlausible'),
    },
    ais: { enabled: aisRaw.enabled === undefined ? true : aisRaw.enabled === true, ferryLineByMmsi },
  }
}
