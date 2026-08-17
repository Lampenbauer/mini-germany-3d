/**
 * Imperative wrapper around the Cesium viewer: Google Photorealistic 3D
 * Tiles, line routes, stops, and the animated tram boxes.
 *
 * Deliberately kept free of any React dependency – React drives this class
 * through a narrow API (syncTrams, setLineVisibility, …) so the render loop
 * does not run through React re-renders.
 */

import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Cartographic,
  ClassificationType,
  Color,
  ColorGeometryInstanceAttribute,
  ColorMaterialProperty,
  ConstantPositionProperty,
  ConstantProperty,
  DistanceDisplayCondition,
  Entity,
  GeometryInstance,
  GridImageryProvider,
  HeadingPitchRange,
  HeadingPitchRoll,
  Intersect,
  Ion,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer,
  createGooglePhotorealistic3DTileset,
  type Cesium3DTileset,
} from 'cesium'
import { config } from '@/config'
import type { PreparedDirection, PreparedNetwork } from '@/data/network-types'
import type { TramSnapshot } from '@/engine/simulation'
import { mirrorTunnelRanges, splitPathByTunnels } from '@/lib/tunnels'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export interface CesiumMapOptions {
  /** Offline mode: no Ion/Google requests (for tests/development without network). */
  offline?: boolean
  /** Fixed ground height in meters (skips all height sampling; debug). */
  fixedGroundHeight?: number
  onSelectTram?: (tramId: string | null) => void
  onTilesetStatus?: (status: TilesetStatus) => void
}

interface TramEntityRecord {
  /**
   * The vehicle body as a Primitive with a direct modelMatrix: position
   * updates take effect immediately. (Entity boxes rebuild their geometry
   * asynchronously on every position change – under continuous movement this
   * rebuild starves as soon as the render rate drops to tick level, and the
   * boxes visibly freeze.)
   */
  primitive: Primitive
  /** Reused modelMatrix of the primitive (updated in place). */
  matrix: Matrix4
  /** Entity for the number label (billboard path, updates without rebuild). */
  labelEntity: Entity
  labelPosition: ConstantPositionProperty
  baseColor: Color
  /**
   * Shared appearance of the body primitive. Tunnel transitions only toggle
   * its `translucent` flag – the primitive picks that up per frame
   * (isTranslucent()) and rebuilds just its render state, no new
   * appearance/shader per transition.
   */
  appearance: PerInstanceColorAppearance
  /** Vehicle is on a tunnel/underground route section (drawn at 40 %). */
  inTunnel: boolean
  /** Vehicle is the current selection (body brightened). */
  highlighted: boolean
  /**
   * Body color still needs to be (re)applied: geometry attributes are only
   * writable once the primitive has rendered, so a tunnel transition on a
   * not-yet-rendered vehicle is retried on the following ticks.
   */
  appearanceDirty: boolean
  /** Half the vehicle height in meters (box center above ground). */
  halfHeight: number
  /** Smoothed ground height (ellipsoidal) below the tram in meters. */
  groundHeight: number
  /** Frame counter of the last height query (sampling is staggered). */
  lastSampleFrame: number
}

/**
 * Ellipsoidal height of Rostock's streets while no tile height has been
 * measured yet (geoid undulation ~40 m + terrain height). Replaced by real
 * measurements at runtime.
 */
const FALLBACK_GROUND_HEIGHT = 45

/** Every how many frames the ground height is re-sampled per tram. */
const HEIGHT_SAMPLE_INTERVAL = 12

/** Base alpha of the route polylines. */
const ROUTE_ALPHA = 0.85

/**
 * Visibility of tunnel/underground sections: route pieces and vehicles on
 * them are rendered at 40 % of their normal opacity.
 */
const TUNNEL_VISIBILITY = 0.4

// Scratch objects for the per-tick hot path in syncTrams: Cesium clones all
// values it retains (ConstantProperty, modelMatrix), so reusing these avoids
// ~2 allocations per tram per tick.
const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll()

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

export class CesiumMap {
  readonly viewer: Viewer
  private readonly opts: CesiumMapOptions
  private trams = new Map<string, TramEntityRecord>()
  private routeEntities = new Map<string, Entity[]>()
  private stopEntities: Entity[] = []
  private stopRecords: { entity: Entity; lon: number; lat: number; resolved: boolean }[] = []
  private stopScanIndex = 0
  private handler: ScreenSpaceEventHandler
  private selectedId: string | null = null
  private destroyed = false
  private followId: string | null = null
  private followOffset: HeadingPitchRange | null = null
  private googleTileset: Cesium3DTileset | null = null
  /** Most recently measured plausible ground height – initial value for new trams. */
  private defaultGroundHeight: number
  private frameCounter = 0
  private frustumSphere = new BoundingSphere()
  /** Time of the last user interaction (mouse/touch/wheel) in ms. */
  private lastInteractionAt = 0
  /** A camera animation (flyTo) is running until this point in time. */
  private flyingUntil = 0
  private readonly noteInteraction = () => {
    this.lastInteractionAt = performance.now()
  }

  constructor(container: HTMLElement, opts: CesiumMapOptions = {}) {
    this.opts = opts
    // Offline (ellipsoid): ground is exactly at 0 m
    this.defaultGroundHeight =
      opts.fixedGroundHeight ?? (opts.offline ? 0 : FALLBACK_GROUND_HEIGHT)

    if (!opts.offline) {
      Ion.defaultAccessToken = config.cesiumIonToken
    }

    this.viewer = new Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      msaaSamples: 4,
      // The render loop is driven entirely by the app (see the App.tsx loop
      // + render()): Cesium's own 60 fps loop would update clock/visualizer/
      // scene every frame even without changes and put a constant load on
      // CPU/GPU.
      useDefaultRenderLoop: false,
    })

    // Debug/test access to the viewer (e.g. for E2E tests)
    ;(globalThis as { __cesiumViewer?: Viewer }).__cesiumViewer = this.viewer

    const scene = this.viewer.scene
    scene.globe.baseColor = Color.fromCssColorString('#0c1322')
    scene.backgroundColor = Color.fromCssColorString('#05080f')

    // The viewer's double-click zoom interferes with our own selection logic
    this.viewer.screenSpaceEventHandler.removeInputAction(
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    )

    if (opts.offline) {
      // Subtle grid instead of satellite imagery – computable fully offline
      scene.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          color: Color.fromCssColorString('#22304a').withAlpha(0.6),
          glowColor: Color.TRANSPARENT,
          backgroundColor: Color.fromCssColorString('#0c1322'),
          cells: 4,
        }),
      )
      opts.onTilesetStatus?.('offline')
    } else {
      opts.onTilesetStatus?.('loading')
      void this.loadGoogleTiles()
    }

    this.setCameraHome(false)

    // Interactions wake the render loop (the app then renders at full rate)
    const canvas = scene.canvas
    canvas.addEventListener('pointerdown', this.noteInteraction)
    canvas.addEventListener('wheel', this.noteInteraction, { passive: true })
    canvas.addEventListener('touchstart', this.noteInteraction, { passive: true })
    canvas.addEventListener('touchmove', this.noteInteraction, { passive: true })
    canvas.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.buttons !== 0) this.noteInteraction()
    })

    this.handler = new ScreenSpaceEventHandler(scene.canvas)
    this.handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = scene.pick(movement.position) as { id?: unknown } | undefined
      const pickedId = picked?.id
      // Vehicle-body primitives return the instance id as a string, the
      // number label an Entity – both carry the "tram:" prefix.
      let tramId: string | null = null
      if (pickedId instanceof Entity && pickedId.id.startsWith('tram:')) {
        tramId = pickedId.id.slice('tram:'.length)
      } else if (typeof pickedId === 'string' && pickedId.startsWith('tram:')) {
        tramId = pickedId.slice('tram:'.length)
      }
      this.opts.onSelectTram?.(tramId)
    }, ScreenSpaceEventType.LEFT_CLICK)
  }

  private async loadGoogleTiles(): Promise<void> {
    try {
      const tileset = await createGooglePhotorealistic3DTileset()
      if (this.destroyed) return
      // enableCollision: prevents the camera from getting below the tiles
      tileset.enableCollision = true
      this.googleTileset = tileset
      this.viewer.scene.primitives.add(tileset)
      // The globe would render twice underneath the photorealistic tiles
      this.viewer.scene.globe.show = false
      this.opts.onTilesetStatus?.('google-3d-tiles')
      window.setTimeout(() => void this.bootstrapGroundHeights(), 2000)
    } catch (error) {
      console.error('Failed to load Google Photorealistic 3D Tiles:', error)
      if (this.destroyed) return
      // Fallback: dark globe with grid so the simulation stays usable
      this.viewer.scene.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          color: Color.fromCssColorString('#22304a').withAlpha(0.6),
          glowColor: Color.TRANSPARENT,
          backgroundColor: Color.fromCssColorString('#0c1322'),
          cells: 4,
        }),
      )
      this.opts.onTilesetStatus?.('failed')
    }
  }

  private homeView: {
    longitude: number
    latitude: number
    height: number
    heading: number
    pitch: number
  } = config.home

  /** Sets the home view (e.g. from the network bounding box) and jumps to it. */
  setHomeView(view: typeof this.homeView): void {
    this.homeView = view
    this.setCameraHome(false)
  }

  setCameraHome(animate = true): void {
    const { longitude, latitude, height, heading, pitch } = this.homeView
    const destination = Cartesian3.fromDegrees(longitude, latitude, height)
    const orientation = {
      heading: CesiumMath.toRadians(heading),
      pitch: CesiumMath.toRadians(pitch),
      roll: 0,
    }
    if (animate) {
      // Render at full rate during the camera flight
      this.flyingUntil = performance.now() + 2600
      this.viewer.camera.flyTo({ destination, orientation, duration: 2 })
    } else {
      this.viewer.camera.setView({ destination, orientation })
    }
  }

  /**
   * Draws the route polylines of all lines (draped onto ground/3D tiles).
   * Tunnel/underground sections become their own polyline pieces at 40 %
   * of the normal opacity.
   */
  addRoutes(network: PreparedNetwork): void {
    network.lines.forEach((line, index) => {
      const color = Color.fromCssColorString(line.color)
      const entities: Entity[] = []

      const dirs = [line.directions[0]]
      // Only draw the second direction if it has its own geometry or its
      // own tunnel layout (with mirrored directions both are identical)
      const d1 = line.directions[1]
      const d0 = line.directions[0]
      if (!directionsAreMirrored(d0, d1)) dirs.push(d1)

      for (const dir of dirs) {
        const pieces = splitPathByTunnels(dir.path, dir.cum, dir.tunnels)
        pieces.forEach((piece, pieceIndex) => {
          const alpha = piece.tunnel ? ROUTE_ALPHA * TUNNEL_VISIBILITY : ROUTE_ALPHA
          entities.push(
            this.viewer.entities.add({
              id: `route:${line.id}:${dir.direction}:${pieceIndex}`,
              polyline: {
                positions: Cartesian3.fromDegreesArray(piece.path.flat()),
                width: 5,
                clampToGround: true,
                material: new ColorMaterialProperty(color.withAlpha(alpha)),
                classificationType: ClassificationType.BOTH,
                zIndex: 10 + index,
              },
            }),
          )
        })
      }
      this.routeEntities.set(line.id, entities)
    })
  }

  /**
   * Draws all stops (deduplicated across lines).
   * Heights are – as with the trams – set explicitly and adjusted as soon
   * as the 3D tiles are loaded at the respective location.
   */
  addStops(network: PreparedNetwork): void {
    const seen = new Set<string>()
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          if (seen.has(stop.id)) continue
          seen.add(stop.id)
          const [lon, lat] = stop.coord
          const entity = this.viewer.entities.add({
            id: `stop:${stop.id}`,
            position: Cartesian3.fromDegrees(lon, lat, this.defaultGroundHeight + 0.5),
            point: {
              pixelSize: 7,
              color: Color.fromCssColorString('#f8fafc'),
              outlineColor: Color.fromCssColorString('#334155'),
              outlineWidth: 2,
              distanceDisplayCondition: new DistanceDisplayCondition(0, 9000),
              disableDepthTestDistance: 3000,
            },
            label: {
              text: stop.name,
              font: '13px "Inter Variable", system-ui, sans-serif',
              fillColor: Color.fromCssColorString('#e2e8f0'),
              outlineColor: Color.fromCssColorString('#0f172a'),
              outlineWidth: 3,
              style: LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cartesian2(0, -16),
              distanceDisplayCondition: new DistanceDisplayCondition(0, 2600),
              disableDepthTestDistance: 3000,
            },
          })
          this.stopEntities.push(entity)
          this.stopRecords.push({ entity, lon, lat, resolved: false })
        }
      }
    }
  }

  /** Resolves the stop heights bit by bit (a few per pass). */
  private resolveStopHeights(): void {
    if (!this.googleTileset || this.stopRecords.length === 0) return
    // Throttled: only every 15th simulation tick queries heights
    if (this.frameCounter % 15 !== 0) return
    if (this.stopRecords.every((s) => s.resolved)) return
    let budget = 4
    for (let i = 0; i < this.stopRecords.length && budget > 0; i++) {
      this.stopScanIndex = (this.stopScanIndex + 1) % this.stopRecords.length
      const stop = this.stopRecords[this.stopScanIndex]
      if (stop.resolved) continue
      budget--
      const height = this.sampleGroundHeight(stop.lon, stop.lat)
      if (height !== undefined) {
        stop.resolved = true
        stop.entity.position = new ConstantPositionProperty(
          Cartesian3.fromDegrees(stop.lon, stop.lat, height + 0.5),
        )
      }
    }
  }

  setRoutesVisible(visible: boolean): void {
    for (const entities of this.routeEntities.values()) {
      for (const e of entities) e.show = visible
    }
  }

  setStopsVisible(visible: boolean): void {
    for (const e of this.stopEntities) e.show = visible
  }

  setLineRouteVisible(lineId: string, visible: boolean): void {
    for (const e of this.routeEntities.get(lineId) ?? []) e.show = visible
  }

  /**
   * One-time height bootstrapping: measures the tile heights at all stops
   * asynchronously (specifically loading detail tiles to do so) and derives
   * the base ground height for trams and stops from them. Logs the result
   * to the console for diagnostics.
   */
  private async bootstrapGroundHeights(): Promise<void> {
    if (this.destroyed || this.opts.fixedGroundHeight !== undefined) return
    if (this.stopRecords.length === 0) {
      window.setTimeout(() => void this.bootstrapGroundHeights(), 2000)
      return
    }
    const scene = this.viewer.scene
    if (!scene.sampleHeightSupported) {
      console.warn('[MiniRostock3D] sampleHeight is not supported by this GPU/WebGL environment')
      return
    }

    const sampledStops = this.stopRecords.filter((_, i) => i % 2 === 0)
    const positions = sampledStops.map((s) => Cartographic.fromDegrees(s.lon, s.lat))
    try {
      const updated = await scene.sampleHeightMostDetailed(positions)
      if (this.destroyed) return
      const heights: number[] = []
      updated.forEach((carto, i) => {
        const h = carto?.height
        if (h !== undefined && Number.isFinite(h) && h > -100 && h < 500) {
          heights.push(h)
          const stop = sampledStops[i]
          stop.resolved = true
          stop.entity.position = new ConstantPositionProperty(
            Cartesian3.fromDegrees(stop.lon, stop.lat, h + 0.5),
          )
        }
      })
      if (heights.length === 0) {
        console.warn(
          '[MiniRostock3D] Height bootstrap: no valid tile heights determined – ' +
            'trams will use the fallback height. Please report this message ' +
            'along with window.__mrt.groundHeights().',
        )
        return
      }
      heights.sort((a, b) => a - b)
      const median = heights[Math.floor(heights.length / 2)]
      this.defaultGroundHeight = median
      // Raise the base for all trams already running (the ongoing per-tram
      // sampling does the fine-tuning afterwards)
      for (const record of this.trams.values()) {
        record.groundHeight = median
      }
      console.info(
        `[MiniRostock3D] Tile heights determined (ellipsoidal): ` +
          `min ${heights[0].toFixed(1)} m · median ${median.toFixed(1)} m · ` +
          `max ${heights[heights.length - 1].toFixed(1)} m (${heights.length} sample points)`,
      )
      this.render()
    } catch (error) {
      console.warn('[MiniRostock3D] Height bootstrap failed:', error)
    }
  }

  /**
   * Ellipsoidal ground height at a position, measured on the loaded Google
   * 3D tiles. undefined if no tile is loaded there (yet).
   */
  private sampleGroundHeight(lon: number, lat: number): number | undefined {
    if (!this.googleTileset) return undefined
    try {
      const height = this.googleTileset.getHeight(
        Cartographic.fromDegrees(lon, lat),
        this.viewer.scene,
      )
      // Plausibility window for Rostock (ellipsoidal approx. 30–120 m)
      if (height !== undefined && Number.isFinite(height) && height > -100 && height < 500) {
        return height
      }
    } catch {
      // Tile content not queryable – keep using the fallback height
    }
    return undefined
  }

  /**
   * Reconciles the tram entities with the current snapshots.
   * Called every frame: updates positions in place, creates new entities,
   * and removes finished trips.
   *
   * The trams' height is set EXPLICITLY (tile height + half the vehicle
   * height) instead of via HeightReference clamping – clamping entity
   * geometries onto 3D tiles is unreliable in practice, which left the
   * boxes sitting below the photorealistic surface.
   */
  syncTrams(
    snapshots: TramSnapshot[],
    visibleLines: ReadonlySet<string>,
  ): { anyTramInView: boolean } {
    this.frameCounter++
    this.resolveStopHeights()
    const alive = new Set<string>()

    // Visibility test: is at least one tram inside the camera frustum?
    // (Controls whether a re-render is needed at all.)
    const camera = this.viewer.camera
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    )
    let anyTramInView = false

    for (const snap of snapshots) {
      alive.add(snap.id)
      let record = this.trams.get(snap.id)
      if (!record) {
        record = this.createTramEntity(snap)
        this.trams.set(snap.id, record)
      }

      // Entering/leaving a tunnel section toggles the 40 % ghost rendering.
      if (snap.inTunnel !== record.inTunnel) {
        record.inTunnel = snap.inTunnel
        record.appearanceDirty = true
      }
      if (record.appearanceDirty) {
        record.appearanceDirty = !this.applyTramAppearance(snap.id)
      }

      const show = visibleLines.has(snap.lineId)
      let position = Cartesian3.fromDegrees(
        snap.lon,
        snap.lat,
        record.groundHeight + record.halfHeight + 0.3,
        undefined,
        positionScratch,
      )

      // Frustum test per shown tram (6 plane checks – cheap). The result
      // drives both the render pacing (anyTramInView) and whether the much
      // more expensive tile-height sampling below is worth doing at all.
      let inView = false
      if (show) {
        Cartesian3.clone(position, this.frustumSphere.center)
        this.frustumSphere.radius = 80
        inView = cullingVolume.computeVisibility(this.frustumSphere) !== Intersect.OUTSIDE
        if (inView) anyTramInView = true
      }

      // Update the ground height in a staggered fashion (not every tram in
      // every frame) and only where it is visible: tileset.getHeight does a
      // ray intersection against the loaded tiles and dominates the tick cost.
      const followed = snap.id === this.followId
      if (
        this.opts.fixedGroundHeight === undefined &&
        (inView || followed) &&
        this.frameCounter - record.lastSampleFrame >= HEIGHT_SAMPLE_INTERVAL
      ) {
        // A large gap means the tram was off-screen and unsampled: snap to
        // the measured height right at the screen edge instead of visibly
        // gliding to it in mid-view.
        const snapToHeight =
          this.frameCounter - record.lastSampleFrame >= HEIGHT_SAMPLE_INTERVAL * 4
        record.lastSampleFrame = this.frameCounter
        const sampled = this.sampleGroundHeight(snap.lon, snap.lat)
        if (sampled !== undefined) {
          // Smooth so the tram follows inclines gently
          record.groundHeight += (sampled - record.groundHeight) * (snapToHeight ? 1 : 0.35)
          position = Cartesian3.fromDegrees(
            snap.lon,
            snap.lat,
            record.groundHeight + record.halfHeight + 0.3,
            undefined,
            positionScratch,
          )
        }
      }

      record.labelPosition.setValue(position)
      // Update modelMatrix in place – takes effect immediately on the next render
      hprScratch.heading = CesiumMath.toRadians(snap.bearing - 90)
      Transforms.headingPitchRollToFixedFrame(
        position,
        hprScratch,
        undefined,
        undefined,
        record.matrix,
      )
      record.primitive.show = show
      record.labelEntity.show = show

      if (followed) {
        this.updateFollowCamera(snap.lon, snap.lat)
      }
    }

    for (const [id, record] of this.trams) {
      if (!alive.has(id)) {
        if (id === this.followId) this.setFollow(null)
        this.viewer.entities.remove(record.labelEntity)
        this.viewer.scene.primitives.remove(record.primitive)
        this.trams.delete(id)
      }
    }

    return { anyTramInView }
  }

  /** Renders exactly one frame (the app controls the frequency). */
  render(): void {
    if (this.destroyed) return
    this.viewer.render()
  }

  /**
   * Hints for the app's render pacing:
   * - interacting: user is currently moving the camera (or inertia/flight)
   * - tilesLoading: tiles are still being loaded
   */
  getRenderHints(): { interacting: boolean; tilesLoading: boolean } {
    const now = performance.now()
    const interacting = now - this.lastInteractionAt < 2500 || now < this.flyingUntil
    const scene = this.viewer.scene
    const tilesLoading =
      (this.googleTileset !== null && !this.googleTileset.tilesLoaded) ||
      (scene.globe.show && !scene.globe.tilesLoaded)
    return { interacting, tilesLoading }
  }

  /** Current camera orientation (for URL persistence). */
  getCameraView(): {
    longitude: number
    latitude: number
    height: number
    heading: number
    pitch: number
  } {
    const camera = this.viewer.camera
    const carto = camera.positionCartographic
    return {
      longitude: CesiumMath.toDegrees(carto.longitude),
      latitude: CesiumMath.toDegrees(carto.latitude),
      height: carto.height,
      heading: CesiumMath.toDegrees(camera.heading),
      pitch: CesiumMath.toDegrees(camera.pitch),
    }
  }

  /** Set the camera directly to a view (e.g. restored from the URL). */
  setView(view: {
    longitude: number
    latitude: number
    height: number
    heading: number
    pitch: number
  }): void {
    this.viewer.camera.setView({
      destination: Cartesian3.fromDegrees(view.longitude, view.latitude, view.height),
      orientation: {
        heading: CesiumMath.toRadians(view.heading),
        pitch: CesiumMath.toRadians(view.pitch),
        roll: 0,
      },
    })
  }

  private createTramEntity(snap: TramSnapshot): TramEntityRecord {
    const color = Color.fromCssColorString(snap.color)
    const halfHeight = snap.vehicle.height / 2
    // Vehicles on a tunnel section start as 40 % ghosts right away.
    const alpha = snap.inTunnel ? TUNNEL_VISIBILITY : 1
    const initialPosition = Cartesian3.fromDegrees(
      snap.lon,
      snap.lat,
      this.defaultGroundHeight + halfHeight + 0.3,
    )

    const matrix = Transforms.headingPitchRollToFixedFrame(
      initialPosition,
      new HeadingPitchRoll(CesiumMath.toRadians(snap.bearing - 90), 0, 0),
    )
    // The base render state stays opaque; only the mutable `translucent`
    // flag switches blending on/off. (A base state built as translucent
    // would keep its blending even after toggling the flag back off.)
    const appearance = new PerInstanceColorAppearance({ closed: true, translucent: false })
    appearance.translucent = snap.inTunnel
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: BoxGeometry.fromDimensions({
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          // Vehicle dimensions per line: tram/bus/ferry differ noticeably
          dimensions: new Cartesian3(
            snap.vehicle.length,
            snap.vehicle.width,
            snap.vehicle.height,
          ),
        }),
        attributes: {
          color: ColorGeometryInstanceAttribute.fromColor(color.withAlpha(alpha)),
        },
        id: `tram:${snap.id}`,
      }),
      appearance,
      asynchronous: false,
      modelMatrix: matrix,
    })
    this.viewer.scene.primitives.add(primitive)
    // IMPORTANT: Primitive CLONES the modelMatrix passed in – for the
    // in-place updates in syncTrams, the primitive's own instance must be
    // referenced, otherwise the vehicle bodies never move.
    const liveMatrix = primitive.modelMatrix

    const labelPosition = new ConstantPositionProperty(initialPosition)
    const labelEntity = this.viewer.entities.add({
      id: `tram:${snap.id}`,
      position: labelPosition,
      label: {
        text: snap.lineId,
        font: 'bold 14px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.WHITE.withAlpha(alpha),
        outlineColor: color.withAlpha(alpha),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -28),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 12000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    return {
      primitive,
      matrix: liveMatrix,
      labelEntity,
      labelPosition,
      baseColor: color,
      appearance,
      inTunnel: snap.inTunnel,
      highlighted: false,
      appearanceDirty: false,
      halfHeight,
      groundHeight: this.defaultGroundHeight,
      lastSampleFrame: -HEIGHT_SAMPLE_INTERVAL, // sample immediately on the first frame
    }
  }

  /**
   * Applies the current visual state of a vehicle: selection highlight
   * (body brightened) combined with tunnel ghosting (body and label at
   * 40 % opacity while on an underground section). Returns false while the
   * primitive has not rendered yet and the body color could not be written.
   */
  private applyTramAppearance(tramId: string): boolean {
    const record = this.trams.get(tramId)
    if (!record) return true
    record.appearance.translucent = record.inTunnel
    const alpha = record.inTunnel ? TUNNEL_VISIBILITY : 1
    const label = record.labelEntity.label
    if (label) {
      label.fillColor = new ConstantProperty(Color.WHITE.withAlpha(alpha))
      label.outlineColor = new ConstantProperty(record.baseColor.withAlpha(alpha))
    }
    try {
      const attributes = record.primitive.getGeometryInstanceAttributes(`tram:${tramId}`)
      if (!attributes) return false
      const color = record.highlighted
        ? Color.lerp(record.baseColor, Color.WHITE, 0.45, new Color())
        : record.baseColor
      attributes.color = ColorGeometryInstanceAttribute.toValue(
        color.withAlpha(alpha),
        attributes.color,
      )
      return true
    } catch {
      // Primitive not rendered yet – retried via appearanceDirty
      return false
    }
  }

  setSelected(tramId: string | null): void {
    if (this.selectedId) {
      const record = this.trams.get(this.selectedId)
      if (record) {
        record.highlighted = false
        // Not-yet-rendered primitives are retried via appearanceDirty in
        // syncTrams – same as tunnel transitions.
        record.appearanceDirty = !this.applyTramAppearance(this.selectedId)
      }
    }
    this.selectedId = tramId
    if (tramId) {
      const record = this.trams.get(tramId)
      if (record) {
        record.highlighted = true
        record.appearanceDirty = !this.applyTramAppearance(tramId)
      }
    }
  }

  /**
   * Attach the camera to a tram (null = detach).
   *
   * Deliberately NOT implemented via viewer.trackedEntity: Cesium aborts
   * tracking as soon as the bounding sphere of an entity with
   * HeightReference cannot be computed. Instead, updateFollowCamera()
   * repositions the camera each frame via camera.lookAt – mouse orbit and
   * zoom remain possible.
   */
  setFollow(tramId: string | null): void {
    this.followId = tramId
    this.followOffset = null
    if (!tramId) {
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
    }
  }

  private updateFollowCamera(lon: number, lat: number): void {
    const camera = this.viewer.camera

    // Camera center at the height of the followed tram (its ground height
    // is already sampled on the 3D tiles and smoothed in syncTrams).
    const record = this.followId ? this.trams.get(this.followId) : undefined
    const groundHeight = record?.groundHeight ?? this.defaultGroundHeight
    const vehicleHeight = (record?.halfHeight ?? config.vehicles.tram.height / 2) * 2

    const center = Cartesian3.fromDegrees(lon, lat, groundHeight + vehicleHeight + 2)

    if (!this.followOffset) {
      // First frame: swing in behind/above the tram
      this.followOffset = new HeadingPitchRange(
        camera.heading,
        CesiumMath.toRadians(-32),
        450,
      )
    } else {
      // Adopt user orbit/zoom: in the lookAt reference frame heading/pitch
      // are relative and the tram sits at the origin.
      this.followOffset.heading = camera.heading
      this.followOffset.pitch = camera.pitch
      this.followOffset.range = Cartesian3.magnitude(camera.position)
    }
    camera.lookAt(center, this.followOffset)
  }

  hasTram(tramId: string): boolean {
    return this.trams.has(tramId)
  }

  /**
   * Debug/tests: maximum distance between vehicle body (primitive matrix)
   * and number label across all trams in meters. Must be ~0 – a larger
   * value means the vehicle bodies no longer follow the simulation.
   */
  getTramBoxDriftMeters(): number {
    let maxDrift = 0
    for (const record of this.trams.values()) {
      const labelPos = record.labelPosition.getValue(this.viewer.clock.currentTime)
      if (!labelPos) continue
      const dx = record.primitive.modelMatrix[12] - labelPos.x
      const dy = record.primitive.modelMatrix[13] - labelPos.y
      const dz = record.primitive.modelMatrix[14] - labelPos.z
      const drift = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (drift > maxDrift) maxDrift = drift
    }
    return maxDrift
  }

  /** Debug: current ground heights of the trams (for diagnosing tile heights). */
  getGroundHeights(): { id: string; groundHeight: number }[] {
    return [...this.trams.entries()].map(([id, record]) => ({
      id,
      groundHeight: Math.round(record.groundHeight * 10) / 10,
    }))
  }

  destroy(): void {
    this.destroyed = true
    this.handler.destroy()
    this.viewer.destroy()
  }
}
