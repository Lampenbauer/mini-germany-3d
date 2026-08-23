/**
 * The routes layer: one polyline set per line and direction, drawn at the
 * absolute DGM heights from network.json, plus the attention pulse that
 * "zoom to line" runs on them.
 *
 * Split out of CesiumMap. The NHN→ellipsoid offset lives here because the
 * route geometry is what it positions, but the map reads it for the
 * vehicles and hands over the calibrated value once the height bootstrap
 * has measured it against the loaded tiles.
 */

import {
  CallbackProperty,
  Cartesian3,
  ClassificationType,
  Color,
  ColorMaterialProperty,
  ConstantProperty,
  Credit,
  type Entity,
  type Viewer,
} from 'cesium'
import type { PreparedDirection, PreparedNetwork } from '@/data/network-types'
import type { LonLat } from '@/lib/geo'
import { mirrorTunnelRanges, splitPathByTunnels } from '@/lib/tunnels'

/** What the routes layer needs from the map around it. */
export interface RoutesLayerHost {
  requestRender(): void
  /** Offline mode draws on the bare ellipsoid, where DGM heights would float. */
  readonly offline: boolean
}

/** Base alpha of the route polylines. */
const ROUTE_ALPHA = 0.85

/**
 * Initial offset in meters between NHN heights (DHHN2016, the reference of
 * the DGM route heights in network.json) and the ellipsoidal heights the
 * scene works in: the geoid undulation around Rostock is ~36 m. Only a
 * first guess so the routes appear at roughly the right height immediately;
 * the height bootstrap calibrates the real offset against the Google tiles
 * (which carry their own bias of a few meters) within seconds.
 */
export const ROUTE_HEIGHT_OFFSET_FALLBACK = 36.5

/**
 * Base lift of the route polylines above the terrain height in meters –
 * keeps them clear of road surfaces that sit slightly above the DGM (curbs,
 * rails) and of z-fighting with the tile mesh.
 */
const ROUTE_BASE_LIFT = 0.8

/**
 * Additional per-line lift stagger. Lines sharing a street would otherwise
 * be exactly coplanar and flicker; a few decimeters are invisible from any
 * distance at which routes are readable, but separate the depth values.
 */
const ROUTE_LIFT_STEP = 0.15
const ROUTE_LIFT_SLOTS = 8

/**
 * Additional lift for ferry route lines in meters: their NHN height is 0,
 * but the Google mesh's water surface undulates up to ~1 m around the
 * geoid, which the land-calibrated height offset cannot capture.
 */
const FERRY_ROUTE_EXTRA_LIFT = 1.25

/**
 * Attention pulse on a line's route after "zoom to line": the opacity
 * swings smoothly from full to zero and back (cosine), several dips over
 * the total duration. Smooth instead of hard on/off blinking – the route
 * stays readable while clearly calling attention to itself. All OTHER
 * lines fade out for the duration (ROUTE_PULSE_FADE_MS ramps at both
 * ends), so the pulsing line stands out even on shared corridors.
 */
export const ROUTE_PULSE_DURATION_MS = 3000
const ROUTE_PULSE_PERIOD_MS = 750
const ROUTE_PULSE_FADE_MS = 250

/**
 * Visibility of tunnel/underground sections: route pieces and vehicles on
 * them are rendered at this fraction of their normal opacity. Exported for
 * the tests, which pin the ghosting behaviour against it.
 */
export const TUNNEL_VISIBILITY = 0.2

/**
 * True when the reverse direction is an exact mirror of the forward one
 * (path reversed point for point, tunnel ranges mirrored) – then a single
 * set of polylines covers both directions. Directions that merely share
 * length and endpoints (e.g. loops, or asymmetric tunnel tagging) are
 * drawn separately.
 */
function directionsAreMirrored(
  forward: PreparedDirection,
  reverse: PreparedDirection,
): boolean {
  if (forward.path.length !== reverse.path.length) return false
  const lastPoint = forward.path.length - 1
  for (let i = 0; i <= lastPoint; i++) {
    const a = forward.path[lastPoint - i]
    const b = reverse.path[i]
    if (a[0] !== b[0] || a[1] !== b[1]) return false
  }
  const mirrored = mirrorTunnelRanges(forward.tunnels, forward.totalLength)
  if (mirrored.length !== reverse.tunnels.length) return false
  // Mirrored meter ranges are recomputed floats – compare with a tolerance
  // far below visibility instead of bit-exact.
  return mirrored.every(
    ([start, end], i) =>
      Math.abs(start - reverse.tunnels[i][0]) < 0.01 &&
      Math.abs(end - reverse.tunnels[i][1]) < 0.01,
  )
}

export class RoutesLayer {
  private routeEntities = new Map<string, Entity[]>()
  /**
   * Route pieces drawn at absolute heights (NHN + routeHeightOffset) –
   * kept so the calibration can rewrite their positions once the real
   * NHN→ellipsoid offset has been measured against the loaded tiles.
   */
  private heightRoutePieces: { entity: Entity; path: LonLat[]; heights: number[]; lift: number }[] =
    []
  /** Current NHN→ellipsoidal offset for route heights (calibrated later). */
  private routeHeightOffset = ROUTE_HEIGHT_OFFSET_FALLBACK
  /** Route coordinates per line as a flat [lon, lat, …] array (camera fit). */
  private linePaths = new Map<string, number[]>()
  /** Running route attention pulse (see startRoutePulse), null = none. */
  private routePulse: { lineId: string; start: number; until: number } | null = null

  constructor(
    private readonly viewer: Viewer,
    private readonly host: RoutesLayerHost,
  ) {}

  /** Current NHN→ellipsoidal offset – the vehicles ride on it too. */
  get heightOffset(): number {
    return this.routeHeightOffset
  }

  /** true once at least one route piece is drawn at absolute heights. */
  get hasHeightPieces(): boolean {
    return this.heightRoutePieces.length > 0
  }

  /**
   * Flat [lon, lat, …] of a line's route, for the "zoom to line" camera
   * fit. undefined for an unknown line.
   */
  linePoints(lineId: string): number[] | undefined {
    return this.linePaths.get(lineId)
  }

  /**
   * Applies the NHN→ellipsoid offset measured by the height bootstrap and
   * re-anchors every height-based route piece to it.
   */
  calibrateHeightOffset(offset: number): void {
    this.routeHeightOffset = offset
    this.applyRouteHeightOffset()
  }

  /**
   * Draws the route polylines of all lines. With per-vertex terrain heights
   * from network.json (DGM © GeoBasis-DE/M-V) the routes are ordinary
   * polylines at absolute heights – Cesium's ground-clamping classification
   * passes cost measurable GPU time on EVERY rendered frame, so they are
   * reserved as a fallback for directions without height data (and for the
   * offline mode, whose ellipsoid ground sits at 0 m where NHN heights
   * would float mid-air). Tunnel/underground sections become their own
   * polyline pieces at 40 % of the normal opacity.
   */
  add(network: PreparedNetwork): void {
    // Network/height data licenses (ODbL, © GeoBasis-DE/M-V) require a
    // visible attribution – Cesium's credit display ("Data attribution")
    // is the canonical place for data-source credits.
    this.viewer.creditDisplay.addStaticCredit(new Credit(network.meta.attribution, false))

    network.lines.forEach((line, index) => {
      const color = Color.fromCssColorString(line.color)
      const entities: Entity[] = []
      // Ferry lines get extra clearance: their heights are 0 m NHN, but
      // the water surface in the Google mesh undulates (waves, wakes,
      // reconstruction noise) up to ~1 m around the geoid, and the
      // land-calibrated offset does not account for it – without the
      // extra lift the lines visibly dip into the water tiles.
      const modeLift = line.mode === 'ferry' ? FERRY_ROUTE_EXTRA_LIFT : 0
      const lift =
        ROUTE_BASE_LIFT + (index % ROUTE_LIFT_SLOTS) * ROUTE_LIFT_STEP + modeLift

      const dirs = [line.directions[0]]
      // Only draw the second direction if it has its own geometry or its
      // own tunnel layout (with mirrored directions both are identical)
      const d1 = line.directions[1]
      const d0 = line.directions[0]
      if (!directionsAreMirrored(d0, d1)) dirs.push(d1)

      for (const dir of dirs) {
        const heights = this.host.offline ? undefined : dir.heights
        const pieces = splitPathByTunnels(dir.path, dir.cum, dir.tunnels, heights)
        pieces.forEach((piece, pieceIndex) => {
          const alpha = piece.tunnel ? ROUTE_ALPHA * TUNNEL_VISIBILITY : ROUTE_ALPHA
          // Non-constant color: routes stay in Cesium's static polyline
          // batch (isDynamic only looks at geometry properties), but the
          // batch refreshes the per-instance color attribute in place on
          // every rendered frame – the supported path for animating the
          // attention pulse without primitive rebuilds. Replacing the
          // color property per frame instead re-batches asynchronously
          // and never becomes visible.
          const baseColor = color.withAlpha(alpha)
          const scratchColor = new Color()
          const material = new ColorMaterialProperty(
            new CallbackProperty(
              () => this.routePieceColor(line.id, baseColor, scratchColor),
              false,
            ),
          )
          const id = `route:${line.id}:${dir.direction}:${pieceIndex}`
          let entity: Entity
          if (piece.heights && piece.heights.length === piece.path.length) {
            entity = this.viewer.entities.add({
              id,
              polyline: {
                positions: this.routePiecePositions(piece.path, piece.heights, lift),
                width: 5,
                material,
              },
            })
            this.heightRoutePieces.push({
              entity,
              path: piece.path,
              heights: piece.heights,
              lift,
            })
          } else {
            entity = this.viewer.entities.add({
              id,
              polyline: {
                positions: Cartesian3.fromDegreesArray(piece.path.flat()),
                width: 5,
                clampToGround: true,
                material,
                classificationType: ClassificationType.BOTH,
                zIndex: 10 + index,
              },
            })
          }
          entities.push(entity)
        })
      }
      this.routeEntities.set(line.id, entities)

      // Union of both directions – basis for the "zoom to line" camera fit
      // (duplicate points of mirrored directions do not hurt the sphere).
      const flat: number[] = []
      for (const dir of line.directions) {
        for (const [lon, lat] of dir.path) flat.push(lon, lat)
      }
      this.linePaths.set(line.id, flat)
    })
    this.host.requestRender()
  }

  /** Starts the attention pulse on a line's route (replaces any running one). */
  startPulse(lineId: string): void {
    const now = performance.now()
    this.routePulse = { lineId, start: now, until: now + ROUTE_PULSE_DURATION_MS }
    this.host.requestRender()
  }

  /**
   * Current color of a route piece – the CallbackProperty behind every
   * piece's material, evaluated per rendered frame by Cesium's color
   * batch. Without a pulse it is the base color, so ending a pulse
   * restores the exact originals by construction. (Offline mode draws
   * ground-clamped routes in Cesium's per-material batch, which does not
   * re-evaluate colors per frame – the pulse is only visible on the
   * height-based routes of the normal online mode.)
   */
  private routePieceColor(lineId: string, base: Color, result: Color): Color {
    const pulse = this.routePulse
    if (!pulse) return Color.clone(base, result)
    const now = performance.now()
    if (now >= pulse.until) return Color.clone(base, result)
    if (pulse.lineId !== lineId) {
      // Every other line clears the stage while the pulse runs – faded
      // out at the start and back in at the end instead of popping.
      const fadeOut = Math.min(1, (now - pulse.start) / ROUTE_PULSE_FADE_MS)
      const fadeIn = Math.min(1, (pulse.until - now) / ROUTE_PULSE_FADE_MS)
      const hidden = Math.min(fadeOut, fadeIn)
      return Color.fromAlpha(base, base.alpha * (1 - hidden), result)
    }
    const phase = ((now - pulse.start) % ROUTE_PULSE_PERIOD_MS) / ROUTE_PULSE_PERIOD_MS
    // Cosine: starts at full opacity, dips to 0, comes back – per period
    const factor = 0.5 + 0.5 * Math.cos(2 * Math.PI * phase)
    return Color.fromAlpha(base, base.alpha * factor, result)
  }

  /**
   * Drives the pulse from render(): keeps frames coming while it runs
   * (regardless of the simulation tick rate) and clears it once over –
   * the final requestRender repaints the base colors.
   */
  updatePulse(): void {
    if (!this.routePulse) return
    if (performance.now() >= this.routePulse.until) {
      this.routePulse = null
    }
    this.host.requestRender()
  }

  setVisible(visible: boolean): void {
    for (const entities of this.routeEntities.values()) {
      for (const e of entities) e.show = visible
    }
    this.host.requestRender()
  }

  /** World positions of a height-based route piece at the current offset. */
  private routePiecePositions(path: LonLat[], heights: number[], lift: number): Cartesian3[] {
    return path.map(([lon, lat], i) =>
      Cartesian3.fromDegrees(lon, lat, heights[i] + this.routeHeightOffset + lift),
    )
  }

  /**
   * Re-anchors all height-based route pieces after the NHN→ellipsoid
   * offset has been calibrated against the loaded Google tiles. One-off
   * work (a few hundred polylines) – not a per-frame cost.
   */
  private applyRouteHeightOffset(): void {
    for (const piece of this.heightRoutePieces) {
      const polyline = piece.entity.polyline
      if (!polyline) continue
      polyline.positions = new ConstantProperty(
        this.routePiecePositions(piece.path, piece.heights, piece.lift),
      )
    }
    this.host.requestRender()
  }

  setLineVisible(lineId: string, visible: boolean): void {
    for (const e of this.routeEntities.get(lineId) ?? []) e.show = visible
    this.host.requestRender()
  }
}
