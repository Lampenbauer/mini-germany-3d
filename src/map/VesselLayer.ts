/**
 * Background harbor traffic from AIS (see src/lib/ais.ts): one box per
 * vessel in the real ship's reported dimensions, colored by its AIS type,
 * plus a name label. The fleet renders AIS_PLAYBACK_DELAY_MS behind the
 * wall clock, interpolating between the recorded fixes of each vessel's
 * track (playbackSample) – between two known points there is nothing to
 * extrapolate, so ships glide instead of stalling and teleporting. The
 * city ferries are excluded upstream – they sail as simulated vehicles
 * on their timetable.
 *
 * Same rendering approach as VehicleLayer: Primitive boxes with in-place
 * modelMatrix updates (Entity boxes rebuild geometry asynchronously and
 * freeze under continuous movement), a plain text label per vessel.
 */

import {
  BoundingSphere,
  BoxGeometry,
  CustomShader,
  Model,
  UniformType,
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
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
  ShadowMode,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import { AIS_EXPIRE_MS, AIS_PLAYBACK_DELAY_MS, playbackSample, type AisVessel } from '@/lib/ais-extract'
import { cameraFramingScale } from './CameraLens'
import {
  keepNonOverlappingLabels,
  type LabelMetrics,
  type ScreenRect,
} from './screen-rects'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'
import { FollowCamera } from '@/map/FollowCamera'

export interface VesselLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface (calibrated like the ferry routes). */
  readonly waterSurfaceHeight: number
  /** A camera flight is starting – keeps the render loop at full rate. */
  noteCameraFlight(durationMs: number): void
  /** Screen rectangles the names keep clear of (the webcam pictures). */
  obstacles?: () => readonly ScreenRect[]
  /** Window position of a world point (CSS px), undefined behind the camera. */
  windowPosition?: (position: Cartesian3) => Cartesian2 | undefined
  /** Device pixels per CSS pixel the map draws at (default 1). */
  readonly pixelRatio?: number
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
/** Rough glyph width of the 11 px bold name font, for the picture test. */
const NAME_PX_PER_CHAR = 7
/** Plate height and side padding in CSS px – see NAME_PLATE below. */
const NAME_HEIGHT_PX = 21
const NAME_PAD_X_PX = 7
/** Clearance the plates keep from each other and from a webcam picture. */
const NAME_GAP_PX = 4
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
 * A ship's name is written on a dark plate, the negative of the light one
 * the stop names wear (StopsLayer.stopNameplate): over water, where every
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
const NAME_VISIBLE_RANGE = 30_000
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
 * glTF hulls per AIS type group, generated by scripts/build-vehicle-models.mjs
 * from scripts/lib/vessel-fleet.mjs – same visual language as the vehicle
 * fleet. Reference dimensions mirror VESSEL_DIMS there (pinned against the
 * GLB bounds by tests/vessel-models.test.ts); the drawn ship is this model
 * stretched to the vessel's reported size, so one coaster hull covers
 * everything from a bunker barge to the 200 m CEMLUNA.
 */
export const VESSEL_MODELS: Record<string, { uri: string; length: number; width: number; height: number }> = {
  'vessel-container': { uri: 'models/vessel-container.glb', length: 300, width: 40, height: 46 },
  'vessel-cargo': { uri: 'models/vessel-cargo.glb', length: 90, width: 14, height: 16 },
  'vessel-tanker': { uri: 'models/vessel-tanker.glb', length: 90, width: 14, height: 14 },
  'vessel-barge': { uri: 'models/vessel-barge.glb', length: 85, width: 9.5, height: 6 },
  'vessel-dredger': { uri: 'models/vessel-dredger.glb', length: 100, width: 20, height: 18 },
  'vessel-passenger': { uri: 'models/vessel-passenger.glb', length: 160, width: 24, height: 34 },
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
}

const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll(0, 0, 0)
const scaleScratch = new Cartesian3()

/** Night-time window glow, identical language to the vehicle fleet. */
const WINDOW_GLOW_COLOR = 'vec3(1.0, 0.83, 0.52)'
const WINDOW_GLOW_LUMINANCE_CUTOFF = '0.075'
const WINDOW_GLOW_MAX = 0.85

export class VesselLayer {
  private vessels = new Map<number, VesselRecord>()
  private visible = true
  private labelsVisible = true
  /** MMSI the camera is chasing, null when free. */
  private followMmsi: number | null = null
  private readonly followCamera: FollowCamera
  private frustumSphere = new BoundingSphere()
  private lastSyncMs = 0
  /** Counts rendered frames (see markRendered / VesselRecord.renderedStamp). */
  private renderStamp = 0
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
    const renderRange = VESSEL_RENDER_RANGE_AT_REFERENCE * cameraFramingScale(camera)
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
    const cullingVolume = camera.frustum.computeCullingVolume(
      camera.positionWC,
      camera.directionWC,
      camera.upWC,
    )
    // Smoothing step for this tick; a long pause (tab hidden) snaps.
    const dtMs = this.lastSyncMs > 0 ? Math.max(0, nowMs - this.lastSyncMs) : 0
    this.lastSyncMs = nowMs
    const alpha = dtMs > 0 && dtMs < 2000 ? 1 - Math.exp(-dtMs / SMOOTH_TAU_MS) : 1

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
      const target = Cartesian3.fromDegrees(
        sample.lon,
        sample.lat,
        this.host.waterSurfaceHeight + drawnHeight / 2,
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
       * declutter the stop names use: a busy harbour puts a dozen plates
       * on the same patch of screen, and Cesium cannot let the nearest one
       * cover the rest – a LabelCollection draws every background first
       * and every glyph after, in two collections of its own, so the names
       * write straight over each other whatever the plate's opacity. The
       * loop only collects the candidates.
       */
      let nameShown = this.visible && this.labelsVisible
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
      // Box stand-in or loaded model – attachModel swaps one for the other,
      // so only ever one of them is on the scene.
      const body = record.model ?? record.primitive
      if (body && body.show !== showBody) {
        body.show = showBody
        this.host.requestRender()
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
    return {
      anyMovingVesselInView,
      nearestHullMeters,
      nearestHullWidthM,
      maxScreenMotionPx,
      maxTickMotionPx,
    }
  }

  /** Day→night ramp for the window glow (driven by the map's sun state). */
  applyNightFactor(night: number): void {
    this.windowGlowShader.setUniform('u_windowGlow', WINDOW_GLOW_MAX * night)
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
      record.labelEntity.show = visible && this.labelsVisible
    }
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

  /** Ship names off – the fleet's half of the Labels layer toggle. */
  setLabelsVisible(visible: boolean): void {
    if (visible === this.labelsVisible) return
    this.labelsVisible = visible
    for (const record of this.vessels.values()) {
      record.labelEntity.show = this.visible && visible
    }
    this.host.requestRender()
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
    const color = Color.fromCssColorString(style.color)
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
    this.viewer.scene.primitives.add(primitive)

    const labelPosition = new ConstantPositionProperty(position)
    const labelText = vessel.name || String(vessel.mmsi)
    const labelEntity = this.viewer.entities.add({
      id: `vessel:${vessel.mmsi}`,
      position: labelPosition,
      show: this.visible && this.labelsVisible,
      label: {
        text: labelText,
        font: 'bold 11px "Inter Variable", system-ui, sans-serif',
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
    this.viewer.scene.primitives.add(model)
    if (record.primitive) {
      this.viewer.scene.primitives.remove(record.primitive)
      record.primitive = null
    }
    record.model = model
    // fromGltfAsync clones the matrix – rebind so the in-place scale
    // composition in sync() reaches the model.
    record.modelMatrix = model.modelMatrix
    this.host.requestRender()
  }

  private remove(mmsi: number): void {
    const record = this.vessels.get(mmsi)
    if (!record) return
    if (record.primitive) this.viewer.scene.primitives.remove(record.primitive)
    if (record.model) this.viewer.scene.primitives.remove(record.model)
    this.viewer.entities.remove(record.labelEntity)
    this.vessels.delete(mmsi)
  }
}
