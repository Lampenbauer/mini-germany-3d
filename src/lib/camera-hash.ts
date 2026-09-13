import { config } from '@/config'
import { berlinDateKey, berlinEpoch, parseTimeOfDay } from '@/lib/clock'
import { isMapView, type MapView } from '@/lib/map-view'
import { isWeatherMode, type WeatherMode } from '@/lib/weather'

/**
 * Persists the view in the URL hash in one of four forms:
 *   camera pose  #lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35
 *   vehicle      #vehicle=1-0-500
 *   ship         #vessel=211222290
 *   aircraft     #aircraft=3c65a2
 *   stop         #stop=osm-241200227
 * While a selection is up, ONLY its id is in the URL – trip ids are
 * deterministic across reloads (see simTripId), stop ids are the stable
 * network ids, an MMSI is the ship herself – and opening such a link
 * re-selects it (a vehicle and a ship are then followed, a stop flown to),
 * so no camera pose is needed. Without a selection the camera pose makes
 * the view shareable.
 *
 * The ship is the one whose link can go stale: her MMSI is as stable as
 * any id, but whether she is still in the harbour an hour later is not up
 * to us. The restore waits for her and gives up silently, the way the
 * vehicle restore does for a trip that is not running.
 *
 * The city is not in the hash: it is the path (`/kiel/`, see
 * lib/site-path.ts), where a crawler and a link preview can see it.
 */

export interface CameraView {
  longitude: number
  latitude: number
  height: number
  heading: number
  pitch: number
}

export function parseCameraHash(hash: string): CameraView | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const params = new URLSearchParams(raw)

  const lat = Number(params.get('lat'))
  const lon = Number(params.get('lon'))
  const height = Number(params.get('height'))
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(height)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  if (height <= 0 || height > 40_000_000) return null

  const headingRaw = Number(params.get('heading') ?? '0')
  const pitchRaw = Number(params.get('pitch') ?? '-90')
  const heading = Number.isFinite(headingRaw) ? ((headingRaw % 360) + 360) % 360 : 0
  const pitch = Number.isFinite(pitchRaw) ? Math.min(90, Math.max(-90, pitchRaw)) : -90

  return { longitude: lon, latitude: lat, height, heading, pitch }
}

export function formatCameraHash(view: CameraView): string {
  const heading = Math.round(((view.heading % 360) + 360) % 360)
  return (
    `#lat=${view.latitude.toFixed(6)}` +
    `&lon=${view.longitude.toFixed(6)}` +
    `&height=${Math.round(view.height)}` +
    `&heading=${heading === 360 ? 0 : heading}` +
    `&pitch=${Math.round(view.pitch)}`
  )
}

/** Hash for a selected vehicle – the trip id is the whole shared state. */
export function formatVehicleHash(vehicleId: string): string {
  return `#vehicle=${encodeURIComponent(vehicleId)}`
}

/** Hash for a selected ship – her MMSI is the whole shared state. */
export function formatVesselHash(mmsi: number): string {
  return `#vessel=${mmsi}`
}

/**
 * MMSI of the ship selection carried in the hash, or null. An MMSI is nine
 * digits at most; anything else is not one, and a ship that is no longer
 * in the harbour is simply never found by the restore.
 */
export function parseVesselHash(hash: string): number | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const vessel = new URLSearchParams(raw).get('vessel')
  if (!vessel || !/^[0-9]{1,9}$/.test(vessel)) return null
  const mmsi = Number(vessel)
  return mmsi > 0 ? mmsi : null
}

/** Hash for a selected aircraft – its ICAO address is the whole shared state. */
export function formatAircraftHash(hex: string): string {
  return `#aircraft=${encodeURIComponent(hex)}`
}

/**
 * ICAO address of the aircraft selection carried in the hash, or null:
 * six hex digits, with the '~' a non-ICAO address wears. Like the ship,
 * an aircraft that has flown on out of the box is simply never found by
 * the restore.
 */
export function parseAircraftHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const aircraft = new URLSearchParams(raw).get('aircraft')?.toLowerCase()
  if (!aircraft || !/^~?[0-9a-f]{6}$/.test(aircraft)) return null
  return aircraft
}

/**
 * Hash for a selected stop. Stop ids are stable across reloads (OSM node
 * ids from network.json), so the link re-opens the same stop card; like
 * the vehicle hash it carries no camera pose – the restore flies to the
 * stop instead.
 */
export function formatStopHash(stopId: string): string {
  return `#stop=${encodeURIComponent(stopId)}`
}

/** Stop id carried in the hash, or null (same permissiveness as vehicles). */
export function parseStopHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const stop = new URLSearchParams(raw).get('stop')
  if (!stop || stop.length > 128) return null
  return stop
}

/**
 * UI state that rides along in either hash form (camera pose or vehicle):
 * the Routes/Stops/Labels layer toggles, the sky, the webcams and the
 * clouds, the miniature look, the clock as it was set by hand, and the
 * pause state. Apart from the sky – which every link names, so that it
 * opens on the one it was copied from – only deviations from the
 * defaults (all layers on, the miniature look at
 * config.camera.miniatureDefault, the real clock, running) appear in the
 * URL, so default sessions keep short hashes. The city the rest refers
 * to is the path's (lib/site-path.ts).
 */
export interface HashUiState {
  /**
   * Which reading of the network is on screen. The surface is the plain
   * map, so it is what an absent `view=` means and never written out.
   */
  view: MapView
  routesHidden: boolean
  stopsHidden: boolean
  labelsHidden: boolean
  /** The webcam pictures switched off in the panel (the layer's own boot flag is ?webcams=0). */
  webcamsHidden: boolean
  /**
   * The sky in force – the live weather or one of the three picked ones
   * (see WeatherMode). Written out like the city, every session's sky
   * included, because "live" is a choice as much as "rain" is and a URL
   * that leaves it out says which sky it means only to a reader who
   * knows whether the session it came from could poll one. Null only
   * where a hash names no sky, which the app reads as the sky such a
   * session opens on.
   */
  weather: WeatherMode | null
  /**
   * The volumetric clouds, as they are – switched from the weather
   * popover; the hash carries them only when they deviate from
   * config.weather.clouds3dDefault (clouds=1 or clouds=0).
   */
  clouds: boolean
  /** The miniature look, as it is – the hash carries it only when it deviates. */
  tiltShift: boolean
  /**
   * The clock as the reader SET it – the day picked in the panel's
   * calendar ("YYYY-MM-DD") and the time typed into its field ("HH:MM",
   * seconds only when they were given) – null for a half still on the
   * real clock. The entry, never the running clock: a hash that ticked
   * with the simulation would be a link that is never the same twice
   * and an address bar that never rests, and what the reader meant was
   * the moment they set, which is what the link opens on. The `?time=`
   * search parameter stays the boot flag it is (the tests) and makes no
   * entry; the panel's does, and wins over it.
   */
  date: string | null
  time: string | null
  paused: boolean
}

/** A "YYYY-MM-DD" that is a real calendar day (Feb 30 is not one). */
function isDateKey(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && berlinDateKey(berlinEpoch(text, 0)) === text
}

/**
 * A time of day (seconds since midnight) as the hash and the panel's
 * field spell it: "HH:MM", or "HH:MM:SS" where the seconds are not zero.
 */
export function formatTimeEntry(sec: number): string {
  const hh = String(Math.floor(sec / 3600)).padStart(2, '0')
  const mm = String(Math.floor((sec % 3600) / 60)).padStart(2, '0')
  const ss = sec % 60
  return ss === 0 ? `${hh}:${mm}` : `${hh}:${mm}:${String(ss).padStart(2, '0')}`
}

/** A typed time in that spelling; anything that is not a time of day is null. */
export function normalizeTimeEntry(text: string | null | undefined): string | null {
  const sec = text ? parseTimeOfDay(text) : null
  return sec === null ? null : formatTimeEntry(sec)
}

/** Suffix appended to a camera or vehicle hash ('' when all defaults). */
export function formatUiStateHash(state: HashUiState): string {
  const tilt =
    state.tiltShift === config.camera.miniatureDefault ? '' : state.tiltShift ? '&tiltshift=1' : '&tiltshift=0'
  const clouds =
    state.clouds === config.weather.clouds3dDefault ? '' : state.clouds ? '&clouds=1' : '&clouds=0'
  return (
    (state.view === 'surface' ? '' : `&view=${state.view}`) +
    (state.routesHidden ? '&routes=0' : '') +
    (state.stopsHidden ? '&stops=0' : '') +
    (state.labelsHidden ? '&labels=0' : '') +
    (state.webcamsHidden ? '&webcams=0' : '') +
    (state.weather ? `&weather=${state.weather}` : '') +
    clouds +
    tilt +
    (state.date ? `&date=${state.date}` : '') +
    (state.time ? `&time=${state.time}` : '') +
    (state.paused ? '&paused=1' : '')
  )
}

export function parseUiStateHash(hash: string): HashUiState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(raw)
  const tilt = params.get('tiltshift')
  const clouds = params.get('clouds')
  const date = params.get('date')
  return {
    // An unknown or missing reading is the map itself
    view: isMapView(params.get('view')) ? (params.get('view') as MapView) : 'surface',
    routesHidden: params.get('routes') === '0',
    stopsHidden: params.get('stops') === '0',
    labelsHidden: params.get('labels') === '0',
    webcamsHidden: params.get('webcams') === '0',
    // An unnamed or misspelled sky is no sky – whether this session can
    // show the one named is the caller's business (see hashWeatherMode).
    weather: isWeatherMode(params.get('weather')) ? (params.get('weather') as WeatherMode) : null,
    clouds: clouds === '1' ? true : clouds === '0' ? false : config.weather.clouds3dDefault,
    tiltShift: tilt === '1' ? true : tilt === '0' ? false : config.camera.miniatureDefault,
    // A day that is no day, a time that is no time: no entry, as if the
    // hash had named none
    date: date !== null && isDateKey(date) ? date : null,
    time: normalizeTimeEntry(params.get('time')),
    paused: params.get('paused') === '1',
  }
}

/**
 * Trip id of the vehicle selection carried in the hash, or null. Kept
 * permissive on the format – an id that matches no active trip is simply
 * never found by the restore and times out silently.
 */
export function parseVehicleHash(hash: string): string | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw) return null
  const vehicle = new URLSearchParams(raw).get('vehicle')
  if (!vehicle || vehicle.length > 128) return null
  return vehicle
}
