/**
 * Imperative wrapper around the Cesium viewer: Google Photorealistic 3D
 * Tiles, line routes, stops, and the animated tram boxes.
 *
 * Deliberately kept free of any React dependency – React drives this class
 * through a narrow API (syncTrams, setLineVisibility, …) so the render loop
 * does not run through React re-renders.
 */

import {
  BillboardCollection,
  BlendOption,
  BoundingSphere,
  BoxGeometry,
  CallbackProperty,
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
  HorizontalOrigin,
  Intersect,
  Ion,
  JulianDate,
  LabelStyle,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  PlaneGeometry,
  Primitive,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Simon1994PlanetaryPositions,
  Transforms,
  VertexFormat,
  VerticalOrigin,
  Viewer,
  createGooglePhotorealistic3DTileset,
  type Billboard,
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
  /**
   * Fired while the camera pose changes (per rendered frame, threshold
   * camera.percentageChanged, settled=false) and once when movement ends
   * (camera.moveEnd, settled=true). Basis for the event-driven URL
   * persistence – no polling.
   */
  onCameraChanged?: (settled: boolean) => void
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
  /** Current direction of travel in degrees (0° = north, clockwise). */
  bearing: number
  /** Smoothed ground height (ellipsoidal) below the tram in meters. */
  groundHeight: number
  /** Frame counter of the last height query (sampling is staggered). */
  lastSampleFrame: number
  /** Position of the last tick – detects movement for render requests. */
  lastPosition: Cartesian3
  /** Night-time light pool under the vehicle (null without 2D canvas). */
  glow: Primitive | null
  /** Live modelMatrix of the glow quad (updated in place). */
  glowMatrix: Matrix4 | null
  /** Ground extent of the pool (vehicle footprint plus spill). */
  glowScale: Cartesian3
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

/** Camera distance in meters up to which the stop discs are drawn. */
const STOP_DISC_RANGE = 20000

/** Camera distance in meters up to which stop name labels are drawn. */
const STOP_LABEL_RANGE = 2600

/** Rendered size of a stop disc in CSS px (fill + outline). */
const STOP_DISC_SIZE = 10

/** Font size of the stop name plates in CSS px. */
const STOP_LABEL_FONT_SIZE = 13
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
 * Night-time cabin glow: a soft, warm light pool under every vehicle, as
 * if the interior lighting spilled onto the road. Drawn as a flat,
 * radial-gradient quad; its opacity follows the real sun elevation with
 * the same ramp the tiles' time-of-day shader uses, so the pools fade in
 * exactly while the city grades into night.
 */
const GLOW_COLOR = Color.fromCssColorString('#ffd9a0')
/** Pool opacity in full night (scaled by the sun ramp in between). */
const GLOW_MAX_ALPHA = 0.5
/** Sine of the sun elevation where the glow starts (dusk) / is fully on. */
const GLOW_SUN_START = -0.05
const GLOW_SUN_FULL = -0.17
/** Meters above the sampled ground – below routes, above the road mesh. */
const GLOW_LIFT = 0.15
/** Camera distance in meters up to which the pools are drawn. */
const GLOW_VISIBLE_RANGE = 2_500

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
  vec3 nightTint = vec3(0.09, 0.11, 0.20);

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
const FERRY_ROUTE_EXTRA_LIFT = 1.25

/** Camera pitch of the "zoom to line" flight in degrees (heading is kept). */
const LINE_FOCUS_PITCH = -55

/**
 * Attention pulse on a line's route after "zoom to line": the opacity
 * swings smoothly from full to zero and back (cosine), several dips over
 * the total duration. Smooth instead of hard on/off blinking – the route
 * stays readable while clearly calling attention to itself. All OTHER
 * lines fade out for the duration (ROUTE_PULSE_FADE_MS ramps at both
 * ends), so the pulsing line stands out even on shared corridors.
 */
const ROUTE_PULSE_DURATION_MS = 3000
const ROUTE_PULSE_PERIOD_MS = 750
const ROUTE_PULSE_FADE_MS = 250

/** Follow camera: initial offset behind/above the vehicle. */
const FOLLOW_PITCH_DEG = -14
const FOLLOW_RANGE = 150

/** Duration of the approach flight when following starts, in seconds. */
const FOLLOW_FLIGHT_SECONDS = 1.4

/**
 * Per-update easing of the chase heading toward the travel bearing
 * (~0.25 s time constant at the 30 fps tick). The bearing jumps at path
 * segment boundaries – applying it directly would visibly snap the view.
 */
const FOLLOW_CHASE_EASE = 0.12

/**
 * Deviations beyond these thresholds between the camera pose and the pose
 * the chase applied last frame mean the user moved the camera by hand.
 * Rotating (heading/pitch) disengages the chase; a pure range change is
 * zooming and is adopted into the chase instead. Radians for angles,
 * relative for the range; generous against floating-point noise, far
 * below any real mouse input.
 */
const CHASE_BREAK_ANGLE = 0.003
const CHASE_BREAK_RANGE_RATIO = 0.01

/**
 * Visibility of tunnel/underground sections: route pieces and vehicles on
 * them are rendered at this fraction of their normal opacity. Exported for
 * the tests, which pin the ghosting behaviour against it.
 */
export const TUNNEL_VISIBILITY = 0.2

// Scratch objects for the per-tick hot path in syncTrams: Cesium clones all
// values it retains (ConstantProperty, modelMatrix), so reusing these avoids
// ~2 allocations per tram per tick.
const positionScratch = new Cartesian3()

// Scratches for the sun-elevation night factor (see updateNightFactor).
const sunPositionScratch = new Cartesian3()
const sunTransformScratch = new Matrix3()

// Scratch for the per-tick glow pool pose (see syncTrams).
const glowPositionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll()

// Scratch for the stop label declutter's screen projections.
const windowScratch = new Cartesian2()

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
  /** Rendered line badges (rounded rectangle + line number), one per line. */
  private badgeCache = new Map<string, { canvas: HTMLCanvasElement; width: number; height: number }>()
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
  /**
   * Discs AND name plates of all stops in one purely translucent billboard
   * collection. Both are depth-clamped to the near plane
   * (disableDepthTestDistance), where opaque passes write depth and the
   * per-frame command sort – not the primitive list – decides what covers
   * what, which left discs over neighboring stop names. Within a single
   * translucent command, fragments instead blend strictly in add order:
   * all discs first, every name after them, so names always draw on top.
   * (Tram badges stay above both: their opaque entity billboards write
   * near-plane depth this depth-tested collection cannot pass.)
   */
  private stopBillboards: BillboardCollection | null = null
  private stopRecords: StopEntityRecord[] = []
  /** A stop changed (position, visibility) – the label declutter must rerun. */
  private stopLabelsDirty = true
  /** Camera view matrix of the last declutter pass (all zeros = never ran). */
  private declutterViewMatrix = new Matrix4()
  private handler: ScreenSpaceEventHandler
  private selectedId: string | null = null
  private destroyed = false
  private followId: string | null = null
  private followOffset: HeadingPitchRange | null = null
  /** Until this time the approach flight runs and lookAt stays disengaged. */
  private followFlightUntil = 0
  /**
   * Chase mode: the camera stays exactly behind the vehicle (heading
   * follows the travel bearing) until the user moves the camera by hand –
   * from then on manual orbit/zoom is adopted as before.
   */
  private followChase = false
  private googleTileset: Cesium3DTileset | null = null
  /** Most recently measured plausible ground height – initial value for new trams. */
  private defaultGroundHeight: number
  /** Drawing-buffer pixels per CSS pixel (HiDPI rendering, capped at 2). */
  private readonly effectivePixelRatio: number
  private frameCounter = 0
  /** Timestamp of the last stop height sampling pass (see resolveStopHeights). */
  private lastStopSampleAt = 0
  private frustumSphere = new BoundingSphere()
  /** 0 = day … 1 = full night; drives the cabin-glow opacity. */
  private nightFactor = 0
  /** Radial gradient sprite of the glow pools (null: no 2D canvas). */
  private glowSpriteCanvas?: HTMLCanvasElement | null
  /** Material/appearance shared by ALL pools – one uniform sets the alpha. */
  private glowMaterial: Material | null = null
  private glowAppearance: MaterialAppearance | null = null
  /** Unit up vector at the city center (sun elevation reference). */
  private cityUp: Cartesian3 | null = null
  /** Time of the last user interaction (mouse/touch/wheel) in ms. */
  private lastInteractionAt = 0
  /** A camera animation (flyTo) is running until this point in time. */
  private flyingUntil = 0
  /** Running route attention pulse (see startRoutePulse), null = none. */
  private routePulse: { lineId: string; start: number; until: number } | null = null
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

    // Camera change events for the URL persistence. The default
    // percentageChanged (0.5) only fires on huge jumps – 1 % keeps every
    // user-visible pose change reported while sub-pixel jitter stays quiet.
    if (opts.onCameraChanged) {
      const onCameraChanged = opts.onCameraChanged
      this.viewer.camera.percentageChanged = 0.01
      this.viewer.camera.changed.addEventListener(() => onCameraChanged(false))
      this.viewer.camera.moveEnd.addEventListener(() => onCameraChanged(true))
    }

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
   * Rotates the camera to the given heading and/or pitch (in degrees)
   * while keeping the ground point at the screen center fixed – the view
   * pivots in place instead of jumping elsewhere. Omitted components keep
   * their current value. Used by the 2D/3D and "face north" buttons.
   */
  setCameraOrientation(orientation: { headingDeg?: number; pitchDeg?: number }): void {
    const camera = this.viewer.camera
    const carto = camera.positionCartographic
    const heading =
      orientation.headingDeg !== undefined
        ? CesiumMath.toRadians(orientation.headingDeg)
        : camera.heading
    const pitch =
      orientation.pitchDeg !== undefined
        ? CesiumMath.toRadians(orientation.pitchDeg)
        : camera.pitch
    // Pivot: where the view axis meets the ground, derived from pitch and
    // the height above ground (no ray cast needed). Near-horizontal views
    // would put that point at infinity – clamp them to a plausible pivot.
    const heightAbove = Math.max(50, carto.height - this.defaultGroundHeight)
    const descent = Math.tan(-camera.pitch)
    const forward = descent > 0.05 ? heightAbove / descent : heightAbove * 20
    const earthRadius = 6378137
    const target = Cartesian3.fromRadians(
      carto.longitude + (forward * Math.sin(camera.heading)) / (earthRadius * Math.cos(carto.latitude)),
      carto.latitude + (forward * Math.cos(camera.heading)) / earthRadius,
      this.defaultGroundHeight,
    )
    // Render at full rate during the flight (see getRenderHints)
    this.flyingUntil = performance.now() + 1600
    this.requestRender()
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(target, 0), {
      duration: 1,
      offset: new HeadingPitchRange(heading, pitch, Math.hypot(heightAbove, forward)),
    })
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
    // Render at full rate during flight AND pulse (see getRenderHints)
    this.flyingUntil = performance.now() + Math.max(2100, ROUTE_PULSE_DURATION_MS + 200)
    this.startRoutePulse(lineId)
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

  /** Starts the attention pulse on a line's route (replaces any running one). */
  private startRoutePulse(lineId: string): void {
    const now = performance.now()
    this.routePulse = { lineId, start: now, until: now + ROUTE_PULSE_DURATION_MS }
    this.requestRender()
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
  private updateRoutePulse(): void {
    if (!this.routePulse) return
    if (performance.now() >= this.routePulse.until) {
      this.routePulse = null
    }
    this.requestRender()
  }

  /**
   * Draws all stops (deduplicated across lines).
   * Heights are – as with the trams – set explicitly and adjusted as soon
   * as the 3D tiles are loaded at the respective location.
   */
  addStops(network: PreparedNetwork): void {
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
    }[] = []
    // Stops are shared across lines – collect every serving line per stop,
    // so hiding lines can hide exactly the stops no shown line serves.
    const byId = new Map<string, string[]>()
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          const lines = byId.get(stop.id)
          if (lines) {
            if (!lines.includes(line.id)) lines.push(line.id)
            continue
          }
          const [lon, lat] = stop.coord
          const entry = { id: stop.id, name: stop.name, lon, lat, nhn: stop.nhn, lines: [line.id] }
          byId.set(stop.id, entry.lines)
          unique.push(entry)
        }
      }
    }

    const positions = unique.map((stop) =>
      Cartesian3.fromDegrees(stop.lon, stop.lat, this.defaultGroundHeight + 0.5),
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
      const plate = this.stopNameplate(stop.name)
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
        labelHalfWidth: plate ? plate.width / 2 : stop.name.length * 3.5,
        lines: stop.lines,
        lineVisible: true,
        lon: stop.lon,
        lat: stop.lat,
        position: Cartesian3.fromDegrees(stop.lon, stop.lat, this.defaultGroundHeight),
        sampledFrom: Number.POSITIVE_INFINITY,
        retryAfter: 0,
        nhn: stop.nhn,
      })
    })
    this.stopLabelsDirty = true
    this.requestRender()
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
      this.requestRender()
    }
  }

  /** Disc image shared by all stops, drawn at the drawing-buffer ratio. */
  private stopDiscImage(): HTMLCanvasElement | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const ratio = this.effectivePixelRatio
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
   * Renders a stop name (outlined text, same look as the previous Label
   * primitives) to a canvas at the drawing-buffer pixel ratio. Returns
   * undefined where no 2D canvas is available (jsdom).
   */
  private stopNameplate(
    name: string,
  ): { canvas: HTMLCanvasElement; width: number; height: number } | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const ratio = this.effectivePixelRatio
    const font = `${Math.round(STOP_LABEL_FONT_SIZE * ratio)}px ${STOP_LABEL_FONT_FAMILY}`
    ctx.font = font
    const textWidth = ctx.measureText(name).width
    const padX = 4 * ratio
    const height = Math.round(STOP_LABEL_HEIGHT * ratio)
    const width = Math.ceil(textWidth + 2 * padX)
    canvas.width = width
    canvas.height = height
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 3 * ratio
    ctx.strokeStyle = '#0f172a'
    ctx.strokeText(name, width / 2, height / 2)
    ctx.fillStyle = '#e2e8f0'
    ctx.fillText(name, width / 2, height / 2)
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
  private declutterStopLabels(): void {
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

    const kept: { left: number; right: number; top: number; bottom: number }[] = []
    let changed = false
    for (const candidate of candidates) {
      const halfWidth = candidate.record.labelHalfWidth + STOP_LABEL_GAP
      // Window y grows downward; the label is anchored bottom-center at
      // pixelOffset above the disc.
      const bottom = candidate.y + STOP_LABEL_OFFSET_Y
      const top = bottom - STOP_LABEL_HEIGHT - STOP_LABEL_GAP
      const left = candidate.x - halfWidth
      const right = candidate.x + halfWidth
      let free = true
      for (const rect of kept) {
        if (left < rect.right && right > rect.left && top < rect.bottom && bottom > rect.top) {
          free = false
          break
        }
      }
      if (free) kept.push({ left, right, top, bottom })
      if (candidate.record.label.show !== free) {
        candidate.record.label.show = free
        changed = true
      }
    }
    if (changed) this.requestRender()
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
      const lifted = Cartesian3.fromDegrees(stop.lon, stop.lat, height + 0.5)
      stop.disc.position = lifted
      stop.label.position = lifted
      this.stopLabelsDirty = true
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
    if (this.stopBillboards) this.stopBillboards.show = visible
    this.stopLabelsDirty = true
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
          const lifted = Cartesian3.fromDegrees(stop.lon, stop.lat, h + 0.5)
          stop.disc.position = lifted
          stop.label.position = lifted
          this.stopLabelsDirty = true
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
    this.declutterStopLabels()
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
      record.bearing = snap.bearing
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

      // Night-time cabin glow: only at night, never in tunnels, and only
      // where the pool is more than a couple of pixels.
      if (record.glow && record.glowMatrix) {
        const showGlow =
          showBody &&
          !record.inTunnel &&
          this.nightFactor > 0.02 &&
          cameraDistance < GLOW_VISIBLE_RANGE
        if (record.glow.show !== showGlow) {
          record.glow.show = showGlow
          this.renderRequested = true
        }
        if (showGlow) {
          // Same heading as the body (hprScratch above), anchored on the
          // ground instead of the vehicle center.
          Transforms.headingPitchRollToFixedFrame(
            Cartesian3.fromDegrees(
              snap.lon,
              snap.lat,
              record.groundHeight + GLOW_LIFT,
              undefined,
              glowPositionScratch,
            ),
            hprScratch,
            undefined,
            undefined,
            record.glowMatrix,
          )
          Matrix4.multiplyByScale(record.glowMatrix, record.glowScale, record.glowMatrix)
        }
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
        if (record.glow) this.viewer.scene.primitives.remove(record.glow)
        this.trams.delete(id)
        this.renderRequested = true
      }
    }

    return { anyTramInView }
  }

  /** Renders exactly one frame (the app controls the frequency). */
  render(): void {
    if (this.destroyed) return
    this.updateRoutePulse()
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
    this.updateNightFactor(this.viewer.clock.currentTime)
    this.requestRender()
  }

  /**
   * Recomputes the day/night factor from the real sun elevation over the
   * city and applies it to the shared glow material – the pools fade in
   * with the same sun ramp the tiles' time-of-day shader grades by.
   * Called with setSceneTime's ~1-sim-minute throttle.
   */
  private updateNightFactor(time: JulianDate): void {
    this.cityUp ??= Cartesian3.normalize(
      Cartesian3.fromDegrees(config.home.longitude, config.home.latitude),
      new Cartesian3(),
    )
    const sun = Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(
      time,
      sunPositionScratch,
    )
    // Without loaded EOP data the precise ICRF transform is unavailable –
    // the TEME approximation is plenty for a lighting ramp.
    const toFixed = Transforms.computeIcrfToFixedMatrix(time, sunTransformScratch)
    Matrix3.multiplyByVector(
      toFixed ?? Transforms.computeTemeToPseudoFixedMatrix(time, sunTransformScratch),
      sun,
      sun,
    )
    const sunUp = Cartesian3.dot(Cartesian3.normalize(sun, sun), this.cityUp)
    const t = CesiumMath.clamp(
      (sunUp - GLOW_SUN_FULL) / (GLOW_SUN_START - GLOW_SUN_FULL),
      0,
      1,
    )
    const night = 1 - t * t * (3 - 2 * t) // smoothstep
    if (Math.abs(night - this.nightFactor) < 0.01 && night !== 0) return
    this.nightFactor = night
    if (this.glowMaterial) {
      const uniforms = this.glowMaterial.uniforms as { color: Color }
      uniforms.color.alpha = GLOW_MAX_ALPHA * night
    }
  }

  /** Shared radial-gradient sprite of the glow pools (null: no 2D canvas). */
  private glowSprite(): HTMLCanvasElement | null {
    // ??=-style caching that also survives prototype-based test instances
    if (this.glowSpriteCanvas !== undefined) return this.glowSpriteCanvas
    this.glowSpriteCanvas = null
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      const ctx = canvas.getContext('2d')
      if (ctx) {
        const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128)
        gradient.addColorStop(0, 'rgba(255,255,255,0.9)')
        gradient.addColorStop(0.35, 'rgba(255,255,255,0.4)')
        gradient.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 256, 256)
        this.glowSpriteCanvas = canvas
      }
    }
    return this.glowSpriteCanvas
  }

  /** Appearance shared by all glow pools (lazy; null without 2D canvas). */
  private glowPoolAppearance(): MaterialAppearance | null {
    if (this.glowAppearance) return this.glowAppearance
    const sprite = this.glowSprite()
    if (!sprite) return null
    // One material for every pool: a single uniform write dims all pools
    // with the night factor. The sprite carries the falloff, the color
    // uniform carries warmth and the ramped alpha.
    this.glowMaterial = new Material({
      fabric: {
        type: 'VehicleGlow',
        uniforms: {
          image: sprite,
          color: GLOW_COLOR.withAlpha(GLOW_MAX_ALPHA * this.nightFactor),
        },
        components: {
          diffuse: 'color.rgb',
          alpha: 'texture(image, materialInput.st).a * color.a',
        },
      },
    })
    this.glowAppearance = new MaterialAppearance({
      flat: true,
      translucent: true,
      material: this.glowMaterial,
    })
    return this.glowAppearance
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

  /**
   * Draws (and caches) the badge for a line: the line number in white on a
   * rounded rectangle filled with the line color – the same look as the
   * badges in the line panel. Rendered at the drawing-buffer pixel ratio so
   * it stays sharp on HiDPI screens; the billboard shows it at CSS size.
   * Returns undefined where no 2D canvas is available (jsdom) – the caller
   * then falls back to a plain text label.
   */
  private lineBadge(
    lineId: string,
    color: Color,
  ): { canvas: HTMLCanvasElement; width: number; height: number } | undefined {
    // ??= : prototype-based test instances skip the class field initializers
    this.badgeCache ??= new Map()
    const cached = this.badgeCache.get(lineId)
    if (cached) return cached
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const ratio = this.effectivePixelRatio
    const font = `bold ${Math.round(14 * ratio)}px "Inter Variable", system-ui, sans-serif`
    ctx.font = font
    const textWidth = ctx.measureText(lineId).width
    const padX = 5 * ratio
    const height = Math.round(22 * ratio)
    const width = Math.max(height, Math.round(textWidth + 2 * padX))
    canvas.width = width
    canvas.height = height

    const radius = 5 * ratio
    ctx.beginPath()
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(0, 0, width, height, radius)
    } else {
      ctx.rect(0, 0, width, height)
    }
    ctx.fillStyle = color.toCssColorString()
    ctx.fill()
    ctx.font = font
    ctx.fillStyle = '#ffffff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(lineId, width / 2, height / 2 + 0.5 * ratio)

    const entry = { canvas, width: width / ratio, height: height / ratio }
    this.badgeCache.set(lineId, entry)
    return entry
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
    // Badge like in the line panel: line number on a rounded rectangle in
    // the line color (pre-rendered per line, see lineBadge) – far easier
    // to spot against the photo tiles than outlined text alone. Tunnel
    // ghosting dims the whole badge via the billboard color multiplier.
    const badge = this.lineBadge(snap.lineId, color)
    const labelEntity = this.viewer.entities.add({
      id: `tram:${snap.id}`,
      position: labelPosition,
      ...(badge
        ? {
            billboard: {
              image: badge.canvas,
              width: badge.width,
              height: badge.height,
              color: Color.WHITE.withAlpha(alpha),
              pixelOffset: new Cartesian2(0, -30),
              distanceDisplayCondition: new DistanceDisplayCondition(0, TRAM_VISIBLE_RANGE),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }
        : {
            // No 2D canvas (jsdom): plain outlined text label
            label: {
              text: snap.lineId,
              font: 'bold 14px "Inter Variable", system-ui, sans-serif',
              fillColor: Color.WHITE.withAlpha(alpha),
              outlineColor: color.withAlpha(alpha),
              outlineWidth: 4,
              style: LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cartesian2(0, -30),
              distanceDisplayCondition: new DistanceDisplayCondition(0, TRAM_VISIBLE_RANGE),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
    })

    // Night-time cabin glow: pool extent = footprint plus sideways spill
    const glowScale = new Cartesian3(
      snap.vehicle.length * 1.25 + 4,
      snap.vehicle.width * 3.5,
      1,
    )
    let glow: Primitive | null = null
    let glowMatrix: Matrix4 | null = null
    const glowAppearance = this.glowPoolAppearance()
    if (glowAppearance) {
      glow = new Primitive({
        geometryInstances: new GeometryInstance({
          geometry: new PlaneGeometry({ vertexFormat: VertexFormat.POSITION_AND_ST }),
        }),
        appearance: glowAppearance,
        asynchronous: false,
        allowPicking: false,
        modelMatrix: Matrix4.multiplyByScale(Matrix4.clone(matrix), glowScale, new Matrix4()),
        show: false, // syncTrams turns it on at night
      })
      this.viewer.scene.primitives.add(glow)
      glowMatrix = glow.modelMatrix
    }

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
      bearing: snap.bearing,
      groundHeight: this.defaultGroundHeight,
      lastSampleFrame: -HEIGHT_SAMPLE_INTERVAL, // sample immediately on the first frame
      lastPosition: Cartesian3.clone(initialPosition),
      glow,
      glowMatrix,
      glowScale,
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
    // Badge billboard: dim the whole badge via the color multiplier; the
    // text-label fallback (no canvas) dims fill and outline instead.
    const billboard = record.labelEntity.billboard
    if (billboard) {
      billboard.color = new ConstantProperty(Color.WHITE.withAlpha(alpha))
    }
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
    this.followChase = tramId !== null
    if (!tramId) {
      // Also abort a still-running approach flight (e.g. "Stop following"
      // clicked mid-flight), otherwise it lands on the abandoned vehicle.
      if (performance.now() < this.followFlightUntil) this.viewer.camera.cancelFlight()
      this.followFlightUntil = 0
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
      this.requestRender()
      return
    }
    // Approach with a camera flight instead of teleporting: fly to the
    // vehicle's current position with the same offset the follow camera
    // starts from, and only engage the per-frame lookAt once the flight is
    // done (updateFollowCamera skips until followFlightUntil). The flight
    // ends BEHIND the vehicle looking along its direction of travel
    // (heading = bearing); afterwards the user can orbit freely as before.
    // The vehicle moves a few meters during the flight.
    const record = this.trams.get(tramId)
    if (record) {
      this.viewer.camera.lookAtTransform(Matrix4.IDENTITY)
      const carto = Cartographic.fromCartesian(record.lastPosition)
      const center = Cartesian3.fromRadians(
        carto.longitude,
        carto.latitude,
        record.groundHeight + record.halfHeight * 2 + 2,
      )
      // The tween only ends with its complete/cancel callback – under slow
      // rendering that can be well after the nominal duration, and a tween
      // frame landing after the lookAt hand-over would move the camera and
      // trip the chase's manual-input detection. The timestamp is only a
      // safety cap for a tween whose callbacks never fire.
      this.followFlightUntil = performance.now() + FOLLOW_FLIGHT_SECONDS * 1000 + 2000
      const endFlight = () => {
        this.followFlightUntil = 0
      }
      // Render at full rate during the flight (see getRenderHints)
      this.flyingUntil = performance.now() + FOLLOW_FLIGHT_SECONDS * 1000 + 200
      this.viewer.camera.flyToBoundingSphere(new BoundingSphere(center, 0), {
        duration: FOLLOW_FLIGHT_SECONDS,
        offset: new HeadingPitchRange(
          CesiumMath.toRadians(record.bearing),
          CesiumMath.toRadians(FOLLOW_PITCH_DEG),
          FOLLOW_RANGE,
        ),
        complete: endFlight,
        cancel: endFlight,
      })
    }
    this.requestRender()
  }

  private updateFollowCamera(lon: number, lat: number): void {
    // The approach flight is still running – lookAt would cut it short.
    if (performance.now() < this.followFlightUntil) return
    const camera = this.viewer.camera

    // Camera center at the height of the followed tram (its ground height
    // is already sampled on the 3D tiles and smoothed in syncTrams).
    const record = this.followId ? this.trams.get(this.followId) : undefined
    const groundHeight = record?.groundHeight ?? this.defaultGroundHeight
    const vehicleHeight = (record?.halfHeight ?? config.vehicles.tram.height / 2) * 2

    const center = Cartesian3.fromDegrees(lon, lat, groundHeight + vehicleHeight + 2)

    if (!this.followOffset) {
      // First frame: the approach flight ends in exactly this pose, so the
      // lookAt hand-over continues seamlessly from it. A tween that hit the
      // safety cap without completing must not keep animating into the
      // engaged lookAt.
      camera.cancelFlight()
      this.followOffset = new HeadingPitchRange(
        camera.heading,
        CesiumMath.toRadians(FOLLOW_PITCH_DEG),
        FOLLOW_RANGE,
      )
    } else if (this.followChase) {
      // Chase: any camera pose that deviates from what the chase applied
      // last frame must come from the user (drag/zoom between our ticks) –
      // hand control over to manual orbit for the rest of this follow.
      const headingMoved =
        Math.abs(CesiumMath.negativePiToPi(camera.heading - this.followOffset.heading)) >
        CHASE_BREAK_ANGLE
      const pitchMoved = Math.abs(camera.pitch - this.followOffset.pitch) > CHASE_BREAK_ANGLE
      const rangeMoved =
        Math.abs(Cartesian3.magnitude(camera.position) - this.followOffset.range) >
        this.followOffset.range * CHASE_BREAK_RANGE_RATIO
      if (headingMoved || pitchMoved) {
        this.followChase = false
        this.followOffset.heading = camera.heading
        this.followOffset.pitch = camera.pitch
        this.followOffset.range = Cartesian3.magnitude(camera.position)
      } else {
        // Zooming (range change only) does not break the chase: adopt the
        // new distance and keep trailing the vehicle.
        if (rangeMoved) {
          this.followOffset.range = Cartesian3.magnitude(camera.position)
        }
        if (record) {
          // Stay behind the vehicle: ease the heading toward the travel
          // bearing (it jumps at path segment boundaries).
          const turn = CesiumMath.negativePiToPi(
            CesiumMath.toRadians(record.bearing) - this.followOffset.heading,
          )
          this.followOffset.heading = CesiumMath.zeroToTwoPi(
            this.followOffset.heading + turn * FOLLOW_CHASE_EASE,
          )
        }
      }
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
