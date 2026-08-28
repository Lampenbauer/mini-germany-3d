/**
 * The Rostock fleet as low-poly meshes, dimensioned after the real
 * vehicles (see src/config.ts):
 *
 *   tram   Vossloh 6N2 – 32 m five-section articulated tram
 *   train  Talent 2 (BR 442) – 56.8 m three-car unit, Jakobs-articulated
 *   bus    12 m rigid city bus
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
  wheel,
  windowBand,
} from './vehicle-mesh.mjs'

/** Overall heights (rail to roof gear) – the layer's halfHeight. */
export const HEIGHTS = { tram: 3.6, train: 4.3, bus: 3.1 }

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
 */
function carShell(mesh, { length, width, bodyTop, floor, noseFront, noseBack, bevel = 0.16, yBase, clearance = 0.02 }) {
  const half = length / 2
  const skirtTop = yBase + 0.55
  // Skirt: full-length dark under-floor box hiding the gap to the road.
  // For rail vehicles it reaches within 2 cm of the wheel plane (the
  // bogies alone touch the rail – and two chassis faces sharing the
  // exact wheel plane were one of the coplanar double-draws the fleet
  // test now rejects). A road vehicle passes a real `clearance` instead:
  // a bus with its skirt at the asphalt reads as a tram, daylight under
  // the floor and visible wheels are what make it read as a bus.
  const skirtBottom = yBase + clearance
  const skirtHeight = skirtTop + 0.36 - skirtBottom
  box(mesh, 'chassis', 0, skirtBottom + skirtHeight / 2, 0, width - 0.24, skirtHeight, length - 0.1)

  const profile = bodyProfile(width, floor - 0.45, bodyTop, bevel)
  const stations = []
  if (noseBack) {
    stations.push({ z: -half + 0.0, sx: noseBack.sx, sy: noseBack.sy })
    stations.push({ z: -half + noseBack.length })
  } else {
    stations.push({ z: -half })
  }
  if (noseFront) {
    stations.push({ z: half - noseFront.length })
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

/** 12 m rigid city bus. */
export function bus() {
  const mesh = createMesh()
  const H = HEIGHTS.bus
  const yBase = -H / 2
  const width = 2.55
  const length = 12
  // The cabin sits higher than the rail vehicles' and the skirt stops
  // well short of the road: ~32 cm of daylight under the floor, wheels
  // filling it at the axles, is the difference between a bus and a tram
  // that lost its rails.
  const floor = yBase + 0.9
  const bodyTop = yBase + 2.95
  carShell(mesh, {
    length,
    width,
    bodyTop,
    floor,
    yBase,
    bevel: 0.14,
    clearance: 0.32,
    noseFront: { length: 0.7, sx: 0.88, sy: 0.97 },
    noseBack: { length: 0.5, sx: 0.92, sy: 0.98 },
  })
  const winTop = bodyTop - 0.22
  const winBottom = floor + 0.5
  // Citaro-style door layout: front door in the front overhang by the
  // driver, middle door behind the front axle. The old front door stood
  // exactly OVER the axle – invisible while the wheels were hidden
  // boxes, absurd once they showed.
  const frontDoorZ = length / 2 - 1.65
  const midDoorZ = -length / 2 + 4.2
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.7, length / 2 - 1.5, {
    panes: 4,
    holes: [doorHole(frontDoorZ, 1.15, RIGHT), doorHole(midDoorZ, 1.15, RIGHT)],
  })
  doors(mesh, width, floor - 0.35, winTop, frontDoorZ, 1.15, RIGHT)
  doors(mesh, width, floor - 0.35, winTop, midDoorZ, 1.15, RIGHT)
  // Two axles of visible wheels, tucked into the clearance under the
  // skirt like into wheel arches. Front axle behind the front door,
  // rear axle clear of the middle door – a plausible 12 m wheelbase.
  for (const z of [length / 2 - 2.8, -length / 2 + 2.9]) {
    for (const side of [-1, 1]) {
      wheel(mesh, side * (width / 2 - 0.235), yBase + 0.5, z, 0.5, 0.3, side)
    }
  }
  // Roof AC pod – flat enough to stay inside the configured 3.1 m, its
  // base sunk 1 cm into the roof sheet so the two never share a plane
  box(mesh, 'roof', 0, bodyTop + 0.075, -0.8, width * 0.68, 0.13, 3.4)
  // Rear engine tower hint: dark grille panel across the tail
  quad(
    mesh,
    'chassis',
    [width * 0.35, floor - 0.2, -length / 2 - 0.011],
    [width * 0.35, bodyTop - 0.75, -length / 2 - 0.011],
    [-width * 0.35, bodyTop - 0.75, -length / 2 - 0.011],
    [-width * 0.35, floor - 0.2, -length / 2 - 0.011],
  )
  return mesh
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
  const hull = bodyProfile(width, yBase, hullTop, 0.14)
  extrude(
    mesh,
    hull,
    [
      { z: -length / 2, sx: 0.3, sy: 0.85 },
      { z: -length / 2 + 2.6 },
      { z: length / 2 - 2.6 },
      { z: length / 2, sx: 0.3, sy: 0.85 },
    ],
    { material: 'chassis', yAnchor: yBase },
  )

  // Cabin: white, glazed on all four sides
  const cabinW = 5.0
  const cabinL = 12
  const cabinTop = hullTop + 1.6
  box(mesh, 'body', 0, (hullTop + cabinTop) / 2, 0, cabinW, cabinTop - hullTop, cabinL)
  windowBand(mesh, cabinW, hullTop + 0.4, cabinTop - 0.25, -cabinL / 2 + 0.4, cabinL / 2 - 0.4, {
    panes: 4,
  })
  for (const dir of [-1, 1]) {
    box(mesh, 'glass', 0, (hullTop + cabinTop) / 2 + 0.12, dir * (cabinL / 2 + 0.015), 3.4, 1.0, 0.03)
  }

  // Wheelhouse amidships, glazed all round, roof flush with the height cap
  const whTop = H / 2
  box(mesh, 'body', 0, (cabinTop + whTop) / 2, 0, 2.6, whTop - cabinTop, 2.8)
  for (const side of [-1, 1]) {
    box(mesh, 'glass', side * (2.6 / 2 + 0.015), (cabinTop + whTop) / 2 + 0.05, 0, 0.03, 0.42, 2.2)
    box(mesh, 'glass', 0, (cabinTop + whTop) / 2 + 0.05, side * (2.8 / 2 + 0.015), 2.0, 0.42, 0.03)
  }

  // Cabin roof fore and aft of the wheelhouse (clear of its footprint,
  // so no two down-facing faces share the cabin-top plane)
  for (const dir of [-1, 1]) {
    box(mesh, 'roof', 0, cabinTop + 0.03, dir * (cabinL / 2 / 2 + 0.85), cabinW * 0.9, 0.06, cabinL / 2 - 1.75)
  }
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
  const hull = bodyProfile(width, yBase, deck, 0.2)
  extrude(
    mesh,
    hull,
    [
      { z: -length / 2, sx: 0.5, sy: 0.9 },
      { z: -length / 2 + 4 },
      { z: length / 2 - 4 },
      { z: length / 2, sx: 0.5, sy: 0.9 },
    ],
    { material: 'body', yAnchor: yBase },
  )
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
    box(mesh, 'body', side * (width / 2 - 0.35), deck + 0.35, 0, 0.25, 0.8, length - 10)
  }

  // Deckhouse on the starboard side with the bridge on top
  const houseX = width / 2 - 1.6
  const houseTop = deck + 2.3
  box(mesh, 'body', houseX, (deck + houseTop) / 2, 0, 2.4, houseTop - deck, 12)
  // windowBand() centers its panes on the vehicle axis – this house is
  // offset to one side, so its glazing is placed by hand
  for (const side of [-1, 1]) {
    for (const dz of [-1, 0, 1]) {
      box(mesh, 'glass', houseX + side * (2.4 / 2 + 0.015), deck + 1.55, dz * 3.7, 0.03, 1.1, 3.2)
    }
  }
  const bridgeTop = houseTop + 1.5
  box(mesh, 'body', houseX, (houseTop + bridgeTop) / 2, 0, 2.8, bridgeTop - houseTop, 4.6)
  for (const dz of [-1, 1]) {
    box(mesh, 'glass', houseX, (houseTop + bridgeTop) / 2 + 0.1, dz * (4.6 / 2 + 0.015), 2.2, 0.6, 0.03)
  }
  box(mesh, 'roof', houseX, bridgeTop + 0.03, 0, 2.6, 0.06, 4.2)
  // Mast up to the height cap
  box(mesh, 'chassis', houseX, (bridgeTop + H / 2) / 2 + 0.03, 0, 0.12, H / 2 - bridgeTop - 0.06, 0.12)
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
}
