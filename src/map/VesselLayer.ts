/**
 * Background harbor traffic from AIS (see src/lib/ais.ts): one box per
 * vessel in the real ship's reported dimensions, colored by its AIS type,
 * plus a name label. The fleet renders AIS_PLAYBACK_DELAY_MS behind the
 * clock it is handed – the wall clock for the live fleet, the simulated
 * one for the recording replayed when that clock is set into the past
 * (lib/ais-archive.ts) – interpolating between the recorded fixes of
 * each vessel's track (playbackSample): between two known points there
 * is nothing to extrapolate, so ships glide instead of stalling and
 * teleporting. The city ferries are excluded upstream – they sail as
 * simulated vehicles on their timetable.
 *
 * Same rendering approach as VehicleLayer: Primitive boxes with in-place
 * modelMatrix updates (Entity boxes rebuild geometry asynchronously and
 * freeze under continuous movement), a plain text label per vessel.
 *
 * At night every ship that moves shows her navigation lights (NavLights,
 * the rules in lib/nav-lights.ts): red to port and green to starboard
 * at the bridge, white at the masthead and the stern; a ship at anchor
 * her anchor light; one lying at her berth nothing. Their places come
 * from the hull's reference dimensions – the bridge just forward of the
 * funnel where the hull has one – stretched with it.
 */

import {
  BoundingSphere,
  BoxGeometry,
  CustomShader,
  Model,
  UniformType,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Cartographic,
  Color,
  ColorBlendMode,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
  DistanceDisplayCondition,
  GeometryInstance,
  HeadingPitchRoll,
  Intersect,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveCollection,
  ShadowMode,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import { AIS_EXPIRE_MS, AIS_PLAYBACK_DELAY_MS, playbackSample, type AisVessel } from '@/lib/ais-extract'
import {
  VESSEL_SIDELIGHT_ARC_DEG,
  portLightSeen,
  starboardLightSeen,
  sternLightSeen,
  vesselLightsMode,
  viewBearingDeg,
} from '@/lib/nav-lights'
import { cameraFramingScale } from './CameraLens'
import { LIGHT_GREEN, LIGHT_RED, LIGHT_WHITE, NavLights } from './NavLights'
import {
  keepNonOverlappingLabels,
  type LabelMetrics,
  type ScreenRect,
} from './screen-rects'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'
import { FollowCamera } from '@/map/FollowCamera'
import { SMOKE_MAX_DISTANCE_M, smokeIntensity, type FunnelSmoke } from './FunnelSmoke'
import { WAKE_LIFE_S, WAKE_MAX_DISTANCE_M, WAKE_STEP_S, type Wake, type WakeSample } from './Wake'

export interface VesselLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface (calibrated like the ferry routes). */
  readonly waterSurfaceHeight: number
  /**
   * Ellipsoid height of the loaded scene geometry under a position – the
   * tiles' own water, whatever level Google's mesh has it at there
   * (scene.clampToHeight: an offscreen pick per call, ~1.4 ms, of the
   * tiles alone – the map hides everything else for it, so a hull does
   * not pick itself). undefined where nothing is loaded yet or picking is
   * unsupported (offline). Optional: without it every ship rides
   * waterSurfaceHeight.
   */
  clampToSurface?(lon: number, lat: number): number | undefined
  /**
   * Whether the camera stood still since the last tick – the surface
   * picks wait for that (see CesiumMap.cameraAtRest); absent, it is
   * taken to rest.
   */
  readonly cameraAtRest?: boolean
  /**
   * Bumped whenever the loaded tiles changed – a load cycle finished, or
   * the tileset was swapped – so a clamped height that was read off a
   * coarse tile is read again off the fine one. Without it a ship would
   * have to poll.
   */
  surfaceGeneration?(): number
  /** A camera flight is starting – keeps the render loop at full rate. */
  noteCameraFlight(durationMs: number): void
  /** The city's leash for the chase camera (see FollowCameraHost.clampToLeash). */
  clampToLeash?(pose: Cartographic): Cartesian3 | null
  /**
   * Whether every ship drawn counts as in view for the pacing – the
   * time-lapse and a playing camera path (see CesiumMap.setPaceWholeView).
   * Otherwise only those within the render range do, and a name further
   * out advances in the loop's slow heartbeat steps.
   */
  readonly paceWholeView?: boolean
  /** Screen rectangles the names keep clear of (the webcam pictures). */
  obstacles?: () => readonly ScreenRect[]
  /** Window position of a world point (CSS px), undefined behind the camera. */
  windowPosition?: (position: Cartesian3) => Cartesian2 | undefined
  /** Device pixels per CSS pixel the map draws at (default 1). */
  readonly pixelRatio?: number
  /**
   * The exhaust plumes the layer feeds per tick, one per ship under way
   * with a funnel (see FunnelSmoke). Absent where the render profile
   * leaves them out – the layer then draws no smoke.
   */
  readonly funnelSmoke?: FunnelSmoke
  /** The fleet's wakes, fed per tick from each ship's track (see Wake). Absent with the smoke. */
  readonly wake?: Wake
}

/**
 * Beyond this camera distance the hull is not drawn any more and the name
 * carries the ship alone – the vehicles' split between body and label,
 * only ten times wider: a 200 m freighter still reads as a ship where a
 * 30 m tram has long been a smudge. Below NAME_VISIBLE_RANGE, so a ship
 * never loses her name before her hull.
 */
const VESSEL_BODY_VISIBLE_RANGE = 20_000
/** The name floats this many CSS pixels above the ship (negative = up). */
const NAME_PIXEL_OFFSET_Y = -16
/** Rough glyph width of the 10 px bold name font, for the picture test. */
const NAME_PX_PER_CHAR = 6
/** Plate height and side padding in CSS px – see NAME_PLATE below. */
const NAME_HEIGHT_PX = 19
const NAME_PAD_X_PX = 3
/** Clearance the plates keep from each other and from a webcam picture. */
const NAME_GAP_PX = 2
/**
 * The plate as the declutter sees it. The label is anchored on its text
 * baseline, so the plate straddles the anchor: its bottom edge sits half a
 * plate below NAME_PIXEL_OFFSET_Y.
 */
const NAME_METRICS: LabelMetrics = {
  offsetY: NAME_PIXEL_OFFSET_Y + NAME_HEIGHT_PX / 2,
  height: NAME_HEIGHT_PX,
  gap: NAME_GAP_PX,
}
/**
 * A ship's name is written on a dark plate, unlike the stop names, which
 * are bare haloed text (StopsLayer.stopNameImage): over water, where every
 * backdrop is one dark blue, a light plate would shout and outlined text
 * would disappear. The two together mean the fleet and the network can be
 * told apart at a glance, and neither can be taken for a vehicle, which
 * wears its line colour and nothing else.
 *
 * Cesium's own label background rather than a canvas billboard: a name is
 * unique per ship, and a canvas image would leave a texture-atlas region
 * behind for every ship that ever passed (see the badge note in
 * VehicleLayer).
 *
 * Opaque, and that is load-bearing rather than a taste: nothing declutters
 * the fleet's names the way StopsLayer declutters the stops', so in a busy
 * harbour a dozen of them land on each other. Opaque, that reads as a pile
 * with the nearest name on top – the way the vehicles' badges have always
 * behaved. At 90 % it read as one illegible blob instead, every name
 * blending through the ones in front of it.
 */
const NAME_PLATE = Color.fromCssColorString('#1e293b')
const NAME_INK = Color.fromCssColorString('#f8fafc')
/** Ship names fade in below this camera distance (meters). */
const NAME_VISIBLE_RANGE = 35_000
/**
 * Beyond this camera distance a moving vessel neither requests repaints
 * nor holds the render loop at its animation rate – the app's
 * event-driven rendering must stay idle when nothing visible changes (the
 * trams' layer works the same way: movement only costs GPU while it is
 * inside the view). Where this is set below VESSEL_BODY_VISIBLE_RANGE,
 * hulls between the two are still drawn but advance in the loop's slow
 * heartbeat steps instead of gliding.
 *
 * A distance that means an on-screen size, so it follows the field of
 * view like the trams' ranges do (see camera-fov.ts).
 */
/**
 * Beyond this camera distance a ship is off screen for the layer –
 * measured at the reference lens and scaled per check by the lens the
 * camera wears (cameraFramingScale), like the vehicles' render range.
 */
const VESSEL_RENDER_RANGE_AT_REFERENCE = 5_000
/**
 * Time constant of the display smoothing in ms: the drawn position eases
 * toward the playback target instead of snapping. Between ticks that
 * yields fluid motion, and it rounds the corners where one track segment
 * hands over to the next; when a data gap ends and the playback catches
 * up, the ship glides over in about a second instead of teleporting.
 */
const SMOOTH_TAU_MS = 400
/** Fallback dimensions for the many small craft without static data. */
const DEFAULT_LENGTH = 12
const DEFAULT_WIDTH = 4

/**
 * Where a hull's funnel top is, in the model frame Cesium hands the layer
 * (x along the ship, forward positive; z up from the origin at
 * mid-height) and how wide the funnel is – where the exhaust plume
 * starts (FunnelSmoke). The shipyard's own reading of the mesh
 * (mesh.funnel in scripts/lib/vessel-fleet.mjs, in its Y-up frame) is
 * pinned against this by tests/vessel-models.test.ts.
 */
export interface VesselFunnel {
  x: number
  z: number
  width: number
}

/**
 * glTF hulls per AIS type group, generated by scripts/build-vehicle-models.mjs
 * from scripts/lib/vessel-fleet.mjs – same visual language as the vehicle
 * fleet. Reference dimensions mirror VESSEL_DIMS there (pinned against the
 * GLB bounds by tests/vessel-models.test.ts); the drawn ship is this model
 * stretched to the vessel's reported size, so one coaster hull covers
 * everything from a bunker barge to the 200 m CEMLUNA. The hulls with a
 * funnel say where it is (see VesselFunnel); the rest show no exhaust.
 */
export const VESSEL_MODELS: Record<
  string,
  { uri: string; length: number; width: number; height: number; funnel?: VesselFunnel }
> = {
  'vessel-container': {
    uri: 'models/vessel-container.glb',
    length: 300,
    width: 40,
    height: 46,
    funnel: { x: -89.5, z: 22.3, width: 6 },
  },
  'vessel-cargo': {
    uri: 'models/vessel-cargo.glb',
    length: 90,
    width: 14,
    height: 16,
    funnel: { x: -41.2, z: 8, width: 2.4 },
  },
  'vessel-tanker': {
    uri: 'models/vessel-tanker.glb',
    length: 90,
    width: 14,
    height: 14,
    funnel: { x: -41, z: 7, width: 2.4 },
  },
  'vessel-barge': { uri: 'models/vessel-barge.glb', length: 85, width: 9.5, height: 6 },
  'vessel-dredger': {
    uri: 'models/vessel-dredger.glb',
    length: 100,
    width: 20,
    height: 18,
    funnel: { x: -43, z: 8.5, width: 3 },
  },
  'vessel-passenger': {
    uri: 'models/vessel-passenger.glb',
    length: 160,
    width: 24,
    height: 34,
    funnel: { x: -44.8, z: 16.9, width: 4.5 },
  },
  'vessel-tender': { uri: 'models/vessel-tender.glb', length: 20, width: 5, height: 6 },
  'vessel-pilot': { uri: 'models/vessel-pilot.glb', length: 20, width: 6, height: 7.5 },
  'vessel-tug': { uri: 'models/vessel-tug.glb', length: 26, width: 9, height: 10 },
  'vessel-fishing': { uri: 'models/vessel-fishing.glb', length: 18, width: 5.5, height: 7.5 },
  'vessel-sail': { uri: 'models/vessel-sail.glb', length: 12, width: 3.8, height: 14 },
  'vessel-motor': { uri: 'models/vessel-motor.glb', length: 14, width: 4.2, height: 5 },
  'vessel-generic': { uri: 'models/vessel-generic.glb', length: 16, width: 5, height: 5.5 },
}

/**
 * Length from which a cargo ship of no stated kind is drawn as a
 * container ship. Type 76 says "container ship" since ITU-R M.1371-6,
 * but almost nothing transmits it yet, and 70–74 and 79 cover every dry
 * cargo ship there is – so the size decides, and in a container port
 * that is the honest guess: what comes up the Elbe at 150 m and more is
 * a feeder or bigger. A bulk carrier that keeps to the old codes gets
 * the box stacks too, which is the price of having no better signal.
 */
const CONTAINER_MIN_LENGTH_M = 150

/**
 * Length below which a "passenger ship" is one of the harbour launches
 * rather than a ferry or a cruise ship. Hamburg's barkassen mostly
 * broadcast type 60, and a 160 m cruise silhouette squeezed to 20 m
 * reads as a toy of the wrong thing entirely.
 */
const LAUNCH_MAX_LENGTH_M = 35

/**
 * An inland ship is not a small seagoing one: the Europaschiff on the
 * Elbe measures 85 × 9.5 m, proportions no coaster has (they start at
 * 12.5 m of beam), and it carries its wheelhouse right aft. Without a
 * reported beam the question cannot be asked, so the answer is no.
 */
function isInlandBarge(lengthM: number, widthM: number | null): boolean {
  return lengthM >= 50 && widthM !== null && widthM <= 12
}

/**
 * AIS ship type code → archetype model.
 *
 * ITU-R M.1371-6 (February 2026) finally names hulls the earlier table
 * only had room for: 75–78 split the cargo group into bulk carrier,
 * container ship, ro-ro and landing craft, 67 marks the harbour cruise
 * boat, 38 the trawler, 39 the patrol vessel. Those codes are read here
 * for what they say.
 *
 * They are the future, not the present: a spec from February is not what
 * the fleet transmits, and every 400 m box ship in the Hamburg sample
 * still called itself 71 or 74 – "cargo carrying dangerous goods". So
 * the size heuristics below stay, and they are what actually fires
 * today. Where the code says nothing the reported size does: how big a
 * cargo ship is, how narrow an inland one, how small a "passenger ship"
 * really is.
 */
export function archetypeFor(
  typeCode: number,
  lengthM: number | null = null,
  widthM: number | null = null,
): string {
  const group = Math.floor(typeCode / 10)
  const length = lengthM ?? 0

  // --- Codes that name the hull outright ------------------------------
  if (typeCode === 76) return 'vessel-container'
  // Bulk carrier and ro-ro have no hull of their own: the coaster's
  // flush deck and hatch covers are the closer of what there is, and a
  // ro-ro carries no boxes to give it the container silhouette.
  if (typeCode === 75 || typeCode === 77) return 'vessel-cargo'
  if (typeCode === 78) return 'vessel-barge' // landing craft: a flat deck with a ramp
  if (typeCode === 67) return 'vessel-tender' // harbour cruise boat: the barkasse
  if (typeCode === 38) return 'vessel-fishing' // trawler
  if (typeCode === 39) return 'vessel-pilot' // patrol vessel
  // The working craft of a port, each with a code of its own and a
  // silhouette that shares nothing with the tug they all used to be
  if (typeCode === 33) return 'vessel-dredger'
  if (typeCode === 53) return 'vessel-tender' // port or fish tender
  // Pilot, search-and-rescue and police all run the same kind of fast,
  // heavily fendered patrol boat
  if (typeCode === 50 || typeCode === 51 || typeCode === 55) return 'vessel-pilot'

  // --- Groups, with the size deciding what the code leaves open -------
  if (group === 6 || group === 4) {
    // 4x is high-speed craft; both groups hold everything from a launch
    // to a cruise ship, and only the length tells them apart
    return length > 0 && length < LAUNCH_MAX_LENGTH_M ? 'vessel-tender' : 'vessel-passenger'
  }
  if (group === 7 || group === 8) {
    if (isInlandBarge(length, widthM)) return 'vessel-barge'
    if (group === 8) return 'vessel-tanker'
    return length >= CONTAINER_MIN_LENGTH_M ? 'vessel-container' : 'vessel-cargo'
  }
  if (group === 5) return 'vessel-tug' // tug and the rest of the support craft
  if (typeCode === 31 || typeCode === 32) return 'vessel-tug' // towing
  if (typeCode === 30) return 'vessel-fishing'
  if (typeCode === 36) return 'vessel-sail'
  if (typeCode === 37) return 'vessel-motor'
  // Special purpose ships (01–09) and support vessels (11–19) are
  // working ships – an ice breaker, a buoy tender, a cable layer. A big
  // one is a ship and gets the freighter hull, never the box stacks.
  if (typeCode >= 1 && typeCode <= 19) {
    return length >= 45 ? 'vessel-cargo' : 'vessel-generic'
  }

  // Everything left is a code that says nothing about the hull: 0 "not
  // available", 2x wing-in-ground (which inland ships on the Elbe hand
  // out freely – RHENUS BRAUNSCHWEIG, 177 × 12 m, calls itself a
  // ground-effect craft), the rest of 3x, and 9x "other". Size is all
  // there is to go on, and it is enough to keep a real ship from being
  // drawn as a stretched workboat.
  if (length >= 45) {
    if (isInlandBarge(length, widthM)) return 'vessel-barge'
    return length >= CONTAINER_MIN_LENGTH_M ? 'vessel-container' : 'vessel-cargo'
  }
  return 'vessel-generic'
}

/** Height scale from the footprint scale – ships do not grow linearly tall. */
function heightScale(lengthScale: number, widthScale: number): number {
  return Math.min(2.2, Math.max(0.55, Math.sqrt(lengthScale * widthScale)))
}

/**
 * Hull color and height by AIS ship type group – muted, the fleet is
 * scenery. The height only shapes the placeholder box until the glTF hull
 * is in; the name plate above it is the one slate for every ship (see
 * NAME_PLATE), so a name is read as a name rather than as a type.
 */
function vesselStyle(typeCode: number): { color: string; height: number } {
  const group = Math.floor(typeCode / 10)
  if (group === 6) return { color: '#4a7fb5', height: 5 } // passenger
  if (group === 7) return { color: '#4e8a57', height: 5 } // cargo
  if (group === 8) return { color: '#a05252', height: 5 } // tanker
  if (typeCode === 30) return { color: '#8a7250', height: 3 } // fishing
  if (typeCode === 33) return { color: '#8a7a4e', height: 4 } // dredger
  if (typeCode === 36 || typeCode === 37) return { color: '#8a6fb0', height: 3 } // sailing/pleasure
  if (group === 5) return { color: '#4f9494', height: 3 } // tug/pilot/tender/SAR
  return { color: '#7a8494', height: 3 } // unknown
}

interface VesselRecord {
  /** Archetype the body was chosen by – a late type code swaps the hull. */
  archetype: string
  /** Picked in the app – her hull lights up (see setSelected). */
  highlighted: boolean
  /** The box placeholder's own colour, to mix the highlight into. */
  hullColor: Color
  /** Placeholder box until the glTF hull is in (null afterwards). */
  primitive: Primitive | null
  /** glTF hull; null while loading (the box stands in) or after a failure. */
  model: Model | null
  /** The model's own matrix – fromGltfAsync clones what it got. */
  modelMatrix: Matrix4 | null
  /** Unscaled base pose; the model matrix composes scale on top. */
  matrix: Matrix4
  labelEntity: Entity
  labelPosition: ConstantPositionProperty
  /** Dimensions the box was built with – a real size arriving later rebuilds it. */
  builtLength: number
  builtWidth: number
  builtHeight: number
  labelText: string
  /** Smoothed pose actually drawn (eases toward the reckoned target). */
  displayPosition: Cartesian3
  displayBearing: number
  /** Pose as of the last repaint request – the change detector. */
  lastPosition: Cartesian3
  lastBearing: number
  /**
   * Pose as of the frame that was last RENDERED – what on-screen motion
   * is measured against, so slow movement accumulates across ticks (see
   * screen-motion.ts and VehicleLayer's twin of this). Refreshed lazily
   * by renderedStamp on the first tick after a newer frame was drawn.
   */
  renderedPosition: Cartesian3
  renderedBearing: number
  renderedStamp: number
  /**
   * Height the hull was last clamped to (null: never – the ship rides
   * the host's water surface until it is), and where and against which
   * tiles it was read, so the clamp is only repeated when one of the two
   * changed.
   */
  clampedHeight: number | null
  clampLon: number
  clampLat: number
  clampedGeneration: number
  /**
   * Until when her wake is laid: WAKE_LIFE_S past the last tick she was
   * under way, so a ship that stops leaves her wake to fade rather than
   * losing it at once – and a ship at her berth costs no samples at all.
   */
  wakeUntilMs: number
}

/*
 * The ships are clamped to the tiles rather than set on a fixed water
 * surface: inland the water is a staircase of lock reaches and Google's
 * mesh is the only thing that says where each step lies. A clamp is an
 * offscreen pick (~1.4 ms measured 2026-09-08 – a scene update and a
 * synchronous readPixels, which stalls the GPU pipeline and, in Firefox,
 * round-trips to the process that runs WebGL), so it is made only when
 * its answer could have changed – the ship moved CLAMP_MOVE_M since the
 * last one, or the tiles under it did (host.surfaceGeneration) – and only
 * for ships on screen; the rest ride the fallback surface unseen and are
 * clamped the tick they come into view. A pick that found no tile is not
 * asked again until the tiles change either: nothing else can change its
 * answer, and asking every tick was what kept a long view over the Elbe
 * at its full budget for good (found 2026-09-13). CLAMP_BUDGET_PER_TICK
 * caps the work of a tick when many ships qualify at once (a city switch,
 * a load cycle over a busy harbour) – the rest follow next tick. A fleet
 * at rest under a resting camera costs nothing.
 *
 * Nor does a load cycle re-read every ship on screen: the tiles that
 * refine as the camera moves are the ones near it, and a metre's error
 * under a ship two kilometres off is a fraction of a pixel, so a ship
 * whose clamp has answered is read again at a new generation only within
 * CLAMP_REFINE_RANGE_AT_REFERENCE (at the reference lens, scaled like the
 * render range), or once she has moved. Measured 2026-09-13 at 1175 m
 * over Hamburg's harbour with 245 ships on screen: every generation
 * re-clamped them all, three a tick for three seconds, each clamp a full
 * scene update – 22 % (Chrome) to 30 % (Firefox) of a pan's wall time.
 */
const CLAMP_BUDGET_PER_TICK = 3
const CLAMP_MOVE_M = 25
const CLAMP_REFINE_RANGE_AT_REFERENCE = 2_000

/**
 * Meters the fallback water surface (host.waterSurfaceHeight, NHN 0 plus
 * the calibrated offset) rides above the geoid: the water in Google's
 * mesh undulates up to ~1 m around it, and a hull on the fallback would
 * otherwise sit in it. Only ships without a clamp answer ride it.
 */
export const WATER_SURFACE_FALLBACK_LIFT = 1.25

const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll(0, 0, 0)
const scaleScratch = new Cartesian3()
const funnelScratch = new Cartesian3()
const funnelWorldScratch = new Cartesian3()
const lightScratch = new Cartesian3()
const lightWorldScratch = new Cartesian3()
const axisScratch = new Cartesian4()
const toCameraScratch = new Cartesian3()

/** The dot product of a pose matrix's axis (0 forward, 1 port, 2 up) with a world vector. */
function axisDot(matrix: Matrix4, column: 0 | 1 | 2, vector: Cartesian3): number {
  Matrix4.getColumn(matrix, column, axisScratch)
  return axisScratch.x * vector.x + axisScratch.y * vector.y + axisScratch.z * vector.z
}

/**
 * Where a hull's lights are, in the model frame (x forward, y port, z
 * up) at the reference size: the sidelights at the bridge – just
 * forward of the funnel where there is one, a fifth of the length aft
 * of amidships otherwise – a hand outboard of the beam; the masthead
 * light over the funnel, the highest point a hull has (the mast it
 * really hangs on is not modelled, and a light in mid-air over the
 * fo'c'sle read as a stray dot); the stern light at the stern; the
 * anchor light on the fo'c'sle, a few metres over the deck.
 */
function vesselLightPoints(spec: (typeof VESSEL_MODELS)[string]) {
  const bridgeX = spec.funnel ? spec.funnel.x + spec.length * 0.06 : -spec.length * 0.2
  const bridgeZ = spec.funnel ? spec.funnel.z * 0.75 : spec.height * 0.25
  return {
    port: { x: bridgeX, y: spec.width / 2 + 0.2, z: bridgeZ },
    starboard: { x: bridgeX, y: -spec.width / 2 - 0.2, z: bridgeZ },
    masthead: { x: spec.funnel ? spec.funnel.x : -spec.length * 0.1, y: 0, z: spec.height / 2 + 0.2 },
    stern: { x: -spec.length / 2 + 0.3, y: 0, z: 0 },
    anchor: { x: spec.length * 0.4, y: 0, z: spec.height * 0.15 },
  }
}
/** The lights' brightness below which none is drawn at all – by day a ship shows none. */
const LIGHTS_MIN_NIGHT = 0.05

/** Metres per second in a knot. */
const KNOT_MPS = 0.514444

/**
 * The picked ship lights up the way the picked tram does: her hull washed
 * toward white and rimmed in it. The numbers are the vehicles' own – the
 * 0.25 blend of MODEL_TINT_AMOUNT, their 2.5 px silhouette, and the 0.45
 * the box fallback lerps by – so picking a hull and picking a tram read as
 * the same act. A ship carries no line colour to brighten, so the blend
 * goes to white itself rather than to a lighter livery.
 */
const HIGHLIGHT_BLEND = 0.25
const HIGHLIGHT_SILHOUETTE_PX = 2.5
const HIGHLIGHT_BOX_MIX = 0.45

/** Night-time window glow, identical language to the vehicle fleet. */
const WINDOW_GLOW_COLOR = 'vec3(1.0, 0.83, 0.52)'
const WINDOW_GLOW_LUMINANCE_CUTOFF = '0.075'
const WINDOW_GLOW_MAX = 0.85

export class VesselLayer {
  private vessels = new Map<number, VesselRecord>()
  /**
   * Every primitive of the fleet – hulls, placeholder boxes, lights –
   * under one collection, so the map can take the whole fleet out of a
   * surface pick with one flag (see CesiumMap.clampToSurface): a Model
   * that is merely hidden is still updated, a hidden parent skips it.
   */
  readonly root = new PrimitiveCollection({ destroyPrimitives: true })
  private visible = true
  private labelsVisible = true
  /** "Zoom to line" keeps the names off until this instant (startLineFocus). */
  private lineFocusUntil = 0
  /** MMSI of the picked ship, null when nothing is picked. */
  private selectedMmsi: number | null = null
  /** MMSI the camera is chasing, null when free. */
  private followMmsi: number | null = null
  private readonly followCamera: FollowCamera
  private frustumSphere = new BoundingSphere()
  private lastSyncMs = 0
  /** Counts rendered frames (see markRendered / VesselRecord.renderedStamp). */
  private renderStamp = 0
  /** The fleet's navigation lights (see NavLights). */
  private readonly lights: NavLights
  /** 0 = day … 1 = full night, as last applied – the lights' brightness. */
  private night = 0
  /** Lights the hulls' glazing at night (see WINDOW_GLOW_COLOR). */
  private readonly windowGlowShader = new CustomShader({
    uniforms: { u_windowGlow: { type: UniformType.FLOAT, value: 0 } },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
      {
        float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
        if (luminance < ${WINDOW_GLOW_LUMINANCE_CUTOFF})
        {
          material.emissive += ${WINDOW_GLOW_COLOR} * u_windowGlow;
        }
      }
    `,
  })

  constructor(
    private readonly viewer: Viewer,
    private readonly host: VesselLayerHost,
  ) {
    this.followCamera = new FollowCamera(viewer, host)
    viewer.scene.primitives.add(this.root)
    this.lights = new NavLights(this.root)
  }

  /** Lights on at the last tick – the debug API's count. */
  get lightCount(): number {
    return this.lights.count
  }

  /**
   * Whether `position` sits inside the view and close enough to matter.
   * Everything the layer changes – movement, arrivals, departures, late
   * names and dimensions – is folded into whichever frame renders next
   * anyway; a repaint of its own is only owed while someone can see the
   * change. Off screen the layer stays silent, and the app's
   * event-driven rendering stays idle (the trams' rule).
   */
  private isOnScreen(
    cullingVolume: { computeVisibility(sphere: BoundingSphere): number },
    position: Cartesian3,
  ): boolean {
    if (!this.visible) return false
    const camera = this.viewer.camera
    // Under the time-lapse and a camera path the whole picture moves: a
    // ship counts as in view wherever her name is drawn
    const renderRange = this.host.paceWholeView
      ? NAME_VISIBLE_RANGE
      : VESSEL_RENDER_RANGE_AT_REFERENCE * cameraFramingScale(camera)
    if (Cartesian3.distance(camera.positionWC, position) >= renderRange) return false
    Cartesian3.clone(position, this.frustumSphere.center)
    this.frustumSphere.radius = 80
    return cullingVolume.computeVisibility(this.frustumSphere) !== Intersect.OUTSIDE
  }

  private repaintIfOnScreen(
    cullingVolume: { computeVisibility(sphere: BoundingSphere): number },
    position: Cartesian3,
  ): void {
    if (this.isOnScreen(cullingVolume, position)) this.host.requestRender()
  }

  /**
   * Per-tick update: played-back positions, arrivals, departures.
   * Returns whether a vessel whose drawn pose is still changing sits
   * inside the view – the app's tick and render pacing treat that like a
   * tram in view, otherwise ships glide in 500 ms stop-motion steps.
   */
  sync(
    vessels: AisVessel[],
    nowMs: number,
  ): {
    anyMovingVesselInView: boolean
    nearestHullMeters: number
    nearestHullWidthM: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    // One collectionChanged event per tick instead of one per ship – see
    // VehicleLayer.sync for the reasoning.
    const entities = this.viewer.entities
    entities.suspendEvents()
    try {
      return this.syncBatched(vessels, nowMs)
    } finally {
      entities.resumeEvents()
    }
  }

  /**
   * The map drew a frame: motion is measured against the poses of the
   * tick before this call from here on (see VesselRecord.renderedPosition).
   */
  markRendered(): void {
    this.renderStamp++
    this.host.funnelSmoke?.markRendered()
  }

  private syncBatched(
    vessels: AisVessel[],
    nowMs: number,
  ): {
    anyMovingVesselInView: boolean
    nearestHullMeters: number
    nearestHullWidthM: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    const renderMs = nowMs - AIS_PLAYBACK_DELAY_MS
    const alive = new Set<number>()
    // One culling volume per tick, for every repaint decision below.
    const camera = this.viewer.camera
    // Webcam pictures on screen – a name that would sit on one steps aside
    const obstacles = this.host.obstacles?.() ?? []
    // …and every name steps aside while a "zoom to line" focus runs
    const namesAside = this.namesAside()
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    )
    // Smoothing step for this tick; a long pause (tab hidden) snaps.
    const dtMs = this.lastSyncMs > 0 ? Math.max(0, nowMs - this.lastSyncMs) : 0
    this.lastSyncMs = nowMs
    const alpha = dtMs > 0 && dtMs < 2000 ? 1 - Math.exp(-dtMs / SMOOTH_TAU_MS) : 1
    // The plumes run on the same clock as the ships and are rebuilt
    // every tick from the ships that qualify (see FunnelSmoke)
    const smoke = this.host.funnelSmoke
    if (smoke) {
      smoke.advance(nowMs)
      smoke.begin()
    }
    const wake = this.host.wake
    wake?.begin(nowMs)
    const lights = this.lights
    lights.begin()
    const lightsOn = this.night >= LIGHTS_MIN_NIGHT

    let anyMovingVesselInView = false
    /**
     * Distance to the closest drawn hull and how wide it is – the map's
     * shadow gate needs to know whether anything is near enough to cast a
     * shadow the screen can show, and a 200 m freighter matters from much
     * further out than a tram.
     */
    let nearestHullMeters = Number.POSITIVE_INFINITY
    let nearestHullWidthM = DEFAULT_WIDTH
    // On-screen motion since the last rendered frame (see screen-motion.ts)
    const pxPerMeterAtUnit = cssPixelsPerMeterAtUnitDistance(this.viewer)
    const motionThreshold = motionThresholdCssPx(this.host.pixelRatio ?? 1)
    let maxScreenMotionPx = 0
    // …and since the last tick alone, for the app's speed estimate
    let maxTickMotionPx = 0
    /*
     * The names in the frame, filled by the loop and pruned after it.
     * Without a windowPosition from the host (the unit tests' viewer has
     * none) there is no screen to declutter on, and every name stays.
     */
    const windowPosition = this.host.windowPosition
    const nameCandidates: {
      record: VesselRecord
      distance: number
      x: number
      y: number
      halfWidth: number
    }[] = []
    let clampBudget = CLAMP_BUDGET_PER_TICK
    const surfaceGeneration = this.host.surfaceGeneration?.() ?? 0
    const clampRefineRange = CLAMP_REFINE_RANGE_AT_REFERENCE * cameraFramingScale(camera)
    // No pick while the camera moves, but for the ship she follows (see
    // CesiumMap.cameraAtRest)
    const cameraAtRest = this.host.cameraAtRest !== false
    for (const vessel of vessels) {
      if (nowMs - vessel.positionAt > AIS_EXPIRE_MS) continue
      alive.add(vessel.mmsi)

      let record = this.vessels.get(vessel.mmsi)
      // Static data can land after the first position: a type code picks
      // a different hull, and while the box still stands in, clearly
      // different dimensions rebuild it. A loaded model needs neither –
      // its per-tick scale follows the reported size by itself.
      if (
        record &&
        (record.archetype !== archetypeFor(vessel.typeCode, vessel.lengthM, vessel.widthM) ||
          (record.model === null &&
            (Math.abs((vessel.lengthM ?? DEFAULT_LENGTH) - record.builtLength) > 1 ||
              Math.abs((vessel.widthM ?? DEFAULT_WIDTH) - record.builtWidth) > 1)))
      ) {
        this.remove(vessel.mmsi)
        record = undefined
      }
      if (!record) {
        record = this.createVessel(vessel, nowMs)
        this.vessels.set(vessel.mmsi, record)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }

      const sample = playbackSample(vessel, renderMs)
      // Stretch the archetype to the reported size; the box placeholder
      // was already built at it. Height grows with the footprint's root –
      // ships get longer much faster than they get taller.
      const spec = VESSEL_MODELS[record.archetype]
      const lengthScale = (vessel.lengthM ?? DEFAULT_LENGTH) / spec.length
      const widthScale = (vessel.widthM ?? DEFAULT_WIDTH) / spec.width
      const drawnHeight = record.model
        ? spec.height * heightScale(lengthScale, widthScale)
        : record.builtHeight
      // Clamp to the tiles – only when the answer could have changed, only
      // on screen, at most CLAMP_BUDGET_PER_TICK a tick (see the constants)
      if (
        this.host.clampToSurface &&
        clampBudget > 0 &&
        (cameraAtRest || vessel.mmsi === this.followMmsi)
      ) {
        const movedM = Math.hypot(
          (sample.lon - record.clampLon) * 111_320 * Math.cos((sample.lat * Math.PI) / 180),
          (sample.lat - record.clampLat) * 111_132,
        )
        const stale =
          movedM > CLAMP_MOVE_M ||
          (record.clampedGeneration !== surfaceGeneration &&
            (record.clampedHeight === null ||
              Cartesian3.distance(camera.positionWC, record.displayPosition) < clampRefineRange))
        if (stale && this.isOnScreen(cullingVolume, record.displayPosition)) {
          clampBudget--
          const h = this.host.clampToSurface(sample.lon, sample.lat)
          record.clampLon = sample.lon
          record.clampLat = sample.lat
          record.clampedGeneration = surfaceGeneration
          if (h !== undefined) record.clampedHeight = h
        }
      }
      const surface = record.clampedHeight ?? this.host.waterSurfaceHeight
      const target = Cartesian3.fromDegrees(
        sample.lon,
        sample.lat,
        surface + drawnHeight / 2,
        undefined,
        positionScratch,
      )
      Cartesian3.lerp(record.displayPosition, target, alpha, record.displayPosition)
      if (Cartesian3.equalsEpsilon(record.displayPosition, target, 0, 0.05)) {
        Cartesian3.clone(target, record.displayPosition)
      }
      // Shortest-path ease of the bearing – cog jitter must not wag the bow
      const bearingGap = ((sample.bearingDeg - record.displayBearing + 540) % 360) - 180
      record.displayBearing =
        Math.abs(bearingGap) < 0.05
          ? sample.bearingDeg
          : (record.displayBearing + bearingGap * alpha + 360) % 360

      hprScratch.heading = CesiumMath.toRadians(record.displayBearing - 90)
      Transforms.headingPitchRollToFixedFrame(
        record.displayPosition,
        hprScratch,
        undefined,
        undefined,
        record.matrix,
      )
      if (record.model && record.modelMatrix) {
        // Model frame after Cesium's glTF mapping: x = travel, y = beam,
        // z = up. Written into the model's own matrix instance.
        scaleScratch.x = lengthScale
        scaleScratch.y = widthScale
        scaleScratch.z = heightScale(lengthScale, widthScale)
        Matrix4.multiplyByScale(record.matrix, scaleScratch, record.modelMatrix)
      }
      record.labelPosition.setValue(record.displayPosition)
      const distance = Cartesian3.distance(camera.positionWC, record.displayPosition)
      /*
       * Which names are drawn is settled after the loop, by the same
       * declutter the stop names use: a busy harbour puts a dozen names
       * on the same patch of screen, and Cesium cannot let the nearest one
       * cover the rest – a LabelCollection draws every background first
       * and every glyph after, in two collections of its own, so the names
       * write straight over each other whatever the plate's opacity. The
       * loop only collects the candidates.
       */
      let nameShown = this.visible && this.labelsVisible && !namesAside
      if (nameShown && distance < NAME_VISIBLE_RANGE && windowPosition) {
        const window = windowPosition(record.displayPosition)
        if (window) {
          nameCandidates.push({
            record,
            distance,
            x: window.x,
            y: window.y,
            halfWidth: (record.labelText.length * NAME_PX_PER_CHAR) / 2 + NAME_PAD_X_PX,
          })
          // Settled below; leave what it has until then.
          nameShown = record.labelEntity.show === true
        } else {
          // Behind the camera – nothing to draw and nothing to declutter
          nameShown = false
        }
      }
      if (record.labelEntity.show !== nameShown) {
        record.labelEntity.show = nameShown
        this.host.requestRender()
      }
      const showBody = this.visible && distance < VESSEL_BODY_VISIBLE_RANGE
      if (showBody && distance < nearestHullMeters) {
        nearestHullMeters = distance
        nearestHullWidthM = vessel.widthM ?? DEFAULT_WIDTH
      }
      // The wake: foam where her trailing end has been over the last
      // WAKE_LIFE_S, read off her track at every step back – and for that
      // long after she stopped, so it fades where she left it
      if (wake && showBody && distance <= WAKE_MAX_DISTANCE_M) {
        if (sample.underWay) record.wakeUntilMs = nowMs + WAKE_LIFE_S * 1000
        if (nowMs < record.wakeUntilMs && vessel.track.length >= 2) {
          const samples: WakeSample[] = []
          for (let ageS = 0; ageS < WAKE_LIFE_S; ageS += WAKE_STEP_S) {
            const past = playbackSample(vessel, renderMs - ageS * 1000)
            samples.push({ ageS, lon: past.lon, lat: past.lat, bearingDeg: past.bearingDeg })
          }
          wake.add(samples, {
            lengthM: vessel.lengthM ?? DEFAULT_LENGTH,
            beamM: vessel.widthM ?? DEFAULT_WIDTH,
            surfaceHeight: surface,
            seed: vessel.mmsi % 977,
          })
          // A wake left standing fades on its own; a frame now and then shows it
          if (wake.fadeFrameDue && this.isOnScreen(cullingVolume, record.displayPosition)) {
            this.host.requestRender()
          }
        }
      }
      // Exhaust: a hull with a funnel, under way over the ground, near
      // enough for a plume to be more than pixels. The plume starts at
      // the funnel top of the stretched hull and trails with the ship's
      // course and speed (its apparent wind); its own motion earns frames
      // and the tick rate the way the hull's does.
      if (smoke && showBody && spec.funnel && distance <= SMOKE_MAX_DISTANCE_M) {
        const intensity = smokeIntensity(vessel.sogKn)
        if (intensity > 0) {
          funnelScratch.x = spec.funnel.x * lengthScale
          funnelScratch.y = 0
          funnelScratch.z = spec.funnel.z * heightScale(lengthScale, widthScale)
          Matrix4.multiplyByPoint(record.matrix, funnelScratch, funnelWorldScratch)
          const speedMps = (vessel.sogKn ?? 0) * KNOT_MPS
          const course = CesiumMath.toRadians(vessel.cogDeg ?? record.displayBearing)
          smoke.add(
            funnelWorldScratch,
            speedMps * Math.sin(course),
            speedMps * Math.cos(course),
            spec.funnel.width * widthScale,
            intensity,
            vessel.mmsi % 997,
          )
          if (this.isOnScreen(cullingVolume, funnelWorldScratch)) {
            anyMovingVesselInView = true
            const pxPerMeter = pxPerMeterAtUnit / Math.max(1, distance)
            if (smoke.metersSinceRendered * pxPerMeter >= motionThreshold) this.host.requestRender()
          }
        }
      }
      // Box stand-in or loaded model – attachModel swaps one for the other,
      // so only ever one of them is on the scene.
      const body = record.model ?? record.primitive
      if (body && body.show !== showBody) {
        body.show = showBody
        this.host.requestRender()
      }
      // The navigation lights, at night, by what she is doing (see
      // lib/nav-lights.ts) – steady, so they ask for no frame of their
      // own: the night ramp and the hull's motion bring the frames
      if (lightsOn && showBody) {
        // Moving by the speed she reports – steadier than the track,
        // whose segments a berthed ship's GNSS wobble can push over the
        // playback's threshold for a minute at a time, and which carries
        // no motion at its ends; the track only where she reports none
        const moving = vessel.sogKn !== null ? vessel.sogKn >= 0.5 : sample.underWay
        const mode = vesselLightsMode(vessel.navStatus, moving)
        if (mode !== 'off') {
          const points = vesselLightPoints(spec)
          const hScale = heightScale(lengthScale, widthScale)
          const at = (point: { x: number; y: number; z: number }) => {
            lightScratch.x = point.x * lengthScale
            lightScratch.y = point.y * widthScale
            lightScratch.z = point.z * hScale
            return Matrix4.multiplyByPoint(record.matrix, lightScratch, lightWorldScratch)
          }
          const id = `vessel:${vessel.mmsi}`
          if (mode === 'anchor') {
            lights.add(at(points.anchor), LIGHT_WHITE, this.night, id)
          } else {
            // Screened as at sea: each light over its own arc, read off
            // where the camera stands against her bow and her port side
            Cartesian3.subtract(camera.positionWC, record.displayPosition, toCameraScratch)
            const forwardDot = axisDot(record.matrix, 0, toCameraScratch)
            const portDot = axisDot(record.matrix, 1, toCameraScratch)
            const bearing = viewBearingDeg(forwardDot, portDot)
            if (portLightSeen(bearing, VESSEL_SIDELIGHT_ARC_DEG)) {
              lights.add(at(points.port), LIGHT_RED, this.night, id)
            }
            if (starboardLightSeen(bearing, VESSEL_SIDELIGHT_ARC_DEG)) {
              lights.add(at(points.starboard), LIGHT_GREEN, this.night, id)
            }
            if (sternLightSeen(bearing, VESSEL_SIDELIGHT_ARC_DEG)) {
              lights.add(at(points.stern), LIGHT_WHITE, this.night, id)
            } else {
              lights.add(at(points.masthead), LIGHT_WHITE, this.night, id)
            }
          }
        }
      }
      // A frame was drawn since this ship's last tick: that tick's pose is
      // on screen and is what motion is measured against from now on.
      if (record.renderedStamp !== this.renderStamp) {
        Cartesian3.clone(record.lastPosition, record.renderedPosition)
        record.renderedBearing = record.lastBearing
        record.renderedStamp = this.renderStamp
      }
      const poseChanged =
        !Cartesian3.equalsEpsilon(record.displayPosition, record.lastPosition, 0, 0.02) ||
        Math.abs(record.displayBearing - record.lastBearing) > 0.05
      // The pacing signal must NOT hang on the per-tick repaint epsilon:
      // a slow ship advances less than it per 33 ms tick, the flag would
      // drop, the app would fall back to 500 ms ticks, and the two rates
      // would oscillate into exactly the stop-motion this exists to
      // prevent. "Under way" comes from the playback segment instead –
      // stable across ticks – with the pose ease riding along until it
      // converged.
      const underWay = sample.underWay
      if ((poseChanged || underWay) && this.isOnScreen(cullingVolume, record.displayPosition)) {
        anyMovingVesselInView = true
        // Repaint once the drawn pose has moved ON SCREEN by a visible
        // step since the rendered frame (see screen-motion.ts): the hull's
        // translation, or its bow swinging round when it turns on the
        // spot – half the drawn length times the angle.
        const halfLength = (spec.length * lengthScale) / 2
        const swing = (from: number) =>
          halfLength * CesiumMath.toRadians(Math.abs(((record.displayBearing - from + 540) % 360) - 180))
        const pxPerMeter = pxPerMeterAtUnit / Math.max(1, distance)
        const movedMeters = Math.max(
          Cartesian3.distance(record.displayPosition, record.renderedPosition),
          swing(record.renderedBearing),
        )
        const tickMeters = Math.max(
          Cartesian3.distance(record.displayPosition, record.lastPosition),
          swing(record.lastBearing),
        )
        const motionPx = movedMeters > 0 ? movedMeters * pxPerMeter : 0
        const tickPx = tickMeters > 0 ? tickMeters * pxPerMeter : 0
        if (motionPx > maxScreenMotionPx) maxScreenMotionPx = motionPx
        if (tickPx > maxTickMotionPx) maxTickMotionPx = tickPx
        if (motionPx >= motionThreshold) this.host.requestRender()
      }
      if (poseChanged) {
        Cartesian3.clone(record.displayPosition, record.lastPosition)
        record.lastBearing = record.displayBearing
      }

      // Chase from the DRAWN pose, not the raw sample: the display ease
      // is what the eye follows, so the camera has to ride the same curve
      // or it would jitter against the hull it is chasing.
      if (vessel.mmsi === this.followMmsi) {
        const carto = Cartographic.fromCartesian(record.displayPosition)
        this.followCamera.update({
          lon: CesiumMath.toDegrees(carto.longitude),
          lat: CesiumMath.toDegrees(carto.latitude),
          centerHeight: this.host.waterSurfaceHeight + drawnHeight + 2,
          bearingDeg: record.displayBearing,
        })
      }

      const text = vessel.name || String(vessel.mmsi)
      if (text !== record.labelText && record.labelEntity.label) {
        record.labelText = text
        record.labelEntity.label.text = new ConstantProperty(text)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }
    }

    // Nearest first, so the closest ship keeps her name in a crowd – and
    // the webcam pictures are claimed before any of them, which is how a
    // name steps aside for a picture it would sit on.
    nameCandidates.sort((a, b) => a.distance - b.distance)
    const namesVisible = keepNonOverlappingLabels(nameCandidates, NAME_METRICS, obstacles)
    for (let i = 0; i < nameCandidates.length; i++) {
      const { record } = nameCandidates[i]
      if (record.labelEntity.show !== namesVisible[i]) {
        record.labelEntity.show = namesVisible[i]
        this.host.requestRender()
      }
    }

    for (const [mmsi, record] of this.vessels) {
      if (!alive.has(mmsi)) {
        // Position first – remove() drops the record.
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
        this.remove(mmsi)
      }
    }
    smoke?.commit()
    wake?.commit()
    lights.commit()
    return {
      anyMovingVesselInView,
      nearestHullMeters,
      nearestHullWidthM,
      maxScreenMotionPx,
      maxTickMotionPx,
    }
  }

  /** Day→night ramp for the window glow and the lights (driven by the map's sun state). */
  applyNightFactor(night: number): void {
    this.windowGlowShader.setUniform('u_windowGlow', WINDOW_GLOW_MAX * night)
    this.night = night
  }

  /**
   * The underground view hides the surface fleet with the other layers.
   * Hiding is applied here so the switch acts at once; bringing the fleet
   * back is left to the next sync, which knows which hulls are inside
   * VESSEL_BODY_VISIBLE_RANGE.
   */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    for (const record of this.vessels.values()) {
      if (!visible) {
        if (record.primitive) record.primitive.show = false
        if (record.model) record.model.show = false
      }
      record.labelEntity.show = visible && this.labelsVisible && !this.namesAside()
    }
    // The plumes and the wakes go with the hulls; the next sync puts them back
    if (!visible) {
      this.host.funnelSmoke?.begin()
      this.host.funnelSmoke?.commit()
      this.host.wake?.begin(this.lastSyncMs)
      this.host.wake?.commit()
    }
    this.lights.setVisible(visible)
    this.host.requestRender()
  }

  /**
   * Follow a ship by MMSI, or nobody. A ship that is not on the map yet
   * gets no approach flight – the first sync that draws her engages the
   * chase instead, which is also what happens when she is off screen.
   */
  /** Chase leash follows the lens (see CesiumMap.applyLensDistance). */
  applyLensDistance(factor: number): boolean {
    return this.followCamera.applyLensDistance(factor)
  }

  setFollow(mmsi: number | null): void {
    this.followMmsi = mmsi
    if (mmsi === null) {
      this.followCamera.release()
      return
    }
    const record = this.vessels.get(mmsi)
    if (!record) {
      this.followCamera.engage(null)
      return
    }
    const carto = Cartographic.fromCartesian(record.displayPosition)
    this.followCamera.engage({
      lon: CesiumMath.toDegrees(carto.longitude),
      lat: CesiumMath.toDegrees(carto.latitude),
      centerHeight: this.host.waterSurfaceHeight + record.builtHeight + 2,
      bearingDeg: record.displayBearing,
    })
  }

  hasVessel(mmsi: number): boolean {
    return this.vessels.has(mmsi)
  }

  /**
   * The picked ship lights up, the one before her goes dark (null = none).
   * The twin of VehicleLayer.setSelected, and it keeps the MMSI rather
   * than only the record: a link restored from the URL picks a ship the
   * fleet has not reported yet, and she lights up when she arrives (see
   * createVessel), as does a hull that is still loading (attachModel).
   */
  setSelected(mmsi: number | null): void {
    if (mmsi === this.selectedMmsi) return
    const before = this.selectedMmsi === null ? undefined : this.vessels.get(this.selectedMmsi)
    if (before) {
      before.highlighted = false
      this.applyVesselAppearance(before, this.selectedMmsi as number)
    }
    this.selectedMmsi = mmsi
    if (mmsi !== null) {
      const record = this.vessels.get(mmsi)
      if (record) {
        record.highlighted = true
        this.applyVesselAppearance(record, mmsi)
      }
    }
    this.host.requestRender()
  }

  /** MMSI of the picked ship, null when nothing is picked. */
  get selectedVesselMmsi(): number | null {
    return this.selectedMmsi
  }

  /**
   * Writes a ship's highlight onto whichever body she is wearing: the
   * glTF hull washed toward white and rimmed in it, or – while the hull
   * is still loading – the placeholder box lerped the same way the land
   * fleet's boxes are. A primitive that has not been rendered yet has no
   * attributes to write; it is built with the highlight already in its
   * instance colour, so there is nothing to retry.
   */
  private applyVesselAppearance(record: VesselRecord, mmsi: number): void {
    if (record.model) {
      record.model.colorBlendMode = ColorBlendMode.MIX
      record.model.color = Color.WHITE
      record.model.colorBlendAmount = record.highlighted ? HIGHLIGHT_BLEND : 0
      record.model.silhouetteColor = Color.WHITE
      record.model.silhouetteSize = record.highlighted ? HIGHLIGHT_SILHOUETTE_PX : 0
    }
    if (record.primitive) {
      try {
        const attributes = record.primitive.getGeometryInstanceAttributes(`vessel:${mmsi}`)
        if (attributes) {
          attributes.color = ColorGeometryInstanceAttribute.toValue(
            this.hullTint(record),
            attributes.color,
          )
        }
      } catch {
        // Not rendered yet – the box was built in this colour anyway.
      }
    }
  }

  /** The box's colour as it should be drawn right now. */
  private hullTint(record: VesselRecord): Color {
    return record.highlighted
      ? Color.lerp(record.hullColor, Color.WHITE, HIGHLIGHT_BOX_MIX, new Color())
      : record.hullColor
  }

  /** Ship names off – the fleet's half of the Labels layer toggle. */
  setLabelsVisible(visible: boolean): void {
    if (visible === this.labelsVisible) return
    this.labelsVisible = visible
    for (const record of this.vessels.values()) {
      record.labelEntity.show = this.visible && visible && !this.namesAside()
    }
    this.host.requestRender()
  }

  /**
   * "Zoom to line": the ship names step aside for the route pulse, the way
   * the other lines' vehicle badges do (VehicleLayer.startLineFocus). No
   * ship belongs to a line here – the scheduled ferries are the vehicle
   * layer's – so every name goes, or the plates over the water would be
   * the only ones left on a screen the pulse is clearing. The hulls stay:
   * a name is what covers a route, a hull is where the ship is.
   *
   * The names come back on the first sync after the focus has run out,
   * a tick behind the pulse, again like the badges.
   */
  startLineFocus(durationMs: number): void {
    this.lineFocusUntil = performance.now() + durationMs
    for (const record of this.vessels.values()) record.labelEntity.show = false
    this.host.requestRender()
  }

  /** Whether a running line focus currently keeps the names off screen. */
  private namesAside(): boolean {
    return performance.now() < this.lineFocusUntil
  }

  get vesselCount(): number {
    return this.vessels.size
  }

  /** MMSI of the ship the camera is chasing, null when free. */
  get followedMmsi(): number | null {
    return this.followMmsi
  }

  private createVessel(vessel: AisVessel, nowMs: number): VesselRecord {
    const archetype = archetypeFor(vessel.typeCode, vessel.lengthM, vessel.widthM)
    const style = vesselStyle(vessel.typeCode)
    const length = vessel.lengthM ?? DEFAULT_LENGTH
    const width = vessel.widthM ?? DEFAULT_WIDTH
    const sample = playbackSample(vessel, nowMs - AIS_PLAYBACK_DELAY_MS)
    const position = Cartesian3.fromDegrees(
      sample.lon,
      sample.lat,
      this.host.waterSurfaceHeight + style.height / 2,
    )
    const matrix = Transforms.headingPitchRollToFixedFrame(
      position,
      new HeadingPitchRoll(CesiumMath.toRadians(sample.bearingDeg - 90), 0, 0),
    )
    const hullColor = Color.fromCssColorString(style.color)
    // Already the picked ship – restored from a link before she was ever
    // reported, or her box rebuilt at a size that arrived late. She is
    // built lit rather than lighting up a tick afterwards.
    const highlighted = this.selectedMmsi === vessel.mmsi
    const color = highlighted
      ? Color.lerp(hullColor, Color.WHITE, HIGHLIGHT_BOX_MIX, new Color())
      : hullColor
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: BoxGeometry.fromDimensions({
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new Cartesian3(length, width, style.height),
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        id: `vessel:${vessel.mmsi}`,
      }),
      appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
      asynchronous: false,
      modelMatrix: matrix,
    })
    primitive.show = this.visible
    this.root.add(primitive)

    const labelPosition = new ConstantPositionProperty(position)
    const labelText = vessel.name || String(vessel.mmsi)
    const labelEntity = this.viewer.entities.add({
      id: `vessel:${vessel.mmsi}`,
      position: labelPosition,
      show: this.visible && this.labelsVisible && !this.namesAside(),
      label: {
        text: labelText,
        font: 'bold 10px "Inter Variable", system-ui, sans-serif',
        fillColor: NAME_INK,
        style: LabelStyle.FILL,
        showBackground: true,
        backgroundColor: NAME_PLATE,
        backgroundPadding: new Cartesian2(NAME_PAD_X_PX, 5),
        pixelOffset: new Cartesian2(0, NAME_PIXEL_OFFSET_Y),
        distanceDisplayCondition: new DistanceDisplayCondition(0, NAME_VISIBLE_RANGE),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    const record: VesselRecord = {
      archetype,
      highlighted,
      hullColor,
      // Primitive CLONES the modelMatrix passed in – reference its own
      // instance so the in-place updates in sync() actually move the box.
      primitive,
      model: null,
      modelMatrix: null,
      matrix: primitive.modelMatrix,
      labelEntity,
      labelPosition,
      builtLength: length,
      builtWidth: width,
      builtHeight: style.height,
      labelText,
      displayPosition: Cartesian3.clone(position),
      displayBearing: sample.bearingDeg,
      lastPosition: Cartesian3.clone(position),
      lastBearing: sample.bearingDeg,
      renderedPosition: Cartesian3.clone(position),
      renderedBearing: sample.bearingDeg,
      renderedStamp: this.renderStamp,
      clampedHeight: null,
      clampLon: sample.lon,
      clampLat: sample.lat,
      clampedGeneration: -1,
      wakeUntilMs: 0,
    }
    void this.attachModel(record, vessel.mmsi)
    return record
  }

  /**
   * Swaps the placeholder box for the archetype's glTF hull once it is
   * in. A failed load (offline, tests) keeps the box – the fleet stays
   * visible either way.
   */
  private async attachModel(record: VesselRecord, mmsi: number): Promise<void> {
    const spec = VESSEL_MODELS[record.archetype]
    let model: Model
    try {
      model = await Model.fromGltfAsync({
        url: `${import.meta.env.BASE_URL}${spec.uri}`,
        id: `vessel:${mmsi}`,
        modelMatrix: Matrix4.clone(record.matrix),
        // Casts onto the tiles, receives nothing – same reasoning as the
        // land vehicles. A hull never enters a tunnel, so unlike theirs
        // this one is set once and never reassigned.
        shadows: ShadowMode.CAST_ONLY,
      })
    } catch (error) {
      console.warn('[MiniGermany3D] Vessel model failed to load:', error)
      return
    }
    // The vessel may have expired (or the viewer been torn down) meanwhile
    if (this.viewer.isDestroyed() || this.vessels.get(mmsi) !== record) {
      model.destroy()
      return
    }
    model.customShader = this.windowGlowShader
    // The load lands between ticks, so it applies sync()'s body cutoff
    // itself instead of showing a hull the next tick would hide again.
    model.show =
      this.visible &&
      Cartesian3.distance(this.viewer.camera.positionWC, record.displayPosition) <
        VESSEL_BODY_VISIBLE_RANGE
    this.root.add(model)
    if (record.primitive) {
      this.root.remove(record.primitive)
      record.primitive = null
    }
    record.model = model
    // The hull replaces the box she was picked on, so it takes the
    // highlight with it (see setSelected).
    this.applyVesselAppearance(record, mmsi)
    // fromGltfAsync clones the matrix – rebind so the in-place scale
    // composition in sync() reaches the model.
    record.modelMatrix = model.modelMatrix
    this.host.requestRender()
  }

  private remove(mmsi: number): void {
    const record = this.vessels.get(mmsi)
    if (!record) return
    if (record.primitive) this.root.remove(record.primitive)
    if (record.model) this.root.remove(record.model)
    this.viewer.entities.remove(record.labelEntity)
    this.vessels.delete(mmsi)
  }
}
