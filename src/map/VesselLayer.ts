/**
 * Background harbor traffic from AIS (see src/lib/ais.ts): one box per
 * vessel in the real ship's reported dimensions, colored by its AIS type,
 * plus a name label. Positions dead-reckon along course and speed between
 * the ~30 s polls, so moving ships glide instead of hopping. The city
 * ferries are excluded upstream – they sail as simulated vehicles whose
 * positions the AIS override corrects (overrideFerryPositions).
 *
 * Same rendering approach as VehicleLayer: Primitive boxes with in-place
 * modelMatrix updates (Entity boxes rebuild geometry asynchronously and
 * freeze under continuous movement), a plain text label per vessel.
 */

import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
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
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import { AIS_EXPIRE_MS, AIS_RECKON_CAP_MS, deadReckon, type AisVessel } from '@/lib/ais-extract'

export interface VesselLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface (calibrated like the ferry routes). */
  readonly waterSurfaceHeight: number
}

/** Ship names fade in below this camera distance (meters). */
const NAME_VISIBLE_RANGE = 15_000
/**
 * Beyond this camera distance a moving vessel does not request repaints –
 * at 20 km a hull is sub-pixel, and the app's event-driven rendering must
 * stay idle when nothing visible changes (the trams' layer works the same
 * way: movement only costs GPU while it is inside the view).
 */
const VESSEL_RENDER_RANGE = 20_000
/**
 * Time constant of the display smoothing in ms: the drawn position eases
 * toward the dead-reckoned target instead of snapping. Between ticks that
 * yields fluid motion; when a fresh fix corrects the extrapolation by
 * meters (or, after a data gap, by hundreds of meters), the ship glides
 * over in about a second instead of teleporting.
 */
const SMOOTH_TAU_MS = 400
/** Fallback dimensions for the many small craft without static data. */
const DEFAULT_LENGTH = 12
const DEFAULT_WIDTH = 4

/** Hull color and height by AIS ship type group – muted, the fleet is scenery. */
function vesselStyle(typeCode: number): { color: string; height: number } {
  const group = Math.floor(typeCode / 10)
  if (group === 6) return { color: '#4a7fb5', height: 5 } // passenger
  if (group === 7) return { color: '#4e8a57', height: 5 } // cargo
  if (group === 8) return { color: '#a05252', height: 5 } // tanker
  if (typeCode === 30) return { color: '#8a7250', height: 3 } // fishing
  if (typeCode === 36 || typeCode === 37) return { color: '#8a6fb0', height: 3 } // sailing/pleasure
  if (group === 5) return { color: '#4f9494', height: 3 } // tug/pilot/SAR
  return { color: '#7a8494', height: 3 } // unknown
}

interface VesselRecord {
  primitive: Primitive
  /** The primitive's own matrix – Primitive clones what the constructor got. */
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
}

const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll(0, 0, 0)

export class VesselLayer {
  private vessels = new Map<number, VesselRecord>()
  private visible = true
  private frustumSphere = new BoundingSphere()
  private lastSyncMs = 0

  constructor(
    private readonly viewer: Viewer,
    private readonly host: VesselLayerHost,
  ) {}

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
    if (Cartesian3.distance(this.viewer.camera.positionWC, position) >= VESSEL_RENDER_RANGE) return false
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
   * Per-tick update: dead-reckoned positions, arrivals, departures.
   * Returns whether a vessel whose drawn pose is still changing sits
   * inside the view – the app's tick and render pacing treat that like a
   * tram in view, otherwise ships glide in 500 ms stop-motion steps.
   */
  sync(vessels: AisVessel[], nowMs: number): { anyMovingVesselInView: boolean } {
    const alive = new Set<number>()
    // One culling volume per tick, for every repaint decision below.
    const camera = this.viewer.camera
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
    for (const vessel of vessels) {
      if (nowMs - vessel.positionAt > AIS_EXPIRE_MS) continue
      alive.add(vessel.mmsi)

      let record = this.vessels.get(vessel.mmsi)
      // Static data can land after the first position: once the real
      // dimensions differ clearly from the built box, rebuild it.
      if (
        record &&
        (Math.abs((vessel.lengthM ?? DEFAULT_LENGTH) - record.builtLength) > 1 ||
          Math.abs((vessel.widthM ?? DEFAULT_WIDTH) - record.builtWidth) > 1)
      ) {
        this.remove(vessel.mmsi)
        record = undefined
      }
      if (!record) {
        record = this.createVessel(vessel, nowMs)
        this.vessels.set(vessel.mmsi, record)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }

      const reckoned = deadReckon(vessel, nowMs)
      const target = Cartesian3.fromDegrees(
        reckoned.lon,
        reckoned.lat,
        this.host.waterSurfaceHeight + record.builtHeight / 2,
        undefined,
        positionScratch,
      )
      Cartesian3.lerp(record.displayPosition, target, alpha, record.displayPosition)
      if (Cartesian3.equalsEpsilon(record.displayPosition, target, 0, 0.05)) {
        Cartesian3.clone(target, record.displayPosition)
      }
      // Shortest-path ease of the bearing – cog jitter must not wag the bow
      const bearingGap = ((reckoned.bearingDeg - record.displayBearing + 540) % 360) - 180
      record.displayBearing =
        Math.abs(bearingGap) < 0.05
          ? reckoned.bearingDeg
          : (record.displayBearing + bearingGap * alpha + 360) % 360

      hprScratch.heading = CesiumMath.toRadians(record.displayBearing - 90)
      Transforms.headingPitchRollToFixedFrame(
        record.displayPosition,
        hprScratch,
        undefined,
        undefined,
        record.matrix,
      )
      record.labelPosition.setValue(record.displayPosition)
      // Repaint per tick while the drawn pose still changes – that is what
      // makes a ship under way glide at the render loop's own rate.
      const poseChanged =
        !Cartesian3.equalsEpsilon(record.displayPosition, record.lastPosition, 0, 0.02) ||
        Math.abs(record.displayBearing - record.lastBearing) > 0.05
      // The pacing signal must NOT hang on the per-tick repaint epsilon:
      // a slow ship advances less than it per 33 ms tick, the flag would
      // drop, the app would fall back to 500 ms ticks, and the two rates
      // would oscillate into exactly the stop-motion this exists to
      // prevent. "Under way" comes from the data instead – stable across
      // ticks – with the pose ease riding along until it converged.
      const underWay =
        (vessel.sogKn ?? 0) >= 0.3 &&
        vessel.cogDeg !== null &&
        nowMs - vessel.positionAt <= AIS_RECKON_CAP_MS
      if ((poseChanged || underWay) && this.isOnScreen(cullingVolume, record.displayPosition)) {
        anyMovingVesselInView = true
        if (poseChanged) this.host.requestRender()
      }
      if (poseChanged) {
        Cartesian3.clone(record.displayPosition, record.lastPosition)
        record.lastBearing = record.displayBearing
      }

      const text = vessel.name || String(vessel.mmsi)
      if (text !== record.labelText && record.labelEntity.label) {
        record.labelText = text
        record.labelEntity.label.text = new ConstantProperty(text)
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
      }
    }

    for (const [mmsi, record] of this.vessels) {
      if (!alive.has(mmsi)) {
        // Position first – remove() drops the record.
        this.repaintIfOnScreen(cullingVolume, record.lastPosition)
        this.remove(mmsi)
      }
    }
    return { anyMovingVesselInView }
  }

  /** The underground view hides the surface fleet with the other layers. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    for (const record of this.vessels.values()) {
      record.primitive.show = visible
      record.labelEntity.show = visible
    }
    this.host.requestRender()
  }

  get vesselCount(): number {
    return this.vessels.size
  }

  private createVessel(vessel: AisVessel, nowMs: number): VesselRecord {
    const style = vesselStyle(vessel.typeCode)
    const length = vessel.lengthM ?? DEFAULT_LENGTH
    const width = vessel.widthM ?? DEFAULT_WIDTH
    const reckoned = deadReckon(vessel, nowMs)
    const position = Cartesian3.fromDegrees(
      reckoned.lon,
      reckoned.lat,
      this.host.waterSurfaceHeight + style.height / 2,
    )
    const matrix = Transforms.headingPitchRollToFixedFrame(
      position,
      new HeadingPitchRoll(CesiumMath.toRadians(reckoned.bearingDeg - 90), 0, 0),
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
      show: this.visible,
      label: {
        text: labelText,
        font: '10px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: color,
        outlineWidth: 2,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -16),
        distanceDisplayCondition: new DistanceDisplayCondition(0, NAME_VISIBLE_RANGE),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    return {
      // Primitive CLONES the modelMatrix passed in – reference its own
      // instance so the in-place updates in sync() actually move the box.
      primitive,
      matrix: primitive.modelMatrix,
      labelEntity,
      labelPosition,
      builtLength: length,
      builtWidth: width,
      builtHeight: style.height,
      labelText,
      displayPosition: Cartesian3.clone(position),
      displayBearing: reckoned.bearingDeg,
      lastPosition: Cartesian3.clone(position),
      lastBearing: reckoned.bearingDeg,
    }
  }

  private remove(mmsi: number): void {
    const record = this.vessels.get(mmsi)
    if (!record) return
    this.viewer.scene.primitives.remove(record.primitive)
    this.viewer.entities.remove(record.labelEntity)
    this.vessels.delete(mmsi)
  }
}
