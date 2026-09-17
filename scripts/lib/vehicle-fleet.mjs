/**
 * The Rostock fleet as low-poly meshes, dimensioned after the real
 * vehicles (see src/config.ts):
 *
 *   tram   Vossloh 6N2 – 32 m five-section articulated tram
 *   train  Talent 2 (BR 442) – 56.8 m three-car unit, Jakobs-articulated
 *   bus    12 m rigid city bus
 *
 * and, for Berlin, a third-rail subway section that the U-Bahn (BR H)
 * and the S-Bahn (BR 481) share as six-section consists:
 *
 *   subway 13 m articulated section, cab and middle variants
 *
 * Split into one mesh per car/section; the runtime couples them into
 * consists (see VEHICLE_MODELS in src/map/VehicleLayer.ts). All meshes
 * share the conventions of vehicle-mesh.mjs: meters, Y-up, +Z = travel,
 * origin mid-length at half the overall height.
 */

import {
  bodyProfile,
  bogie,
  box,
  createMesh,
  doorHole,
  doors,
  extrude,
  pantograph,
  quad,
  windowBand,
} from './vehicle-mesh.mjs'

import { ellipsoid, mergeMesh, rod, roundedBox, smoothSurface } from './model-detail.mjs'
import { detailedBus } from './bus-model.mjs'

/** Round bilges and a fuller transition to each end of a double-ended ferry. */
function ferryHull(mesh, { length, width, yBase, deck, taper, end, material }) {
  const profile = [[0.7, 0], [0.88, 0.08], [0.98, 0.3], [1, 0.7], [1, 0.96], [0.98, 1]]
  const section = [...profile, ...profile.toReversed().map(([x, y]) => [-x, y])].map(([x, y]) => [x * width / 2, yBase + y * (deck - yBase)])
  const tip = (z, f) => ({ z, sx: end + (1 - end) * Math.sqrt(1 - f * f), sy: 1 - 0.1 * f * f })
  const fractions = [1, 0.96, 0.85, 0.65, 0.35, 0]
  const stations = [...fractions.map((f) => tip(-length / 2 + taper * (1 - f), f)), ...fractions.toReversed().map((f) => tip(length / 2 - taper * (1 - f), f))]
  const shell = createMesh()
  extrude(shell, section, stations, { material, yAnchor: yBase })
  mergeMesh(mesh, smoothSurface(shell, 50))
  // Fender tubes on both long sides, where the ferry meets a landing.
  for (const side of [-1, 1]) {
    rod(mesh, 'bellows', [side * (width / 2 - 0.04), deck - 0.24, -length / 2 + taper], [side * (width / 2 - 0.04), deck - 0.24, length / 2 - taper], 0.055, 12)
    for (const z of [-length * 0.24, length * 0.24]) {
      rod(mesh, 'steel', [side * width * 0.39, deck + 0.03, z], [side * width * 0.39, deck + 0.37, z], 0.07)
    }
  }
}

function ferryRail(mesh, x, y, z0, z1, height = 0.65) {
  for (const h of [height * 0.5, height]) rod(mesh, 'steel', [x, y + h, z0], [x, y + h, z1], 0.022, 8)
  const count = Math.ceil((z1 - z0) / 1.4)
  for (let i = 0; i <= count; i++) {
    const z = z0 + (z1 - z0) * i / count
    rod(mesh, 'steel', [x, y, z], [x, y + height, z], 0.022, 8)
  }
}

/** Overall heights (rail to roof gear) – the layer's halfHeight. */
export const HEIGHTS = { tram: 3.6, train: 4.3, bus: 3.1, subway: 3.4 }

/**
 * The mesh's -X renders as the right-hand side of travel: Cesium maps
 * glTF +Z onto the vehicle's forward axis and glTF +X onto its LEFT.
 * Confirmed by a human looking at the running app – screenshots kept
 * misleading here (a camera placed by compass math trusted the snapshot
 * bearing of a bus dwelling at a stop, and nose-vs-tail is genuinely
 * hard to tell on a low-poly model), so when this side ever looks wrong
 * again: check it in the app, not on stills.
 * Buses and the unidirectional 6N2 board on this side only; the
 * Talent 2 keeps doors in both walls. A flipped rear cab car swaps the
 * sides, which is why the tram's rear end section is its own mesh
 * (tram-end-rear) with the door mirrored to +X.
 */
const RIGHT = [-1]
const MIRRORED = [1]

/**
 * Shared vertical layout of a car: skirt from the wheels up to the
 * floor, body shell above, roof sheet on top.
 *
 * A nose is one taper station at the tip; an optional `shoulder`
 * (`{ length, sx, sy }`, measured from the same tip) adds a second,
 * gentler station before it – a two-step taper that reads as a rounded
 * snout instead of a wedge. Without one the stations are exactly what
 * they always were, so the older meshes serialize byte-identically.
 */
function carShell(mesh, { length, width, bodyTop, floor, noseFront, noseBack, bevel = 0.16, yBase, clearance = 0.02 }) {
  const half = length / 2
  const skirtTop = yBase + 0.55
  // Skirt: full-length dark under-floor box hiding the gap to the road.
  // For rail vehicles it reaches within 2 cm of the wheel plane (the
  // bogies alone touch the rail – and two chassis faces sharing the
  // exact wheel plane were one of the coplanar double-draws the fleet
  // test now rejects). The bus uses its own shell with open wheel arches.
  const skirtBottom = yBase + clearance
  const skirtHeight = skirtTop + 0.36 - skirtBottom
  box(mesh, 'chassis', 0, skirtBottom + skirtHeight / 2, 0, width - 0.24, skirtHeight, length - 0.1)

  const profile = bodyProfile(width, floor - 0.45, bodyTop, bevel)
  const stations = []
  if (noseBack) {
    stations.push({ z: -half + 0.0, sx: noseBack.sx, sy: noseBack.sy })
    if (noseBack.shoulder) {
      const s = noseBack.shoulder
      stations.push({ z: -half + s.length, sx: s.sx, sy: s.sy })
    }
    stations.push({ z: -half + noseBack.length })
  } else {
    stations.push({ z: -half })
  }
  if (noseFront) {
    stations.push({ z: half - noseFront.length })
    if (noseFront.shoulder) {
      const s = noseFront.shoulder
      stations.push({ z: half - s.length, sx: s.sx, sy: s.sy })
    }
    stations.push({ z: half, sx: noseFront.sx, sy: noseFront.sy })
  } else {
    stations.push({ z: half })
  }
  extrude(mesh, profile, stations, {
    material: 'body',
    yAnchor: floor - 0.45,
    capMaterials: [
      noseBack ? 'glass' : 'bellows',
      noseFront ? 'glass' : 'bellows',
    ],
  })
  // Roof sheet: the bird's-eye view is this app's default view, so the
  // top of every car is the silver-grey roof a real vehicle shows from
  // above – full length, with only a slim body-colored edge remaining.
  // Nose sections keep the sheet off the raked cab.
  const front = noseFront ? noseFront.length + 0.2 : 0.25
  const back = noseBack ? noseBack.length + 0.2 : 0.25
  box(
    mesh,
    'roof',
    0,
    bodyTop + 0.045,
    (back - front) / 2,
    width * 0.92,
    0.09,
    length - front - back,
  )
}

/**
 * Vossloh 6N2 end section (cab at +Z). `doorSides` defaults to the
 * right wall; the rear section of the consist rides flipped 180° and
 * passes MIRRORED so its door comes out on the right side of the CAR.
 */
export function tramEnd({ doorSides = RIGHT } = {}) {
  const mesh = createMesh()
  const H = HEIGHTS.tram
  const yBase = -H / 2
  const width = 2.65
  const length = 6.55
  const floor = yBase + 0.9
  const bodyTop = yBase + 3.3
  carShell(mesh, {
    length,
    width,
    bodyTop,
    floor,
    yBase,
    noseFront: { length: 1.35, sx: 0.6, sy: 0.86 },
  })
  const winTop = bodyTop - 0.28
  const winBottom = floor + 0.35
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.35, length / 2 - 1.75, {
    panes: 2,
    holes: [doorHole(-0.35, undefined, doorSides)],
  })
  doors(mesh, width, floor - 0.42, winTop, -0.35, undefined, doorSides)
  bogie(mesh, yBase, -length / 2 + 1.35, width)
  // Rooftop resistor/AC hump behind the cab
  box(mesh, 'roof', 0, bodyTop + 0.16, -0.9, width * 0.6, 0.22, 2.2)
  return mesh
}

/** 6N2 middle section (bellows both ends); `withPantograph` for section 2. */
export function tramMid({ withPantograph = false } = {}) {
  const mesh = createMesh()
  const H = HEIGHTS.tram
  const yBase = -H / 2
  const width = 2.65
  const length = 6.1
  const floor = yBase + 0.9
  const bodyTop = yBase + 3.3
  carShell(mesh, { length, width, bodyTop, floor, yBase })
  // Bellows collars at both couplings
  for (const dir of [-1, 1]) {
    box(mesh, 'bellows', 0, (floor - 0.45 + bodyTop) / 2, dir * (length / 2 - 0.06), width * 0.9, bodyTop - floor + 0.3, 0.24)
  }
  const winTop = bodyTop - 0.28
  const winBottom = floor + 0.35
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.5, length / 2 - 0.5, {
    panes: 2,
    holes: [doorHole(0, undefined, RIGHT)],
  })
  doors(mesh, width, floor - 0.42, winTop, 0, undefined, RIGHT)
  bogie(mesh, yBase, 0, width)
  if (withPantograph) pantograph(mesh, bodyTop + 0.09, 0.4, H / 2)
  else box(mesh, 'roof', 0, bodyTop + 0.16, 0, width * 0.6, 0.22, 2.4)
  return mesh
}

/** Talent 2 end car (cab at +Z, the raked Talent nose). */
export function sbahnEnd() {
  const mesh = createMesh()
  const H = HEIGHTS.train
  const yBase = -H / 2
  const width = 2.92
  const length = 18.6
  const floor = yBase + 1.0
  const bodyTop = yBase + 3.95
  carShell(mesh, {
    length,
    width,
    bodyTop,
    floor,
    yBase,
    bevel: 0.22,
    noseFront: { length: 2.3, sx: 0.55, sy: 0.8 },
  })
  const winTop = bodyTop - 0.5
  const winBottom = floor + 0.55
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.6, length / 2 - 3.1, {
    panes: 6,
    holes: [doorHole(-length / 2 + 3.6), doorHole(length / 2 - 5.2)],
  })
  doors(mesh, width, floor - 0.42, winTop, -length / 2 + 3.6)
  doors(mesh, width, floor - 0.42, winTop, length / 2 - 5.2)
  bogie(mesh, yBase, -length / 2 + 2.6, width)
  bogie(mesh, yBase, length / 2 - 2.2, width)
  box(mesh, 'roof', 0, bodyTop + 0.2, -2.5, width * 0.62, 0.3, 5.5)
  return mesh
}

/** Talent 2 middle car, pantograph amidships. */
export function sbahnMid() {
  const mesh = createMesh()
  const H = HEIGHTS.train
  const yBase = -H / 2
  const width = 2.92
  const length = 18.9
  const floor = yBase + 1.0
  const bodyTop = yBase + 3.95
  carShell(mesh, { length, width, bodyTop, floor, yBase, bevel: 0.22 })
  for (const dir of [-1, 1]) {
    box(mesh, 'bellows', 0, (floor - 0.45 + bodyTop) / 2, dir * (length / 2 - 0.06), width * 0.88, bodyTop - floor + 0.2, 0.28)
  }
  const winTop = bodyTop - 0.5
  const winBottom = floor + 0.55
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.7, length / 2 - 0.7, {
    panes: 6,
    holes: [doorHole(-length / 2 + 4.4), doorHole(length / 2 - 4.4)],
  })
  doors(mesh, width, floor - 0.42, winTop, -length / 2 + 4.4)
  doors(mesh, width, floor - 0.42, winTop, length / 2 - 4.4)
  // Jakobs bogies sit under the articulations; pulled just inside the
  // car so the mesh stays within its declared length
  bogie(mesh, yBase, -length / 2 + 1.05, width)
  bogie(mesh, yBase, length / 2 - 1.05, width)
  pantograph(mesh, bodyTop + 0.09, 0, H / 2)
  box(mesh, 'roof', 0, bodyTop + 0.2, -5.2, width * 0.62, 0.3, 4.5)
  return mesh
}

/** Detailed 12 m low-floor city bus; the rail fleet keeps its original helpers. */
export function bus() {
  return detailedBus(HEIGHTS.bus)
}

/**
 * Warnow ferry Kabutzenhof–Gehlsdorf: a small double-ended passenger
 * ferry (19.9 × 6.6 × 3.5 m per network.json) – low hull pointed at both
 * ends, a glazed full-width cabin, wheelhouse amidships. Symmetric fore
 * and aft like the real vessel, which never turns around.
 */
export function ferryGehlsdorf() {
  const mesh = createMesh()
  const H = 3.5
  const yBase = -H / 2 // waterline
  const length = 19.9
  const width = 6.6
  const hullTop = yBase + 1.2

  // Hull: dark, pointed at both ends
  ferryHull(mesh, { length, width, yBase, deck: hullTop, taper: 2.6, end: 0.3, material: 'chassis' })

  // Cabin: white, glazed on all four sides
  const cabinW = 5.0
  const cabinL = 12
  const cabinTop = hullTop + 1.6
  roundedBox(mesh, 'body', 0, (hullTop + cabinTop) / 2, 0, cabinW, cabinTop - hullTop, cabinL)
  windowBand(mesh, cabinW, hullTop + 0.4, cabinTop - 0.25, -cabinL / 2 + 0.4, cabinL / 2 - 0.4, {
    panes: 4,
  })
  for (const dir of [-1, 1]) {
    box(mesh, 'glass', 0, (hullTop + cabinTop) / 2 + 0.12, dir * (cabinL / 2 + 0.015), 3.4, 1.0, 0.03)
  }

  // Wheelhouse amidships, glazed all round, roof flush with the height cap
  const whTop = H / 2
  roundedBox(mesh, 'body', 0, (cabinTop + whTop) / 2, 0, 2.6, whTop - cabinTop, 2.8)
  for (const side of [-1, 1]) {
    box(mesh, 'glass', side * (2.6 / 2 + 0.015), (cabinTop + whTop) / 2 + 0.05, 0, 0.03, 0.42, 2.2)
    box(mesh, 'glass', 0, (cabinTop + whTop) / 2 + 0.05, side * (2.8 / 2 + 0.015), 2.0, 0.42, 0.03)
  }

  // Cabin roof fore and aft of the wheelhouse (clear of its footprint,
  // so no two down-facing faces share the cabin-top plane)
  for (const dir of [-1, 1]) {
    box(mesh, 'roof', 0, cabinTop + 0.03, dir * (cabinL / 2 / 2 + 0.85), cabinW * 0.9, 0.06, cabinL / 2 - 1.75)
  }
  for (const side of [-1, 1]) {
    ferryRail(mesh, side * width * 0.43, hullTop + 0.05, -7.1, -6.1)
    ferryRail(mesh, side * width * 0.43, hullTop + 0.05, 6.1, 7.1)
    ellipsoid(mesh, 'body', [side * 1.65, cabinTop + 0.18, -3.8], [0.24, 0.16, 0.65], 16, 8)
  }
  for (const z of [-3, 3]) roundedBox(mesh, 'roof', 0, cabinTop + 0.13, z, 0.7, 0.12, 0.9)
  return mesh
}

/**
 * Breitling ferry Warnemünde–Hohe Düne: the double-ended car ferry
 * (39 × 11 × 6 m per network.json) – open car deck between white
 * bulwarks, boarding ramps raked up at both ends, deckhouse with the
 * bridge on the starboard side. Fore-aft symmetric; on the return leg
 * the 180° rotation puts the house on the other side, exactly like the
 * real double-ender.
 */
export function ferryBreitling() {
  const mesh = createMesh()
  const H = 6
  const yBase = -H / 2 // waterline
  const length = 39
  const width = 11
  const deck = yBase + 1.7

  // Hull with double-ended taper
  ferryHull(mesh, { length, width, yBase, deck: deck, taper: 4, end: 0.5, material: 'body' })
  // Car deck plate between the ramps (its underside sits inside the hull)
  box(mesh, 'chassis', 0, deck - 0.02, 0, width - 1.4, 0.06, length - 9.6)

  // Boarding ramps raked up at both ends – the double-ender's signature.
  // Thin free-form slabs (top and underside quad each); the edge-on gap
  // between the two faces is below anything the map resolves.
  const rampW = 7
  for (const dir of [-1, 1]) {
    const z0 = dir * (length / 2 - 4.7)
    const z1 = dir * (length / 2 - 0.4)
    const yLow = deck - 0.02
    const yHigh = deck + 1.5
    const x = rampW / 2
    const top = [
      [-x, yLow, z0],
      [x, yLow, z0],
      [x, yHigh, z1],
      [-x, yHigh, z1],
    ]
    if (dir < 0) top.reverse()
    quad(mesh, 'chassis', top[0], top[1], top[2], top[3])
    const bottom = [...top].reverse().map(([bx, by, bz]) => [bx, by - 0.1, bz])
    quad(mesh, 'chassis', bottom[0], bottom[1], bottom[2], bottom[3])
  }

  // Bulwarks along the open deck, inset from the hull sides
  for (const side of [-1, 1]) {
    roundedBox(mesh, 'body', side * (width / 2 - 0.35), deck + 0.35, 0, 0.25, 0.8, length - 10)
  }

  // Deckhouse on the starboard side with the bridge on top
  const houseX = width / 2 - 1.6
  const houseTop = deck + 2.3
  roundedBox(mesh, 'body', houseX, (deck + houseTop) / 2, 0, 2.4, houseTop - deck, 12)
  // windowBand() centers its panes on the vehicle axis – this house is
  // offset to one side, so its glazing is placed by hand
  for (const side of [-1, 1]) {
    for (const dz of [-1, 0, 1]) {
      box(mesh, 'glass', houseX + side * (2.4 / 2 + 0.015), deck + 1.55, dz * 3.7, 0.03, 1.1, 3.2)
    }
  }
  const bridgeTop = houseTop + 1.5
  roundedBox(mesh, 'body', houseX, (houseTop + bridgeTop) / 2, 0, 2.8, bridgeTop - houseTop, 4.6)
  for (const dz of [-1, 1]) {
    box(mesh, 'glass', houseX, (houseTop + bridgeTop) / 2 + 0.1, dz * (4.6 / 2 + 0.015), 2.2, 0.6, 0.03)
  }
  box(mesh, 'roof', houseX, bridgeTop + 0.03, 0, 2.6, 0.06, 4.2)
  // Mast up to the height cap
  box(mesh, 'chassis', houseX, (bridgeTop + H / 2) / 2 + 0.03, 0, 0.12, H / 2 - bridgeTop - 0.06, 0.12)
  for (const side of [-1, 1]) ferryRail(mesh, side * (width / 2 - 0.38), deck + 0.78, -length / 2 + 5.2, length / 2 - 5.2, 0.6)
  // Lane paint stays on the deck; ramp stiffeners follow the raised ramp.
  for (const x of [-2.4, 0.2]) {
    for (let z = -12; z < 12; z += 3) box(mesh, 'hullWhite', x, deck + 0.018, z, 0.08, 0.006, 1.4)
  }
  for (const dir of [-1, 1]) {
    for (let i = 1; i < 6; i++) {
      const t = i / 6, z = dir * (length / 2 - 4.7 + 4.3 * t)
      rod(mesh, 'steel', [-3.4, deck - 0.02 + 1.52 * t + 0.018, z], [3.4, deck - 0.02 + 1.52 * t + 0.018, z], 0.018, 8)
    }
  }
  ellipsoid(mesh, 'body', [houseX, bridgeTop + 0.15, 1.3], [0.26, 0.12, 0.26], 16, 8)
  return mesh
}

/**
 * Third-rail subway unit, end section (cab at +Z): 13 m articulated
 * section, 2.6 m wide, no pantograph – only small boxes on the roof.
 * Drawn after Hamburg's DT5; Berlin's U-Bahn (BR H) and S-Bahn (BR 481)
 * run it as six sections with 0.3 m gaps (see VEHICLE_CONSISTS). The end
 * sections carry a single bogie under the cab and rest on the middle
 * section at the articulation, which is why there is none at the back.
 * Rounded two-step snout with the glass cap as windscreen; doors in both
 * walls.
 */
export function ubahnEnd() {
  const mesh = createMesh()
  const H = HEIGHTS.subway
  const yBase = -H / 2
  const width = 2.6
  const length = 13.0
  const floor = yBase + 0.95
  const bodyTop = yBase + 3.15
  const nose = 1.7
  carShell(mesh, {
    length,
    width,
    bodyTop,
    floor,
    yBase,
    bevel: 0.2,
    noseFront: { length: nose, sx: 0.62, sy: 0.84, shoulder: { length: 0.65, sx: 0.9, sy: 0.97 } },
  })
  const winTop = bodyTop - 0.3
  const winBottom = floor + 0.4
  const doorZ = [-length / 2 + 3.2, 1.7]
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.45, length / 2 - nose - 0.3, {
    panes: 4,
    holes: doorZ.map((z) => doorHole(z)),
  })
  for (const z of doorZ) doors(mesh, width, floor - 0.42, winTop, z)
  bogie(mesh, yBase, length / 2 - 2.9, width)
  // Roof: two flat equipment boxes, nothing that could pass for a pantograph
  box(mesh, 'roof', 0, bodyTop + 0.14, -3.6, width * 0.55, 0.18, 2.2)
  box(mesh, 'roof', 0, bodyTop + 0.14, 1.6, width * 0.55, 0.18, 1.6)
  return mesh
}

/** DT5 middle section: bellows both ends, two bogies of its own. */
export function ubahnMid() {
  const mesh = createMesh()
  const H = HEIGHTS.subway
  const yBase = -H / 2
  const width = 2.6
  const length = 13.0
  const floor = yBase + 0.95
  const bodyTop = yBase + 3.15
  carShell(mesh, { length, width, bodyTop, floor, yBase, bevel: 0.2 })
  for (const dir of [-1, 1]) {
    box(mesh, 'bellows', 0, (floor - 0.45 + bodyTop) / 2, dir * (length / 2 - 0.06), width * 0.9, bodyTop - floor + 0.3, 0.24)
  }
  const winTop = bodyTop - 0.3
  const winBottom = floor + 0.4
  const doorZ = [-3.0, 3.0]
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.5, length / 2 - 0.5, {
    panes: 4,
    holes: doorZ.map((z) => doorHole(z)),
  })
  for (const z of doorZ) doors(mesh, width, floor - 0.42, winTop, z)
  // Its bogies sit under the articulations that carry the end sections
  bogie(mesh, yBase, -length / 2 + 1.25, width)
  bogie(mesh, yBase, length / 2 - 1.25, width)
  box(mesh, 'roof', 0, bodyTop + 0.14, 0, width * 0.55, 0.18, 2.4)
  for (const dir of [-1, 1]) box(mesh, 'roof', 0, bodyTop + 0.14, dir * 4.2, width * 0.55, 0.18, 1.4)
  return mesh
}

/** Every file the build script writes: name → mesh factory. */
export const FLEET = {
  'tram-end': () => tramEnd(),
  'tram-end-rear': () => tramEnd({ doorSides: MIRRORED }),
  'tram-mid': () => tramMid(),
  'tram-mid-panto': () => tramMid({ withPantograph: true }),
  'sbahn-end': sbahnEnd,
  'sbahn-mid-panto': sbahnMid,
  bus,
  'ferry-fg': ferryGehlsdorf,
  'ferry-fw': ferryBreitling,
  'ubahn-end': ubahnEnd,
  'ubahn-mid': ubahnMid,
}
