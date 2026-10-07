/**
 * Live air traffic from ADS-B (see src/lib/aircraft.ts): one body per
 * aircraft in the type's real size, at its reported altitude, plus a
 * callsign plate. Built after VesselLayer – the same playback a few
 * seconds behind the clock, the same display ease, the same pacing
 * signals, the same highlight and chase – with three differences that
 * are the aircraft's own:
 *
 * - It flies in three dimensions. The pose is heading, pitch and roll:
 *   the nose follows the true heading where the transponder reports it
 *   (the aircraft crabs into the wind and the track over the ground is
 *   not where it points), the pitch is the climb angle out of the
 *   vertical rate and the ground speed, the bank is the reported roll
 *   or, without one, what the turn rate and the speed say it must be.
 * - Its height is a number the feed sends, not a surface to clamp to:
 *   the geometric altitude is a height above the WGS84 ellipsoid and
 *   goes straight into Cesium; where only the pressure altitude is
 *   reported it is lifted by what the aircraft reporting both measure
 *   at that height – the geoid height and the day's pressure (see
 *   pressureLift) – fix by fix, by the kind each fix carries (see
 *   AircraftTrackPoint). Only an aircraft on the ground is clamped to
 *   the tiles, the way the ships are, so a taxiing airliner rolls on
 *   Google's apron – and one landing from its last fix in the air on,
 *   so it comes down onto the runway rather than dropping onto it (see
 *   drawnHeight), and one the reckoning carries down blind, so it stops
 *   on the runway rather than sinking through it (see sinkingBlind).
 * - Its plate is blue (NAME_PLATE) – the fourth kind of name on the map
 *   after the vehicles' line badges, the stops' bare text and the
 *   ships' slate, and it must not converge with any of them (see
 *   PROJECT-PLAN-DECISIONS.md, "Three kinds of name").
 *
 * The ranges are wide: an aircraft at cruise is ten kilometres up and
 * the box is seventy across, so the plates are drawn out to
 * LABEL_VISIBLE_RANGE and the bodies to BODY_VISIBLE_RANGE, where a
 * wide-body is still a few pixels. Nothing here is more than one body,
 * one label and a handful of lights per aircraft, and a city sees a few
 * dozen.
 *
 * The lights (NavLights, timed by lib/nav-lights.ts): the red and green
 * position lights at the wing tips, the white tail light, the flashing
 * red beacons and the white strobes – in the air the whole set, taxiing
 * everything but the strobes, parked none. Their brightness follows the
 * night, though never to nothing: a strobe is seen by day. And the
 * landing gear, a glTF node of its own in every retractable type, is
 * shown only near the ground (GEAR_DOWN_AGL_M) – an airliner crossing
 * the box with its wheels out read as a toy.
 */

import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Cartesian4,
  Cartographic,
  Color,
  ColorBlendMode,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
  Credit,
  DistanceDisplayCondition,
  GeometryInstance,
  HeadingPitchRoll,
  Intersect,
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  Model,
  PerInstanceColorAppearance,
  Primitive,
  PrimitiveCollection,
  ShadowMode,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import {
  AIRCRAFT_EXPIRE_MS,
  AIRCRAFT_PLAYBACK_DELAY_MS,
  aircraftPlaybackSample,
  pressureLift,
  pressureReference,
  type Aircraft,
  type AircraftPlaybackSample,
} from '@/lib/aircraft-extract'
import {
  ARCHETYPE_SIZE,
  aircraftSize,
  aircraftTitle,
  type AircraftArchetype,
  type AircraftSize,
} from '@/lib/aircraft-info'
import {
  AIRCRAFT_SIDELIGHT_ARC_DEG,
  aircraftLightsMode,
  beaconOn,
  lightPhaseMs,
  portLightSeen,
  starboardLightSeen,
  sternLightSeen,
  strobeOn,
  viewBearingDeg,
} from '@/lib/nav-lights'
import { FollowCamera } from '@/map/FollowCamera'
import { LIGHT_GREEN, LIGHT_RED, LIGHT_WHITE, NavLights, STROBE_PX } from './NavLights'
import { cameraFramingScale } from './CameraLens'
import { keepNonOverlappingLabels, type LabelMetrics, type ScreenRect } from './screen-rects'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'

/** What the layer needs from the map around it. */
export interface AircraftLayerHost {
  requestRender(): void
  /** Ellipsoid height of the city's ground – where an aircraft on the ground stands until it is clamped. */
  readonly defaultGroundHeight: number
  /**
   * Ellipsoid height of sea level here (the calibrated offset the routes
   * carry, see RoutesLayer.heightOffset) – what a pressure altitude is
   * lifted by to become a height Cesium can place where too few aircraft
   * around report both altitudes to measure the lift (see pressureLift).
   */
  readonly geoidHeight: number
  /**
   * How far the map's ground has been lowered under the real one: 0 with
   * the tiles, and on the flat map the city's ground height, which is
   * flattened to 0 m there (see CesiumMap.setBasemap). Every reported
   * altitude comes down by it, so an approach 300 m over the airport
   * shows 300 m over the map and not 300 m plus the airport's own height.
   * Absent, nothing is lowered.
   */
  readonly flattenedGroundM?: number
  /**
   * The ground is a plane at defaultGroundHeight, known without a pick:
   * offline and on the flat map (see CesiumMap.flatGround), where no
   * pick answers. Absent, the ground is the tiles'.
   */
  readonly flatGround?: boolean
  /**
   * Ellipsoid height of the loaded scene geometry under a position –
   * the tiles' own apron (scene.clampToHeight: an offscreen pick per
   * call, of the tiles alone). undefined where nothing is loaded yet or
   * picking is unsupported (offline).
   */
  clampToSurface?(lon: number, lat: number): number | undefined
  /**
   * Whether the camera stood still since the last tick – the surface
   * picks wait for that (see CesiumMap.cameraAtRest); absent, it is
   * taken to rest.
   */
  readonly cameraAtRest?: boolean
  /** Bumped whenever the loaded tiles changed – a clamped height is read again then. */
  surfaceGeneration?(): number
  /** A camera flight is starting – keeps the render loop at full rate. */
  noteCameraFlight(durationMs: number): void
  /** The city's leash for the chase camera (see FollowCameraHost.clampToLeash). */
  clampToLeash?(pose: Cartographic): Cartesian3 | null
  /** Whether every aircraft drawn counts as in view for the pacing (see CesiumMap.setPaceWholeView). */
  readonly paceWholeView?: boolean
  /** Screen rectangles the plates keep clear of (the webcam pictures). */
  obstacles?: () => readonly ScreenRect[]
  /** Window position of a world point (CSS px), undefined behind the camera. */
  windowPosition?: (position: Cartesian3) => Cartesian2 | undefined
  /** Device pixels per CSS pixel the map draws at (default 1). */
  readonly pixelRatio?: number
}

/**
 * Beyond this camera distance the body is not drawn any more and the
 * plate carries the aircraft alone. Twice the ships' range: an aircraft
 * at cruise is ten kilometres above the city and still a real thing in
 * the sky, and a wide-body is a few pixels there. Below
 * LABEL_VISIBLE_RANGE, so no aircraft loses its plate before its body.
 */
const BODY_VISIBLE_RANGE = 40_000
/** The plates fade in below this camera distance (metres) – the whole box from the home view. */
const LABEL_VISIBLE_RANGE = 60_000
/**
 * Beyond this camera distance an aircraft is off screen for the pacing –
 * measured at the reference lens and scaled by the lens the camera
 * wears (cameraFramingScale), like the ships' render range. Three
 * times theirs: an airliner covers a hundred metres a second and moves
 * on screen from much further out than a ship does.
 */
const AIRCRAFT_RENDER_RANGE_AT_REFERENCE = 15_000
/** The plate floats this many CSS pixels above the aircraft (negative = up). */
const NAME_PIXEL_OFFSET_Y = -16
/** Rough glyph width of the 10 px bold font, for the declutter. */
const NAME_PX_PER_CHAR = 6
const NAME_HEIGHT_PX = 19
const NAME_PAD_X_PX = 3
const NAME_GAP_PX = 2
const NAME_METRICS: LabelMetrics = {
  offsetY: NAME_PIXEL_OFFSET_Y + NAME_HEIGHT_PX / 2,
  height: NAME_HEIGHT_PX,
  gap: NAME_GAP_PX,
}
/**
 * The callsign plate: blue, where a ship's is slate and a stop's is bare
 * text – the sky's own colour, and one no line badge wears as a plain
 * dark ground. Opaque like the ships' (see NAME_PLATE there for why),
 * decluttered by the same pass.
 */
const NAME_PLATE = Color.fromCssColorString('#1e40af')
const NAME_INK = Color.fromCssColorString('#f8fafc')
/**
 * Time constant of the display smoothing in ms – position, heading,
 * pitch and roll all ease toward the playback target at this rate, the
 * ships' value: between ticks it makes motion fluid, and it rounds the
 * kinks where one track segment hands over to the next.
 */
const SMOOTH_TAU_MS = 400
/**
 * The ease while the playback hands over from dead reckoning to a fix
 * that landed late: the reckoned position and the chord the late fix
 * draws differ by however far the reckoning went wrong, and the usual
 * 400 ms closed that gap as a visible lurch. For HANDOVER_BLEND_MS after
 * the handover the position eases with this constant instead.
 */
const HANDOVER_TAU_MS = 1500
const HANDOVER_BLEND_MS = 2000
/** The climb angle drawn is capped: a transponder's rate is noisy, and an airliner never pitches more than this. */
const MAX_PITCH_DEG = 12
/** The bank drawn is capped at what an airliner turns with – a light aircraft rolls more, and reads fine at this. */
const MAX_BANK_DEG = 35
/** Placeholder box colour until the glTF body is in. */
const BODY_COLOR = Color.fromCssColorString('#d6d9dd')
/** Highlight of the picked aircraft – the vehicles' and the ships' own numbers (see VesselLayer). */
const HIGHLIGHT_BLEND = 0.25
const HIGHLIGHT_SILHOUETTE_PX = 2.5
const HIGHLIGHT_BOX_MIX = 0.45
/**
 * Only an aircraft on the ground, or coming down onto it – from its last
 * fix in the air, or blind – is clamped: to the apron, at most this
 * many picks a tick, again after this much motion, and after a load
 * cycle only within the refine range of the camera (the ships' rule,
 * see VesselLayer).
 */
const CLAMP_BUDGET_PER_TICK = 3
const CLAMP_MOVE_M = 25
const CLAMP_REFINE_RANGE_AT_REFERENCE = 2_000
/**
 * A blind descent (see sinkingBlind in sync) stops on an apron picked no
 * further back than this – the same stretch of runway; a pick left
 * further behind, the camera moving since, may be another airfield's.
 */
const CLAMP_FLOOR_RANGE_M = 250
const KNOT_MPS = 0.514444
const GRAVITY_MPS2 = 9.81
/**
 * Below this height over the city's ground the landing gear is out:
 * an airliner lowers it some five miles from the runway, about 1500 ft
 * up, and raises it seconds after lifting off. Measured against the
 * city's ground rather than the airport's, which the map does not know
 * – the two differ by tens of metres, not hundreds.
 */
const GEAR_DOWN_AGL_M = 600
/** The name of the gear's node in the glTF (scripts/lib/aircraft-fleet.mjs, mesh.parts.gear). */
const GEAR_NODE = 'gear'
/**
 * How bright the lights are by day: the position lights are on by day
 * too, and a strobe is seen by day – against a bright sky at a
 * distance, less than at night, which the night factor adds.
 */
const LIGHTS_DAY_INTENSITY = 0.35

/** A light's position in the model frame Cesium hands the layer (x forward, y port, z up). */
export interface LightPoint {
  x: number
  y: number
  z: number
}

/**
 * Where an aircraft's lights are, in the model frame: the position
 * lights at the wing tips (port red, starboard green), the white tail
 * light, the beacons on top of and under the fuselage. Recorded by the
 * workshop (mesh.lights in scripts/lib/aircraft-fleet.mjs, in its Y-up
 * frame) and pinned against these by tests/aircraft-models.test.ts.
 */
export interface AircraftLights {
  port: LightPoint
  starboard: LightPoint
  tail: LightPoint
  beaconTop: LightPoint
  beaconBottom: LightPoint
}

/**
 * glTF bodies per archetype, generated by scripts/build-vehicle-models.mjs
 * from scripts/lib/aircraft-fleet.mjs. Reference dimensions mirror
 * AIRCRAFT_DIMS there and ARCHETYPE_SIZE in lib/aircraft-info.ts (pinned
 * against the GLB bounds by tests/aircraft-models.test.ts); the drawn
 * aircraft is this model stretched to its type's size.
 */
const LIGHTS: Record<AircraftArchetype, AircraftLights> = {
  'aircraft-narrowbody': {
    port: { x: -3.39, y: 18.15, z: -0.96 },
    starboard: { x: -3.39, y: -18.15, z: -0.96 },
    tail: { x: -19.05, y: 0, z: -0.02 },
    beaconTop: { x: -1.88, y: 0, z: 1 },
    beaconBottom: { x: 3.76, y: 0, z: -3.5 },
  },
  'aircraft-widebody': {
    port: { x: -5.65, y: 30.4, z: -0.98 },
    starboard: { x: -5.65, y: -30.4, z: -0.98 },
    tail: { x: -32.1, y: 0, z: -0.19 },
    beaconTop: { x: -3.19, y: 0, z: 1.14 },
    beaconBottom: { x: 6.37, y: 0, z: -4.9 },
  },
  'aircraft-jumbo': {
    port: { x: -9.03, y: 40.15, z: -1.65 },
    starboard: { x: -9.03, y: -40.15, z: -1.65 },
    tail: { x: -36.6, y: 0, z: -0.03 },
    beaconTop: { x: -3.64, y: 0, z: 1.85 },
    beaconBottom: { x: 7.27, y: 0, z: -6.95 },
  },
  'aircraft-bizjet': {
    port: { x: -1.91, y: 10.05, z: -0.76 },
    starboard: { x: -1.91, y: -10.05, z: -0.76 },
    tail: { x: -10.7, y: 0, z: 0.41 },
    beaconTop: { x: -1.04, y: 0, z: 1.01 },
    beaconBottom: { x: 2.09, y: 0, z: -2.09 },
  },
  'aircraft-turboprop': {
    port: { x: 1.41, y: 13.8, z: 0.3 },
    starboard: { x: 1.41, y: -13.8, z: 0.3 },
    tail: { x: -13.85, y: 0, z: 0.1 },
    beaconTop: { x: -1, y: 0, z: 0.1 },
    beaconBottom: { x: 3, y: 0, z: -3.18 },
  },
  'aircraft-light': {
    port: { x: 1.78, y: 5.75, z: 0.82 },
    starboard: { x: 1.78, y: -5.75, z: 0.82 },
    tail: { x: -4.4, y: 0, z: 0.1 },
    beaconTop: { x: -3.48, y: 0, z: 1.3 },
    beaconBottom: { x: 0.6, y: 0, z: -0.92 },
  },
  'aircraft-helicopter': {
    port: { x: 1.2, y: 1.12, z: -0.1 },
    starboard: { x: 1.2, y: -1.12, z: -0.1 },
    tail: { x: -5.35, y: 0, z: 0.3 },
    beaconTop: { x: -0.6, y: 0, z: 1.42 },
    beaconBottom: { x: 1.5, y: 0, z: -1.25 },
  },
}

export const AIRCRAFT_MODELS: Record<
  AircraftArchetype,
  { uri: string; lengthM: number; spanM: number; heightM: number; lights: AircraftLights }
> = Object.fromEntries(
  (Object.keys(ARCHETYPE_SIZE) as AircraftArchetype[]).map((archetype) => [
    archetype,
    { uri: `models/${archetype}.glb`, ...ARCHETYPE_SIZE[archetype], lights: LIGHTS[archetype] },
  ]),
) as Record<
  AircraftArchetype,
  { uri: string; lengthM: number; spanM: number; heightM: number; lights: AircraftLights }
>

interface AircraftRecord {
  size: AircraftSize
  highlighted: boolean
  /** Placeholder box until the glTF body is in (null afterwards). */
  primitive: Primitive | null
  /** glTF body; null while loading or after a failure. */
  model: Model | null
  /** The model's own matrix – fromGltfAsync clones what it got. */
  modelMatrix: Matrix4 | null
  /** Unscaled base pose; the model matrix composes scale on top. */
  matrix: Matrix4
  labelEntity: Entity
  labelPosition: ConstantPositionProperty
  labelText: string
  /** Smoothed pose actually drawn (eases toward the playback target). */
  displayPosition: Cartesian3
  displayBearing: number
  displayPitch: number
  displayRoll: number
  /** Whether the last sample was flown on by dead reckoning (see HANDOVER_TAU_MS). */
  reckoned: boolean
  /** Until when the position eases with HANDOVER_TAU_MS after a handover. */
  blendUntilMs: number
  /** Pose as of the last repaint request – the change detector. */
  lastPosition: Cartesian3
  lastBearing: number
  /** Pose as of the frame that was last RENDERED (see VesselLayer's twin). */
  renderedPosition: Cartesian3
  renderedBearing: number
  renderedStamp: number
  /** Apron height the aircraft was last clamped to on the ground, and where (see VesselLayer). */
  clampedHeight: number | null
  clampLon: number
  clampLat: number
  clampedGeneration: number
  /** The playback as last drawn, its pressure lift, and whether it stood on the apron (see asDrawn). */
  sample: AircraftPlaybackSample | null
  liftM: number
  grounded: boolean
  /** The per-aircraft offset of its flashes (see lightPhaseMs). */
  lightPhaseMs: number
  /** Beacon and strobe as last drawn – a change on screen is worth a frame. */
  lastBeacon: boolean
  lastStrobe: boolean
  /** Whether the gear node is shown, null until the model has one to show. */
  gearShown: boolean | null
}

const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll(0, 0, 0)
const scaleScratch = new Cartesian3()
const lightScratch = new Cartesian3()
const lightWorldScratch = new Cartesian3()
const axisScratch = new Cartesian4()
const toCameraScratch = new Cartesian3()

/** The dot product of a pose matrix's axis (0 forward, 1 port, 2 up) with a world vector. */
function axisDot(matrix: Matrix4, column: 0 | 1 | 2, vector: Cartesian3): number {
  Matrix4.getColumn(matrix, column, axisScratch)
  return axisScratch.x * vector.x + axisScratch.y * vector.y + axisScratch.z * vector.z
}

export class AircraftLayer {
  private aircraft = new Map<string, AircraftRecord>()
  /** Every primitive of the fleet under one collection – the ships' reasoning (VesselLayer.root). */
  readonly root = new PrimitiveCollection({ destroyPrimitives: true })
  private visible = true
  private labelsVisible = true
  /** "Zoom to line" keeps the plates off until this instant (startLineFocus). */
  private lineFocusUntil = 0
  /** Address of the picked aircraft, null when nothing is picked. */
  private selectedHex: string | null = null
  /** Address the camera is chasing, null when free. */
  private followHex: string | null = null
  private readonly followCamera: FollowCamera
  private frustumSphere = new BoundingSphere()
  private lastSyncMs = 0
  /** Counts rendered frames (see markRendered / AircraftRecord.renderedStamp). */
  private renderStamp = 0
  /** adsb.fi's line in the credits, while any aircraft is drawn – its terms ask for a citation with a link. */
  private credit: Credit | null = null
  /** The position lights, beacons and strobes of every aircraft drawn (see NavLights). */
  private readonly lights: NavLights
  /** 0 = day … 1 = full night; the lights' brightness follows it. */
  private night = 0

  constructor(
    private readonly viewer: Viewer,
    private readonly host: AircraftLayerHost,
  ) {
    this.followCamera = new FollowCamera(viewer, host)
    viewer.scene.primitives.add(this.root)
    this.lights = new NavLights(this.root)
  }

  /** Day→night ramp for the lights (driven by the map's sun state). */
  applyNightFactor(night: number): void {
    this.night = night
  }

  /** Lights on at the last tick – the debug API's count. */
  get lightCount(): number {
    return this.lights.count
  }

  /** Whether `position` sits inside the view and close enough to matter (the ships' rule). */
  private isOnScreen(
    cullingVolume: { computeVisibility(sphere: BoundingSphere): number },
    position: Cartesian3,
  ): boolean {
    if (!this.visible) return false
    const camera = this.viewer.camera
    const renderRange = this.host.paceWholeView
      ? LABEL_VISIBLE_RANGE
      : AIRCRAFT_RENDER_RANGE_AT_REFERENCE * cameraFramingScale(camera)
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
   * Per-tick update: played-back poses, arrivals, departures. Returns
   * whether an aircraft whose drawn pose is still changing sits inside
   * the view – the app's tick and render pacing treat that like a tram
   * in view – and the nearest drawn body for the map's shadow gate.
   */
  sync(
    list: Aircraft[],
    nowMs: number,
  ): {
    anyMovingAircraftInView: boolean
    nearestBodyMeters: number
    nearestBodySpanM: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    const entities = this.viewer.entities
    entities.suspendEvents()
    try {
      return this.syncBatched(list, nowMs)
    } finally {
      entities.resumeEvents()
    }
  }

  /** The map drew a frame: motion is measured against the poses of the tick before this call from here on. */
  markRendered(): void {
    this.renderStamp++
  }

  private syncBatched(
    list: Aircraft[],
    nowMs: number,
  ): {
    anyMovingAircraftInView: boolean
    nearestBodyMeters: number
    nearestBodySpanM: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    const renderMs = nowMs - AIRCRAFT_PLAYBACK_DELAY_MS
    const alive = new Set<string>()
    const camera = this.viewer.camera
    const obstacles = this.host.obstacles?.() ?? []
    const namesAside = this.namesAside()
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    )
    const dtMs = this.lastSyncMs > 0 ? Math.max(0, nowMs - this.lastSyncMs) : 0
    this.lastSyncMs = nowMs
    const alpha = dtMs > 0 && dtMs < 2000 ? 1 - Math.exp(-dtMs / SMOOTH_TAU_MS) : 1

    let anyMovingAircraftInView = false
    let nearestBodyMeters = Number.POSITIVE_INFINITY
    let nearestBodySpanM = ARCHETYPE_SIZE['aircraft-light'].spanM
    const pxPerMeterAtUnit = cssPixelsPerMeterAtUnitDistance(this.viewer)
    const motionThreshold = motionThresholdCssPx(this.host.pixelRatio ?? 1)
    let maxScreenMotionPx = 0
    let maxTickMotionPx = 0
    const windowPosition = this.host.windowPosition
    const nameCandidates: {
      record: AircraftRecord
      distance: number
      x: number
      y: number
      halfWidth: number
    }[] = []
    let clampBudget = CLAMP_BUDGET_PER_TICK
    const surfaceGeneration = this.host.surfaceGeneration?.() ?? 0
    const lights = this.lights
    lights.begin()
    const lightIntensity = LIGHTS_DAY_INTENSITY + (1 - LIGHTS_DAY_INTENSITY) * this.night
    // What lifts a pressure altitude onto the geometric scale today, from
    // the aircraft that report both (see pressureLift)
    const liftAt = pressureLift(list, this.host.geoidHeight)

    for (const aircraft of list) {
      if (nowMs - aircraft.positionAt > AIRCRAFT_EXPIRE_MS) continue
      alive.add(aircraft.hex)

      const liftM = liftAt(pressureReference(aircraft))
      let record = this.aircraft.get(aircraft.hex)
      // A type learnt after the first position picks a different body
      const size = aircraftSize(aircraft.typeCode, aircraft.category, aircraft.callsign)
      if (record && record.size.archetype !== size.archetype) {
        this.remove(aircraft.hex)
        record = undefined
      }
      if (!record) {
        record = this.createAircraft(aircraft, size, nowMs, liftM)
        this.aircraft.set(aircraft.hex, record)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }
      record.size = size

      const sample = aircraftPlaybackSample(aircraft, renderMs, liftM)
      const spec = AIRCRAFT_MODELS[size.archetype]
      const lengthScale = size.lengthM / spec.lengthM
      const spanScale = size.spanM / spec.spanM
      const heightScale = size.heightM / spec.heightM

      // Flown on blind and sinking near the ground: the feed has gone quiet
      // on short final – Frankfurt's feeders lose most landings a few
      // metres over the runway and hear them again on the ground up to a
      // couple of minutes on – and the reckoning carries the
      // aircraft on down at its rate, which ended 77 m under the runway.
      // It is clamped like one on the ground, and stopped on the apron
      const sinkingBlind =
        sample.reckoned &&
        sample.altM !== null &&
        (sample.verticalRateMps ?? 0) < 0 &&
        sample.altM - (this.host.flattenedGroundM ?? 0) - this.host.defaultGroundHeight <
          GEAR_DOWN_AGL_M
      const fromLastPickM = (r: AircraftRecord) =>
        Math.hypot(
          (sample.lon - r.clampLon) * 111_320 * Math.cos((sample.lat * Math.PI) / 180),
          (sample.lat - r.clampLat) * 111_132,
        )

      // Height: the feed's own number in the air; on the ground the tiles'
      // apron, clamped the way the ships are – only when the answer could
      // have changed, only on screen, a few a tick (see VesselLayer) – and
      // from the last fix in the air on, so the apron a landing comes down
      // onto is known before it gets there (see drawnHeight)
      if (sample.groundShare > 0 || sinkingBlind) {
        if (
          this.host.clampToSurface &&
          clampBudget > 0 &&
          (this.host.cameraAtRest !== false || aircraft.hex === this.followHex)
        ) {
          const movedM = fromLastPickM(record)
          const stale =
            movedM > CLAMP_MOVE_M ||
            (record.clampedGeneration !== surfaceGeneration &&
              (record.clampedHeight === null ||
                Cartesian3.distance(camera.positionWC, record.displayPosition) <
                  CLAMP_REFINE_RANGE_AT_REFERENCE * cameraFramingScale(camera)))
          if (stale && this.isOnScreen(cullingVolume, record.displayPosition)) {
            clampBudget--
            const h = this.host.clampToSurface(sample.lon, sample.lat)
            record.clampLon = sample.lon
            record.clampLat = sample.lat
            record.clampedGeneration = surfaceGeneration
            if (h !== undefined) record.clampedHeight = h
          }
        }
      }
      const ground = (record.clampedHeight ?? this.host.defaultGroundHeight) + size.heightM / 2
      let height = this.drawnHeight(sample, ground)
      // Standing or rolling on the apron – level, the gear out, the strobes off
      let grounded = sample.groundShare > 0 && height <= ground
      // The blind descent ends on the apron picked under the aircraft – a
      // pick near where it is, never one left behind elsewhere; on a flat
      // ground, on that – and rolls on there for what is left of the
      // reckoning
      if (
        sinkingBlind &&
        height <= ground &&
        (this.host.flatGround === true ||
          (record.clampedHeight !== null && fromLastPickM(record) <= CLAMP_FLOOR_RANGE_M))
      ) {
        height = ground
        grounded = true
      }
      // What the card shows, the picture's instant rather than the last fix (see asDrawn)
      record.sample = sample
      record.liftM = liftM
      record.grounded = grounded
      // A late fix after a spell of reckoning: ease the gap over longer
      if (record.reckoned && !sample.reckoned) record.blendUntilMs = nowMs + HANDOVER_BLEND_MS
      record.reckoned = sample.reckoned
      const positionAlpha =
        nowMs < record.blendUntilMs && dtMs > 0 && dtMs < 2000
          ? 1 - Math.exp(-dtMs / HANDOVER_TAU_MS)
          : alpha
      const target = Cartesian3.fromDegrees(sample.lon, sample.lat, height, undefined, positionScratch)
      Cartesian3.lerp(record.displayPosition, target, positionAlpha, record.displayPosition)
      if (Cartesian3.equalsEpsilon(record.displayPosition, target, 0, 0.05)) {
        Cartesian3.clone(target, record.displayPosition)
      }

      // The nose: the playback's, eased along the heading's own arc –
      // before, it was the motion bearing plus the crab of the
      // record's LATEST heading against its latest track, and a track
      // that flipped between two fixes (a parked transponder's, or the
      // stale one a taxiing aircraft keeps) swung the nose through 180°
      // and back while the heading itself never moved
      const targetBearing = sample.noseDeg
      const bearingGap = ((targetBearing - record.displayBearing + 540) % 360) - 180
      record.displayBearing =
        Math.abs(bearingGap) < 0.05
          ? targetBearing
          : (record.displayBearing + bearingGap * alpha + 360) % 360
      // Climb angle out of the vertical rate and the ground speed
      const gsMps = (sample.gsKn ?? 0) * KNOT_MPS
      const targetPitch =
        grounded || gsMps < 5
          ? 0
          : CesiumMath.clamp(
              CesiumMath.toDegrees(Math.atan2(sample.verticalRateMps ?? 0, gsMps)),
              -MAX_PITCH_DEG,
              MAX_PITCH_DEG,
            )
      record.displayPitch += (targetPitch - record.displayPitch) * alpha
      // Bank: the roll reported at the drawn instant (the record's where
      // the fixes are too old to carry one), or the coordinated turn the
      // turn rate implies
      const reportedRoll = sample.rollDeg === undefined ? aircraft.rollDeg : sample.rollDeg
      const targetRoll =
        grounded
          ? 0
          : reportedRoll !== null
            ? CesiumMath.clamp(reportedRoll, -MAX_BANK_DEG, MAX_BANK_DEG)
            : CesiumMath.clamp(
                CesiumMath.toDegrees(
                  Math.atan((gsMps * CesiumMath.toRadians(sample.turnRateDegPerS)) / GRAVITY_MPS2),
                ),
                -MAX_BANK_DEG,
                MAX_BANK_DEG,
              )
      record.displayRoll += (targetRoll - record.displayRoll) * alpha

      hprScratch.heading = CesiumMath.toRadians(record.displayBearing - 90)
      hprScratch.pitch = CesiumMath.toRadians(record.displayPitch)
      hprScratch.roll = CesiumMath.toRadians(record.displayRoll)
      Transforms.headingPitchRollToFixedFrame(
        record.displayPosition,
        hprScratch,
        undefined,
        undefined,
        record.matrix,
      )
      if (record.model && record.modelMatrix) {
        // Model frame after Cesium's glTF mapping: x = travel, y = span, z = up
        scaleScratch.x = lengthScale
        scaleScratch.y = spanScale
        scaleScratch.z = heightScale
        Matrix4.multiplyByScale(record.matrix, scaleScratch, record.modelMatrix)
      }
      record.labelPosition.setValue(record.displayPosition)
      const distance = Cartesian3.distance(camera.positionWC, record.displayPosition)

      // Which plates are drawn is settled after the loop by the declutter
      // the ships' names use (see VesselLayer); the loop collects
      let nameShown = this.visible && this.labelsVisible && !namesAside
      if (nameShown && distance < LABEL_VISIBLE_RANGE && windowPosition) {
        const window = windowPosition(record.displayPosition)
        if (window) {
          nameCandidates.push({
            record,
            distance,
            x: window.x,
            y: window.y,
            halfWidth: (record.labelText.length * NAME_PX_PER_CHAR) / 2 + NAME_PAD_X_PX,
          })
          nameShown = record.labelEntity.show === true
        } else {
          nameShown = false
        }
      }
      if (record.labelEntity.show !== nameShown) {
        record.labelEntity.show = nameShown
        this.host.requestRender()
      }
      const showBody = this.visible && distance < BODY_VISIBLE_RANGE
      if (showBody && distance < nearestBodyMeters) {
        nearestBodyMeters = distance
        nearestBodySpanM = size.spanM
      }
      const body = record.model ?? record.primitive
      if (body && body.show !== showBody) {
        body.show = showBody
        this.host.requestRender()
      }
      // The gear: out near the ground, folded away above it – set on the
      // glTF node once the model is in, and again only when it changes
      if (record.model?.ready) {
        const gearDown = grounded || height - this.host.defaultGroundHeight < GEAR_DOWN_AGL_M
        if (record.gearShown !== gearDown) {
          const node = record.model.getNode(GEAR_NODE)
          if (node) node.show = gearDown
          record.gearShown = gearDown
          if (showBody) this.host.requestRender()
        }
      }
      // The lights, from the clock: steady position lights, the beacons
      // and strobes flashing on the aircraft's own phase. A flash that
      // changed since the last tick on an aircraft on screen is a frame.
      const mode = aircraftLightsMode(grounded, sample.moving || (sample.gsKn ?? 0) >= 1)
      let beacon = false
      let strobe = false
      if (showBody && mode !== 'off') {
        const inAir = !grounded
        const at = (point: LightPoint) => {
          lightScratch.x = point.x * lengthScale
          lightScratch.y = point.y * spanScale
          lightScratch.z = point.z * heightScale
          return Matrix4.multiplyByPoint(record.matrix, lightScratch, lightWorldScratch)
        }
        const id = `aircraft:${aircraft.hex}`
        // The position lights are screened – each shows over its own arc,
        // so the camera chasing from behind sees the tail light and the
        // strobes, and one ahead the red and the green together
        Cartesian3.subtract(camera.positionWC, record.displayPosition, toCameraScratch)
        const forwardDot = axisDot(record.matrix, 0, toCameraScratch)
        const portDot = axisDot(record.matrix, 1, toCameraScratch)
        const bearing = viewBearingDeg(forwardDot, portDot)
        beacon = beaconOn(nowMs, record.lightPhaseMs)
        strobe = mode === 'flight' && strobeOn(nowMs, record.lightPhaseMs)
        if (strobe) {
          lights.add(at(spec.lights.port), LIGHT_WHITE, lightIntensity, id, STROBE_PX, inAir)
          lights.add(at(spec.lights.starboard), LIGHT_WHITE, lightIntensity, id, STROBE_PX, inAir)
        } else {
          if (portLightSeen(bearing, AIRCRAFT_SIDELIGHT_ARC_DEG)) {
            lights.add(at(spec.lights.port), LIGHT_RED, lightIntensity, id, undefined, inAir)
          }
          if (starboardLightSeen(bearing, AIRCRAFT_SIDELIGHT_ARC_DEG)) {
            lights.add(at(spec.lights.starboard), LIGHT_GREEN, lightIntensity, id, undefined, inAir)
          }
        }
        if (sternLightSeen(bearing, AIRCRAFT_SIDELIGHT_ARC_DEG)) {
          lights.add(at(spec.lights.tail), LIGHT_WHITE, lightIntensity, id, undefined, inAir)
        }
        if (beacon) lights.add(at(spec.lights.beaconTop), LIGHT_RED, lightIntensity, id, undefined, inAir)
        if (beaconOn(nowMs, record.lightPhaseMs, true)) {
          lights.add(at(spec.lights.beaconBottom), LIGHT_RED, lightIntensity, id, undefined, inAir)
        }
      }
      if (
        (beacon !== record.lastBeacon || strobe !== record.lastStrobe) &&
        this.isOnScreen(cullingVolume, record.displayPosition)
      ) {
        this.host.requestRender()
      }
      record.lastBeacon = beacon
      record.lastStrobe = strobe
      if (record.renderedStamp !== this.renderStamp) {
        Cartesian3.clone(record.lastPosition, record.renderedPosition)
        record.renderedBearing = record.lastBearing
        record.renderedStamp = this.renderStamp
      }
      const poseChanged =
        !Cartesian3.equalsEpsilon(record.displayPosition, record.lastPosition, 0, 0.02) ||
        Math.abs(record.displayBearing - record.lastBearing) > 0.05
      // The pacing signal keys on the playback's own "moving", stable
      // across ticks, with the pose ease riding along (the ships' reasoning)
      if ((poseChanged || sample.moving) && this.isOnScreen(cullingVolume, record.displayPosition)) {
        anyMovingAircraftInView = true
        const halfLength = size.lengthM / 2
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

      // Chase from the DRAWN pose, along the direction of motion
      if (aircraft.hex === this.followHex) {
        const carto = Cartographic.fromCartesian(record.displayPosition)
        this.followCamera.update({
          lon: CesiumMath.toDegrees(carto.longitude),
          lat: CesiumMath.toDegrees(carto.latitude),
          centerHeight: carto.height + size.heightM / 2,
          bearingDeg: sample.bearingDeg,
        })
      }

      const text = aircraftTitle(aircraft)
      if (text !== record.labelText && record.labelEntity.label) {
        record.labelText = text
        record.labelEntity.label.text = new ConstantProperty(text)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }
    }

    // Nearest first, so the closest aircraft keeps its plate in a crowd
    nameCandidates.sort((a, b) => a.distance - b.distance)
    const namesVisible = keepNonOverlappingLabels(nameCandidates, NAME_METRICS, obstacles)
    for (let i = 0; i < nameCandidates.length; i++) {
      const { record } = nameCandidates[i]
      if (record.labelEntity.show !== namesVisible[i]) {
        record.labelEntity.show = namesVisible[i]
        this.host.requestRender()
      }
    }

    for (const [hex, record] of this.aircraft) {
      if (!alive.has(hex)) {
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
        this.remove(hex)
      }
    }
    lights.commit()
    this.applyCredit()
    return {
      anyMovingAircraftInView,
      nearestBodyMeters,
      nearestBodySpanM,
      maxScreenMotionPx,
      maxTickMotionPx,
    }
  }

  /**
   * The underground view hides the traffic with the rest of the surface.
   * Hiding is applied here so the switch acts at once; bringing the
   * bodies back is left to the next sync, which knows the cutoffs.
   */
  /**
   * Forgets every apron height picked off the tiles – the ground changed
   * under the traffic (see CesiumMap.setBasemap); the next tick stands
   * every aircraft on the ground on the map's ground again.
   */
  resetClamps(): void {
    for (const record of this.aircraft.values()) {
      record.clampedHeight = null
      record.clampedGeneration = -1
    }
    this.host.requestRender()
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    for (const record of this.aircraft.values()) {
      if (!visible) {
        if (record.primitive) record.primitive.show = false
        if (record.model) record.model.show = false
      }
      record.labelEntity.show = visible && this.labelsVisible && !this.namesAside()
    }
    this.lights.setVisible(visible)
    this.host.requestRender()
  }

  /** Chase leash follows the lens (see CesiumMap.applyLensDistance). */
  applyLensDistance(factor: number): boolean {
    return this.followCamera.applyLensDistance(factor)
  }

  /**
   * Follow an aircraft by address, or nobody. One not on the map yet
   * gets no approach flight – the first sync that draws it engages the
   * chase instead (the ships' behaviour).
   */
  setFollow(hex: string | null): void {
    this.followHex = hex
    if (hex === null) {
      this.followCamera.release()
      return
    }
    const record = this.aircraft.get(hex)
    if (!record) {
      this.followCamera.engage(null)
      return
    }
    const carto = Cartographic.fromCartesian(record.displayPosition)
    this.followCamera.engage({
      lon: CesiumMath.toDegrees(carto.longitude),
      lat: CesiumMath.toDegrees(carto.latitude),
      centerHeight: carto.height + record.size.heightM / 2,
      bearingDeg: record.displayBearing,
    })
  }

  hasAircraft(hex: string): boolean {
    return this.aircraft.has(hex)
  }

  /**
   * The aircraft as the picture shows it, for its card: the record with
   * the kinematics of the instant drawn – the playback's, twelve seconds
   * behind the feed – in place of its last fix's: the altitude as the
   * transponder reports it, the ground speed, the climb, and the ground
   * once the body stands on it. The card showed the last fix
   * before, and said "on the ground" while the body was still twelve
   * seconds out on its final approach. The pressure altitude beside a
   * geometric one (the flight level) is the aircraft's own difference
   * between the two where its record reports both, the sky's otherwise
   * (see pressureLift). null for an aircraft not drawn yet.
   */
  asDrawn(aircraft: Aircraft): Aircraft | null {
    const record = this.aircraft.get(aircraft.hex)
    const sample = record?.sample
    if (!record || !sample) return null
    if (record.grounded || sample.altM === null) {
      return {
        ...aircraft,
        onGround: true,
        altGeomM: null,
        altBaroM: null,
        gsKn: sample.gsKn,
        verticalRateMps: null,
      }
    }
    const geomOverBaroM =
      sample.altGeometric && aircraft.altGeomM !== null && aircraft.altBaroM !== null
        ? aircraft.altGeomM - aircraft.altBaroM
        : record.liftM
    return {
      ...aircraft,
      onGround: false,
      altGeomM: sample.altGeometric ? sample.altM : null,
      altBaroM: sample.altM - geomOverBaroM,
      gsKn: sample.gsKn,
      verticalRateMps: sample.verticalRateMps,
    }
  }

  /**
   * The picked aircraft lights up, the one before it goes dark (null =
   * none) – the two marks every picked thing on this map wears (see
   * VesselLayer.setSelected). Kept by address, so a link restored before
   * the aircraft was reported lights it up when it arrives.
   */
  setSelected(hex: string | null): void {
    if (hex === this.selectedHex) return
    const before = this.selectedHex === null ? undefined : this.aircraft.get(this.selectedHex)
    if (before) {
      before.highlighted = false
      this.applyAppearance(before, this.selectedHex as string)
    }
    this.selectedHex = hex
    if (hex !== null) {
      const record = this.aircraft.get(hex)
      if (record) {
        record.highlighted = true
        this.applyAppearance(record, hex)
      }
    }
    this.host.requestRender()
  }

  /** Address of the picked aircraft, null when nothing is picked. */
  get selectedAircraftHex(): string | null {
    return this.selectedHex
  }

  private applyAppearance(record: AircraftRecord, hex: string): void {
    if (record.model) {
      record.model.colorBlendMode = ColorBlendMode.MIX
      record.model.color = Color.WHITE
      record.model.colorBlendAmount = record.highlighted ? HIGHLIGHT_BLEND : 0
      record.model.silhouetteColor = Color.WHITE
      record.model.silhouetteSize = record.highlighted ? HIGHLIGHT_SILHOUETTE_PX : 0
    }
    if (record.primitive) {
      try {
        const attributes = record.primitive.getGeometryInstanceAttributes(`aircraft:${hex}`)
        if (attributes) {
          attributes.color = ColorGeometryInstanceAttribute.toValue(
            this.boxTint(record),
            attributes.color,
          )
        }
      } catch {
        // Not rendered yet – the box was built in this colour anyway.
      }
    }
  }

  private boxTint(record: AircraftRecord): Color {
    return record.highlighted
      ? Color.lerp(BODY_COLOR, Color.WHITE, HIGHLIGHT_BOX_MIX, new Color())
      : BODY_COLOR
  }

  /** Plates off – the traffic's share of the Labels layer toggle. */
  setLabelsVisible(visible: boolean): void {
    if (visible === this.labelsVisible) return
    this.labelsVisible = visible
    for (const record of this.aircraft.values()) {
      record.labelEntity.show = this.visible && visible && !this.namesAside()
    }
    this.host.requestRender()
  }

  /**
   * "Zoom to line": the plates step aside for the route pulse like the
   * ship names do (VesselLayer.startLineFocus) – no aircraft belongs to
   * a line, so every plate goes. The bodies stay: a plate is what covers
   * a route, a body is where the aircraft is. They come back on the
   * first sync after the focus has run out.
   */
  startLineFocus(durationMs: number): void {
    this.lineFocusUntil = performance.now() + durationMs
    for (const record of this.aircraft.values()) record.labelEntity.show = false
    this.host.requestRender()
  }

  private namesAside(): boolean {
    return performance.now() < this.lineFocusUntil
  }

  get count(): number {
    return this.aircraft.size
  }

  /** Address of the aircraft the camera is chasing, null when free. */
  get followedHex(): string | null {
    return this.followHex
  }

  /**
   * The height the body's centre is drawn at: the playback's altitude in
   * the air, over a ground the flat map may have lowered; `ground` – the
   * apron plus half the body – on the ground; and across the segment
   * from the last fix in the air to the first on the ground (or back,
   * lifting off) blended between the two by the ground's share and never
   * below the apron. Landing, the playback carries the altitude on down
   * at the aircraft's own rate (see AircraftPlaybackSample.groundShare):
   * it touches down when that meets the apron and rolls there, or by the
   * first fix on the ground at the latest where it sinks more slowly.
   */
  private drawnHeight(sample: AircraftPlaybackSample, ground: number): number {
    if (sample.altM === null) return ground
    const air = sample.altM - (this.host.flattenedGroundM ?? 0)
    if (sample.groundShare <= 0) return air
    return Math.max(ground, air + (ground - air) * sample.groundShare)
  }

  private createAircraft(
    aircraft: Aircraft,
    size: AircraftSize,
    nowMs: number,
    liftM: number,
  ): AircraftRecord {
    const sample = aircraftPlaybackSample(aircraft, nowMs - AIRCRAFT_PLAYBACK_DELAY_MS, liftM)
    const height = this.drawnHeight(sample, this.host.defaultGroundHeight + size.heightM / 2)
    const position = Cartesian3.fromDegrees(sample.lon, sample.lat, height)
    const matrix = Transforms.headingPitchRollToFixedFrame(
      position,
      new HeadingPitchRoll(CesiumMath.toRadians(sample.noseDeg - 90), 0, 0),
    )
    const highlighted = this.selectedHex === aircraft.hex
    const color = highlighted
      ? Color.lerp(BODY_COLOR, Color.WHITE, HIGHLIGHT_BOX_MIX, new Color())
      : BODY_COLOR
    const primitive = new Primitive({
      geometryInstances: new GeometryInstance({
        geometry: BoxGeometry.fromDimensions({
          vertexFormat: PerInstanceColorAppearance.VERTEX_FORMAT,
          dimensions: new Cartesian3(size.lengthM, size.spanM, size.heightM),
        }),
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) },
        id: `aircraft:${aircraft.hex}`,
      }),
      appearance: new PerInstanceColorAppearance({ closed: true, translucent: false }),
      asynchronous: false,
      modelMatrix: matrix,
    })
    primitive.show = this.visible
    this.root.add(primitive)

    const labelPosition = new ConstantPositionProperty(position)
    const labelText = aircraftTitle(aircraft)
    const labelEntity = this.viewer.entities.add({
      id: `aircraft:${aircraft.hex}`,
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
        distanceDisplayCondition: new DistanceDisplayCondition(0, LABEL_VISIBLE_RANGE),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    const record: AircraftRecord = {
      size,
      highlighted,
      // Primitive CLONES the modelMatrix passed in – reference its own
      // instance so the in-place updates in sync() actually move the box
      primitive,
      model: null,
      modelMatrix: null,
      matrix: primitive.modelMatrix,
      labelEntity,
      labelPosition,
      labelText,
      displayPosition: Cartesian3.clone(position),
      displayBearing: sample.noseDeg,
      displayPitch: 0,
      displayRoll: 0,
      reckoned: false,
      blendUntilMs: 0,
      lastPosition: Cartesian3.clone(position),
      lastBearing: sample.noseDeg,
      renderedPosition: Cartesian3.clone(position),
      renderedBearing: sample.noseDeg,
      renderedStamp: this.renderStamp,
      clampedHeight: null,
      clampLon: sample.lon,
      clampLat: sample.lat,
      clampedGeneration: -1,
      sample: null,
      liftM,
      grounded: false,
      lightPhaseMs: lightPhaseMs(aircraft.hex),
      lastBeacon: false,
      lastStrobe: false,
      gearShown: null,
    }
    void this.attachModel(record, aircraft.hex)
    return record
  }

  /** Swaps the placeholder box for the archetype's glTF body once it is in; a failed load keeps the box. */
  private async attachModel(record: AircraftRecord, hex: string): Promise<void> {
    const spec = AIRCRAFT_MODELS[record.size.archetype]
    let model: Model
    try {
      model = await Model.fromGltfAsync({
        url: `${import.meta.env.BASE_URL}${spec.uri}`,
        id: `aircraft:${hex}`,
        modelMatrix: Matrix4.clone(record.matrix),
        // Casts onto the tiles, receives nothing – the land fleet's reasoning
        shadows: ShadowMode.CAST_ONLY,
      })
    } catch (error) {
      console.warn('[MiniGermany3D] Aircraft model failed to load:', error)
      return
    }
    if (this.viewer.isDestroyed() || this.aircraft.get(hex) !== record) {
      model.destroy()
      return
    }
    model.show =
      this.visible &&
      Cartesian3.distance(this.viewer.camera.positionWC, record.displayPosition) < BODY_VISIBLE_RANGE
    this.root.add(model)
    if (record.primitive) {
      this.root.remove(record.primitive)
      record.primitive = null
    }
    record.model = model
    this.applyAppearance(record, hex)
    record.modelMatrix = model.modelMatrix
    this.host.requestRender()
  }

  private remove(hex: string): void {
    const record = this.aircraft.get(hex)
    if (!record) return
    if (record.primitive) this.root.remove(record.primitive)
    if (record.model) this.root.remove(record.model)
    this.viewer.entities.remove(record.labelEntity)
    this.aircraft.delete(hex)
  }

  /**
   * The citation adsb.fi's terms ask for – "cite adsb.fi and include a
   * link to our home page", nothing about where – kept while any
   * aircraft is on the map. In the credits dialog only (the lightbox
   * behind the map's "Data attribution" link), not on screen: Windy's
   * terms want their courtesy in the corner of the map, adsb.fi's do
   * not, and one line at the foot of the map is enough.
   */
  private applyCredit(): void {
    const display = this.viewer.creditDisplay
    if (!display) return
    const wanted = this.aircraft.size > 0
    if (wanted && !this.credit) {
      this.credit = new Credit(
        '<a href="https://adsb.fi" target="_blank" rel="noopener">Aircraft: adsb.fi</a>',
        false,
      )
      display.addStaticCredit(this.credit)
    } else if (!wanted && this.credit) {
      display.removeStaticCredit(this.credit)
      this.credit = null
    }
  }
}
