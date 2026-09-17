/**
 * Aircraft for the ADS-B traffic: smooth 32-sided fuselages, profiled
 * wings and fins, recessed fan intakes, shell-mounted glazing and satin
 * PBR materials. One archetype per silhouette, stretched by the layer
 * to the reported ICAO type's length, span and height.
 *
 * Conventions as everywhere: 1 unit = 1 m, Y-up, +Z is the nose, +X the
 * port (left) wing, origin mid-length at half the total height, the
 * wheels (or skids) at y = -height/2 – the aircraft stands on the apron
 * in this frame, and the layer lifts it to its altitude. AIRCRAFT_DIMS
 * (reference length, span, height) is the contract with
 * src/map/AircraftLayer.ts, with ARCHETYPE_SIZE in
 * src/lib/aircraft-info.ts and with the model tests.
 *
 * Every builder also records where its lights are (`mesh.lights`, in
 * this frame): the red and green position lights at the wing tips, the
 * white tail light, the red beacons on top of and under the fuselage.
 * AIRCRAFT_MODELS in the layer carries the same points in the frame
 * Cesium hands it, pinned by tests/aircraft-models.test.ts.
 *
 * A retractable undercarriage is a part of its own (`mesh.parts.gear`,
 * a glTF node named "gear"): the layer shows it near the ground and
 * hides it in the air, where an airliner with its wheels out reads as
 * a toy. A fixed undercarriage – the light single's, the helicopter's
 * skids – is part of the body and always out.
 */

import { MATERIALS, box, createMesh, extrude, fan, quad, tri } from './vehicle-mesh.mjs'

import { ellipsoid, mergeMesh, rod, roundedBox, smoothSurface } from './model-detail.mjs'

void MATERIALS // palette lives in vehicle-mesh; imported for doc proximity

/** Reference dimensions per archetype (length, span as width, total height). */
export const AIRCRAFT_DIMS = {
  'aircraft-narrowbody': { length: 37.6, width: 35.8, height: 11.8 }, // A320
  'aircraft-widebody': { length: 63.7, width: 60.3, height: 16.8 }, // A330-300
  'aircraft-jumbo': { length: 72.7, width: 79.8, height: 24.1 }, // A380
  'aircraft-bizjet': { length: 20.9, width: 19.6, height: 6.3 }, // Challenger 600
  'aircraft-turboprop': { length: 27.2, width: 27.1, height: 7.7 }, // ATR 72
  'aircraft-light': { length: 8.3, width: 11.0, height: 2.7 }, // Cessna 172
  'aircraft-helicopter': { length: 10.2, width: 10.2, height: 3.5 }, // EC135, nose to tail
}

/** Sides of every round thing – fuselage, nacelle, wheel, rotor. */
const SIDES = 32
/** How far the glazing stands proud of the shell it lies on, in metres. */
const GLASS_PROUD = 0.03

// ---------------------------------------------------------------------------
// Geometry helpers the aeroplanes need and the vehicles never did: slabs
// at any angle (wings, fins), tubes around any axis (nacelles), discs
// (propellers, rotors, wheels), and glass laid on a curved shell. Every
// face is wound by the solid's own centroid, so a helper can be fed its
// corners in any perimeter order.

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s]
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a) => {
  const len = Math.hypot(...a) || 1
  return scale(a, 1 / len)
}
const centroid = (pts) => scale(pts.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / pts.length)

/** A quad whose normal is made to point away from `centre`, whatever order the corners came in. */
function quadOut(mesh, material, a, b, c, d, centre) {
  const n = cross(sub(b, a), sub(d, a))
  const outward = sub(centroid([a, b, c, d]), centre)
  if (dot(n, outward) < 0) quad(mesh, material, a, d, c, b)
  else quad(mesh, material, a, b, c, d)
}

/** The same for a triangle. */
function triOut(mesh, material, a, b, c, centre) {
  const n = cross(sub(b, a), sub(c, a))
  const outward = sub(centroid([a, b, c]), centre)
  if (dot(n, outward) < 0) tri(mesh, material, a, c, b)
  else tri(mesh, material, a, b, c)
}

/**
 * A flat plate of `thickness` around the planar quad `corners` (perimeter
 * order) – a wing, a fin, a stabiliser. Six faces, twelve triangles.
 */
function slab(mesh, material, corners, thickness) {
  const [a, b, c, d] = corners
  const n = unit(cross(sub(b, a), sub(d, a)))
  const up = scale(n, thickness / 2)
  const top = corners.map((p) => add(p, up))
  const bottom = corners.map((p) => sub(p, up))
  const centre = centroid([...top, ...bottom])
  quadOut(mesh, material, ...top, centre)
  quadOut(mesh, material, ...bottom, centre)
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4
    quadOut(mesh, material, top[i], top[j], bottom[j], bottom[i], centre)
  }
}

/**
 * The points of a regular n-gon around (cx, cy, cz) whose flats, not its
 * corners, lie at radius r – so its extent along either axis is exactly
 * 2r, and a wheel of radius r stands on the ground at exactly cy - r.
 * `axis` is the one it lies around: 'z' for a fuselage ring or a
 * propeller, 'y' for a main rotor, 'x' for a wheel or a tail rotor.
 */
function ngon(cx, cy, cz, r, axis = 'z', n = SIDES) {
  const pts = []
  const corner = r / Math.cos(Math.PI / n)
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI / n) * (2 * i + 1)
    const u = Math.cos(angle) * corner
    const v = Math.sin(angle) * corner
    if (axis === 'z') pts.push([cx + u, cy + v, cz])
    else if (axis === 'y') pts.push([cx + u, cy, cz + v])
    else pts.push([cx, cy + u, cz + v])
  }
  return pts
}

/** Caps a ring with a fan around its centroid, wound away from `centre`. */
function capRing(mesh, material, ring, centre) {
  const c = centroid(ring)
  for (let i = 0; i < ring.length; i++) {
    triOut(mesh, material, c, ring[i], ring[(i + 1) % ring.length], centre)
  }
}

/**
 * A round tube along Z around (cx, cy): `stations` give the z and the
 * radius scale of each ring, tail first. Capped at both ends – `caps`
 * names the materials of the rear and the front cap (an engine's intake
 * is dark).
 */
function tube(mesh, material, cx, cy, radius, stations, caps = [material, material]) {
  const wall = createMesh()
  const rings = stations.map((st) => ngon(cx, cy, st.z, radius * (st.s ?? 1)))
  const centre = centroid(rings.flat())
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      quadOut(wall, material, rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i], centre)
    }
  }
  mergeMesh(mesh, smoothSurface(wall))
  capRing(mesh, caps[0], rings[0], centre)
  capRing(mesh, caps[1], rings[rings.length - 1], centre)
}

/**
 * A thin round disc – a propeller or a rotor, drawn in the see-through
 * `rotor` material as the blur it is at any speed a transponder reports,
 * or a wheel in a solid one. `axis` is the shaft.
 */
function disc(mesh, material, cx, cy, cz, radius, thickness, axis) {
  const offset =
    axis === 'z' ? [0, 0, thickness / 2] : axis === 'y' ? [0, thickness / 2, 0] : [thickness / 2, 0, 0]
  const a = ngon(cx, cy, cz, radius, axis).map((p) => add(p, offset))
  const b = ngon(cx, cy, cz, radius, axis).map((p) => sub(p, offset))
  const centre = [cx, cy, cz]
  const wall = createMesh()
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES
    quadOut(wall, material, a[i], a[j], b[j], b[i], centre)
  }
  mergeMesh(mesh, smoothSurface(wall))
  capRing(mesh, material, a, centre)
  capRing(mesh, material, b, centre)
}

/**
 * The points of a rounded cross-section: an n-gon on the ellipse w wide
 * and h tall around (0, yc), counter-clockwise seen from +Z (the nose),
 * from the bottom right up the right side – with a flat at the top and
 * the bottom, like the vehicles' bevelled profile. The i-th face of a
 * ring built from it runs from point i to point i+1. Glazing uses a
 * sixteen-sector angular coordinate through shell.pointAt(), independent
 * of this finer mesh, so its height and size stay fixed.
 */
function roundProfile(w, h, yc) {
  const pts = []
  for (let k = 0; k < SIDES; k++) {
    const a = -Math.PI / 2 + Math.PI / 16 + ((2 * Math.PI) / SIDES) * k
    pts.push([(w / 2) * Math.cos(a), yc + (h / 2) * Math.sin(a)])
  }
  return pts
}

/**
 * A body extruded along Z with round rings, and the means to find its
 * shell again: `ringAt(z)` is the ring the extrusion has at any length,
 * interpolated between the two stations around it exactly as the faces
 * between them are – which is what lets glass be laid ON the shell
 * rather than poked through it (the first cockpit was a box, and it
 * broke through the nose taper on every side).
 */
function body(mesh, material, profile, stations, yAnchor, capMaterials, mirrored = false) {
  let skin = createMesh()
  extrude(skin, profile, stations, { material, yAnchor, capMaterials })
  if (mirrored) {
    // Non-planar quads need mirrored diagonals as well as mirrored points,
    // or a projected pane can clear one cheek but intersect the other.
    const symmetric = createMesh()
    for (const [name, group] of skin.groups) {
      for (let i = 0; i < group.indices.length; i += 3) {
        const points = group.indices.slice(i, i + 3).map((index) => group.positions.slice(index * 3, index * 3 + 3))
        if (points.some(([x]) => x < -1e-8)) continue
        const [a, b, c] = points.map(([x, y, z]) => [Math.abs(x) < 1e-8 ? 0 : x, y, z])
        tri(symmetric, name, a, b, c)
        const reflect = ([x, y, z]) => [-x, y, z]
        tri(symmetric, name, reflect(a), reflect(c), reflect(b))
      }
    }
    skin = symmetric
  }
  mergeMesh(mesh, smoothSurface(skin))
  const ring = (st) =>
    profile.map(([x, y]) => [x * (st.sx ?? 1), (y - yAnchor) * (st.sy ?? 1) + yAnchor + (st.yOff ?? 0), st.z])
  const ringAt = (z) => {
    let s = 0
    while (s + 2 < stations.length && stations[s + 1].z < z) s++
    const a = ring(stations[s])
    const b = ring(stations[s + 1])
    const span = stations[s + 1].z - stations[s].z
    const t = span > 0 ? Math.min(1, Math.max(0, (z - stations[s].z) / span)) : 0
    return a.map((p, i) => lerp(p, b[i], t))
  }
  // Glazing coordinates retain the original sixteen-face angular frame;
  // interpolate on the actual finer shell, including its station bends.
  const pointAt = (z, face) => {
    const ring = ringAt(z)
    const i = ((face * SIDES / 16) % SIDES + SIDES) % SIDES
    return lerp(ring[Math.floor(i)], ring[(Math.floor(i) + 1) % SIDES], i % 1)
  }
  return { ringAt, pointAt, stations }
}

/**
 * Glass laid on the faces `faces` of a body's shell between two
 * lengths, GLASS_PROUD proud of it, following whatever taper the shell
 * has there – one pane per face and length piece, `panes` pieces with
 * gaps between them, or one continuous pane. `band` narrows a pane to a
 * strip of the face's height (0 at the lower edge, 1 at the upper) – a
 * cabin window row is a strip, a cockpit window the whole cheek.
 */
function glaze(mesh, shell, faces, zFrom, zTo, { panes = 1, gap = 0.09, band = [0, 1] } = {}) {
  const skin = createMesh()
  // Adjacent facets share exactly the same lifted edge; offsetting each
  // facet by its own normal leaves bright cracks across a curved pane.
  const point = (z, face) => {
    const p = shell.pointAt(z, face)
    const up = sub(shell.pointAt(z, face + 0.01), shell.pointAt(z, face - 0.01))
    const forward = sub(shell.pointAt(z + 0.01, face), shell.pointAt(z - 0.01, face))
    return add(p, scale(unit(cross(up, forward)), GLASS_PROUD))
  }
  const paneLength = (zTo - zFrom - gap * (panes - 1)) / panes
  for (let n = 0; n < panes; n++) {
    const za = zFrom + n * (paneLength + gap)
    const zb = za + paneLength
    // A pane that crosses a station is bent at it, so it keeps to the shell
    const zs = [za, ...shell.stations.map((st) => st.z).filter((z) => z > za && z < zb), zb]
    for (let k = 0; k + 1 < zs.length; k++) {
      for (const i of faces) {
        const edges = [band[0], ...[0.5].filter((v) => v > band[0] && v < band[1]), band[1]]
        for (let f = 0; f + 1 < edges.length; f++) {
          const a = point(zs[k], i + edges[f])
          const b = point(zs[k], i + edges[f + 1])
          const c = point(zs[k + 1], i + edges[f + 1])
          const d = point(zs[k + 1], i + edges[f])
          quad(skin, 'aircraftGlass', a, b, c, d)
        }
      }
    }
  }
  mergeMesh(mesh, smoothSurface(skin))
}

/** The faces a cabin's window row lies on: both flanks from 11° to 34° above the centre line. */
const CABIN_FACES = [4, 11]
/** The row above it on a double-decker: the cheeks from 34° to 56°. */
const UPPER_DECK_FACES = [5, 10]

// ---------------------------------------------------------------------------
// Parts

/**
 * Fuselage: a round tube tapered to a raised tail cone aft and, forward,
 * to a nose that drops away under the cockpit – the top line falls to
 * the radome while the underside runs on nearly level, the way an
 * airliner's does (`noseDroop`, the tip's drop as a share of the
 * height). `length` long between the two tips, `w` wide and `h` tall
 * amidships around the centre line at yc. Returns the shell for the
 * glazing.
 */
function fuselage(mesh, { length, w, h, yc, tailRise = 0.3, noseDroop = 0.26, taper = 0.22, jetNose = false }) {
  // The jet forebody is sized by cabin width, not total aircraft length.
  // Separate crown and belly heights give the windscreen a steeper rake,
  // followed by a shallow radome shoulder and a round, full chin.
  const nose = jetNose ? [
    // Distance aft of the tip / width, half-width / width, crown and belly / height.
    [1.6, 0.5, 0.5, -0.5],
    [1.25, 0.5, 0.498, -0.495],
    [1.0, 0.485, 0.47, -0.48],
    [0.78, 0.456, 0.405, -0.455],
    [0.60, 0.405, 0.28, -0.425],
    [0.46, 0.36, 0.185, -0.39],
    [0.32, 0.30, 0.13, -0.365],
    [0.18, 0.225, 0.07, -0.31],
    [0.075, 0.15, -0.005, -0.255],
    [0.02, 0.08, -0.067, -0.20],
    [0.004, 0.036, -0.101, -0.162],
    [0, 0.002, -0.128, -0.132],
  ].map(([aft, radius, top, bottom]) => ({
    z: length / 2 - w * aft, sx: radius * 2, sy: top - bottom, yOff: h * (top + bottom) / 2,
  })) : [
    { z: length * 0.3 },
    { z: length * 0.38, sx: 0.985, sy: 0.985, yOff: -h * noseDroop * 0.05 },
    { z: length * 0.44, sx: 0.86, sy: 0.82, yOff: -h * noseDroop * 0.35 },
    { z: length * 0.475, sx: 0.6, sy: 0.55, yOff: -h * noseDroop * 0.72 },
    { z: length * 0.49, sx: 0.36, sy: 0.32, yOff: -h * noseDroop * 0.92 },
    { z: length * 0.498, sx: 0.14, sy: 0.12, yOff: -h * noseDroop },
    { z: length / 2, sx: 0.025, sy: 0.025, yOff: -h * noseDroop },
  ]
  return body(
    mesh,
    'airframe',
    roundProfile(w, h, yc),
    [
      { z: -length / 2, sx: 0.1, sy: 0.18, yOff: h * tailRise },
      { z: -length / 2 + length * taper * 0.18, sx: 0.24, sy: 0.32, yOff: h * tailRise * 0.85 },
      { z: -length / 2 + length * taper * 0.45, sx: 0.5, sy: 0.6, yOff: h * tailRise * 0.6 },
      { z: -length / 2 + length * taper, sx: 0.86, sy: 0.92, yOff: h * tailRise * 0.2 },
      { z: -length * 0.12 },
      ...nose,
    ],
    yc,
    // No cap materials: the nose closes on the stations themselves
    undefined,
    jetNose,
  )
}

/**
 * Six cockpit panes, authored in front and side elevations and projected
 * onto the forebody. The broad windscreens reach the
 * centre pillar; the narrower side panes wrap around the cheeks. Build
 * one side and mirror its vertices AND winding: opposite angular bands
 * have opposite height directions, so repeating their offsets is not a
 * reflection (the old strip cockpit had mismatched heights on each side).
 */
function jetCockpit(mesh, shell, { length, w, h, yc }) {
  const rings = shell.stations.filter((st) => st.z >= length / 2 - w * 1.6 - 1e-6)
    .map((st) => shell.ringAt(st.z))
  const triangles = []
  for (let s = 0; s + 1 < rings.length; s++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      const a = rings[s][i]
      const b = rings[s][j]
      const c = rings[s + 1][j]
      const d = rings[s + 1][i]
      triangles.push([a, b, c], [a, c, d])
    }
  }
  // Perimeter order: inner lower, outer lower, outer upper, inner upper.
  const panes = [
    [[0.018, 0.175], [0.25, 0.165], [0.225, 0.305], [0.018, 0.315]],
  ]
  // Side windows are drawn in side elevation: nearly level sills and
  // upright rear pillars, rather than curved strips climbing the crown.
  const sidePanes = [
    [[0.89, 0.155], [0.568, 0.165], [0.742, 0.305], [0.89, 0.29]],
    [[1.08, 0.15], [0.93, 0.155], [0.93, 0.29], [1.08, 0.28]],
  ]
  const glass = createMesh()
  for (const [index, corners] of [...panes, ...sidePanes].entries()) {
    const axis = index === 0 ? 0 : 2
    const depth = index === 0 ? 2 : 0
    const outline = corners.map(([u, v]) => [index === 0 ? u * w : length / 2 - u * w, yc + v * h])
    for (const triangle of triangles) {
      if (triangle.some(([x]) => x < -1e-8)) continue
      const normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]))
      if (normal[depth] <= 1e-10) continue
      // Clip the actual shell triangle against the pane's four projected
      // edges. Unlike a sampled grid, this preserves every station and
      // facet bend, so even the jumbo's large panes never cut into the skin.
      let polygon = triangle
      for (let edge = 0; edge < outline.length && polygon.length; edge++) {
        const a = outline[edge]
        const b = outline[(edge + 1) % outline.length]
        const distance = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[axis] - a[0])
        const clipped = []
        for (let i = 0; i < polygon.length; i++) {
          const p = polygon[i]
          const q = polygon[(i + 1) % polygon.length]
          const dp = distance(p)
          const dq = distance(q)
          if (dp >= 0) clipped.push(p)
          if ((dp >= 0) !== (dq >= 0)) clipped.push(lerp(p, q, dp / (dp - dq)))
        }
        polygon = clipped
      }
      const lifted = polygon.map((p) => p.map((v, k) => v + (k === depth ? GLASS_PROUD : 0)))
      const reflect = ([x, y, z]) => [-x, y, z]
      for (let i = 1; i + 1 < lifted.length; i++) {
        const a = lifted[0]
        const b = lifted[i]
        const c = lifted[i + 1]
        if (Math.hypot(...cross(sub(b, a), sub(c, a))) < 1e-10) continue
        tri(glass, 'aircraftGlass', a, b, c)
        tri(glass, 'aircraftGlass', reflect(a), reflect(c), reflect(b))
      }
    }
  }
  mergeMesh(mesh, smoothSurface(glass))
}

/**
 * A row of portholes along both flanks: a small octagonal pane every
 * `pitch` – an airliner's frame pitch – each laid flat on the shell
 * a hand above the centre line. Every vertex follows the curved shell.
 * An octagon a window, one fan of nine vertices: at the distance
 * the map is looked at from a window is a dot, and a dot with corners
 * is a rectangle.
 */
function portholeRow(mesh, shell, zFrom, zTo, { pitch = 0.53, w = 0.3, h = 0.42, faces = CABIN_FACES, at = 0.2 } = {}) {
  const n = Math.floor((zTo - zFrom) / pitch)
  const start = zFrom + (zTo - zFrom - n * pitch) / 2
  for (const i of faces) {
    for (let k = 0; k < n; k++) {
      const z = start + pitch * (k + 0.5)
      const pa = shell.pointAt(z, i + at)
      const tangent = sub(shell.pointAt(z, i + at + 0.05), shell.pointAt(z, i + at - 0.05))
      const faceHeight = Math.hypot(...tangent) / 0.1
      const normal = unit(cross(tangent, [0, 0, 1]))
      const centre = add(pa, scale(normal, GLASS_PROUD))
      const pts = []
      const cut = 1 / Math.cos(Math.PI / 8)
      for (let m = 0; m < 8; m++) {
        const angle = (Math.PI / 8) * (2 * m + 1)
        const face = i + at + (h / 2) * cut * Math.sin(angle) / faceHeight
        const p = shell.pointAt(z + (w / 2) * cut * Math.cos(angle), face)
        pts.push(add(p, scale(normal, GLASS_PROUD)))
      }
      // Wound to face outward: reversed where the fan's own normal points in
      const fanNormal = cross(sub(pts[0], centre), sub(pts[1], centre))
      fan(mesh, 'aircraftGlass', centre, dot(fanNormal, normal) < 0 ? pts.reverse() : pts)
    }
  }
}

/** Subtle door outlines and handles on the shell, below the window row. */
function cabinDoors(mesh, shell, length, height, frontZ = length * 0.345) {
  for (const side of [1, -1]) {
    for (const z of [-length * 0.22, frontZ]) {
      const face = side > 0 ? 4 : 11
      const at = (dz, f) => {
        const p = shell.pointAt(z + dz, face + f)
        return [p[0] + side * 0.038, p[1], p[2]]
      }
      const corners = [[-0.37, -0.95], [-0.37, 0.52], [0.37, 0.52], [0.37, -0.95]]
      for (let i = 0; i < corners.length; i++) {
        const [za, fa] = corners[i], [zb, fb] = corners[(i + 1) % corners.length]
        // Split vertical edges at the shell's finer faces.
        const steps = Math.max(1, Math.ceil(Math.abs(fb - fa) * 4))
        for (let j = 0; j < steps; j++) {
          const point = (t) => at(za + (zb - za) * t, fa + (fb - fa) * t)
          rod(mesh, 'wingMetal', point(j / steps), point((j + 1) / steps), Math.min(0.014, height * 0.004), 6)
        }
      }
      rod(mesh, 'engineMetal', at(-0.14, -0.25), at(0.1, -0.25), 0.025, 8)
    }
  }
}

/**
 * One wing panel, root to tip: swept back by the difference of the two
 * leading-edge z's, tapered from rootChord to tipChord, rising by the
 * dihedral. The root sits inside the fuselage so no seam shows.
 */
function wing(mesh, material, side, { rootX, rootY, rootZ, rootChord, tipX, tipY, tipZ, tipChord, thickness }) {
  // A rounded leading edge and a thin trailing edge, with the section
  // shrinking toward the tip. Three span stations keep the root full.
  const skin = createMesh()
  const chords = [0, 0.015, 0.05, 0.12, 0.24, 0.4, 0.6, 0.78, 0.92, 1]
  const rings = [0, 0.36, 1].map((t) => {
    const chord = rootChord + (tipChord - rootChord) * t
    const x = side * (rootX + (tipX - rootX) * t)
    const y = rootY + (tipY - rootY) * t
    const z = rootZ + (tipZ - rootZ) * t
    const section = (u, upper) => {
      const shape = 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u ** 2 + 0.2843 * u ** 3 - 0.1015 * u ** 4)
      return [x, y + (upper ? 1 : -1) * thickness * (chord / rootChord) * shape, z - chord * u]
    }
    return [...chords.map((u) => section(u, true)), ...chords.slice(1).reverse().map((u) => section(u, false))]
  })
  const centre = centroid(rings.flat())
  for (let r = 0; r + 1 < rings.length; r++) {
    for (let i = 0; i < rings[r].length; i++) {
      const j = (i + 1) % rings[r].length
      quadOut(skin, material, rings[r][i], rings[r][j], rings[r + 1][j], rings[r + 1][i], centre)
    }
  }
  capRing(skin, material, rings[0], centre)
  capRing(skin, material, rings.at(-1), centre)
  mergeMesh(mesh, smoothSurface(skin, 48))
  // Flap/aileron hinge on the upper surface, following the section.
  const line = (t) => {
    const chord = rootChord + (tipChord - rootChord) * t
    return [side * (rootX + (tipX - rootX) * t), rootY + (tipY - rootY) * t + thickness * (chord / rootChord) * 0.27 + 0.012, rootZ + (tipZ - rootZ) * t - chord * 0.76]
  }
  rod(mesh, 'wingMetal', line(0.16), line(0.96), Math.min(0.022, rootChord * 0.004), 6)
}

/** The vertical fin, swept, from the fuselage top to `top`. */
function fin(mesh, material, { zRoot, rootChord, tipChord, yRoot, top, sweep }) {
  const section = [[0, 0], [0.04, 0.28], [0.2, 0.5], [0.45, 0.4], [0.75, 0.22], [1, 0.012]]
  const rings = [0, 0.35, 1].map((t) => {
    const chord = rootChord + (tipChord - rootChord) * t
    const y = yRoot + (top - yRoot) * t
    const z = zRoot - sweep * t
    const point = (u, w, side) => [side * chord * 0.08 * w, y, z - u * chord]
    return [...section.map(([u, w]) => point(u, w, 1)), ...section.slice(1).toReversed().map(([u, w]) => point(u, w, -1))]
  })
  const skin = createMesh()
  const centre = centroid(rings.flat())
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < rings[k].length; i++) {
      const j = (i + 1) % rings[k].length
      quadOut(skin, material, rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i], centre)
    }
  }
  capRing(skin, material, rings[0], centre)
  capRing(skin, material, rings.at(-1), centre)
  mergeMesh(mesh, smoothSurface(skin, 48))
}

/** Both horizontal stabilisers at height y. */
function stabilisers(mesh, material, { rootX, y, zRoot, rootChord, tipChord, halfSpan, sweep, dihedral = 0.08 }) {
  for (const side of [-1, 1]) {
    wing(mesh, material, side, {
      rootX,
      rootY: y,
      rootZ: zRoot,
      rootChord,
      tipX: halfSpan,
      tipY: y + halfSpan * dihedral,
      tipZ: zRoot - sweep,
      tipChord,
      thickness: rootChord * 0.08,
    })
  }
}

/** A jet engine under (or beside) the wing: a round pod with a dark intake and a pylon to the wing. */
function jetEngine(mesh, { x, y, z, diameter, length, pylonTo }) {
  const r = diameter / 2
  const front = z + length / 2
  // A continuous annular lip folds into the intake. The fan is recessed
  // behind it, so an engine has depth from the follow camera as well.
  const profile = [
    [-0.5, 0.63], [-0.34, 0.88], [-0.12, 1], [0.3, 1],
    [0.46, 0.96], [0.5, 0.9], [0.48, 0.81], [0.32, 0.77], [0.18, 0.72],
  ]
  const skin = createMesh()
  const rings = profile.map(([dz, scale]) => ngon(x, y, z + length * dz, r * scale))
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      quad(skin, k >= 6 ? 'engineMetal' : k >= 4 ? 'engineMetal' : 'airframe', rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i])
    }
  }
  mergeMesh(mesh, smoothSurface(skin))
  disc(mesh, 'chassis', x, y, z + length * 0.18, r * 0.72, 0.02, 'z')
  for (let i = 0; i < 18; i++) {
    const a = i * Math.PI * 2 / 18
    const pt = (rad, angle) => [x + r * rad * Math.cos(angle), y + r * rad * Math.sin(angle), z + length * 0.2]
    quad(mesh, 'engineMetal', pt(0.19, a), pt(0.68, a + 0.18), pt(0.68, a + 0.28), pt(0.19, a + 0.25))
  }
  ellipsoid(mesh, 'engineMetal', [x, y, front - length * 0.24], [r * 0.2, r * 0.2, length * 0.15], 16, 8)
  tube(mesh, 'engineMetal', x, y, r, [{ z: z - length * 0.58, s: 0.47 }, { z: z - length * 0.49, s: 0.6 }], ['chassis', 'engineMetal'])
  if (pylonTo !== undefined) {
    const mid = (y + pylonTo) / 2
    box(mesh, 'airframe', x, mid, z - length * 0.1, diameter * 0.16, Math.abs(pylonTo - y) + 0.01, length * 0.6)
  }
}

/**
 * One undercarriage leg with its wheels on the ground: a dark strut from
 * yTop down to the axle and a round tyre either side of it (or one on
 * it), each with a lighter hub proud of the tyre so it reads as a wheel
 * and not as a drum. `wheel` is the tyre's diameter.
 */
function gear(mesh, { x, z, yTop, yGround, wheel, twin = true }) {
  const r = wheel / 2
  const axleY = yGround + r
  const tyre = wheel * 0.32
  rod(mesh, 'engineMetal', [x, axleY, z], [x, yTop, z], tyre * 0.24)
  rod(mesh, 'engineMetal', [x, axleY + wheel * 0.2, z], [x, yTop, z + wheel * 0.7], tyre * 0.12)
  const offsets = twin ? [-tyre * 0.62, tyre * 0.62] : [0]
  for (const dx of offsets) {
    disc(mesh, 'chassis', x + dx, axleY, z, r, tyre, 'x')
    disc(mesh, 'wingMetal', x + dx, axleY, z, r * 0.42, tyre + 0.04, 'x')
  }
}

/** The lights every aircraft carries – see the header; `tipZ` is the wing tip's mid chord. */
function lights(mesh, { halfSpan, tipY, tipZ, tailY, tailZ, topY, topZ, bottomY, bottomZ }) {
  // The tip lights a hand outboard of the tip, so they sit beside the wing rather than in it
  mesh.lights = {
    port: [halfSpan + 0.25, tipY, tipZ],
    starboard: [-halfSpan - 0.25, tipY, tipZ],
    tail: [0, tailY, tailZ - 0.25],
    beaconTop: [0, topY + 0.2, topZ],
    beaconBottom: [0, bottomY - 0.2, bottomZ],
  }
}

// ---------------------------------------------------------------------------
// The archetypes

/**
 * A twin-jet airliner with the engines under a low swept wing – the
 * A320 and the 737, the E-Jets and the A220 by scaling – or, with
 * `engines: 4`, a four-engined one. The fuselage cross-section and the
 * fin's height come from the reference type; the ground is the wheels'.
 */
function jetliner(name, { fuselageW, fuselageH, engines, engineDiameter, pitch, doubleDeck = false }) {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS[name]
  const ground = -height / 2
  // Fuselage bottom a little over a fifth of the height off the ground –
  // where the door sills of every airliner are
  const yc = ground + height * 0.22 + fuselageH / 2
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, jetNose: true })
  jetCockpit(mesh, shell, { length, w: fuselageW, h: fuselageH, yc })
  cabinDoors(mesh, shell, length, fuselageH)
  portholeRow(mesh, shell, -length * 0.16, length * 0.31, { pitch })
  if (doubleDeck) portholeRow(mesh, shell, -length * 0.14, length * 0.27, { pitch, faces: UPPER_DECK_FACES, at: 0.35 })
  // Wing: root at the fuselage bottom, a quarter of the length forward
  // of the tail cone, swept 25° and rising 5°
  const wingY = yc - fuselageH * 0.32
  const rootChord = length * 0.19
  const halfSpan = width / 2
  const sweep = halfSpan * 0.47
  const wingZ = length * 0.06 + rootChord / 2
  const tipChord = rootChord * 0.28
  const tipY = wingY + halfSpan * 0.09
  for (const side of [-1, 1]) {
    wing(mesh, 'wingMetal', side, {
      rootX: fuselageW * 0.3,
      rootY: wingY,
      rootZ: wingZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ: wingZ - sweep,
      tipChord,
      thickness: rootChord * 0.075,
    })
    // Winglet: a small blade standing up at the tip, inside the span
    const wingletX = side * (halfSpan - rootChord * 0.015)
    slab(
      mesh,
      'wingMetal',
      [
        [wingletX, tipY, wingZ - sweep],
        [wingletX, tipY + width * 0.04, wingZ - sweep - rootChord * 0.12],
        [wingletX, tipY + width * 0.04, wingZ - sweep - rootChord * 0.24],
        [wingletX, tipY, wingZ - sweep - tipChord],
      ],
      rootChord * 0.03,
    )
    // Engines hung under the wing, ahead of its leading edge
    const positions = engines === 4 ? [0.34, 0.6] : [0.36]
    for (const at of positions) {
      const x = side * (fuselageW * 0.3 + (halfSpan - fuselageW * 0.3) * at)
      const wingYAt = wingY + halfSpan * at * 0.09
      const wingZAt = wingZ - sweep * at
      const chordAt = rootChord + (tipChord - rootChord) * at
      jetEngine(mesh, {
        x,
        y: wingYAt - engineDiameter * 0.75,
        z: wingZAt + chordAt * 0.15,
        diameter: engineDiameter,
        length: engineDiameter * 1.9,
        pylonTo: wingYAt,
      })
    }
  }
  // Tail: fin from the fuselage top to the model's ceiling, stabilisers low
  const finRootZ = -length / 2 + length * 0.22
  fin(mesh, 'hullBlue', {
    zRoot: finRootZ,
    rootChord: length * 0.17,
    tipChord: length * 0.07,
    yRoot: yc + fuselageH * 0.4,
    top: height / 2,
    sweep: (height / 2 - yc) * 0.7,
  })
  // The stabilisers' tips end at the tail, not behind it
  stabilisers(mesh, 'wingMetal', {
    rootX: fuselageW * 0.1,
    y: yc + fuselageH * 0.2,
    zRoot: -length / 2 + length * 0.01 + width * 0.08 + length * 0.04,
    rootChord: length * 0.1,
    tipChord: length * 0.04,
    halfSpan: width * 0.19,
    sweep: width * 0.08,
  })
  // Undercarriage: nose leg and two main legs under the wing root, in
  // the part the layer folds away in the air
  const wheel = fuselageH * 0.3
  const gearPart = (mesh.parts.gear = createMesh())
  gear(gearPart, { x: 0, z: length * 0.36, yTop: yc - fuselageH * 0.3, yGround: ground, wheel: wheel * 0.75 })
  for (const side of [-1, 1]) {
    gear(gearPart, { x: side * fuselageW * 0.55, z: wingZ - rootChord * 0.75, yTop: wingY, yGround: ground, wheel })
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: wingZ - sweep - tipChord * 0.4,
    tailY: yc + fuselageH * 0.3,
    tailZ: -length / 2,
    topY: yc + fuselageH / 2,
    topZ: -length * 0.05,
    bottomY: yc - fuselageH / 2,
    bottomZ: length * 0.1,
  })
  return mesh
}

export function aircraftNarrowbody() {
  return jetliner('aircraft-narrowbody', {
    fuselageW: 3.95,
    fuselageH: 4.1,
    engines: 2,
    engineDiameter: 2.4,
    pitch: 0.53,
  })
}

export function aircraftWidebody() {
  return jetliner('aircraft-widebody', {
    fuselageW: 5.64,
    fuselageH: 5.64,
    engines: 2,
    engineDiameter: 3.6,
    pitch: 0.56,
  })
}

/** The A380: four engines and two rows of windows on a fuselage taller than it is wide. */
export function aircraftJumbo() {
  return jetliner('aircraft-jumbo', {
    fuselageW: 7.14,
    fuselageH: 8.4,
    engines: 4,
    engineDiameter: 3.9,
    pitch: 0.64,
    doubleDeck: true,
  })
}

/**
 * A business jet – and the CRJs, the Fokkers and the MD-80s by scaling:
 * the engines on the rear fuselage, a T-tail, a low wing.
 */
export function aircraftBizjet() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-bizjet']
  const ground = -height / 2
  const fuselageW = 2.7
  const fuselageH = 2.7
  const yc = ground + height * 0.2 + fuselageH / 2
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, tailRise: 0.35, taper: 0.28, jetNose: true })
  jetCockpit(mesh, shell, { length, w: fuselageW, h: fuselageH, yc })
  // Leave a solid pillar between the wider cockpit and the entry door.
  cabinDoors(mesh, shell, length, fuselageH, length / 2 - fuselageW * 1.45)
  portholeRow(mesh, shell, -length * 0.12, length * 0.28, { pitch: 0.95, w: 0.36, h: 0.46 })
  const wingY = yc - fuselageH * 0.3
  const rootChord = length * 0.2
  const halfSpan = width / 2
  const sweep = halfSpan * 0.4
  const wingZ = length * 0.02 + rootChord / 2
  const tipChord = rootChord * 0.3
  const tipY = wingY + halfSpan * 0.06
  for (const side of [-1, 1]) {
    wing(mesh, 'wingMetal', side, {
      rootX: fuselageW * 0.3,
      rootY: wingY,
      rootZ: wingZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ: wingZ - sweep,
      tipChord,
      thickness: rootChord * 0.07,
    })
    // Engines on stub pylons either side of the rear fuselage
    const engineD = fuselageH * 0.5
    jetEngine(mesh, {
      x: side * (fuselageW / 2 + engineD * 0.7),
      y: yc + fuselageH * 0.12,
      z: -length * 0.24,
      diameter: engineD,
      length: engineD * 2.6,
    })
    box(mesh, 'airframe', side * (fuselageW / 2 + engineD * 0.3), yc + fuselageH * 0.12, -length * 0.25, engineD * 0.8, engineD * 0.2, engineD * 1.3)
  }
  // T-tail: the stabilisers ride on top of the fin
  const finRootZ = -length / 2 + length * 0.26
  fin(mesh, 'hullBlue', {
    zRoot: finRootZ,
    rootChord: length * 0.2,
    tipChord: length * 0.1,
    yRoot: yc + fuselageH * 0.35,
    top: height / 2 - 0.08,
    sweep: (height / 2 - yc) * 0.75,
  })
  stabilisers(mesh, 'wingMetal', {
    rootX: 0,
    y: height / 2 - 0.1,
    zRoot: finRootZ - (height / 2 - yc) * 0.75,
    rootChord: length * 0.1,
    tipChord: length * 0.05,
    halfSpan: width * 0.2,
    sweep: width * 0.07,
    dihedral: 0,
  })
  const wheel = fuselageH * 0.26
  const gearPart = (mesh.parts.gear = createMesh())
  gear(gearPart, { x: 0, z: length * 0.34, yTop: yc - fuselageH * 0.3, yGround: ground, wheel: wheel * 0.8 })
  for (const side of [-1, 1]) {
    gear(gearPart, { x: side * fuselageW * 0.6, z: wingZ - rootChord * 0.7, yTop: wingY, yGround: ground, wheel })
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: wingZ - sweep - tipChord * 0.4,
    tailY: yc + fuselageH * 0.35,
    tailZ: -length / 2,
    topY: yc + fuselageH / 2,
    topZ: -length * 0.05,
    bottomY: yc - fuselageH / 2,
    bottomZ: length * 0.1,
  })
  return mesh
}

/**
 * A shell drawn from measured side elevations. Each station gives
 * [z, width, belly, crown, superellipse power]; crown and belly are
 * independent, so a cowling, windscreen and cabin are distinct shapes.
 * Build one half and mirror its triangles, including their diagonals.
 */
function shapedShell(mesh, material, stations, sides = SIDES) {
  const skin = createMesh()
  const rings = stations.map(([z, w, bottom, top, power = 2.6]) =>
    Array.from({ length: sides / 2 + 1 }, (_, i) => {
      const a = -Math.PI / 2 + i * Math.PI * 2 / sides
      const s = Math.sin(a)
      return [i === 0 || i === sides / 2 ? 0 : w / 2 * Math.cos(a) ** (2 / power),
        (top + bottom) / 2 + (top - bottom) / 2 * Math.sign(s) * Math.abs(s) ** (2 / power), z]
    }),
  )
  const reflect = ([x, y, z]) => [-x, y, z]
  const triangles = []
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < sides / 2; i++) {
      const a = rings[k][i], b = rings[k][i + 1]
      const c = rings[k + 1][i + 1], d = rings[k + 1][i]
      for (const points of [[a, b, c], [a, c, d]]) {
        triangles.push(points)
        tri(skin, material, ...points)
        tri(skin, material, reflect(points[0]), reflect(points[2]), reflect(points[1]))
      }
    }
  }
  const centre = centroid(rings.flat())
  for (const half of [rings[0], rings.at(-1)]) {
    capRing(skin, material, [...half, ...half.slice(1, -1).toReversed().map(reflect)], centre)
  }
  mergeMesh(mesh, smoothSurface(skin))
  return { triangles }
}

/**
 * Clip a convex contour onto the actual shell triangles, in side [z,y]
 * front [x,y] or top [z,x] elevation. Glazing, seals and paint follow every bend
 * of the shell instead of floating rectangles or angular glass bands.
 */
function shellPanel(mesh, shell, material, outline, { front = false, top = false, offset = 0.009, minZ = -Infinity } = {}) {
  const axis = front ? 0 : 2
  const vertical = top ? 0 : 1
  const depth = top ? 1 : front ? 2 : 0
  const area = outline.reduce((sum, p, i) => {
    const q = outline[(i + 1) % outline.length]
    return sum + p[0] * q[1] - q[0] * p[1]
  }, 0)
  const contour = area < 0 ? outline.toReversed() : outline
  const panel = createMesh()
  for (const triangle of shell.triangles) {
    if (triangle.every((p) => p[2] < minZ)) continue
    const normal = cross(sub(triangle[1], triangle[0]), sub(triangle[2], triangle[0]))
    if (normal[depth] < 1e-9) continue
    let polygon = triangle
    for (let edge = 0; edge < contour.length && polygon.length; edge++) {
      const a = contour[edge], b = contour[(edge + 1) % contour.length]
      const distance = (p) => (b[0] - a[0]) * (p[vertical] - a[1]) - (b[1] - a[1]) * (p[axis] - a[0])
      const clipped = []
      for (let i = 0; i < polygon.length; i++) {
        const p = polygon[i], q = polygon[(i + 1) % polygon.length]
        const dp = distance(p), dq = distance(q)
        if (dp >= 0) clipped.push(p)
        if ((dp >= 0) !== (dq >= 0)) clipped.push(lerp(p, q, dp / (dp - dq)))
      }
      polygon = clipped
    }
    const points = polygon.map((p) => p.map((v, k) => v + (k === depth ? offset : 0)))
    const reflect = ([x, y, z]) => [-x, y, z]
    for (let i = 1; i + 1 < points.length; i++) {
      const a = points[0], b = points[i], c = points[i + 1]
      if (Math.hypot(...cross(sub(b, a), sub(c, a))) < 1e-9) continue
      tri(panel, material, a, b, c)
      tri(panel, material, reflect(a), reflect(c), reflect(b))
    }
  }
  mergeMesh(mesh, smoothSurface(panel))
}

/** Octagonal rounded corners in an elevation, independent of shell facets. */
function windowContour(z0, z1, y0, y1, radius = 0.06) {
  return [[z0 + radius, y0], [z1 - radius, y0], [z1, y0 + radius],
    [z1, y1 - radius], [z1 - radius, y1], [z0 + radius, y1],
    [z0, y1 - radius], [z0, y0 + radius]]
}

/** A thin seal around a pane, or a door seam, projected onto the shell. */
function panelOutline(mesh, shell, contour, material = 'wingMetal', width = 0.012) {
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i], b = contour[(i + 1) % contour.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const dx = (b[1] - a[1]) / len * width / 2
    const dy = -(b[0] - a[0]) / len * width / 2
    shellPanel(mesh, shell, material, [[a[0] + dx, a[1] + dy], [b[0] + dx, b[1] + dy],
      [b[0] - dx, b[1] - dy], [a[0] - dx, a[1] - dy]], { offset: 0.016 })
  }
}

/** A swept, tapered blade, with a thin section instead of a cylindrical spoke. */
function rotorBlade(mesh, centre, axis, angle, radius, chord, material = 'chassis') {
  const point = (r, t, lift = 0) => {
    const u = r * Math.cos(angle) - t * Math.sin(angle)
    const v = r * Math.sin(angle) + t * Math.cos(angle)
    return add(centre, axis === 'y' ? [u, lift, v] : axis === 'z' ? [u, v, lift] : [lift, u, v])
  }
  const stations = [[0.1, 0.24, 0], [0.40, 1, -0.03], [0.94, 0.7, -0.27], [1, 0.2, -0.4]]
  for (let i = 0; i + 1 < stations.length; i++) {
    const [ra, ca, sa] = stations[i], [rb, cb, sb] = stations[i + 1]
    slab(mesh, material, [point(ra * radius, (sa - ca / 2) * chord),
      point(rb * radius, (sb - cb / 2) * chord), point(rb * radius, (sb + cb / 2) * chord),
      point(ra * radius, (sa + ca / 2) * chord)], chord * 0.08)
  }
}

/** Metallic exhaust pipe with a dark outlet inside the rim. */
function exhaust(mesh, a, b, radius) {
  const direction = unit(sub(b, a))
  rod(mesh, 'engineMetal', a, b, radius, 16)
  const end = add(b, scale(direction, 0.006))
  rod(mesh, 'aircraftGlass', end, add(end, scale(direction, 0.004)), radius * 0.78, 16)
}

/**
 * ATR 72-600, proportioned from ATR's side elevation and 27.05 m span:
 * https://www.atr-aircraft.com/regional-mobility/regional-aircraft/atr-72-600/
 * https://www.atr-aircraft.com/wp-content/uploads/2023/04/Cam_Left-1-scaled.png
 */
export function aircraftTurboprop() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-turboprop']
  const ground = -height / 2
  const shell = shapedShell(mesh, 'airframe', [
    [-13.6, 0.10, -0.34, 0.12],
    [-11.1, 1.25, -1.05, 0.13], [-9.2, 2.13, -2.02, 0.06],
    [-7.4, 2.72, -2.76, -0.01], [-5.6, 2.87, -2.98, -0.11, 2],
    // Width-based forebody stations: a raked screen above a rounded radome.
    ...[[1.25, 0.5, 0.498, -0.495], [1.0, 0.485, 0.47, -0.48],
      [0.78, 0.456, 0.405, -0.455], [0.60, 0.405, 0.28, -0.425],
      [0.46, 0.36, 0.185, -0.39], [0.32, 0.30, 0.13, -0.365],
      [0.18, 0.225, 0.07, -0.31], [0.075, 0.15, -0.005, -0.255],
      [0.02, 0.08, -0.067, -0.20], [0.004, 0.036, -0.101, -0.162],
      [0, 0.002, -0.128, -0.132]].map(([aft, radius, crown, belly]) =>
      [length / 2 - 2.87 * aft, 5.74 * radius, -1.545 + 2.87 * belly, -1.545 + 2.87 * crown, 2]),
  ])
  shellPanel(mesh, shell, 'aircraftGlass', [[0.04, -0.89], [0.70, -0.95],
    [0.66, -0.43], [0.04, -0.34]], { front: true, minZ: 10.3, offset: 0.016 })
  for (const pane of [
    [[10.66, -0.99], [11.56, -0.99], [10.92, -0.44], [10.66, -0.43]],
    [[9.91, -0.88], [10.56, -0.97], [10.56, -0.43], [9.91, -0.43]],
  ]) shellPanel(mesh, shell, 'aircraftGlass', pane, { offset: 0.016 })
  for (let k = 0; k < 24; k++) {
    const z = -6.35 + k * 0.575
    shellPanel(mesh, shell, 'aircraftGlass', windowContour(z, z + 0.285, -1.57, -1.10, 0.075))
  }
  for (const [z0, z1] of [[8.65, 9.85], [-7.92, -7.12]]) {
    panelOutline(mesh, shell, windowContour(z0, z1, -2.76, -0.40, 0.14), 'wingMetal', 0.02)
    shellPanel(mesh, shell, 'engineMetal', windowContour(z0 + 0.2, z0 + 0.44, -0.70, -0.64, 0.02), { offset: 0.025 })
  }
  // A restrained blue belly continues the fin colour around the gear fairings.
  shellPanel(mesh, shell, 'aircraftBlue', [[-12.6, -0.51], [-4.8, -2.34], [8.0, -2.54],
    [8.0, -2.87], [-6.8, -2.98]])
  const wingY = 0.12
  const halfSpan = width / 2
  const tipY = 0.30
  shapedShell(mesh, 'airframe', [[-2.35, 0.50, -0.2, 0.03], [-1.3, 2.12, -0.2, 0.34],
    [1.8, 2.27, -0.2, 0.39], [2.72, 1.78, -0.16, 0.18], [3.12, 0.35, -0.10, 0.0]], 16)
  for (const side of [-1, 1]) {
    wing(mesh, 'airframe', side, { rootX: 0.9, rootY: wingY, rootZ: 2.65,
      rootChord: 2.85, tipX: 4.35, tipY: 0.17, tipZ: 2.62, tipChord: 2.85, thickness: 0.43 })
    wing(mesh, 'airframe', side, { rootX: 4.35, rootY: 0.17, rootZ: 2.62,
      rootChord: 2.85, tipX: halfSpan, tipY, tipZ: 1.88, tipChord: 1.18, thickness: 0.43 })
    // Shorter streamlined nacelles, narrowing aft of the wing. The propeller
    // has six broad swept blades, with a proper conical spinner and intake.
    const x = side * 4.1, y = -0.25, propZ = 4.43
    tube(mesh, 'airframe', x, y, 0.62, [
      { z: -1.6, s: 0.15 }, { z: -0.8, s: 0.52 }, { z: 0.5, s: 0.85 },
      { z: 2.15, s: 1.05 }, { z: 3.55, s: 1 }, { z: 4.28, s: 0.68 },
    ])
    ellipsoid(mesh, 'airframe', [x, y - 0.32, 3.45], [0.41, 0.38, 0.78], 16, 6)
    ellipsoid(mesh, 'windowSeal', [x, y - 0.49, 4.025], [0.27, 0.16, 0.07], 12, 6)
    exhaust(mesh, [x + side * 0.38, y + 0.23, 1.85], [x + side * 0.61, y + 0.25, 1.34], 0.15)
    disc(mesh, 'rotorBlur', x, y, propZ, 1.965, 0.015, 'z')
    for (let k = 0; k < 6; k++) rotorBlade(mesh, [x, y, propZ + 0.015], 'z', 0.18 + k * Math.PI / 3, 1.95, 0.27)
    tube(mesh, 'engineMetal', x, y, 0.31, [
      { z: 4.35 }, { z: 4.60, s: 0.85 }, { z: 4.93, s: 0.46 }, { z: 5.14, s: 0.015 },
    ])
    // Gear sponsons follow the lower fuselage rather than looking like floats.
    const sponson = createMesh()
    shapedShell(sponson, 'airframe', [[-2.30, 0.1, -2.7, -2.58], [-1.35, 1.10, -3.13, -2.31],
      [1.15, 1.18, -3.20, -2.21], [2.30, 0.84, -2.95, -2.43], [2.85, 0.03, -2.64, -2.61]], 12)
    for (const g of sponson.groups.values()) {
      for (let i = 0; i < g.positions.length; i += 3) g.positions[i] += side * 1.18
    }
    mergeMesh(mesh, sponson)
  }
  // The dorsal fillet flows into the swept T-tail, with no separate spike.
  fin(mesh, 'aircraftBlue', { zRoot: -7.85, rootChord: 4.9, tipChord: 2.1,
    yRoot: -0.06, top: height / 2 - 0.14, sweep: 2.87 })
  slab(mesh, 'aircraftBlue', [[0, -0.01, -4.7], [0, -0.01, -7.0],
    [0, 0.35, -7.0], [0, 0.02, -4.8]], 0.09)
  slab(mesh, 'aircraftBlue', [[0, -0.01, -7.0], [0, -0.01, -8.85],
    [0, 1.54, -9.05], [0, 0.35, -7.0]], 0.09)
  stabilisers(mesh, 'airframe', { rootX: 0, y: height / 2 - 0.16,
    zRoot: -10.40, rootChord: 2.48, tipChord: 1.18, halfSpan: 3.62, sweep: 0.48, dihedral: 0 })
  const gearPart = (mesh.parts.gear = createMesh())
  gear(gearPart, { x: 0, z: 10.55, yTop: -2.55, yGround: ground, wheel: 0.56 })
  for (const side of [-1, 1]) gear(gearPart, { x: side * 1.45, z: 0.36, yTop: -2.65, yGround: ground, wheel: 0.86 })
  // Small dorsal aerials give scale without adding visible draw calls.
  for (const z of [7.6, -3.3]) slab(mesh, 'airframe', [[0, -0.10, z], [0, -0.10, z - 0.45],
    [0, 0.27, z - 0.55], [0, 0.27, z - 0.30]], 0.055)
  lights(mesh, { halfSpan, tipY, tipZ: 1.41, tailY: 0.1, tailZ: -length / 2,
    topY: -0.10, topZ: -1, bottomY: -2.98, bottomZ: 3 })
  return mesh
}

/** Cessna 172 Skyhawk: short full cowling, upright cabin and a braced high wing. */
export function aircraftLight() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-light']
  const ground = -height / 2
  const tail = -length / 2
  const shell = shapedShell(mesh, 'airframe', [
    [tail, 0.08, -0.05, 0.12], [-3.6, 0.21, -0.16, 0.18],
    [-2.5, 0.44, -0.34, 0.25], [-1.35, 0.75, -0.53, 0.35],
    [-0.55, 1.00, -0.66, 0.57, 3.2], [0.25, 1.1, -0.72, 0.62, 3.5],
    [1.75, 1.1, -0.72, 0.62, 3.5], [2.13, 1.08, -0.70, 0.58, 3.5],
    [2.72, 1.04, -0.66, 0.16, 3.2], [3.35, 1.0, -0.58, 0.12, 2.8],
    [3.73, 0.89, -0.46, 0.06], [3.83, 0.73, -0.37, 0.015],
  ])
  // Windscreen with a narrow centre post; two large door windows and
  // the smaller swept rear side panes. These are contours, not ring bands.
  shellPanel(mesh, shell, 'aircraftGlass', [[0.018, 0.18], [0.40, 0.19],
    [0.45, 0.43], [0.34, 0.565], [0.018, 0.58]], { front: true, minZ: 2.1 })
  const frontWindow = [[1.98, -0.015], [2.51, -0.01], [2.39, 0.17],
    [2.06, 0.49], [1.98, 0.49]]
  const doorWindow = windowContour(0.56, 1.88, -0.025, 0.50, 0.055)
  const rearWindow = [[-0.43, 0.02], [0.40, -0.025], [0.40, 0.49],
    [-0.32, 0.43], [-0.59, 0.19]]
  for (const pane of [frontWindow, doorWindow, rearWindow]) {
    shellPanel(mesh, shell, 'aircraftGlass', pane)
    panelOutline(mesh, shell, pane, 'windowSeal', 0.018)
  }
  // Project the rear window onto the sloping crown too: no floating pane.
  shellPanel(mesh, shell, 'aircraftGlass', [[-1.13, 0.02], [-0.60, 0.02],
    [-0.60, 0.38], [-1.02, 0.30]], { top: true })
  panelOutline(mesh, shell, [[0.48, -0.56], [2.25, -0.55], [2.55, -0.04],
    [2.08, 0.53], [0.48, 0.54]], 'wingMetal', 0.009)
  shellPanel(mesh, shell, 'engineMetal', windowContour(0.71, 0.89, -0.14, -0.10, 0.01), { offset: 0.02 })
  // The photo's red waist stripes taper into the tail; no fake registration.
  shellPanel(mesh, shell, 'aircraftRed', [[-3.85, 0.04], [3.62, -0.22], [3.62, -0.18], [-3.85, 0.075]])
  shellPanel(mesh, shell, 'aircraftRed', [[-3.45, -0.04], [2.92, -0.35], [2.92, -0.31], [-3.45, -0.01]])
  shellPanel(mesh, shell, 'windowSeal', [[-2.9, -0.11], [0.5, -0.45], [0.5, -0.41], [-2.9, -0.085]])
  const propY = -0.17
  disc(mesh, 'rotorBlur', 0, propY, 3.9, 0.94, 0.012, 'z')
  for (let k = 0; k < 2; k++) rotorBlade(mesh, [0, propY, 3.91], 'z', 0.35 + k * Math.PI, 0.92, 0.12)
  tube(mesh, 'engineMetal', 0, propY, 0.19, [
    { z: 3.88 }, { z: 3.95, s: 0.95 }, { z: 4.07, s: 0.58 }, { z: 4.15, s: 0.02 },
  ])
  // Inlets sit inside the broad front face, either side of the spinner.
  for (const side of [-1, 1]) {
    ellipsoid(mesh, 'windowSeal', [side * 0.27, -0.14, 3.824], [0.105, 0.105, 0.022], 16, 8)
  }
  exhaust(mesh, [0.28, -0.51, 3.2], [0.28, -0.70, 2.98], 0.035)
  const wingY = 0.67
  const wingZ = 2.2
  const halfSpan = width / 2
  const tipY = 0.82
  for (const side of [-1, 1]) {
    // The Skyhawk keeps a constant inboard chord; only the outer panel tapers.
    wing(mesh, 'airframe', side, { rootX: 0, rootY: wingY, rootZ: wingZ,
      rootChord: 1.63, tipX: 3.3, tipY: 0.76, tipZ: wingZ, tipChord: 1.63, thickness: 0.20 })
    wing(mesh, 'airframe', side, { rootX: 3.3, rootY: 0.76, rootZ: wingZ,
      rootChord: 1.63, tipX: halfSpan, tipY, tipZ: 2.10, tipChord: 1.08, thickness: 0.20 })
    slab(mesh, 'airframe', [[side * 0.49, -0.59, 1.27], [side * 3.25, 0.68, 1.5],
      [side * 3.25, 0.68, 1.34], [side * 0.49, -0.59, 1.11]], 0.045)
    // Navigation-light housing on each rounded wing tip.
    ellipsoid(mesh, 'wingMetal', [side * 5.46, tipY, 1.78], [0.035, 0.045, 0.13], 12, 6)
    rod(mesh, 'airframe', [side * 0.3, 0.77, 0.8], [side * 0.33, 1.25, 0.43], 0.012, 6)
  }
  fin(mesh, 'airframe', { zRoot: -2.5, rootChord: 1.57, tipChord: 0.60,
    yRoot: 0.18, top: height / 2, sweep: 0.67 })
  slab(mesh, 'airframe', [[0, 0.24, -1.24], [0, 0.2, -2.6],
    [0, 0.75, -2.85], [0, 0.39, -1.67]], 0.055)
  stabilisers(mesh, 'airframe', { rootX: 0, y: 0.02, zRoot: -2.95,
    rootChord: 1.19, tipChord: 0.68, halfSpan: 1.7, sweep: 0.14, dihedral: 0 })
  gear(mesh, { x: 0, z: 2.99, yTop: -0.57, yGround: ground, wheel: 0.38, twin: false })
  for (const side of [-1, 1]) {
    const axle = [side * 1.12, ground + 0.23, 0.33]
    slab(mesh, 'airframe', [[side * 0.39, -0.63, 0.74], [side * 1.1, ground + 0.24, 0.41],
      [side * 1.1, ground + 0.24, 0.25], [side * 0.39, -0.63, 0.53]], 0.045)
    disc(mesh, 'chassis', ...axle, 0.23, 0.16, 'x')
    disc(mesh, 'engineMetal', ...axle, 0.10, 0.175, 'x')
    disc(mesh, 'wingMetal', ...axle, 0.055, 0.18, 'x')
    rod(mesh, 'wingMetal', [side * 0.56, -0.54, 1.1], [side * 0.77, -0.59, 1.1], 0.016, 8)
  }
  lights(mesh, { halfSpan, tipY, tipZ: 1.78, tailY: 0.1, tailZ: tail,
    topY: 1.1, topZ: -3.48, bottomY: -0.72, bottomZ: 0.6 })
  return mesh
}

/**
 * Airbus H140, after the user's photograph: glazed cabin, sculpted engine
 * deck, five blades and an open Fenestron below a T-tail.
 * https://www.airbus.com/en/products-services/helicopters/civil-helicopters/h140
 */
export function aircraftHelicopter() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-helicopter']
  const ground = -height / 2
  const shell = shapedShell(mesh, 'airframe', [
    [-3.58, 0.30, 0.05, 0.44], [-2.65, 0.40, -0.02, 0.44],
    [-1.5, 0.66, -0.14, 0.49], [-0.65, 1.17, -0.48, 0.59],
    [0.1, 1.73, -0.91, 0.65, 3], [0.7, 1.94, -1.09, 0.70, 3.3],
    [2.4, 1.98, -1.09, 0.73, 3.3], [3.22, 1.87, -1.01, 0.69, 3],
    [3.75, 1.69, -0.90, 0.53], [4.25, 1.45, -0.82, 0.21],
    [4.65, 1.13, -0.75, -0.05], [4.9, 0.81, -0.65, -0.16],
    [5.04, 0.43, -0.54, -0.25], [5.1, 0.02, -0.41, -0.37],
  ])
  // Continuous black framing around individual panes, as on the reference.
  shellPanel(mesh, shell, 'windowSeal', [[0.30, -0.44], [0.8, -0.64], [4.72, -0.60],
    [4.95, -0.34], [3.47, 0.69], [1.12, 0.64], [0.35, 0.38]], { offset: 0.006 })
  shellPanel(mesh, shell, 'windowSeal', [[0, -0.57], [0.87, -0.42], [0.96, 0.15],
    [0.65, 0.67], [0, 0.69]], { front: true, minZ: 3.2, offset: 0.01 })
  const windows = [
    windowContour(0.60, 1.40, -0.44, 0.46, 0.11),
    windowContour(1.56, 2.73, -0.46, 0.52, 0.1),
    [[2.90, -0.44], [4.25, -0.40], [4.32, -0.22], [3.42, 0.55], [2.94, 0.55]],
  ]
  for (const pane of windows) shellPanel(mesh, shell, 'aircraftGlass', pane, { offset: 0.025 })
  shellPanel(mesh, shell, 'aircraftGlass', [[0.035, -0.24], [0.55, -0.31], [0.78, -0.12],
    [0.76, 0.23], [0.52, 0.60], [0.035, 0.63]], { front: true, minZ: 3.3, offset: 0.024 })
  shellPanel(mesh, shell, 'aircraftGlass', [[0.06, -0.52], [0.47, -0.53], [0.62, -0.41],
    [0.48, -0.36], [0.06, -0.31]], { front: true, minZ: 4.3, offset: 0.024 })
  // Lower doors, handles and sliding-door rails stay on the curved shell.
  for (const contour of [windowContour(1.45, 2.83, -0.94, 0.57, 0.08),
    [[2.89, -0.86], [3.72, -0.73], [4.31, -0.36], [3.43, 0.60], [2.89, 0.60]]]) {
    panelOutline(mesh, shell, contour, 'wingMetal', 0.011)
  }
  for (const z of [1.68, 3.04]) {
    shellPanel(mesh, shell, 'windowSeal', windowContour(z, z + 0.13, -0.65, -0.59, 0.025), { offset: 0.02 })
  }
  shellPanel(mesh, shell, 'wingMetal', [[0.18, -0.61], [2.77, -0.61], [2.77, -0.58], [0.18, -0.58]], { offset: 0.018 })
  shellPanel(mesh, shell, 'aircraftBlue', [[-3.6, 0.04], [-0.9, -0.47], [0.26, -0.97],
    [0.35, -0.65], [-0.6, -0.12], [-3.6, 0.27]])
  shellPanel(mesh, shell, 'aircraftBlue', [[0.8, -1.08], [3.6, -0.86], [3.62, -0.75], [0.8, -0.92]])
  // A tapering engine cowling blends into the shoulders, with two exhausts
  // at the rear. Its crown falls away forward of the gearbox.
  shapedShell(mesh, 'airframe', [
    [-1.85, 0.40, 0.31, 0.64], [-1.3, 0.90, 0.38, 0.92],
    [-0.65, 1.45, 0.44, 1.14], [0.10, 1.60, 0.50, 1.30],
    [0.70, 1.51, 0.52, 1.22], [1.55, 1.05, 0.61, 0.98], [2.10, 0.26, 0.69, 0.76],
  ])
  for (const side of [-1, 1]) {
    ellipsoid(mesh, 'windowSeal', [side * 0.65, 0.89, 0.88], [0.075, 0.17, 0.33], 16, 8)
    exhaust(mesh, [side * 0.57, 0.82, -0.74], [side * 0.69, 0.83, -1.25], 0.16)
    for (let i = 0; i < 6; i++) {
      rod(mesh, 'wingMetal', [side * 0.742, 0.70, 0.54 - i * 0.075],
        [side * 0.72, 1.02, 0.54 - i * 0.075], 0.009, 6)
    }
  }
  const rotorY = height / 2 - 0.07
  rod(mesh, 'engineMetal', [0, 1.19, 0], [0, rotorY, 0], 0.085, 16)
  ellipsoid(mesh, 'engineMetal', [0, rotorY - 0.055, 0], [0.28, 0.09, 0.28], 16, 8)
  for (let k = 0; k < 5; k++) {
    const a = 0.22 + k * Math.PI * 2 / 5
    rotorBlade(mesh, [0, rotorY, 0], 'y', a, width / 2 - 0.045, 0.25)
    rod(mesh, 'engineMetal', [0.18 * Math.cos(a), 1.39, 0.18 * Math.sin(a)],
      [0.42 * Math.cos(a), rotorY, 0.42 * Math.sin(a)], 0.025, 8)
  }
  disc(mesh, 'rotorBlur', 0, rotorY - 0.012, 0, width / 2, 0.01, 'y')
  // The duct is the fin's lower body. No solid fin or boom crosses its
  // aperture: daylight must be visible between the ten fan blades.
  const fanY = 0.14, fanZ = -4.27, outerR = 0.83, innerR = 0.60
  const shroud = createMesh()
  const rings = [[-0.12, outerR - 0.03], [0, outerR], [0.15, outerR - 0.03],
    [0.18, innerR + 0.035], [0.12, innerR], [-0.12, innerR],
    [-0.18, innerR + 0.035]].map(([x, r]) => ngon(x, fanY, fanZ, r, 'x'))
  for (let k = 0; k < rings.length; k++) {
    const next = (k + 1) % rings.length
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      quad(shroud, k === 4 ? 'engineMetal' : 'airframe', rings[k][i], rings[k][j], rings[next][j], rings[next][i])
    }
  }
  mergeMesh(mesh, smoothSurface(shroud, 48))
  for (let k = 0; k < 10; k++) rotorBlade(mesh, [0, fanY, fanZ], 'x', k * Math.PI / 5, innerR * 0.97, 0.075, 'engineMetal')
  disc(mesh, 'rotorBlur', 0, fanY, fanZ, innerR - 0.01, 0.015, 'x')
  rod(mesh, 'engineMetal', [-0.15, fanY, fanZ], [0.15, fanY, fanZ], 0.12, 16)
  // Swept upper fin starts ABOVE the opening. The forward fairing joins
  // the boom to the outside of the ring without plugging it.
  fin(mesh, 'aircraftBlue', { zRoot: -3.93, rootChord: 1.08, tipChord: 0.58,
    yRoot: 0.91, top: 1.65, sweep: 0.48 })
  slab(mesh, 'airframe', [[0, 0.29, -3.50], [0, 0.81, -3.86],
    [0, 1.02, -4.07], [0, 0.40, -3.59]], 0.18)
  stabilisers(mesh, 'airframe', { rootX: 0, y: 1.60, zRoot: -4.22,
    rootChord: 0.67, tipChord: 0.40, halfSpan: 1.35, sweep: 0.10, dihedral: 0 })
  // Long skids carry the cabin, with upturned toes and cross tubes.
  for (const side of [-1, 1]) {
    const x = side * 1.04
    rod(mesh, 'chassis', [x, ground + 0.055, -0.4], [x, ground + 0.055, 3.35], 0.055)
    rod(mesh, 'chassis', [x, ground + 0.055, 3.35], [x, ground + 0.28, 3.85], 0.055)
    for (const z of [0.23, 2.62]) {
      rod(mesh, 'chassis', [x, ground + 0.08, z], [side * 0.79, -1.03, z - 0.10], 0.045)
      rod(mesh, 'chassis', [side * 0.79, -1.03, z - 0.10], [0, -1.03, z - 0.10], 0.045)
    }
    rod(mesh, 'chassis', [side * 1.05, -1.1, 0.75], [side * 1.05, -1.1, 2.15], 0.035)
    for (const z of [0.75, 2.15]) {
      rod(mesh, 'chassis', [side * 1.05, -1.1, z], [side * 0.65, -0.96, z], 0.025, 8)
    }
  }
  mesh.lights = {
    port: [1.12, -0.1, 1.2], starboard: [-1.12, -0.1, 1.2],
    tail: [0, 0.3, -length / 2 - 0.25], beaconTop: [0, 1.42, -0.6],
    beaconBottom: [0, -1.25, 1.5],
  }
  return mesh
}

/** Archetype name → builder, mirrored by AIRCRAFT_DIMS. */
export const AIRCRAFT = {
  'aircraft-narrowbody': aircraftNarrowbody,
  'aircraft-widebody': aircraftWidebody,
  'aircraft-jumbo': aircraftJumbo,
  'aircraft-bizjet': aircraftBizjet,
  'aircraft-turboprop': aircraftTurboprop,
  'aircraft-light': aircraftLight,
  'aircraft-helicopter': aircraftHelicopter,
}
