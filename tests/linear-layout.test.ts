import { describe, expect, it } from 'vitest'
import type { PreparedDirection, PreparedLine, TransitMode } from '@/data/network-types'
import {
  buildLinearLayout,
  compareLinesForRows,
  keepReadableLabels,
  rowIndexById,
  vehicleX,
} from '@/lib/linear-layout'

/**
 * The linear view's arithmetic (see src/lib/linear-layout.ts). Nothing
 * here touches the DOM or Cesium: a row is a function of the distances
 * the network already carries, which is exactly what makes it testable
 * on its own.
 */

/** A line of the given length with stops at the given distances. */
function line(
  id: string,
  lengthMeters: number,
  stopDistances: number[],
  mode: TransitMode = 'tram',
): PreparedLine {
  const dir = (direction: 0 | 1): PreparedDirection => ({
    lineId: id,
    direction,
    from: 'A',
    to: 'B',
    path: [
      [12.1, 54.0],
      [12.1, 54.1],
    ],
    cum: [0, lengthMeters],
    totalLength: lengthMeters,
    stops: stopDistances.map((dist, i) => ({
      id: `${id}-${i}`,
      name: `Stop ${i}`,
      coord: [12.1, 54.0] as [number, number],
      dist: direction === 0 ? dist : lengthMeters - dist,
    })),
    tunnels: [],
  })
  return {
    id,
    name: `Line ${id}`,
    color: '#ff0000',
    mode,
    vehicle: { length: 30, width: 2.6, height: 3.5 },
    directions: [dir(0), dir(1)],
  }
}

describe('keepReadableLabels', () => {
  it('drops names that would collide and keeps the ones that clear the gap', () => {
    expect(keepReadableLabels([0, 5, 40, 44, 80], 20)).toEqual([true, false, true, false, true])
  })

  it('always keeps both ends, even when the last one is crowded', () => {
    // 100 sits 4 units behind 96, so 96 gives way rather than the terminus
    const kept = keepReadableLabels([0, 50, 96, 100], 20)
    expect(kept[0]).toBe(true)
    expect(kept[kept.length - 1]).toBe(true)
    expect(kept[2]).toBe(false)
  })

  it('keeps a lone stop and survives an empty row', () => {
    expect(keepReadableLabels([42], 20)).toEqual([true])
    expect(keepReadableLabels([], 20)).toEqual([])
  })
})

describe('compareLinesForRows', () => {
  it('groups by mode the way the panel does, then sorts lines naturally', () => {
    const lines = [
      line('10', 1000, [0], 'bus'),
      line('S1', 1000, [0], 'train'),
      line('2', 1000, [0], 'tram'),
      line('9', 1000, [0], 'bus'),
    ]
    expect([...lines].sort(compareLinesForRows).map((l) => l.id)).toEqual(['2', 'S1', '9', '10'])
  })
})

describe('buildLinearLayout', () => {
  it('draws every row at one shared scale, so lengths stay comparable', () => {
    const layout = buildLinearLayout([line('A', 10_000, [0, 10_000]), line('B', 5000, [0, 5000])], {
      width: 1040,
    })
    const [a, b] = layout.rows
    // 10 km fills the usable width (1040 - 40 - 32 = 968), 5 km half of it
    expect(a.x1 - a.x0).toBeCloseTo(968, 5)
    expect(b.x1 - b.x0).toBeCloseTo(484, 5)
    expect(layout.metersPerUnit).toBeCloseTo(10_000 / 968, 6)
  })

  it('stacks the rows and grows the diagram past the window', () => {
    const lines = Array.from({ length: 20 }, (_, i) => line(`L${i}`, 5000, [0, 5000]))
    const layout = buildLinearLayout(lines, { width: 1040 })
    expect(layout.rows[1].y - layout.rows[0].y).toBe(108)
    expect(layout.height).toBeGreaterThan(2000)
  })

  it('puts a stop where its distance says, not where its index says', () => {
    const layout = buildLinearLayout([line('A', 1000, [0, 100, 1000])], { width: 1040 })
    const [start, near, end] = layout.rows[0].stations
    expect(start.x).toBeCloseTo(40, 5)
    expect(end.x).toBeCloseTo(1008, 5)
    // A tenth of the way along the line, not a third of the way along the row
    expect(near.x).toBeCloseTo(40 + 96.8, 5)
  })

  it('drops crowded names but never the stops themselves', () => {
    // 120 stops over 968 usable units sit ~8 apart, below the 20 a name needs
    const distances = Array.from({ length: 120 }, (_, i) => i * 20)
    const layout = buildLinearLayout([line('A', 2380, distances)], { width: 1040 })
    const stations = layout.rows[0].stations
    expect(stations).toHaveLength(120)
    expect(stations.filter((s) => s.labelled).length).toBeLessThan(80)
    expect(stations[0].labelled).toBe(true)
    expect(stations[119].labelled).toBe(true)
  })

  it('handles an empty network and a network of zero length', () => {
    const empty = buildLinearLayout([], { width: 1040 })
    expect(empty.rows).toEqual([])
    expect(empty.height).toBe(254)
    const degenerate = buildLinearLayout([line('A', 0, [0])], { width: 1040 })
    expect(degenerate.rows[0].x1).toBe(degenerate.rows[0].x0)
  })

  it('lays out for the width it is given', () => {
    const narrow = buildLinearLayout([line('A', 10_000, [0, 10_000])], { width: 500 })
    expect(narrow.rows[0].x1).toBeCloseTo(468, 5)
    expect(narrow.width).toBe(500)
  })
})

describe('vehicleX', () => {
  const row = buildLinearLayout([line('A', 10_000, [0, 10_000])], { width: 1040 }).rows[0]

  it('places a vehicle at its distance along the row', () => {
    expect(vehicleX(row, 0, 0)).toBeCloseTo(row.x0, 5)
    expect(vehicleX(row, 10_000, 0)).toBeCloseTo(row.x1, 5)
    expect(vehicleX(row, 2500, 0)).toBeCloseTo(row.x0 + (row.x1 - row.x0) * 0.25, 5)
  })

  it('runs the reverse direction along the same row, from the other end', () => {
    expect(vehicleX(row, 0, 1)).toBeCloseTo(row.x1, 5)
    expect(vehicleX(row, 10_000, 1)).toBeCloseTo(row.x0, 5)
  })

  it('keeps a vehicle past the end on the row', () => {
    expect(vehicleX(row, 12_000, 0)).toBeCloseTo(row.x1, 5)
    expect(vehicleX(row, -50, 0)).toBeCloseTo(row.x0, 5)
  })
})

describe('rowIndexById', () => {
  it('reports the row a line is drawn on', () => {
    const layout = buildLinearLayout([line('B', 1000, [0]), line('A', 1000, [0])], { width: 1040 })
    expect(rowIndexById(layout).get('A')).toBe(0)
    expect(rowIndexById(layout).get('B')).toBe(1)
    expect(rowIndexById(layout).get('C')).toBeUndefined()
  })
})
