/**
 * The stops layer: one disc plus one name plate per stop position, their
 * line-driven visibility, the screen-space label declutter, and the
 * camera-dependent height refinement on the photo tiles.
 *
 * Split out of CesiumMap: this owns a closed set of state (the billboard
 * collection, one record per stop, the declutter bookkeeping) and reaches
 * back into the map only through the narrow StopsLayerHost below.
 */

import {
  type Billboard,
  Color,
  BillboardCollection,
  BlendOption,
  Cartesian2,
  Cartesian3,
  DistanceDisplayCondition,
  HorizontalOrigin,
  Matrix4,
  SceneTransforms,
  VerticalOrigin,
  type Viewer,
} from 'cesium'
import type { PreparedNetwork } from '@/data/network-types'
import { isInTunnel } from '@/lib/tunnels'
import { tunnelOpacity } from './tunnel-view'

/** What the stops layer needs from the map around it. */
export interface StopsLayerHost {
  requestRender(): void
  /**
   * Ellipsoidal ground height on the loaded photo tiles, undefined where
   * no tile is queryable (yet).
   */
  sampleGroundHeight(lon: number, lat: number): number | undefined
  /** Current fallback ground height (rises once the bootstrap has run). */
  readonly defaultGroundHeight: number
  /** false offline and until the photorealistic tileset is loaded. */
  readonly hasTileset: boolean
  /** Device pixel ratio the canvases are drawn at. */
  readonly pixelRatio: number
}

/**
 * One stop of the height bootstrap: the coordinates to measure and the way
 * to apply the result. Keeps the layer's records out of the bootstrap in
 * CesiumMap, which only needs these three things.
 */
export interface StopHeightSample {
  readonly lon: number
  readonly lat: number
  /** DGM height in m NHN where the dataset has one. */
  readonly nhn?: number
  /** Applies a most-detailed tile measurement – final, never re-measured. */
  apply(ellipsoidHeight: number): void
}

interface StopEntityRecord {
  /** Disc marker – a billboard in stopBillboards, added before all names. */
  disc: Billboard
  /** Name plate – a billboard in stopBillboards, added after all discs. */
  label: Billboard
  /**
   * Half the rendered name plate width in CSS px – the screen-space
   * rectangle for the label declutter.
   */
  labelHalfWidth: number
  /** Ids of all lines serving this stop (stops are shared across lines). */
  lines: string[]
  /**
   * At least one serving line is currently shown – drives disc/label
   * visibility together with the global stops layer toggle.
   */
  lineVisible: boolean
  /** Platform lies on an underground section (drives the ghosting). */
  inTunnel: boolean
  lon: number
  lat: number
  /** Fixed world position of the stop – basis for the camera distance check. */
  position: Cartesian3
  /**
   * Camera distance in meters at which the currently applied height was
   * measured. Infinity = not measured yet, 0 = measured most-detailed
   * (final, no camera-dependent measurement may override it).
   */
  sampledFrom: number
  /**
   * Timestamp before which no new attempt is made – set when a measurement
   * found no queryable tile, so a handful of unreachable stops right in
   * front of the camera cannot monopolize the per-pass budget.
   */
  retryAfter: number
  /**
   * Terrain height in meters NHN from network.json (DGM) – paired with the
   * sampled tile height to calibrate the route height offset.
   */
  nhn?: number
}

/**
 * A stop height is re-measured once the camera has come this much closer
 * than at the previous measurement (0.7 = 30 % closer). Tile heights are
 * LOD-dependent, so a closer camera yields a measurably better value.
 */
const STOP_RESAMPLE_RATIO = 0.7

/** Stop heights measured per pass (one ray intersection each). */
const STOP_HEIGHT_BUDGET = 4

/**
 * Minimum spacing between two sampling passes in ms. Deliberately wall-clock
 * based rather than a frame count: the app throttles the simulation tick to
 * 2 Hz whenever the clock is paused or no vehicle is in view, which would
 * otherwise stretch a pass to 7.5 s and leave stops the user is looking at
 * on the fallback height for minutes.
 */
const STOP_SAMPLE_INTERVAL_MS = 500

/** How long a stop is skipped for after a measurement found no loaded tile. */
const STOP_RETRY_MS = 1500

/** Camera distance in meters up to which the stop discs are drawn. */
const STOP_DISC_RANGE = 20000

/** Camera distance in meters up to which stop name labels are drawn. */
const STOP_LABEL_RANGE = 2600

/** Rendered size of a stop disc in CSS px (fill + outline). */
const STOP_DISC_SIZE = 10

/** Font size of the stop name plates in CSS px. */
const STOP_LABEL_FONT_SIZE = 13
/** Font size of the serving-lines suffix, e.g. "(1, 5, 25)". */
const STOP_LABEL_LINES_FONT_SIZE = 11
const STOP_LABEL_FONT_FAMILY = '"Inter Variable", system-ui, sans-serif'

/** Canvas height of a stop name plate in CSS px (font + outline). */
const STOP_LABEL_HEIGHT = 20

/** Vertical anchor offset of a stop label above its disc in CSS px. */
const STOP_LABEL_OFFSET_Y = -16

/**
 * Minimum screen-space gap between two stop labels in CSS px – labels whose
 * padded rectangles intersect an already accepted one are hidden.
 */
const STOP_LABEL_GAP = 4



// Scratch for the declutter's screen projections.
const windowScratch = new Cartesian2()

/** Nearest-stop working set of the height sampling (see resolveHeights). */
const nearestStops: (StopEntityRecord | null)[] = new Array(STOP_HEIGHT_BUDGET).fill(null)
const nearestDistances = new Float64Array(STOP_HEIGHT_BUDGET)

/** One label's anchor on screen (CSS px) and half its rendered width. */
export interface LabelBox {
  x: number
  y: number
  halfWidth: number
}

/**
 * Screen-space label pruning. The boxes come in nearest-first order, and a
 * label stays visible only where its box overlaps none of the boxes already
 * kept – so the nearest stop wins a collision.
 *
 * Pure on purpose: this is the part of the declutter worth testing, and it
 * needs neither a scene nor a camera to do it.
 */
export function keepNonOverlappingLabels(boxes: readonly LabelBox[]): boolean[] {
  const kept: { left: number; right: number; top: number; bottom: number }[] = []
  return boxes.map((box) => {
    const halfWidth = box.halfWidth + STOP_LABEL_GAP
    // Window y grows downward; the label is anchored bottom-center at
    // pixelOffset above the disc.
    const bottom = box.y + STOP_LABEL_OFFSET_Y
    const top = bottom - STOP_LABEL_HEIGHT - STOP_LABEL_GAP
    const left = box.x - halfWidth
    const right = box.x + halfWidth
    const free = !kept.some(
      (rect) => left < rect.right && right > rect.left && top < rect.bottom && bottom > rect.top,
    )
    if (free) kept.push({ left, right, top, bottom })
    return free
  })
}

export class StopsLayer {
  /** Discs AND name plates in one collection (add order = overlap order). */
  private stopBillboards: BillboardCollection | null = null
  private stopRecords: StopEntityRecord[] = []
  /** A stop changed (position, visibility) – the label declutter must rerun. */
  private stopLabelsDirty = true
  /** Camera view matrix of the last declutter pass (all zeros = never ran). */
  private declutterViewMatrix = new Matrix4()
  private lastStopSampleAt = 0
  /** Underground view (see setUnderground). */
  private underground = false

  constructor(
    private readonly viewer: Viewer,
    private readonly host: StopsLayerHost,
  ) {}

  /** Number of stops on the map (0 before add()). */
  get count(): number {
    return this.stopRecords.length
  }

  /**
   * Underground view: the stops on the surface are ghosted, the ones on an
   * underground platform stay solid – the same swap the routes and vehicles
   * make. Disc and name plate carry it via their color multiplier.
   */
  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    for (const record of this.stopRecords) this.applyStopOpacity(record)
    this.host.requestRender()
  }

  private applyStopOpacity(record: StopEntityRecord): void {
    const alpha = tunnelOpacity(record.inTunnel, this.underground)
    record.disc.color = Color.WHITE.withAlpha(alpha)
    record.label.color = Color.WHITE.withAlpha(alpha)
  }

  setVisible(visible: boolean): void {
    if (this.stopBillboards) this.stopBillboards.show = visible
    this.stopLabelsDirty = true
    this.host.requestRender()
  }

  /**
   * Per-frame upkeep: refine a few stop heights and rerun the declutter if
   * the camera moved or a stop changed. Both are no-ops when nothing did.
   */
  update(): void {
    this.resolveHeights()
    this.declutterLabels()
  }

  /**
   * An evenly spread subset of the stops for the one-off height bootstrap
   * (see CesiumMap.bootstrapGroundHeights).
   */
  bootstrapSamples(max: number): StopHeightSample[] {
    const stride = Math.max(1, Math.ceil(this.stopRecords.length / max))
    return this.stopRecords
      .filter((_, index) => index % stride === 0)
      .map((stop) => ({
        lon: stop.lon,
        lat: stop.lat,
        nhn: stop.nhn,
        apply: (height: number) => {
          // Most detailed measurement available – mark as final so the
          // camera-dependent sampling in resolveHeights() leaves it alone.
          stop.sampledFrom = 0
          const lifted = Cartesian3.fromDegrees(stop.lon, stop.lat, height + 0.5)
          stop.disc.position = lifted
          stop.label.position = lifted
          this.stopLabelsDirty = true
        },
      }))
  }

  add(network: PreparedNetwork): void {
    // One shared billboard collection for discs AND name plates, rendered
    // purely translucent – see stopBillboards for why the add order inside
    // a single collection is the only reliable overlap order. The names
    // are pre-rendered to canvases (like the tram badges); Cesium's Label
    // primitives would live in their own collection again and lose the
    // ordering guarantee.
    const billboards = new BillboardCollection({ blendOption: BlendOption.TRANSLUCENT })
    this.viewer.scene.primitives.add(billboards)
    this.stopBillboards = billboards

    const unique: {
      id: string
      name: string
      lon: number
      lat: number
      nhn?: number
      lines: string[]
      /** Served underground by at least one line (drives the ghosting). */
      inTunnel: boolean
    }[] = []
    // Stops are shared across lines – collect every serving line per stop,
    // so hiding lines can hide exactly the stops no shown line serves.
    const byId = new Map<string, { entry: (typeof unique)[number] }>()
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          // Underground platform: the stop's distance along this direction
          // falls inside one of its tunnel sections. A stop shared with a
          // surface line counts as underground all the same – its platform
          // is down there either way.
          const underground = isInTunnel(dir.tunnels, stop.dist)
          const known = byId.get(stop.id)
          if (known) {
            if (!known.entry.lines.includes(line.id)) known.entry.lines.push(line.id)
            if (underground) known.entry.inTunnel = true
            continue
          }
          const [lon, lat] = stop.coord
          const entry = {
            id: stop.id,
            name: stop.name,
            lon,
            lat,
            nhn: stop.nhn,
            lines: [line.id],
            inTunnel: underground,
          }
          byId.set(stop.id, { entry })
          unique.push(entry)
        }
      }
    }

    const positions = unique.map((stop) =>
      Cartesian3.fromDegrees(stop.lon, stop.lat, this.host.defaultGroundHeight + 0.5),
    )

    // First pass: all discs (one shared image via a fixed imageId).
    // In environments without a 2D canvas (jsdom) the billboards simply
    // carry no image – nothing renders there anyway.
    const discImage = this.stopDiscImage()
    const discs = unique.map((stop, i) => {
      const disc = billboards.add({
        id: `stop:${stop.id}`,
        position: positions[i],
        width: STOP_DISC_SIZE,
        height: STOP_DISC_SIZE,
        distanceDisplayCondition: new DistanceDisplayCondition(0, STOP_DISC_RANGE),
        disableDepthTestDistance: 3000,
      })
      if (discImage) disc.setImage('mrt:stop-disc', discImage)
      return disc
    })

    // Second pass: every name plate after every disc
    unique.forEach((stop, i) => {
      const plate = this.stopNameplate(stop.name, stop.lines)
      const label = billboards.add({
        id: `stop:${stop.id}`,
        position: positions[i],
        image: plate?.canvas,
        width: plate?.width,
        height: plate?.height,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, STOP_LABEL_OFFSET_Y),
        distanceDisplayCondition: new DistanceDisplayCondition(0, STOP_LABEL_RANGE),
        disableDepthTestDistance: 3000,
      })
      this.stopRecords.push({
        disc: discs[i],
        label,
        labelHalfWidth: plate
          ? plate.width / 2
          : (stop.name.length + stop.lines.join(', ').length + 3) * 3.5,
        lines: stop.lines,
        lineVisible: true,
        inTunnel: stop.inTunnel,
        lon: stop.lon,
        lat: stop.lat,
        position: Cartesian3.fromDegrees(stop.lon, stop.lat, this.host.defaultGroundHeight),
        sampledFrom: Number.POSITIVE_INFINITY,
        retryAfter: 0,
        nhn: stop.nhn,
      })
    })
    this.stopLabelsDirty = true
    this.host.requestRender()
  }

  /**
   * Applies the line visibility to the stops: a stop stays on the map as
   * long as at least one line serving it is shown. Composes with the
   * global stops layer toggle (collection show) and with the label
   * declutter, which skips hidden stops and re-runs after a change.
   */
  setVisibleLines(visibleLines: ReadonlySet<string>): void {
    let changed = false
    for (const record of this.stopRecords) {
      const visible = record.lines.some((id) => visibleLines.has(id))
      if (visible === record.lineVisible) continue
      record.lineVisible = visible
      record.disc.show = visible
      // Re-shown labels start visible; the declutter prunes overlaps on
      // its next pass (stopLabelsDirty below).
      record.label.show = visible
      changed = true
    }
    if (changed) {
      this.stopLabelsDirty = true
      this.host.requestRender()
    }
  }

  /** Disc image shared by all stops, drawn at the drawing-buffer ratio. */
  private stopDiscImage(): HTMLCanvasElement | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const ratio = this.host.pixelRatio
    const size = Math.round(STOP_DISC_SIZE * ratio)
    canvas.width = size
    canvas.height = size
    const center = size / 2
    ctx.beginPath()
    // Stroke is centered on the arc – pull the radius in by half of it
    ctx.arc(center, center, center - ratio, 0, 2 * Math.PI)
    ctx.fillStyle = '#f8fafc'
    ctx.fill()
    ctx.lineWidth = 2 * ratio
    ctx.strokeStyle = '#334155'
    ctx.stroke()
    return canvas
  }

  /**
   * Renders a stop name plus the serving lines in parentheses (outlined
   * text, the lines slightly smaller and dimmer) to a canvas at the
   * drawing-buffer pixel ratio. Returns undefined where no 2D canvas is
   * available (jsdom).
   */
  private stopNameplate(
    name: string,
    lines: string[],
  ): { canvas: HTMLCanvasElement; width: number; height: number } | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const ratio = this.host.pixelRatio
    const nameFont = `${Math.round(STOP_LABEL_FONT_SIZE * ratio)}px ${STOP_LABEL_FONT_FAMILY}`
    const linesFont = `${Math.round(STOP_LABEL_LINES_FONT_SIZE * ratio)}px ${STOP_LABEL_FONT_FAMILY}`
    const suffix = lines.length > 0 ? `(${lines.join(', ')})` : ''
    ctx.font = nameFont
    const nameWidth = ctx.measureText(name).width
    ctx.font = linesFont
    const suffixWidth = suffix ? ctx.measureText(suffix).width : 0
    const gap = suffix ? 5 * ratio : 0
    const padX = 4 * ratio
    const height = Math.round(STOP_LABEL_HEIGHT * ratio)
    const width = Math.ceil(nameWidth + gap + suffixWidth + 2 * padX)
    canvas.width = width
    canvas.height = height
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3 * ratio
    ctx.strokeStyle = '#0f172a'
    ctx.font = nameFont
    ctx.strokeText(name, padX, height / 2)
    ctx.fillStyle = '#e2e8f0'
    ctx.fillText(name, padX, height / 2)
    if (suffix) {
      ctx.font = linesFont
      ctx.strokeText(suffix, padX + nameWidth + gap, height / 2)
      // Dimmer than the name, so long line lists stay secondary
      ctx.fillStyle = '#b7c2d0'
      ctx.fillText(suffix, padX + nameWidth + gap, height / 2)
    }
    return { canvas, width: width / ratio, height: height / ratio }
  }

  /**
   * Hides stop labels that would overlap an already accepted one. Cesium
   * draws every label unconditionally, so dense sections (downtown, shared
   * corridors) turned into unreadable text piles. The stop nearest to the
   * camera wins; a hidden label keeps its disc, so the stop itself stays
   * on the map. Only recomputed when the camera actually moved or a stop
   * changed (stopLabelsDirty) – an idle scene pays nothing.
   */
  private declutterLabels(): void {
    if (!this.stopBillboards || !this.stopBillboards.show || this.stopRecords.length === 0) return
    const camera = this.viewer.camera
    if (
      !this.stopLabelsDirty &&
      Matrix4.equals(this.declutterViewMatrix, camera.viewMatrix)
    ) {
      return
    }
    this.stopLabelsDirty = false
    Matrix4.clone(camera.viewMatrix, this.declutterViewMatrix)

    const scene = this.viewer.scene
    const cameraPosition = camera.positionWC
    // Candidates: stops whose label the DistanceDisplayCondition draws at
    // all. Behind-camera stops project to undefined and are skipped – their
    // label is off screen either way, its show flag does not matter.
    const candidates: { record: StopEntityRecord; distance: number; x: number; y: number }[] = []
    for (const record of this.stopRecords) {
      if (!record.lineVisible) continue
      const distance = Cartesian3.distance(cameraPosition, record.position)
      if (distance > STOP_LABEL_RANGE) continue
      const windowPosition = SceneTransforms.worldToWindowCoordinates(
        scene,
        record.disc.position,
        windowScratch,
      )
      if (!windowPosition) continue
      candidates.push({ record, distance, x: windowPosition.x, y: windowPosition.y })
    }
    candidates.sort((a, b) => a.distance - b.distance)

    const visible = keepNonOverlappingLabels(
      candidates.map((c) => ({ x: c.x, y: c.y, halfWidth: c.record.labelHalfWidth })),
    )
    let changed = false
    candidates.forEach((candidate, i) => {
      if (candidate.record.label.show === visible[i]) return
      candidate.record.label.show = visible[i]
      changed = true
    })
    if (changed) this.host.requestRender()
  }

  /**
   * Resolves the stop heights bit by bit (a few per pass).
   *
   * A measured height is NOT final: tileset.getHeight() only sees the tile
   * level currently loaded, and the coarse LOD of a far-away area sits up to
   * ~10 m above the real surface. Freezing the first measurement therefore
   * left every stop that was far from the camera at startup floating in
   * mid-air as soon as the camera came closer. Each stop hence remembers the
   * camera distance its height was measured at and is re-measured once the
   * camera has come substantially closer.
   */
  private resolveHeights(): void {
    if (!this.host.hasTileset || this.stopRecords.length === 0) return
    const now = performance.now()
    if (now - this.lastStopSampleAt < STOP_SAMPLE_INTERVAL_MS) return
    this.lastStopSampleAt = now
    const cameraPosition = this.viewer.camera.positionWC

    // Of all stops a measurement would improve, take the ones nearest to
    // the camera: those are what the user is looking at, and their tiles are
    // loaded in the finest detail right now. The distance check is far
    // cheaper than the ray intersection in sampleGroundHeight(), so scanning
    // every stop to spend the small budget well is worth it.
    let count = 0
    for (const stop of this.stopRecords) {
      if (now < stop.retryAfter) continue
      const distance = Cartesian3.distance(cameraPosition, stop.position)
      if (distance > stop.sampledFrom * STOP_RESAMPLE_RATIO) continue
      if (count === STOP_HEIGHT_BUDGET && distance >= nearestDistances[count - 1]) continue
      // Insertion into the ascending list – at four entries a linear shift
      // beats any heap.
      let slot = Math.min(count, STOP_HEIGHT_BUDGET - 1)
      while (slot > 0 && nearestDistances[slot - 1] > distance) {
        nearestDistances[slot] = nearestDistances[slot - 1]
        nearestStops[slot] = nearestStops[slot - 1]
        slot--
      }
      nearestDistances[slot] = distance
      nearestStops[slot] = stop
      if (count < STOP_HEIGHT_BUDGET) count++
    }

    for (let i = 0; i < count; i++) {
      const stop = nearestStops[i] as StopEntityRecord
      // Release the scratch slot – it would otherwise keep entities (and
      // through them the viewer) alive past destroy().
      nearestStops[i] = null
      const height = this.host.sampleGroundHeight(stop.lon, stop.lat)
      if (height === undefined) {
        // No tile queryable there (yet) – keep the current height and let
        // other stops have the budget for a while.
        stop.retryAfter = now + STOP_RETRY_MS
        continue
      }
      stop.sampledFrom = nearestDistances[i]
      const lifted = Cartesian3.fromDegrees(stop.lon, stop.lat, height + 0.5)
      stop.disc.position = lifted
      stop.label.position = lifted
      this.stopLabelsDirty = true
      this.host.requestRender()
    }
  }
}
