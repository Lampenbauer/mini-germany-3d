/**
 * Low-poly aircraft for the ADS-B traffic, in the visual language of the
 * vehicle fleet and the shipyard (vehicle-fleet.mjs, vessel-fleet.mjs):
 * flat-shaded bodies, glass on the shell, the muted PBR palette – only
 * rounder than the vehicles, with sixteen-sided fuselages, nacelles and
 * wheels: an aircraft is all curves, and an octagonal fuselage read as a
 * pencil. One archetype per silhouette – the layer picks by ICAO type
 * designator (see aircraftSize in src/lib/aircraft-info.ts) and
 * stretches the model to the type's length, span and height, so the
 * A320 becomes an A321 by scaling, not by new geometry.
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
const SIDES = 16
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
  const rings = stations.map((st) => ngon(cx, cy, st.z, radius * (st.s ?? 1)))
  const centre = centroid(rings.flat())
  for (let s = 0; s < rings.length - 1; s++) {
    for (let i = 0; i < SIDES; i++) {
      const j = (i + 1) % SIDES
      quadOut(mesh, material, rings[s][i], rings[s][j], rings[s + 1][j], rings[s + 1][i], centre)
    }
  }
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
  for (let i = 0; i < SIDES; i++) {
    const j = (i + 1) % SIDES
    quadOut(mesh, material, a[i], a[j], b[j], b[i], centre)
  }
  capRing(mesh, material, a, centre)
  capRing(mesh, material, b, centre)
}

/**
 * The points of a rounded cross-section: an n-gon on the ellipse w wide
 * and h tall around (0, yc), counter-clockwise seen from +Z (the nose),
 * from the bottom right up the right side – with a flat at the top and
 * the bottom, like the vehicles' bevelled profile. The i-th face of a
 * ring built from it runs from point i to point i+1; with sixteen sides
 * the faces 4–6 are the right cheek above the centre line, 7 the roof,
 * 8–10 the left cheek, 11 the left flank just above the centre line –
 * the glazing helpers below pick faces by these numbers.
 */
function roundProfile(w, h, yc) {
  const pts = []
  for (let k = 0; k < SIDES; k++) {
    const a = -Math.PI / 2 + ((2 * Math.PI) / SIDES) * (k + 0.5)
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
function body(mesh, material, profile, stations, yAnchor, capMaterials) {
  extrude(mesh, profile, stations, { material, yAnchor, capMaterials })
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
  return { ringAt, stations }
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
  const paneLength = (zTo - zFrom - gap * (panes - 1)) / panes
  for (let n = 0; n < panes; n++) {
    const za = zFrom + n * (paneLength + gap)
    const zb = za + paneLength
    // A pane that crosses a station is bent at it, so it keeps to the shell
    const zs = [za, ...shell.stations.map((st) => st.z).filter((z) => z > za && z < zb), zb]
    for (let k = 0; k + 1 < zs.length; k++) {
      const r0 = shell.ringAt(zs[k])
      const r1 = shell.ringAt(zs[k + 1])
      for (const i of faces) {
        const j = (i + 1) % SIDES
        const a = lerp(r0[i], r0[j], band[0])
        const b = lerp(r0[i], r0[j], band[1])
        const c = lerp(r1[i], r1[j], band[1])
        const d = lerp(r1[i], r1[j], band[0])
        // The extrusion's own winding – its normal points out of the shell
        const off = scale(unit(cross(sub(b, a), sub(d, a))), GLASS_PROUD)
        quad(mesh, 'glass', add(a, off), add(b, off), add(c, off), add(d, off))
      }
    }
  }
}

/** The faces a cabin's window row lies on: both flanks from 11° to 34° above the centre line. */
const CABIN_FACES = [4, 11]
/** The row above it on a double-decker: the cheeks from 34° to 56°. */
const UPPER_DECK_FACES = [5, 10]

// ---------------------------------------------------------------------------
// Parts

/**
 * Fuselage: a round tube tapered to a raised tail cone aft and a
 * drooping nose forward, `length` long between the two tips, `w` wide
 * and `h` tall amidships around the centre line at yc. Returns the shell
 * for the glazing.
 */
/**
 * Fuselage: a round tube tapered to a raised tail cone aft and, forward,
 * to a nose that drops away under the cockpit – the top line falls to
 * the radome while the underside runs on nearly level, the way an
 * airliner's does (`noseDroop`, the tip's drop as a share of the
 * height). `length` long between the two tips, `w` wide and `h` tall
 * amidships around the centre line at yc. Returns the shell for the
 * glazing.
 */
function fuselage(mesh, { length, w, h, yc, tailRise = 0.3, noseDroop = 0.26, taper = 0.22 }) {
  return body(
    mesh,
    'hullWhite',
    roundProfile(w, h, yc),
    [
      { z: -length / 2, sx: 0.1, sy: 0.18, yOff: h * tailRise },
      { z: -length / 2 + length * taper * 0.45, sx: 0.5, sy: 0.6, yOff: h * tailRise * 0.6 },
      { z: -length / 2 + length * taper, sx: 0.86, sy: 0.92, yOff: h * tailRise * 0.2 },
      { z: -length * 0.12 },
      { z: length * 0.3 },
      { z: length * 0.38, sx: 0.985, sy: 0.985, yOff: -h * noseDroop * 0.05 },
      { z: length * 0.44, sx: 0.86, sy: 0.82, yOff: -h * noseDroop * 0.35 },
      { z: length * 0.475, sx: 0.6, sy: 0.55, yOff: -h * noseDroop * 0.72 },
      { z: length / 2, sx: 0.16, sy: 0.16, yOff: -h * noseDroop },
    ],
    yc,
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
 * A row of portholes along both flanks: a small octagonal pane every
 * `pitch` – an airliner's frame pitch – each laid flat on the shell
 * a hand above the centre line, where the windows of every airliner
 * sit. An octagon a window, one fan of nine vertices: at the distance
 * the map is looked at from a window is a dot, and a dot with corners
 * is a rectangle.
 */
function portholeRow(mesh, shell, zFrom, zTo, { pitch = 0.53, w = 0.3, h = 0.42, faces = CABIN_FACES, at = 0.2 } = {}) {
  const n = Math.floor((zTo - zFrom) / pitch)
  const start = zFrom + (zTo - zFrom - n * pitch) / 2
  for (const i of faces) {
    const j = (i + 1) % SIDES
    for (let k = 0; k < n; k++) {
      const z = start + pitch * (k + 0.5)
      const r0 = shell.ringAt(z - w / 2)
      const r1 = shell.ringAt(z + w / 2)
      const a = lerp(r0[i], r0[j], at)
      const c = lerp(add(a, lerp(r1[i], r1[j], at)), [0, 0, 0], 0.5)
      // The window's own axes on the shell: up the face, forward along z
      const v = unit(sub(r0[j], r0[i]))
      const u = [0, 0, 1]
      const normal = unit(cross(sub(r0[j], r0[i]), sub(r1[i], r0[i])))
      const centre = add(c, scale(normal, GLASS_PROUD))
      const pts = []
      const cut = 1 / Math.cos(Math.PI / 8)
      for (let m = 0; m < 8; m++) {
        const angle = (Math.PI / 8) * (2 * m + 1)
        pts.push(add(centre, add(scale(u, (w / 2) * cut * Math.cos(angle)), scale(v, (h / 2) * cut * Math.sin(angle)))))
      }
      // Wound to face outward: reversed where the fan's own normal points in
      const fanNormal = cross(sub(pts[0], centre), sub(pts[1], centre))
      fan(mesh, 'glass', centre, dot(fanNormal, normal) < 0 ? pts.reverse() : pts)
    }
  }
}

/**
 * One wing panel, root to tip: swept back by the difference of the two
 * leading-edge z's, tapered from rootChord to tipChord, rising by the
 * dihedral. The root sits inside the fuselage so no seam shows.
 */
function wing(mesh, material, side, { rootX, rootY, rootZ, rootChord, tipX, tipY, tipZ, tipChord, thickness }) {
  slab(
    mesh,
    material,
    [
      [side * rootX, rootY, rootZ],
      [side * tipX, tipY, tipZ],
      [side * tipX, tipY, tipZ - tipChord],
      [side * rootX, rootY, rootZ - rootChord],
    ],
    thickness,
  )
}

/** The vertical fin, swept, from the fuselage top to `top`. */
function fin(mesh, material, { zRoot, rootChord, tipChord, yRoot, top, sweep }) {
  slab(
    mesh,
    material,
    [
      [0, yRoot, zRoot],
      [0, top, zRoot - sweep],
      [0, top, zRoot - sweep - tipChord],
      [0, yRoot, zRoot - rootChord],
    ],
    rootChord * 0.08,
  )
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
  tube(
    mesh,
    'body',
    x,
    y,
    diameter / 2,
    [
      { z: z - length / 2, s: 0.78 },
      { z: z - length * 0.15, s: 0.98 },
      { z: z + length / 2, s: 1 },
    ],
    ['chassis', 'chassis'],
  )
  if (pylonTo !== undefined) {
    const mid = (y + pylonTo) / 2
    box(mesh, 'body', x, mid, z - length * 0.1, diameter * 0.16, Math.abs(pylonTo - y) + 0.01, length * 0.6)
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
  box(mesh, 'chassis', x, (yTop + axleY) / 2, z, tyre * 0.55, yTop - axleY + 0.01, tyre * 0.55)
  const offsets = twin ? [-tyre * 0.62, tyre * 0.62] : [0]
  for (const dx of offsets) {
    disc(mesh, 'chassis', x + dx, axleY, z, r, tyre, 'x')
    disc(mesh, 'roof', x + dx, axleY, z, r * 0.42, tyre + 0.04, 'x')
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
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc })
  cockpit(mesh, shell, length)
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
    wing(mesh, 'roof', side, {
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
      'roof',
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
  stabilisers(mesh, 'roof', {
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
  const shell = fuselage(mesh, { length, w: fuselageW, h: fuselageH, yc, tailRise: 0.35, taper: 0.28 })
  cockpit(mesh, shell, length)
  portholeRow(mesh, shell, -length * 0.12, length * 0.28, { pitch: 0.95, w: 0.36, h: 0.46 })
  const wingY = yc - fuselageH * 0.3
  const rootChord = length * 0.2
  const halfSpan = width / 2
  const sweep = halfSpan * 0.4
  const wingZ = length * 0.02 + rootChord / 2
  const tipChord = rootChord * 0.3
  const tipY = wingY + halfSpan * 0.06
  for (const side of [-1, 1]) {
    wing(mesh, 'roof', side, {
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
    box(mesh, 'body', side * (fuselageW / 2 + engineD * 0.3), yc + fuselageH * 0.12, -length * 0.25, engineD * 0.8, engineD * 0.2, engineD * 1.3)
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
  stabilisers(mesh, 'roof', {
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
  portholeRow(mesh, shell, -length * 0.12, length * 0.3, { pitch: 0.62 })
  const wingY = yc + fuselageH * 0.48
  const rootChord = length * 0.1
  const halfSpan = width / 2
  const wingZ = length * 0.08 + rootChord / 2
  const tipChord = rootChord * 0.55
  const tipY = wingY + halfSpan * 0.02
  // The wing box over the cabin the wing grows out of
  box(mesh, 'hullWhite', 0, wingY, wingZ - rootChord * 0.45, fuselageW * 0.7, fuselageH * 0.28, rootChord * 1.1)
  for (const side of [-1, 1]) {
    wing(mesh, 'roof', side, {
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
      'body',
      x,
      wingY - nacelleD * 0.25,
      nacelleD / 2,
      [
        { z: nacelleZ - rootChord * 1.3, s: 0.6 },
        { z: nacelleZ - rootChord * 0.2, s: 1 },
        { z: nacelleZ + rootChord * 0.9, s: 0.85 },
      ],
      ['body', 'chassis'],
    )
    disc(mesh, 'rotor', x, wingY - nacelleD * 0.25, nacelleZ + rootChord * 0.95, width * 0.072, 0.05, 'z')
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
  stabilisers(mesh, 'roof', {
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
    box(mesh, 'hullWhite', side * fuselageW * 0.45, yc - fuselageH * 0.35, wingZ - rootChord * 0.6, fuselageW * 0.35, fuselageH * 0.3, rootChord * 1.4)
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
    wing(mesh, 'hullWhite', side, {
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
  stabilisers(mesh, 'hullWhite', {
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
  // The nose cap is the windscreen – a bubble of glass, the way these
  // cabins are all window forward
  const shell = body(
    mesh,
    'hullWhite',
    roundProfile(cabinW, cabinH, yc),
    [
      { z: cabinZ - cabinL / 2, sx: 0.55, sy: 0.7, yOff: cabinH * 0.12 },
      { z: cabinZ - cabinL * 0.15 },
      { z: cabinZ + cabinL * 0.2 },
      { z: cabinZ + cabinL * 0.42, sx: 0.8, sy: 0.85, yOff: -cabinH * 0.05 },
      { z: cabinZ + cabinL / 2, sx: 0.4, sy: 0.5, yOff: -cabinH * 0.1 },
    ],
    yc,
    ['hullWhite', 'glass'],
  )
  // The doors' windows and the cheeks of the nose, on the shell
  glaze(mesh, shell, [4, 5, 10, 11], cabinZ - cabinL * 0.05, cabinZ + cabinL * 0.18, { panes: 2 })
  glaze(mesh, shell, [4, 5, 6, 9, 10, 11], cabinZ + cabinL * 0.22, cabinZ + cabinL * 0.46)
  // Engine cowling and the rotor mast over the cabin's rear half
  const cowlY = yc + cabinH / 2
  box(mesh, 'body', 0, cowlY + 0.25, cabinZ - cabinL * 0.12, cabinW * 0.7, 0.5, cabinL * 0.5)
  const rotorY = height / 2 - 0.05
  box(mesh, 'chassis', 0, (cowlY + 0.5 + rotorY - 0.03) / 2, 0, 0.3, rotorY - 0.03 - cowlY - 0.5, 0.3)
  disc(mesh, 'rotor', 0, rotorY, 0, rotorR, 0.04, 'y')
  // Tail boom from the cabin to the fenestron, tapering
  const boomStart = cabinZ - cabinL / 2 + 0.3
  const boomEnd = -length / 2 + 0.05
  const boomY = yc + cabinH * 0.15
  tube(mesh, 'hullWhite', 0, boomY, 0.45, [
    { z: boomEnd + 1.2, s: 0.55 },
    { z: boomStart, s: 1 },
  ])
  // The shrouded tail rotor: a vertical fin with the fan disc inside
  slab(
    mesh,
    'hullBlue',
    [
      [0, boomY - 0.6, boomEnd + 1.3],
      [0, boomY + 1.0, boomEnd + 0.6],
      [0, boomY + 1.0, boomEnd],
      [0, boomY - 0.6, boomEnd],
    ],
    0.16,
  )
  disc(mesh, 'rotor', 0, boomY + 0.2, boomEnd + 0.7, 0.45, 0.1, 'x')
  // A small horizontal stabiliser on the boom
  stabilisers(mesh, 'hullWhite', {
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
    box(mesh, 'chassis', side * cabinW * 0.55, ground + 0.06, cabinZ - 0.3, 0.1, 0.12, cabinL * 0.62)
    for (const z of [cabinZ - cabinL * 0.3, cabinZ + cabinL * 0.15]) {
      box(mesh, 'chassis', side * cabinW * 0.3, (ground + 0.12 + yc - cabinH / 2) / 2, z, 0.08, yc - cabinH / 2 - ground - 0.12, 0.08)
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
