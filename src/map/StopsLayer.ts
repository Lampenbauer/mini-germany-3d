/**
 * The stops layer: one disc plus one name per stop position, their
 * line-driven visibility, the screen-space label declutter, and the
 * camera-dependent height refinement on the photo tiles.
 *
 * The disc lies flat on the ground (StopDiscs, one instanced draw
 * command for all of them); the name stands over it as a billboard. Both
 * are written to from here – position, opacity, visibility – and nothing
 * else touches either.
 *
 * Split out of CesiumMap: this owns a closed set of state (the discs, the
 * names' billboard collection, one record per stop, the declutter
 * bookkeeping) and reaches back into the map only through the narrow
 * StopsLayerHost below.
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
import { FRAMING_SCALE } from './camera-fov'
import { isInTunnel } from '@/lib/tunnels'
import { StopDiscs } from './StopDiscs'
import {
  keepNonOverlappingLabels,
  type LabelMetrics,
  type ScreenRect,
} from './screen-rects'
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
  /**
   * Bumped when the loaded tiles changed (see CesiumMap.advanceSurfaceGeneration)
   * – the only thing that can change the answer of a ray that found no
   * tile. Absent (the tests' fake map): every generation is the same.
   */
  surfaceGeneration?(): number
  /** Device pixel ratio the canvases are drawn at. */
  readonly pixelRatio: number
  /** Screen rectangles the labels keep clear of (the webcam pictures). */
  obstacles?: () => readonly ScreenRect[]
  /** Bumped whenever the obstacles changed without the camera moving. */
  obstaclesVersion?: () => number
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
  /** The stop's id – what a click on the disc reports, what the name's image is keyed by. */
  id: string
  /** The disc: this stop's instance in the discs primitive (see StopDiscs). */
  disc: number
  /**
   * Name – a billboard in the labels collection. It carries no picture
   * until the stop first comes within label range (see drawStopName); an
   * imageless billboard draws nothing.
   */
  label: Billboard
  /** The stop's name, for the day its plate is actually drawn. */
  name: string
  /** Whether the name canvas has been drawn onto the label billboard. */
  named: boolean
  /**
   * Half the rendered name width in CSS px – the screen-space
   * rectangle for the label declutter. An estimate until the name is
   * drawn, the measured half-width afterwards.
   */
  labelHalfWidth: number
  /** Ids of all lines serving this stop (stops are shared across lines). */
  lines: string[]
  /**
   * At least one serving line is currently shown – drives disc/label
   * visibility together with the global stops layer toggle and with a
   * running line focus (see startLineFocus).
   */
  lineVisible: boolean
  /**
   * The composed visibility – a serving line shown, and the focused line
   * among them while a focus runs – as written onto the disc and the
   * name (applyStopVisibility). The declutter reads it and only ever
   * writes `label.show`.
   */
  shown: boolean
  /**
   * Where the disc lies and the name stands: the stop, STOP_LIFT_M above
   * the ground as last measured. What stopWorldPosition reports and the
   * declutter projects.
   */
  discPosition: Cartesian3
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
   * Surface generation at which a measurement found no queryable tile
   * there, -1 = none: the stop is left alone until the tiles change, so a
   * handful of unreachable stops right in front of the camera cannot
   * monopolize the per-pass budget – they used to be asked again every
   * 1.5 s, eight rays a second for good at a resting camera over water
   * (each ray reads the tile geometry back from the GPU).
   */
  failedAtGeneration: number
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
 * Name plates drawn per declutter pass. A city's stop names used to be
 * drawn all at once when the city went up – Berlin's 2682 of them cost
 * ~300 ms of canvas work and one texture atlas upload, and that landed in
 * the single frame of the city handover, halfway through the flight, where
 * it was the whole of the freeze (measured at 398 ms with the
 * names, 74 ms without). None of them can be seen at that moment: the
 * camera is some 85 km up and a name is drawn within STOP_LABEL_RANGE, so
 * the work was not merely badly timed but pointless. A name is drawn now
 * when its stop first comes close enough to have one, a few per pass like
 * the heights beside it, and the atlas ends up holding what was actually
 * looked at rather than every stop in the city.
 *
 * Large enough to converge at the slowest tick the app has: `update()` rides
 * the simulation tick (see CesiumMap.syncVehicles), which is 500 ms while the
 * clock is paused with nothing in view, so a close view full of stops fills
 * in under a second at 48 a pass and took 1.6 s at 24. A pass of 48 costs
 * about 9 ms. Exported for the test that pins the budget.
 */
export const STOP_NAME_BUDGET = 48

/**
 * Minimum spacing between two sampling passes in ms. Deliberately wall-clock
 * based rather than a frame count: the app throttles the simulation tick to
 * 2 Hz whenever the clock is paused or no vehicle is in view, which would
 * otherwise stretch a pass to 7.5 s and leave stops the user is looking at
 * on the fallback height for minutes.
 */
const STOP_SAMPLE_INTERVAL_MS = 500

/**
 * Camera distances in meters up to which the stop discs and their name
 * labels are drawn. Both are on-screen sizes in disguise and therefore
 * follow the field of view (see camera-fov.ts): at a narrower angle the
 * camera stands further back for the same view, and without the scale the
 * home view loses more than half of its discs.
 */
const STOP_DISC_RANGE = 20000 * FRAMING_SCALE
/** Exported so the declutter test can stand its camera outside it. */
export const STOP_LABEL_RANGE = 2000 * FRAMING_SCALE

/**
 * How far above the measured ground the disc lies and the name stands,
 * in meters: clear of the tiles' own surface, which the disc would
 * otherwise cut into wherever the mesh is a hair above the measurement.
 */
const STOP_LIFT_M = 0.5

/** Font size of the stop names in CSS px. */
const STOP_LABEL_FONT_SIZE = 10
/** Font size of the serving-lines suffix, e.g. "(1, 5, 25)". */
const STOP_LABEL_LINES_FONT_SIZE = 9
const STOP_LABEL_FONT_FAMILY = '"Inter Variable", system-ui, sans-serif'

/*
 * The ink and its halo – the disc wears the same two, see StopDiscs. A
 * stop name is bare text, not a plate: the plate –
 * white, then grey, then a pill – was the brightest thing over Google's
 * tiles whatever its colour and outshouted the line badges, which are what
 * the map is about. A vehicle is the news, a stop is the furniture. Bare
 * text carries no surface of its own, so it settles into the photograph
 * instead of sitting on it, and the map keeps its three kinds of name apart
 * by texture rather than by plate: a badge is white on colour, a ship is
 * white on a dark plate, a stop is light ink with a dark halo, the way a
 * street name is written on any map.
 *
 * The halo is what makes bare text hold one weight over bright roofs, dark
 * trees and wet asphalt alike. It is thin – a rim, not a plate returning
 * by the back door – and dark rather than light, because Google's tiles
 * are mostly bright in daylight and a light rim there is no rim at all.
 * Slate, as everywhere else in this interface; the line list a shade
 * dimmer than the name so long lists stay secondary.
 */
const STOP_LABEL_NAME = 'oklch(0.9842 0.0034 247.86)'
const STOP_LABEL_LINES = 'oklch(0.9288 0.0126 255.51)'
const STOP_LABEL_HALO = 'oklch(0.3717 0.0392 257.29)'
/** Width of the halo stroke in CSS px – drawn centred on the glyph edge,
 *  so half of it shows outside the ink. */
const STOP_LABEL_HALO_WIDTH = 3

/**
 * Margin around the text inside its canvas, in CSS px, on every side: the
 * half of the halo that lies outside the glyphs, rounded up to a whole
 * pixel. Derived from the stroke rather than tuned beside it, so a thicker
 * halo cannot be clipped at the canvas edge by a margin nobody widened.
 */
const STOP_LABEL_PAD = Math.ceil(STOP_LABEL_HALO_WIDTH / 2)
/**
 * Canvas height of a stop name: the line plus that margin above and below,
 * so the canvas follows the font and the halo instead of having to be
 * re-tuned beside them.
 *
 * Checked against the real ink rather than against the nominal size: at
 * 10 px the tallest German stop names ("Gehlsdorf Fähre") span 10.34 px
 * from the umlaut dots down to the descender – a hair more than the font
 * size, and the ratio holds as the size moves – so the margin leaves a
 * little under two pixels clear on each side, which is what the halo's
 * outer half needs.
 */
const STOP_LABEL_HEIGHT = STOP_LABEL_FONT_SIZE + 2 * STOP_LABEL_PAD

/**
 * Vertical anchor offset of a stop label above its disc in CSS px: the
 * canvas is anchored by its bottom edge, so this is the gap itself – close
 * enough that name and disc read as one mark rather than as a name
 * floating over a dot.
 */
const STOP_LABEL_OFFSET_Y = -10

/**
 * Minimum screen-space gap between two stop labels in CSS px – labels whose
 * padded rectangles intersect an already accepted one are hidden.
 */
const STOP_LABEL_GAP = 12

/**
 * The stop name as the declutter sees it: bottom edge STOP_LABEL_OFFSET_Y
 * above the disc, STOP_LABEL_HEIGHT tall, keeping STOP_LABEL_GAP clear.
 * Exported for the test that pins the pruning.
 */
export const STOP_LABEL_METRICS: LabelMetrics = {
  offsetY: STOP_LABEL_OFFSET_Y,
  height: STOP_LABEL_HEIGHT,
  gap: STOP_LABEL_GAP,
}



// Scratch for the declutter's screen projections.
const windowScratch = new Cartesian2()

/** Nearest-stop working set of the height sampling (see resolveHeights). */
const nearestStops: (StopEntityRecord | null)[] = new Array(STOP_HEIGHT_BUDGET).fill(null)
const nearestDistances = new Float64Array(STOP_HEIGHT_BUDGET)

export class StopsLayer {
  /** The discs, flat on the ground – one primitive for all of them. */
  private discs: StopDiscs | null = null
  /** The names, one billboard each. */
  private labels: BillboardCollection | null = null
  private stopRecords: StopEntityRecord[] = []
  /** A stop changed (position, visibility) – the label declutter must rerun. */
  private stopLabelsDirty = true
  /** Camera view matrix of the last declutter pass (all zeros = never ran). */
  private declutterViewMatrix = new Matrix4()
  /** Obstacle version of the last declutter pass (see host.obstaclesVersion). */
  private declutterObstaclesVersion = -1
  private lastStopSampleAt = 0
  /** Underground view (see setUnderground). */
  private underground = false
  /** Running "zoom to line" focus (see startLineFocus), null = none. */
  private lineFocus: { lineId: string; until: number } | null = null

  constructor(
    private readonly viewer: Viewer,
    private readonly host: StopsLayerHost,
  ) {}

  /** Number of stops on the map (0 before add()). */
  get count(): number {
    return this.stopRecords.length
  }

  /** Takes every stop off the map (the map is moving on to another city). */
  clear(): void {
    // remove() destroys what it takes off: the discs' buffers and pick
    // ids, the collection and with it every billboard.
    if (this.discs) {
      this.viewer.scene.primitives.remove(this.discs)
      this.discs = null
    }
    if (this.labels) {
      this.viewer.scene.primitives.remove(this.labels)
      this.labels = null
    }
    this.stopRecords = []
    // The focus named a line of the city being left.
    this.lineFocus = null
    this.stopLabelsDirty = true
    this.host.requestRender()
  }

  /**
   * Current world position of a stop's disc (its lift included), or null
   * for an unknown id. E2E helper – lets a test click the real disc
   * without hunting for it with scene.pick.
   */
  stopWorldPosition(stopId: string): Cartesian3 | null {
    const record = this.stopRecords.find((r) => r.id === stopId)
    return record ? record.discPosition : null
  }

  /**
   * Underground view: the stops on the surface are ghosted, the ones on an
   * underground platform stay solid – the same swap the routes and vehicles
   * make. Disc and name carry it via their color multiplier.
   */
  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    for (const record of this.stopRecords) this.applyStopOpacity(record)
    this.host.requestRender()
  }

  private applyStopOpacity(record: StopEntityRecord): void {
    const alpha = tunnelOpacity(record.inTunnel, this.underground)
    this.discs?.setAlpha(record.disc, alpha)
    record.label.color = Color.WHITE.withAlpha(alpha)
  }

  setVisible(visible: boolean): void {
    if (this.discs) this.discs.show = visible
    if (this.labels) this.labels.show = visible
    this.stopLabelsDirty = true
    this.host.requestRender()
  }

  /**
   * Puts a stop on the ground as measured: disc and name move together,
   * and the declutter reruns for the name.
   */
  private placeStop(record: StopEntityRecord, groundHeight: number): void {
    const lifted = Cartesian3.fromDegrees(record.lon, record.lat, groundHeight + STOP_LIFT_M)
    record.discPosition = lifted
    this.discs?.setPosition(record.disc, lifted)
    record.label.position = lifted
    this.stopLabelsDirty = true
  }

  /**
   * Per-frame upkeep: let an expired line focus go, refine a few stop
   * heights and rerun the declutter if the camera moved or a stop changed.
   * All three are no-ops when nothing did.
   */
  update(): void {
    // No timer of its own: the pulse keeps frames coming to its very end
    // (RoutesLayer.updatePulse), so the stops are back one frame after it.
    if (this.lineFocus && performance.now() >= this.lineFocus.until) {
      this.lineFocus = null
      this.applyStopVisibility()
    }
    this.resolveHeights()
    this.declutterLabels()
  }

  /**
   * Puts every stop back on the map's ground height and forgets what was
   * measured on the tiles – the ground changed (see CesiumMap.setBasemap).
   * With tiles, resolveHeights measures the stops near the camera again.
   */
  resetHeights(): void {
    for (const record of this.stopRecords) {
      record.sampledFrom = Number.POSITIVE_INFINITY
      record.failedAtGeneration = -1
      this.placeStop(record, this.host.defaultGroundHeight)
    }
    this.host.requestRender()
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
          this.placeStop(stop, height)
        },
      }))
  }

  add(network: PreparedNetwork): void {
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
      Cartesian3.fromDegrees(stop.lon, stop.lat, this.host.defaultGroundHeight + STOP_LIFT_M),
    )

    // The discs: one primitive, one instance per stop, flat on the ground
    // (see StopDiscs) – on the scene before the names, which stand over
    // them and are a billboard each.
    const discs = new StopDiscs(
      unique.map((stop, i) => ({ id: stop.id, position: positions[i] })),
      { maxDistance: STOP_DISC_RANGE },
    )
    this.viewer.scene.primitives.add(discs)
    this.discs = discs
    // The names are pre-rendered to canvases (like the tram badges), so
    // they are billboards rather than Cesium's Label primitives; the
    // plates are claimed here and stay empty until the stop is close
    // enough to be named (see STOP_NAME_BUDGET).
    const labels = new BillboardCollection({ blendOption: BlendOption.TRANSLUCENT })
    this.viewer.scene.primitives.add(labels)
    this.labels = labels

    unique.forEach((stop, i) => {
      const label = labels.add({
        id: `stop:${stop.id}`,
        position: positions[i],
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.BOTTOM,
        pixelOffset: new Cartesian2(0, STOP_LABEL_OFFSET_Y),
        distanceDisplayCondition: new DistanceDisplayCondition(0, STOP_LABEL_RANGE),
        disableDepthTestDistance: 3000,
      })
      const record: StopEntityRecord = {
        id: stop.id,
        disc: i,
        label,
        name: stop.name,
        named: false,
        // Guessed from the text until the plate is drawn – which is all
        // there ever is where no canvas exists (Node, jsdom), and what the
        // declutter then places by.
        labelHalfWidth: (stop.name.length + stop.lines.join(', ').length + 3) * 3.5,
        lines: stop.lines,
        lineVisible: true,
        shown: true,
        discPosition: positions[i],
        inTunnel: stop.inTunnel,
        lon: stop.lon,
        lat: stop.lat,
        position: Cartesian3.fromDegrees(stop.lon, stop.lat, this.host.defaultGroundHeight),
        sampledFrom: Number.POSITIVE_INFINITY,
        failedAtGeneration: -1,
        nhn: stop.nhn,
      }
      this.stopRecords.push(record)
      // The underground view is the reader's and outlives the city switch,
      // so the stops that arrive take it as it stands. Every other layer
      // reads the flag as it draws; the disc and the name carry it in an
      // opacity written once, which left a city entered from below wearing
      // its surface stops solid over the tunnels.
      this.applyStopOpacity(record)
    })
    this.stopLabelsDirty = true
    this.host.requestRender()
  }

  /**
   * Applies the line visibility to the stops: a stop stays on the map as
   * long as at least one line serving it is shown. Composes with the
   * global stops layer toggle (collection show), with a running line focus
   * (see startLineFocus) and with the label declutter, which skips hidden
   * stops and re-runs after a change.
   */
  setVisibleLines(visibleLines: ReadonlySet<string>): void {
    for (const record of this.stopRecords) {
      record.lineVisible = record.lines.some((id) => visibleLines.has(id))
    }
    this.applyStopVisibility()
  }

  /**
   * "Zoom to line": for these few seconds only the stops that line calls at
   * stay on the map. The other routes fade out for the attention pulse (see
   * RoutesLayer) and the other lines' badges step aside with them
   * (VehicleLayer.startLineFocus) – every disc and name the line does not
   * call at would otherwise be the furniture left standing on the very
   * route the pulse is pointing at. The panel's line filter still has the
   * last word: a focus never shows a stop the filter has taken off.
   */
  startLineFocus(lineId: string, durationMs: number): void {
    this.lineFocus = { lineId, until: performance.now() + durationMs }
    this.applyStopVisibility()
  }

  /**
   * Writes the composed visibility of every stop onto its disc and its
   * name: at least one serving line shown, and the focused line among
   * them while a focus runs. `record.shown` carries the composed state –
   * the declutter reads it and only ever writes `label.show`.
   */
  private applyStopVisibility(): void {
    const focus = this.lineFocus?.lineId
    let changed = false
    for (const record of this.stopRecords) {
      const visible = record.lineVisible && (focus === undefined || record.lines.includes(focus))
      if (visible === record.shown) continue
      record.shown = visible
      this.discs?.setShown(record.disc, visible)
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

  /**
   * Draws a stop's name onto its plate – the canvas work `add` used to do
   * for every stop in the city at once. Keyed by stop id so the atlas holds
   * one region per name however often this is reached, and marked done even
   * where no canvas exists at all (Node, jsdom), so a nameless environment
   * does not spend its budget on the same stop every pass.
   */
  private drawStopName(record: StopEntityRecord): void {
    record.named = true
    const image = this.stopNameImage(record.name, record.lines)
    if (!image) return
    record.label.setImage(`mg3d:stop-name:${record.id}`, image.canvas)
    record.label.width = image.width
    record.label.height = image.height
    record.labelHalfWidth = image.width / 2
  }

  /**
   * Renders a stop name plus the serving lines in parentheses as haloed
   * text, at the drawing-buffer pixel ratio – see STOP_LABEL_NAME for why
   * bare text and not a plate. Returns undefined where no 2D canvas is
   * available (jsdom).
   */
  private stopNameImage(
    name: string,
    lines: string[],
  ): { canvas: HTMLCanvasElement; width: number; height: number } | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const ratio = this.host.pixelRatio
    const nameFont = `500 ${Math.round(STOP_LABEL_FONT_SIZE * ratio)}px ${STOP_LABEL_FONT_FAMILY}`
    const linesFont = `${Math.round(STOP_LABEL_LINES_FONT_SIZE * ratio)}px ${STOP_LABEL_FONT_FAMILY}`
    const suffix = lines.length > 0 ? `(${lines.join(', ')})` : ''
    ctx.font = nameFont
    const nameWidth = ctx.measureText(name).width
    ctx.font = linesFont
    const suffixWidth = suffix ? ctx.measureText(suffix).width : 0
    const gap = suffix ? 4 * ratio : 0
    const padX = STOP_LABEL_PAD * ratio
    canvas.width = Math.ceil(nameWidth + gap + suffixWidth + 2 * padX)
    canvas.height = Math.round(STOP_LABEL_HEIGHT * ratio)

    const textY = canvas.height / 2
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    // The halo first, under both runs, so the name's rim never cuts into
    // the line list where the two meet; round joins keep it a soft edge.
    ctx.lineJoin = 'round'
    ctx.lineWidth = STOP_LABEL_HALO_WIDTH * ratio
    ctx.strokeStyle = STOP_LABEL_HALO
    ctx.font = nameFont
    ctx.strokeText(name, padX, textY)
    if (suffix) {
      ctx.font = linesFont
      ctx.strokeText(suffix, padX + nameWidth + gap, textY)
    }
    ctx.font = nameFont
    ctx.fillStyle = STOP_LABEL_NAME
    ctx.fillText(name, padX, textY)
    if (suffix) {
      ctx.font = linesFont
      // Dimmer than the name, so long line lists stay secondary
      ctx.fillStyle = STOP_LABEL_LINES
      ctx.fillText(suffix, padX + nameWidth + gap, textY)
    }
    return { canvas, width: canvas.width / ratio, height: canvas.height / ratio }
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
    if (!this.labels || !this.labels.show || this.stopRecords.length === 0) return
    const camera = this.viewer.camera
    const obstaclesVersion = this.host.obstaclesVersion?.() ?? 0
    if (
      !this.stopLabelsDirty &&
      obstaclesVersion === this.declutterObstaclesVersion &&
      Matrix4.equals(this.declutterViewMatrix, camera.viewMatrix)
    ) {
      return
    }
    this.stopLabelsDirty = false
    this.declutterObstaclesVersion = obstaclesVersion
    Matrix4.clone(camera.viewMatrix, this.declutterViewMatrix)

    const scene = this.viewer.scene
    const cameraPosition = camera.positionWC
    // Candidates: stops whose label the DistanceDisplayCondition draws at
    // all. Behind-camera stops project to undefined and are skipped – their
    // label is off screen either way, its show flag does not matter.
    const candidates: { record: StopEntityRecord; distance: number; x: number; y: number }[] = []
    for (const record of this.stopRecords) {
      // record.shown is the composed visibility (line filter and focus):
      // a stop that is off the map has no name to place either.
      if (!record.shown) continue
      const distance = Cartesian3.distance(cameraPosition, record.position)
      if (distance > STOP_LABEL_RANGE) continue
      const windowPosition = SceneTransforms.worldToWindowCoordinates(
        scene,
        record.discPosition,
        windowScratch,
      )
      if (!windowPosition) continue
      candidates.push({ record, distance, x: windowPosition.x, y: windowPosition.y })
    }
    candidates.sort((a, b) => a.distance - b.distance)

    // Nearest first, so a budget that runs out runs out on the stops
    // furthest away. A name still undrawn is left out of the declutter
    // entirely rather than claiming space with its estimated width, and
    // the pass is marked for a rerun so the rest follow a frame later.
    let nameBudget = STOP_NAME_BUDGET
    let namesPending = false
    const placeable: typeof candidates = []
    for (const candidate of candidates) {
      if (!candidate.record.named) {
        if (nameBudget === 0) {
          namesPending = true
          continue
        }
        nameBudget--
        this.drawStopName(candidate.record)
      }
      placeable.push(candidate)
    }
    if (namesPending) this.stopLabelsDirty = true

    const visible = keepNonOverlappingLabels(
      placeable.map((c) => ({ x: c.x, y: c.y, halfWidth: c.record.labelHalfWidth })),
      STOP_LABEL_METRICS,
      this.host.obstacles?.() ?? [],
    )
    let changed = false
    placeable.forEach((candidate, i) => {
      if (candidate.record.label.show === visible[i]) return
      candidate.record.label.show = visible[i]
      changed = true
    })
    // A drawn name is a new picture in the atlas, so the frame it was drawn
    // in has to be repainted whether or not a show flag moved; and while
    // names are still pending, the next frame is what draws them.
    if (changed || namesPending || nameBudget < STOP_NAME_BUDGET) this.host.requestRender()
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
    const generation = this.host.surfaceGeneration?.() ?? 0

    // Of all stops a measurement would improve, take the ones nearest to
    // the camera: those are what the user is looking at, and their tiles are
    // loaded in the finest detail right now. The distance check is far
    // cheaper than the ray intersection in sampleGroundHeight(), so scanning
    // every stop to spend the small budget well is worth it.
    let count = 0
    for (const stop of this.stopRecords) {
      if (stop.failedAtGeneration === generation) continue
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
        // other stops have the budget until the tiles change.
        stop.failedAtGeneration = generation
        continue
      }
      stop.sampledFrom = nearestDistances[i]
      this.placeStop(stop, height)
      this.host.requestRender()
    }
  }
}
