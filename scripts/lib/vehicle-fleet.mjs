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
  windowBand,
} from './vehicle-mesh.mjs'

/** Overall heights (rail to roof gear) – the layer's halfHeight. */
export const HEIGHTS = { tram: 3.6, train: 4.3, bus: 3.1 }

/**
 * Shared vertical layout of a car: skirt from the wheels up to the
 * floor, body shell above, roof sheet on top.
 */
function carShell(mesh, { length, width, bodyTop, floor, noseFront, noseBack, bevel = 0.16, yBase }) {
  const half = length / 2
  const skirtTop = yBase + 0.55
  // Skirt: full-length dark under-floor box hiding the gap to the road.
  // Its bottom stops 2 cm short of the wheel plane – the bogies alone
  // touch the rail, and two chassis faces sharing the exact wheel plane
  // were one of the coplanar double-draws the fleet test now rejects.
  const skirtBottom = yBase + 0.02
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

/** Vossloh 6N2 end section (cab at +Z). */
export function tramEnd() {
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
    holes: [doorHole(-0.35)],
  })
  doors(mesh, width, floor - 0.42, winTop, -0.35)
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
    holes: [doorHole(0)],
  })
  doors(mesh, width, floor - 0.42, winTop, 0)
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
  const floor = yBase + 0.75
  const bodyTop = yBase + 2.95
  carShell(mesh, {
    length,
    width,
    bodyTop,
    floor,
    yBase,
    bevel: 0.14,
    noseFront: { length: 0.7, sx: 0.88, sy: 0.97 },
    noseBack: { length: 0.5, sx: 0.92, sy: 0.98 },
  })
  const winTop = bodyTop - 0.22
  const winBottom = floor + 0.5
  windowBand(mesh, width, winBottom, winTop, -length / 2 + 0.7, length / 2 - 1.5, {
    panes: 4,
    holes: [doorHole(length / 2 - 2.6, 1.15), doorHole(-length / 2 + 4.2, 1.15)],
  })
  doors(mesh, width, floor - 0.35, winTop, length / 2 - 2.6, 1.15)
  doors(mesh, width, floor - 0.35, winTop, -length / 2 + 4.2, 1.15)
  // Wheels: two axles as dark wheel boxes
  for (const z of [-length / 2 + 2.0, length / 2 - 2.6]) {
    for (const side of [-1, 1]) {
      box(mesh, 'chassis', side * (width / 2 - 0.2), yBase + 0.34, z, 0.26, 0.68, 0.72)
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

/** Every file the build script writes: name → mesh factory. */
export const FLEET = {
  'tram-end': tramEnd,
  'tram-mid': () => tramMid(),
  'tram-mid-panto': () => tramMid({ withPantograph: true }),
  'sbahn-end': sbahnEnd,
  'sbahn-mid-panto': sbahnMid,
  bus,
}
