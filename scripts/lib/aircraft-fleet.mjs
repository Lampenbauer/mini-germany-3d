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
 * The cockpit windows: a narrow band of three panes a side – the two
 * windscreens and the side window – from about 20° to 55° above the
 * centre line, where the nose has begun to drop, two to four metres
 * from the tip. Two strips, one on the upper part of the flank face and
 * one on the lower part of the cheek face, meeting at the faces' seam.
 */
function cockpit(mesh, shell, length) {
  const zFrom = length * 0.405
  const zTo = length * 0.455
  glaze(mesh, shell, [4, 11], zFrom, zTo, { panes: 3, band: [0.55, 1] })
  glaze(mesh, shell, [5, 10], zFrom, zTo, { panes: 3, band: [0, 0.8] })
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
 * A regional turboprop – the ATR and the Dash 8: a high straight wing
 * with an engine nacelle and a propeller disc on each side, a T-tail,
 * and the fuselage hanging under it all.
 */
export function aircraftTurboprop() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-turboprop']
  const ground = -height / 2
  const fuselageW = 2.87
  const fuselageH = 3.0
  const yc = ground + height * 0.17 + fuselageH / 2
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, tailRise: 0.4, taper: 0.3 })
  cockpit(mesh, shell, length)
  cabinDoors(mesh, shell, length, fuselageH)
  portholeRow(mesh, shell, -length * 0.12, length * 0.3, { pitch: 0.62 })
  const wingY = yc + fuselageH * 0.48
  const rootChord = length * 0.1
  const halfSpan = width / 2
  const wingZ = length * 0.08 + rootChord / 2
  const tipChord = rootChord * 0.55
  const tipY = wingY + halfSpan * 0.02
  // The wing box over the cabin the wing grows out of
  roundedBox(mesh, 'airframe', 0, wingY, wingZ - rootChord * 0.45, fuselageW * 0.7, fuselageH * 0.28, rootChord * 1.1)
  for (const side of [-1, 1]) {
    wing(mesh, 'wingMetal', side, {
      rootX: fuselageW * 0.3,
      rootY: wingY,
      rootZ: wingZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ: wingZ - rootChord * 0.15,
      tipChord,
      thickness: rootChord * 0.12,
    })
    // Nacelle ahead of the wing, hanging a little under it; the prop before it
    const x = side * halfSpan * 0.3
    const nacelleD = fuselageH * 0.42
    const nacelleZ = wingZ + rootChord * 0.3
    tube(
      mesh,
      'airframe',
      x,
      wingY - nacelleD * 0.25,
      nacelleD / 2,
      [
        { z: nacelleZ - rootChord * 1.3, s: 0.6 },
        { z: nacelleZ - rootChord * 0.2, s: 1 },
        { z: nacelleZ + rootChord * 0.9, s: 0.85 },
      ],
      ['airframe', 'chassis'],
    )
    disc(mesh, 'rotor', x, wingY - nacelleD * 0.25, nacelleZ + rootChord * 0.95, width * 0.072, 0.05, 'z')
    ellipsoid(mesh, 'engineMetal', [x, wingY - nacelleD * 0.25, nacelleZ + rootChord], [nacelleD * 0.22, nacelleD * 0.22, nacelleD * 0.38], 20, 10)
  }
  const finRootZ = -length / 2 + length * 0.3
  fin(mesh, 'hullBlue', {
    zRoot: finRootZ,
    rootChord: length * 0.25,
    tipChord: length * 0.11,
    yRoot: yc + fuselageH * 0.3,
    top: height / 2 - 0.08,
    sweep: (height / 2 - yc) * 0.55,
  })
  stabilisers(mesh, 'wingMetal', {
    rootX: 0,
    y: height / 2 - 0.12,
    zRoot: finRootZ - (height / 2 - yc) * 0.55,
    rootChord: length * 0.11,
    tipChord: length * 0.06,
    halfSpan: width * 0.14,
    sweep: width * 0.03,
    dihedral: 0,
  })
  const wheel = fuselageH * 0.24
  const gearPart = (mesh.parts.gear = createMesh())
  gear(gearPart, { x: 0, z: length * 0.36, yTop: yc - fuselageH * 0.3, yGround: ground, wheel: wheel * 0.8 })
  for (const side of [-1, 1]) {
    // The main gear of a high-wing turboprop folds into fairings on the fuselage
    ellipsoid(mesh, 'airframe', [side * fuselageW * 0.45, yc - fuselageH * 0.35, wingZ - rootChord * 0.6], [fuselageW * 0.22, fuselageH * 0.2, rootChord * 0.8])
    gear(gearPart, { x: side * fuselageW * 0.5, z: wingZ - rootChord * 0.6, yTop: yc - fuselageH * 0.35, yGround: ground, wheel })
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: wingZ - rootChord * 0.15 - tipChord * 0.4,
    tailY: yc + fuselageH * 0.4,
    tailZ: -length / 2,
    topY: yc + fuselageH / 2,
    topZ: -length * 0.08,
    bottomY: yc - fuselageH / 2,
    bottomZ: length * 0.1,
  })
  return mesh
}

/**
 * A light single – the Cessna 172 and everything else that flies from
 * the club airfields: a high strut-braced wing, one propeller on the
 * nose, a fixed tricycle undercarriage, a plain tail.
 */
export function aircraftLight() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-light']
  const ground = -height / 2
  const fuselageW = 1.1
  const fuselageH = 1.3
  const yc = ground + height * 0.28 + fuselageH / 2
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, tailRise: 0.25, noseDroop: 0.05, taper: 0.4 })
  // Cabin glazing all round the front half: the cheeks and the flanks
  glaze(mesh, shell, [4, 5, 6, 9, 10, 11], length * 0.02, length * 0.3, { panes: 2 })
  const wingY = height / 2 - 0.25
  const rootChord = length * 0.19
  const halfSpan = width / 2
  const wingZ = length * 0.14 + rootChord / 2
  const tipChord = rootChord * 0.85
  const tipY = wingY + halfSpan * 0.01
  for (const side of [-1, 1]) {
    wing(mesh, 'airframe', side, {
      rootX: 0,
      rootY: wingY,
      rootZ: wingZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ: wingZ,
      tipChord,
      thickness: rootChord * 0.12,
    })
    // Wing strut from the lower fuselage to mid-span
    slab(
      mesh,
      'chassis',
      [
        [side * fuselageW * 0.5, yc - fuselageH * 0.3, wingZ - rootChord * 0.3],
        [side * halfSpan * 0.55, wingY - 0.05, wingZ - rootChord * 0.3],
        [side * halfSpan * 0.55, wingY - 0.05, wingZ - rootChord * 0.36],
        [side * fuselageW * 0.5, yc - fuselageH * 0.3, wingZ - rootChord * 0.36],
      ],
      0.05,
    )
  }
  disc(mesh, 'rotor', 0, yc, length / 2 + 0.02, width * 0.086, 0.04, 'z')
  const finRootZ = -length / 2 + length * 0.22
  fin(mesh, 'hullBlue', {
    zRoot: finRootZ,
    rootChord: length * 0.2,
    tipChord: length * 0.1,
    yRoot: yc + fuselageH * 0.25,
    top: height / 2 - 0.35,
    sweep: length * 0.06,
  })
  stabilisers(mesh, 'airframe', {
    rootX: 0,
    y: yc + fuselageH * 0.2,
    zRoot: -length / 2 + length * 0.12,
    rootChord: length * 0.11,
    tipChord: length * 0.08,
    halfSpan: width * 0.16,
    sweep: length * 0.02,
  })
  const wheel = 0.42
  gear(mesh, { x: 0, z: length * 0.3, yTop: yc - fuselageH * 0.4, yGround: ground, wheel: wheel * 0.85, twin: false })
  for (const side of [-1, 1]) {
    gear(mesh, { x: side * fuselageW * 0.9, z: length * 0.02, yTop: yc - fuselageH * 0.4, yGround: ground, wheel, twin: false })
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: wingZ - tipChord * 0.4,
    tailY: yc + fuselageH * 0.25,
    tailZ: -length / 2,
    topY: height / 2 - 0.35,
    topZ: finRootZ - length * 0.06 - length * 0.05,
    bottomY: yc - fuselageH / 2,
    bottomZ: length * 0.05,
  })
  return mesh
}

/**
 * A light twin-engined helicopter – the EC135 of the police and the
 * air ambulances, the H145 and the AS350 by scaling: a glazed cabin, a
 * tail boom to a shrouded tail rotor, the main rotor as a disc, skids.
 * The length is the fuselage's, nose to tail rotor; the disc reaches
 * over the nose and stops short of the tail.
 */
export function aircraftHelicopter() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-helicopter']
  const ground = -height / 2
  const rotorR = width / 2
  // Rotor hub at z = 0; the disc spans ±rotorR, the boom runs on behind it
  const cabinL = 5.4
  const cabinW = 2.0
  const cabinH = 1.75
  const yc = ground + 0.95 + cabinH / 2
  const cabinZ = 1.4
  // A rounded, drooping nose under the broad windscreen. The glass
  // follows the shell, leaving the chin and the tip in painted metal.
  const shell = body(
    mesh,
    'airframe',
    roundProfile(cabinW, cabinH, yc),
    [
      { z: cabinZ - cabinL / 2, sx: 0.55, sy: 0.7, yOff: cabinH * 0.12 },
      { z: cabinZ - cabinL * 0.15 },
      { z: cabinZ + cabinL * 0.2 },
      { z: cabinZ + cabinL * 0.42, sx: 0.8, sy: 0.85, yOff: -cabinH * 0.05 },
      { z: cabinZ + cabinL * 0.46, sx: 0.6, sy: 0.64, yOff: -cabinH * 0.1 },
      { z: cabinZ + cabinL * 0.49, sx: 0.28, sy: 0.32, yOff: -cabinH * 0.15 },
      { z: cabinZ + cabinL / 2, sx: 0.025, sy: 0.06, yOff: -cabinH * 0.18 },
    ],
    yc,
    ['airframe', 'airframe'],
  )
  // The doors' windows and the cheeks of the nose, on the shell
  glaze(mesh, shell, [4, 5, 10, 11], cabinZ - cabinL * 0.05, cabinZ + cabinL * 0.18, { panes: 2 })
  glaze(mesh, shell, [4, 5, 6, 9, 10, 11], cabinZ + cabinL * 0.22, cabinZ + cabinL * 0.49)
  // Engine cowling and the rotor mast over the cabin's rear half
  const cowlY = yc + cabinH / 2
  ellipsoid(mesh, 'airframe', [0, cowlY + 0.1, cabinZ - cabinL * 0.12], [cabinW * 0.4, 0.4, cabinL * 0.27])
  const rotorY = height / 2 - 0.05
  box(mesh, 'chassis', 0, (cowlY + 0.5 + rotorY - 0.03) / 2, 0, 0.3, rotorY - 0.03 - cowlY - 0.5, 0.3)
  disc(mesh, 'rotor', 0, rotorY, 0, rotorR, 0.04, 'y')
  // Tail boom from the cabin to the fenestron, tapering
  const boomStart = cabinZ - cabinL / 2 + 0.3
  const boomEnd = -length / 2 + 0.05
  const boomY = yc + cabinH * 0.15
  tube(mesh, 'airframe', 0, boomY, 0.45, [
    { z: boomEnd + 1.2, s: 0.55 },
    { z: boomStart, s: 1 },
  ])
  // Fenestron: an annular shroud with its translucent fan visible through
  // the opening, and a swept fin growing above it.
  const tailCentre = [0, boomY + 0.2, boomEnd + 0.7]
  const shroud = createMesh()
  const rings = [[-0.14, 0.55], [0.14, 0.55], [0.14, 0.43], [-0.14, 0.43]].map(([x, r]) => ngon(x, tailCentre[1], tailCentre[2], r, 'x'))
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      const next = (k + 1) % 4
      quad(shroud, 'hullBlue', rings[k][i], rings[k][j], rings[next][j], rings[next][i])
    }
  }
  mergeMesh(mesh, smoothSurface(shroud, 40))
  slab(mesh, 'hullBlue', [[0, boomY + 0.68, boomEnd + 1.1], [0, boomY + 1.0, boomEnd + 0.6], [0, boomY + 1.0, boomEnd], [0, boomY - 0.35, boomEnd + 0.05]], 0.16)
  disc(mesh, 'rotor', 0, tailCentre[1], tailCentre[2], 0.425, 0.08, 'x')
  rod(mesh, 'engineMetal', [-0.16, tailCentre[1], tailCentre[2]], [0.16, tailCentre[1], tailCentre[2]], 0.07)
  // A small horizontal stabiliser on the boom
  stabilisers(mesh, 'airframe', {
    rootX: 0,
    y: boomY + 0.1,
    zRoot: boomEnd + 2.6,
    rootChord: 0.5,
    tipChord: 0.4,
    halfSpan: 1.3,
    sweep: 0,
  })
  // Skids: two tubes on cross-struts, on the ground
  for (const side of [-1, 1]) {
    rod(mesh, 'chassis', [side * cabinW * 0.55, ground + 0.06, cabinZ - 0.3 - cabinL * 0.31], [side * cabinW * 0.55, ground + 0.06, cabinZ - 0.3 + cabinL * 0.31], 0.06)
    rod(mesh, 'chassis', [side * cabinW * 0.55, ground + 0.06, cabinZ - 0.3 + cabinL * 0.31], [side * cabinW * 0.55, ground + 0.25, cabinZ + cabinL * 0.34], 0.06)
    for (const z of [cabinZ - cabinL * 0.3, cabinZ + cabinL * 0.15]) {
      rod(mesh, 'engineMetal', [side * cabinW * 0.55, ground + 0.13, z], [side * cabinW * 0.3, yc - cabinH / 2 + 0.1, z], 0.045)
    }
  }
  // The position lights on the cabin's sides, the beacon on the fin, the
  // tail light at the end of the boom
  mesh.lights = {
    port: [cabinW / 2 + 0.2, yc, cabinZ - cabinL * 0.2],
    starboard: [-cabinW / 2 - 0.2, yc, cabinZ - cabinL * 0.2],
    tail: [0, boomY, boomEnd - 0.2],
    beaconTop: [0, boomY + 1.2, boomEnd + 0.6],
    beaconBottom: [0, yc - cabinH / 2 - 0.2, cabinZ],
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
