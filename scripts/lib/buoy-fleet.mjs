/**
 * Generic buoys for the fairways: the shapes OpenStreetMap names for a
 * mark (seamark:<type>:shape – see lib/buoys.mjs) in the three colours
 * the map draws, one GLB per shape and colour, so a red can and a green
 * cone need no runtime tint and a lantern's grey stays grey.
 *
 * Conventions as everywhere: 1 unit = 1 m, Y-up. The origin is on the
 * WATERLINE, not mid-height like the ships': the layer clamps a buoy to
 * the tiles' water and sets the model down on it, and whatever lies
 * under y = 0 – the float's draft, the antifouling band – is in the
 * water, where the mesh hides it and a wave crest shows a dark band, as
 * it does on the real thing. BUOY_SHAPES (height above water, where the
 * lantern is, the widest radius) is the contract with
 * src/map/BuoysLayer.ts and tests/buoy-models.test.ts.
 *
 * Built from the curved helpers of model-detail.mjs, which the road and
 * rail vehicles do not use – their GLBs stay byte-identical through
 * anything here – and a palette that only gained the buoys' entries.
 *
 * The topmarks are IALA region A's, which every German water is in: a
 * can on the red (port) marks, a cone point-up on the green (starboard)
 * ones, a cross on the yellow special marks – on the pillar and spar
 * buoys, whose body is a tower or a pole; a can, a cone, a sphere or a
 * barrel is its own shape and carries none. The pillar and the spar
 * carry a lantern too, lit or not: a light sits on a tower or a pole,
 * and an unlit one is a grey cylinder nobody notices.
 */

import { createMesh } from './vehicle-mesh.mjs'
import { ellipsoid, rod } from './model-detail.mjs'

/** The paint per colour, as vehicle-mesh's palette names it. */
const PAINT = { red: 'buoyRed', green: 'buoyGreen', yellow: 'buoyYellow' }

/**
 * Per shape: how high the mark stands over the water (the tallest of
 * its three colours – the topmarks differ a little in height), where
 * its light is (the lantern's centre – a shape without a lantern is lit
 * at its top, the rare case of a lit can or sphere), and the widest
 * radius in plan.
 */
export const BUOY_SHAPES = {
  pillar: { height: 5.7, lightHeight: 4.4, radius: 1.3 },
  spar: { height: 4.5, lightHeight: 3.65, radius: 0.28 },
  can: { height: 1.5, lightHeight: 1.6, radius: 0.85 },
  conical: { height: 1.9, lightHeight: 2.0, radius: 0.85 },
  spherical: { height: 1.2, lightHeight: 1.35, radius: 0.85 },
  barrel: { height: 0.92, lightHeight: 1.1, radius: 1.1 },
}

export const BUOY_COLOURS = ['red', 'green', 'yellow']

/** A vertical cylinder between two heights on the buoy's axis. */
function column(mesh, material, y0, y1, r0, r1 = r0, sides = 12) {
  rod(mesh, material, [0, y0, 0], [0, y1, 0], r0, sides, r1)
}

/**
 * The topmark over a tower or a pole at height y: the can, the cone or
 * the cross of the mark's colour (see the header).
 */
function topmark(mesh, colour, y, size) {
  const paint = PAINT[colour]
  if (colour === 'red') column(mesh, paint, y, y + size * 1.3, size, size, 10)
  else if (colour === 'green') column(mesh, paint, y, y + size * 1.8, size, size * 0.08, 10)
  else {
    // A cross: two thin rods leaning against each other in the plane
    // the buoy is looked at from
    const arm = size * 0.14
    rod(mesh, paint, [-size, y, 0], [size, y + size * 1.9, 0], arm, 6)
    rod(mesh, paint, [size, y, 0], [-size, y + size * 1.9, 0], arm, 6)
  }
}

/** A lantern on a tower or a pole: the housing and its cap. */
function lantern(mesh, y, r) {
  column(mesh, 'buoyLantern', y, y + r * 2.3, r, r, 10)
  column(mesh, 'buoyLantern', y + r * 2.3, y + r * 3.2, r * 1.15, r * 0.2, 10)
}

/** The pillar buoy: a wide float, a tapered tower, the lantern and the topmark. */
export function pillar(colour) {
  const mesh = createMesh()
  const paint = PAINT[colour]
  column(mesh, 'buoyDark', -0.8, 0.15, 1.3, 1.3, 16)
  column(mesh, paint, 0.15, 0.6, 1.3, 1.3, 16)
  column(mesh, paint, 0.6, 3.9, 0.55, 0.32, 10)
  column(mesh, paint, 3.9, 4.1, 0.55, 0.55, 10)
  lantern(mesh, 4.1, 0.26)
  topmark(mesh, colour, 5.05, 0.33)
  return mesh
}

/** The spar buoy: a pole, most of it under water, a small lantern and the topmark. */
export function spar(colour) {
  const mesh = createMesh()
  const paint = PAINT[colour]
  column(mesh, 'buoyDark', -1.6, 0.2, 0.2, 0.2, 10)
  column(mesh, paint, 0.2, 3.5, 0.2, 0.15, 10)
  lantern(mesh, 3.5, 0.13)
  topmark(mesh, colour, 4.0, 0.24)
  return mesh
}

/** The can buoy: a drum, flat on top. */
export function can(colour) {
  const mesh = createMesh()
  column(mesh, 'buoyDark', -0.7, 0.15, 0.85, 0.85, 16)
  column(mesh, PAINT[colour], 0.15, 1.5, 0.85, 0.85, 16)
  return mesh
}

/** The conical buoy: a drum drawn to a point. */
export function conical(colour) {
  const mesh = createMesh()
  column(mesh, 'buoyDark', -0.7, 0.15, 0.85, 0.85, 16)
  column(mesh, PAINT[colour], 0.15, 0.5, 0.85, 0.85, 16)
  column(mesh, PAINT[colour], 0.5, 1.9, 0.85, 0.06, 16)
  return mesh
}

/** The spherical buoy: a ball, a third of it under water. */
export function spherical(colour) {
  const mesh = createMesh()
  ellipsoid(mesh, PAINT[colour], [0, 0.35, 0], [0.85, 0.85, 0.85], 20, 10)
  return mesh
}

/** The barrel buoy: a drum lying on the water. */
export function barrel(colour) {
  const mesh = createMesh()
  rod(mesh, PAINT[colour], [0, 0.3, -0.9], [0, 0.3, 0.9], 0.62, 14)
  return mesh
}

const BUILDERS = { pillar, spar, can, conical, spherical, barrel }

/** Every buoy the map draws, by GLB name: buoy-<shape>-<colour>. */
export const BUOYS = Object.fromEntries(
  Object.keys(BUOY_SHAPES).flatMap((shape) =>
    BUOY_COLOURS.map((colour) => [`buoy-${shape}-${colour}`, () => BUILDERS[shape](colour)]),
  ),
)
