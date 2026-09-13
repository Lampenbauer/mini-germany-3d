/**
 * What a sector light shows to a viewer: the colour of the sector the
 * viewer stands in, or nothing where no sector reaches. The bearings a
 * chart gives a sector are "from seaward" – the bearing from the vessel
 * to the light, clockwise from true north – and a sector runs clockwise
 * from its start to its end, through north where the end is the smaller
 * number. An all-round light (no bounds) shows its colour everywhere.
 *
 * Pure, like the ships' screened lights (nav-lights.ts): the layer
 * hands in the camera's bearing to the light and paints the point.
 */

import type { LightColour, LightSector } from '@/data/lighthouses'

/** Whether a bearing lies in the clockwise arc from `start` to `end` (degrees, folded). */
export function bearingInSector(bearingDeg: number, start: number, end: number): boolean {
  const fold = (deg: number) => ((deg % 360) + 360) % 360
  const b = fold(bearingDeg)
  const s = fold(start)
  const e = fold(end)
  // A sector given as a full circle, or degenerate, shows everywhere
  if (s === e) return true
  return s < e ? b >= s && b <= e : b >= s || b <= e
}

/**
 * The colour a light shows towards a viewer at `bearingDeg` (from the
 * viewer to the light): the first sector holding the bearing, an
 * all-round sector where none is bounded – or null, the light obscured
 * from where the viewer stands.
 */
export function sectorColourTowards(sectors: readonly LightSector[], bearingDeg: number): LightColour | null {
  let allRound: LightColour | null = null
  for (const [colour, start, end] of sectors) {
    if (start === null || end === null) {
      allRound ??= colour
      continue
    }
    if (bearingInSector(bearingDeg, start, end)) return colour
  }
  return allRound
}

/**
 * The bearing from one point to another over the ground, degrees
 * clockwise from true north – good to a fraction of a degree over the
 * few kilometres a light is looked at from, which is all a sector
 * needs.
 */
export function bearingToDeg(fromLon: number, fromLat: number, toLon: number, toLat: number): number {
  const midLat = (((fromLat + toLat) / 2) * Math.PI) / 180
  const east = (toLon - fromLon) * Math.cos(midLat)
  const north = toLat - fromLat
  const deg = (Math.atan2(east, north) * 180) / Math.PI
  return ((deg % 360) + 360) % 360
}
