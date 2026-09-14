import { describe, expect, it } from 'vitest'
import {
  ORBIT_BUTTON_PX,
  ORBIT_GAP_PX,
  ORBIT_GLOBE_PX,
  ORBIT_RADIUS_PX,
  ORBIT_RING_PX,
  ORBIT_SLOTS,
  orbitLayout,
} from '@/lib/rail-orbit'

/**
 * The control rail's arc (lib/rail-orbit.ts): the buttons around the
 * globe touch neither it nor each other, and the box holds them all.
 */

describe("the rail's orbit", () => {
  const layout = orbitLayout()
  const centre = (place: { left: number; top: number }, size: number) => ({
    x: place.left + size / 2,
    y: place.top + size / 2,
  })
  const globe = centre(layout.globe, ORBIT_GLOBE_PX)

  it('keeps every button clear of the globe and of its neighbours', () => {
    const slots = Object.keys(ORBIT_SLOTS) as (keyof typeof ORBIT_SLOTS)[]
    for (const slot of slots) {
      const c = centre(layout.slots[slot], ORBIT_BUTTON_PX)
      const fromGlobe = Math.hypot(c.x - globe.x, c.y - globe.y)
      // The buttons stand on the ring; the globe inside it is the smaller
      expect(fromGlobe).toBeGreaterThanOrEqual(ORBIT_RING_PX / 2 + ORBIT_BUTTON_PX / 2 + ORBIT_GAP_PX - 0.1)
      expect(fromGlobe).toBeGreaterThan(ORBIT_GLOBE_PX / 2 + ORBIT_BUTTON_PX / 2 + ORBIT_GAP_PX)
      for (const other of slots) {
        if (other === slot) continue
        const o = centre(layout.slots[other], ORBIT_BUTTON_PX)
        expect(Math.hypot(c.x - o.x, c.y - o.y), `${slot} against ${other}`).toBeGreaterThan(ORBIT_BUTTON_PX + 4)
      }
    }
  })

  it('fits the globe and every slot into its box, with nothing hanging out', () => {
    expect(layout.globe.left).toBeGreaterThanOrEqual(0)
    expect(layout.globe.top).toBeGreaterThanOrEqual(0)
    expect(layout.globe.left + ORBIT_GLOBE_PX).toBeLessThanOrEqual(layout.width)
    expect(layout.globe.top + ORBIT_GLOBE_PX).toBeLessThanOrEqual(layout.height)
    for (const place of Object.values(layout.slots)) {
      expect(place.left).toBeGreaterThanOrEqual(0)
      expect(place.top).toBeGreaterThanOrEqual(0)
      expect(place.left + ORBIT_BUTTON_PX).toBeLessThanOrEqual(layout.width)
      expect(place.top + ORBIT_BUTTON_PX).toBeLessThanOrEqual(layout.height)
    }
    // The globe sits in the middle of the ring the buttons stand on: every
    // button is the ring's radius away from its centre
    for (const place of Object.values(layout.slots)) {
      const c = centre(place, ORBIT_BUTTON_PX)
      expect(Math.hypot(c.x - globe.x, c.y - globe.y)).toBeCloseTo(ORBIT_RADIUS_PX, 0)
    }
    // The 2D/3D switch stands over the globe, a little left of its axis; the About button at the lower left
    expect(centre(layout.slots.tilt, ORBIT_BUTTON_PX).y).toBeLessThan(globe.y - ORBIT_GLOBE_PX / 2)
    expect(Math.abs(centre(layout.slots.tilt, ORBIT_BUTTON_PX).x - globe.x)).toBeLessThan(20)
    expect(centre(layout.slots.about, ORBIT_BUTTON_PX).y).toBeGreaterThan(globe.y)
    expect(centre(layout.slots.about, ORBIT_BUTTON_PX).x).toBeLessThan(globe.x)
    // A rail no wider than a card's slot deserves: under 200 px either way
    expect(layout.width).toBeLessThan(200)
    expect(layout.height).toBeLessThan(200)
  })
})
