/**
 * The linear view: the network with every line pulled straight, drawn in
 * SVG over the map.
 *
 * The switch between the two is a morph rather than a cut, and that is
 * the whole reason this draws in screen space. Each row is sampled at
 * the same number of equal steps along the route in both readings: the
 * geographic one is where those points sit on screen right now (the map
 * projects them, see CesiumMap.projectToScreen), the linear one is a
 * straight row. Point i means the same distance along the line in both,
 * so pulling the line straight is a lerp between two known positions –
 * the same trick the app already uses for a vehicle's height and its
 * tunnel state, read on another axis (see lib/linear-layout.ts).
 *
 * Doing the morph here rather than inside Cesium is deliberate: a
 * polyline whose positions change is rebuilt by Cesium asynchronously
 * (which is why the route pulse animates colours and not geometry), and
 * a network is tens of thousands of vertices. Screen space costs one
 * projection at the moment the switch is pressed, and nothing after.
 *
 * The lines themselves are drawn at full strength from the first frame
 * of the morph to the last. Only the ground behind them fades: the city
 * out, this view's own background in. That is what makes both ends of
 * the transition seamless – at rest the drawn line lies exactly on the
 * map's route, so the map can take its own network off the moment the
 * morph starts (and put it back the moment it ends) with nothing to see.
 * A line that faded in as it moved would be a smear instead.
 *
 * Imperative like the map layers, and for the same reason: the vehicles
 * move at the render loop's rate, and React has no business in that path.
 */

import type { PreparedLine } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'
import { heightAtDistance, sampleAtDistance } from '@/lib/geo'
import {
  buildLinearLayout,
  vehicleX,
  type LinearLayout,
  type LinearLayoutOptions,
  type LinearRow,
} from '@/lib/linear-layout'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * How many points a row is sampled at for the morph. Enough that a
 * curved line reads as itself while it straightens; few enough that
 * every row can be rebuilt per frame while it does.
 */
export const MORPH_SAMPLES = 96

/** Angle the station names are set at, degrees counter-clockwise. */
const LABEL_ANGLE = -60

/** The space the rows are laid out in – App.tsx measures it. */
export type LinearBox = Pick<LinearLayoutOptions, 'width' | 'paddingLeft'>

export interface ScreenPoint {
  x: number
  y: number
}

/**
 * Where the map currently draws what the diagram is about to draw: the
 * starting pose of the morph. Missing entries (behind the camera, off
 * screen) simply start where they end.
 */
export interface LinearSeed {
  /** Line id → MORPH_SAMPLES points along its first direction. */
  paths: Map<string, (ScreenPoint | null)[]>
  /** Vehicle trip id → where its model stands. */
  vehicles: Map<string, ScreenPoint | null>
}

/**
 * Reads off the map where the diagram's own points currently are: every
 * row sampled at the same equal distance steps the straight row uses,
 * and every vehicle where its model stands. One projection call for the
 * whole network – see CesiumMap.projectToScreen.
 */
export function buildLinearSeed(
  project: (points: readonly { lon: number; lat: number; nhn?: number }[]) => (ScreenPoint | null)[],
  lines: readonly PreparedLine[],
  snapshots: readonly VehicleSnapshot[],
): LinearSeed {
  const points: { lon: number; lat: number; nhn?: number }[] = []
  for (const line of lines) {
    const dir = line.directions[0]
    for (let i = 0; i < MORPH_SAMPLES; i++) {
      const distance = (dir.totalLength * i) / (MORPH_SAMPLES - 1)
      const at = sampleAtDistance(dir.path, dir.cum, distance)
      points.push({
        lon: at.lon,
        lat: at.lat,
        nhn: dir.heights ? heightAtDistance(dir.heights, dir.cum, distance) : undefined,
      })
    }
  }
  for (const snap of snapshots) {
    points.push({ lon: snap.lon, lat: snap.lat, nhn: snap.nhn })
  }

  const screen = project(points)
  const paths = new Map<string, (ScreenPoint | null)[]>()
  lines.forEach((line, index) => {
    const start = index * MORPH_SAMPLES
    paths.set(line.id, screen.slice(start, start + MORPH_SAMPLES))
  })
  const vehicles = new Map<string, ScreenPoint | null>()
  const vehicleOffset = lines.length * MORPH_SAMPLES
  snapshots.forEach((snap, index) => {
    vehicles.set(snap.id, screen[vehicleOffset + index])
  })
  return { paths, vehicles }
}

export interface LinearViewHost {
  onSelectVehicle(id: string): void
  onSelectStop(id: string): void
}

interface RowElements {
  row: LinearRow
  path: SVGPathElement
  badge: SVGTextElement
  stations: SVGGElement
}

interface VehicleElements {
  dot: SVGCircleElement
  /** Where the dot started the morph, in screen units. */
  from: ScreenPoint | null
  /** Where its row puts it, as of the last sync. */
  target: ScreenPoint
}

/** Straight-row position of sample i, 0 … MORPH_SAMPLES-1. */
function rowSample(row: LinearRow, i: number): ScreenPoint {
  const t = i / (MORPH_SAMPLES - 1)
  return { x: row.x0 + (row.x1 - row.x0) * t, y: row.y }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export class LinearView {
  private readonly root: HTMLDivElement
  private readonly backdrop: HTMLDivElement
  private readonly scroller: HTMLDivElement
  private readonly svg: SVGSVGElement
  private readonly linesGroup: SVGGElement
  private readonly detailGroup: SVGGElement
  private readonly vehicleGroup: SVGGElement
  private readonly host: LinearViewHost

  private layout: LinearLayout = { rows: [], width: 0, height: 0, metersPerUnit: 1 }
  private box: LinearBox = { width: 0 }
  private rowElements = new Map<string, RowElements>()
  private vehicles = new Map<string, VehicleElements>()
  private lines: readonly PreparedLine[] = []
  private seed: LinearSeed | null = null
  /** 0 = the map's geometry, 1 = the straight rows. */
  private morph = 0
  private selectedId: string | null = null
  private destroyed = false

  constructor(container: HTMLElement, host: LinearViewHost) {
    this.host = host
    this.root = document.createElement('div')
    this.root.dataset.testid = 'linear-view'
    // Above the map, below the interface. Out of the way entirely when
    // there is no transition to show – see setActive.
    this.root.className = 'absolute inset-0 z-[5]'
    this.root.style.display = 'none'
    // The ground the diagram stands on. It is the only thing here that
    // fades, and it fades against the city fading out underneath it.
    this.backdrop = document.createElement('div')
    this.backdrop.className = 'absolute inset-0 bg-background'
    this.backdrop.style.opacity = '0'
    // Scrolls: forty lines are taller than any window, and the diagram is
    // not worth shrinking to fit. Separate from the backdrop, which stays
    // over the viewport rather than travelling with the rows.
    this.scroller = document.createElement('div')
    this.scroller.className = 'absolute inset-0 overflow-y-auto overflow-x-hidden pointer-events-none'
    this.svg = document.createElementNS(SVG_NS, 'svg')
    this.svg.setAttribute('width', '100%')
    this.svg.style.display = 'block'
    this.linesGroup = document.createElementNS(SVG_NS, 'g')
    this.detailGroup = document.createElementNS(SVG_NS, 'g')
    // The stops and their names fade in once the lines have arrived –
    // fifteen hundred labels flying across the screen is noise, and
    // moving them all per frame is the one thing here that would cost.
    this.detailGroup.setAttribute('opacity', '0')
    this.detailGroup.style.transition = 'opacity 220ms ease-out'
    this.vehicleGroup = document.createElementNS(SVG_NS, 'g')
    this.svg.append(this.linesGroup, this.detailGroup, this.vehicleGroup)
    this.scroller.append(this.svg)
    this.root.append(this.backdrop, this.scroller)
    container.append(this.root)
    this.svg.addEventListener('click', this.onClick)
  }

  /**
   * Whether the diagram is on screen at all. It stays on for the whole
   * transition in either direction – what changes during it is the
   * backdrop (see setMorph), not this.
   */
  setActive(active: boolean): void {
    this.root.style.display = active ? 'block' : 'none'
    this.scroller.style.pointerEvents = active ? 'auto' : 'none'
    if (!active) this.scroller.scrollTop = 0
  }

  /** The lines to draw, in the panel's own filtered set. */
  setLines(lines: readonly PreparedLine[], box: LinearBox): void {
    this.lines = lines
    this.box = box
    this.layout = buildLinearLayout(lines, box)
    this.svg.setAttribute('height', String(this.layout.height))
    this.svg.setAttribute('viewBox', `0 0 ${this.layout.width} ${this.layout.height}`)
    this.buildRows()
    this.applyMorph()
  }

  /** Re-lays the rows for a new box (a resize, or the panel folding away). */
  resize(box: LinearBox): void {
    if (box.width === this.box.width && box.paddingLeft === this.box.paddingLeft) return
    this.setLines(this.lines, box)
  }

  /**
   * Where the morph starts from. Redraws at once: the seed is half of
   * what every line's position is made of, and a frame drawn between
   * setting it and the next setMorph would show the rows straight before
   * they have been pulled.
   */
  setSeed(seed: LinearSeed | null): void {
    this.seed = seed
    for (const [id, vehicle] of this.vehicles) {
      vehicle.from = seed?.vehicles.get(id) ?? null
    }
    this.applyMorph()
  }

  /**
   * Where a dot leaves from. Normally the map's own model position, read
   * off the seed. A vehicle the seed does not have – one that started its
   * trip after the switch was pressed, or stood behind the camera when it
   * was – rides its line instead: the same distance along the same seeded
   * path the line itself is being pulled straight from, so it travels
   * with its line rather than appearing beside it.
   */
  private morphOrigin(snap: VehicleSnapshot, row: LinearRow): ScreenPoint | null {
    const seeded = this.seed?.vehicles.get(snap.id)
    if (seeded) return seeded
    const path = this.seed?.paths.get(snap.lineId)
    if (!path || row.lengthMeters <= 0) return null
    const along = snap.direction === 0 ? snap.distance : row.lengthMeters - snap.distance
    const fraction = Math.min(Math.max(along / row.lengthMeters, 0), 1)
    return path[Math.round(fraction * (MORPH_SAMPLES - 1))] ?? null
  }

  /** Puts one dot between where it left and where its row wants it. */
  private placeVehicle(vehicle: VehicleElements): void {
    const from = vehicle.from ?? vehicle.target
    vehicle.dot.setAttribute('cx', String(lerp(from.x, vehicle.target.x, this.morph)))
    vehicle.dot.setAttribute('cy', String(lerp(from.y, vehicle.target.y, this.morph)))
  }

  /**
   * Drives the transition. 0 leaves everything where the map has it, 1
   * is the finished diagram; the app eases between them and fades the
   * globe out underneath (see App.tsx).
   */
  setMorph(t: number): void {
    this.morph = Math.min(1, Math.max(0, t))
    // Only the ground moves between the two readings; the lines drawn on
    // it are at full strength throughout (see the note at the top).
    this.backdrop.style.opacity = String(this.morph)
    this.detailGroup.setAttribute('opacity', this.morph >= 1 ? '1' : '0')
    this.applyMorph()
  }

  /** Per-tick vehicle update, same snapshots the map gets. */
  sync(snapshots: readonly VehicleSnapshot[]): void {
    if (this.destroyed) return
    const alive = new Set<string>()
    const rows = this.rowElements
    for (const snap of snapshots) {
      const row = rows.get(snap.lineId)?.row
      if (!row) continue
      alive.add(snap.id)
      let vehicle = this.vehicles.get(snap.id)
      if (!vehicle) {
        // The line's colour ringed in white – a stop is the other way
        // round, so the two never read as the same mark on the row.
        const dot = document.createElementNS(SVG_NS, 'circle')
        dot.setAttribute('r', '6')
        dot.setAttribute('fill', snap.color)
        dot.setAttribute('stroke', 'oklch(0.9842 0.0034 247.86)')
        dot.setAttribute('stroke-width', '2')
        dot.dataset.vehicle = snap.id
        dot.style.cursor = 'pointer'
        this.vehicleGroup.append(dot)
        vehicle = {
          dot,
          from: this.morphOrigin(snap, row),
          target: { x: vehicleX(row, snap.distance, snap.direction), y: row.y },
        }
        this.vehicles.set(snap.id, vehicle)
      }
      vehicle.target = { x: vehicleX(row, snap.distance, snap.direction), y: row.y }
      // Where it goes is this tick's business; where it is right now is the
      // morph's, and that runs at frame rate (see placeVehicle).
      this.placeVehicle(vehicle)
      vehicle.dot.setAttribute('r', snap.id === this.selectedId ? '9' : '6')
      vehicle.dot.setAttribute('opacity', snap.inTunnel ? '0.45' : '1')
    }
    for (const [id, vehicle] of this.vehicles) {
      if (alive.has(id)) continue
      vehicle.dot.remove()
      this.vehicles.delete(id)
    }
  }

  setSelected(id: string | null): void {
    this.selectedId = id
    for (const [vehicleId, vehicle] of this.vehicles) {
      vehicle.dot.setAttribute('r', vehicleId === id ? '9' : '6')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.svg.removeEventListener('click', this.onClick)
    this.root.remove()
  }

  /** A dot or a stop was hit – the cards are the app's, not this view's. */
  private readonly onClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null
    const vehicleId = target?.dataset?.vehicle
    if (vehicleId) {
      this.host.onSelectVehicle(vehicleId)
      return
    }
    const stopId = target?.dataset?.stop
    if (stopId) this.host.onSelectStop(stopId)
  }

  /** Builds one group per row: the line, its badge, its stops and names. */
  private buildRows(): void {
    this.linesGroup.replaceChildren()
    this.detailGroup.replaceChildren()
    this.rowElements.clear()

    for (const row of this.layout.rows) {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', row.color)
      path.setAttribute('stroke-width', '6')
      path.setAttribute('stroke-linecap', 'round')
      path.setAttribute('stroke-linejoin', 'round')
      this.linesGroup.append(path)

      const badge = document.createElementNS(SVG_NS, 'text')
      badge.textContent = row.lineId
      badge.setAttribute('x', String(row.x0 - 12))
      badge.setAttribute('y', String(row.y + 5))
      badge.setAttribute('text-anchor', 'end')
      badge.setAttribute('fill', row.color)
      badge.setAttribute('font-size', '14')
      badge.setAttribute('font-weight', '700')
      this.detailGroup.append(badge)

      const stations = document.createElementNS(SVG_NS, 'g')
      for (const station of row.stations) {
        const tick = document.createElementNS(SVG_NS, 'circle')
        tick.setAttribute('cx', String(station.x))
        tick.setAttribute('cy', String(row.y))
        tick.setAttribute('r', '3.5')
        tick.setAttribute('fill', 'oklch(0.9842 0.0034 247.86)')
        tick.setAttribute('stroke', 'oklch(0.3717 0.0392 257.29)')
        tick.setAttribute('stroke-width', '1.5')
        tick.dataset.stop = station.id
        tick.style.cursor = 'pointer'
        stations.append(tick)
        if (!station.labelled) continue
        const label = document.createElementNS(SVG_NS, 'text')
        label.textContent = station.name
        label.setAttribute('transform', `translate(${station.x} ${row.y - 12}) rotate(${LABEL_ANGLE})`)
        label.setAttribute('fill', 'oklch(0.869 0.0198 252.89)')
        label.setAttribute('font-size', '11')
        label.dataset.stop = station.id
        label.style.cursor = 'pointer'
        stations.append(label)
      }
      this.detailGroup.append(stations)
      this.rowElements.set(row.lineId, { row, path, badge, stations })
    }
  }

  /**
   * Puts everything drawn between where the map has it and where the row
   * is – the lines and the vehicles on them. Both have to be here: this
   * runs at the morph's own frame rate, while sync() runs at the
   * simulation's, and a dot placed at the slower one visibly falls off
   * the line it is supposed to be riding.
   */
  private applyMorph(): void {
    const t = this.morph
    for (const [lineId, elements] of this.rowElements) {
      const seedPath = this.seed?.paths.get(lineId)
      const points: string[] = []
      for (let i = 0; i < MORPH_SAMPLES; i++) {
        const straight = rowSample(elements.row, i)
        const from = seedPath?.[i] ?? straight
        const x = lerp(from.x, straight.x, t).toFixed(1)
        const y = lerp(from.y, straight.y, t).toFixed(1)
        points.push(`${x} ${y}`)
      }
      elements.path.setAttribute('d', `M ${points.join(' L ')}`)
    }
    for (const vehicle of this.vehicles.values()) this.placeVehicle(vehicle)
  }
}
