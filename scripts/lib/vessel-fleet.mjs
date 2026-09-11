/**
 * Low-poly hulls for the AIS backdrop fleet, in the same visual language
 * as the Rostock vehicle fleet (see vehicle-fleet.mjs, especially the two
 * ferries): flat-shaded prism hulls, boxy superstructures, glass bands,
 * muted PBR palette. One archetype per AIS ship-type group – the layer
 * picks by type code and stretches the model to the vessel's reported
 * dimensions, so a 90 m reference coaster becomes the 199 m CEMLUNA or a
 * 60 m bunker barge by scaling, not by new geometry.
 *
 * Conventions as everywhere: 1 unit = 1 m, Y-up, +Z is the bow, origin
 * mid-length at half the total height, the waterline at y = -height/2.
 * VESSEL_DIMS (reference length/width/height) is the contract with
 * src/map/VesselLayer.ts and the model tests.
 */

import { MATERIALS, bodyProfile, box, createMesh, extrude, windowBand } from './vehicle-mesh.mjs'

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
  'vessel-pilot': { length: 20, width: 6, height: 7.5 },
  'vessel-tug': { length: 26, width: 9, height: 10 },
  'vessel-fishing': { length: 18, width: 5.5, height: 7.5 },
  'vessel-sail': { length: 12, width: 3.8, height: 14 },
  'vessel-motor': { length: 14, width: 4.2, height: 5 },
  'vessel-generic': { length: 16, width: 5, height: 5.5 },
}

/**
 * Ship hull: raked bow at +Z, near-full transom at -Z, both slightly
 * lifted so the taper reads as flare instead of a scoop.
 */
function hull(mesh, { length, width, yBase, depth, material, bow = 0.1, stern = 0.55 }) {
  const profile = bodyProfile(width, yBase, yBase + depth, Math.min(0.3, width * 0.05))
  extrude(
    mesh,
    profile,
    [
      { z: -length / 2, sx: stern, sy: 0.88 },
      { z: -length / 2 + length * 0.12 },
      { z: length / 2 - length * 0.22 },
      { z: length / 2, sx: bow, sy: 0.94 },
    ],
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
  box(mesh, 'glass', 0, (y0 + y1) / 2, z + 0.015, w, y1 - y0, 0.03)
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
  box(mesh, 'body', 0, y0 + h / 2, z, w, h, l)
  box(mesh, 'chassis', 0, y0 + h + 0.25, z, w * 0.92, 0.5, l * 0.92)
  mesh.funnel = { z, top: y0 + h + 0.5, width: w }
}

/**
 * Rail along a deck edge: a thin top rope on short stanchions. Cheap in
 * triangles and it is what turns a slab into a deck someone stands on.
 */
function railing(mesh, { w, y0, h, z, l, posts = 5 }) {
  for (const side of [-1, 1]) {
    box(mesh, 'chassis', (side * w) / 2, y0 + h, z, 0.06, 0.06, l)
    for (let i = 0; i < posts; i++) {
      const pz = z - l / 2 + (l * (i + 0.5)) / posts
      box(mesh, 'chassis', (side * w) / 2, y0 + h / 2, pz, 0.05, h, 0.05)
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
  hull(mesh, { length, width, yBase, depth: 18, material: 'hullBlue', bow: 0.08, stern: 0.62 })
  box(mesh, 'roof', 0, deck + 0.1, 0, width * 0.94, 0.2, length * 0.9) // weather deck
  // Box bays: alternating materials read as mixed boxes at any distance,
  // one solid slab would read as a bulk carrier.
  const bays = 6
  const cargoStart = -length * 0.2
  const cargoEnd = length * 0.44
  const span = cargoEnd - cargoStart
  const lashGap = 2.4
  const bayLength = (span - lashGap * (bays - 1)) / bays
  for (let i = 0; i < bays; i++) {
    const z = cargoStart + i * (bayLength + lashGap) + bayLength / 2
    const t = (z - cargoStart) / span
    const taper = Math.max(0, t - 0.6) / 0.4
    const w = width * (0.93 - 0.2 * taper)
    const h = 13.5 - 4.5 * taper
    box(mesh, i % 2 === 0 ? 'body' : 'hullRed', 0, deck + 0.3 + h / 2, z, w, h, bayLength)
  }
  // Two more bays behind the house, one tier lower than the forward stacks
  for (const z of [-length * 0.4, -length * 0.325]) {
    box(mesh, 'body', 0, deck + 0.3 + 4.5, z, width * 0.86, 9, bayLength * 0.7)
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
  box(mesh, 'hullRed', 0, deck + 0.08, 0, width * 0.94, 0.16, length * 0.9) // gangway deck
  // Hold: two coamings with the dark cargo space between them
  const holdZ = length * 0.06
  const holdL = length * 0.62
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
  // Fo'c'sle locker and the bow winch post
  box(mesh, 'body', 0, deck + 0.55, length / 2 - 3.5, width * 0.6, 0.9, 4)
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
  hull(mesh, { length, width, yBase, depth: 7, material: 'hullRed', bow: 0.12, stern: 0.66 })
  box(mesh, 'roof', 0, deck + 0.1, -4, width * 0.94, 0.2, length * 0.86)
  // The hopper: coamings port and starboard, the well dark between them
  const hopperZ = -length * 0.06
  const hopperL = length * 0.46
  for (const side of [-1, 1]) {
    box(mesh, 'body', (side * width * 0.8) / 2, deck + 1.3, hopperZ, width * 0.14, 2.4, hopperL)
  }
  box(mesh, 'bellows', 0, deck + 0.7, hopperZ, width * 0.62, 1.2, hopperL)
  // Suction pipe along the starboard side, raked down toward the bow on
  // its gantry – a square profile walked down through its stations.
  const pipeX = width * 0.44
  const pipeR = 0.9
  extrude(
    mesh,
    [
      [pipeX - pipeR, deck + 1],
      [pipeX + pipeR, deck + 1],
      [pipeX + pipeR, deck + 1 + 2 * pipeR],
      [pipeX - pipeR, deck + 1 + 2 * pipeR],
    ],
    [
      { z: -length * 0.16 },
      { z: length * 0.1, yOff: -1.2 },
      { z: length * 0.34, yOff: -4.6 },
      { z: length * 0.42, yOff: -6.4, sx: 0.8 },
    ],
    { material: 'chassis', yAnchor: deck },
  )
  for (const z of [-length * 0.12, length * 0.16]) {
    box(mesh, 'chassis', pipeX, deck + 2.6, z, 0.5, 5, 0.5) // gantry davits
    box(mesh, 'chassis', pipeX, deck + 5, z, 0.5, 0.4, 3)
  }
  // Bridge forward, funnel aft
  const houseZ = length * 0.3
  const houseTop = deck + 6.5
  box(mesh, 'body', 0, (deck + houseTop) / 2, houseZ, width * 0.72, houseTop - deck, 12)
  windowBand(mesh, width * 0.72, deck + 1.4, deck + 2.8, houseZ - 5, houseZ + 5, { panes: 3 })
  box(mesh, 'body', 0, houseTop + 1.3, houseZ - 0.5, width * 0.86, 2.6, 7)
  windowBand(mesh, width * 0.86, houseTop + 1.3, houseTop + 2.3, houseZ - 3.5, houseZ + 2.5, { panes: 3 })
  bridgeFront(mesh, { w: width * 0.72, y0: houseTop + 1.3, y1: houseTop + 2.3, z: houseZ + 3.02 })
  box(mesh, 'roof', 0, houseTop + 2.7, houseZ - 0.5, width * 0.8, 0.2, 6.6)
  funnel(mesh, { y0: deck, h: height / 2 - 1 - deck, z: -length / 2 + 7, w: 3, l: 4.5 })
  box(mesh, 'chassis', 0, houseTop + 3.6, houseZ - 0.5, 0.4, 1.8, 0.4) // radar mast
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
  box(mesh, 'chassis', 0, deck - 0.1, 0, width + 0.06, 0.3, length * 0.86) // rubbing strake
  box(mesh, 'roof', 0, deck + 0.05, 0, width * 0.9, 0.1, length * 0.88)
  // The cabin: one long glass box, the barkasse's whole silhouette
  const cabZ = -0.6
  const cabL = length * 0.66
  const cabTop = deck + 2.0
  box(mesh, 'hullWhite', 0, (deck + cabTop) / 2, cabZ, width * 0.88, cabTop - deck, cabL)
  windowBand(mesh, width * 0.88, deck + 0.75, cabTop - 0.35, cabZ - cabL / 2 + 0.4, cabZ + cabL / 2 - 0.4, {
    panes: 6,
  })
  bridgeFront(mesh, { w: width * 0.72, y0: deck + 0.75, y1: cabTop - 0.35, z: cabZ + cabL / 2 + 0.02 })
  box(mesh, 'roof', 0, cabTop + 0.06, cabZ, width * 0.94, 0.12, cabL + 0.6)
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
  return mesh
}

/**
 * Pilot boat (AIS 50, and the patrol and rescue craft of 51 and 55): a
 * dark, deep-sheered hull built to lie alongside a moving ship – heavy
 * fendering, the wheelhouse well forward, a low working deck aft where
 * the pilot steps across, and a mast that carries more aerials than the
 * boat seems able to.
 */
export function vesselPilot() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-pilot']
  const yBase = -height / 2
  const deck = yBase + 2.0
  hull(mesh, { length, width, yBase, depth: 2.0, material: 'chassis', bow: 0.14, stern: 0.78 })
  // The fendering a boat takes ship's-side contact on, all the way round
  box(mesh, 'bellows', 0, deck - 0.25, 0.6, width + 0.06, 0.7, length * 0.88)
  box(mesh, 'roof', 0, deck + 0.05, -2, width * 0.9, 0.1, length * 0.8)
  // Deckhouse forward of midship, wheelhouse glazed on top of it
  const houseZ = length * 0.14
  const houseTop = deck + 1.9
  box(mesh, 'hullWhite', 0, (deck + houseTop) / 2, houseZ, width * 0.76, houseTop - deck, length * 0.42)
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
  hull(mesh, { length, width, yBase, depth: 5, material: 'hullRed' })
  box(mesh, 'roof', 0, deck + 0.1, 2, width * 0.94, 0.2, length * 0.8) // weather deck
  // Fo'c'sle and the two hatch covers
  box(mesh, 'hullRed', 0, deck + 0.6, length / 2 - 3.4, width * 0.7, 1.2, 5.5)
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
  hull(mesh, { length, width, yBase, depth: 5, material: 'chassis' })
  box(mesh, 'hullRed', 0, deck + 0.09, 2, width * 0.94, 0.18, length * 0.82) // rust-red deck
  // Center pipeline with the midship manifold and its crossover
  box(mesh, 'roof', 0, deck + 0.55, 6, 1.2, 0.7, length * 0.62)
  box(mesh, 'roof', 0, deck + 0.7, 8, width * 0.6, 0.5, 2.2)
  box(mesh, 'body', 0, deck + 1.1, length / 2 - 4, width * 0.55, 1.0, 4.5) // fo'c'sle locker
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
  hull(mesh, { length, width, yBase, depth: 9, material: 'hullBlue', bow: 0.06 })
  // Two stepped white bands, each with a long window row
  const band1Top = deck + 7
  box(mesh, 'body', 0, (deck + band1Top) / 2, -2, width * 0.96, band1Top - deck, length * 0.86)
  windowBand(mesh, width * 0.96, deck + 3.2, deck + 5.4, -length * 0.4, length * 0.36, { panes: 10 })
  const band2Top = band1Top + 7
  box(mesh, 'body', 0, (band1Top + band2Top) / 2, -5, width * 0.88, band2Top - band1Top, length * 0.68)
  windowBand(mesh, width * 0.88, band1Top + 2.6, band1Top + 4.8, -length * 0.38, length * 0.26, { panes: 9 })
  // Bridge: full beam, glazed front, on the forward end of band 2
  const bridgeY = band2Top
  box(mesh, 'body', 0, bridgeY + 1.6, length * 0.24, width, 3.2, 8)
  windowBand(mesh, width, bridgeY + 1.7, bridgeY + 2.8, length * 0.24 - 3.6, length * 0.24 + 3.6, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.9, y0: bridgeY + 1.7, y1: bridgeY + 2.8, z: length * 0.24 + 4 })
  box(mesh, 'roof', 0, bridgeY + 3.25, length * 0.24, width * 0.94, 0.1, 7.6)
  box(mesh, 'roof', 0, band2Top + 0.05, -8, width * 0.8, 0.1, length * 0.6)
  funnel(mesh, { y0: band2Top, h: height / 2 - 0.6 - band2Top, z: -length * 0.28, w: 4.5, l: 7 })
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
  box(mesh, 'bellows', 0, deck - 0.15, 0.4, width + 0.08, 0.55, length * 0.86)
  box(mesh, 'hullRed', 0, deck + 0.7, length / 2 - 2.6, width * 0.72, 1.4, 4.4) // raised bow
  // Deckhouse + tall wheelhouse, glazed all round
  house(mesh, { w: width * 0.6, y0: deck + 0.1, h: 2.0, z: 1.2, l: 6.5, panes: 2 })
  const whY = deck + 2.1
  const whTop = height / 2 - 0.7
  box(mesh, 'body', 0, (whY + whTop) / 2, 1.6, width * 0.48, whTop - whY, 3.6)
  windowBand(mesh, width * 0.48, whTop - 1.4, whTop - 0.3, 0.1, 3.1, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.4, y0: whTop - 1.4, y1: whTop - 0.3, z: 3.4 })
  box(mesh, 'roof', 0, whTop + 0.05, 1.6, width * 0.44, 0.1, 3.4)
  box(mesh, 'chassis', 0, whTop + 0.35, 1.0, 0.25, 0.7, 0.25) // mast, capped at H/2
  return mesh
}

/** Fishing vessel (AIS 30): blue hull, aft wheelhouse, forward mast+boom. */
export function vesselFishing() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-fishing']
  const yBase = -height / 2
  const deck = yBase + 1.9
  hull(mesh, { length, width, yBase, depth: 1.9, material: 'hullBlue', bow: 0.16, stern: 0.72 })
  box(mesh, 'roof', 0, deck + 0.06, 0.5, width * 0.9, 0.12, length * 0.82)
  const whY = deck + 0.1
  const whTop = deck + 2.5
  box(mesh, 'body', 0, (whY + whTop) / 2, -length / 2 + 3.4, width * 0.62, whTop - whY, 3.6)
  windowBand(mesh, width * 0.62, whTop - 1.0, whTop - 0.25, -length / 2 + 2.0, -length / 2 + 4.6, { panes: 1 })
  bridgeFront(mesh, { w: width * 0.5, y0: whTop - 1.0, y1: whTop - 0.25, z: -length / 2 + 5.2 })
  // Mast with the boom raked aft over the working deck
  box(mesh, 'chassis', 0, deck + (height / 2 - deck) / 2 + 0.2, length / 2 - 5.2, 0.28, height / 2 - deck - 0.4, 0.28)
  box(mesh, 'chassis', 0, deck + 2.6, length / 2 - 7.4, 0.16, 0.16, 4.6)
  return mesh
}

/** Sailing yacht (AIS 36): slim white hull, low cabin, tall mast + boom. */
export function vesselSail() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-sail']
  const yBase = -height / 2
  const deck = yBase + 1.1
  hull(mesh, { length, width, yBase, depth: 1.1, material: 'hullWhite', bow: 0.06, stern: 0.5 })
  box(mesh, 'roof', 0, deck + 0.04, 0.3, width * 0.86, 0.08, length * 0.86)
  box(mesh, 'hullWhite', 0, deck + 0.35, 0.8, width * 0.62, 0.6, length * 0.4)
  box(mesh, 'glass', 0, deck + 0.42, 0.8, width * 0.62 + 0.03, 0.28, length * 0.34)
  // Rig: mast just forward of midship, boom aft of it
  box(mesh, 'chassis', 0, deck + (height / 2 - deck) / 2, 0.9, 0.16, height / 2 - deck, 0.16)
  box(mesh, 'chassis', 0, deck + 1.5, 0.9 - length * 0.17, 0.12, 0.12, length * 0.32)
  return mesh
}

/** Motor yacht / pleasure craft (AIS 37): sporty white cruiser. */
export function vesselMotor() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-motor']
  const yBase = -height / 2
  const deck = yBase + 1.4
  hull(mesh, { length, width, yBase, depth: 1.4, material: 'hullWhite', bow: 0.1, stern: 0.85 })
  // Raked cabin with a wraparound glass band
  const cabTop = deck + 1.6
  box(mesh, 'hullWhite', 0, (deck + cabTop) / 2, 0.6, width * 0.8, cabTop - deck, length * 0.5)
  windowBand(mesh, width * 0.8, deck + 0.7, cabTop - 0.2, 0.6 - length * 0.22, 0.6 + length * 0.22, { panes: 2 })
  bridgeFront(mesh, { w: width * 0.66, y0: deck + 0.7, y1: cabTop - 0.2, z: 0.6 + length * 0.25 })
  box(mesh, 'roof', 0, cabTop + 0.04, 0.6, width * 0.72, 0.08, length * 0.44)
  box(mesh, 'chassis', 0, cabTop + 0.5, -0.6, 0.9, 0.9, 0.14) // radar arch
  return mesh
}

/** Workboat / unknown type: plain hull with a small deckhouse. */
export function vesselGeneric() {
  const mesh = createMesh()
  const { length, width, height } = VESSEL_DIMS['vessel-generic']
  const yBase = -height / 2
  const deck = yBase + 1.6
  hull(mesh, { length, width, yBase, depth: 1.6, material: 'chassis', bow: 0.18, stern: 0.7 })
  box(mesh, 'roof', 0, deck + 0.05, 0.4, width * 0.9, 0.1, length * 0.84)
  const whTop = height / 2 - 0.3
  box(mesh, 'body', 0, (deck + whTop) / 2, -length / 2 + 3.6, width * 0.6, whTop - deck, 3.4)
  windowBand(mesh, width * 0.6, whTop - 0.9, whTop - 0.2, -length / 2 + 2.2, -length / 2 + 4.8, { panes: 1 })
  bridgeFront(mesh, { w: width * 0.48, y0: whTop - 0.9, y1: whTop - 0.2, z: -length / 2 + 5.3 })
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
  'vessel-tanker': vesselTanker,
  'vessel-passenger': vesselPassenger,
  'vessel-tug': vesselTug,
  'vessel-fishing': vesselFishing,
  'vessel-sail': vesselSail,
  'vessel-motor': vesselMotor,
  'vessel-generic': vesselGeneric,
}
