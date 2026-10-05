/**
 * The clockwork of the navigation lights (see map/NavLights.ts for what
 * draws them): which of an aircraft's or a ship's lights are on at one
 * instant, from the clock alone. Nothing here remembers a previous
 * frame – a flash is on or off by where the instant falls in its
 * period, so any frame is right whatever the last one was, a pause
 * holds every flash where it is, and a replay flashes as the recording's
 * clock says (the rule every animated effect on this map follows, see
 * CLAUDE.md). Pure, so it is tested without a scene.
 *
 * What flashes and what does not is aviation's and the sea's own:
 *
 * - An aircraft carries a red light on the left wing tip and a green one
 *   on the right, steady, and a white one at the tail – the position
 *   lights, which say which way it is going. On top of and under the
 *   fuselage a red anti-collision beacon flashes about once a second
 *   whenever an engine runs, and white strobes at the wing tips flash
 *   brighter and less often in flight. On the ground with the engines
 *   off it shows nothing.
 * - A ship under way at night shows a red sidelight to port and a green
 *   one to starboard, a white masthead light forward and a white stern
 *   light aft, all steady; at anchor a white all-round light and nothing
 *   else; lying at her berth, none of them. By day, none at all.
 * - The sidelights, the tail and the stern light are screened: each
 *   shows over its own arc and no further, which is how a sailor reads a
 *   ship's course off her lights at night – red and green together mean
 *   she is coming straight at you. The arcs below are the real ones.
 */

/** The anti-collision beacon: about once a second, briefly. */
export const BEACON_PERIOD_MS = 1200
export const BEACON_ON_MS = 160
/** The wing-tip strobes: less often, and a bright short flash. */
export const STROBE_PERIOD_MS = 1600
export const STROBE_ON_MS = 120

/**
 * A per-thing offset into every period, from its id – so a sky full of
 * aircraft does not flash in step, which no sky does. Any stable id will
 * do; the spread is what matters, not the hash.
 */
export function lightPhaseMs(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return hash % 100_000
}

/** Whether a light flashing `onMs` of every `periodMs` is on at `nowMs`, offset by `phaseMs`. */
export function flashOn(nowMs: number, periodMs: number, onMs: number, phaseMs = 0): boolean {
  const t = (((nowMs + phaseMs) % periodMs) + periodMs) % periodMs
  return t < onMs
}

/** The anti-collision beacon's state at an instant. The lower beacon flashes half a period after the upper one. */
export function beaconOn(nowMs: number, phaseMs: number, lower = false): boolean {
  return flashOn(nowMs, BEACON_PERIOD_MS, BEACON_ON_MS, phaseMs + (lower ? BEACON_PERIOD_MS / 2 : 0))
}

/** The wing-tip strobes' state at an instant. */
export function strobeOn(nowMs: number, phaseMs: number): boolean {
  return flashOn(nowMs, STROBE_PERIOD_MS, STROBE_ON_MS, phaseMs)
}

/**
 * The arcs the screened lights show over, in degrees: a ship's
 * sidelights from dead ahead to 22.5° abaft the beam (112.5° each), her
 * stern light the 135° left over and her masthead light the 225° ahead;
 * an aircraft's position lights 110° each and its tail light the 140°
 * astern. A beacon, a strobe and an anchor light show all round.
 */
export const VESSEL_SIDELIGHT_ARC_DEG = 112.5
export const AIRCRAFT_SIDELIGHT_ARC_DEG = 110
/** A hair of overlap at the bow, so both sidelights show from dead ahead as they do at sea. */
const BOW_OVERLAP_DEG = 2

/**
 * The bearing the viewer stands on, off the bow, from the viewer's
 * direction resolved along the thing's forward and port axes – positive
 * to port, 180° dead astern.
 */
export function viewBearingDeg(forwardDot: number, portDot: number): number {
  return (Math.atan2(portDot, forwardDot) * 180) / Math.PI
}

/** Whether the port (red) light is seen from `bearingDeg` – its arc runs from the bow round to port. */
export function portLightSeen(bearingDeg: number, arcDeg: number): boolean {
  return bearingDeg >= -BOW_OVERLAP_DEG && bearingDeg <= arcDeg
}

/** The starboard (green) light's mirror image. */
export function starboardLightSeen(bearingDeg: number, arcDeg: number): boolean {
  return bearingDeg <= BOW_OVERLAP_DEG && bearingDeg >= -arcDeg
}

/** The stern light fills what the sidelights leave: seen from abaft their arcs. */
export function sternLightSeen(bearingDeg: number, sidelightArcDeg: number): boolean {
  return Math.abs(bearingDeg) >= sidelightArcDeg
}

/**
 * What an aircraft shows: nothing parked with the engines off (on the
 * ground, not moving – the feed says nothing about engines, and a
 * transponder at the gate is usually an aircraft being readied with its
 * lights still off), position lights and the beacon taxiing, strobes
 * as well in the air.
 */
export function aircraftLightsMode(onGround: boolean, moving: boolean): 'off' | 'taxi' | 'flight' {
  if (!onGround) return 'flight'
  return moving ? 'taxi' : 'off'
}

/**
 * What a ship shows: the running lights when she moves, the anchor
 * light lying still with her status at anchor (1), nothing otherwise.
 * Her motion is the one thing decided here, because the navigational
 * status is set by hand on the bridge and left as it was in either
 * direction – the GRANDE INGHILTERRA came down the Elbe at twelve knots
 * calling herself moored, and 139 of Hamburg's ships called themselves
 * under way while lying at their berths, against 40 that moved. A
 * ship truly stopped in the fairway under engine goes
 * dark for this; that is the rarer picture by far.
 */
export function vesselLightsMode(navStatus: number | null, underWay: boolean): 'off' | 'underway' | 'anchor' {
  if (underWay) return 'underway'
  return navStatus === 1 ? 'anchor' : 'off'
}
