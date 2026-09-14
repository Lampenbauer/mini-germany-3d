/**
 * What the ground of the map is drawn from – the choice the layers
 * popover's "Flat map" switch makes and the hash carries as
 * `basemap=flat` (see lib/camera-hash.ts).
 *
 * '3d' is Google's photorealistic tiles, the map as it opens. 'flat' is
 * a street map on the bare ellipsoid: no tiles, no terrain, and every
 * height the city carries – the routes' profile, the stops, the lamps,
 * the water the ships ride – flattened to 0 m, so everything lies on the
 * one plane (see CesiumMap.setBasemap). The pictures come from Mapbox,
 * two styles of the site's own, one for the day and one for the night,
 * crossfaded along the sun's ramp (see map/FlatBasemap.ts).
 */
export type Basemap = '3d' | 'flat'

export const DEFAULT_BASEMAP: Basemap = '3d'

export function isBasemap(value: string | null | undefined): value is Basemap {
  return value === '3d' || value === 'flat'
}

/**
 * How the two Mapbox styles share the flat map at a night level (0 = day
 * … 1 = full night, CesiumMap's nightFactor): the night style is laid
 * over the day style at the level's opacity, and a style that would be
 * invisible is not drawn at all – Cesium loads tiles for every shown
 * layer whatever its alpha, so a switched-off style costs no requests
 * and no quota. Both are up only through dusk and dawn.
 */
export function flatMapStyleBlend(nightLevel: number): {
  day: { show: boolean }
  night: { show: boolean; alpha: number }
} {
  const night = Math.min(1, Math.max(0, nightLevel))
  return {
    day: { show: night < 1 },
    night: { show: night > 0, alpha: night },
  }
}
