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
  createGooglePhotorealistic3DTileset,
  CustomShader,
  Entity,
  GridImageryProvider,
  HeadingPitchRange,
  Ion,
  JulianDate,
  Math as CesiumMath,
  Matrix3,
  Matrix4,
  PerspectiveFrustum,
  Rectangle,
  SceneTransforms,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  ShadowMode,
  Simon1994PlanetaryPositions,
  Transforms,
  UniformType,
  Viewer,
  type Cesium3DTileset,
} from 'cesium'
import { config } from '@/config'
import { boundingBoxCenter, type BoundingBox, type City } from '@/lib/city'
import { CameraLens, cameraFramingScale } from './CameraLens'
import { FRAMING_SCALE } from './camera-fov'
import { boundingBoxCameraLimits, clampCameraPose, type CameraLimits } from './camera-limits'
import { FERRY_ROUTE_EXTRA_LIFT, ROUTE_PULSE_DURATION_MS, RoutesLayer } from './RoutesLayer'
import { TiltShiftEffect } from './TiltShiftEffect'
import { TUNNEL_VISIBILITY } from './tunnel-view'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'
import { StopsLayer } from './StopsLayer'
import { VesselLayer } from './VesselLayer'
import { WebcamsLayer } from './WebcamsLayer'
import type { AisVessel } from '@/lib/ais-extract'
import type { Webcam } from '@/lib/webcams-extract'
import { StreetLampsLayer } from './StreetLampsLayer'
import { delayBadgeSuffix, VehicleLayer } from './VehicleLayer'
import {
  CLOUD_UNIFORM,
  overcastGrade,
  RAIN_UNIFORM,
  WeatherOverlay,
} from './WeatherOverlay'
import type { PreparedNetwork } from '@/data/network-types'
import type { StreetLampData } from '@/data/street-lamps'
import type { VehicleSnapshot } from '@/engine/simulation'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export { TUNNEL_VISIBILITY }
export { delayBadgeSuffix }

export interface CesiumMapOptions {
  /**
   * The city the map opens on: its rectangle is the camera leash, its
   * home view the first frame, its geoid offset the height first guess.
   * setCity moves the map on to another one.
   */
  city: City
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
  /**
   * Upper bound on the rain drop pool (?drops=). Visible rain pins the
   * render loop at animation rate, which the E2E rain test pays for on a
   * software renderer; a small pool exercises the same paths far cheaper.
   */
  maxRainDrops?: number
  /**
   * Whether the miniature look is on from the first frame; default
   * config.camera.miniatureDefault. A restored URL hash passes its own
   * answer here rather than switching after the fact.
   */
  tiltShift?: boolean
  onSelectVehicle?: (vehicleId: string | null) => void
  /** Click on an AIS ship, by MMSI (null = selection cleared). */
  onSelectVessel?: (mmsi: number | null) => void
  /** A webcam picture was clicked: its windy.com page, which the terms want opened. */
  onOpenWebcam?: (url: string) => void
  /** Click on a stop disc or name plate (null = click on empty map). */
  onSelectStop?: (stopId: string | null) => void
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
 * Meters of terrain a city's streets are assumed to stand above the
 * geoid while nothing better is known – the ellipsoidal ground first
 * guess is the city's geoid offset plus this. Replaced by the network's
 * own stop heights as soon as they are loaded (setGroundReference) and
 * by real tile measurements after that.
 */
const FALLBACK_TERRAIN_HEIGHT = 5

/**
 * Whether a measured ellipsoidal ground height can be a German street at
 * all: below sea level only in a harbor tunnel, above 3 km nowhere. A
 * number outside is a tile that has not loaded or a ray that hit the sky.
 */
function plausibleGroundHeight(height: number): boolean {
  return Number.isFinite(height) && height > -100 && height < 3000
}

/**
 * Seconds a flight from one city to the next takes: a few seconds for a
 * neighbor, capped so Munich to Rostock does not turn into a tour.
 */
function cityFlightSeconds(distanceMeters: number): number {
  return Math.min(8, Math.max(2.5, distanceMeters / 40_000))
}

/**
 * The rectangle the plan view frames: the drawn network with a margin
 * around it, never smaller than CITY_PLAN_MIN_HALF_SPAN in either axis.
 */
function planViewBounds(box: BoundingBox): BoundingBox {
  const lon = boundingBoxCenter(box).longitude
  const lat = boundingBoxCenter(box).latitude
  const halfWidth = Math.max(((box.east - box.west) / 2) * (1 + CITY_PLAN_MARGIN), CITY_PLAN_MIN_HALF_SPAN)
  const halfHeight = Math.max(((box.north - box.south) / 2) * (1 + CITY_PLAN_MARGIN), CITY_PLAN_MIN_HALF_SPAN)
  return {
    west: lon - halfWidth,
    east: lon + halfWidth,
    south: lat - halfHeight,
    north: lat + halfHeight,
  }
}

/**
 * Seconds the climb to the plan view takes before the lines are pulled
 * straight (see flyToCityPlan). Long enough to read as a move to another
 * way of looking at the city, short enough that it never delays it.
 */
const CITY_PLAN_FLIGHT_SECONDS = 1.4

/**
 * Air left around the drawn network in the plan view, as a share of its
 * own extent per side. Enough that a terminus does not sit on the frame
 * edge, little enough that the network still fills the view.
 */
const CITY_PLAN_MARGIN = 0.12

/**
 * Smallest half-extent the plan view frames, in degrees (~150 m). A
 * single short ferry route would otherwise be framed from a few meters
 * up, where the flight is all descent and nothing is recognizable.
 */
const CITY_PLAN_MIN_HALF_SPAN = 0.0015



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
 * Sine of the sun elevation below which vehicle shadows are switched off
 * (~3°). Near the horizon a shadow stretches to the horizon with it,
 * the shadow map's resolution is spread over that whole length, and what
 * lands on the street is a smeared band rather than a tram. Below the
 * horizon there is no light to cast one at all. Switching the map off
 * also stops paying for it through the night.
 */
const SHADOW_SUN_MIN = 0.05

/**
 * Shadow map tuning – the three knobs on the map itself, kept together.
 *
 * Cesium's defaults are built for a scene that shadows itself. Here a
 * handful of vehicle models cast onto photo tiles that already carry the
 * survey flight's own sun baked into the texture, so the shadow has to
 * read as a hint rather than as a second, contradicting light.
 *
 * SHADOW_DARKNESS is the share of light LEFT INSIDE the shadow, so
 * higher means fainter. Cesium's default 0.3 punches an almost black
 * hole into a sunlit street; 0.62 was invisible. Compared side by side
 * against the same frame at 0.30 / 0.42 / 0.52.
 *
 * SHADOW_MAX_DISTANCE is how far the shadowed volume reaches, and the
 * same number decides whether the pass runs at all (applyShadowState):
 * with no caster inside it there is nothing to draw. It reaches past
 * VEHICLE_BODY_VISIBLE_RANGE, so every vehicle drawn as a body is
 * covered; ships stay drawn out to VESSEL_RENDER_RANGE, so theirs is
 * the shadow that ends at this radius.
 *
 * SHADOW_MAP_SIZE is spread over that extent – raising the distance
 * without the pixels to go with it is what makes the edge stair-step.
 *
 * It is the size of ONE cascade. Cesium's sun shadow has four of them
 * and packs them 2×2 into a single texture, so the texture it allocates
 * is twice this on each side (ShadowMap.js, resize): 8192 here is a
 * 16384² depth texture – a gigabyte of GPU memory and the largest
 * texture most GPUs allow (Cesium halves the size where one allows
 * less). The maintainer's choice, for the edge. The alternative, 4096,
 * would be an 8192² texture of 256 MB and ~2.5 ms less per frame while
 * shadows are on (measured 2026-09-05), at half the texels per meter of
 * shadow. Since the shadowed volume ends where a caster stops spanning a
 * couple of pixels (applyShadowState), the cascades spend these texels
 * on a short range, and the edge is finer than it was at the map's old
 * 8.8 km reach.
 */
const SHADOW_DARKNESS = 0.52
const SHADOW_MAP_SIZE = 8192
const SHADOW_MAX_DISTANCE = 4000 * FRAMING_SCALE

/**
 * How wide the nearest caster's body has to be ON SCREEN, in CSS pixels,
 * before the shadow pass is worth running. The shadow of a vehicle is
 * about as wide as the vehicle; narrower than this it is a sub-pixel
 * smear the eye cannot find. The home view of a city sits ~5 km above
 * the fleet, where a tram is a pixel wide – there the pass used to cost
 * half of every frame (9.5 of 19 ms, measured 2026-09-05) to change
 * 0.026 % of the pixels. SHADOW_CASTER_WIDTH_M is the width the test
 * assumes: a tram or bus body, the narrowest thing that casts.
 *
 * The same numbers bound the shadowed volume: shadowMap.maximumDistance
 * follows the distance at which a body of that width still spans this
 * many pixels (see applyShadowState). Fragments beyond the last cascade
 * skip the shadow lookup in Cesium's receive shader, and the cascades
 * share their texels over a shorter range, so a tighter volume is both
 * cheaper and sharper.
 */
const SHADOW_MIN_CASTER_PX = 2
const SHADOW_CASTER_WIDTH_M = 2.65

/**
 * How many tiles the tileset's tree may hold before a fresh copy takes
 * its place (see replaceTileset). Cesium unloads tile CONTENT to stay
 * inside cacheBytes, but never the tree itself: an external tileset,
 * once fetched, keeps its subtree of Cesium3DTile objects for the life
 * of the tileset, and Google's globe is stitched from hundreds of
 * thousands of them. Measured 2026-09-05: a city's home view is ~31 000
 * tiles, every city visited adds ~35–45 000 more at ~3 KB each, and a
 * tour of seven cities stood at 282 000 tiles and a gigabyte of JS heap
 * – towards V8's 4 GB ceiling the collector stutters the map into
 * stop-motion, then the tab dies. Two cities' worth, generously.
 */
const TILE_TREE_LIMIT = 120_000

/**
 * How long after a city flight lands the old tileset stays up while the
 * new one is still loading the arrival view, in ms. Past this the swap
 * happens anyway – the old tileset carries the old city's tree, which
 * is the thing being got rid of, and the tiles still missing arrive in
 * the new one just as they would have in the old.
 */
const TILESET_SWAP_GRACE_MS = 6000

/**
 * A flight to a webcam picture: looking this far down, from this many
 * half-diagonals of the picture away (scaled by the lens) – the picture
 * then spans a good third of the frame.
 */
const WEBCAM_FOCUS_PITCH = -15
const WEBCAM_FOCUS_RANGE_FACTOR = 4

/** Scratches of windowPosition / metersPerCssPixel (see there). */
const windowScratch = new Cartesian2()
const pixelSizeSphere = new BoundingSphere(new Cartesian3(), 0)

/** Earth's equatorial radius in meters – the horizon dip (see horizonMayBeInView). */
const EARTH_RADIUS = 6378137

/**
 * Margin the horizon test keeps below the frame's top corners, in radians
 * (~2°): terrain and the tiles' own relief stand a little above the
 * geometric horizon, and the sky must never be missing where a strip of
 * it could show.
 */
const SKY_MARGIN_RAD = 0.035

/**
 * How much of the shadow survives the weather, as two anchor points on
 * the same 0..1 overcast grade the tiles are graded by (see
 * overcastGrade): rain always implies an overcast sky, so whichever of
 * rain and cloud cover is stronger decides.
 *
 * For orientation on that scale: a fully closed sky without rain reads
 * 0.5, the lightest drizzle 0.55, and rain from ~3 mm saturates at 1.
 * So LIGHT is roughly "overcast or drizzling" and HEAVY is "properly
 * raining". Between and beyond the anchors the strength interpolates
 * linearly; clear weather is full strength.
 *
 * Strength 1 leaves SHADOW_DARKNESS as it is, strength 0 would remove
 * the shadow entirely.
 */
const SHADOW_WEATHER_LIGHT = { overcast: 0.5, strength: 0.3 }
const SHADOW_WEATHER_HEAVY = { overcast: 1.0, strength: 0.05 }

/** Share of the shadow that survives an overcast grade of 0..1. */
export function shadowStrengthForOvercast(grade: number): number {
  const g = Math.min(1, Math.max(0, grade))
  const { overcast: lightAt, strength: lightStrength } = SHADOW_WEATHER_LIGHT
  const { overcast: heavyAt, strength: heavyStrength } = SHADOW_WEATHER_HEAVY
  if (g <= 0) return 1
  // Clear → light, then light → heavy, flat beyond the heavy anchor
  if (g <= lightAt) return 1 + (lightStrength - 1) * (g / lightAt)
  const t = Math.min(1, (g - lightAt) / Math.max(1e-6, heavyAt - lightAt))
  return lightStrength + (heavyStrength - lightStrength) * t
}

/**
 * How far the photo tiles are dimmed in the underground view. The value is
 * applied in the renderer's linear light, so it sits far below the share it
 * reads as on screen: measured over the map area, 0.02 lands at ~35 % of the
 * normal view's luminance, 0.055 at ~41 %, 0.1 at ~47 %.
 */
const UNDERGROUND_DIM = 0.02

/**
 * Minimum gap between two hover picks in ms. A pick runs the scene update
 * for a tiny frustum – every selected tile and every vehicle model still
 * has its update called – so one per mouse-move event would put a real
 * cost on a cursor change: measured 2026-09-05 at 1 ms in Rostock and
 * 7.4 ms in Berlin's morning rush. Ten a second is plenty for a cursor
 * to change under a resting mouse, and none at all are taken while a
 * button is held (the camera is being dragged, the cursor is a hand).
 */
const HOVER_PICK_INTERVAL_MS = 100

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

/**
 * The tileset's per-frame statistics – public in Cesium's JS API (the
 * inspector reads them), missing from its TS typings.
 */
function tileStatistics(tileset: Cesium3DTileset): {
  numberOfTilesTotal: number
  numberOfTilesWithContentReady: number
} {
  return (
    tileset as unknown as {
      statistics: { numberOfTilesTotal: number; numberOfTilesWithContentReady: number }
    }
  ).statistics
}





export class CesiumMap {
  readonly viewer: Viewer
  private readonly opts: CesiumMapOptions

  /** Time-of-day shader of the Google tiles (null offline/fallback). */
  private tileShader: CustomShader | null = null
  /** Rain field and overcast grade – owns its own state (see WeatherOverlay). */
  private readonly weather: WeatherOverlay
  /** Discs, name plates, declutter and stop heights (see StopsLayer). */
  private readonly stops: StopsLayer
  /** AIS harbor traffic (see VesselLayer). */
  private vesselLayer: VesselLayer
  /** Live webcams floating over their spot (see WebcamsLayer). */
  private readonly webcamsLayer: WebcamsLayer
  /** Route polylines, their heights and the attention pulse (see RoutesLayer). */
  private readonly routes: RoutesLayer
  /** Night-time light pools under the OSM street lamps (see StreetLampsLayer). */
  private readonly streetLamps: StreetLampsLayer
  /** Boxes, badges, glow pools, selection and chase cam (see VehicleLayer). */
  private readonly vehicleLayer: VehicleLayer
  /** Miniature look: band blur and toy grade (see TiltShiftEffect). */
  private readonly tiltShift: TiltShiftEffect
  /** Field of view and its dolly (see CameraLens). */
  private readonly lens: CameraLens
  /** Underground view (see setUnderground). */
  private underground = false
  /** The city on the map (see setCity). */
  private city: City
  /** Camera leash (see enforceCameraLimits); null while flying between cities. */
  private cameraLimits: CameraLimits | null
  /**
   * Which run of the height bootstrap is the current one. setCity bumps
   * it, so a run still measuring the previous city's stops throws its
   * results away instead of calibrating the new city against them.
   */
  private bootstrapGeneration = 0
  private bootstrapTimer: number | null = null
  /** The bootstrap has measured this city's ground on the tiles. */
  private groundMeasured = false
  /** Rate limiting and last state of the hover cursor (see the MOUSE_MOVE hook). */
  private lastHoverPickAt = 0
  private hoverPickTimer: number | null = null
  private hoverPosition: Cartesian2 | null = null
  private hoveringVehicle = false
  private handler: ScreenSpaceEventHandler
  private destroyed = false
  private googleTileset: Cesium3DTileset | null = null
  /**
   * A fresh copy of the tileset warming up out of sight, the frames it
   * has been given so far, and the moment it may take over regardless
   * (see replaceTileset).
   */
  private replacement: { tileset: Cesium3DTileset; swapAfter: number; frames: number } | null =
    null
  /** A replacement is on its way from Ion – one at a time. */
  private replacementInFlight = false
  /** Most recently measured plausible ground height – initial value for new vehicles. */
  private defaultGroundHeight: number
  /** Drawing-buffer pixels per CSS pixel (HiDPI rendering, capped at 2). */
  private readonly effectivePixelRatio: number
  /** 0 = day … 1 = full night; drives the cabin-glow opacity. */
  private nightFactor = 0
  /** Sun high enough for a usable shadow (see updateNightFactor). */
  private sunHighEnoughForShadows = false

  /** Weather as the shadow reads it (see applyShadowDarkness). */
  private overcast = 0
  private rainMm = 0
  private cloudPercent = 0

  /** Distance to the closest drawn caster of each fleet (see applyShadowState). */
  private nearestVehicleMeters = Number.POSITIVE_INFINITY
  private nearestVesselMeters = Number.POSITIVE_INFINITY
  /** Beam of that closest hull – how wide a shadow it can throw. */
  private nearestVesselWidthM = 10

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
  /**
   * The camera's view matrix as of the last rendered frame. A camera that
   * has moved since – a chase cam trailing its vehicle, a flight – needs a
   * frame whether or not anything else asked for one (see
   * cameraMovedSinceRender). All zeros before the first frame, which no
   * real view matrix equals.
   */
  private readonly renderedViewMatrix = new Matrix4()
  /** A pointer button is held on the canvas – the camera is being dragged. */
  private pointerDown = false
  private resizeObserver: ResizeObserver | null = null
  private readonly noteInteraction = () => {
    this.lastInteractionAt = performance.now()
  }
  private readonly onPointerDown = () => {
    this.pointerDown = true
    this.noteInteraction()
  }
  private readonly onPointerUp = () => {
    this.pointerDown = false
  }

  constructor(container: HTMLElement, opts: CesiumMapOptions) {
    this.opts = opts
    this.city = opts.city
    // Offline (ellipsoid): ground is exactly at 0 m
    this.defaultGroundHeight =
      opts.fixedGroundHeight ?? (opts.offline ? 0 : this.groundFirstGuess(opts.city))

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
      // Vehicles and ships cast a sun shadow onto the photo tiles. Only
      // they do: the tileset receives but never casts (see
      // loadGoogleTiles), so the shadow pass draws a few dozen small
      // models instead of the whole city. Starts off and is switched on
      // per tick only while a caster is in reach – see applyShadowState.
      shadows: false,
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
    this.weather = new WeatherOverlay(
      this.viewer,
      () => this.requestRender(),
      opts.maxRainDrops,
    )
    this.routes = new RoutesLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      offline: opts.offline === true,
    })
    this.routes.resetHeightOffset(opts.city.terrain.geoidOffsetFallback)
    this.streetLamps = new StreetLampsLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      get nightFactor() {
        return map.nightFactor
      },
      groundHeightForNhn: (nhn) =>
        opts.fixedGroundHeight === undefined && !opts.offline
          ? nhn + map.routes.heightOffset
          : map.defaultGroundHeight,
    })
    this.vehicleLayer = new VehicleLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      obstacles: () => map.webcamsLayer.screenRects,
      windowPosition: (position) => this.windowPosition(position),
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
      obstacles: () => map.webcamsLayer.screenRects,
      obstaclesVersion: () => map.webcamsLayer.screenRectsVersion,
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
    this.vesselLayer = new VesselLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      obstacles: () => map.webcamsLayer.screenRects,
      windowPosition: (position) => this.windowPosition(position),
      // Water level like the ferry routes: NHN 0 plus the calibrated
      // offset plus the same lift that clears the tiles' wavy water mesh.
      get waterSurfaceHeight() {
        return map.routes.heightOffset + FERRY_ROUTE_EXTRA_LIFT
      },
      get pixelRatio() {
        return map.effectivePixelRatio
      },
      noteCameraFlight: (durationMs) => {
        this.flyingUntil = performance.now() + durationMs
      },
    })
    this.webcamsLayer = new WebcamsLayer(this.viewer, {
      requestRender: () => this.requestRender(),
      sampleGroundHeight: (lon, lat) => this.sampleGroundHeight(lon, lat),
      get defaultGroundHeight() {
        return map.defaultGroundHeight
      },
      windowPosition: (position) => this.windowPosition(position),
      metersPerPixel: (position) => this.metersPerCssPixel(position),
    })
    // The miniature look this whole map is named after – on or off from
    // the start as the URL or config.camera.miniatureDefault says, and
    // switched from the panel like the layers are. It costs nothing at the
    // poses where it would look wrong: the ramps in TiltShiftEffect.update
    // disable the stages outright.
    const miniature = opts.tiltShift ?? config.camera.miniatureDefault
    this.tiltShift = new TiltShiftEffect(this.viewer, () => this.defaultGroundHeight)
    this.tiltShift.setEnabled(miniature)

    const shadowMap = scene.shadowMap
    shadowMap.darkness = SHADOW_DARKNESS
    shadowMap.softShadows = false
    shadowMap.size = SHADOW_MAP_SIZE
    shadowMap.maximumDistance = SHADOW_MAX_DISTANCE

    // The lens: narrow while the miniature look is on, plain while it is
    // off (see config.camera and CameraLens). Built wearing the starting
    // look, before the home view is flown – that flight measures its
    // distance against the angle in force.
    this.lens = new CameraLens(
      this.viewer,
      {
        requestRender: () => this.requestRender(),
        applyDistanceFactor: (factor) => this.applyLensDistance(factor),
      },
      miniature,
    )

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

    // Zoom-out stop for wheel and pinch. Cesium measures this as the
    // distance to the point under the cursor, not as a height, so on a
    // tilted view the wheel comes to rest a little below the ceiling –
    // it only makes the gesture end softly. The height itself is capped
    // per frame (see enforceCameraLimits).
    scene.screenSpaceCameraController.maximumZoomDistance =
      config.cameraLimits.maxHeightMeters
    // The leash itself: the city's bounding box (the city limits plus
    // its padding – the rectangle the data pipeline and the AIS
    // subscription share) and the height ceiling. The fence runs after
    // the camera controller has moved the camera (scene.initializeFrame)
    // and before the frame is drawn, so a pose outside the leash never
    // reaches the screen.
    this.cameraLimits = boundingBoxCameraLimits(
      opts.city.boundingBox,
      config.cameraLimits.maxHeightMeters,
    )
    scene.preUpdate.addEventListener(() => this.enforceCameraLimits())

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
    // pointerdown also marks the drag the hover pick sits out (see the
    // MOUSE_MOVE hook); the release can land anywhere, hence the window.
    canvas.addEventListener('pointerdown', this.onPointerDown)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
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
      const target = this.pickTarget(movement.position)
      if (target?.type === 'vehicle') {
        this.opts.onSelectVehicle?.(target.id)
      } else if (target?.type === 'stop') {
        this.opts.onSelectStop?.(target.id)
      } else if (target?.type === 'vessel') {
        this.opts.onSelectVessel?.(Number(target.id))
      } else if (target?.type === 'webcam') {
        // A picture leads to its page; whatever is selected stays so
        const url = this.webcamsLayer.detailUrl(Number(target.id))
        if (url) this.opts.onOpenWebcam?.(url)
      } else {
        // Empty map clears whichever selection is up
        this.opts.onSelectVehicle?.(null)
        this.opts.onSelectStop?.(null)
        this.opts.onSelectVessel?.(null)
      }
    }, ScreenSpaceEventType.LEFT_CLICK)

    // Hover: turn the cursor into a pointer over a vehicle, so it reads as
    // clickable. scene.pick() renders a small offscreen region, which is
    // not free under software rendering, so the picks are rate-limited –
    // but with a trailing evaluation, never by dropping events: the last
    // move before the mouse comes to rest is exactly the one that decides
    // the cursor, and a plain throttle would swallow it.
    this.handler.setInputAction((movement: { endPosition: Cartesian2 }) => {
      // Dragging the camera: the cursor is busy and every pick would be
      // paid for on a scene that is moving anyway. The first move after
      // the release picks again.
      if (this.pointerDown) return
      this.hoverPosition = Cartesian2.clone(movement.endPosition, this.hoverPosition ?? undefined)
      if (this.hoverPickTimer !== null) return
      const wait = Math.max(0, HOVER_PICK_INTERVAL_MS - (performance.now() - this.lastHoverPickAt))
      this.hoverPickTimer = window.setTimeout(() => {
        this.hoverPickTimer = null
        this.applyHoverCursor()
      }, wait)
    }, ScreenSpaceEventType.MOUSE_MOVE)
  }

  /** Pointer over a vehicle or stop, default cursor otherwise (see MOUSE_MOVE). */
  private applyHoverCursor(): void {
    if (this.destroyed || !this.hoverPosition) return
    this.lastHoverPickAt = performance.now()
    const overTarget = this.pickTarget(this.hoverPosition) !== null
    if (overTarget === this.hoveringVehicle) return
    this.hoveringVehicle = overTarget
    this.viewer.scene.canvas.style.cursor = overTarget ? 'pointer' : ''
  }

  /**
   * Selectable object under a screen position, or null. Vehicle body
   * primitives return their instance id as a string, the number label an
   * Entity – both carry the "vehicle:" prefix. Stop discs and name plates
   * are billboards whose id is the "stop:"-prefixed stop id, and AIS hulls
   * and their name labels the "vessel:"-prefixed MMSI.
   */
  private pickTarget(
    position: Cartesian2,
  ): { type: 'vehicle' | 'stop' | 'vessel' | 'webcam'; id: string } | null {
    const picked = this.viewer.scene.pick(position) as { id?: unknown } | undefined
    const pickedId = picked?.id
    const raw =
      pickedId instanceof Entity ? pickedId.id : typeof pickedId === 'string' ? pickedId : null
    if (raw === null) return null
    if (raw.startsWith('vehicle:')) return { type: 'vehicle', id: raw.slice('vehicle:'.length) }
    if (raw.startsWith('stop:')) return { type: 'stop', id: raw.slice('stop:'.length) }
    if (raw.startsWith('vessel:')) return { type: 'vessel', id: raw.slice('vessel:'.length) }
    if (raw.startsWith('webcam:')) return { type: 'webcam', id: raw.slice('webcam:'.length) }
    return null
  }

  /**
   * A tileset the way this map wants it: Google's photorealistic tiles
   * with the collision, shadow, LOD and memory settings below and the
   * shared time-of-day shader. Built once at startup (loadGoogleTiles)
   * and again for every replacement (replaceTileset), so the two can
   * never drift apart. Not yet on the scene – the caller decides when.
   */
  private async createTileset(): Promise<Cesium3DTileset> {
    const tileset = await createGooglePhotorealistic3DTileset()
    // enableCollision: prevents the camera from getting below the tiles
    tileset.enableCollision = true
    // Receives the vehicles' shadows, casts none of its own: the photo
    // texture already contains the survey flight's own shadows, and a
    // second set from the simulated sun would contradict them building
    // by building. It is also what keeps the shadow pass cheap.
    tileset.shadows = ShadowMode.RECEIVE_ONLY
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
    // One shader for every tileset this map ever holds: the two overcast
    // uniforms are driven by the weather overlay, which pushes its current
    // grades as soon as it gets the shader, the underground flag is set on
    // it as well – a replacement inherits all of it with the object.
    this.tileShader ??= new CustomShader({
      fragmentShaderText: TIME_OF_DAY_SHADER,
      uniforms: {
        [RAIN_UNIFORM]: { type: UniformType.FLOAT, value: 0 },
        [CLOUD_UNIFORM]: { type: UniformType.FLOAT, value: 0 },
        u_underground: { type: UniformType.FLOAT, value: this.underground ? 1 : 0 },
        u_undergroundDim: { type: UniformType.FLOAT, value: UNDERGROUND_DIM },
      },
    })
    tileset.customShader = this.tileShader
    return tileset
  }

  private async loadGoogleTiles(): Promise<void> {
    try {
      const tileset = await this.createTileset()
      if (this.destroyed) {
        tileset.destroy()
        return
      }
      this.weather.attachTileShader(this.tileShader)
      this.googleTileset = tileset
      this.viewer.scene.primitives.add(tileset)
      // The globe would render twice underneath the photorealistic tiles
      this.viewer.scene.globe.show = false
      this.requestRender()
      this.opts.onTilesetStatus?.('google-3d-tiles')
      this.scheduleGroundBootstrap(2000)
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

  /**
   * Starts a fresh copy of the tileset that loads out of sight and takes
   * the current one's place once it holds the current view – or after
   * `deadlineMs`, whichever comes first (see tendTileset).
   *
   * Why replace a tileset at all: Cesium's tile cache unloads content,
   * never the tree of tile objects, so a session that moves from city to
   * city keeps every subtree it ever touched until the tab runs out of
   * heap (see TILE_TREE_LIMIT). Destroying the tileset is the one way to
   * let a tree go, and a hidden replacement warming up first is what
   * keeps the swap from showing as a blank city.
   *
   * One at a time: a call while one is under way only moves its deadline
   * closer, never further. A failed creation (network) keeps the old
   * tileset and tries again on the next occasion.
   */
  private replaceTileset(deadlineMs: number): void {
    if (this.destroyed || !this.googleTileset) return
    if (this.replacement) {
      this.armTilesetSwap(deadlineMs)
      return
    }
    if (this.replacementInFlight) return
    this.replacementInFlight = true
    const swapAfter = performance.now() + deadlineMs
    void this.createTileset()
      .then((tileset) => {
        this.replacementInFlight = false
        if (this.destroyed) {
          tileset.destroy()
          return
        }
        tileset.show = false
        tileset.preloadWhenHidden = true
        this.viewer.scene.primitives.add(tileset)
        this.replacement = { tileset, swapAfter, frames: 0 }
        this.requestRender()
      })
      .catch((error: unknown) => {
        this.replacementInFlight = false
        // The current one stays, flight preloads and all (see setCity)
        if (this.googleTileset) this.googleTileset.preloadFlightDestinations = true
        console.warn('[MiniGermany3D] Tileset rebuild failed, keeping the current one:', error)
      })
  }

  /** Brings a running replacement's deadline forward to `inMs` from now. */
  private armTilesetSwap(inMs: number): void {
    const swapAfter = performance.now() + inMs
    if (this.replacement) {
      this.replacement.swapAfter = Math.min(this.replacement.swapAfter, swapAfter)
    } else {
      this.replaceTileset(inMs)
    }
  }

  /**
   * Per rendered frame: swaps a replacement in once it is ready, and
   * starts one when the tree has outgrown its limit. Ready means the
   * hidden tileset reports every tile of the current view loaded – its
   * traversal only advances with rendered frames, which getRenderHints
   * keeps coming, and tilesLoaded reads true before the first traversal
   * has requested anything, hence the few frames of patience.
   */
  private tendTileset(): void {
    const current = this.googleTileset
    if (!current) return
    const replacement = this.replacement
    if (replacement) {
      replacement.frames++
      const { tileset } = replacement
      const ready =
        replacement.frames >= 3 &&
        tileset.tilesLoaded &&
        tileStatistics(tileset).numberOfTilesWithContentReady > 0
      if (!ready && performance.now() < replacement.swapAfter) return
      this.replacement = null
      tileset.preloadWhenHidden = false
      tileset.show = true
      this.googleTileset = tileset
      // remove() destroys the old tileset, tree and all
      this.viewer.scene.primitives.remove(current)
      this.requestRender()
      return
    }
    if (tileStatistics(current).numberOfTilesTotal > TILE_TREE_LIMIT) {
      // Swap when the copy has caught up with the view; a minute at most
      this.replaceTileset(60_000)
    }
  }

  /** The city on the map. */
  get currentCity(): City {
    return this.city
  }

  /**
   * Moves the map on to another city: the leash, the home view and the
   * height first guesses become that city's. 'jump' puts the camera on
   * the new home view at once (a link opened, a hash edited); 'fly' lifts
   * the leash and flies there, and only on arrival does the new leash
   * take over – the camera has to cross both fences to get from one
   * city to the other. The layers of the city left behind are the
   * caller's to clear (clearCity), before or after – the flight does not
   * care.
   */
  setCity(city: City, transition: 'jump' | 'fly'): void {
    this.city = city
    // Sun elevation reference and height bootstrap belong to the place
    this.cityUp = null
    this.bootstrapGeneration++
    this.groundMeasured = false
    if (this.bootstrapTimer !== null) {
      window.clearTimeout(this.bootstrapTimer)
      this.bootstrapTimer = null
    }
    if (this.opts.fixedGroundHeight === undefined) {
      this.defaultGroundHeight = this.opts.offline ? 0 : this.groundFirstGuess(city)
      this.vehicleLayer.setGroundHeight(this.defaultGroundHeight)
    }
    this.routes.resetHeightOffset(city.terrain.geoidOffsetFallback)
    const limits = boundingBoxCameraLimits(city.boundingBox, config.cameraLimits.maxHeightMeters)
    if (transition === 'jump') {
      this.cameraLimits = limits
      this.setCameraHome(false)
      // A fresh tileset for the new place, at once: the old one would
      // load the same tiles for the same view, on top of the tree it
      // carries from the place left behind (see replaceTileset).
      this.replaceTileset(0)
      this.scheduleGroundBootstrap(500)
      return
    }
    // Off the leash for the flight: the fence runs per frame and would
    // pull the camera back to the old city's border on the first one.
    this.cameraLimits = null
    const { heading, pitch } = city.home
    const orientation = {
      heading: CesiumMath.toRadians(heading),
      pitch: CesiumMath.toRadians(pitch),
      roll: 0,
    }
    const destination = this.homePosition(orientation.heading, orientation.pitch)
    const duration = cityFlightSeconds(
      Cartesian3.distance(this.viewer.camera.positionWC, destination),
    )
    this.flyingUntil = performance.now() + duration * 1000 + 500
    this.requestRender()
    const arrive = () => {
      // A later setCity has taken over; its own flight ends its own way.
      if (this.destroyed || this.city !== city) return
      this.cameraLimits = limits
      this.enforceCameraLimits()
      // The city left behind is not coming back, and neither is its tile
      // tree: the fresh tileset started with the flight takes over as
      // soon as it has the arrival view, or after the grace period.
      this.armTilesetSwap(TILESET_SWAP_GRACE_MS)
      this.scheduleGroundBootstrap(500)
      this.requestRender()
    }
    // The replacement loads the destination out of sight during the
    // flight (preloadWhenHidden + preloadFlightDestinations), so the
    // arrival finds its tiles there – not blank where the old tileset
    // would have had them. The old one gives up preloading the same
    // destination: it is not going to show it, and its tree is the big
    // one to traverse – with both of them at it, the flight cost ~25
    // points more of the main thread (measured 2026-09-05). Should the
    // replacement fail to come, replaceTileset hands the job back.
    if (this.googleTileset) this.googleTileset.preloadFlightDestinations = false
    this.replaceTileset(duration * 1000 + 500 + TILESET_SWAP_GRACE_MS)
    this.viewer.camera.flyTo({ destination, orientation, duration, complete: arrive, cancel: arrive })
  }

  /**
   * Takes everything that belongs to the city off the map – routes,
   * stops, lamps, vehicles – so another city's can go up. The AIS fleet
   * is the app's: it syncs the next city's ships in on its next tick.
   */
  clearCity(): void {
    this.vehicleLayer.clear()
    this.webcamsLayer.clear()
    this.stops.clear()
    this.routes.clear()
    this.streetLamps.clear()
    this.nearestVehicleMeters = Number.POSITIVE_INFINITY
    this.applyShadowState()
    this.requestRender()
  }

  /**
   * A better ground first guess than the city's geoid offset alone: the
   * median terrain height of the network's stops, once the network is
   * loaded. Ignored after the bootstrap has measured the real ground
   * on the tiles – a measurement beats an estimate.
   */
  setGroundReference(medianStopNhn: number): void {
    if (this.opts.fixedGroundHeight !== undefined || this.opts.offline || this.groundMeasured) return
    this.defaultGroundHeight = medianStopNhn + this.routes.heightOffset
    this.vehicleLayer.setGroundHeight(this.defaultGroundHeight)
  }

  /** Ellipsoidal ground height of a city's streets before anything is measured. */
  private groundFirstGuess(city: City): number {
    return city.terrain.geoidOffsetFallback + FALLBACK_TERRAIN_HEIGHT
  }

  setCameraHome(animate = true): void {
    const { heading, pitch } = this.city.home
    const orientation = {
      heading: CesiumMath.toRadians(heading),
      pitch: CesiumMath.toRadians(pitch),
      roll: 0,
    }
    const destination = this.homePosition(orientation.heading, orientation.pitch)
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
   * Puts the camera straight above the city, looking down at as much of
   * it as the height ceiling allows.
   *
   * This is the view the linear diagram is entered from. The morph starts
   * from where the map has each line on screen, so the lines want to be
   * on screen when it begins – and a plan of the whole city is also the
   * reading closest to the diagram, which is what makes the straightening
   * legible rather than a jump (see map/LinearView.ts).
   *
   * The compass heading is kept, like every other flight here; only the
   * pitch and the position change. `onArrive` runs whether the flight
   * finished or the viewer cut it short, so nothing waits on a camera
   * that has stopped moving.
   */
  flyToCityPlan(lineIds: Iterable<string>, onArrive?: () => void, animate = true): void {
    const camera = this.viewer.camera
    // What is drawn, not what the city limits say – with two lines
    // switched on the diagram is about those two, and framing their city
    // would start the morph from a network the size of a thumbnail. The
    // limits are the fallback for a map that has no routes on it yet.
    const bounds = planViewBounds(this.routes.linesExtent(lineIds) ?? this.city.cityBounds)
    const center = boundingBoxCenter(bounds)
    // The height the whole city fits at, as Cesium derives it from the
    // frustum – then held under the ceiling the leash enforces per frame,
    // which for a city the size of Hamburg is where it lands.
    const framed = Cartographic.fromCartesian(
      camera.getRectangleCameraCoordinates(
        Rectangle.fromDegrees(bounds.west, bounds.south, bounds.east, bounds.north),
      ),
    )
    const height = Math.min(framed.height, config.cameraLimits.maxHeightMeters)
    const destination = Cartesian3.fromDegrees(center.longitude, center.latitude, height)
    const orientation = { heading: camera.heading, pitch: -CesiumMath.PI_OVER_TWO, roll: 0 }
    if (!animate) {
      camera.setView({ destination, orientation })
      this.enforceCameraLimits()
      this.requestRender()
      onArrive?.()
      return
    }
    this.flyingUntil = performance.now() + CITY_PLAN_FLIGHT_SECONDS * 1000 + 200
    this.requestRender()
    const arrive = () => {
      if (this.destroyed) return
      onArrive?.()
    }
    camera.flyTo({
      destination,
      orientation,
      duration: CITY_PLAN_FLIGHT_SECONDS,
      // Straight there: Cesium arcs a long flight upwards, and a peak
      // above the ceiling would be pulled back down by the leash on every
      // frame of it.
      maximumHeight: Math.max(height, camera.positionCartographic.height),
      complete: arrive,
      cancel: arrive,
    })
  }

  /**
   * Where the home view's camera stands. city.home names the ground
   * point the view is centered on, and the camera sits behind it against
   * the heading, `above` meters up and above/tan(pitch) meters back: the
   * pitch's own triangle.
   *
   * The height was framed at Cesium's 60°, and a narrower angle needs
   * more distance for the same ground. That distance is added along the
   * VIEW AXIS, so the aim point stays put and only the camera steps back
   * – a taller camera over the same spot would frame a different part of
   * the city instead.
   */
  private homePosition(heading: number, pitch: number): Cartesian3 {
    const { longitude, latitude, height } = this.city.home
    const above = height - this.defaultGroundHeight
    const forward = above / Math.tan(-pitch)
    // A camera looking at the horizon (tan → ∞) has no ground point to
    // aim at – stand it over the center instead.
    if (!Number.isFinite(forward)) return Cartesian3.fromDegrees(longitude, latitude, height)
    const scale = cameraFramingScale(this.viewer.camera)
    const aim = Cartesian3.fromDegrees(longitude, latitude, this.defaultGroundHeight)
    const enu = Transforms.eastNorthUpToFixedFrame(aim, undefined, new Matrix4())
    return Matrix4.multiplyByPoint(
      enu,
      new Cartesian3(
        -forward * scale * Math.sin(heading),
        -forward * scale * Math.cos(heading),
        above * scale,
      ),
      new Cartesian3(),
    )
  }

  /**
   * Pulls the camera back inside the leash – the city's bounding box and
   * the height ceiling (see the constructor). Runs per frame, and in the
   * normal case – camera inside – costs three comparisons and nothing
   * else. setView calls it too, so a pose restored from a shared link
   * never stands outside the fence, not even for a frame. No leash while
   * the camera is flying to another city (see setCity).
   */
  private enforceCameraLimits(): void {
    if (!this.cameraLimits) return
    const camera = this.viewer.camera
    // Follow mode parks the camera in the followed vehicle's local frame
    // (camera.lookAt), where setView would read world coordinates as local
    // ones. No fence needed there: the camera hangs on a vehicle that runs
    // inside the network, and maximumZoomDistance caps how far it can
    // orbit away from it.
    if (!Matrix4.equals(camera.transform, Matrix4.IDENTITY)) return
    const clamped = clampCameraPose(camera.positionCartographic, this.cameraLimits)
    if (!clamped) return
    camera.setView({
      destination: Cartesian3.fromRadians(clamped.longitude, clamped.latitude, clamped.height),
      orientation: { heading: camera.heading, pitch: camera.pitch, roll: camera.roll },
    })
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
    // The badges of the other lines step aside for the same span, so they
    // do not cover the route the pulse is pointing at.
    this.vehicleLayer.startLineFocus(lineId, ROUTE_PULSE_DURATION_MS)
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
        STOP_FOCUS_RANGE * cameraFramingScale(this.viewer.camera),
      ),
    })
  }

  /**
   * Live weather (see WeatherOverlay): rain in mm and cloud cover in
   * percent. Both are applied per UI tick, unchanged values cost nothing.
   */
  setRain(precipitationMm: number): void {
    this.weather.setRain(precipitationMm)
    this.rainMm = precipitationMm
    this.applyShadowDarkness()
  }

  setCloudCover(cloudCoverPercent: number): void {
    this.weather.setCloudCover(cloudCoverPercent)
    this.cloudPercent = cloudCoverPercent
    this.applyShadowDarkness()
  }

  /**
   * Weakens the vehicle shadows with the weather. A sunlit street casts
   * a crisp shadow; under a closed sky the light is diffuse and the
   * shadow is a hint; in real rain there is barely one at all.
   *
   * The shadow map has no per-object strength, so this rides `darkness`
   * – the share of light left INSIDE the shadow. Full strength keeps
   * SHADOW_DARKNESS, less strength lifts it toward 1, which is no shadow.
   */
  private applyShadowDarkness(): void {
    const grade = overcastGrade(this.rainMm, this.cloudPercent)
    if (Math.abs(grade - this.overcast) < 0.005) return
    this.overcast = grade
    this.viewer.scene.shadowMap.darkness =
      1 - (1 - SHADOW_DARKNESS) * shadowStrengthForOvercast(grade)
    this.requestRender()
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
  ): {
    anyVehicleInView: boolean
    nearestBodyMeters: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    this.stops.update()
    const info = this.vehicleLayer.sync(snapshots, visibleLines)
    this.nearestVehicleMeters = info.nearestBodyMeters
    this.applyShadowState()
    return info
  }

  /**
   * The on-screen motion (CSS px) at which the layers ask for a frame –
   * the app paces its ticks against it (see screen-motion.ts).
   */
  get motionThresholdCssPx(): number {
    return motionThresholdCssPx(this.effectivePixelRatio)
  }

  /**
   * Whether the camera has moved since the last rendered frame – the chase
   * cam trailing its vehicle, a flight, a leash correction. The app draws
   * a frame for it whether or not anything else asked for one.
   */
  cameraMovedSinceRender(): boolean {
    return !Matrix4.equals(this.viewer.camera.viewMatrix, this.renderedViewMatrix)
  }

  /** A chase cam is engaged on a vehicle or a ship – the camera moves per tick. */
  isChasing(): boolean {
    return this.vehicleLayer.followedId !== null || this.vesselLayer.followedMmsi !== null
  }

  /**
   * How far out a body `widthMeters` across still spans SHADOW_MIN_CASTER_PX
   * on screen – the distance a shadow of that width is worth drawing to.
   * Capped at the map's own reach; the whole reach where the camera cannot
   * say (no perspective frustum, no canvas).
   */
  private shadowReachMeters(widthMeters: number): number {
    const pxPerMeterAtUnit = cssPixelsPerMeterAtUnitDistance(this.viewer)
    if (!Number.isFinite(pxPerMeterAtUnit)) return SHADOW_MAX_DISTANCE
    return Math.min(SHADOW_MAX_DISTANCE, (widthMeters * pxPerMeterAtUnit) / SHADOW_MIN_CASTER_PX)
  }

  /**
   * The sun shadow map is only worth having on while something can cast
   * into it: a caster near enough that its shadow spans a couple of
   * pixels (see SHADOW_MIN_CASTER_PX) AND a sun high enough to throw a
   * usable shadow. Off, it costs nothing; on, every fragment of the
   * full-screen tileset samples the cascade textures whether or not a
   * caster exists – half of every frame in the home view, where the
   * fleet is kilometers away and its shadows sub-pixel.
   *
   * Both fleets count, each with its own width. Keying on the vehicles
   * alone left a 200 m freighter under the camera casting nothing in the
   * harbour, where no tram is ever within range; keying on the tram's
   * width alone would cut that freighter's 20 m wide shadow off where a
   * tram's would have become invisible.
   *
   * While the shadows are on, the shadowed volume follows the same
   * reach: fragments beyond the last cascade skip the lookup in Cesium's
   * receive shader, and the cascades share their texels over the shorter
   * range – cheaper and sharper at once. Re-set only on a real change,
   * so the shadow map is not disturbed for a pixel of drift.
   *
   * The underground view switches them off wholesale: down there the sky
   * is gone, the city is a dark relief, and the surface fleet has left
   * with it – a sun shadow would be light from a sun nobody can see.
   */
  private applyShadowState(): void {
    const vehicleReach = this.shadowReachMeters(SHADOW_CASTER_WIDTH_M)
    const vesselReach = this.shadowReachMeters(this.nearestVesselWidthM)
    const vehiclesCast = this.nearestVehicleMeters < vehicleReach
    const vesselsCast = this.nearestVesselMeters < vesselReach
    const wanted =
      !this.underground && (vehiclesCast || vesselsCast) && this.sunHighEnoughForShadows
    const shadowMap = this.viewer.scene.shadowMap
    if (wanted) {
      const reach = Math.max(vehiclesCast ? vehicleReach : 0, vesselsCast ? vesselReach : 0)
      if (Math.abs(shadowMap.maximumDistance - reach) > reach * 0.05) {
        shadowMap.maximumDistance = reach
        this.requestRender()
      }
    }
    if (this.viewer.shadows === wanted) return
    this.viewer.shadows = wanted
    this.requestRender()
  }

  setSelected(id: string | null): void {
    this.vehicleLayer.setSelected(id)
  }

  setFollow(id: string | null): void {
    // One camera between the two layers, so every change of mind has to
    // release the other one – including a release, which is where this
    // used to go wrong: clearing the vehicle follow left a still-engaged
    // ship chase behind, and the next tick threw the camera into orbit.
    this.vesselLayer.setFollow(null)
    this.vehicleLayer.setFollow(id)
  }

  /**
   * Follow an AIS ship, or nobody. A camera cannot chase a tram and a
   * freighter at once, so this releases the vehicle side either way –
   * see setFollow above for why "either way" matters.
   */
  setFollowVessel(mmsi: number | null): void {
    this.vehicleLayer.setFollow(null)
    this.vesselLayer.setFollow(mmsi)
  }

  hasVessel(mmsi: number): boolean {
    return this.vesselLayer.hasVessel(mmsi)
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
  /** Per-tick update of the AIS harbor traffic (see VesselLayer). */
  /** The city's webcams as last polled (see WebcamsLayer.sync). */
  syncWebcams(webcams: Webcam[]): void {
    this.webcamsLayer.sync(webcams)
  }

  /** Cameras on the map – tests and the debug API. */
  getWebcamCount(): number {
    return this.webcamsLayer.count
  }

  /** The panel's Webcams switch (see WebcamsLayer.setVisible). */
  setWebcamsVisible(visible: boolean): void {
    this.webcamsLayer.setVisible(visible)
  }

  /**
   * Flies to a camera's picture: level with it, looking slightly down,
   * far enough back for the picture to fill a good part of the frame.
   * A camera not on the map (or a picture not loaded yet) is left alone.
   */
  flyToWebcam(id: number): void {
    const target = this.webcamsLayer.focusTarget(id)
    if (!target) return
    this.flyingUntil = performance.now() + 1800
    this.requestRender()
    this.viewer.camera.flyToBoundingSphere(new BoundingSphere(target.center, target.radius), {
      duration: 1.5,
      offset: new HeadingPitchRange(
        this.viewer.camera.heading,
        CesiumMath.toRadians(WEBCAM_FOCUS_PITCH),
        target.radius * WEBCAM_FOCUS_RANGE_FACTOR * cameraFramingScale(this.viewer.camera),
      ),
    })
  }

  syncVessels(
    vessels: AisVessel[],
    nowMs: number,
  ): { anyMovingVesselInView: boolean; maxScreenMotionPx: number; maxTickMotionPx: number } {
    const info = this.vesselLayer.sync(vessels, nowMs)
    this.nearestVesselMeters = info.nearestHullMeters
    this.nearestVesselWidthM = info.nearestHullWidthM
    return info
  }

  getVesselCount(): number {
    return this.vesselLayer.vesselCount
  }

  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    this.applyShadowState()
    this.routes.setUnderground(underground)
    this.vehicleLayer.setUnderground(underground)
    // The AIS fleet is surface scenery – it leaves with the sky.
    this.vesselLayer.setVisible(!underground)
    this.webcamsLayer.setUnderground(underground)
    this.stops.setUnderground(underground)
    this.streetLamps.setUnderground(underground)
    this.tileShader?.setUniform('u_underground', underground ? 1 : 0)
    // The sky belongs to the surface: with the city sunk into a dark relief
    // a bright daylight atmosphere above it reads as an eclipse.
    this.updateSkyVisibility()
    this.requestRender()
  }

  /**
   * Draws the sky atmosphere only while the sky can be in the frame.
   * Cesium renders it every frame with no visibility test of its own – a
   * full-screen scattering pass, ~2 ms of the home view's 19 (measured
   * 2026-09-05) – even with the camera pitched down onto a city that
   * covers every pixel. The underground view hides it regardless (see
   * setUnderground). Called per rendered frame from render(): the pose
   * is what it depends on, and a pose change always brings a frame.
   */
  private updateSkyVisibility(): void {
    const sky = this.viewer.scene.skyAtmosphere
    if (!sky) return
    const show = !this.underground && this.horizonMayBeInView()
    if (sky.show !== show) sky.show = show
  }

  /**
   * Whether any ray of the view frustum reaches up to the horizon: the
   * camera's pitch plus the frustum's half-diagonal (its corners look
   * higher than the middle of its top edge) against the horizon's dip
   * below the horizontal at the camera's height, with a margin. True
   * whenever the camera cannot tell – then the sky is drawn as before.
   */
  private horizonMayBeInView(): boolean {
    const camera = this.viewer.camera
    const frustum = camera.frustum
    if (!(frustum instanceof PerspectiveFrustum)) return true
    const { fovy, aspectRatio } = frustum
    if (fovy === undefined || aspectRatio === undefined) return true
    const tanY = Math.tan(fovy / 2)
    const halfDiagonal = Math.atan(Math.hypot(tanY * aspectRatio, tanY))
    const height = camera.positionCartographic.height
    const dip = height > 0 ? Math.acos(EARTH_RADIUS / (EARTH_RADIUS + height)) : 0
    return camera.pitch + halfDiagonal > -dip - SKY_MARGIN_RAD
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

  /**
   * Registers the street lamps for the night-time lighting. The pools are
   * built lazily on the first frame that would show them (see
   * StreetLampsLayer), so a daytime session costs nothing.
   */
  addStreetLamps(data: StreetLampData): void {
    this.streetLamps.add(data)
  }

  setStopsVisible(visible: boolean): void {
    this.stops.setVisible(visible)
  }

  /** One switch for every name on the map: vehicle numbers and ship names. */
  setLabelsVisible(visible: boolean): void {
    this.vehicleLayer.setLabelsVisible(visible)
    this.vesselLayer.setLabelsVisible(visible)
  }

  /**
   * What the miniature effect is currently doing: whether it is switched
   * on, how much of it the camera pose carries, and whether its passes
   * are compiled and running (see TiltShiftEffect).
   */
  tiltShiftState(): { enabled: boolean; strength: number; ready: boolean } {
    return {
      enabled: this.tiltShift.enabled,
      strength: this.tiltShift.strength,
      ready: this.tiltShift.ready,
    }
  }

  /** Miniature look on/off – the effect and the lens it is shot with. */
  setTiltShift(enabled: boolean): void {
    this.tiltShift.setEnabled(enabled)
    this.lens.setMiniature(enabled)
    this.requestRender()
  }

  /**
   * Holds the framing while the lens changes: the camera's distance to
   * what it looks at is multiplied by the factor the angle just cost.
   *
   * A chase cam keeps the camera on a leash of its own and would put back
   * anything moved here on its next tick, so it scales that leash instead
   * – and only when no chase is running does the free camera walk.
   */
  private applyLensDistance(factor: number): void {
    const chasingVehicle = this.vehicleLayer.applyLensDistance(factor)
    const chasingVessel = this.vesselLayer.applyLensDistance(factor)
    if (chasingVehicle || chasingVessel) return
    const camera = this.viewer.camera
    const above = camera.positionCartographic.height - this.defaultGroundHeight
    const descent = Math.sin(-camera.pitch)
    // A camera at the horizon aims at nothing this side of it, and one
    // below the ground has no framing left to hold.
    if (!(above > 0) || !(descent > 0.02)) return
    camera.moveBackward((above / descent) * (factor - 1))
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
  /** Runs the height bootstrap after `delayMs`, replacing a pending one. */
  private scheduleGroundBootstrap(delayMs: number): void {
    if (this.bootstrapTimer !== null) window.clearTimeout(this.bootstrapTimer)
    this.bootstrapTimer = window.setTimeout(() => {
      this.bootstrapTimer = null
      void this.bootstrapGroundHeights()
    }, delayMs)
  }

  private async bootstrapGroundHeights(): Promise<void> {
    if (this.destroyed || this.opts.fixedGroundHeight !== undefined) return
    // No tiles yet: loadGoogleTiles schedules a run of its own once they are in.
    if (!this.googleTileset) return
    if (this.stops.count === 0) {
      this.scheduleGroundBootstrap(2000)
      return
    }
    const generation = this.bootstrapGeneration
    const scene = this.viewer.scene
    if (!scene.sampleHeightSupported) {
      console.warn('[MiniGermany3D] sampleHeight is not supported by this GPU/WebGL environment')
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
        // The map moved on to another city while the tiles were loading
        if (this.destroyed || generation !== this.bootstrapGeneration) return
        updated.forEach((carto, i) => {
          const h = carto?.height
          if (h === undefined || !plausibleGroundHeight(h)) return
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
      console.warn('[MiniGermany3D] Height bootstrap failed:', error)
      return
    }

    if (heights.length === 0) {
      console.warn(
        '[MiniGermany3D] Height bootstrap: no valid tile heights determined – ' +
          'vehicles will use the fallback height. Please report this message ' +
          'along with window.__mrt.groundHeights().',
      )
      return
    }
    this.groundMeasured = true
    heights.sort((a, b) => a - b)
    console.info(
      `[MiniGermany3D] Tile heights determined (ellipsoidal): ` +
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
          `[MiniGermany3D] Route heights calibrated: NHN→ellipsoid offset ` +
            `${offset.toFixed(1)} m (${nhnOffsets.length} stop samples)`,
        )
      } else {
        console.warn(
          `[MiniGermany3D] Route height calibration implausible (${offset.toFixed(1)} m) – ` +
            `keeping the ${this.city.terrain.geoidOffsetFallback} m fallback offset`,
        )
      }
    }
  }

  /**
   * Ellipsoidal ground height at a position, measured on the loaded Google
   * 3D tiles. undefined if no tile is loaded there (yet).
   */
  /**
   * Window position of a world point in CSS pixels, undefined behind the
   * camera. Returns a scratch – read it before the next call.
   */
  private windowPosition(position: Cartesian3): Cartesian2 | undefined {
    return SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position, windowScratch)
  }

  /**
   * Meters one CSS pixel covers at a world point's distance from the
   * camera. Cesium folds the scene's pixel ratio in already, so this is
   * per CSS pixel whatever the display's density (checked against the
   * projected width of a picture at ratio 1 and 2).
   */
  private metersPerCssPixel(position: Cartesian3): number {
    const scene = this.viewer.scene
    Cartesian3.clone(position, pixelSizeSphere.center)
    return this.viewer.camera.getPixelSize(
      pixelSizeSphere,
      scene.drawingBufferWidth,
      scene.drawingBufferHeight,
    )
  }

  private sampleGroundHeight(lon: number, lat: number): number | undefined {
    if (!this.googleTileset) return undefined
    try {
      const height = this.googleTileset.getHeight(
        Cartographic.fromDegrees(lon, lat),
        this.viewer.scene,
      )
      if (height !== undefined && plausibleGroundHeight(height)) {
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
    this.routes.updateForCameraHeight(this.viewer.camera.positionCartographic.height)
    this.routes.updatePulse()
    this.streetLamps.update()
    this.webcamsLayer.update()
    this.lens.update()
    this.tiltShift.update()
    this.updateSkyVisibility()
    this.tendTileset()
    this.viewer.render()
    // What this frame showed is the reference for the next one's motion
    this.vehicleLayer.markRendered()
    this.vesselLayer.markRendered()
    Matrix4.clone(this.viewer.camera.viewMatrix, this.renderedViewMatrix)
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
      Cartesian3.fromDegrees(this.city.home.longitude, this.city.home.latitude),
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
    // A low sun casts a shadow the length of the horizon and the map's
    // resolution goes with it; below the horizon there is nothing to cast.
    // Only recorded here (this runs on the ~1-sim-minute throttle) – the
    // switch itself happens per tick in applyShadowState.
    this.sunHighEnoughForShadows = sunUp > SHADOW_SUN_MIN
    const t = CesiumMath.clamp(
      (sunUp - GLOW_SUN_FULL) / (GLOW_SUN_START - GLOW_SUN_FULL),
      0,
      1,
    )
    const night = 1 - t * t * (3 - 2 * t) // smoothstep
    if (Math.abs(night - this.nightFactor) < 0.01 && night !== 0) return
    this.nightFactor = night
    this.vehicleLayer.applyNightFactor(night)
    this.vesselLayer.applyNightFactor(night)
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
    // A replacement warming up counts too: its traversal, like any
    // tileset's, only advances with rendered frames (see tendTileset).
    const tilesLoading =
      (this.googleTileset !== null && !this.googleTileset.tilesLoaded) ||
      (this.replacement !== null && !this.replacement.tileset.tilesLoaded) ||
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
    // A shared link may carry a pose from anywhere on the globe.
    this.enforceCameraLimits()
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
    /** Tile objects in the tree – the thing replaceTileset keeps bounded. */
    tilesTotal: number
    /** A hidden replacement is warming up (see replaceTileset). */
    replacing: boolean
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
      tilesTotal: tileStatistics(tileset).numberOfTilesTotal,
      replacing: this.replacement !== null || this.replacementInFlight,
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

  /** Debug/tests: lamps batched into the scene and their current opacity. */
  getStreetLampInfo(): { drawn: number; alpha: number } {
    return this.streetLamps.info
  }

  /**
   * Screen position of a stop's disc in CSS pixels, or null when off
   * screen or unknown – the stop-card E2E clicks the real disc with it.
   */
  getStopScreenPosition(id: string): { x: number; y: number } | null {
    const position = this.stops.stopWorldPosition(id)
    if (!position) return null
    const window = SceneTransforms.worldToWindowCoordinates(this.viewer.scene, position)
    return window ? { x: window.x, y: window.y } : null
  }

  /**
   * Projects ground points to screen pixels, at the height the layers
   * draw them at – the route profile where the dataset has one, the
   * measured ground otherwise. Points behind the camera come back null.
   *
   * One call for a whole network: this seeds the linear view's morph
   * with where the map has each line at the moment the switch is
   * pressed, which is what lets the lines straighten out of their real
   * course instead of appearing somewhere else (see map/LinearView.ts).
   */
  projectToScreen(
    points: readonly { lon: number; lat: number; nhn?: number }[],
  ): ({ x: number; y: number } | null)[] {
    const scene = this.viewer.scene
    const useProfile = this.opts.fixedGroundHeight === undefined && !this.opts.offline
    const offset = this.routes.heightOffset
    return points.map((point) => {
      const height =
        useProfile && point.nhn !== undefined ? point.nhn + offset : this.defaultGroundHeight
      const world = Cartesian3.fromDegrees(point.lon, point.lat, height)
      const window = SceneTransforms.worldToWindowCoordinates(scene, world)
      return window ? { x: window.x, y: window.y } : null
    })
  }

  /** Debug: current ground heights of the vehicles (for diagnosing tile heights). */
  getGroundHeights(): { id: string; groundHeight: number }[] {
    return this.vehicleLayer.getGroundHeights()
  }

  destroy(): void {
    this.destroyed = true
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    if (this.hoverPickTimer !== null) window.clearTimeout(this.hoverPickTimer)
    if (this.bootstrapTimer !== null) window.clearTimeout(this.bootstrapTimer)
    this.resizeObserver?.disconnect()
    this.handler.destroy()
    this.weather.destroy()
    this.streetLamps.destroy()
    this.viewer.destroy()
  }
}
