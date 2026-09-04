/**
 * The linear view's geometry: every line pulled straight into a row of
 * its own, the way a timetable board draws it, with the stops sitting
 * along it at the distance they really are.
 *
 * The whole layout is a function of one number the app already has for
 * everything it draws – the distance along the route. Route vertices
 * carry it (PreparedDirection.cum), stops carry it (PreparedStop.dist),
 * and the simulation computes it for every vehicle on every tick. So a
 * row is not a second dataset, it is the same data read on a different
 * axis, which is what lets the map morph into the diagram rather than
 * cut to it (see map/LinearView.ts).
 *
 * Every row shares one scale, so a 50 km line is drawn five times the
 * length of a 10 km one. Normalizing each line to the full width would
 * read more tidily and lie about the network: the point of pulling the
 * lines straight is to be able to compare them.
 *
 * Deliberately free of the DOM and of Cesium – this is arithmetic, and
 * it is unit tested as such.
 */

import type { PreparedLine, TransitMode } from '@/data/network-types'
import { TRANSIT_MODES } from '@/lib/transit-mode'

/** One stop on a row. */
export interface LinearStation {
  id: string
  name: string
  /** Distance along the drawn direction in meters. */
  dist: number
  /** Horizontal position in diagram units (= screen pixels). */
  x: number
  /** Whether the name is drawn – dense stretches drop labels, never stops. */
  labelled: boolean
}

/** One line, pulled straight. */
export interface LinearRow {
  lineId: string
  name: string
  color: string
  mode: TransitMode
  /** The direction the row draws (0 – the reverse runs the other way). */
  direction: 0
  from: string
  to: string
  lengthMeters: number
  /** Vertical centre of the row in diagram units. */
  y: number
  /** Where the row starts and ends horizontally. */
  x0: number
  x1: number
  stations: LinearStation[]
}

export interface LinearLayout {
  rows: LinearRow[]
  /** Diagram size in units (= screen pixels); the height may exceed the view. */
  width: number
  height: number
  /** Meters per diagram unit, shared by every row. */
  metersPerUnit: number
}

export interface LinearLayoutOptions {
  /** Width of the view in pixels. */
  width: number
  /** Vertical distance between two rows. */
  rowHeight?: number
  /**
   * Space left of the first row: the line badge sits in it, and the app
   * widens it so the rows clear the control panel rather than running
   * underneath it.
   */
  paddingLeft?: number
  paddingRight?: number
  /** Space above the first row – the labels of row 0 rise into it. */
  paddingTop?: number
  paddingBottom?: number
  /**
   * Minimum horizontal gap between two drawn station names. The names
   * are set at an angle, so what they take from the row is roughly the
   * width of one text line's ascent, not the length of the name: at 60°
   * a gap of g along the row leaves g·sin60° between two of them, so it
   * has to stay a little above the font size.
   */
  minLabelGapPx?: number
}

const DEFAULTS = {
  // A name set at 60° over a hundred pixels long rises about ninety, so
  // the rows stand far enough apart that a label never reaches the line
  // above it.
  rowHeight: 108,
  paddingLeft: 40,
  paddingRight: 32,
  paddingTop: 150,
  // Enough that the last row scrolls clear of the view tabs standing at
  // the foot of the map, rather than ending underneath them.
  paddingBottom: 104,
  minLabelGapPx: 20,
}

/**
 * Which station names survive at these positions, left to right. A name
 * is kept when it clears the last kept one by `minGap`; the first and
 * the last are always kept, because a line's ends are what a reader
 * looks for first. Pure, and the counterpart of the map's own label
 * declutter in map/StopsLayer.ts.
 */
export function keepReadableLabels(xs: readonly number[], minGap: number): boolean[] {
  const kept = xs.map(() => false)
  if (xs.length === 0) return kept
  let lastX = Number.NEGATIVE_INFINITY
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] - lastX < minGap) continue
    kept[i] = true
    lastX = xs[i]
  }
  // The terminus outranks whatever stands in its way
  const last = xs.length - 1
  if (!kept[last]) {
    for (let i = last - 1; i >= 0; i--) {
      if (!kept[i]) continue
      if (xs[last] - xs[i] < minGap) kept[i] = false
      break
    }
    kept[last] = true
  }
  kept[0] = true
  return kept
}

/** The order rows are stacked in: by mode as the panel groups them, then by line. */
export function compareLinesForRows(a: PreparedLine, b: PreparedLine): number {
  const byMode = TRANSIT_MODES.indexOf(a.mode) - TRANSIT_MODES.indexOf(b.mode)
  if (byMode !== 0) return byMode
  return a.id.localeCompare(b.id, 'de', { numeric: true })
}

/**
 * Lays the given lines out as rows. `lines` is what the panel currently
 * shows – the diagram follows the same filter the map does, which is
 * what keeps it readable in a city with forty of them.
 */
export function buildLinearLayout(
  lines: readonly PreparedLine[],
  options: LinearLayoutOptions,
): LinearLayout {
  const o = { ...DEFAULTS, ...options }
  const ordered = [...lines].sort(compareLinesForRows)
  const usable = Math.max(1, o.width - o.paddingLeft - o.paddingRight)
  const longest = ordered.reduce((max, line) => Math.max(max, line.directions[0].totalLength), 0)
  // A network of one short line should not be drawn at street scale
  const metersPerUnit = longest > 0 ? longest / usable : 1

  const rows: LinearRow[] = ordered.map((line, index) => {
    const dir = line.directions[0]
    const y = o.paddingTop + index * o.rowHeight
    const xs = dir.stops.map((stop) => o.paddingLeft + stop.dist / metersPerUnit)
    const labelled = keepReadableLabels(xs, o.minLabelGapPx)
    return {
      lineId: line.id,
      name: line.name,
      color: line.color,
      mode: line.mode,
      direction: 0,
      from: dir.from,
      to: dir.to,
      lengthMeters: dir.totalLength,
      y,
      x0: o.paddingLeft,
      x1: o.paddingLeft + dir.totalLength / metersPerUnit,
      stations: dir.stops.map((stop, i) => ({
        id: stop.id,
        name: stop.name,
        dist: stop.dist,
        x: xs[i],
        labelled: labelled[i],
      })),
    }
  })

  return {
    rows,
    width: o.width,
    height:
      rows.length === 0
        ? o.paddingTop + o.paddingBottom
        : o.paddingTop + (rows.length - 1) * o.rowHeight + o.paddingBottom,
    metersPerUnit,
  }
}

/**
 * Where a vehicle sits on its row. `distance` is what the simulation
 * hands out per tick, so the dot needs no geometry of its own.
 *
 * A vehicle running the reverse direction is drawn on the same row, from
 * the other end: the row is the line, not one of its two timetables.
 */
export function vehicleX(row: LinearRow, distance: number, direction: 0 | 1): number {
  const along = direction === 0 ? distance : row.lengthMeters - distance
  const clamped = Math.min(Math.max(along, 0), row.lengthMeters)
  return row.x0 + clamped / (row.lengthMeters / (row.x1 - row.x0) || 1)
}

/** The row a line is drawn on, or undefined when the line is filtered out. */
export function rowIndexById(layout: LinearLayout): Map<string, number> {
  return new Map(layout.rows.map((row, index) => [row.lineId, index]))
}
