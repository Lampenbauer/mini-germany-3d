/**
 * What an aircraft's raw numbers mean on the map and on its card: which
 * body an ICAO type designator gets and how big it is, and the words
 * for its altitude, speed and climb. ADS-B carries no dimensions – a
 * ship reports her length, an aircraft only says what type it is – so
 * the sizes come from a table of the types met over German cities, and
 * the emitter category stands in for a type the table does not know.
 */

import type { Aircraft } from '@/lib/aircraft-extract'
import { t } from '@/lib/i18n'

/**
 * The bodies the map draws (scripts/lib/aircraft-fleet.mjs builds one
 * glTF per archetype, AIRCRAFT_MODELS in map/AircraftLayer.ts stretches
 * it to the type's size). Seven, chosen by silhouette: a jet with
 * engines under a low wing in three sizes, a jet with its engines on the
 * tail, a high-wing turboprop, a light single, a helicopter.
 */
export type AircraftArchetype =
  | 'aircraft-narrowbody'
  | 'aircraft-widebody'
  | 'aircraft-jumbo'
  | 'aircraft-bizjet'
  | 'aircraft-turboprop'
  | 'aircraft-light'
  | 'aircraft-helicopter'

export interface AircraftSize {
  archetype: AircraftArchetype
  /** Length, wing span (rotor diameter for a helicopter) and height in metres. */
  lengthM: number
  spanM: number
  heightM: number
}

/** Reference size of each archetype – the type the model was drawn as. */
export const ARCHETYPE_SIZE: Record<AircraftArchetype, Omit<AircraftSize, 'archetype'>> = {
  'aircraft-narrowbody': { lengthM: 37.6, spanM: 35.8, heightM: 11.8 }, // A320
  'aircraft-widebody': { lengthM: 63.7, spanM: 60.3, heightM: 16.8 }, // A330-300
  'aircraft-jumbo': { lengthM: 72.7, spanM: 79.8, heightM: 24.1 }, // A380
  'aircraft-bizjet': { lengthM: 20.9, spanM: 19.6, heightM: 6.3 }, // Challenger 600
  'aircraft-turboprop': { lengthM: 27.2, spanM: 27.1, heightM: 7.7 }, // ATR 72
  'aircraft-light': { lengthM: 8.3, spanM: 11.0, heightM: 2.7 }, // Cessna 172
  'aircraft-helicopter': { lengthM: 10.2, spanM: 10.2, heightM: 3.5 }, // EC135, nose to tail
}

type Row = [AircraftArchetype, number, number, number]
const N = 'aircraft-narrowbody'
const W = 'aircraft-widebody'
const J = 'aircraft-jumbo'
const B = 'aircraft-bizjet'
const T = 'aircraft-turboprop'
const L = 'aircraft-light'
const H = 'aircraft-helicopter'

/**
 * ICAO type designator → body and size (length, span, height in
 * metres, from the manufacturers' airport-planning figures). The types
 * a German city sees: the airline fleets first, then the regional,
 * business and general-aviation types, the helicopters of the police
 * and the air ambulances, and the military transports that cross the
 * boxes. A type not listed falls back to its emitter category
 * (aircraftSize below).
 */
const TYPES: Record<string, Row> = {
  // Airbus single-aisle
  A318: [N, 31.4, 34.1, 12.6],
  A319: [N, 33.8, 35.8, 11.8],
  A19N: [N, 33.8, 35.8, 11.8],
  A320: [N, 37.6, 35.8, 11.8],
  A20N: [N, 37.6, 35.8, 11.8],
  A321: [N, 44.5, 35.8, 11.8],
  A21N: [N, 44.5, 35.8, 11.8],
  // Boeing single-aisle
  B733: [N, 33.4, 28.9, 11.1],
  B734: [N, 36.4, 28.9, 11.1],
  B735: [N, 31.0, 28.9, 11.1],
  B736: [N, 31.2, 34.3, 12.5],
  B737: [N, 33.6, 34.3, 12.5],
  B738: [N, 39.5, 35.8, 12.5],
  B739: [N, 42.1, 35.8, 12.5],
  B37M: [N, 35.6, 35.9, 12.3],
  B38M: [N, 39.5, 35.9, 12.3],
  B39M: [N, 42.2, 35.9, 12.3],
  B3XM: [N, 43.8, 35.9, 12.3],
  B752: [N, 47.3, 38.0, 13.6],
  B753: [N, 54.5, 38.0, 13.6],
  // Regional jets with engines under the wing
  E170: [N, 29.9, 26.0, 9.9],
  E175: [N, 31.7, 26.0, 9.9],
  E190: [N, 36.2, 28.7, 10.6],
  E195: [N, 38.7, 28.7, 10.6],
  E290: [N, 36.2, 33.7, 10.9],
  E295: [N, 41.5, 35.1, 10.9],
  BCS1: [N, 35.0, 35.1, 11.5],
  BCS3: [N, 38.7, 35.1, 11.5],
  RJ85: [N, 28.6, 26.3, 8.6],
  RJ1H: [N, 31.0, 26.3, 8.6],
  SU95: [N, 29.9, 27.8, 10.3],
  // Regional jets and airliners with engines on the tail
  CRJ2: [B, 26.8, 21.2, 6.2],
  CRJ7: [B, 32.5, 23.2, 7.6],
  CRJ9: [B, 36.2, 24.9, 7.5],
  CRJX: [B, 39.1, 26.2, 7.5],
  F70: [B, 30.9, 28.1, 8.5],
  F100: [B, 35.5, 28.1, 8.5],
  B712: [B, 37.8, 28.4, 8.9],
  MD82: [B, 45.1, 32.9, 9.0],
  MD83: [B, 45.1, 32.9, 9.0],
  MD88: [B, 45.1, 32.9, 9.0],
  // Twin-aisle
  A306: [W, 54.1, 44.8, 16.5],
  A310: [W, 46.7, 43.9, 15.8],
  A332: [W, 58.8, 60.3, 17.4],
  A333: [W, 63.7, 60.3, 16.8],
  A338: [W, 58.4, 64.0, 17.4],
  A339: [W, 63.7, 64.0, 16.8],
  A343: [W, 63.7, 60.3, 16.9],
  A346: [W, 75.4, 63.5, 17.3],
  A359: [W, 66.8, 64.8, 17.1],
  A35K: [W, 73.8, 64.8, 17.1],
  B762: [W, 48.5, 47.6, 15.8],
  B763: [W, 54.9, 47.6, 15.8],
  B764: [W, 61.4, 51.9, 16.8],
  B772: [W, 63.7, 60.9, 18.5],
  B773: [W, 73.9, 60.9, 18.5],
  B77L: [W, 63.7, 64.8, 18.6],
  B77W: [W, 73.9, 64.8, 18.5],
  B788: [W, 56.7, 60.1, 16.9],
  B789: [W, 62.8, 60.1, 17.0],
  B78X: [W, 68.3, 60.1, 17.0],
  MD11: [W, 61.2, 51.7, 17.6],
  C17: [W, 53.0, 51.7, 16.8],
  // The four-engined double-deckers and their kin
  A388: [J, 72.7, 79.8, 24.1],
  B742: [J, 70.7, 59.6, 19.3],
  B743: [J, 70.7, 59.6, 19.3],
  B744: [J, 70.7, 64.4, 19.4],
  B748: [J, 76.3, 68.4, 19.4],
  A124: [J, 69.1, 73.3, 21.1],
  // Turboprops
  AT43: [T, 22.7, 24.6, 7.6],
  AT45: [T, 22.7, 24.6, 7.6],
  AT46: [T, 22.7, 24.6, 7.6],
  AT72: [T, 27.2, 27.1, 7.7],
  AT75: [T, 27.2, 27.1, 7.7],
  AT76: [T, 27.2, 27.1, 7.7],
  DH8A: [T, 22.3, 25.9, 7.5],
  DH8B: [T, 22.3, 25.9, 7.5],
  DH8C: [T, 25.7, 27.4, 7.5],
  DH8D: [T, 32.8, 28.4, 8.3],
  SF34: [T, 19.7, 21.4, 6.9],
  D328: [T, 21.3, 21.0, 7.2],
  JS41: [T, 19.3, 18.3, 5.7],
  B190: [T, 17.6, 17.7, 4.7],
  BE20: [T, 13.4, 16.6, 4.6],
  B350: [T, 14.2, 17.7, 4.4],
  A400: [T, 45.1, 42.4, 14.7],
  C130: [T, 29.8, 40.4, 11.7],
  C30J: [T, 29.8, 40.4, 11.7],
  C160: [T, 32.4, 40.0, 11.7],
  // Business jets
  C25A: [B, 14.5, 15.2, 4.3],
  C25B: [B, 15.6, 16.3, 4.5],
  C25C: [B, 16.3, 16.3, 4.6],
  C25M: [B, 16.3, 16.3, 4.6],
  C510: [B, 9.4, 13.2, 4.1],
  C525: [B, 12.9, 14.3, 4.2],
  C550: [B, 14.4, 15.8, 4.6],
  C560: [B, 14.9, 16.3, 4.6],
  C56X: [B, 15.8, 17.2, 5.2],
  C680: [B, 19.4, 19.2, 6.2],
  C68A: [B, 20.9, 22.0, 6.5],
  C700: [B, 22.4, 21.9, 6.0],
  C750: [B, 22.0, 19.4, 5.8],
  CL30: [B, 20.9, 19.5, 6.2],
  CL35: [B, 20.9, 19.5, 6.2],
  CL60: [B, 20.9, 19.6, 6.3],
  GLF4: [B, 26.9, 23.7, 7.4],
  GLF5: [B, 29.4, 28.5, 7.9],
  GLF6: [B, 30.4, 30.4, 7.8],
  GL5T: [B, 29.5, 28.7, 7.7],
  GL7T: [B, 33.8, 31.7, 8.2],
  GLEX: [B, 30.3, 28.7, 7.7],
  F2TH: [B, 20.2, 21.4, 7.1],
  FA7X: [B, 23.4, 26.2, 7.9],
  FA8X: [B, 24.5, 26.3, 7.9],
  F900: [B, 20.2, 19.3, 7.5],
  FA50: [B, 18.5, 18.9, 6.9],
  LJ35: [B, 14.8, 12.0, 3.7],
  LJ45: [B, 17.7, 14.6, 4.3],
  LJ60: [B, 17.9, 13.4, 4.4],
  LJ75: [B, 17.7, 15.6, 4.3],
  E35L: [B, 26.3, 21.2, 6.7],
  E545: [B, 20.7, 20.3, 6.4],
  E550: [B, 20.7, 20.3, 6.4],
  E50P: [B, 12.8, 12.3, 4.4],
  E55P: [B, 15.9, 16.2, 4.8],
  PC24: [B, 16.9, 17.0, 5.4],
  HDJT: [B, 13.0, 12.1, 4.5],
  PRM1: [B, 14.1, 13.6, 4.7],
  BE40: [B, 14.8, 13.3, 4.2],
  H25B: [B, 15.6, 15.7, 5.4],
  ASTR: [B, 16.9, 16.6, 5.5],
  // Fighters and trainers: the tail-engined body is the nearest thing
  EUFI: [B, 15.9, 10.9, 5.3],
  F16: [B, 15.0, 9.5, 5.0],
  F35: [B, 15.7, 10.7, 4.4],
  TORN: [B, 16.7, 13.9, 5.9],
  // Light aircraft
  C150: [L, 7.3, 10.2, 2.6],
  C152: [L, 7.3, 10.2, 2.6],
  C172: [L, 8.3, 11.0, 2.7],
  C72R: [L, 8.3, 11.0, 2.7],
  C177: [L, 8.4, 10.8, 2.6],
  C182: [L, 8.8, 11.0, 2.8],
  C206: [L, 8.6, 11.0, 2.8],
  C208: [L, 12.7, 15.9, 4.7],
  C210: [L, 8.6, 11.2, 3.0],
  P28A: [L, 7.3, 9.0, 2.2],
  P28B: [L, 7.3, 9.0, 2.2],
  P28R: [L, 7.5, 9.0, 2.4],
  P28T: [L, 7.5, 9.0, 2.4],
  PA34: [L, 8.7, 11.9, 3.0],
  PA46: [L, 9.0, 13.1, 3.4],
  PA31: [L, 9.9, 12.4, 4.0],
  SR20: [L, 7.9, 11.7, 2.7],
  SR22: [L, 7.9, 11.7, 2.7],
  S22T: [L, 7.9, 11.7, 2.7],
  DA40: [L, 8.1, 11.9, 2.0],
  DA42: [L, 8.6, 13.4, 2.5],
  DA62: [L, 9.2, 14.6, 2.8],
  DV20: [L, 7.3, 10.9, 2.2],
  A210: [L, 7.3, 10.3, 2.4],
  BE33: [L, 8.4, 10.2, 2.5],
  BE35: [L, 8.4, 10.2, 2.3],
  BE36: [L, 8.4, 10.2, 2.6],
  BE58: [L, 9.1, 11.5, 3.0],
  M20P: [L, 8.1, 11.0, 2.5],
  M20T: [L, 8.1, 11.0, 2.5],
  PC12: [L, 14.4, 16.3, 4.3],
  TBM7: [L, 10.6, 12.7, 4.4],
  TBM8: [L, 10.6, 12.7, 4.4],
  TBM9: [L, 10.7, 12.7, 4.4],
  EV97: [L, 6.0, 8.1, 2.3],
  CTLS: [L, 6.6, 8.6, 2.3],
  // Helicopters – the length is the fuselage's, nose to tail rotor
  EC35: [H, 10.2, 10.2, 3.5],
  EC45: [H, 11.2, 11.0, 3.9],
  EC55: [H, 12.0, 12.6, 4.1],
  EC30: [H, 10.0, 10.7, 3.3],
  EC20: [H, 9.8, 10.7, 3.3],
  EC25: [H, 16.8, 16.2, 4.6],
  EC75: [H, 15.6, 14.8, 5.3],
  H160: [H, 12.6, 12.0, 4.1],
  AS50: [H, 10.9, 10.7, 3.3],
  AS55: [H, 10.9, 10.7, 3.3],
  AS65: [H, 11.6, 11.9, 4.0],
  A109: [H, 11.4, 11.0, 3.5],
  A139: [H, 13.5, 13.8, 5.0],
  A169: [H, 12.4, 12.1, 4.5],
  B06: [H, 9.5, 10.2, 3.0],
  B407: [H, 10.6, 10.7, 3.3],
  B412: [H, 12.9, 14.0, 4.6],
  B429: [H, 11.3, 11.0, 4.0],
  B505: [H, 10.5, 11.3, 3.4],
  R22: [H, 6.3, 7.7, 2.7],
  R44: [H, 9.1, 10.1, 3.3],
  R66: [H, 9.1, 10.1, 3.5],
  S76: [H, 13.2, 13.4, 4.4],
  S92: [H, 17.3, 17.2, 6.5],
  H60: [H, 15.3, 16.4, 5.1],
  UH1: [H, 12.8, 14.6, 4.4],
  CH47: [H, 15.9, 18.3, 5.7],
  NH90: [H, 16.1, 16.3, 5.4],
  EH10: [H, 19.5, 18.6, 6.6],
}

/**
 * The body and size for an aircraft: its type where the table knows
 * it, else its emitter category's archetype at that archetype's own
 * size – A3 "large" is a narrow-body, A5 "heavy" a wide-body, A7 a
 * rotorcraft, A1 and the B categories (gliders, balloons, ultralights,
 * drones) a light aircraft. Without either, a callsign of an airline's
 * shape (three letters and a flight number) makes it a narrow-body, and
 * anything else a light aircraft.
 */
export function aircraftSize(typeCode: string, category: string, callsign = ''): AircraftSize {
  const row = TYPES[typeCode.toUpperCase()]
  if (row) return { archetype: row[0], lengthM: row[1], spanM: row[2], heightM: row[3] }
  const archetype = archetypeForCategory(category, callsign)
  return { archetype, ...ARCHETYPE_SIZE[archetype] }
}

function archetypeForCategory(category: string, callsign: string): AircraftArchetype {
  switch (category.toUpperCase()) {
    case 'A1':
      return 'aircraft-light'
    case 'A2':
      return 'aircraft-turboprop'
    case 'A3':
    case 'A4':
      return 'aircraft-narrowbody'
    case 'A5':
      return 'aircraft-widebody'
    case 'A6':
      return 'aircraft-bizjet'
    case 'A7':
      return 'aircraft-helicopter'
  }
  if (category.startsWith('B')) return 'aircraft-light'
  return /^[A-Z]{3}[0-9]/.test(callsign) ? 'aircraft-narrowbody' : 'aircraft-light'
}

/** Callsign, else the registration, else the address – the name on the plate and the card. */
export function aircraftTitle(aircraft: Aircraft): string {
  return aircraft.callsign || aircraft.registration || aircraft.hex.toUpperCase()
}

/**
 * The type as the card names it: the feed's description where it has
 * one ("AIRBUS A-320-214"), the bare designator otherwise, and the
 * translated "type unknown" for an aircraft that reports neither.
 */
export function aircraftTypeLabel(aircraft: Aircraft): string {
  return aircraft.description || aircraft.typeCode || t('aircraft.typeUnknown')
}

/** Whole metres with a thin-space thousands separator, as the card writes heights. */
function metres(value: number): string {
  return `${Math.round(value).toLocaleString('en-US').replace(/,/g, ' ')} m`
}

/**
 * "11 280 m · FL370" – the geometric altitude as the map draws it,
 * with the flight level, which is the pressure altitude in hundreds of
 * feet and the number the crew and the controller use. On the ground
 * the card says so instead of showing zero metres.
 */
export function formatAltitude(aircraft: Aircraft): string {
  if (aircraft.onGround) return t('aircraft.onGround')
  const altM = aircraft.altGeomM ?? aircraft.altBaroM
  if (altM === null) return t('aircraft.notReported')
  const parts = [metres(altM)]
  if (aircraft.altBaroM !== null && aircraft.altBaroM >= 1500) {
    parts.push(`FL${String(Math.round(aircraft.altBaroM / 0.3048 / 100)).padStart(3, '0')}`)
  }
  return parts.join(' · ')
}

/** "457 kn · 846 km/h" – ground speed in the unit aviation uses, and the one the reader does. */
export function formatGroundSpeed(gsKn: number | null): string {
  const kn = gsKn ?? null
  if (kn === null) return t('aircraft.notReported')
  if (kn < 1) return '0 kn'
  return `${Math.round(kn)} kn · ${Math.round(kn * 1.852)} km/h`
}

/**
 * "+5.2 m/s" climbing, "−3.0 m/s" descending, "level" within half a
 * metre a second of it – the sign is the news, the number the size.
 */
export function formatVerticalRate(rateMps: number | null): string {
  const rate = rateMps ?? null
  if (rate === null) return t('aircraft.notReported')
  if (Math.abs(rate) < 0.5) return t('aircraft.level')
  return `${rate > 0 ? '+' : '−'}${Math.abs(rate).toFixed(1)} m/s`
}
