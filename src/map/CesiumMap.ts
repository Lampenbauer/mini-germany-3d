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
  Credit,
  CustomShader,
  DistanceDisplayCondition,
  Entity,
  GeometryInstance,
  GridImageryProvider,
  HeadingPitchRange,
  HeadingPitchRoll,
  Intersect,
  Ion,
  JulianDate,
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
import type { LonLat } from '@/lib/geo'
import type { PreparedDirection, PreparedNetwork } from '@/data/network-types'
import type { TramSnapshot } from '@/engine/simulation'
import { mirrorTunnelRanges, splitPathByTunnels } from '@/lib/tunnels'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export interface CesiumMapOptions {
  /** Offline mode: no Ion/Google requests (for tests/development without network). */
  offline?: boolean
  /** Fixed ground height in meters (skips all height sampling; debug). */
  fixedGroundHeight?: number
  /**
   * Tile LOD budget override in drawing-buffer pixels (?sse=…): replaces
   * the default budget including its pixel-ratio scaling. Lower = finer
   * tiles everywhere at a steep data/memory cost (~4× per halving).
   */
  maximumScreenSpaceError?: number
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
  /** Position of the last tick – detects movement for render requests. */
  lastPosition: Cartesian3
}

interface StopEntityRecord {
  entity: Entity
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
 * Ellipsoidal height of Rostock's streets while no tile height has been
 * measured yet (geoid undulation ~40 m + terrain height). Replaced by real
 * measurements at runtime.
 */
const FALLBACK_GROUND_HEIGHT = 45

/**
 * Every how many frames the ground height is re-sampled per tram – only
 * for vehicles WITHOUT route terrain heights (approximated dataset); with
 * heights present the height comes from the route profile instead.
 */
const HEIGHT_SAMPLE_INTERVAL = 12

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

/**
 * Number of stops per sampleHeightMostDetailed() call during bootstrapping.
 * Chunking lets the stops settle onto the surface progressively instead of
 * all at once after the full run.
 */
const STOP_HEIGHT_CHUNK = 100

/**
 * How many stops the height bootstrap measures – a small, evenly spread
 * subset. Sampling every stop made sampleHeightMostDetailed() load
 * finest-LOD tiles for the entire city, which kept the tileset (and the
 * GPU) busy for minutes after startup; for the ground-height median a few
 * dozen points are just as good, and individual stops are refined on
 * demand by resolveStopHeights() once the camera gets near them.
 */
const STOP_BOOTSTRAP_SAMPLES = 40

/**
 * Camera distance in meters up to which a vehicle counts as visible: the
 * number label fades out here (see the label's DistanceDisplayCondition),
 * and beyond it the body is only a few pixels. Vehicles farther away must
 * neither hold the 30 fps render pacing nor get tile-height samples –
 * without this cap a camera dozens of kilometers away still "sees" the
 * whole fleet as soon as it faces the network.
 */
const TRAM_VISIBLE_RANGE = 20_000

/**
 * Camera distance in meters up to which the vehicle BODY (the 3D box) is
 * drawn. Beyond this the box is sub-pixel noise while the number label
 * still reads fine, so only the label stays up to TRAM_VISIBLE_RANGE.
 */
const TRAM_BODY_VISIBLE_RANGE = 3_000

/**
 * Time-of-day grading for the photorealistic tiles. The tiles are unlit
 * (KHR_materials_unlit – daylight is baked into the photo textures), so the
 * scene's sun cannot shade them; instead the baked color is blended toward
 * golden-hour and night tints as the sun goes down. The sun direction comes
 * from Cesium's built-in czm_sunDirectionWC, which follows viewer.clock –
 * setSceneTime() couples that clock to the simulated time.
 *
 * Night keeps a blue ambient and only mild desaturation so the city stays
 * readable: real night light (lit windows, street lamps) cannot be derived
 * from daylight photogrammetry, this is an ambience grade.
 */
const TIME_OF_DAY_SHADER = `
void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
{
  // sin of the sun elevation at this fragment (up = away from Earth center)
  float sunUp = dot(czm_sunDirectionWC, normalize(fsInput.attributes.positionWC));

  vec3 goldenTint = vec3(1.0, 0.84, 0.66);
  vec3 duskTint = vec3(0.40, 0.35, 0.37);
  vec3 nightTint = vec3(0.14, 0.17, 0.28);

  // Blend regions by sun height: full day above +8 deg, golden hour down
  // to sunset, dusk while the sun sinks to -5 deg, night below about
  // -10 deg (matches how dark a real nautical dusk already feels).
  float golden = 1.0 - smoothstep(0.0, 0.14, sunUp);
  float dusk = 1.0 - smoothstep(-0.09, 0.0, sunUp);
  float night = 1.0 - smoothstep(-0.17, -0.07, sunUp);

  vec3 tint = mix(vec3(1.0), goldenTint, golden);
  tint = mix(tint, duskTint, dusk);
  tint = mix(tint, nightTint, night);

  float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
  vec3 color = mix(material.diffuse, vec3(luminance), 0.45 * night);
  material.diffuse = color * tint;
}
`

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
const ROUTE_HEIGHT_OFFSET_FALLBACK = 36.5

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
const FERRY_ROUTE_EXTRA_LIFT = 0.75

/** Camera pitch of the "zoom to line" flight in degrees (heading is kept). */
const LINE_FOCUS_PITCH = -55

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

// Scratch for the per-pass selection of the stops nearest to the camera,
// kept as an ascending top-N list (see resolveStopHeights).
const nearestStops: (StopEntityRecord | null)[] = new Array(STOP_HEIGHT_BUDGET).fill(null)
const nearestDistances = new Float64Array(STOP_HEIGHT_BUDGET)

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
  private stopEntities: Entity[] = []
  private stopRecords: StopEntityRecord[] = []
  private handler: ScreenSpaceEventHandler
  private selectedId: string | null = null
  private destroyed = false
  private followId: string | null = null
  private followOffset: HeadingPitchRange | null = null
  private googleTileset: Cesium3DTileset | null = null
  /** Most recently measured plausible ground height – initial value for new trams. */
  private defaultGroundHeight: number
  /** Drawing-buffer pixels per CSS pixel (HiDPI rendering, capped at 2). */
  private readonly effectivePixelRatio: number
  private frameCounter = 0
  /** Timestamp of the last stop height sampling pass (see resolveStopHeights). */
  private lastStopSampleAt = 0
  private frustumSphere = new BoundingSphere()
  /** Time of the last user interaction (mouse/touch/wheel) in ms. */
  private lastInteractionAt = 0
  /** A camera animation (flyTo) is running until this point in time. */
  private flyingUntil = 0
  /**
   * A one-off scene change (selection, visibility toggle, stop height,
   * resize, …) needs a frame. Consumed by the app's render loop – outside
   * the interaction/animation/tile-loading states the app only renders on
   * this flag plus a slow heartbeat, so an idle map costs no GPU at all.
   */
  private renderRequested = true
  private resizeObserver: ResizeObserver | null = null
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
      // Render at native device resolution: Cesium's default is CSS-pixel
      // resolution, which leaves labels and edges visibly pixelated on
      // Retina/HiDPI displays.
      useBrowserRecommendedResolution: false,
      // The render loop is driven entirely by the app (see the App.tsx loop
      // + render()): Cesium's own 60 fps loop would update clock/visualizer/
      // scene every frame even without changes and put a constant load on
      // CPU/GPU.
      useDefaultRenderLoop: false,
    })

    // Cap the effective pixel ratio at 2×: beyond that the extra sharpness
    // is invisible but the fill-rate cost keeps growing quadratically.
    const pixelRatio = window.devicePixelRatio || 1
    this.effectivePixelRatio = Math.min(pixelRatio, 2)
    this.viewer.resolutionScale = this.effectivePixelRatio / pixelRatio

    // Debug/test access to the viewer (e.g. for E2E tests)
    ;(globalThis as { __cesiumViewer?: Viewer }).__cesiumViewer = this.viewer

    const scene = this.viewer.scene
    scene.globe.baseColor = Color.fromCssColorString('#0c1322')
    scene.backgroundColor = Color.fromCssColorString('#05080f')

    // Day/night sky: with a globe present (ours is merely hidden), the sky
    // atmosphere takes its dynamic lighting from these globe flags and
    // ignores scene.atmosphere (see Scene.updateEnvironment). Without them
    // the sky stays noon-blue around the clock; with them it darkens with
    // the sun and the star skybox shows through at night.
    scene.globe.enableLighting = true
    scene.globe.dynamicAtmosphereLighting = true
    scene.globe.dynamicAtmosphereLightingFromSun = true

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

    // A container/window resize must reach the screen even in the idle
    // render state (viewer.render() picks the new size up via resize()).
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.requestRender())
      this.resizeObserver.observe(container)
    }

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
      // Tile LOD budget. Screen-space error is measured in drawing-buffer
      // pixels, so the budget scales with the pixel ratio to stay a
      // constant CSS-pixel tolerance across displays. Cesium's default
      // (16 CSS px equivalent) left mid-distance buildings visibly mushy
      // at tilted views – tuned via the ?sse= override to 6 CSS px, the
      // value where the middle distance reads as sharp. A tilted city
      // view then needs roughly 1.1 GB of tile memory, still inside the
      // cache budget below.
      const TILE_SSE_CSS_PX = 6
      tileset.maximumScreenSpaceError =
        this.opts.maximumScreenSpaceError ?? TILE_SSE_CSS_PX * this.effectivePixelRatio
      // Cesium's dynamic SSE (on by default) additionally relaxes the error
      // budget for tiles far from a tilted camera by up to
      // dynamicScreenSpaceErrorFactor pixels – and because the "street
      // level" reference height comes from the global tileset's enormous
      // bounding volume, the full effect applies even kilometers above the
      // city, leaving the horizon visibly mushy. A factor of 6 instead of
      // 24 keeps some horizon savings without the smeared backdrop;
      // 0 would disable the optimization entirely.
      tileset.dynamicScreenSpaceErrorFactor = 6
      // Tile memory budget. With the default 512 MB cache (+512 MB
      // overflow) a tilted city view exceeds the limit, and Cesium then
      // raises the EFFECTIVE screen-space error by 2 % per frame
      // (memoryAdjustedScreenSpaceError) until the view fits – silently
      // overriding every SSE setting above and leaving distant tiles far
      // coarser than configured, no matter how the knobs are tuned. Give
      // the photorealistic tileset a budget that matches its appetite,
      // scaled down for low-memory devices (navigator.deviceMemory is in
      // GB and Chrome-only, capped at 8; elsewhere assume mid-range).
      const deviceMemoryGb = (navigator as { deviceMemory?: number }).deviceMemory ?? 4
      tileset.cacheBytes = (deviceMemoryGb >= 8 ? 2048 : 1024) * 1024 * 1024
      tileset.maximumCacheOverflowBytes = 1024 * 1024 * 1024
      // Day/night ambience following the simulated time (see setSceneTime)
      tileset.customShader = new CustomShader({ fragmentShaderText: TIME_OF_DAY_SHADER })
      this.googleTileset = tileset
      this.viewer.scene.primitives.add(tileset)
      // The globe would render twice underneath the photorealistic tiles
      this.viewer.scene.globe.show = false
      this.requestRender()
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
      this.requestRender()
      this.opts.onTilesetStatus?.('failed')
    }
  }

  setCameraHome(animate = true): void {
    const { longitude, latitude, height, heading, pitch } = config.home
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
    this.requestRender()
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
  addRoutes(network: PreparedNetwork): void {
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
        const heights = this.opts.offline ? undefined : dir.heights
        const pieces = splitPathByTunnels(dir.path, dir.cum, dir.tunnels, heights)
        pieces.forEach((piece, pieceIndex) => {
          const alpha = piece.tunnel ? ROUTE_ALPHA * TUNNEL_VISIBILITY : ROUTE_ALPHA
          const material = new ColorMaterialProperty(color.withAlpha(alpha))
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
    this.requestRender()
  }

  /**
   * Flies the camera so the entire route of a line is in view. The current
   * compass heading is kept – only position, height, and pitch change; the
   * distance is computed by Cesium from the route's bounding sphere.
   */
  focusLine(lineId: string): void {
    const flat = this.linePaths.get(lineId)
    if (!flat || flat.length < 4) return
    const sphere = BoundingSphere.fromPoints(Cartesian3.fromDegreesArray(flat))
    // The route coordinates carry no heights (ellipsoid 0 m) – lift the
    // sphere center onto the measured ground so the camera aims at the
    // streets instead of a point ~45 m below them.
    const center = Cartographic.fromCartesian(sphere.center)
    sphere.center = Cartesian3.fromRadians(
      center.longitude,
      center.latitude,
      this.defaultGroundHeight,
      undefined,
      sphere.center,
    )
    // Render at full rate during the flight (see getRenderHints)
    this.flyingUntil = performance.now() + 2100
    this.requestRender()
    this.viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.5,
      // range 0 = Cesium picks the distance at which the sphere fits fully
      offset: new HeadingPitchRange(
        this.viewer.camera.heading,
        CesiumMath.toRadians(LINE_FOCUS_PITCH),
        0,
      ),
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
          this.stopRecords.push({
            entity,
            lon,
            lat,
            position: Cartesian3.fromDegrees(lon, lat, this.defaultGroundHeight),
            sampledFrom: Number.POSITIVE_INFINITY,
            retryAfter: 0,
            nhn: stop.nhn,
          })
        }
      }
    }
    this.requestRender()
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
  private resolveStopHeights(): void {
    if (!this.googleTileset || this.stopRecords.length === 0) return
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
      const height = this.sampleGroundHeight(stop.lon, stop.lat)
      if (height === undefined) {
        // No tile queryable there (yet) – keep the current height and let
        // other stops have the budget for a while.
        stop.retryAfter = now + STOP_RETRY_MS
        continue
      }
      stop.sampledFrom = nearestDistances[i]
      stop.entity.position = new ConstantPositionProperty(
        Cartesian3.fromDegrees(stop.lon, stop.lat, height + 0.5),
      )
      this.requestRender()
    }
  }

  setRoutesVisible(visible: boolean): void {
    for (const entities of this.routeEntities.values()) {
      for (const e of entities) e.show = visible
    }
    this.requestRender()
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
    this.requestRender()
  }

  setStopsVisible(visible: boolean): void {
    for (const e of this.stopEntities) e.show = visible
    this.requestRender()
  }

  setLineRouteVisible(lineId: string, visible: boolean): void {
    for (const e of this.routeEntities.get(lineId) ?? []) e.show = visible
    this.requestRender()
  }

  /**
   * One-time height bootstrapping: measures the tile heights at a small,
   * evenly spread subset of the stops (STOP_BOOTSTRAP_SAMPLES) and derives
   * the base ground height for trams and stops from them. Logs the result
   * to the console for diagnostics.
   *
   * Unlike tileset.getHeight(), sampleHeightMostDetailed() loads the finest
   * tile level per point regardless of where the camera is looking, so its
   * heights are final and settle the sampled stops for good. Deliberately
   * NOT run for every stop: that loaded detail tiles for the whole city and
   * kept the tileset (and the GPU) busy for minutes after startup. The
   * remaining stops are refined on demand by resolveStopHeights() as soon
   * as the camera gets near them.
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

    const stride = Math.max(1, Math.ceil(this.stopRecords.length / STOP_BOOTSTRAP_SAMPLES))
    const sampleStops = this.stopRecords.filter((_, index) => index % stride === 0)

    const heights: number[] = []
    // Differences between sampled tile height and the stop's DGM height –
    // their median is the real NHN→ellipsoid offset for the route lines.
    const nhnOffsets: number[] = []
    try {
      for (let start = 0; start < sampleStops.length; start += STOP_HEIGHT_CHUNK) {
        const chunk = sampleStops.slice(start, start + STOP_HEIGHT_CHUNK)
        const updated = await scene.sampleHeightMostDetailed(
          chunk.map((s) => Cartographic.fromDegrees(s.lon, s.lat)),
        )
        if (this.destroyed) return
        updated.forEach((carto, i) => {
          const h = carto?.height
          if (h === undefined || !Number.isFinite(h) || h <= -100 || h >= 500) return
          heights.push(h)
          const stop = chunk[i]
          if (stop.nhn !== undefined) nhnOffsets.push(h - stop.nhn)
          // Most detailed measurement available – mark as final so the
          // camera-dependent sampling in resolveStopHeights() leaves it alone.
          stop.sampledFrom = 0
          stop.entity.position = new ConstantPositionProperty(
            Cartesian3.fromDegrees(stop.lon, stop.lat, h + 0.5),
          )
        })
        if (heights.length > 0) {
          // Raise the base for all trams already running (the ongoing
          // per-tram sampling does the fine-tuning afterwards)
          const median = [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)]
          this.defaultGroundHeight = median
          for (const record of this.trams.values()) {
            record.groundHeight = median
          }
        }
        this.render()
      }
    } catch (error) {
      console.warn('[MiniRostock3D] Height bootstrap failed:', error)
      return
    }

    if (heights.length === 0) {
      console.warn(
        '[MiniRostock3D] Height bootstrap: no valid tile heights determined – ' +
          'trams will use the fallback height. Please report this message ' +
          'along with window.__mrt.groundHeights().',
      )
      return
    }
    heights.sort((a, b) => a - b)
    console.info(
      `[MiniRostock3D] Tile heights determined (ellipsoidal): ` +
        `min ${heights[0].toFixed(1)} m · median ${this.defaultGroundHeight.toFixed(1)} m · ` +
        `max ${heights[heights.length - 1].toFixed(1)} m (${heights.length} sample points)`,
    )

    // Calibrate the route heights: median of (tile height − DGM height)
    // over the sampled stops. Robust against single outliers (a stop under
    // a tree crown baked into the mesh); the plausibility window catches a
    // systematically broken dataset.
    if (nhnOffsets.length >= 5 && this.heightRoutePieces.length > 0) {
      nhnOffsets.sort((a, b) => a - b)
      const offset = nhnOffsets[Math.floor(nhnOffsets.length / 2)]
      if (offset > 20 && offset < 60) {
        this.routeHeightOffset = offset
        this.applyRouteHeightOffset()
        console.info(
          `[MiniRostock3D] Route heights calibrated: NHN→ellipsoid offset ` +
            `${offset.toFixed(1)} m (${nhnOffsets.length} stop samples)`,
        )
      } else {
        console.warn(
          `[MiniRostock3D] Route height calibration implausible (${offset.toFixed(1)} m) – ` +
            `keeping the ${ROUTE_HEIGHT_OFFSET_FALLBACK} m fallback offset`,
        )
      }
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
   * The trams' height is set EXPLICITLY instead of via HeightReference
   * clamping (clamping entity geometries onto 3D tiles is unreliable in
   * practice, which left boxes below the photorealistic surface). The
   * height source is the direction's DGM terrain profile (snapshot `nhn` +
   * the calibrated NHN→ellipsoid offset) – the same numbers the route
   * polylines use, so vehicles and lines are congruent by construction and
   * no tileset.getHeight ray casts are needed. Vehicles without route
   * heights (approximated dataset) fall back to sampling the 3D tiles.
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
        this.renderRequested = true
      }

      // Entering/leaving a tunnel section toggles the 40 % ghost rendering.
      if (snap.inTunnel !== record.inTunnel) {
        record.inTunnel = snap.inTunnel
        record.appearanceDirty = true
      }
      if (record.appearanceDirty) {
        record.appearanceDirty = !this.applyTramAppearance(snap.id)
        if (!record.appearanceDirty) this.renderRequested = true
      }

      const show = visibleLines.has(snap.lineId)

      // Vehicle height: terrain profile of the route (NHN + calibrated
      // offset) whenever the direction carries DGM heights – deterministic,
      // congruent with the route polylines, and free of ray casts. In
      // offline mode the ground is the bare ellipsoid, where NHN heights
      // would float mid-air, so the fallback below applies there too.
      const routeGroundHeight =
        this.opts.fixedGroundHeight === undefined && !this.opts.offline && snap.nhn !== undefined
          ? snap.nhn + this.routeHeightOffset
          : undefined
      if (routeGroundHeight !== undefined) {
        record.groundHeight = routeGroundHeight
      }

      let position = Cartesian3.fromDegrees(
        snap.lon,
        snap.lat,
        record.groundHeight + record.halfHeight + 0.3,
        undefined,
        positionScratch,
      )

      // Visibility test per shown tram: inside the camera frustum AND within
      // label range (beyond that the vehicle is only a few pixels). The
      // result drives the render pacing (anyTramInView) and whether the
      // fallback tile-height sampling below is worth doing at all.
      let inView = false
      const cameraDistance = Cartesian3.distance(camera.positionWC, position)
      if (show && cameraDistance < TRAM_VISIBLE_RANGE) {
        Cartesian3.clone(position, this.frustumSphere.center)
        this.frustumSphere.radius = 80
        inView = cullingVolume.computeVisibility(this.frustumSphere) !== Intersect.OUTSIDE
        if (inView) anyTramInView = true
      }

      // Fallback for vehicles WITHOUT route heights (approximated dataset):
      // sample the tile height in a staggered fashion (not every tram in
      // every frame) and only where visible – tileset.getHeight does a ray
      // intersection against the loaded tiles and would dominate the tick.
      const followed = snap.id === this.followId
      if (
        routeGroundHeight === undefined &&
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

      // Movement of an on-screen vehicle (sim tick, time jump, height
      // adjustment) must reach the screen even outside the 30 fps state.
      if (!Cartesian3.equalsEpsilon(position, record.lastPosition, 0, 0.01)) {
        Cartesian3.clone(position, record.lastPosition)
        if (inView) this.renderRequested = true
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
      // The body box is only drawn close up; the number label carries the
      // vehicle out to TRAM_VISIBLE_RANGE. (Checked here on the CPU – a
      // DistanceDisplayCondition attribute on the Primitive measures from
      // the instance matrix, which is identity for these boxes since the
      // position lives in the primitive's own modelMatrix.)
      const showBody = show && cameraDistance < TRAM_BODY_VISIBLE_RANGE
      if (record.primitive.show !== showBody || record.labelEntity.show !== show) {
        record.primitive.show = showBody
        record.labelEntity.show = show
        this.renderRequested = true
      }

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
        this.renderRequested = true
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
   * Couples the scene clock to the simulated instant (epoch ms). Sun
   * position, atmosphere, and the tiles' time-of-day grading follow it.
   * The caller throttles updates (~1 sim-minute steps), so an idle map at
   * real-time speed costs about one extra render per minute.
   */
  setSceneTime(epochMs: number): void {
    this.viewer.clock.currentTime = JulianDate.fromDate(new Date(epochMs))
    this.requestRender()
  }

  /** Marks the scene as changed – the app loop then renders a frame promptly. */
  requestRender(): void {
    this.renderRequested = true
  }

  /** Returns (and clears) whether a one-off scene change needs a frame. */
  consumeRenderRequest(): boolean {
    const requested = this.renderRequested
    this.renderRequested = false
    return requested
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
    this.requestRender()
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
        distanceDisplayCondition: new DistanceDisplayCondition(0, TRAM_VISIBLE_RANGE),
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
      lastPosition: Cartesian3.clone(initialPosition),
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
    this.requestRender()
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
    this.requestRender()
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
    // The camera moved with the tram – must reach the screen even when the
    // render pacing is otherwise idle.
    this.requestRender()
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

  /** Debug/tests: color-attribute opacity currently applied to a vehicle body. */
  getTramOpacity(tramId: string): number | null {
    const record = this.trams.get(tramId)
    if (!record) return null
    try {
      const attributes = record.primitive.getGeometryInstanceAttributes(`tram:${tramId}`)
      const alpha = attributes?.color?.[3]
      return typeof alpha === 'number' ? alpha / 255 : null
    } catch {
      // The primitive has not completed its first render yet.
      return null
    }
  }

  /**
   * Debug: tile memory usage vs. budget and the LOD budget actually in
   * effect. effectiveSse > configuredSse means Cesium's memory ratchet is
   * degrading the LOD because the view does not fit into cacheBytes.
   */
  getTileMemoryInfo(): {
    usedMB: number
    cacheMB: number
    configuredSse: number
    effectiveSse: number
  } | null {
    const tileset = this.googleTileset
    if (!tileset) return null
    // Public in Cesium's JS API but missing from its TS typings.
    const effectiveSse =
      (tileset as unknown as { memoryAdjustedScreenSpaceError?: number })
        .memoryAdjustedScreenSpaceError ?? tileset.maximumScreenSpaceError
    return {
      usedMB: Math.round(tileset.totalMemoryUsageInBytes / 1024 / 1024),
      cacheMB: Math.round(tileset.cacheBytes / 1024 / 1024),
      configuredSse: Math.round(tileset.maximumScreenSpaceError * 10) / 10,
      effectiveSse: Math.round(effectiveSse * 10) / 10,
    }
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
    this.resizeObserver?.disconnect()
    this.handler.destroy()
    this.heightRoutePieces = []
    this.viewer.destroy()
  }
}
