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
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  CustomShader,
  Entity,
  GridImageryProvider,
  HeadingPitchRange,
  Ion,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Simon1994PlanetaryPositions,
  Transforms,
  UniformType,
  Viewer,
  createGooglePhotorealistic3DTileset,
  type Cesium3DTileset,
} from 'cesium'
import { config } from '@/config'
import {
  ROUTE_HEIGHT_OFFSET_FALLBACK,
  ROUTE_PULSE_DURATION_MS,
  RoutesLayer,
} from './RoutesLayer'
import { TUNNEL_VISIBILITY } from './tunnel-view'
import { StopsLayer } from './StopsLayer'
import { delayBadgeSuffix, VehicleLayer } from './VehicleLayer'
import {
  CLOUD_UNIFORM,
  RAIN_UNIFORM,
  WeatherOverlay,
} from './WeatherOverlay'
import type { PreparedNetwork } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export { TUNNEL_VISIBILITY }
export { delayBadgeSuffix }

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



/**
 * Ellipsoidal height of Rostock's streets while no tile height has been
 * measured yet (geoid undulation ~40 m + terrain height). Replaced by real
 * measurements at runtime.
 */
const FALLBACK_GROUND_HEIGHT = 45



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



/** Sine of the sun elevation where the glow starts (dusk) / is fully on. */
const GLOW_SUN_START = -0.05
const GLOW_SUN_FULL = -0.17

/**
 * How far the photo tiles are dimmed in the underground view. The value is
 * applied in the renderer's linear light, so it sits far below the share it
 * reads as on screen: measured over the map area, 0.02 lands at ~35 % of the
 * normal view's luminance, 0.055 at ~41 %, 0.1 at ~47 %.
 */
const UNDERGROUND_DIM = 0.02

/**
 * Minimum gap between two hover picks in ms. A pick is an offscreen render
 * of a small region, so one per mouse-move event would put a real cost on a
 * cursor change; ~20/s is far more than the eye needs.
 */
const HOVER_PICK_INTERVAL_MS = 50

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
  // always implies an overcast sky – whichever is stronger wins. The
  // underground view drops it: down there the weather is not the point,
  // and a graded surface only muddies the tunnels showing through.
  float overcast = max(u_cloudFactor, u_rainFactor) * (1.0 - u_underground);

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

  // Underground view: the world recedes to a dark relief at the same 20 %
  // the tunnels are drawn at otherwise. Deliberately NOT via material.alpha:
  // translucent tiles write no depth, and without depth Cesium's camera
  // cannot pick a point under the cursor – dragging then rotates the view
  // instead of moving the map. Darkening keeps the tileset opaque.
  float sunkenLum = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
  vec3 sunken = mix(material.diffuse, vec3(sunkenLum), 0.6) * u_undergroundDim
    + vec3(0.012, 0.016, 0.028);
  material.diffuse = mix(material.diffuse, sunken, u_underground);
}
`






/** Camera pitch of the "zoom to line" flight in degrees (heading is kept). */
const LINE_FOCUS_PITCH = -55

/** Camera pose after "fly to stop": distance in meters, pitch in degrees. */
const STOP_FOCUS_RANGE = 400
const STOP_FOCUS_PITCH = -55








// Scratches for the sun-elevation night factor (see updateNightFactor).
const sunPositionScratch = new Cartesian3()
const sunTransformScratch = new Matrix3()





export class CesiumMap {
  readonly viewer: Viewer
  private readonly opts: CesiumMapOptions

  /** Time-of-day shader of the Google tiles (null offline/fallback). */
  private tileShader: CustomShader | null = null
  /** Rain field and overcast grade – owns its own state (see WeatherOverlay). */
  private readonly weather: WeatherOverlay
  /** Discs, name plates, declutter and stop heights (see StopsLayer). */
  private readonly stops: StopsLayer
  /** Route polylines, their heights and the attention pulse (see RoutesLayer). */
  private readonly routes: RoutesLayer
  /** Boxes, badges, glow pools, selection and chase cam (see VehicleLayer). */
  private readonly vehicleLayer: VehicleLayer
  /** Underground view (see setUnderground). */
  private underground = false
  /** Rate limiting and last state of the hover cursor (see the MOUSE_MOVE hook). */
  private lastHoverPickAt = 0
  private hoverPickTimer: number | null = null
  private hoverPosition: Cartesian2 | null = null
  private hoveringVehicle = false
  private handler: ScreenSpaceEventHandler
  private destroyed = false
  private googleTileset: Cesium3DTileset | null = null
  /** Most recently measured plausible ground height – initial value for new vehicles. */
  private defaultGroundHeight: number
  /** Drawing-buffer pixels per CSS pixel (HiDPI rendering, capped at 2). */
  private readonly effectivePixelRatio: number
  /** 0 = day … 1 = full night; drives the cabin-glow opacity. */
  private nightFactor = 0
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
    this.vehicleLayer = new VehicleLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      sampleGroundHeight: (lon, lat) => this.sampleGroundHeight(lon, lat),
      get defaultGroundHeight() {
        return map.defaultGroundHeight
      },
      get routeHeightOffset() {
        return map.routes.heightOffset
      },
      get nightFactor() {
        return map.nightFactor
      },
      get pixelRatio() {
        return map.effectivePixelRatio
      },
      offline: opts.offline === true,
      fixedGroundHeight: opts.fixedGroundHeight,
      noteCameraFlight: (durationMs) => {
        this.flyingUntil = performance.now() + durationMs
      },
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
      this.opts.onSelectVehicle?.(this.pickVehicleId(movement.position))
    }, ScreenSpaceEventType.LEFT_CLICK)

    // Hover: turn the cursor into a pointer over a vehicle, so it reads as
    // clickable. scene.pick() renders a small offscreen region, which is
    // not free under software rendering, so the picks are rate-limited –
    // but with a trailing evaluation, never by dropping events: the last
    // move before the mouse comes to rest is exactly the one that decides
    // the cursor, and a plain throttle would swallow it.
    this.handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      this.hoverPosition = Cartesian2.clone(movement.endPosition, this.hoverPosition ?? undefined)
      if (this.hoverPickTimer !== null) return
      const wait = Math.max(0, HOVER_PICK_INTERVAL_MS - (performance.now() - this.lastHoverPickAt))
      this.hoverPickTimer = window.setTimeout(() => {
        this.hoverPickTimer = null
        this.applyHoverCursor()
      }, wait)
    }, ScreenSpaceEventType.MOUSE_MOVE)
  }

  /** Pointer over a vehicle, default cursor otherwise (see the MOUSE_MOVE hook). */
  private applyHoverCursor(): void {
    if (this.destroyed || !this.hoverPosition) return
    this.lastHoverPickAt = performance.now()
    const overVehicle = this.pickVehicleId(this.hoverPosition) !== null
    if (overVehicle === this.hoveringVehicle) return
    this.hoveringVehicle = overVehicle
    this.viewer.scene.canvas.style.cursor = overVehicle ? 'pointer' : ''
  }

  /**
   * Vehicle id under a screen position, or null. Body primitives return
   * their instance id as a string, the number label an Entity – both carry
   * the "vehicle:" prefix.
   */
  private pickVehicleId(position: Cartesian2): string | null {
    const picked = this.viewer.scene.pick(position) as { id?: unknown } | undefined
    const pickedId = picked?.id
    if (pickedId instanceof Entity && pickedId.id.startsWith('vehicle:')) {
      return pickedId.id.slice('vehicle:'.length)
    }
    if (typeof pickedId === 'string' && pickedId.startsWith('vehicle:')) {
      return pickedId.slice('vehicle:'.length)
    }
    return null
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
          u_underground: { type: UniformType.FLOAT, value: this.underground ? 1 : 0 },
          u_undergroundDim: { type: UniformType.FLOAT, value: UNDERGROUND_DIM },
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

  /** Debug/test: raindrops currently on screen. */
  getRainDropsVisible(): number {
    return this.weather.visibleDropCount
  }




  /**
   * Vehicle layer (see VehicleLayer). The stops upkeep rides on the same
   * tick – both are per-frame work the app drives through one call.
   */
  syncVehicles(
    snapshots: VehicleSnapshot[],
    visibleLines: ReadonlySet<string>,
  ): { anyVehicleInView: boolean } {
    this.stops.update()
    return this.vehicleLayer.sync(snapshots, visibleLines)
  }

  setSelected(id: string | null): void {
    this.vehicleLayer.setSelected(id)
  }

  setFollow(id: string | null): void {
    this.vehicleLayer.setFollow(id)
  }

  hasVehicle(id: string): boolean {
    return this.vehicleLayer.hasVehicle(id)
  }

  getVehicleBoxDriftMeters(): number {
    return this.vehicleLayer.getVehicleBoxDriftMeters()
  }

  getVehicleOpacity(id: string): number | null {
    return this.vehicleLayer.getVehicleOpacity(id)
  }

  /**
   * Underground view: tunnel sections and the vehicles inside them become
   * solid, while the surface – routes, vehicles and the photo tiles
   * themselves – is ghosted instead.
   */
  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    this.routes.setUnderground(underground)
    this.vehicleLayer.setUnderground(underground)
    this.stops.setUnderground(underground)
    this.tileShader?.setUniform('u_underground', underground ? 1 : 0)
    // The sky belongs to the surface: with the city sunk into a dark relief
    // a bright daylight atmosphere above it reads as an eclipse.
    const scene = this.viewer.scene
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = !underground
    this.requestRender()
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
          this.vehicleLayer.setGroundHeight(median)
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
    this.vehicleLayer.applyNightFactor(night)
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

  /**
   * Screen position of a vehicle in CSS pixels, or null when it is off
   * screen or unknown. Lets the E2E tests hover a vehicle without hunting
   * for it with scene.pick(), which is an offscreen render per call and
   * ruinous under software rendering.
   */
  getVehicleScreenPosition(id: string): { x: number; y: number } | null {
    const position = this.vehicleLayer.getVehiclePosition(id)
    if (!position) return null
    const window = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position)
    return window ? { x: window.x, y: window.y } : null
  }

  /** Debug: current ground heights of the vehicles (for diagnosing tile heights). */
  getGroundHeights(): { id: string; groundHeight: number }[] {
    return this.vehicleLayer.getGroundHeights()
  }

  destroy(): void {
    this.destroyed = true
    if (this.hoverPickTimer !== null) window.clearTimeout(this.hoverPickTimer)
    this.resizeObserver?.disconnect()
    this.handler.destroy()
    this.weather.destroy()
    this.viewer.destroy()
  }
}
