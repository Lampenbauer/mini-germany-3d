/** Type declarations so the buoy selection can be unit-tested from Vitest. */

export type BuoyColour = 'red' | 'green' | 'yellow'
export type BuoyShape = 'can' | 'conical' | 'spar' | 'pillar' | 'spherical' | 'barrel'
export type BuoyLightColour = 'red' | 'green' | 'yellow' | 'white'

export const BUOY_COLOURS: readonly BuoyColour[]
export const BUOY_SHAPES: readonly BuoyShape[]
export const BUOY_LIGHT_COLOURS: readonly BuoyLightColour[]

export interface BuoyLight {
  colour: BuoyLightColour
  character: string | null
  period: number | null
}

/** One selected buoy: [lon, lat, colour, shape, light colour, light character, light period]. */
export type SelectedBuoy = [
  number,
  number,
  BuoyColour,
  BuoyShape,
  BuoyLightColour | null,
  string | null,
  number | null,
]

export function classifyBuoy(
  tags: Record<string, string> | undefined,
): { colour: BuoyColour; shape: BuoyShape; light: BuoyLight | null } | null

export function classifyLight(tags: Record<string, string>, buoyColour: BuoyColour): BuoyLight | null

export function selectBuoys(
  elements: { type: string; id?: number; lon?: number; lat?: number; tags?: Record<string, string> }[],
  box: { west: number; south: number; east: number; north: number },
): SelectedBuoy[]

export function countBuoys(buoys: readonly SelectedBuoy[]): { byColour: Record<string, number>; lit: number }
