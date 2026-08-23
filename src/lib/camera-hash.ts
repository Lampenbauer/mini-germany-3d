/**
 * Persists the view in the URL hash in one of two forms:
 *   camera pose  #lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35
 *   selection    #vehicle=1-0-500
 * While a vehicle is selected, ONLY its trip id is in the URL – trip ids
 * are deterministic across reloads (see simTripId), and opening such a
 * link re-selects the vehicle and follows it, so no camera pose is
 * needed. Without a selection the camera pose makes the view shareable.
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
 * UI state that rides along in either hash form (camera pose or vehicle):
 * the Routes/Stops layer toggles and the pause state. Only deviations
 * from the defaults (both layers on, clock running) appear in the URL, so
 * default sessions keep clean hashes.
 */
export interface HashUiState {
  routesHidden: boolean
  stopsHidden: boolean
  paused: boolean
}

/** Suffix appended to a camera or vehicle hash ('' when all defaults). */
export function formatUiStateHash(state: HashUiState): string {
  return (
    (state.routesHidden ? '&routes=0' : '') +
    (state.stopsHidden ? '&stops=0' : '') +
    (state.paused ? '&paused=1' : '')
  )
}

export function parseUiStateHash(hash: string): HashUiState {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(raw)
  return {
    routesHidden: params.get('routes') === '0',
    stopsHidden: params.get('stops') === '0',
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
