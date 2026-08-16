/**
 * Geodätische Hilfsfunktionen für die Bewegung entlang von Polylinien.
 * Alle Koordinaten sind [Längengrad, Breitengrad] in Grad (WGS84).
 */

export type LonLat = [number, number]

const EARTH_RADIUS_M = 6371008.8

export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI
}

/** Großkreis-Distanz (Haversine) in Metern. */
export function haversineMeters(a: LonLat, b: LonLat): number {
  const [lon1, lat1] = a
  const [lon2, lat2] = b
  const φ1 = toRadians(lat1)
  const φ2 = toRadians(lat2)
  const dφ = toRadians(lat2 - lat1)
  const dλ = toRadians(lon2 - lon1)
  const h =
    Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Anfangs-Kurswinkel von a nach b in Grad (0° = Nord, im Uhrzeigersinn). */
export function bearingDegrees(a: LonLat, b: LonLat): number {
  const φ1 = toRadians(a[1])
  const φ2 = toRadians(b[1])
  const dλ = toRadians(b[0] - a[0])
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (toDegrees(Math.atan2(y, x)) + 360) % 360
}

/** Kumulative Distanzen entlang einer Polylinie; Länge = path.length. */
export function cumulativeDistances(path: LonLat[]): number[] {
  const cum: number[] = new Array(path.length)
  cum[0] = 0
  for (let i = 1; i < path.length; i++) {
    cum[i] = cum[i - 1] + haversineMeters(path[i - 1], path[i])
  }
  return cum
}

export interface PathSample {
  lon: number
  lat: number
  /** Fahrtrichtung an dieser Stelle in Grad (0° = Nord). */
  bearing: number
}

/**
 * Punkt (und Fahrtrichtung) bei Distanz `d` entlang der Polylinie.
 * `d` wird auf [0, Gesamtlänge] begrenzt. Lineare Interpolation ist auf
 * Stadt-Maßstab (Segmente < 1 km) völlig ausreichend.
 */
export function sampleAtDistance(path: LonLat[], cum: number[], d: number): PathSample {
  const total = cum[cum.length - 1]
  const dist = Math.min(Math.max(d, 0), total)

  // Binäre Suche nach dem Segment mit cum[i] <= dist <= cum[i+1]
  let lo = 0
  let hi = cum.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= dist) lo = mid
    else hi = mid
  }

  const segLen = cum[hi] - cum[lo]
  const t = segLen > 0 ? (dist - cum[lo]) / segLen : 0
  const a = path[lo]
  const b = path[hi]
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    bearing: bearingDegrees(a, b),
  }
}

/**
 * Distanz entlang der Polylinie zum Fußpunkt der Projektion von `p`.
 * Verwendet eine lokale äquirektangulare Näherung pro Segment – für das
 * Zuordnen von Haltestellen auf die Strecke mehr als genau genug.
 *
 * `fromDist` (Meter) beschränkt die Suche auf den Streckenteil ab dieser
 * Distanz: Bei Linien, die denselben Straßenzug mehrfach befahren
 * (Schleifen), ist die globale Projektion mehrdeutig – Haltestellen werden
 * deshalb sequenziell projiziert, jede erst hinter ihrer Vorgängerin.
 */
export function projectOntoPath(
  path: LonLat[],
  cum: number[],
  p: LonLat,
  fromDist = 0,
): number {
  let bestDist = Infinity
  let bestAlong = fromDist
  const cosLat = Math.cos(toRadians(p[1]))

  for (let i = 0; i < path.length - 1; i++) {
    if (cum[i + 1] <= fromDist) continue // Segment liegt komplett vor fromDist
    const a = path[i]
    const b = path[i + 1]
    // Lokale Metrik-Koordinaten (Meter) relativ zu a
    const ax = 0
    const ay = 0
    const bx = (b[0] - a[0]) * cosLat * 111320
    const by = (b[1] - a[1]) * 110540
    const px = (p[0] - a[0]) * cosLat * 111320
    const py = (p[1] - a[1]) * 110540

    const segLenSq = (bx - ax) ** 2 + (by - ay) ** 2
    let t = 0
    if (segLenSq > 0) {
      t = ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / segLenSq
      t = Math.min(1, Math.max(0, t))
    }
    const cx = ax + t * (bx - ax)
    const cy = ay + t * (by - ay)
    const dSq = (px - cx) ** 2 + (py - cy) ** 2
    if (dSq < bestDist) {
      bestDist = dSq
      // Anteilig auf die (per Haversine berechnete) Segmentlänge umrechnen,
      // damit das Ergebnis konsistent zu `cum` ist. Nie vor fromDist landen
      // (der Fußpunkt kann im teilweise abgeschnittenen Segment davor liegen).
      bestAlong = Math.max(fromDist, cum[i] + (cum[i + 1] - cum[i]) * t)
    }
  }
  return bestAlong
}
