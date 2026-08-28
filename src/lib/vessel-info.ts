/**
 * Turning a vessel's raw AIS numbers into the words the vessel card shows:
 * the ship type code and the navigational status. Both are ITU-R M.1371
 * enumerations, so the mapping is fixed by the standard rather than by
 * taste – see src/map/VesselLayer.ts for the hull that the same type code
 * picks.
 */

import type { AisVessel } from '@/lib/ais-extract'
import { t, type MessageKey } from '@/lib/i18n'

/**
 * AIS ship type → label key. The first digit is the group, the second a
 * cargo hint we ignore (nobody needs "Cargo ship, hazardous category B" on
 * a city map). The 3x group is the exception: it is not a group at all but
 * a list of individual special craft.
 */
export function vesselTypeKey(typeCode: number): MessageKey | null {
  if (!Number.isFinite(typeCode) || typeCode <= 0) return null
  switch (typeCode) {
    case 30:
      return 'vesselType.fishing'
    case 31:
    case 32:
      return 'vesselType.towing'
    case 33:
      return 'vesselType.dredger'
    case 34:
      return 'vesselType.diving'
    case 35:
      return 'vesselType.military'
    case 36:
      return 'vesselType.sailing'
    case 37:
      return 'vesselType.pleasure'
  }
  switch (Math.floor(typeCode / 10)) {
    case 4:
      return 'vesselType.highSpeed'
    case 5:
      // 5x is a grab bag of service craft; the ones a harbor actually shows
      // are worth naming, the rest share the group's label.
      if (typeCode === 50) return 'vesselType.pilot'
      if (typeCode === 51) return 'vesselType.searchRescue'
      if (typeCode === 53) return 'vesselType.portTender'
      if (typeCode === 54) return 'vesselType.antiPollution'
      if (typeCode === 55) return 'vesselType.lawEnforcement'
      if (typeCode === 58) return 'vesselType.medical'
      return 'vesselType.tug'
    case 6:
      return 'vesselType.passenger'
    case 7:
      return 'vesselType.cargo'
    case 8:
      return 'vesselType.tanker'
    case 9:
      return 'vesselType.other'
  }
  return null
}

/**
 * Navigational status → label key. 9, 10 and 13 are reserved and 14 is the
 * SART/MOB beacon; anything outside the table reads as unknown rather than
 * as a wrong guess.
 */
export function navStatusKey(navStatus: number | null): MessageKey | null {
  if (navStatus === null) return null
  const known = [0, 1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15]
  return known.includes(navStatus) ? (`navStatus.${navStatus}` as MessageKey) : null
}

/** Ship name, or the MMSI when no static report has named her yet. */
export function vesselTitle(vessel: AisVessel): string {
  return vessel.name || String(vessel.mmsi)
}

/** "52 × 12 m", or null when no static report carried the dimensions. */
export function formatDimensions(vessel: AisVessel): string | null {
  if (vessel.lengthM === null && vessel.widthM === null) return null
  const length = vessel.lengthM === null ? '?' : String(Math.round(vessel.lengthM))
  const width = vessel.widthM === null ? '?' : String(Math.round(vessel.widthM))
  return `${length} × ${width} m`
}

/**
 * Speed in knots, one decimal. Below 0.2 kn a ship is not "moving slowly",
 * she is lying still, and the card says so rather than showing 0.1 kn of
 * GPS noise.
 */
export function formatSpeed(sogKn: number | null): string {
  if (sogKn === null) return t('vessel.notReported')
  if (sogKn < 0.2) return '0 kn'
  return `${sogKn.toFixed(1)} kn`
}

/**
 * How stale the shown position is, in the reader's terms. The fleet plays
 * back four minutes late by design (see AIS_PLAYBACK_DELAY_MS), so this is
 * the age of the DATA, not a fault – it is here to explain a ship that
 * sits still because nothing new has come in for her.
 */
export function formatFixAge(positionAt: number, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - positionAt) / 1000))
  return seconds < 90
    ? t('vessel.fixAge', { count: seconds })
    : t('vessel.fixAgeMin', { count: Math.round(seconds / 60) })
}
