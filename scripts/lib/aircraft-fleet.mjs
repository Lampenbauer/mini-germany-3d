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
 * A rounded-rectangle cross-section on the same thirty-two angles as
 * roundProfile – a superellipse of exponent `power` (2 is the ellipse,
 * 4 nearly a box with round corners): the slab-sided cabin of a light
 * aircraft or a helicopter, whose doors are flat and whose roof is flat.
 * The same angular frame, so the glazing's sixteen faces mean the same.
 */
function superProfile(w, h, yc, power = 4) {
  const pts = []
  const k = 2 / power
  for (let i = 0; i < SIDES; i++) {
    const a = -Math.PI / 2 + Math.PI / 16 + ((2 * Math.PI) / SIDES) * i
    const c = Math.cos(a)
    const s = Math.sin(a)
    pts.push([(w / 2) * Math.sign(c) * Math.abs(c) ** k, yc + (h / 2) * Math.sign(s) * Math.abs(s) ** k])
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
 * A regional turboprop, modelled on the ATR 72-600 – the type that
 * carries most of Germany's turboprop traffic, and the Dash 8 and the
 * Saab by scaling: a slender round fuselage with the jets' forebody and
 * cockpit under a high straight wing, the long nacelles slung ahead of
 * and under it with six-bladed propellers on pointed spinners, the rear
 * fuselage swept up under a tall swept fin with its dorsal fillet and
 * the stabilisers on top, and the main gear folding into sponsons on
 * the lower fuselage (2026-09-17; before it was a generic high-wing
 * twin with a stub tail).
 */
export function aircraftTurboprop() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-turboprop']
  const ground = -height / 2
  const fuselageW = 2.87
  const fuselageH = 2.87
  // The fuselage a metre over the apron: the ATR stands low on short legs
  const yc = ground + 1.05 + fuselageH / 2
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, tailRise: 0.42, taper: 0.32, jetNose: true })
  jetCockpit(mesh, shell, { length, w: fuselageW, h: fuselageH, yc })
  cabinDoors(mesh, shell, length, fuselageH, length * 0.3)
  portholeRow(mesh, shell, -length * 0.2, length * 0.27, { pitch: 0.62, w: 0.34, h: 0.4 })
  // The wing on the crown, straight, with the fairing it grows out of
  const wingY = yc + fuselageH / 2 + 0.3
  const rootChord = 2.75
  const tipChord = 1.55
  const halfSpan = width / 2
  const rootZ = 2.9
  const tipZ = 2.35
  const tipY = wingY + halfSpan * 0.01
  roundedBox(mesh, 'airframe', 0, wingY - 0.12, rootZ - rootChord * 0.45, fuselageW * 0.8, 0.55, rootChord * 1.25, 0.16)
  for (const side of [-1, 1]) {
    wing(mesh, 'wingMetal', side, {
      rootX: fuselageW * 0.35,
      rootY: wingY,
      rootZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ,
      tipChord,
      thickness: rootChord * 0.15,
    })
    // The nacelle: long, slung under the leading edge and reaching well
    // ahead of it, the intake scoop under the spinner, the exhausts on top
    const x = side * 4.05
    const nacelleR = 0.6
    const nacelleY = wingY - 0.42
    tube(
      mesh,
      'airframe',
      x,
      nacelleY,
      nacelleR,
      [
        { z: -1.6, s: 0.55 },
        { z: 0.2, s: 0.82 },
        { z: 2.0, s: 1 },
        { z: 4.6, s: 1 },
        { z: 5.15, s: 0.78 },
      ],
      ['airframe', 'chassis'],
    )
    roundedBox(mesh, 'chassis', x, nacelleY - nacelleR * 0.85, 4.55, 0.55, 0.32, 0.8, 0.08)
    for (const dx of [-0.26, 0.26]) {
      rod(mesh, 'engineMetal', [x + dx, nacelleY + nacelleR * 0.8, 3.5], [x + dx, nacelleY + nacelleR * 0.98, 2.9], 0.1, 8)
    }
    // Six blades in the blur of their disc, on a pointed spinner
    const propZ = 5.28
    disc(mesh, 'rotor', x, nacelleY, propZ, 1.96, 0.06, 'z')
    ellipsoid(mesh, 'engineMetal', [x, nacelleY, 5.45], [0.3, 0.3, 0.55], 12, 6)
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3
      rod(mesh, 'chassis', [x + 0.2 * Math.cos(a), nacelleY + 0.2 * Math.sin(a), propZ], [x + 1.1 * Math.cos(a), nacelleY + 1.1 * Math.sin(a), propZ], 0.06, 6)
    }
  }
  // The tail: a tall swept fin with a long dorsal fillet, the
  // stabilisers across its top
  const finRootZ = -length / 2 + 6.4
  const finTop = height / 2 - 0.14
  const finSweep = 2.6
  fin(mesh, 'hullBlue', {
    zRoot: finRootZ,
    rootChord: 5.4,
    tipChord: 2.3,
    yRoot: yc + fuselageH * 0.36,
    top: finTop,
    sweep: finSweep,
  })
  // The fillet is a convex quad: a fourth corner inside the others' triangle
  // would wind its second triangle against the slab's normal
  slab(mesh, 'hullBlue', [[0, yc + 1.4, -3.3], [0, yc + 1.3, finRootZ + 0.2], [0, yc + 2.5, finRootZ - 0.4], [0, yc + 1.75, -3.7]], 0.1)
  stabilisers(mesh, 'wingMetal', {
    rootX: 0,
    y: finTop - 0.02,
    zRoot: finRootZ - finSweep + 0.3,
    rootChord: 2.5,
    tipChord: 1.35,
    halfSpan: width * 0.14,
    sweep: 0.6,
    dihedral: 0,
  })
  // Undercarriage: the nose leg under the cockpit, the mains under
  // their sponsons on the lower fuselage – all in the part the layer
  // folds away in the air
  const gearPart = (mesh.parts.gear = createMesh())
  gear(gearPart, { x: 0, z: 9.6, yTop: yc - fuselageH * 0.3, yGround: ground, wheel: 0.55 })
  for (const side of [-1, 1]) {
    ellipsoid(mesh, 'airframe', [side * 1.35, yc - 1.15, 1.2], [0.75, 0.55, 2.2], 14, 7)
    gear(gearPart, { x: side * 1.45, z: 1.0, yTop: yc - 1.2, yGround: ground, wheel: 0.86 })
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: tipZ - tipChord * 0.4,
    tailY: yc + fuselageH * 0.42,
    tailZ: -length / 2,
    topY: yc + fuselageH / 2,
    topZ: -1,
    bottomY: yc - fuselageH / 2,
    bottomZ: 3,
  })
  return mesh
}

/**
 * A light single, modelled on the Cessna 172 Skyhawk – and everything
 * else that flies from the club airfields by scaling: a slab-sided
 * cabin under a strut-braced high wing that lies on its roof, the
 * windscreen raked back from the cowling to the wing's leading edge,
 * the rear window wrapping round the cabin's back, a tapered rear
 * fuselage to a swept fin with its dorsal fillet, the propeller on its
 * spinner, and the fixed tricycle gear on sprung legs (2026-09-17;
 * before it was a round tube with a wing on stilts).
 */
export function aircraftLight() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-light']
  const ground = -height / 2
  const nose = length / 2
  const tail = -length / 2
  // The cabin: a metre wide, its floor half a metre over the wheels' ground
  const cabinW = 1.06
  const cabinH = 1.28
  const yc = ground + 0.56 + cabinH / 2
  const shell = body(
    mesh,
    'airframe',
    superProfile(cabinW, cabinH, yc, 3.2),
    [
      { z: tail, sx: 0.1, sy: 0.3, yOff: cabinH * 0.16 },
      { z: tail + 1.2, sx: 0.3, sy: 0.5, yOff: cabinH * 0.12 },
      { z: tail + 2.6, sx: 0.66, sy: 0.76, yOff: cabinH * 0.05 },
      { z: -0.75 },
      { z: 1.25 },
      // The windscreen: the roof line falls to the cowling over half a
      // metre, and the belly rises a little toward the nose – the thrust
      // line stays near the cabin's centre, the propeller clear of the ground
      { z: 1.75, sx: 0.96, sy: 0.7, yOff: -cabinH * 0.08 },
      { z: 2.9, sx: 0.9, sy: 0.6, yOff: -cabinH * 0.06 },
      { z: 3.75, sx: 0.66, sy: 0.5, yOff: -cabinH * 0.05 },
      { z: 3.9, sx: 0.4, sy: 0.34, yOff: -cabinH * 0.05 },
    ],
    yc,
    ['airframe', 'airframe'],
  )
  // Glazing on the shell: the windscreen over the cowling, the door and
  // rear side windows on the flanks, the rear window round the back
  glaze(mesh, shell, [5, 6, 7, 8, 9, 10], 1.27, 1.73)
  glaze(mesh, shell, [4, 11], -0.7, 1.2, { panes: 2, band: [0, 0.9] })
  glaze(mesh, shell, [3, 12], -0.7, 1.2, { panes: 2, band: [0.6, 1] })
  glaze(mesh, shell, [5, 6, 7, 8, 9, 10], -1.45, -0.8)
  // The engine: the spinner and the propeller's disc ahead of the cowling,
  // the two intakes either side of the spinner, the exhaust under it
  const cowlY = yc - cabinH * 0.05
  ellipsoid(mesh, 'engineMetal', [0, cowlY, 3.92], [0.2, 0.2, 0.22], 16, 8)
  disc(mesh, 'rotor', 0, cowlY, 3.98, 0.95, 0.04, 'z')
  for (const side of [-1, 1]) roundedBox(mesh, 'chassis', side * 0.28, cowlY - 0.04, 3.88, 0.22, 0.16, 0.08, 0.03)
  rod(mesh, 'engineMetal', [0.2, cowlY - 0.42, 3.2], [0.2, cowlY - 0.5, 2.7], 0.035, 8)
  // The wing on the roof: constant chord inboard, tapered outboard,
  // a little dihedral, no sweep; the struts from the door sills to mid-span
  const wingY = yc + cabinH / 2 + 0.1
  const rootChord = 1.65
  const tipChord = 1.15
  const halfSpan = width / 2
  const wingZ = 1.35
  const tipY = wingY + halfSpan * 0.03
  for (const side of [-1, 1]) {
    wing(mesh, 'airframe', side, {
      rootX: 0,
      rootY: wingY,
      rootZ: wingZ,
      rootChord,
      tipX: halfSpan,
      tipY,
      tipZ: wingZ - 0.12,
      tipChord,
      thickness: rootChord * 0.12,
    })
    slab(
      mesh,
      'wingMetal',
      [
        [side * 0.5, yc - 0.45, 1.0],
        [side * 2.6, wingY - 0.12, 1.05],
        [side * 2.6, wingY - 0.12, 0.91],
        [side * 0.5, yc - 0.45, 0.86],
      ],
      0.05,
    )
  }
  // The tail: the swept fin with its dorsal fillet, the stabiliser low
  const finTop = height / 2
  fin(mesh, 'airframe', { zRoot: -2.45, rootChord: 1.5, tipChord: 0.62, yRoot: yc + 0.5, top: finTop, sweep: 0.62 })
  slab(mesh, 'airframe', [[0, yc + 0.6, -1.3], [0, yc + 0.6, -2.5], [0, yc + 1.0, -2.75], [0, yc + 0.72, -1.45]], 0.06)
  stabilisers(mesh, 'airframe', {
    rootX: 0.1,
    y: yc + 0.22,
    zRoot: -3.05,
    rootChord: 1.1,
    tipChord: 0.72,
    halfSpan: 1.7,
    sweep: 0.12,
    dihedral: 0,
  })
  // Fixed gear: the nose leg under the cowling, the mains on flat spring
  // legs out of the belly – part of the body, nothing folds
  gear(mesh, { x: 0, z: 3.0, yTop: yc - cabinH * 0.5, yGround: ground, wheel: 0.36, twin: false })
  for (const side of [-1, 1]) {
    const axle = [side * 1.15, ground + 0.22, 0.45]
    rod(mesh, 'wingMetal', [side * 0.3, yc - cabinH / 2 + 0.02, 0.35], axle, 0.035, 8)
    disc(mesh, 'chassis', axle[0], axle[1], axle[2], 0.22, 0.15, 'x')
    disc(mesh, 'wingMetal', axle[0], axle[1], axle[2], 0.09, 0.19, 'x')
  }
  lights(mesh, {
    halfSpan,
    tipY,
    tipZ: wingZ - 0.12 - tipChord * 0.4,
    tailY: yc + 0.35,
    tailZ: tail,
    topY: finTop - 0.25,
    topZ: -3.38,
    bottomY: yc - cabinH / 2,
    bottomZ: 0.6,
  })
  return mesh
}

/**
 * A light twin-engined helicopter, modelled on Airbus's H140 and H145 –
 * the EC135 of the police and the air ambulances by scaling: a rounded
 * cabin glazed all over its nose, the sliding doors' windows on its
 * flanks, the engine deck on its roof with the intakes and exhausts,
 * the rotor mast and hub with the blades' roots in the blur of the
 * disc, the boom rising to the fenestron in its big swept fin with the
 * stabiliser across the fin's top, and skids. The length is the
 * fuselage's, nose to tail; the disc reaches over the nose and stops
 * short of the tail (2026-09-17; before it was a capsule with a hump).
 */
export function aircraftHelicopter() {
  const mesh = createMesh()
  const { length, width, height } = AIRCRAFT_DIMS['aircraft-helicopter']
  const ground = -height / 2
  const nose = length / 2
  const tail = -length / 2
  const rotorR = width / 2
  const cabinW = 2.0
  const cabinH = 1.8
  // The cabin floor over the skids, the boom growing out of the cabin's
  // back and rising to the fin – one shell from the nose to the fin
  const yc = ground + 0.6 + cabinH / 2
  const shell = body(
    mesh,
    'airframe',
    superProfile(cabinW, cabinH, yc, 3),
    [
      { z: tail + 0.75, sx: 0.17, sy: 0.2, yOff: cabinH * 0.36 },
      { z: -2.6, sx: 0.24, sy: 0.27, yOff: cabinH * 0.3 },
      { z: -1.3, sx: 0.42, sy: 0.46, yOff: cabinH * 0.2 },
      { z: -0.3, sx: 0.78, sy: 0.84, yOff: cabinH * 0.07 },
      { z: 0.5 },
      { z: 2.9 },
      { z: 3.55, sx: 0.95, sy: 0.96, yOff: -cabinH * 0.03 },
      { z: 4.25, sx: 0.74, sy: 0.76, yOff: -cabinH * 0.17 },
      { z: 4.75, sx: 0.44, sy: 0.46, yOff: -cabinH * 0.33 },
      { z: nose - 0.03, sx: 0.24, sy: 0.24, yOff: -cabinH * 0.4 },
    ],
    yc,
    ['airframe', 'airframe'],
  )
  // The nose glazed over its whole upper half, the chin windows under
  // it, the doors' windows on the flanks
  glaze(mesh, shell, [4, 5, 6, 7, 8, 9, 10, 11], 3.6, 4.95, { panes: 2, gap: 0.12 })
  glaze(mesh, shell, [3, 12], 4.1, 4.85)
  glaze(mesh, shell, [4, 11], 0.75, 2.85, { panes: 2 })
  glaze(mesh, shell, [3, 12], 0.75, 2.85, { panes: 2, band: [0.45, 1] })
  // The engine deck on the roof: the cowling with its intakes forward
  // and the exhausts aft, the mast and the hub over its front
  const roofY = yc + cabinH / 2
  roundedBox(mesh, 'airframe', 0, roofY + 0.3, 0.4, cabinW * 0.78, 0.6, 3.0, 0.14)
  roundedBox(mesh, 'airframe', 0, roofY + 0.2, -1.4, 1.1, 0.4, 1.0, 0.1)
  for (const side of [-1, 1]) {
    roundedBox(mesh, 'chassis', side * 0.5, roofY + 0.5, 1.6, 0.35, 0.16, 0.5, 0.04)
    rod(mesh, 'engineMetal', [side * 0.42, roofY + 0.35, -1.05], [side * 0.42, roofY + 0.43, -1.55], 0.14, 10)
  }
  const rotorY = height / 2 - 0.05
  rod(mesh, 'chassis', [0, roofY + 0.6, 0], [0, rotorY - 0.08, 0], 0.1, 12)
  ellipsoid(mesh, 'chassis', [0, rotorY - 0.08, 0], [0.3, 0.1, 0.3], 16, 8)
  for (let k = 0; k < 5; k++) {
    const a = (k * 2 * Math.PI) / 5
    rod(mesh, 'chassis', [0.25 * Math.cos(a), rotorY - 0.04, 0.25 * Math.sin(a)], [1.3 * Math.cos(a), rotorY - 0.04, 1.3 * Math.sin(a)], 0.045, 6)
  }
  disc(mesh, 'rotor', 0, rotorY, 0, rotorR, 0.04, 'y')
  // The fin over the boom's end with the fenestron in it: an annular
  // shroud with its translucent fan, the stabiliser across the fin's top
  const finRootZ = -3.75
  fin(mesh, 'hullBlue', { zRoot: finRootZ, rootChord: 1.35, tipChord: 0.85, yRoot: 0.45, top: 1.6, sweep: 0.45 })
  const fanCentre = [0, 0.8, -4.45]
  const shroud = createMesh()
  const rings = [[-0.14, 0.55], [0.14, 0.55], [0.14, 0.43], [-0.14, 0.43]].map(([x, r]) => ngon(x, fanCentre[1], fanCentre[2], r, 'x'))
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      const next = (k + 1) % 4
      quad(shroud, 'hullBlue', rings[k][i], rings[k][j], rings[next][j], rings[next][i])
    }
  }
  mergeMesh(mesh, smoothSurface(shroud, 40))
  disc(mesh, 'rotor', 0, fanCentre[1], fanCentre[2], 0.425, 0.08, 'x')
  rod(mesh, 'engineMetal', [-0.16, fanCentre[1], fanCentre[2]], [0.16, fanCentre[1], fanCentre[2]], 0.07)
  rod(mesh, 'hullBlue', [0, 0.35, -4.15], [0, -0.3, -4.6], 0.05, 8)
  stabilisers(mesh, 'airframe', {
    rootX: 0,
    y: 1.5,
    zRoot: -4.05,
    rootChord: 0.62,
    tipChord: 0.42,
    halfSpan: 1.45,
    sweep: 0.05,
    dihedral: 0,
  })
  // Skids: two tubes with upturned toes on cross-tube legs, on the ground
  for (const side of [-1, 1]) {
    const x = side * 1.0
    rod(mesh, 'chassis', [x, ground + 0.06, 2.4], [x, ground + 0.06, -0.9], 0.06)
    rod(mesh, 'chassis', [x, ground + 0.06, 2.4], [x, ground + 0.4, 3.0], 0.06)
    for (const z of [1.9, -0.4]) {
      rod(mesh, 'engineMetal', [x, ground + 0.1, z], [side * 0.55, yc - cabinH / 2 + 0.05, z], 0.045)
    }
  }
  // The position lights on the cabin's sides, the beacon on the engine
  // deck, the tail light at the fin's trailing edge
  mesh.lights = {
    port: [cabinW / 2 + 0.2, yc + 0.1, 1.2],
    starboard: [-cabinW / 2 - 0.2, yc + 0.1, 1.2],
    tail: [0, 0.9, tail - 0.25],
    beaconTop: [0, roofY + 0.8, -0.6],
    beaconBottom: [0, yc - cabinH / 2 - 0.2, 1.5],
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
