/**
 * The three readings of a city's network, exactly one of them on screen:
 * the city above ground, the same city from underneath, and the lines
 * pulled straight into a diagram with the city taken away entirely.
 *
 * They are one value rather than two switches because they exclude each
 * other – the tabs at the foot of the map are these, and so is the
 * `view=` the URL hash carries (see lib/camera-hash.ts).
 */
export type MapView = 'surface' | 'underground' | 'linear'

/** Every reading, in the order the tabs stack them. */
export const MAP_VIEWS = ['surface', 'underground', 'linear'] as const

export function isMapView(value: string | null): value is MapView {
  return value !== null && (MAP_VIEWS as readonly string[]).includes(value)
}
