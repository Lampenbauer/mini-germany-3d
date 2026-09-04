import { beforeEach, describe, expect, it } from 'vitest'
import type { PreparedDirection, PreparedLine } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'
import { vehicleX } from '@/lib/linear-layout'
import { LinearView, MORPH_SAMPLES, type LinearSeed } from '@/map/LinearView'

/**
 * The morph's own frame loop drives the whole diagram, and this is what
 * says so. The vehicles used to be placed by sync() alone – which runs at
 * the simulation's tick rate, not the morph's – so while the lines were
 * pulled straight at frame rate the dots on them moved a couple of times
 * and hung visibly off their lines for the length of the transition.
 *
 * Every assertion below therefore moves the morph WITHOUT syncing in
 * between: what the view draws between two ticks has to be right too.
 */

const LENGTH = 10_000

function testLine(): PreparedLine {
  const dir = (direction: 0 | 1): PreparedDirection => ({
    lineId: 'T',
    direction,
    from: 'A',
    to: 'B',
    path: [
      [12.1, 54.0],
      [12.1, 54.1],
    ],
    cum: [0, LENGTH],
    totalLength: LENGTH,
    stops: [
      { id: 'a', name: 'A', coord: [12.1, 54.0], dist: 0 },
      { id: 'b', name: 'B', coord: [12.1, 54.1], dist: LENGTH },
    ],
    tunnels: [],
  })
  return {
    id: 'T',
    name: 'Test',
    color: '#ff0000',
    mode: 'tram',
    vehicle: { length: 30, width: 2.6, height: 3.5 },
    directions: [dir(0), dir(1)],
  }
}

function snapshot(overrides: Partial<VehicleSnapshot> = {}): VehicleSnapshot {
  return {
    id: 'trip-1',
    lineId: 'T',
    lineName: 'Test',
    color: '#ff0000',
    mode: 'tram',
    vehicle: { length: 30, width: 2.6, height: 3.5 },
    direction: 0,
    distance: LENGTH / 2,
    lon: 12.1,
    lat: 54.05,
    bearing: 0,
    status: 'moving',
    inTunnel: false,
    nextStopName: 'B',
    destination: 'B',
    origin: 'A',
    delaySeconds: 0,
    realtime: false,
    ...overrides,
  }
}

/** A seed that puts the whole line, and the vehicle, at a known place. */
function seedAt(x: number, y: number): LinearSeed {
  return {
    paths: new Map([['T', Array.from({ length: MORPH_SAMPLES }, () => ({ x, y }))]]),
    vehicles: new Map([['trip-1', { x, y }]]),
  }
}

describe('LinearView vehicles during the morph', () => {
  let container: HTMLDivElement
  let view: LinearView

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    view = new LinearView(container, { onSelectVehicle: () => {}, onSelectStop: () => {} })
    view.setLines([testLine()], { width: 1000 })
  })

  const dot = () => container.querySelector('circle[data-vehicle="trip-1"]')!
  const at = () => ({ x: Number(dot().getAttribute('cx')), y: Number(dot().getAttribute('cy')) })

  it('moves the dot on every morph step, with no sync in between', () => {
    view.setSeed(seedAt(600, 500))
    view.sync([snapshot()])

    view.setMorph(0)
    expect(at()).toEqual({ x: 600, y: 500 })

    // The regression: these two used to leave the dot at the seed while
    // the lines straightened around it.
    view.setMorph(0.5)
    const half = at()
    expect(half.x).not.toBe(600)
    expect(half.y).not.toBe(500)

    view.setMorph(1)
    const end = at()
    expect(half.x).toBeCloseTo((600 + end.x) / 2, 6)
    expect(half.y).toBeCloseTo((500 + end.y) / 2, 6)
  })

  it('lands the dot exactly where its row puts it', () => {
    view.setSeed(seedAt(600, 500))
    view.sync([snapshot()])
    view.setMorph(1)

    const row = { x0: 40, x1: 968, y: 150, lengthMeters: LENGTH } as never
    expect(at().x).toBeCloseTo(vehicleX(row, LENGTH / 2, 0), 6)
  })

  it('starts a vehicle the seed never saw on its own line, not beside it', () => {
    // Seeded before the trip existed: the line is in the seed, the dot is not
    const seed = seedAt(700, 400)
    seed.vehicles.delete('trip-1')
    view.setSeed(seed)
    view.sync([snapshot()])

    view.setMorph(0)
    // Its line is a single point in this seed, so that is where it rides from
    expect(at()).toEqual({ x: 700, y: 400 })
  })

  it('keeps following the morph after the simulation moves it on', () => {
    view.setSeed(seedAt(600, 500))
    view.sync([snapshot({ distance: 0 })])
    view.setMorph(0.5)
    const before = at()

    // A tick arrives mid-morph: the target moves, the origin does not
    view.sync([snapshot({ distance: LENGTH })])
    const after = at()
    expect(after.x).toBeGreaterThan(before.x)

    // ... and the morph keeps driving it from there
    view.setMorph(1)
    const row = { x0: 40, x1: 968, y: 150, lengthMeters: LENGTH } as never
    expect(at().x).toBeCloseTo(vehicleX(row, LENGTH, 0), 6)
  })
})
