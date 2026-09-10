/**
 * The front door: whether the welcome screen – the city chooser that
 * covers the map when the site is opened (see components/WelcomeScreen)
 * – goes up for this visit, and the one preference it keeps.
 *
 * It opens on a plain visit and stays away for a link that already says
 * where to go. Every hash the app writes names its city, and a hash with
 * a place in it – a city, a camera pose, a vehicle, a ship, a stop – is
 * a link someone shared or a session reloaded; whoever opens it wants
 * what it points at, not a question first. The checkbox on the screen
 * turns it off for good in this browser (WELCOME_STORAGE_KEY); the app
 * then opens straight on the default city. `?welcome=1` brings the
 * screen back regardless, `?welcome=0` keeps it away for one visit –
 * the tests open the app that way, since the screen would otherwise
 * stand between them and the map.
 *
 * Pure in its decision, so it is tested without a window; the storage
 * comes in as an argument for the same reason.
 */

import { parseCameraHash, parseStopHash, parseUiStateHash, parseVehicleHash, parseVesselHash } from './camera-hash'

/** Where the wish not to see the screen again is kept. */
export const WELCOME_STORAGE_KEY = 'mg3d.welcome'

/** What the key holds once the reader asked not to see the screen again. */
const HIDDEN = 'hidden'

/** As much of Storage as this module reads and writes. */
export type WelcomeStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The browser's localStorage, or null where reaching it throws (private mode, blocked storage). */
export function browserStorage(): WelcomeStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Whether a hash points somewhere – a city, a pose or a thing to select. */
function hashNamesPlace(hash: string): boolean {
  return (
    parseUiStateHash(hash).city !== null ||
    parseCameraHash(hash) !== null ||
    parseVehicleHash(hash) !== null ||
    parseVesselHash(hash) !== null ||
    parseStopHash(hash) !== null
  )
}

/** Whether this browser was asked not to show the screen again. */
export function welcomeHidden(storage: WelcomeStorage | null): boolean {
  try {
    return storage?.getItem(WELCOME_STORAGE_KEY) === HIDDEN
  } catch {
    return false
  }
}

/** Keeps – or drops – the wish not to see the screen again. */
export function setWelcomeHidden(storage: WelcomeStorage | null, hidden: boolean): void {
  try {
    if (hidden) storage?.setItem(WELCOME_STORAGE_KEY, HIDDEN)
    else storage?.removeItem(WELCOME_STORAGE_KEY)
  } catch {
    // A preference that cannot be kept is no harm: the screen comes back.
  }
}

/**
 * Whether the welcome screen opens for this visit, from the URL's search
 * and hash and what the browser kept: `?welcome=0` never, `?welcome=1`
 * always, a link that names a place no, and otherwise unless the reader
 * asked not to see it again.
 */
export function welcomeWanted(search: string, hash: string, storage: WelcomeStorage | null): boolean {
  const asked = new URLSearchParams(search).get('welcome')
  if (asked === '0') return false
  if (asked === '1') return true
  if (hashNamesPlace(hash)) return false
  return !welcomeHidden(storage)
}
