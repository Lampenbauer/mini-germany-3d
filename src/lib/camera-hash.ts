import { config } from '@/config'
import { isMapView, type MapView } from '@/lib/map-view'

/**
 * Persists the view in the URL hash in one of three forms:
 *   camera pose  #lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35
 *   vehicle      #vehicle=1-0-500
 *   stop         #stop=osm-241200227
 * While a selection is up, ONLY its id is in the URL – trip ids are
 * deterministic across reloads (see simTripId), stop ids are the stable
 * network ids – and opening such a link re-selects it (a vehicle is then
 * followed, a stop flown to), so no camera pose is needed. Without a
 * selection the camera pose makes the view shareable.
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
 * the city, the Routes/Stops/Labels layer toggles, the webcams and the
 * clouds, the miniature look and the pause state. Only deviations from
 * the defaults (the default city, all layers on, the miniature look at
 * config.camera.miniatureDefault, clock running) appear in the URL, so
 * default sessions keep clean hashes.
 */
export interface HashUiState {
  /**
   * City slug, null for the default city. Written first so a shared link
   * reads "#city=kiel&lat=…" – the city is what the rest refers to:
   * vehicle and stop ids are only meaningful inside it.
   */
  city: string | null
  /** The lines pulled straight instead of drawn on the map (see LinearView). */
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
   * The volumetric clouds, as they are – switched from the weather
   * popover; the hash carries them only when they deviate from
   * config.weather.clouds3dDefault (clouds=1 or clouds=0).
   */
  clouds: boolean
  /** The miniature look, as it is – the hash carries it only when it deviates. */
  tiltShift: boolean
  paused: boolean
}

/** Suffix appended to a camera or vehicle hash ('' when all defaults). */
export function formatUiStateHash(state: HashUiState): string {
  const tilt =
    state.tiltShift === config.camera.miniatureDefault ? '' : state.tiltShift ? '&tiltshift=1' : '&tiltshift=0'
  const clouds =
    state.clouds === config.weather.clouds3dDefault ? '' : state.clouds ? '&clouds=1' : '&clouds=0'
  return (
    (state.city ? `&city=${encodeURIComponent(state.city)}` : '') +
    (state.view === 'surface' ? '' : `&view=${state.view}`) +
    (state.routesHidden ? '&routes=0' : '') +
    (state.stopsHidden ? '&stops=0' : '') +
    (state.labelsHidden ? '&labels=0' : '') +
    (state.webcamsHidden ? '&webcams=0' : '') +
    clouds +
    tilt +
    (state.paused ? '&paused=1' : '')
  )
}

export function parseUiStateHash(hash: string): HashUiState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(raw)
  const tilt = params.get('tiltshift')
  const clouds = params.get('clouds')
  const city = params.get('city')
  return {
    // Whether the slug names a city this build knows is the caller's
    // business – the hash module only carries it.
    city: city && city.length <= 64 ? city : null,
    // An unknown or missing reading is the map itself
    view: isMapView(params.get('view')) ? (params.get('view') as MapView) : 'surface',
    routesHidden: params.get('routes') === '0',
    stopsHidden: params.get('stops') === '0',
    labelsHidden: params.get('labels') === '0',
    webcamsHidden: params.get('webcams') === '0',
    clouds: clouds === '1' ? true : clouds === '0' ? false : config.weather.clouds3dDefault,
    tiltShift: tilt === '1' ? true : tilt === '0' ? false : config.camera.miniatureDefault,
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
