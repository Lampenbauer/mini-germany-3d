/**
 * The rotating optic of a lighthouse, as the map turns it. A flashing
 * light (character Fl or LFl) on a lighthouse is a lens assembly turning
 * about the lamp: every lens throws a beam, and a beam sweeping past the
 * observer is the flash. So a light of "Fl(3) 22s" turns three lenses,
 * 120° apart, once every 22 seconds – one turn per period, one flash
 * per lens per turn. The composite groups ("2+1") are read as their sum
 * with the lenses spaced evenly, a simplification of optics whose
 * panels are not. A short period does not mean a fast optic: a plain
 * "Fl 3s" is not one lens racing round in three seconds but several
 * turning slowly – how many, OSM cannot say, so the map takes the
 * fewest that let a turn last MIN_TURN_S (four lenses in twelve seconds
 * for Friedrichsort's Fl 3s), which shows the same flash every three
 * seconds and turns like an optic does (the user saw the one-lens
 * version strobe, 2026-09-16).
 *
 * Which lights are optics at all: a tower's – a major light with a
 * range of OPTIC_RANGE_NM and more, so a pier head's flashing LED
 * (minor, Fl) is none, and neither is the flashing sector light on a
 * four-metre pole over the Havel that OSM tags light_major without a
 * range (Berlin) – with a period from OSM (an invented period would be
 * an invention), and one whose EVERY sector flashes with that one
 * character and period. An optic turns one lamp's light through
 * coloured screens: it cannot flash to the west and burn steadily to
 * the east. A light that does is a leading or sector light with a
 * flashing lamp behind a fixed lens – Wilhelmshaven's leading light
 * with its Oc 6s guide sector a degree wide, Fl 3s a degree left of it
 * and Fl(2) 9s three degrees right, fixed colours everywhere else, or
 * Bülk's white Fl(2) over one arc among occulting and fixed sectors –
 * and turns nothing (the first rule took Wilhelmshaven's first flashing
 * sector and swept a beam through its degree of arc: a strobe).
 *
 * The beam is lit where the light shows: the colour of the sector the
 * beam points into, read the way the lantern's point is (see
 * seamark-lights.ts – a sector's bearings are from seaward, from the
 * vessel to the light, so the beam's own azimuth is that bearing turned
 * about), nothing where the light is screened, as at sea.
 *
 * Pure; the layer (map/LighthousesLayer.ts) hands in the light and a
 * clock and gets the lenses' azimuths, and the tests pin the arithmetic.
 */

import type { LightColour, LightSector, Lighthouse } from '@/data/lighthouses'
import { sectorTowards } from './seamark-lights'

export interface RotatingOptic {
  /** The light's period in seconds – one group of flashes per period, as OSM gives it. */
  periodS: number
  /** Seconds per turn of the optic: the period, or a multiple of it where the period is short (MIN_TURN_S). */
  turnS: number
  /** Lenses about the lamp, evenly spaced – the group's flashes, times the turns a period is stretched to. */
  lenses: number
}

/** The characters that mean a turning optic: flashing and long-flashing. */
const ROTATING_CHARACTERS = new Set(['Fl', 'LFl'])
/** A light turns its optic from this range in nautical miles – a tower's light, not a pole's. */
export const OPTIC_RANGE_NM = 10
/** The least a turn of the optic takes, in seconds – a short period is more lenses, not a faster optic. */
export const MIN_TURN_S = 12

/** Whether a sector's character is a flashing one – what a turning lens shows. */
function flashes(sector: LightSector): boolean {
  const character = sector[3]
  return character !== null && ROTATING_CHARACTERS.has(character)
}

/** How many flashes a group holds: "3" → 3, "2+1" → 3, none → 1; a group that is no number → 1. */
export function lensCount(group: string | null | undefined): number {
  if (!group) return 1
  const parts = group.split('+').map((part) => Number.parseInt(part.trim(), 10))
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return 1
  return parts.reduce((sum, n) => sum + n, 0)
}

/**
 * The optic a light turns, or null: a major light of OPTIC_RANGE_NM and
 * more whose every sector flashes with one character and one period
 * that OSM gives (Bastorf's white and red are both LFl 15s; a light
 * with an occulting or fixed sector among them is no optic – see the
 * header). The lenses are the group's flashes, multiplied until a turn
 * lasts MIN_TURN_S.
 */
export function rotatingOptic(light: Lighthouse): RotatingOptic | null {
  const [, , kind, , rangeNm, sectors] = light
  if (kind !== 'major' || rangeNm === null || rangeNm < OPTIC_RANGE_NM || sectors.length === 0) return null
  const [first] = sectors
  if (!flashes(first)) return null
  const periodS = first[4]
  if (periodS === undefined || periodS === null || periodS <= 0) return null
  for (const sector of sectors) {
    if (sector[3] !== first[3] || sector[4] !== periodS) return null
  }
  const turns = Math.max(1, Math.ceil(MIN_TURN_S / periodS))
  return { periodS, turnS: periodS * turns, lenses: lensCount(first[5]) * turns }
}

/**
 * Where each lens's beam points at `seconds` on the optic's clock, in
 * degrees clockwise from true north: the optic turns clockwise seen from
 * above, once per `turnS`, the lenses evenly spaced and the first at
 * north when the clock is at zero.
 */
export function lensAzimuthsDeg(seconds: number, optic: RotatingOptic): number[] {
  const turn = ((seconds / optic.turnS) % 1 + 1) % 1
  const azimuths: number[] = []
  for (let lens = 0; lens < optic.lenses; lens++) {
    azimuths.push(((turn + lens / optic.lenses) * 360) % 360)
  }
  return azimuths
}

/**
 * The colour a beam pointing at `azimuthDeg` carries – the sector it
 * points into, read from seaward – or null where the light is screened
 * in that direction and the lens throws nothing. The sector is the one
 * the lantern's point shows (sectorTowards): the first bounded one
 * holding the bearing, else an all-round one. Every sector of an optic
 * flashes (rotatingOptic), so a lit sector is a lit beam.
 */
export function beamColour(sectors: readonly LightSector[], azimuthDeg: number): LightColour | null {
  return sectorTowards(sectors, azimuthDeg + 180)?.[0] ?? null
}
