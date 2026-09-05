/**
 * What the app keeps of Windy's Webcams API answer – shared by the dev
 * middleware (vite.config.ts) and mirrored by api/webcams.php, so both
 * endpoints hand the browser the same shape. Pure: no fetch, no clock.
 *
 * Windy (https://api.windy.com/webcams/docs) lists cameras around a
 * point (`nearby=lat,lon,radiusKm`); a city asks for the circle around
 * its box and keeps the cameras inside the box that are active and carry
 * a preview picture. The free tier serves 400 × 224 previews.
 */

import { boundingBoxCenter, containsLonLat, type BoundingBox } from './city'

/** One camera as the map draws it. */
export interface Webcam {
  id: number
  title: string
  lon: number
  lat: number
  /** The current preview picture (URL from the API – the terms allow no other). */
  image: string
  /** The camera's page on windy.com – every picture has to link there. */
  detailUrl: string
  /** When the camera last sent a picture (ISO 8601). */
  updatedAt: string
}

/** What /api/webcams answers. */
export interface WebcamsApiResponse {
  servedAt: number
  webcams: Webcam[]
}

/** The circle Windy is asked for: the box's center and the distance to its corner. */
export function windyNearby(box: BoundingBox): { lat: number; lon: number; radiusKm: number } {
  const center = boundingBoxCenter(box)
  const meters = haversineMeters(center.longitude, center.latitude, box.east, box.north)
  return {
    lat: Number(center.latitude.toFixed(4)),
    lon: Number(center.longitude.toFixed(4)),
    radiusKm: Math.ceil(meters / 1000),
  }
}

/**
 * The cameras of an API answer (or a merged list of pages) inside the
 * box, minus the ids the city leaves off the map (city.json
 * `webcams.exclude`).
 */
export function extractWebcams(payload: unknown, box: BoundingBox, exclude: readonly number[] = []): Webcam[] {
  const list = (payload as { webcams?: unknown } | null)?.webcams
  if (!Array.isArray(list)) return []
  const excluded = new Set(exclude)
  const webcams: Webcam[] = []
  for (const raw of list) {
    const cam = raw as Record<string, unknown>
    const location = cam.location as Record<string, unknown> | undefined
    const images = cam.images as { current?: { preview?: unknown } } | undefined
    const urls = cam.urls as { detail?: unknown } | undefined
    const id = cam.webcamId
    const lon = location?.longitude
    const lat = location?.latitude
    const image = images?.current?.preview
    const detailUrl = urls?.detail
    if (
      typeof id !== 'number' ||
      excluded.has(id) ||
      typeof lon !== 'number' ||
      typeof lat !== 'number' ||
      typeof image !== 'string' ||
      typeof detailUrl !== 'string' ||
      cam.status !== 'active' ||
      !containsLonLat(box, lon, lat)
    ) {
      continue
    }
    webcams.push({
      id,
      title: typeof cam.title === 'string' ? cam.title : `Webcam ${id}`,
      lon,
      lat,
      image,
      detailUrl,
      updatedAt: typeof cam.lastUpdatedOn === 'string' ? cam.lastUpdatedOn : '',
    })
  }
  return webcams
}

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a))
}
