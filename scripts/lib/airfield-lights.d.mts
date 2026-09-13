/** Type declarations so the airfield light selection can be unit-tested from Vitest. */

export type AirfieldLightColour = 'white' | 'green' | 'red' | 'blue' | 'yellow'

export const AIRFIELD_LIGHT_KINDS: Record<string, AirfieldLightColour>
export const AIRFIELD_LIGHT_COLOURS: readonly AirfieldLightColour[]

/** One selected light: [lon, lat, kind, colour]. */
export type SelectedAirfieldLight = [number, number, string, AirfieldLightColour]

export function classifyAirfieldLight(
  tags: Record<string, string> | undefined,
): { kind: string; colour: AirfieldLightColour } | null

export function selectAirfieldLights(
  elements: { type: string; id?: number; lon?: number; lat?: number; tags?: Record<string, string> }[],
  box: { west: number; south: number; east: number; north: number },
): SelectedAirfieldLight[]

export function countByKind(lights: readonly SelectedAirfieldLight[]): Record<string, number>
