/**
 * Persists the camera orientation in the URL hash, e.g.
 *   #lat=54.084784&lon=12.131939&height=250&heading=0&pitch=-35
 * so the view survives a browser reload and is shareable. While a vehicle
 * is selected its trip id is appended as &vehicle=… – trip ids are
 * deterministic across reloads (see simTripId), so the link restores the
 * selection for anyone who opens it while that trip is active.
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

export function formatCameraHash(view: CameraView, vehicleId?: string | null): string {
  const heading = Math.round(((view.heading % 360) + 360) % 360)
  return (
    `#lat=${view.latitude.toFixed(6)}` +
    `&lon=${view.longitude.toFixed(6)}` +
    `&height=${Math.round(view.height)}` +
    `&heading=${heading === 360 ? 0 : heading}` +
    `&pitch=${Math.round(view.pitch)}` +
    (vehicleId ? `&vehicle=${encodeURIComponent(vehicleId)}` : '')
  )
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
