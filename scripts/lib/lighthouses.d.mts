/** Type declarations so the lighthouse selection can be unit-tested from Vitest. */

export type LightColour = 'white' | 'red' | 'green' | 'yellow'
export type LighthouseKind = 'major' | 'minor'

export const LIGHT_COLOURS: readonly LightColour[]

export interface LightSector {
  colour: LightColour
  /** Bearing from seaward the sector starts at, clockwise; null for an all-round light. */
  start: number | null
  end: number | null
  character: string | null
  /** The light's period in seconds (seamark:light:period), null without one. */
  periodS: number | null
  /** The group as OSM writes it ("3", "2+1"), null without one. */
  group: string | null
  heightM: number | null
  rangeNm: number | null
}

/** One selected light: [lon, lat, kind, height over the water in m, range in nm, sectors as [colour, start, end, character, period, group]]. */
export type SelectedLighthouse = [
  number,
  number,
  LighthouseKind,
  number | null,
  number | null,
  [LightColour, number | null, number | null, string | null, (number | null)?, (string | null)?][],
]

export function leadingNumber(value: unknown): number | null
export function lightSectors(tags: Record<string, string>): LightSector[]
export function classifyLighthouse(
  tags: Record<string, string> | undefined,
): { kind: LighthouseKind; heightM: number | null; rangeNm: number | null; sectors: LightSector[] } | null
export function selectLighthouses(
  elements: {
    type: string
    id?: number
    lon?: number
    lat?: number
    center?: { lon: number; lat: number }
    tags?: Record<string, string>
  }[],
  box: { west: number; south: number; east: number; north: number },
): SelectedLighthouse[]
export function countLighthouses(lights: readonly SelectedLighthouse[]): { major: number; minor: number; sectored: number; rotating: number }
