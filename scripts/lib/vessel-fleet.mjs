/**
 * Detailed hulls for the AIS fleet: smoothly shaded rounded bilges and
 * full bows, bevelled deckhouses, rails and mooring equipment, individual
 * containers and vessel-specific working gear. Muted PBR materials keep
 * the fleet at home in the photorealistic tiles. Each archetype is stretched
 * to the vessel's reported dimensions by the layer.
 *
 * Conventions as everywhere: 1 unit = 1 m, Y-up, +Z is the bow, origin
 * mid-length at half the total height, the waterline at y = -height/2.
 * VESSEL_DIMS (reference length/width/height) is the contract with
 * src/map/VesselLayer.ts and the model tests.
 */

import { MATERIALS, box as sharpBox, createMesh, extrude, quad, windowBand } from './vehicle-mesh.mjs'

import { ellipsoid, mergeMesh, rod, roundedBox, smoothSurface } from './model-detail.mjs'

// Keep glazing planar; a narrow bevel on painted enclosures catches the sun.
function box(mesh, material, x, y, z, w, h, l) {
  if (['body', 'hullWhite'].includes(material) && Math.min(w, h, l) > 0.3) {
    roundedBox(mesh, material, x, y, z, w, h, l, Math.min(0.16, h * 0.07))
  } else sharpBox(mesh, material, x, y, z, w, h, l)
}

void MATERIALS // palette lives in vehicle-mesh; imported for doc proximity

/** Reference dimensions per archetype (length, width, total height). */
export const VESSEL_DIMS = {
  'vessel-container': { length: 300, width: 40, height: 46 },
  'vessel-cargo': { length: 90, width: 14, height: 16 },
  'vessel-tanker': { length: 90, width: 14, height: 14 },
  'vessel-barge': { length: 85, width: 9.5, height: 6 },
  'vessel-dredger': { length: 100, width: 20, height: 18 },
  'vessel-passenger': { length: 160, width: 24, height: 34 },
  'vessel-tender': { length: 20, width: 5, height: 6 },
  'vessel-pilot': { length: 20, width: 6, height: 9.5 },
  'vessel-patrol': { length: 20, width: 6, height: 7.5 },
  'vessel-tug': { length: 26, width: 9, height: 10 },
  'vessel-fishing': { length: 18, width: 5.5, height: 7.5 },
  'vessel-sail': { length: 12, width: 3.8, height: 14 },
  'vessel-motor': { length: 14, width: 4.2, height: 5 },
  'vessel-generic': { length: 16, width: 5, height: 5.5 },
}

/**
 * The stations a hull is extruded through, stern first: the transom, a
 * rounded run into the parallel body, the parallel body, and the bow –
 * a quarter-ellipse in plan from full beam down to the stem, so the
 * entry is full and rounded rather than a wedge. The first bows were
 * straight lines to a stem a tenth of the beam wide, and a tanker and a
 * box ship came out as pointed as a rowing boat (2026-09-11).
 */
function hullStations({ length, bow, stern, taper }) {
  const taperStart = length / 2 - length * taper
  const bowAt = (f) => ({ z: taperStart + length * taper * f, sx: bow + (1 - bow) * Math.sqrt(1 - f * f) })
  return [
    { z: -length / 2, sx: stern, sy: 0.88 },
    { z: -length / 2 + length * 0.04, sx: stern + (1 - stern) * 0.7, sy: 0.96 },
    { z: -length / 2 + length * 0.12 },
    { z: taperStart },
    ...[0.2, 0.4, 0.58, 0.72, 0.83, 0.91, 0.96, 0.985].map(bowAt),
    { z: length / 2, sx: bow, sy: 0.94 },
  ]
}

function hull(
  mesh,
  { length, width, yBase, depth, material, bow = 0.22, stern = 0.55, taper = 0.2, bootStripe = 'hullRed', rails },
) {
  // The mesh remembers its hull's plan, so the model test can hold every
  // part of the ship inside it (hullHalfWidthAt)
  mesh.hull = { length, width, bow, stern, taper }
  const x = width / 2
  // A rounded bilge below near-vertical topsides. The sheer and full bow
  // still use the same stations as the deck and its fittings.
  const starboard = [[0.72, 0], [0.83, 0.04], [0.93, 0.16], [0.985, 0.38], [1, 0.7], [1, 0.98], [0.985, 1]]
  const profile = [...starboard.map(([w, h]) => [x * w, yBase + depth * h]), ...starboard.toReversed().map(([w, h]) => [-x * w, yBase + depth * h])]
  const skin = createMesh()
  extrude(skin, profile, hullStations({ length, bow, stern, taper }), { material, yAnchor: yBase })
  mergeMesh(mesh, smoothSurface(skin, 50))
  // A narrow boot stripe and deck-edge cap tie the hull to its waterline.
  deckPlate(mesh, bootStripe, { length, width, yBase, depth: depth * 0.22, bow, stern, taper, inset: 0.947, thickness: Math.min(0.16, depth * 0.08) })
  deckPlate(mesh, 'steel', { length, width, yBase, depth, bow, stern, taper, inset: 0.985, thickness: 0.055 })
  deckFittings(mesh, { length, width, yBase, depth, bow, stern, taper, rails })
}

/**
 * Railed side decks, mooring bollards and foredeck windlass, fitted to
 * the hull plan. `rails` names the rails' material (steel unless said
 * otherwise) and the spans of the length they run over, as [z0, z1]
 * pairs – a pilot boat rails her working decks fore and aft and nothing
 * beside the house; without spans they run the whole sheer round.
 */
function deckFittings(mesh, spec) {
  const { length, width, depth, yBase, rails = {} } = spec
  const railMaterial = rails.material ?? 'steel'
  const spans = rails.spans ?? [[-length / 2, length / 2]]
  const stations = hullStations(spec)
  const railHeight = Math.min(1.05, width * 0.17)
  const radius = Math.min(0.045, width * 0.006)
  const lerp = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t)
  // Follow the sheer, including the stern and bow, and stop inside the stem.
  for (const side of [-1, 1]) {
    const points = stations.map((st) => [side * hullHalfWidthAt(st.z, spec) * 0.96, yBase + depth * (st.sy ?? 1) + 0.075, st.z * 0.985])
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]
      const b = points[i + 1]
      for (const [z0, z1] of spans) {
        // The segment clipped to the span – the segment's own ends where
        // the span reaches past them, so a whole sheer comes out as it
        // always did, to the byte
        const t0 = Math.min(1, Math.max(0, (z0 - a[2]) / (b[2] - a[2])))
        const t1 = Math.min(1, Math.max(0, (z1 - a[2]) / (b[2] - a[2])))
        if (t1 <= t0) continue
        const pa = t0 === 0 ? a : lerp(a, b, t0)
        const pb = t1 === 1 ? b : lerp(a, b, t1)
        const count = Math.max(1, Math.ceil((pb[2] - pa[2]) / Math.max(2.5, length / 30)))
        for (let j = 0; j < count; j++) {
          const p = lerp(pa, pb, j / count)
          rod(mesh, railMaterial, p, [p[0], p[1] + railHeight, p[2]], radius, 8)
        }
        for (const h of [railHeight * 0.5, railHeight]) rod(mesh, railMaterial, [pa[0], pa[1] + h, pa[2]], [pb[0], pb[1] + h, pb[2]], radius * 0.8, 8)
      }
    }
    for (const z of [-length * 0.39, length * 0.37]) {
      const x = side * hullHalfWidthAt(z, spec) * 0.67
      const y = yBase + depth + 0.1
      for (const dz of [-1, 1]) {
        const bz = z + dz * Math.min(0.3, width * 0.05)
        rod(mesh, 'chassis', [x, y, bz], [x, y + Math.min(0.6, width * 0.08), bz], Math.min(0.16, width * 0.025))
      }
    }
  }
  const winchZ = length * 0.405
  const y = yBase + depth + 0.24
  rod(mesh, 'steel', [-width * 0.08, y, winchZ], [width * 0.08, y, winchZ], Math.min(0.35, width * 0.045), 16)
}

/** Half the hull's beam at a length z, as hull() builds it – for fitting the deck furniture. */
export function hullHalfWidthAt(z, { length, width, bow = 0.22, stern = 0.55, taper = 0.2 }) {
  const stations = hullStations({ length, bow, stern, taper })
  let s = 0
  while (s + 2 < stations.length && stations[s + 1].z < z) s++
  const a = stations[s]
  const b = stations[s + 1]
  const t = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z)))
  const sx = (a.sx ?? 1) + ((b.sx ?? 1) - (a.sx ?? 1)) * t
  return (width / 2) * sx
}

/**
 * The deck plate on a hull, in the deck's own colour: a thin slab
 * extruded through the hull's own stations, so it narrows into the bow
 * and the transom with the hull and sits on its top wherever that top
 * is. It used to be a plain box, which at the bow of a tanker stood
 * four metres proud of the hull on either side and read as a flight
 * deck (seen 2026-09-11). `inset` keeps it a little inside the gunwale.
 */
function deckPlate(
  mesh,
  material,
  { length, width, yBase, depth, bow = 0.22, stern = 0.55, taper = 0.2, inset = 0.94, thickness = 0.2 },
) {
  const x = (width * inset) / 2
  const y0 = yBase + depth
  // The hull's own stations, the two ends pulled a hand inside its caps
  const stations = hullStations({ length, bow, stern, taper })
  stations[0] = { ...stations[0], z: stations[0].z + 0.3 }
  stations[stations.length - 1] = { ...stations[stations.length - 1], z: length / 2 - 0.3 }
  extrude(
    mesh,
    [
      [x, y0],
      [x, y0 + thickness],
      [-x, y0 + thickness],
      [-x, y0],
    ],
    stations,
    { material, yAnchor: yBase },
  )
}

/** Deckhouse block with a glass band near its top on both sides. */
function house(mesh, { w, y0, h, z, l, panes = 3 }) {
  box(mesh, 'body', 0, y0 + h / 2, z, w, h, l)
  windowBand(mesh, w, y0 + h * 0.55, y0 + h * 0.85, z - l / 2 + 0.3, z + l / 2 - 0.3, { panes })
}

/** Bridge front glazing (thin glass sheet on the forward face). */
function bridgeFront(mesh, { w, y0, y1, z }) {
  const panes = Math.max(3, Math.round(w / 1.4))
  const gap = Math.min(0.12, w * 0.018)
  const paneW = (w - gap * (panes - 1)) / panes
  for (let i = 0; i < panes; i++) {
    box(mesh, 'glass', -w / 2 + paneW / 2 + i * (paneW + gap), (y0 + y1) / 2, z + 0.025, paneW, y1 - y0, 0.03)
  }
}

/**
 * Funnel: body drum with a dark cap. The mesh remembers where its top is
 * (`mesh.funnel`, in this file's frame: z along the length, top the
 * height of the cap's rim, width across the beam) – the exhaust plume
 * the layer draws starts there (FunnelSmoke in src/map/), and
 * VESSEL_MODELS in src/map/VesselLayer.ts carries the same point in the
 * model frame Cesium hands the layer, pinned by tests/vessel-models.test.ts.
 */
function funnel(mesh, { y0, h, z, w = 2.4, l = 3.4 }) {
  roundedBox(mesh, 'body', 0, y0 + h / 2, z, w, h, l, Math.min(w, l) * 0.18)
  roundedBox(mesh, 'chassis', 0, y0 + h + 0.25, z, w * 0.92, 0.5, l * 0.92, 0.1)
  mesh.funnel = { z, top: y0 + h + 0.5, width: w }
}

/**
 * Rail along a deck edge: a thin top rope on short stanchions. Cheap in
 * triangles and it is what turns a slab into a deck someone stands on.
 */
function railing(mesh, { w, y0, h, z, l, posts = 5, material = 'steel' }) {
  for (const side of [-1, 1]) {
    for (const rise of [h * 0.5, h]) rod(mesh, material, [side * w / 2, y0 + rise, z - l / 2], [side * w / 2, y0 + rise, z + l / 2], 0.025, 8)
    for (let i = 0; i < posts; i++) {
      const pz = z - l / 2 + (l * (i + 0.5)) / posts
      rod(mesh, material, [side * w / 2, y0, pz], [side * w / 2, y0 + h, pz], 0.025, 8)
    }
  }
}

/**
 * A block extruded across the beam from its side elevation – the
 * outline as [z, y] points, from x0 to x1 – for what a box cannot give:
 * a wheelhouse front raked forward at the top. Built as the helpers'
 * extrusion along z and turned a quarter round the vertical, so their
 * winding holds; the outline may come in either order, its signed area
 * says which.
 */
function sideProfileBlock(mesh, material, outline, x0, x1) {
  // The part's x is -z of the ship, its z the ship's x
  const profile = outline.map(([z, y]) => [-z, y])
  let area = 0
  for (let i = 0; i < profile.length; i++) {
    const [ax, ay] = profile[i]
    const [bx, by] = profile[(i + 1) % profile.length]
    area += ax * by - bx * ay
  }
  if (area < 0) profile.reverse()
  const part = createMesh()
  extrude(part, profile, [{ z: x0 }, { z: x1 }], { material })
  for (const g of part.groups.values()) {
    for (const list of [g.positions, g.normals]) {
      for (let i = 0; i < list.length; i += 3) {
        const [x, y, z] = [list[i], list[i + 1], list[i + 2]]
        list[i] = z
        list[i + 1] = y
        list[i + 2] = -x
      }
    }
  }
  mergeMesh(mesh, part)
}

/** A container's height, and the width of a stack: two boxes side by side – the finest grain that still reads at map distance. */
const CONTAINER_TIER_M = 2.6
const CONTAINER_STACK_W = 4.9
/** The liveries a stack is drawn in, picked by a small hash so the load is a stable mosaic and the GLB byte-stable. */
const CONTAINER_LIVERIES = ['boxRed', 'boxBlue', 'boxGreen', 'boxGrey', 'boxOrange', 'boxRust', 'boxGrey', 'boxBlue']

/**
 * One bay of a box ship's deck load: stacks across the beam – as many
 * two-box stacks as the beam at that bay takes, with the lashing gaps
 * between them – in two forty-foot slots along the bay, each stack its
 * own box in its own livery and a tier or two short here and there, so
 * the load reads as a mosaic of many containers and not as one slab.
 * Each slot has two individual containers per tier, separated by seams;
 * the exposed sides carry folded corrugations and the ends door bars.
 */
function containerBay(mesh, { z, length, deck, beam, tiers, seed }) {
  const gap = 0.35
  const slotGap = 0.5
  const across = Math.max(1, Math.floor((beam + gap) / (CONTAINER_STACK_W + gap)))
  const totalW = across * CONTAINER_STACK_W + (across - 1) * gap
  const slotL = (length - slotGap) / 2
  for (let k = 0; k < across; k++) {
    const x = -totalW / 2 + CONTAINER_STACK_W / 2 + k * (CONTAINER_STACK_W + gap)
    for (let slot = 0; slot < 2; slot++) {
      const zc = z - length / 2 + slotL / 2 + slot * (slotL + slotGap)
      const n = (seed * 31 + k * 7 + slot * 13) % 97
      const short = (n % 4 === 0 ? 1 : 0) + (n % 9 === 0 ? 1 : 0)
      const h = Math.max(2, tiers - short) * CONTAINER_TIER_M
      for (let tier = 0; tier < Math.round(h / CONTAINER_TIER_M); tier++) {
        for (const half of [-1, 1]) {
          const cx = x + half * CONTAINER_STACK_W * 0.25
          const cy = deck + 0.3 + (tier + 0.5) * CONTAINER_TIER_M
          const cw = CONTAINER_STACK_W / 2 - 0.06
          const ch = CONTAINER_TIER_M - 0.09
          const material = CONTAINER_LIVERIES[(n + tier * 3 + (half + 1)) % CONTAINER_LIVERIES.length]
          sharpBox(mesh, material, cx, cy, zc, cw, ch, slotL - 0.08)
          // Recessed door split on the exposed bay ends, a quiet steel line.
          sharpBox(mesh, 'steel', cx, cy, zc + slotL / 2 - 0.025, 0.035, ch * 0.88, 0.018)
          if ((k === 0 && half < 0) || (k === across - 1 && half > 0)) {
            for (let rib = 1; rib < 12; rib++) {
              const rx = cx + half * (cw / 2 + 0.008)
              const rz = zc - slotL / 2 + slotL * rib / 12
              // Small folded ribs retain the container's own paint.
              const a = [rx, cy - ch * 0.47, rz - 0.04]
              const b = [rx + half * 0.035, cy - ch * 0.47, rz]
              const c = [rx, cy - ch * 0.47, rz + 0.04]
              const up = (p) => [p[0], cy + ch * 0.47, p[2]]
              if (half > 0) {
                quad(mesh, material, a, up(a), up(b), b)
                quad(mesh, material, b, up(b), up(c), c)
              } else {
                quad(mesh, material, b, up(b), up(a), a)
                quad(mesh, material, c, up(c), up(b), b)
              }
            }
          }
        }
      }
    }
  }
}

/**
 * Container ship (AIS 70–79 from ~150 m up): the ship Hamburg is built
 * around, and nothing like the coaster below – a flush hull carrying box
 * bays fore and aft of a deckhouse set two thirds aft, the lashing gaps
 * between the bays giving the silhouette its teeth. Bays step down and
 * narrow toward the bow the way a real stowage plan does. Reference
 * 300 m: the layer stretches it from a 170 m feeder to a 400 m ULCV.
 */
export function vesselContainer() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-container']
  const yBase = -height / 2
  const deck = yBase + 18
  // A box ship carries her beam nearly to the stem: the bow narrows over
  // the last seventh only, and the bays end where it begins
  hull(mesh, { length, width, yBase, depth: 18, material: 'hullBlue', bow: 0.2, stern: 0.62, taper: 0.14 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 18, bow: 0.2, stern: 0.62, taper: 0.14 }) // weather deck
  // The deck load: bays of container stacks (see containerBay), the
  // lashing gaps between the bays giving the silhouette its teeth. The
  // bays step down and lose their outer stacks toward the bow the way a
  // real stowage plan does.
  const bays = 6
  const cargoStart = -length * 0.2
  const cargoEnd = length * 0.36
  const span = cargoEnd - cargoStart
  const lashGap = 2.4
  const bayLength = (span - lashGap * (bays - 1)) / bays
  for (let i = 0; i < bays; i++) {
    const z = cargoStart + i * (bayLength + lashGap) + bayLength / 2
    const t = (z - cargoStart) / span
    const taper = Math.max(0, t - 0.6) / 0.4
    containerBay(mesh, {
      z,
      length: bayLength,
      deck,
      beam: width * (0.93 - 0.2 * taper),
      tiers: Math.round((13.5 - 4.5 * taper) / CONTAINER_TIER_M),
      seed: i,
    })
  }
  // Two more bays behind the house, two tiers lower than the forward stacks
  for (const [k, z] of [-length * 0.4, -length * 0.325].entries()) {
    containerBay(mesh, { z, length: bayLength * 0.7, deck, beam: width * 0.8, tiers: 3, seed: 10 + k })
  }
  // Deckhouse: a tower of decks with the bridge across the full beam
  const houseZ = -length * 0.265
  const houseW = width * 0.64
  const houseTop = deck + 21
  box(mesh, 'body', 0, (deck + houseTop) / 2, houseZ, houseW, houseTop - deck, 15)
  for (let k = 0; k < 3; k++) {
    const y = deck + 5 + k * 5
    windowBand(mesh, houseW, y, y + 1.6, houseZ - 6, houseZ + 6, { panes: 3 })
  }
  const bridgeY = houseTop
  box(mesh, 'body', 0, bridgeY + 1.9, houseZ, width * 0.95, 3.8, 9)
  windowBand(mesh, width * 0.95, bridgeY + 1.9, bridgeY + 3.2, houseZ - 4, houseZ + 4, { panes: 4 })
  bridgeFront(mesh, { w: width * 0.8, y0: bridgeY + 1.9, y1: bridgeY + 3.2, z: houseZ + 4.55 })
  box(mesh, 'roof', 0, bridgeY + 3.9, houseZ, width * 0.9, 0.2, 8.6)
  funnel(mesh, { y0: bridgeY, h: height / 2 - 1.2 - bridgeY, z: houseZ - 10, w: 6, l: 9 })
  // Foremast on the fo'c'sle, capped under the model's own ceiling
  box(mesh, 'chassis', 0, deck + 5, length / 2 - 9, 0.7, 10, 0.7)
  railing(mesh, { w: width * 0.9, y0: bridgeY + 3.95, h: 0.8, z: houseZ, l: 8, posts: 5 })
  ellipsoid(mesh, 'body', [0, bridgeY + 4.6, houseZ], [0.7, 0.65, 0.7], 16, 8)
  return mesh
}

/**
 * Inland barge (Europaschiff on the Elbe): the long flat box a seagoing
 * coaster is never mistaken for once you see them side by side – almost
 * no freeboard, a hold running nearly the whole length between two
 * coamings, and the wheelhouse right aft over the quarters, raised just
 * enough to see past the cargo.
 */
export function vesselBarge() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-barge']
  const yBase = -height / 2
  const deck = yBase + 2.2
  hull(mesh, { length, width, yBase, depth: 2.2, material: 'chassis', bow: 0.34, stern: 0.8 })
  deckPlate(mesh, 'hullRed', { length, width, yBase, depth: 2.2, bow: 0.34, stern: 0.8, thickness: 0.16 }) // gangway deck
  // Hold: two coamings with the dark cargo space between them
  const holdZ = length * 0.02
  const holdL = length * 0.56
  for (const side of [-1, 1]) {
    box(mesh, 'body', (side * width * 0.78) / 2, deck + 0.75, holdZ, width * 0.1, 1.3, holdL)
  }
  box(mesh, 'bellows', 0, deck + 0.5, holdZ, width * 0.66, 0.9, holdL)
  // Aft quarters with the raised wheelhouse on top
  const houseZ = -length / 2 + 7
  box(mesh, 'body', 0, deck + 1.1, houseZ, width * 0.8, 2.0, 9)
  windowBand(mesh, width * 0.8, deck + 1.3, deck + 2.0, houseZ - 3.6, houseZ + 3.6, { panes: 3 })
  const whY = deck + 2.1
  const whTop = height / 2 - 0.8
  box(mesh, 'body', 0, (whY + whTop) / 2, houseZ + 1, width * 0.5, whTop - whY, 3.2)
  windowBand(mesh, width * 0.5, whTop - 1.1, whTop - 0.2, houseZ - 0.5, houseZ + 2.5, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.42, y0: whTop - 1.1, y1: whTop - 0.2, z: houseZ + 2.62 })
  box(mesh, 'roof', 0, whTop + 0.06, houseZ + 1, width * 0.54, 0.12, 3.4)
  box(mesh, 'chassis', 0, whTop + 0.45, houseZ + 1, 0.12, 0.7, 0.12)
  // Fo'c'sle locker, set back where the bow is still wide enough for it
  box(mesh, 'body', 0, deck + 0.55, length / 2 - 5.5, width * 0.4, 0.9, 4)
  for (let z = -20; z < 24; z += 5.5) box(mesh, 'roof', 0, deck + 1.44, z, width * 0.82, 0.12, 0.15)
  return mesh
}

/**
 * Trailing suction hopper dredger (AIS 33): the Elbe fairway is dredged
 * around the clock, and the suction pipe slung along the side is what
 * says so from a distance – it rides its gantry at deck level aft and
 * dips toward the water forward. Hopper coamings amidships, bridge
 * forward the way a dredger carries it.
 */
export function vesselDredger() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-dredger']
  const yBase = -height / 2
  const deck = yBase + 7
  hull(mesh, { length, width, yBase, depth: 7, material: 'hullRed', bow: 0.2, stern: 0.66 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 7, bow: 0.2, stern: 0.66 })
  // The hopper: coamings port and starboard, the well dark between them
  const hopperZ = -length * 0.06
  const hopperL = length * 0.46
  for (const side of [-1, 1]) {
    box(mesh, 'body', (side * width * 0.8) / 2, deck + 1.3, hopperZ, width * 0.14, 2.4, hopperL)
  }
  box(mesh, 'bellows', 0, deck + 0.7, hopperZ, width * 0.62, 1.2, hopperL)
  // Round suction pipe stowed along the starboard side on its gantry,
  // dipping a little toward the
  // bow but never below the deck, and ending before the bow's taper –
  // the first version raked it six metres down and out through the
  // hull's side where the hull had already narrowed (seen 2026-09-11).
  const pipeX = width * 0.44
  const pipeR = 0.9
  const pipePoints = [[pipeX, deck + 1.9, -length * 0.16], [pipeX, deck + 1.6, length * 0.1], [pipeX * 0.8, deck + 1.1, length * 0.26]]
  for (let i = 0; i + 1 < pipePoints.length; i++) rod(mesh, 'chassis', pipePoints[i], pipePoints[i + 1], pipeR, 20)
  for (const z of [-length * 0.12, length * 0.16]) {
    box(mesh, 'chassis', pipeX, deck + 2.6, z, 0.5, 5, 0.5) // gantry davits
    box(mesh, 'chassis', pipeX, deck + 5, z, 0.5, 0.4, 3)
  }
  // Bridge forward, funnel aft
  const houseZ = length * 0.3
  const houseTop = deck + 6.5
  box(mesh, 'body', 0, (deck + houseTop) / 2, houseZ, width * 0.64, houseTop - deck, 12)
  windowBand(mesh, width * 0.64, deck + 1.4, deck + 2.8, houseZ - 5, houseZ + 5, { panes: 3 })
  box(mesh, 'body', 0, houseTop + 1.3, houseZ - 0.5, width * 0.76, 2.6, 7)
  windowBand(mesh, width * 0.76, houseTop + 1.3, houseTop + 2.3, houseZ - 3.5, houseZ + 2.5, { panes: 3 })
  bridgeFront(mesh, { w: width * 0.64, y0: houseTop + 1.3, y1: houseTop + 2.3, z: houseZ + 3.02 })
  box(mesh, 'roof', 0, houseTop + 2.7, houseZ - 0.5, width * 0.7, 0.2, 6.6)
  funnel(mesh, { y0: deck, h: height / 2 - 1 - deck, z: -length / 2 + 7, w: 3, l: 4.5 })
  box(mesh, 'chassis', 0, houseTop + 3.6, houseZ - 0.5, 0.4, 1.8, 0.4) // radar mast
  for (const z of [-12, 16]) rod(mesh, 'steel', [pipeX, deck + 4.8, z], [pipeX - 2.3, deck + 0.4, z + 1.6], 0.12)
  return mesh
}

/**
 * Harbour tender – the Hamburg barkasse (AIS 53, and the small type-60
 * boats that are the same thing): a low white hull under one long glazed
 * cabin, open platforms fore and aft, a railed sun deck on top. There
 * are hundreds of these in the inner harbour and none of them looks
 * remotely like the tug they used to be drawn as.
 */
export function vesselTender() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-tender']
  const yBase = -height / 2
  const deck = yBase + 1.3
  hull(mesh, { length, width, yBase, depth: 1.3, material: 'hullWhite', bow: 0.16, stern: 0.82 })
  // The rubbing strake follows the hull round, a hand proud of it
  deckPlate(mesh, 'chassis', { length, width, yBase, depth: 1.3 - 0.25, bow: 0.16, stern: 0.82, inset: 1 + 0.06 / width, thickness: 0.3 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 1.3, bow: 0.16, stern: 0.82, inset: 0.9, thickness: 0.1 })
  // The cabin: one long glass box, the barkasse's whole silhouette
  const cabZ = -0.6
  const cabL = length * 0.66
  const cabTop = deck + 2.0
  box(mesh, 'hullWhite', 0, (deck + cabTop) / 2, cabZ, width * 0.88, cabTop - deck, cabL)
  windowBand(mesh, width * 0.88, deck + 0.75, cabTop - 0.35, cabZ - cabL / 2 + 0.4, cabZ + cabL / 2 - 0.4, {
    panes: 6,
  })
  bridgeFront(mesh, { w: width * 0.72, y0: deck + 0.75, y1: cabTop - 0.35, z: cabZ + cabL / 2 + 0.02 })
  box(mesh, 'roof', 0, cabTop + 0.06, cabZ, width * 0.9, 0.12, cabL + 0.2)
  railing(mesh, { w: width * 0.9, y0: cabTop + 0.12, h: 0.8, z: cabZ, l: cabL, posts: 5 })
  // Open aft deck with two benches, and the bow platform
  for (const z of [-length * 0.42, -length * 0.36]) {
    box(mesh, 'body', 0, deck + 0.3, z, width * 0.6, 0.35, 0.5)
  }
  railing(mesh, { w: width * 0.86, y0: deck, h: 0.9, z: -length * 0.4, l: length * 0.18, posts: 2 })
  // Mast measured down from the model's ceiling – the layer scales this
  // box to the reported ship, and a mast poking out of it would scale too
  const mastTop = height / 2 - 0.1
  box(mesh, 'chassis', 0, (cabTop + mastTop) / 2, cabZ + cabL * 0.3, 0.1, mastTop - cabTop, 0.1)
  for (const z of [-3, 3]) {
    for (const side of [-1, 1]) roundedBox(mesh, 'deckTeak', side * 1.3, cabTop + 0.34, z, 0.42, 0.35, 2)
  }
  return mesh
}

/**
 * Pilot boat (AIS 50): the German pilot service's boats are orange all
 * over, hull and house, with a heavy black fender all round to lie
 * against a moving ship's side, a green working deck, the wheelhouse
 * forward of midships with its front glazing raked forward at the top
 * against the glare, a raked mast with the radar on it, and the white
 * and red diagonal on the bow. The working decks fore and aft carry
 * the boarding rails, the crane and the liferafts; the sides beside
 * the house are bare. Modelled on the JASMUND of the Lotsenbetrieb MV
 * (2026-09-16); the reference 20 × 6 m is stretched to the reported
 * boat, and the reference height is the mast's: 9.5 m over the water,
 * where the other small craft keep 7.5 – capped there the mast was a
 * stub over the wheelhouse. The rescue and police boats of 51 and 55 wear their own
 * colours and keep the patrol boat below.
 */
export function vesselPilot() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-pilot']
  const yBase = -height / 2
  const depth = 2.0
  const deck = yBase + depth
  const plan = { bow: 0.12, stern: 0.8, taper: 0.24 }
  const orange = 'pilotOrange'
  hull(mesh, {
    length,
    width,
    yBase,
    depth,
    material: orange,
    ...plan,
    bootStripe: 'chassis',
    rails: { material: orange, spans: [[-length / 2, -length * 0.25], [length * 0.24, length / 2]] },
  })
  // The fender: a heavy black strake at the gunwale, a hand proud of the hull
  deckPlate(mesh, 'bellows', { length, width, yBase, depth: depth - 0.55, ...plan, inset: 1 + 0.08 / width, thickness: 0.6 })
  deckPlate(mesh, 'deckGreen', { length, width, yBase, depth, ...plan, inset: 0.9, thickness: 0.1 })
  const deckTop = deck + 0.1
  // The diagonal on the bow, white aft of red, raked forward at the top
  // like the wheelhouse: a decal a finger proud of the topsides, laid
  // along the hull's own profile rows so it hugs the flare
  const topsides = [[0.93, 0.16], [0.985, 0.38], [1, 0.7], [1, 0.98]]
  const sxAt = (h) => {
    let i = 0
    while (i + 2 < topsides.length && topsides[i + 1][1] < h) i++
    const [sa, ha] = topsides[i]
    const [sb, hb] = topsides[i + 1]
    return sa + (sb - sa) * ((h - ha) / (hb - ha))
  }
  const stripeRows = [0.3, 0.38, 0.7, 0.95]
  const stripeAt = (h) => 1.9 + 1.4 * ((h - 0.3) / 0.65)
  for (const side of [-1, 1]) {
    for (const [material, from, to] of [['hullWhite', 0, 0.7], ['buoyRed', 0.7, 1.4]]) {
      for (let r = 0; r + 1 < stripeRows.length; r++) {
        const corner = (h, dz) => [side * ((width / 2) * sxAt(h) + 0.02), yBase + depth * h, stripeAt(h) + dz]
        const [h0, h1] = [stripeRows[r], stripeRows[r + 1]]
        const aftBottom = corner(h0, from), foreBottom = corner(h0, to)
        const aftTop = corner(h1, from), foreTop = corner(h1, to)
        if (side > 0) quad(mesh, material, foreBottom, aftBottom, aftTop, foreTop)
        else quad(mesh, material, aftBottom, foreBottom, foreTop, aftTop)
      }
    }
  }
  // The house: long and low, with the crew's windows aft; the pilots'
  // wheelhouse on its forward half, its front leaning out at the top
  const houseZ = -length * 0.01
  const houseL = length * 0.46
  const houseW = width * 0.74
  const houseTop = deckTop + 1.85
  roundedBox(mesh, orange, 0, (deckTop + houseTop) / 2, houseZ, houseW, houseTop - deckTop, houseL, 0.12)
  windowBand(mesh, houseW, houseTop - 1.25, houseTop - 0.5, houseZ - houseL / 2 + 0.5, houseZ - houseL * 0.1, { panes: 3 })
  const whW = width * 0.7
  const whTop = deckTop + 1.85 + 2.0
  const whAft = houseZ - houseL * 0.15
  const whFore = houseZ + houseL * 0.42
  const rake = 0.7
  sideProfileBlock(mesh, orange, [[whAft, houseTop], [whFore, houseTop], [whFore + rake, whTop], [whAft, whTop]], -whW / 2, whW / 2)
  // The glazing all round: bands along the sides, panes on the raked front
  const glassY0 = whTop - 1.1
  const glassY1 = whTop - 0.25
  windowBand(mesh, whW, glassY0, glassY1, whAft + 0.3, whFore + rake * ((glassY0 - houseTop) / (whTop - houseTop)) - 0.25, { panes: 3 })
  const frontZ = (y) => whFore + rake * ((y - houseTop) / (whTop - houseTop))
  const frontNormal = [whTop - houseTop, -rake].map((v) => v / Math.hypot(whTop - houseTop, rake))
  const panes = 4
  const paneGap = 0.08
  const paneW = (whW * 0.9 - paneGap * (panes - 1)) / panes
  for (let i = 0; i < panes; i++) {
    const xa = -whW * 0.45 + i * (paneW + paneGap)
    const xb = xa + paneW
    const at = (x, y) => [x, y + 0.02 * frontNormal[1], frontZ(y) + 0.02 * frontNormal[0]]
    quad(mesh, 'glass', at(xa, glassY0), at(xb, glassY0), at(xb, glassY1), at(xa, glassY1))
  }
  // The roof: the house's own orange over a dark rim, which with the
  // black frames of the glazing is what the photo's dark band is
  const rimOutline = (y0, y1, out) => [[whAft - out, y0], [whFore + rake + out, y0], [whFore + rake + out, y1], [whAft - out, y1]]
  sideProfileBlock(mesh, 'chassis', rimOutline(whTop - 0.14, whTop, 0.12), -whW / 2 - 0.08, whW / 2 + 0.08)
  sideProfileBlock(mesh, orange, rimOutline(whTop, whTop + 0.14, 0.12), -whW / 2 - 0.08, whW / 2 + 0.08)
  // Mast raked aft from the roof – a tapered pole with the radar on a
  // platform a third of the way up, a yard with the aerials near the top
  const roofTop = whTop + 0.14
  const mastTop = height / 2 - 0.1
  const mastZ = (y) => whAft + 0.9 - 0.5 * ((y - roofTop) / (mastTop - roofTop))
  rod(mesh, orange, [0, roofTop, mastZ(roofTop)], [0, mastTop, mastZ(mastTop)], 0.13, 12, 0.06)
  const radarY = roofTop + 1.1
  box(mesh, orange, 0, radarY - 0.04, mastZ(radarY), 1.0, 0.08, 0.9)
  rod(mesh, 'hullWhite', [0, radarY, mastZ(radarY)], [0, radarY + 0.32, mastZ(radarY)], 0.13, 12)
  rod(mesh, 'hullWhite', [-0.85, radarY + 0.38, mastZ(radarY)], [0.85, radarY + 0.38, mastZ(radarY)], 0.09, 12)
  const yardY = mastTop - 0.7
  rod(mesh, orange, [-1.0, yardY, mastZ(yardY)], [1.0, yardY, mastZ(yardY)], 0.045, 8)
  for (const x of [-1.0, -0.5, 0.5, 1.0]) rod(mesh, 'steel', [x, yardY, mastZ(yardY)], [x, mastTop - 0.05, mastZ(yardY)], 0.015, 6)
  box(mesh, 'chassis', 0, mastTop - 0.14, mastZ(mastTop - 0.14), 0.32, 0.24, 0.24)
  for (const side of [-1, 1]) rod(mesh, 'steel', [side * 0.4, roofTop, mastZ(roofTop) - 0.5], [0, roofTop + 1.6, mastZ(roofTop + 1.6)], 0.03, 6)
  // Satellite dome on a stub to starboard, the searchlight on the brow
  rod(mesh, 'steel', [0.95, roofTop, whAft + 1.6], [0.95, roofTop + 0.3, whAft + 1.6], 0.05, 8)
  ellipsoid(mesh, 'hullWhite', [0.95, roofTop + 0.45, whAft + 1.6], [0.26, 0.22, 0.26], 16, 8)
  ellipsoid(mesh, 'hullWhite', [-0.8, roofTop + 0.18, whFore + rake - 0.2], [0.14, 0.14, 0.18], 12, 6)
  // The house's roof aft of the wheelhouse: railed, with a liferaft
  railing(mesh, { w: houseW * 0.94, y0: houseTop, h: 0.85, z: houseZ - houseL * 0.32, l: houseL * 0.3, posts: 3, material: orange })
  rod(mesh, 'hullWhite', [0.9, houseTop + 0.3, houseZ - houseL * 0.4], [0.9, houseTop + 0.3, houseZ - houseL * 0.2], 0.3, 12)
  // Aft working deck: the crane's A-frame over the transom, the capstan
  // and a second liferaft; the boarding frame on the foredeck
  const aftDeck = deckTop
  for (const x of [-1.5, 1.5]) rod(mesh, orange, [x, aftDeck, -length * 0.35], [0, aftDeck + 2.3, -length * 0.42], 0.07, 8)
  rod(mesh, orange, [-1.5, aftDeck + 1.15, -length * 0.385], [1.5, aftDeck + 1.15, -length * 0.385], 0.05, 8)
  rod(mesh, 'hullWhite', [-1.2, aftDeck, -length * 0.3], [-1.2, aftDeck + 0.55, -length * 0.3], 0.28, 16)
  rod(mesh, 'hullWhite', [1.3, aftDeck + 0.36, -length * 0.35], [1.3, aftDeck + 0.36, -length * 0.28], 0.34, 12)
  box(mesh, 'boxGrey', -0.2, aftDeck + 0.3, -length * 0.29, 1.0, 0.6, 0.9)
  const frameZ = [length * 0.27, length * 0.36]
  for (const side of [-1, 1]) {
    const x = side * hullHalfWidthAt(frameZ[1], { length, width, ...plan }) * 0.66
    for (const z of frameZ) rod(mesh, orange, [x, deckTop, z], [x, deckTop + 1.1, z], 0.045, 8)
    rod(mesh, orange, [x, deckTop + 1.1, frameZ[0]], [x, deckTop + 1.1, frameZ[1]], 0.04, 8)
  }
  const frameX = hullHalfWidthAt(frameZ[1], { length, width, ...plan }) * 0.66
  rod(mesh, orange, [-frameX, deckTop + 1.1, frameZ[1]], [frameX, deckTop + 1.1, frameZ[1]], 0.04, 8)
  return mesh
}

/**
 * Patrol boat (AIS 39, and the rescue and police craft of 51 and 55): a
 * dark, deep-sheered hull built to lie alongside a moving ship – heavy
 * fendering, the wheelhouse well forward, a low working deck aft, and a
 * mast that carries more aerials than the boat seems able to. It was
 * the pilot boat until 2026-09-16, when the pilots got their orange.
 */
export function vesselPatrol() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-patrol']
  const yBase = -height / 2
  const deck = yBase + 2.0
  hull(mesh, { length, width, yBase, depth: 2.0, material: 'chassis', bow: 0.14, stern: 0.78 })
  // The fendering a boat takes ship's-side contact on, all the way
  // round – its top a hand under the deck plate's: at the deck's own
  // height the two faces shared a plane and the whole deck flickered
  // between grey and black (seen on the ROSENORT, 2026-09-16)
  deckPlate(mesh, 'bellows', { length, width, yBase, depth: 2.0 - 0.65, bow: 0.14, stern: 0.78, inset: 1 + 0.06 / width, thickness: 0.7 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 2.0, bow: 0.14, stern: 0.78, inset: 0.9, thickness: 0.1 })
  // Deckhouse forward of midship, wheelhouse glazed on top of it
  const houseZ = length * 0.14
  const houseTop = deck + 1.9
  box(mesh, 'hullWhite', 0, (deck + houseTop) / 2, houseZ, width * 0.7, houseTop - deck, length * 0.42)
  const whTop = height / 2 - 1.1
  box(mesh, 'hullWhite', 0, (houseTop + whTop) / 2, houseZ + 0.4, width * 0.6, whTop - houseTop, 3.4)
  windowBand(mesh, width * 0.6, whTop - 1.2, whTop - 0.25, houseZ - 1.2, houseZ + 2.0, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.5, y0: whTop - 1.2, y1: whTop - 0.25, z: houseZ + 2.12 })
  box(mesh, 'roof', 0, whTop + 0.06, houseZ + 0.4, width * 0.64, 0.12, 3.6)
  // Mast with the radar bar, both measured down from the model's ceiling
  const mastTop = height / 2 - 0.1
  box(mesh, 'chassis', 0, (whTop + mastTop) / 2, houseZ - 0.6, 0.12, mastTop - whTop, 0.12)
  box(mesh, 'chassis', 0, mastTop - 0.35, houseZ - 0.6, 1.6, 0.12, 0.2)
  railing(mesh, { w: width * 0.84, y0: deck + 0.1, h: 0.8, z: -length * 0.3, l: length * 0.3, posts: 3 })
  for (const side of [-1, 1]) {
    for (const z of [-6, -3, 0, 3]) ellipsoid(mesh, 'bellows', [side * width * 0.475, deck - 0.16, z], [0.09, 0.24, 0.45], 12, 8)
  }
  ellipsoid(mesh, 'body', [0, whTop + 0.24, houseZ + 0.5], [0.32, 0.24, 0.32], 16, 8)
  bridgeFront(mesh, { w: width * 0.46, y0: whTop - 1.35, y1: whTop - 0.25, z: houseZ + 0.4 - 1.7 - 0.06 })
  return mesh
}

/**
 * Coaster / general cargo (AIS 70–79): long hold with two hatch covers,
 * raised fo'c'sle, aft superstructure with the bridge on top.
 */
export function vesselCargo() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-cargo']
  const yBase = -height / 2
  const deck = yBase + 5
  hull(mesh, { length, width, yBase, depth: 5, material: 'hullRed', bow: 0.26 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 5, bow: 0.26 }) // weather deck
  // Fo'c'sle and the two hatch covers
  box(mesh, 'hullRed', 0, deck + 0.6, length / 2 - 8.5, width * 0.36, 1.2, 5)
  for (const z of [16, 2]) {
    box(mesh, 'body', 0, deck + 1.0, z, width * 0.62, 1.6, 12)
  }
  // Aft house: two decks plus bridge, funnel behind
  const houseZ = -length / 2 + 9
  house(mesh, { w: width * 0.72, y0: deck + 0.2, h: 4.6, z: houseZ, l: 9, panes: 3 })
  const bridgeY = deck + 4.8
  box(mesh, 'body', 0, bridgeY + 1.4, houseZ + 0.6, width * 0.8, 2.8, 6.4)
  windowBand(mesh, width * 0.8, bridgeY + 1.5, bridgeY + 2.5, houseZ - 2.4, houseZ + 3.4, { panes: 3 })
  bridgeFront(mesh, { w: width * 0.66, y0: bridgeY + 1.5, y1: bridgeY + 2.5, z: houseZ + 3.8 })
  box(mesh, 'roof', 0, bridgeY + 2.85, houseZ + 0.6, width * 0.74, 0.1, 6.0)
  funnel(mesh, { y0: bridgeY, h: height / 2 - 0.5 - bridgeY, z: houseZ - 5.2 })
  // Mast on the fo'c'sle
  box(mesh, 'chassis', 0, deck + 2.6, length / 2 - 4, 0.3, 4.4, 0.3)
  for (const z of [16, 2]) {
    for (let i = -4; i <= 4; i++) box(mesh, 'roof', 0, deck + 1.84, z + i * 1.2, width * 0.59, 0.06, 0.12)
  }
  return mesh
}

/**
 * Tanker (AIS 80–89): black hull, flush deck with the center pipeline
 * and midship manifold, white aft house.
 */
export function vesselTanker() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-tanker']
  const yBase = -height / 2
  const deck = yBase + 5
  hull(mesh, { length, width, yBase, depth: 5, material: 'chassis', bow: 0.32, taper: 0.17 })
  deckPlate(mesh, 'hullRed', { length, width, yBase, depth: 5, bow: 0.32, taper: 0.17, thickness: 0.18 }) // rust-red deck
  // Center pipeline with the midship manifold and its crossover
  for (const x of [-0.48, 0.48]) {
    rod(mesh, 'steel', [x, deck + 0.65, 6 - length * 0.31], [x, deck + 0.65, 6 + length * 0.31], 0.23, 16)
  }
  rod(mesh, 'steel', [-width * 0.3, deck + 0.7, 8], [width * 0.3, deck + 0.7, 8], 0.25, 16)
  for (const z of [-14, -2, 10, 22]) {
    for (const side of [-1, 1]) {
      rod(mesh, 'steel', [side * width * 0.25, deck + 0.2, z], [side * width * 0.25, deck + 0.45, z], 0.85, 16)
      rod(mesh, 'steel', [side * width * 0.25, deck + 0.6, z], [side * width * 0.25, deck + 1.7, z], 0.1)
    }
  }
  box(mesh, 'body', 0, deck + 1.1, length / 2 - 8, width * 0.3, 1.0, 4.5) // fo'c'sle locker
  const houseZ = -length / 2 + 9
  house(mesh, { w: width * 0.72, y0: deck + 0.2, h: 4.2, z: houseZ, l: 9, panes: 3 })
  const bridgeY = deck + 4.4
  box(mesh, 'body', 0, bridgeY + 1.3, houseZ + 0.6, width * 0.8, 2.6, 6.2)
  windowBand(mesh, width * 0.8, bridgeY + 1.4, bridgeY + 2.3, houseZ - 2.2, houseZ + 3.2, { panes: 3 })
  bridgeFront(mesh, { w: width * 0.66, y0: bridgeY + 1.4, y1: bridgeY + 2.3, z: houseZ + 3.7 })
  funnel(mesh, { y0: bridgeY, h: height / 2 - 0.5 - bridgeY, z: houseZ - 5.0 })
  return mesh
}

/**
 * Passenger ship / big ferry / cruise (AIS 60–69): dark lower hull, two
 * stepped white superstructure bands with long glass rows, bridge
 * spanning the full beam, funnel aft. Covers the Scandlines BERLIN as
 * well as an AIDA at Warnemünde – scaled by their reported size.
 */
export function vesselPassenger() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-passenger']
  const yBase = -height / 2
  const deck = yBase + 9
  // A cruise ship's beam runs nearly to the stem; the bands end where
  // the bow begins to narrow, and are a little inside the hull there
  hull(mesh, { length, width, yBase, depth: 9, material: 'hullBlue', bow: 0.14, taper: 0.16 })
  // Two stepped white bands, each with a long window row
  const band1Top = deck + 7
  box(mesh, 'body', 0, (deck + band1Top) / 2, -length * 0.01, width * 0.88, band1Top - deck, length * 0.74)
  for (const y of [deck + 1.1, deck + 4.4]) windowBand(mesh, width * 0.88, y, y + 1.05, -length * 0.36, length * 0.34, { panes: 42 })
  const band2Top = band1Top + 7
  box(mesh, 'body', 0, (band1Top + band2Top) / 2, -5, width * 0.8, band2Top - band1Top, length * 0.66)
  for (const y of [band1Top + 1.1, band1Top + 4.4]) windowBand(mesh, width * 0.8, y, y + 1.05, -length * 0.35, length * 0.26, { panes: 38 })
  // Bridge: full beam, glazed front, on the forward end of band 2
  const bridgeY = band2Top
  box(mesh, 'body', 0, bridgeY + 1.6, length * 0.24, width * 0.92, 3.2, 8)
  windowBand(mesh, width * 0.92, bridgeY + 1.7, bridgeY + 2.8, length * 0.24 - 3.6, length * 0.24 + 3.6, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.84, y0: bridgeY + 1.7, y1: bridgeY + 2.8, z: length * 0.24 + 4 })
  box(mesh, 'roof', 0, bridgeY + 3.25, length * 0.24, width * 0.88, 0.1, 7.6)
  box(mesh, 'roof', 0, band2Top + 0.05, -8, width * 0.74, 0.1, length * 0.6)
  funnel(mesh, { y0: band2Top, h: height / 2 - 0.6 - band2Top, z: -length * 0.28, w: 4.5, l: 7 })
  for (const side of [-1, 1]) {
    for (const z of [-35, -20, -5, 10]) {
      ellipsoid(mesh, 'safetyOrange', [side * width * 0.425, band1Top + 0.4, z], [0.85, 0.85, 3.6], 20, 10)
      rod(mesh, 'steel', [side * width * 0.38, band1Top + 1.4, z], [side * width * 0.44, band1Top + 1.4, z], 0.12)
    }
  }
  for (const z of [-16, 9]) ellipsoid(mesh, 'body', [0, band2Top + 1.0, z], [1.2, 1.0, 1.2], 20, 10)
  railing(mesh, { w: width * 0.75, y0: band2Top + 0.15, h: 1, z: -10, l: length * 0.55, posts: 22 })
  return mesh
}

/** Tug / pilot / SAR (AIS 50s): high bow, big wheelhouse, fender strake. */
export function vesselTug() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-tug']
  const yBase = -height / 2
  const deck = yBase + 2.6
  hull(mesh, { length, width, yBase, depth: 2.6, material: 'chassis', bow: 0.2, stern: 0.7 })
  // Fender strake all around at deck level – the tug's signature
  deckPlate(mesh, 'bellows', { length, width, yBase, depth: 2.6 - 0.42, bow: 0.2, stern: 0.7, inset: 1 + 0.08 / width, thickness: 0.55 })
  box(mesh, 'hullRed', 0, deck + 0.7, length / 2 - 5.2, width * 0.5, 1.4, 4) // raised bow
  // Deckhouse + tall wheelhouse, glazed all round
  house(mesh, { w: width * 0.6, y0: deck + 0.1, h: 2.0, z: 1.2, l: 6.5, panes: 2 })
  const whY = deck + 2.1
  const whTop = height / 2 - 0.7
  box(mesh, 'body', 0, (whY + whTop) / 2, 1.6, width * 0.48, whTop - whY, 3.6)
  windowBand(mesh, width * 0.48, whTop - 1.4, whTop - 0.3, 0.1, 3.1, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.4, y0: whTop - 1.4, y1: whTop - 0.3, z: 3.4 })
  box(mesh, 'roof', 0, whTop + 0.05, 1.6, width * 0.44, 0.1, 3.4)
  box(mesh, 'chassis', 0, whTop + 0.35, 1.0, 0.25, 0.7, 0.25) // mast, capped at H/2
  rod(mesh, 'steel', [-1.2, deck + 0.7, -6], [1.2, deck + 0.7, -6], 0.6, 20)
  for (const side of [-1, 1]) {
    for (const z of [-7, -3, 1, 5]) ellipsoid(mesh, 'bellows', [side * width * 0.475, deck - 0.08, z], [0.12, 0.4, 0.5], 12, 8)
  }
  bridgeFront(mesh, { w: width * 0.4, y0: whTop - 1.4, y1: whTop - 0.3, z: -0.25 })
  return mesh
}

/** Fishing vessel (AIS 30): blue hull, aft wheelhouse, forward mast+boom. */
export function vesselFishing() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-fishing']
  const yBase = -height / 2
  const deck = yBase + 1.9
  hull(mesh, { length, width, yBase, depth: 1.9, material: 'hullBlue', bow: 0.16, stern: 0.72 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 1.9, bow: 0.16, stern: 0.72, inset: 0.9, thickness: 0.12 })
  const whY = deck + 0.1
  const whTop = deck + 2.5
  box(mesh, 'body', 0, (whY + whTop) / 2, -length / 2 + 3.4, width * 0.62, whTop - whY, 3.6)
  windowBand(mesh, width * 0.62, whTop - 1.0, whTop - 0.25, -length / 2 + 2.0, -length / 2 + 4.6, { panes: 1 })
  bridgeFront(mesh, { w: width * 0.5, y0: whTop - 1.0, y1: whTop - 0.25, z: -length / 2 + 5.2 })
  // Mast with the boom raked aft over the working deck
  box(mesh, 'chassis', 0, deck + (height / 2 - deck) / 2 + 0.2, length / 2 - 5.2, 0.28, height / 2 - deck - 0.4, 0.28)
  box(mesh, 'chassis', 0, deck + 2.6, length / 2 - 7.4, 0.16, 0.16, 4.6)
  rod(mesh, 'steel', [-1, deck + 0.9, 0], [1, deck + 0.9, 0], 0.6, 16)
  for (const z of [1.8, 3]) {
    for (const x of [-0.7, 0.7]) roundedBox(mesh, 'boxGrey', x, deck + 0.35, z, 1.1, 0.55, 0.85)
  }
  rod(mesh, 'steel', [0, height / 2 - 0.2, length / 2 - 5.2], [0, deck + 2.65, length / 2 - 9.6], 0.018, 6)
  bridgeFront(mesh, { w: width * 0.5, y0: whTop - 1.0, y1: whTop - 0.25, z: -length / 2 + 1.6 - 0.06 })
  return mesh
}

/** Sailing yacht (AIS 36): slim white hull, low cabin, tall mast + boom. */
export function vesselSail() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-sail']
  const yBase = -height / 2
  const deck = yBase + 1.1
  hull(mesh, { length, width, yBase, depth: 1.1, material: 'hullWhite', bow: 0.06, stern: 0.5 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 1.1, bow: 0.06, stern: 0.5, inset: 0.86, thickness: 0.08 })
  box(mesh, 'hullWhite', 0, deck + 0.35, 0.8, width * 0.62, 0.6, length * 0.4)
  box(mesh, 'glass', 0, deck + 0.42, 0.8, width * 0.62 + 0.03, 0.28, length * 0.34)
  // Rig: mast just forward of midship, boom aft of it
  box(mesh, 'chassis', 0, deck + (height / 2 - deck) / 2, 0.9, 0.16, height / 2 - deck, 0.16)
  box(mesh, 'chassis', 0, deck + 1.5, 0.9 - length * 0.17, 0.12, 0.12, length * 0.32)
  for (const side of [-1, 1]) {
    rod(mesh, 'steel', [0, height / 2 - 0.2, 0.9], [side * 1.45, deck + 0.12, -0.7], 0.012, 6)
    rod(mesh, 'steel', [0, deck + 6, 0.9], [side * 0.9, deck + 6, 0.9], 0.028, 8)
  }
  rod(mesh, 'steel', [0, height / 2 - 0.2, 0.9], [0, deck + 0.12, length * 0.45], 0.014, 6)
  roundedBox(mesh, 'deckTeak', 0, deck + 0.12, -3.2, 1.7, 0.18, 2.5)
  return mesh
}

/** Motor yacht / pleasure craft (AIS 37): sporty white cruiser. */
export function vesselMotor() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-motor']
  const yBase = -height / 2
  const deck = yBase + 1.4
  hull(mesh, { length, width, yBase, depth: 1.4, material: 'hullWhite', bow: 0.1, stern: 0.85 })
  const cabin = createMesh()
  // Raked cabin with a wraparound glass band
  const cabTop = deck + 1.6
  box(cabin, 'hullWhite', 0, (deck + cabTop) / 2, 0.6, width * 0.8, cabTop - deck, length * 0.5)
  windowBand(mesh, width * 0.8, deck + 0.7, cabTop - 0.2, 0.6 - length * 0.22, 0.6 + length * 0.22, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.66, y0: deck + 0.7, y1: cabTop - 0.2, z: 0.6 + length * 0.25 })
  box(cabin, 'roof', 0, cabTop + 0.04, 0.6, width * 0.72, 0.08, length * 0.44)
  box(cabin, 'chassis', 0, cabTop + 0.5, -0.6, 0.9, 0.9, 0.14) // radar arch
  for (const g of cabin.groups.values()) {
    for (let i = 0; i < g.positions.length; i += 3) {
      const rise = Math.max(0, g.positions[i + 1] - deck)
      g.positions[i + 2] -= rise * 0.35
      // Inverse-transpose of the shear keeps the glazing reflections aligned.
      const nx = g.normals[i], ny = g.normals[i + 1] + 0.35 * g.normals[i + 2], nz = g.normals[i + 2]
      const norm = Math.hypot(nx, ny, nz)
      g.normals.splice(i, 3, nx / norm, ny / norm, nz / norm)
    }
  }
  mergeMesh(mesh, cabin)
  roundedBox(mesh, 'deckTeak', 0, deck + 0.06, -length * 0.36, width * 0.62, 0.1, 2.2)
  roundedBox(mesh, 'body', 0, cabTop + 0.18, -0.7, 1.8, 0.28, 1.3)
  ellipsoid(mesh, 'body', [0, cabTop + 0.8, -0.6], [0.27, 0.2, 0.27], 16, 8)
  return mesh
}

/** Workboat / unknown type: plain hull with a small deckhouse. */
export function vesselGeneric() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-generic']
  const yBase = -height / 2
  const deck = yBase + 1.6
  hull(mesh, { length, width, yBase, depth: 1.6, material: 'chassis', bow: 0.18, stern: 0.7 })
  deckPlate(mesh, 'roof', { length, width, yBase, depth: 1.6, bow: 0.18, stern: 0.7, inset: 0.9, thickness: 0.1 })
  const whTop = height / 2 - 0.3
  box(mesh, 'body', 0, (deck + whTop) / 2, -length / 2 + 3.6, width * 0.6, whTop - deck, 3.4)
  windowBand(mesh, width * 0.6, whTop - 0.9, whTop - 0.2, -length / 2 + 2.2, -length / 2 + 4.8, { panes: 1 })
  bridgeFront(mesh, { w: width * 0.48, y0: whTop - 0.9, y1: whTop - 0.2, z: -length / 2 + 5.3 })
  rod(mesh, 'steel', [-0.7, deck + 0.6, 1], [0.7, deck + 0.6, 1], 0.35, 16)
  roundedBox(mesh, 'boxGrey', 0, deck + 0.32, 3.7, 1.5, 0.5, 1.2)
  bridgeFront(mesh, { w: width * 0.48, y0: whTop - 0.9, y1: whTop - 0.2, z: -length / 2 + 1.9 - 0.06 })
  return mesh
}

/** Archetype name → builder, mirrored by VESSEL_DIMS. */
export const VESSELS = {
  'vessel-container': vesselContainer,
  'vessel-cargo': vesselCargo,
  'vessel-barge': vesselBarge,
  'vessel-dredger': vesselDredger,
  'vessel-tender': vesselTender,
  'vessel-pilot': vesselPilot,
  'vessel-patrol': vesselPatrol,
  'vessel-tanker': vesselTanker,
  'vessel-passenger': vesselPassenger,
  'vessel-tug': vesselTug,
  'vessel-fishing': vesselFishing,
  'vessel-sail': vesselSail,
  'vessel-motor': vesselMotor,
  'vessel-generic': vesselGeneric,
}
