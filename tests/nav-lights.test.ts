import { describe, expect, it } from 'vitest'
import {
  BEACON_ON_MS,
  BEACON_PERIOD_MS,
  STROBE_ON_MS,
  STROBE_PERIOD_MS,
  VESSEL_SIDELIGHT_ARC_DEG,
  aircraftLightsMode,
  beaconOn,
  flashOn,
  lightPhaseMs,
  portLightSeen,
  starboardLightSeen,
  sternLightSeen,
  strobeOn,
  vesselLightsMode,
  viewBearingDeg,
} from '@/lib/nav-lights'

/**
 * The clockwork of the navigation lights (src/lib/nav-lights.ts): what
 * flashes when, from the clock alone, and which lights an aircraft or a
 * ship shows in which state.
 */

describe('the flashes', () => {
  it('are on for their share of every period and off for the rest', () => {
    expect(flashOn(0, 1000, 100)).toBe(true)
    expect(flashOn(99, 1000, 100)).toBe(true)
    expect(flashOn(100, 1000, 100)).toBe(false)
    expect(flashOn(999, 1000, 100)).toBe(false)
    expect(flashOn(1000, 1000, 100)).toBe(true)
    // A phase shifts the flash; a negative instant still lands in the period
    expect(flashOn(0, 1000, 100, 500)).toBe(false)
    expect(flashOn(500, 1000, 100, 500)).toBe(true)
    expect(flashOn(-950, 1000, 100)).toBe(true)
  })

  it('come from the clock alone: any instant gives the same answer however it is reached', () => {
    const t = 1_800_000_000_000 + 12_345
    expect(beaconOn(t, 0)).toBe(beaconOn(t, 0))
    expect(strobeOn(t, 7)).toBe(strobeOn(t, 7))
    // The beacon flashes about once a second, briefly; the strobe less often
    let beaconFlashes = 0
    let strobeFlashes = 0
    for (let ms = 0; ms < 60_000; ms++) {
      if (beaconOn(ms, 0) && !beaconOn(ms - 1, 0)) beaconFlashes++
      if (strobeOn(ms, 0) && !strobeOn(ms - 1, 0)) strobeFlashes++
    }
    expect(beaconFlashes).toBe(60_000 / BEACON_PERIOD_MS)
    expect(strobeFlashes).toBe(Math.floor(60_000 / STROBE_PERIOD_MS) + 1)
    expect(BEACON_ON_MS).toBeGreaterThan(100) // caught by a 100 ms tick
    expect(STROBE_ON_MS).toBeGreaterThan(100)
  })

  it('flashes the lower beacon half a period after the upper one', () => {
    expect(beaconOn(0, 0)).toBe(true)
    expect(beaconOn(0, 0, true)).toBe(false)
    expect(beaconOn(BEACON_PERIOD_MS / 2, 0, true)).toBe(true)
  })

  it('spreads the aircraft over the period by their addresses', () => {
    const phases = ['3c65a2', '3d2f0c', 'ae087f', '4ca7b3', '406a1f'].map(lightPhaseMs)
    expect(new Set(phases.map((p) => p % BEACON_PERIOD_MS)).size).toBeGreaterThan(3)
    expect(lightPhaseMs('3c65a2')).toBe(lightPhaseMs('3c65a2'))
  })
})

describe('what an aircraft shows', () => {
  it('is everything in the air, no strobes taxiing, nothing parked', () => {
    expect(aircraftLightsMode(false, true)).toBe('flight')
    expect(aircraftLightsMode(false, false)).toBe('flight')
    expect(aircraftLightsMode(true, true)).toBe('taxi')
    expect(aircraftLightsMode(true, false)).toBe('off')
  })
})

describe('what a ship shows', () => {
  it('is the running lights whenever she moves, whatever her status says', () => {
    // The status is set by hand and often stale: a ro-ro came down the
    // Elbe at twelve knots calling herself moored
    expect(vesselLightsMode(5, true)).toBe('underway')
    expect(vesselLightsMode(1, true)).toBe('underway')
    expect(vesselLightsMode(null, true)).toBe('underway') // Class B: no status
    expect(vesselLightsMode(15, true)).toBe('underway') // undefined status
  })

  it('is the anchor light lying still at anchor, and nothing else lying still', () => {
    expect(vesselLightsMode(1, false)).toBe('anchor')
    // "Under way using engine" at zero speed is a tug at its station, a
    // pilot boat at its berth – 139 of them in Hamburg against 40 that
    // moved – not a ship holding position in the fairway
    expect(vesselLightsMode(0, false)).toBe('off')
    expect(vesselLightsMode(3, false)).toBe('off')
    expect(vesselLightsMode(5, false)).toBe('off') // moored
    expect(vesselLightsMode(6, false)).toBe('off') // aground
    expect(vesselLightsMode(null, false)).toBe('off')
    expect(vesselLightsMode(15, false)).toBe('off')
  })
})

describe('the screened lights', () => {
  const arc = VESSEL_SIDELIGHT_ARC_DEG

  it('reads the viewer’s bearing off the bow, positive to port', () => {
    expect(viewBearingDeg(1, 0)).toBe(0)
    expect(viewBearingDeg(0, 1)).toBe(90)
    expect(viewBearingDeg(0, -1)).toBe(-90)
    expect(Math.abs(viewBearingDeg(-1, 0))).toBe(180)
  })

  it('shows each light over its own arc: both from ahead, one abeam, only the stern light from astern', () => {
    expect(portLightSeen(0, arc)).toBe(true)
    expect(starboardLightSeen(0, arc)).toBe(true)
    expect(portLightSeen(90, arc)).toBe(true)
    expect(starboardLightSeen(90, arc)).toBe(false)
    expect(portLightSeen(-90, arc)).toBe(false)
    expect(starboardLightSeen(-90, arc)).toBe(true)
    // 22.5° abaft the beam the sidelights end and the stern light begins
    expect(portLightSeen(112, arc)).toBe(true)
    expect(portLightSeen(113, arc)).toBe(false)
    expect(sternLightSeen(113, arc)).toBe(true)
    expect(sternLightSeen(180, arc)).toBe(true)
    expect(sternLightSeen(90, arc)).toBe(false)
    expect(sternLightSeen(0, arc)).toBe(false)
  })
})
