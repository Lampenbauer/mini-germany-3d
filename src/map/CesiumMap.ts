/**
 * Imperative wrapper around the Cesium viewer: Google Photorealistic 3D
 * Tiles, line routes, stops, and the animated tram boxes.
 *
 * Deliberately kept free of any React dependency – React drives this class
 * through a narrow API (syncVehicles, setLineVisibility, …) so the render loop
 * does not run through React re-renders.
 */

import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
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
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerInstanceColorAppearance,
  PlaneGeometry,
  Primitive,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Simon1994PlanetaryPositions,
  Transforms,
  UniformType,
  VertexFormat,
  Viewer,
  createGooglePhotorealistic3DTileset,
  type Cesium3DTileset,
} from 'cesium'
import { config } from '@/config'
import {
  ROUTE_HEIGHT_OFFSET_FALLBACK,
  ROUTE_PULSE_DURATION_MS,
  RoutesLayer,
  TUNNEL_VISIBILITY,
} from './RoutesLayer'
import { StopsLayer } from './StopsLayer'
import {
  CLOUD_UNIFORM,
  RAIN_UNIFORM,
  WeatherOverlay,
} from './WeatherOverlay'
import type { PreparedNetwork } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export { TUNNEL_VISIBILITY }

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
  onSelectVehicle?: (vehicleId: string | null) => void
  onTilesetStatus?: (status: TilesetStatus) => void
  /**
   * Fired while the camera pose changes (per rendered frame, threshold
   * camera.percentageChanged, settled=false) and once when movement ends
   * (camera.moveEnd, settled=true). Basis for the event-driven URL
   * persistence – no polling.
   */
  onCameraChanged?: (settled: boolean) => void
}

interface VehicleRecord {
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
  /** GTFS-RT delay suffix currently baked into the badge ('' = on time). */
  delaySuffix: string
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
const VEHICLE_VISIBLE_RANGE = 20_000

/**
 * Camera distance in meters up to which the vehicle BODY (the 3D box) is
 * drawn. Beyond this the box is sub-pixel noise while the number label
 * still reads fine, so only the label stays up to VEHICLE_VISIBLE_RANGE.
 */
const VEHICLE_BODY_VISIBLE_RANGE = 3_000

/**
 * Night-time cabin glow: a soft, warm light pool under every vehicle, as
 * if the interior lighting spilled onto the road. Drawn as a flat,
 * radial-gradient quad; its opacity follows the real sun elevation with
 * the same ramp the tiles' time-of-day shader uses, so the pools fade in
 * exactly while the city grades into night.
 */
const GLOW_COLOR = Color.fromCssColorString('#ffd9a0')
/** Pool opacity in full night (scaled by the sun ramp in between). */
const GLOW_MAX_ALPHA = 0.95
/** Sine of the sun elevation where the glow starts (dusk) / is fully on. */
const GLOW_SUN_START = -0.05
const GLOW_SUN_FULL = -0.17
/** Meters above the sampled ground – below routes, above the road mesh. */
const GLOW_LIFT = 0.15
/** Camera distance in meters up to which the pools are drawn. */
const GLOW_VISIBLE_RANGE = 2_000

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

  // Closed sky, 0..1: cloud cover grades the city on its own, and rain
  // always implies an overcast sky – whichever is stronger wins.
  float overcast = max(u_cloudFactor, u_rainFactor);

  vec3 goldenTint = vec3(1.0, 0.84, 0.66);
  vec3 duskTint = vec3(0.40, 0.35, 0.37);
  vec3 nightTint = vec3(0.06, 0.08, 0.15);

  // Blend regions by sun height: full day above +8 deg, golden hour down
  // to sunset, dusk while the sun sinks to -5 deg, night below about
  // -10 deg (matches how dark a real nautical dusk already feels).
  // A closed sky swallows the low sun, so the golden hour fades with it –
  // dusk and night still fall, they only lose their warm edge.
  float golden = (1.0 - smoothstep(0.0, 0.14, sunUp)) * (1.0 - 0.8 * overcast);
  float dusk = 1.0 - smoothstep(-0.09, 0.0, sunUp);
  float night = 1.0 - smoothstep(-0.17, -0.07, sunUp);

  vec3 tint = mix(vec3(1.0), goldenTint, golden);
  tint = mix(tint, duskTint, dusk);
  tint = mix(tint, nightTint, night);

  float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
  vec3 color = mix(material.diffuse, vec3(luminance), 0.45 * night);
  material.diffuse = color * tint;

  // Overcast grade (faded in softly): flatter (desaturated), dimmer, and
  // slightly cool – overcast daylight really is bluer than direct sun, and
  // it is the leaden sky the sunny photogrammetry cannot show.
  float overcastLum = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
  vec3 graded = mix(material.diffuse, vec3(overcastLum), 0.5 * overcast);
  graded *= mix(1.0, 0.65, overcast);
  graded *= mix(vec3(1.0), vec3(0.9, 0.96, 1.08), overcast);
  material.diffuse = graded;
}
`






/** Camera pitch of the "zoom to line" flight in degrees (heading is kept). */
const LINE_FOCUS_PITCH = -55

/** Camera pose after "fly to stop": distance in meters, pitch in degrees. */
const STOP_FOCUS_RANGE = 400
const STOP_FOCUS_PITCH = -55


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


// Scratch objects for the per-tick hot path in syncVehicles: Cesium clones all
// values it retains (ConstantProperty, modelMatrix), so reusing these avoids
// ~2 allocations per tram per tick.
const positionScratch = new Cartesian3()

// Scratches for the sun-elevation night factor (see updateNightFactor).
const sunPositionScratch = new Cartesian3()
const sunTransformScratch = new Matrix3()

// Scratch for the per-tick glow pool pose (see syncVehicles).
const glowPositionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll()



/**
 * Delay suffix shown on the map badge after the line number ("+2" / "-1").
 * Mirrors the VehicleCard threshold: under a minute counts as on time, and
 * only vehicles with a GTFS-RT match show a delay at all.
 */
export function delayBadgeSuffix(snap: Pick<VehicleSnapshot, 'realtime' | 'delaySeconds'>): string {
  if (!snap.realtime || Math.abs(snap.delaySeconds) < 60) return ''
  const minutes = Math.round(snap.delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes}`
}

export class CesiumMap {
  readonly viewer: Viewer
  private readonly opts: CesiumMapOptions
  private vehicles = new Map<string, VehicleRecord>()
  /** Rendered line badges (rounded rectangle + line number), one per line. */
  private badgeCache = new Map<string, { canvas: HTMLCanvasElement; width: number; height: number }>()

  /** Time-of-day shader of the Google tiles (null offline/fallback). */
  private tileShader: CustomShader | null = null
  /** Rain field and overcast grade – owns its own state (see WeatherOverlay). */
  private readonly weather: WeatherOverlay
  /** Discs, name plates, declutter and stop heights (see StopsLayer). */
  private readonly stops: StopsLayer
  /** Route polylines, their heights and the attention pulse (see RoutesLayer). */
  private readonly routes: RoutesLayer
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
  /** Most recently measured plausible ground height – initial value for new vehicles. */
  private defaultGroundHeight: number
  /** Drawing-buffer pixels per CSS pixel (HiDPI rendering, capped at 2). */
  private readonly effectivePixelRatio: number
  private frameCounter = 0
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
    // Live view of the map for the layer host below: its getters must see
    // the current values, not a snapshot taken at construction time.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const map = this
    // Before loadGoogleTiles(): that hands the overlay its tile shader.
    this.weather = new WeatherOverlay(this.viewer, () => this.requestRender())
    this.routes = new RoutesLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      offline: opts.offline === true,
    })
    this.stops = new StopsLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      sampleGroundHeight: (lon, lat) => this.sampleGroundHeight(lon, lat),
      get defaultGroundHeight() {
        return map.defaultGroundHeight
      },
      get hasTileset() {
        return map.googleTileset !== null
      },
      get pixelRatio() {
        return map.effectivePixelRatio
      },
    })
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
      let vehicleId: string | null = null
      if (pickedId instanceof Entity && pickedId.id.startsWith('vehicle:')) {
        vehicleId = pickedId.id.slice('vehicle:'.length)
      } else if (typeof pickedId === 'string' && pickedId.startsWith('vehicle:')) {
        vehicleId = pickedId.slice('vehicle:'.length)
      }
      this.opts.onSelectVehicle?.(vehicleId)
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
      // Day/night ambience following the simulated time (see setSceneTime).
      // The two overcast uniforms are driven by the weather overlay, which
      // pushes its current grades as soon as it gets the shader.
      this.tileShader = new CustomShader({
        fragmentShaderText: TIME_OF_DAY_SHADER,
        uniforms: {
          [RAIN_UNIFORM]: { type: UniformType.FLOAT, value: 0 },
          [CLOUD_UNIFORM]: { type: UniformType.FLOAT, value: 0 },
        },
      })
      this.weather.attachTileShader(this.tileShader)
      tileset.customShader = this.tileShader
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
   * Flies the camera so the entire route of a line is in view. The current
   * compass heading is kept – only position, height, and pitch change; the
   * distance is computed by Cesium from the route's bounding sphere.
   */
  focusLine(lineId: string): void {
    const flat = this.routes.linePoints(lineId)
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
    this.routes.startPulse(lineId)
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
   * Flies the camera to a single stop (click on an upcoming stop in the
   * vehicle card). Keeps the compass heading, like focusLine.
   */
  flyToStop(lon: number, lat: number, nhn?: number): void {
    // Same height source as the vehicles: the calibrated route-profile
    // height where the dataset has one, the measured ground otherwise.
    const groundHeight =
      this.opts.fixedGroundHeight === undefined && !this.opts.offline && nhn !== undefined
        ? nhn + this.routes.heightOffset
        : this.defaultGroundHeight
    const center = Cartesian3.fromDegrees(lon, lat, groundHeight)
    // Render at full rate during the flight (see getRenderHints)
    this.flyingUntil = performance.now() + 1800
    this.requestRender()
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(center, 0), {
      duration: 1.5,
      offset: new HeadingPitchRange(
        this.viewer.camera.heading,
        CesiumMath.toRadians(STOP_FOCUS_PITCH),
        STOP_FOCUS_RANGE,
      ),
    })
  }

  /**
   * Live weather (see WeatherOverlay): rain in mm and cloud cover in
   * percent. Both are applied per UI tick, unchanged values cost nothing.
   */
  setRain(precipitationMm: number): void {
    this.weather.setRain(precipitationMm)
  }

  setCloudCover(cloudCoverPercent: number): void {
    this.weather.setCloudCover(cloudCoverPercent)
  }

  /** Open-Meteo attribution (CC-BY 4.0) – call once when weather is enabled. */
  addWeatherCredit(): void {
    this.weather.addCredit()
  }




  /** Routes layer (see RoutesLayer) – the map only forwards. */
  addRoutes(network: PreparedNetwork): void {
    this.routes.add(network)
  }

  setRoutesVisible(visible: boolean): void {
    this.routes.setVisible(visible)
  }

  setLineRouteVisible(lineId: string, visible: boolean): void {
    this.routes.setLineVisible(lineId, visible)
  }

  /** Stops layer (see StopsLayer) – the map only forwards. */
  addStops(network: PreparedNetwork): void {
    this.stops.add(network)
  }

  setStopsVisible(visible: boolean): void {
    this.stops.setVisible(visible)
  }

  /** Line visibility drives which stops stay on the map. */
  setVisibleLines(visibleLines: ReadonlySet<string>): void {
    this.stops.setVisibleLines(visibleLines)
  }






  /**
   * One-time height bootstrapping: measures the tile heights at a small,
   * evenly spread subset of the stops (STOP_BOOTSTRAP_SAMPLES) and derives
   * the base ground height for vehicles and stops from them. Logs the result
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
    if (this.stops.count === 0) {
      window.setTimeout(() => void this.bootstrapGroundHeights(), 2000)
      return
    }
    const scene = this.viewer.scene
    if (!scene.sampleHeightSupported) {
      console.warn('[MiniRostock3D] sampleHeight is not supported by this GPU/WebGL environment')
      return
    }

    const sampleStops = this.stops.bootstrapSamples(STOP_BOOTSTRAP_SAMPLES)

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
          stop.apply(h)
        })
        if (heights.length > 0) {
          // Raise the base for all vehicles already running (the ongoing
          // per-tram sampling does the fine-tuning afterwards)
          const median = [...heights].sort((a, b) => a - b)[Math.floor(heights.length / 2)]
          this.defaultGroundHeight = median
          for (const record of this.vehicles.values()) {
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
          'vehicles will use the fallback height. Please report this message ' +
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
    if (nhnOffsets.length >= 5 && this.routes.hasHeightPieces) {
      nhnOffsets.sort((a, b) => a - b)
      const offset = nhnOffsets[Math.floor(nhnOffsets.length / 2)]
      if (offset > 20 && offset < 60) {
        this.routes.calibrateHeightOffset(offset)
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
   * The vehicles' height is set EXPLICITLY instead of via HeightReference
   * clamping (clamping entity geometries onto 3D tiles is unreliable in
   * practice, which left boxes below the photorealistic surface). The
   * height source is the direction's DGM terrain profile (snapshot `nhn` +
   * the calibrated NHN→ellipsoid offset) – the same numbers the route
   * polylines use, so vehicles and lines are congruent by construction and
   * no tileset.getHeight ray casts are needed. Vehicles without route
   * heights (approximated dataset) fall back to sampling the 3D tiles.
   */
  syncVehicles(
    snapshots: VehicleSnapshot[],
    visibleLines: ReadonlySet<string>,
  ): { anyVehicleInView: boolean } {
    this.frameCounter++
    this.stops.update()
    const alive = new Set<string>()

    // Visibility test: is at least one tram inside the camera frustum?
    // (Controls whether a re-render is needed at all.)
    const camera = this.viewer.camera
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    )
    let anyVehicleInView = false

    for (const snap of snapshots) {
      alive.add(snap.id)
      let record = this.vehicles.get(snap.id)
      if (!record) {
        record = this.createVehicleEntity(snap)
        this.vehicles.set(snap.id, record)
        this.renderRequested = true
      }

      // Entering/leaving a tunnel section toggles the 40 % ghost rendering.
      if (snap.inTunnel !== record.inTunnel) {
        record.inTunnel = snap.inTunnel
        record.appearanceDirty = true
      }
      if (record.appearanceDirty) {
        record.appearanceDirty = !this.applyVehicleAppearance(snap.id)
        if (!record.appearanceDirty) this.renderRequested = true
      }

      // GTFS-RT delay on the badge ("+2" after the line number): swap the
      // badge image whenever the rounded minute value changes. The canvases
      // are cached per line+suffix, so steady delays cost nothing per tick.
      const delaySuffix = delayBadgeSuffix(snap)
      if (delaySuffix !== record.delaySuffix) {
        record.delaySuffix = delaySuffix
        const badge = this.lineBadge(snap.lineId, record.baseColor, delaySuffix)
        const billboard = record.labelEntity.billboard
        if (badge && billboard) {
          billboard.image = new ConstantProperty(badge.canvas)
          billboard.width = new ConstantProperty(badge.width)
          billboard.height = new ConstantProperty(badge.height)
        } else if (record.labelEntity.label) {
          record.labelEntity.label.text = new ConstantProperty(
            delaySuffix ? `${snap.lineId} ${delaySuffix}` : snap.lineId,
          )
        }
        this.renderRequested = true
      }

      const show = visibleLines.has(snap.lineId)

      // Vehicle height: terrain profile of the route (NHN + calibrated
      // offset) whenever the direction carries DGM heights – deterministic,
      // congruent with the route polylines, and free of ray casts. In
      // offline mode the ground is the bare ellipsoid, where NHN heights
      // would float mid-air, so the fallback below applies there too.
      const routeGroundHeight =
        this.opts.fixedGroundHeight === undefined && !this.opts.offline && snap.nhn !== undefined
          ? snap.nhn + this.routes.heightOffset
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
      // result drives the render pacing (anyVehicleInView) and whether the
      // fallback tile-height sampling below is worth doing at all.
      let inView = false
      const cameraDistance = Cartesian3.distance(camera.positionWC, position)
      if (show && cameraDistance < VEHICLE_VISIBLE_RANGE) {
        Cartesian3.clone(position, this.frustumSphere.center)
        this.frustumSphere.radius = 80
        inView = cullingVolume.computeVisibility(this.frustumSphere) !== Intersect.OUTSIDE
        if (inView) anyVehicleInView = true
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
      // vehicle out to VEHICLE_VISIBLE_RANGE. (Checked here on the CPU – a
      // DistanceDisplayCondition attribute on the Primitive measures from
      // the instance matrix, which is identity for these boxes since the
      // position lives in the primitive's own modelMatrix.)
      const showBody = show && cameraDistance < VEHICLE_BODY_VISIBLE_RANGE
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

    for (const [id, record] of this.vehicles) {
      if (!alive.has(id)) {
        if (id === this.followId) this.setFollow(null)
        this.viewer.entities.remove(record.labelEntity)
        this.viewer.scene.primitives.remove(record.primitive)
        if (record.glow) this.viewer.scene.primitives.remove(record.glow)
        this.vehicles.delete(id)
        this.renderRequested = true
      }
    }

    return { anyVehicleInView }
  }

  /** Renders exactly one frame (the app controls the frequency). */
  render(): void {
    if (this.destroyed) return
    this.routes.updatePulse()
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
    delaySuffix = '',
  ): { canvas: HTMLCanvasElement; width: number; height: number } | undefined {
    // ??= : prototype-based test instances skip the class field initializers
    this.badgeCache ??= new Map()
    const cacheKey = delaySuffix ? `${lineId}|${delaySuffix}` : lineId
    const cached = this.badgeCache.get(cacheKey)
    if (cached) return cached
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined

    const ratio = this.effectivePixelRatio
    const font = `bold ${Math.round(14 * ratio)}px "Inter Variable", system-ui, sans-serif`
    const suffixFont = `bold ${Math.round(10 * ratio)}px "Inter Variable", system-ui, sans-serif`
    ctx.font = font
    const textWidth = ctx.measureText(lineId).width
    // GTFS-RT delay in small print after the line number ("+2")
    const suffixGap = delaySuffix ? 3 * ratio : 0
    ctx.font = suffixFont
    const suffixWidth = delaySuffix ? ctx.measureText(delaySuffix).width : 0
    const padX = 5 * ratio
    const height = Math.round(22 * ratio)
    const width = Math.max(height, Math.round(textWidth + suffixGap + suffixWidth + 2 * padX))
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
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const textX = (width - (textWidth + suffixGap + suffixWidth)) / 2
    const textY = height / 2 + 0.5 * ratio
    ctx.font = font
    ctx.fillStyle = '#ffffff'
    ctx.fillText(lineId, textX, textY)
    if (delaySuffix) {
      ctx.font = suffixFont
      ctx.fillStyle = 'rgba(255, 255, 255, 0.88)'
      ctx.fillText(delaySuffix, textX + textWidth + suffixGap, textY)
    }

    const entry = { canvas, width: width / ratio, height: height / ratio }
    this.badgeCache.set(cacheKey, entry)
    return entry
  }

  private createVehicleEntity(snap: VehicleSnapshot): VehicleRecord {
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
        id: `vehicle:${snap.id}`,
      }),
      appearance,
      asynchronous: false,
      modelMatrix: matrix,
    })
    this.viewer.scene.primitives.add(primitive)
    // IMPORTANT: Primitive CLONES the modelMatrix passed in – for the
    // in-place updates in syncVehicles, the primitive's own instance must be
    // referenced, otherwise the vehicle bodies never move.
    const liveMatrix = primitive.modelMatrix

    const labelPosition = new ConstantPositionProperty(initialPosition)
    // Badge like in the line panel: line number on a rounded rectangle in
    // the line color (pre-rendered per line, see lineBadge) – far easier
    // to spot against the photo tiles than outlined text alone. Tunnel
    // ghosting dims the whole badge via the billboard color multiplier.
    const delaySuffix = delayBadgeSuffix(snap)
    const badge = this.lineBadge(snap.lineId, color, delaySuffix)
    const labelEntity = this.viewer.entities.add({
      id: `vehicle:${snap.id}`,
      position: labelPosition,
      ...(badge
        ? {
            billboard: {
              image: badge.canvas,
              width: badge.width,
              height: badge.height,
              color: Color.WHITE.withAlpha(alpha),
              pixelOffset: new Cartesian2(0, -30),
              distanceDisplayCondition: new DistanceDisplayCondition(0, VEHICLE_VISIBLE_RANGE),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }
        : {
            // No 2D canvas (jsdom): plain outlined text label
            label: {
              text: delaySuffix ? `${snap.lineId} ${delaySuffix}` : snap.lineId,
              font: 'bold 14px "Inter Variable", system-ui, sans-serif',
              fillColor: Color.WHITE.withAlpha(alpha),
              outlineColor: color.withAlpha(alpha),
              outlineWidth: 4,
              style: LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cartesian2(0, -30),
              distanceDisplayCondition: new DistanceDisplayCondition(0, VEHICLE_VISIBLE_RANGE),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          }),
    })

    // Night-time cabin glow: pool extent = footprint plus sideways spill
    const glowScale = new Cartesian3(
      snap.vehicle.length * 1.5 + 4,
      snap.vehicle.width * 3.9,
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
        show: false, // syncVehicles turns it on at night
      })
      this.viewer.scene.primitives.add(glow)
      glowMatrix = glow.modelMatrix
    }

    return {
      primitive,
      matrix: liveMatrix,
      labelEntity,
      labelPosition,
      delaySuffix,
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
  private applyVehicleAppearance(vehicleId: string): boolean {
    const record = this.vehicles.get(vehicleId)
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
      const attributes = record.primitive.getGeometryInstanceAttributes(`vehicle:${vehicleId}`)
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

  setSelected(vehicleId: string | null): void {
    if (this.selectedId) {
      const record = this.vehicles.get(this.selectedId)
      if (record) {
        record.highlighted = false
        // Not-yet-rendered primitives are retried via appearanceDirty in
        // syncVehicles – same as tunnel transitions.
        record.appearanceDirty = !this.applyVehicleAppearance(this.selectedId)
      }
    }
    this.selectedId = vehicleId
    if (vehicleId) {
      const record = this.vehicles.get(vehicleId)
      if (record) {
        record.highlighted = true
        record.appearanceDirty = !this.applyVehicleAppearance(vehicleId)
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
  setFollow(vehicleId: string | null): void {
    this.followId = vehicleId
    this.followOffset = null
    this.followChase = vehicleId !== null
    if (!vehicleId) {
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
    const record = this.vehicles.get(vehicleId)
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
    // is already sampled on the 3D tiles and smoothed in syncVehicles).
    const record = this.followId ? this.vehicles.get(this.followId) : undefined
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

  hasVehicle(vehicleId: string): boolean {
    return this.vehicles.has(vehicleId)
  }

  /**
   * Debug/tests: maximum distance between vehicle body (primitive matrix)
   * and number label across all vehicles in meters. Must be ~0 – a larger
   * value means the vehicle bodies no longer follow the simulation.
   */
  getVehicleBoxDriftMeters(): number {
    let maxDrift = 0
    for (const record of this.vehicles.values()) {
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
  getVehicleOpacity(vehicleId: string): number | null {
    const record = this.vehicles.get(vehicleId)
    if (!record) return null
    try {
      const attributes = record.primitive.getGeometryInstanceAttributes(`vehicle:${vehicleId}`)
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

  /** Debug: current ground heights of the vehicles (for diagnosing tile heights). */
  getGroundHeights(): { id: string; groundHeight: number }[] {
    return [...this.vehicles.entries()].map(([id, record]) => ({
      id,
      groundHeight: Math.round(record.groundHeight * 10) / 10,
    }))
  }

  destroy(): void {
    this.destroyed = true
    this.resizeObserver?.disconnect()
    this.handler.destroy()
    this.weather.destroy()
    this.viewer.destroy()
  }
}
