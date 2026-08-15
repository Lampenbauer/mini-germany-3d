/**
 * Berechnet die Start-Kameraposition aus der Bounding-Box des Liniennetzes,
 * damit unabhängig von der Datenquelle (Demo/OSM) das gesamte Netz im Bild ist.
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

  // Schräge Draufsicht von Süden: Bei Pitch ≈ -38° liegt der angeschaute
  // Bodenpunkt etwa 1,3 × Höhe vor der Kamera.
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
