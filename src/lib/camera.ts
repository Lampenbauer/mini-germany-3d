/**
 * Computes the initial camera position from the bounding box of the line
 * network, so the entire network is in view regardless of the data source
 * (demo/OSM).
 */

import { toRadians } from '@/lib/geo'
import type { PreparedNetwork } from '@/data/network-types'

export interface HomeView {
  longitude: number
  latitude: number
  height: number
  heading: number
  pitch: number
}

const METERS_PER_DEG_LAT = 110540

export function computeHomeView(network: PreparedNetwork): HomeView {
  let minLon = Infinity
  let maxLon = -Infinity
  let minLat = Infinity
  let maxLat = -Infinity
  for (const line of network.lines) {
    for (const dir of line.directions) {
      for (const [lon, lat] of dir.path) {
        if (lon < minLon) minLon = lon
        if (lon > maxLon) maxLon = lon
        if (lat < minLat) minLat = lat
        if (lat > maxLat) maxLat = lat
      }
    }
  }

  const centerLon = (minLon + maxLon) / 2
  const centerLat = (minLat + maxLat) / 2
  const spanX = (maxLon - minLon) * Math.cos(toRadians(centerLat)) * 111320
  const spanY = (maxLat - minLat) * METERS_PER_DEG_LAT
  const span = Math.max(spanX, spanY, 3000)

  // Oblique top-down view from the south: at pitch ≈ -38° the ground point
  // being looked at lies about 1.3 × height in front of the camera.
  const pitch = -38
  const height = Math.min(Math.max(span * 0.62, 2500), 9000)
  const latOffset = (1.3 * height) / METERS_PER_DEG_LAT

  return {
    longitude: centerLon,
    latitude: centerLat - latOffset,
    height,
    heading: 0,
    pitch,
  }
}
