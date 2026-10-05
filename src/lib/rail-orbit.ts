/**
 * The geometry of the map's control rail on a desktop: a large round
 * globe – the ground switch, see MapRail in App.tsx – with the small
 * round buttons standing on an arc around it, from the lower left over
 * the top to the upper right, the way a hand rests a thumb on a dial.
 * Pure numbers, so a test can prove that nothing overlaps.
 */

/**
 * The ring the buttons stand around, and the globe drawn inside it:
 * the buttons were placed for a 92 px globe and stay there, the globe
 * itself is 84 px (Tailwind's size-21 – 100 and 92 were tried and found
 * large), so it has 4 px more air on every side than the
 * gap alone gives. The buttons' diameter is size-9.
 */
export const ORBIT_RING_PX = 92
export const ORBIT_GLOBE_PX = 84
export const ORBIT_BUTTON_PX = 36
export const ORBIT_GAP_PX = 8
/** Distance from the globe's centre to every button's centre. */
export const ORBIT_RADIUS_PX = ORBIT_RING_PX / 2 + ORBIT_GAP_PX + ORBIT_BUTTON_PX / 2

/**
 * Where each button stands, in degrees counter-clockwise from the
 * right, as on a compass rose laid flat: the About button at the lower
 * left, the layers and the photo mode on the left, the compass at the
 * upper left, the 2D/3D switch on top, the camera reset and full screen
 * on the right – 35° apart, ten pixels between neighbours. A button that is not offered (full screen where the
 * browser has none) leaves its place empty rather than moving the rest.
 */
export const ORBIT_SLOTS = {
  about: 240,
  layers: 205,
  photo: 170,
  compass: 135,
  tilt: 100,
  home: 65,
  fullscreen: 30,
} as const

export type OrbitSlot = keyof typeof ORBIT_SLOTS

export interface OrbitPlace {
  /** The element's top-left corner, in CSS px from the rail's own. */
  left: number
  top: number
}

export interface OrbitLayout {
  /** The rail's size – the box that holds the globe and every slot. */
  width: number
  height: number
  globe: OrbitPlace
  slots: Record<OrbitSlot, OrbitPlace>
}

/** The rail's layout: the globe and the slots placed in a box just big enough for them. */
export function orbitLayout(): OrbitLayout {
  const centres: Record<string, { x: number; y: number }> = {}
  for (const [slot, degrees] of Object.entries(ORBIT_SLOTS)) {
    const angle = (degrees * Math.PI) / 180
    // Screen y grows downwards, so the sine is taken away
    centres[slot] = { x: Math.cos(angle) * ORBIT_RADIUS_PX, y: -Math.sin(angle) * ORBIT_RADIUS_PX }
  }
  const half = ORBIT_BUTTON_PX / 2
  const globeHalf = ORBIT_GLOBE_PX / 2
  // The box is the ring's, not the globe's: the buttons are what reach furthest
  const ringHalf = ORBIT_RING_PX / 2
  let minX = -ringHalf
  let minY = -ringHalf
  let maxX = ringHalf
  let maxY = ringHalf
  for (const { x, y } of Object.values(centres)) {
    minX = Math.min(minX, x - half)
    minY = Math.min(minY, y - half)
    maxX = Math.max(maxX, x + half)
    maxY = Math.max(maxY, y + half)
  }
  const round = (v: number) => Math.round(v * 10) / 10
  const slots = {} as Record<OrbitSlot, OrbitPlace>
  for (const [slot, { x, y }] of Object.entries(centres)) {
    slots[slot as OrbitSlot] = { left: round(x - half - minX), top: round(y - half - minY) }
  }
  return {
    width: round(maxX - minX),
    height: round(maxY - minY),
    globe: { left: round(-globeHalf - minX), top: round(-globeHalf - minY) },
    slots,
  }
}
