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
  LabelStyle,
  Math as CesiumMath,
  Matrix4,
  PerInstanceColorAppearance,
  Primitive,
  Transforms,
  type Entity,
  type Viewer,
} from 'cesium'
import { AIS_EXPIRE_MS, deadReckon, type AisVessel } from '@/lib/ais-extract'

export interface VesselLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface (calibrated like the ferry routes). */
  readonly waterSurfaceHeight: number
}

/** Ship names fade in below this camera distance (meters). */
const NAME_VISIBLE_RANGE = 6_000
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
  lastPosition: Cartesian3
}

const positionScratch = new Cartesian3()
const hprScratch = new HeadingPitchRoll(0, 0, 0)

export class VesselLayer {
  private vessels = new Map<number, VesselRecord>()
  private visible = true

  constructor(
    private readonly viewer: Viewer,
    private readonly host: VesselLayerHost,
  ) {}

  /** Per-tick update: dead-reckoned positions, arrivals, departures. */
  sync(vessels: AisVessel[], nowMs: number): void {
    const alive = new Set<number>()
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
        this.host.requestRender()
      }

      const reckoned = deadReckon(vessel, nowMs)
      const position = Cartesian3.fromDegrees(
        reckoned.lon,
        reckoned.lat,
        this.host.waterSurfaceHeight + record.builtHeight / 2,
        undefined,
        positionScratch,
      )
      hprScratch.heading = CesiumMath.toRadians(reckoned.bearingDeg - 90)
      Transforms.headingPitchRollToFixedFrame(position, hprScratch, undefined, undefined, record.matrix)
      record.labelPosition.setValue(position)
      if (!Cartesian3.equalsEpsilon(position, record.lastPosition, 0, 0.5)) {
        Cartesian3.clone(position, record.lastPosition)
        this.host.requestRender()
      }

      const text = vessel.name || String(vessel.mmsi)
      if (text !== record.labelText && record.labelEntity.label) {
        record.labelText = text
        record.labelEntity.label.text = new ConstantProperty(text)
        this.host.requestRender()
      }
    }

    for (const mmsi of this.vessels.keys()) {
      if (!alive.has(mmsi)) {
        this.remove(mmsi)
        this.host.requestRender()
      }
    }
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
        font: '12px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: color,
        outlineWidth: 3,
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
      lastPosition: Cartesian3.clone(position),
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
