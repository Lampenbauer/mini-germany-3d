/**
 * The transit modes a line can have, in the order the panel groups them.
 *
 * Alias-free on purpose: the city definitions (src/lib/city.ts) and the
 * Node data pipeline import this file directly.
 */

export const TRANSIT_MODES = ['tram', 'subway', 'train', 'bus', 'ferry'] as const

export type TransitMode = (typeof TRANSIT_MODES)[number]

export function isTransitMode(value: unknown): value is TransitMode {
  return typeof value === 'string' && (TRANSIT_MODES as readonly string[]).includes(value)
}
