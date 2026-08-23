/**
 * The vehicle layer: one box primitive, one line badge and one night-time
 * glow pool per running vehicle, plus the selection highlight and the chase
 * camera that follows one of them.
 *
 * Split out of CesiumMap. This is the per-frame hot path – sync() runs at
 * the simulation tick rate – and the piece a move to instanced or batched
 * rendering would touch first, which is exactly why it is worth having on
 * its own.
 */

import {
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  Color,
  ColorBlendMode,
  ColorGeometryInstanceAttribute,
  ConstantPositionProperty,
  ConstantProperty,
  Credit,
  DistanceDisplayCondition,
  type Entity,
  GeometryInstance,
  HeadingPitchRange,
  HeadingPitchRoll,
  Intersect,
  LabelStyle,
  Material,
  MaterialAppearance,
  Math as CesiumMath,
  Cartographic,
  Matrix3,
  Matrix4,
  Model,
  PerInstanceColorAppearance,
  PlaneGeometry,
  Primitive,
  Transforms,
  VertexFormat,
  type Viewer,
} from 'cesium'
import { config } from '@/config'
import type { TransitMode } from '@/data/network-types'
import type { VehicleSnapshot } from '@/engine/simulation'
import { tunnelOpacity } from './tunnel-view'

/** What the vehicle layer needs from the map around it. */
export interface VehicleLayerHost {
  requestRender(): void
  /** Ellipsoidal ground height on the loaded photo tiles, if queryable. */
  sampleGroundHeight(lon: number, lat: number): number | undefined
  /** Current fallback ground height (rises once the bootstrap has run). */
  readonly defaultGroundHeight: number
  /** NHN→ellipsoid offset the route profile heights are drawn at. */
  readonly routeHeightOffset: number
  /** 0..1 day→night ramp – the cabin glow fades in along it. */
  readonly nightFactor: number
  readonly pixelRatio: number
  readonly offline: boolean
  /** Fixed ground height for the deterministic tests, if set. */
  readonly fixedGroundHeight: number | undefined
  /** A camera flight is starting – keeps the render loop at full rate. */
  noteCameraFlight(durationMs: number): void
}

interface VehicleRecord {
  /**
   * The vehicle body with a direct modelMatrix: position updates take
   * effect immediately. (Entity boxes rebuild their geometry
   * asynchronously on every position change – under continuous movement
   * this rebuild starves as soon as the render rate drops to tick level,
   * and the boxes visibly freeze.) Modes with a glTF model use a Model
   * primitive instead of the box; while its async load is in flight the
   * body is null and only the badge marks the vehicle.
   */
  primitive: Primitive | null
  /** Body is a glTF consist (see VEHICLE_MODELS) instead of a colored box. */
  isModelBody: boolean
  /**
   * Wagon models of a glTF body in consist order; slots stay undefined
   * while their async load is in flight. Empty for box bodies.
   */
  models: (Model | undefined)[]
  /** Live modelMatrix instances of the wagons (updated in place). */
  modelMatrices: (Matrix4 | undefined)[]
  /** Per-wagon travel-axis offset from the vehicle center in meters. */
  wagonOffsets: number[]
  /** Per-wagon 180° flip (rear cab cars face backwards). */
  wagonFlips: boolean[]
  /** Uniform model scale (VEHICLE_MODELS.scale). 0 for box bodies. */
  modelScale: number
  /**
   * Base pose of the vehicle (position + heading, unscaled): the box
   * primitive's live matrix, or the per-tick source the wagon matrices
   * are composed from.
   */
  matrix: Matrix4
  /** Entity for the number label (billboard path, updates without rebuild). */
  labelEntity: Entity
  labelPosition: ConstantPositionProperty
  /** GTFS-RT delay suffix currently baked into the badge ('' = on time). */
  delaySuffix: string
  baseColor: Color
  /**
   * Shared appearance of the body primitive (box bodies only, null for
   * model bodies). Tunnel transitions only toggle its `translucent` flag –
   * the primitive picks that up per frame (isTranslucent()) and rebuilds
   * just its render state, no new appearance/shader per transition.
   */
  appearance: PerInstanceColorAppearance | null
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
 * Every how many frames the ground height is re-sampled per tram – only
 * for vehicles WITHOUT route terrain heights (approximated dataset); with
 * heights present the height comes from the route profile instead.
 */
const HEIGHT_SAMPLE_INTERVAL = 12

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

interface VehicleModelSpec {
  /** Uniform scale (tuned visually against the photo tiles). */
  scale: number
  /**
   * Model-space distance from origin to wheel bottom – times scale it
   * puts the wheels on the road.
   */
  baseLift: number
  /** Gap between wagons in meters. */
  gap: number
  /**
   * Consist front to back. length = model length in model units (from the
   * glTF bounds); flipped wagons face backwards (rear cab cars).
   */
  wagons: { uri: string; length: number; flipped?: boolean }[]
}

/**
 * glTF vehicle models (Kenney Train Kit, CC0 – see
 * public/models/LICENSE-kenney-train-kit.txt). Modes without an entry
 * keep the colored box. A single Kenney wagon is stylized-short, so
 * vehicles are drawn as consists of several wagons at natural
 * proportions: the tram as three coupled units, the S-Bahn as cab car +
 * middle coach + rear cab car (flipped). The models are tinted in the
 * line color (see applyVehicleAppearance).
 */
const VEHICLE_MODELS: Partial<Record<TransitMode, VehicleModelSpec>> = {
  tram: {
    scale: 3.4,
    baseLift: 0.36,
    gap: 0.4,
    wagons: [
      { uri: 'models/tram.glb', length: 2.69 },
      { uri: 'models/tram.glb', length: 2.69 },
      { uri: 'models/tram.glb', length: 2.69 },
    ],
  },
  train: {
    scale: 3.6,
    baseLift: 0.36,
    gap: 0.5,
    wagons: [
      { uri: 'models/sbahn.glb', length: 2.5 },
      { uri: 'models/sbahn-mid.glb', length: 2.64 },
      { uri: 'models/sbahn-mid.glb', length: 2.64 },
      { uri: 'models/sbahn.glb', length: 2.5, flipped: true },
    ],
  },
}

/** How strongly the line color covers the model's own livery (0–1). */
const MODEL_TINT_AMOUNT = 0.5

// Scratches for the per-tick wagon pose composition.
const wagonTranslationScratch = new Cartesian3()
const wagonFlipMatrix = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI))

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

/** Meters above the sampled ground – below routes, above the road mesh. */
const GLOW_LIFT = 0.15
/** Camera distance in meters up to which the pools are drawn. */
const GLOW_VISIBLE_RANGE = 2_000

/** Follow camera: initial offset behind/above the vehicle. */
const FOLLOW_PITCH_DEG = -16
const FOLLOW_RANGE = 140

/** Duration of the approach flight when following starts, in seconds. */
const FOLLOW_FLIGHT_SECONDS = 1.4

/**
 * Per-update easing of the chase heading toward the travel bearing
 * (~0.25 s time constant at the 30 fps tick). The bearing jumps at path
 * segment boundaries – applying it directly would visibly snap the view.
 */
const FOLLOW_CHASE_EASE = 0.12

// Scratch objects for the per-tick hot path in syncVehicles: Cesium clones all
// values it retains (ConstantProperty, modelMatrix), so reusing these avoids
// ~2 allocations per tram per tick.
const positionScratch = new Cartesian3()

// Scratch for the per-tick glow pool pose (see syncVehicles).
const glowPositionScratch = new Cartesian3()

const hprScratch = new HeadingPitchRoll()

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
 * Delay suffix shown on the map badge after the line number ("+2" / "-1").
 * Mirrors the VehicleCard threshold: under a minute counts as on time, and
 * only vehicles with a GTFS-RT match show a delay at all.
 */
export function delayBadgeSuffix(snap: Pick<VehicleSnapshot, 'realtime' | 'delaySeconds'>): string {
  if (!snap.realtime || Math.abs(snap.delaySeconds) < 60) return ''
  const minutes = Math.round(snap.delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes}`
}

export class VehicleLayer {
  private vehicles = new Map<string, VehicleRecord>()
  /** Rendered line badges (rounded rectangle + line number), one per line. */
  private badgeCache = new Map<string, { canvas: HTMLCanvasElement; width: number; height: number }>()
  private selectedId: string | null = null
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
  private frameCounter = 0
  private frustumSphere = new BoundingSphere()
  /** Radial gradient sprite of the glow pools (null: no 2D canvas). */
  private glowSpriteCanvas?: HTMLCanvasElement | null
  /** Material/appearance shared by ALL pools – one uniform sets the alpha. */
  private glowMaterial: Material | null = null
  private glowAppearance: MaterialAppearance | null = null

  /** Underground view (see setUnderground). */
  private underground = false

  constructor(
    private readonly viewer: Viewer,
    private readonly host: VehicleLayerHost,
  ) {}

  /**
   * Underground view: vehicles in tunnels solid, those on the surface
   * ghosted. Every record has to be repainted, so they are all marked
   * dirty and picked up by the next sync().
   */
  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    for (const record of this.vehicles.values()) record.appearanceDirty = true
    this.host.requestRender()
  }

  /** Id of the vehicle the camera is chasing, null when free. */
  get followedId(): string | null {
    return this.followId
  }

  /**
   * Raises every running vehicle onto a newly measured ground height (the
   * height bootstrap's median). The per-vehicle sampling refines it after.
   */
  setGroundHeight(height: number): void {
    for (const record of this.vehicles.values()) record.groundHeight = height
  }

  /**
   * Applies the day→night ramp to the shared glow material. Called by the
   * map, which computes the ramp from the sun elevation.
   */
  applyNightFactor(night: number): void {
    if (!this.glowMaterial) return
    const uniforms = this.glowMaterial.uniforms as { color: Color }
    uniforms.color.alpha = GLOW_MAX_ALPHA * night
  }

  /** World position of a vehicle's label, or null when it is not running. */
  getVehiclePosition(id: string): Cartesian3 | null {
    return this.vehicles.get(id)?.lastPosition ?? null
  }

  /** Debug: current ground heights of the vehicles (see __mrt.groundHeights). */
  getGroundHeights(): { id: string; groundHeight: number }[] {
    return [...this.vehicles.entries()].map(([id, record]) => ({
      id,
      groundHeight: Math.round(record.groundHeight * 10) / 10,
    }))
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
  sync(
    snapshots: VehicleSnapshot[],
    visibleLines: ReadonlySet<string>,
  ): { anyVehicleInView: boolean } {
    this.frameCounter++
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
        this.host.requestRender()
      }

      // Entering/leaving a tunnel section toggles the 40 % ghost rendering.
      if (snap.inTunnel !== record.inTunnel) {
        record.inTunnel = snap.inTunnel
        record.appearanceDirty = true
      }
      if (record.appearanceDirty) {
        record.appearanceDirty = !this.applyVehicleAppearance(snap.id)
        if (!record.appearanceDirty) this.host.requestRender()
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
        this.host.requestRender()
      }

      const show = visibleLines.has(snap.lineId)

      // Vehicle height: terrain profile of the route (NHN + calibrated
      // offset) whenever the direction carries DGM heights – deterministic,
      // congruent with the route polylines, and free of ray casts. In
      // offline mode the ground is the bare ellipsoid, where NHN heights
      // would float mid-air, so the fallback below applies there too.
      const routeGroundHeight =
        this.host.fixedGroundHeight === undefined && !this.host.offline && snap.nhn !== undefined
          ? snap.nhn + this.host.routeHeightOffset
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
        this.host.fixedGroundHeight === undefined &&
        (inView || followed) &&
        this.frameCounter - record.lastSampleFrame >= HEIGHT_SAMPLE_INTERVAL
      ) {
        // A large gap means the tram was off-screen and unsampled: snap to
        // the measured height right at the screen edge instead of visibly
        // gliding to it in mid-view.
        const snapToHeight =
          this.frameCounter - record.lastSampleFrame >= HEIGHT_SAMPLE_INTERVAL * 4
        record.lastSampleFrame = this.frameCounter
        const sampled = this.host.sampleGroundHeight(snap.lon, snap.lat)
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
        if (inView) this.host.requestRender()
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
      // glTF consists: compose each wagon pose from the fresh base pose
      for (let k = 0; k < record.modelMatrices.length; k++) {
        const wagonMatrix = record.modelMatrices[k]
        if (wagonMatrix) this.composeWagonMatrix(record, k, wagonMatrix)
      }
      // The body is only drawn close up; the number label carries the
      // vehicle out to VEHICLE_VISIBLE_RANGE. (Checked here on the CPU – a
      // DistanceDisplayCondition attribute on the Primitive measures from
      // the instance matrix, which is identity for these boxes since the
      // position lives in the primitive's own modelMatrix.)
      const showBody = show && cameraDistance < VEHICLE_BODY_VISIBLE_RANGE
      let visibilityChanged = false
      if (record.primitive && record.primitive.show !== showBody) {
        record.primitive.show = showBody
        visibilityChanged = true
      }
      for (const model of record.models) {
        if (model && model.show !== showBody) {
          model.show = showBody
          visibilityChanged = true
        }
      }
      if (record.labelEntity.show !== show) {
        record.labelEntity.show = show
        visibilityChanged = true
      }
      if (visibilityChanged) this.host.requestRender()

      // Night-time cabin glow: only at night, never in tunnels, and only
      // where the pool is more than a couple of pixels.
      if (record.glow && record.glowMatrix) {
        const showGlow =
          showBody &&
          !record.inTunnel &&
          !this.underground &&
          this.host.nightFactor > 0.02 &&
          cameraDistance < GLOW_VISIBLE_RANGE
        if (record.glow.show !== showGlow) {
          record.glow.show = showGlow
          this.host.requestRender()
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
        // Wagons may still be loading (attachWagon then destroys the late
        // arrivals itself).
        if (record.primitive) this.viewer.scene.primitives.remove(record.primitive)
        for (const model of record.models) {
          if (model) this.viewer.scene.primitives.remove(model)
        }
        if (record.glow) this.viewer.scene.primitives.remove(record.glow)
        this.vehicles.delete(id)
        this.host.requestRender()
      }
    }

    return { anyVehicleInView }
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
          color: GLOW_COLOR.withAlpha(GLOW_MAX_ALPHA * this.host.nightFactor),
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

    const ratio = this.host.pixelRatio
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
    const modelSpec = VEHICLE_MODELS[snap.mode]
    // Model bodies: origin-to-wheel distance instead of half the box
    // height, so the shared position formula puts the wheels on the road.
    const halfHeight = modelSpec ? modelSpec.scale * modelSpec.baseLift : snap.vehicle.height / 2
    // Ghosted right away when the view has this vehicle on its far side –
    // in a tunnel normally, on the surface in the underground view.
    const alpha = tunnelOpacity(snap.inTunnel, this.underground)
    const initialPosition = Cartesian3.fromDegrees(
      snap.lon,
      snap.lat,
      this.host.defaultGroundHeight + halfHeight + 0.3,
    )

    const matrix = Transforms.headingPitchRollToFixedFrame(
      initialPosition,
      new HeadingPitchRoll(CesiumMath.toRadians(snap.bearing - 90), 0, 0),
    )
    let primitive: Primitive | null = null
    let appearance: PerInstanceColorAppearance | null = null
    // Consist layout: wagon centers along the travel axis, vehicle center
    // at the pose origin (front wagon at positive X).
    const wagonOffsets: number[] = []
    const wagonFlips: boolean[] = []
    if (modelSpec) {
      const lengths = modelSpec.wagons.map((w) => w.length * modelSpec.scale)
      const total =
        lengths.reduce((sum, l) => sum + l, 0) + modelSpec.gap * (modelSpec.wagons.length - 1)
      let consumed = 0
      modelSpec.wagons.forEach((wagon, index) => {
        wagonOffsets.push(total / 2 - consumed - lengths[index] / 2)
        wagonFlips.push(wagon.flipped === true)
        consumed += lengths[index] + modelSpec.gap
      })
    } else {
      // The base render state stays opaque; only the mutable `translucent`
      // flag switches blending on/off. (A base state built as translucent
      // would keep its blending even after toggling the flag back off.)
      appearance = new PerInstanceColorAppearance({ closed: true, translucent: false })
      appearance.translucent = snap.inTunnel
      primitive = new Primitive({
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
    }
    // IMPORTANT: Primitive CLONES the modelMatrix passed in – for the
    // in-place updates in sync(), the primitive's own instance must be
    // referenced, otherwise the vehicle bodies never move. (Model bodies
    // rebind in attachWagon for the same reason.)
    const liveMatrix = primitive ? primitive.modelMatrix : matrix

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

    const record: VehicleRecord = {
      primitive,
      isModelBody: modelSpec !== undefined,
      models: [],
      modelMatrices: [],
      wagonOffsets,
      wagonFlips,
      modelScale: modelSpec?.scale ?? 0,
      matrix: liveMatrix,
      labelEntity,
      labelPosition,
      delaySuffix,
      baseColor: color,
      appearance,
      inTunnel: snap.inTunnel,
      highlighted: false,
      // Model bodies apply tint/tunnel ghost once the wagons attached
      appearanceDirty: modelSpec !== undefined,
      halfHeight,
      bearing: snap.bearing,
      groundHeight: this.host.defaultGroundHeight,
      lastSampleFrame: -HEIGHT_SAMPLE_INTERVAL, // sample immediately on the first frame
      lastPosition: Cartesian3.clone(initialPosition),
      glow,
      glowMatrix,
      glowScale,
    }
    if (modelSpec) {
      modelSpec.wagons.forEach((wagon, index) => {
        void this.attachWagon(record, snap.id, wagon.uri, index)
      })
    }
    return record
  }

  /**
   * Loads one wagon of a vehicle's glTF consist and attaches it to its
   * record slot. Geometry and textures are shared across all vehicles via
   * Cesium's ResourceCache, so only the first load per file costs
   * anything. Until every wagon arrived, appearanceDirty keeps the
   * tint/ghost application retrying.
   */
  private async attachWagon(
    record: VehicleRecord,
    vehicleId: string,
    uri: string,
    index: number,
  ): Promise<void> {
    let model: Model
    try {
      model = await Model.fromGltfAsync({
        url: `${import.meta.env.BASE_URL}${uri}`,
        id: `vehicle:${vehicleId}`,
        modelMatrix: this.composeWagonMatrix(record, index, new Matrix4()),
      })
    } catch (error) {
      console.warn('[MiniRostock3D] Vehicle model failed to load:', error)
      return
    }
    // The trip may have ended (or the viewer been torn down) during the load
    if (this.viewer.isDestroyed() || this.vehicles.get(vehicleId) !== record) {
      model.destroy()
      return
    }
    model.colorBlendMode = ColorBlendMode.MIX
    model.colorBlendAmount = MODEL_TINT_AMOUNT
    this.viewer.scene.primitives.add(model)
    // fromGltfAsync clones the matrix – rebind so the in-place pose
    // updates in sync() reach the model.
    record.models[index] = model
    record.modelMatrices[index] = model.modelMatrix
    record.appearanceDirty = true
    this.host.requestRender()
  }

  /** Wagon pose: vehicle base pose → travel-axis offset → flip → scale. */
  private composeWagonMatrix(record: VehicleRecord, index: number, result: Matrix4): Matrix4 {
    Matrix4.clone(record.matrix, result)
    Matrix4.multiplyByTranslation(
      result,
      Cartesian3.fromElements(record.wagonOffsets[index], 0, 0, wagonTranslationScratch),
      result,
    )
    if (record.wagonFlips[index]) Matrix4.multiply(result, wagonFlipMatrix, result)
    return Matrix4.multiplyByUniformScale(result, record.modelScale, result)
  }

  /**
   * CC0 requires no attribution – naming the vehicle-model author in the
   * credit line is a courtesy.
   */
  addCredit(): void {
    this.viewer.creditDisplay.addStaticCredit(new Credit('Vehicle models: Kenney.nl', false))
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
    const alpha = tunnelOpacity(record.inTunnel, this.underground)
    if (record.appearance) record.appearance.translucent = alpha < 1
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
    if (record.isModelBody) {
      // glTF consist: tinted in the line color (colorBlendMode MIX, set at
      // attach) like the boxes were; the alpha carries the tunnel
      // ghosting, selection brightens the tint and adds a silhouette.
      const tint = record.highlighted
        ? Color.lerp(record.baseColor, Color.WHITE, 0.45, new Color())
        : record.baseColor
      let complete = true
      for (let k = 0; k < record.wagonOffsets.length; k++) {
        const model = record.models[k]
        if (!model) {
          complete = false // wagon still loading – retried via appearanceDirty
          continue
        }
        model.color = tint.withAlpha(alpha)
        model.silhouetteColor = Color.WHITE
        model.silhouetteSize = record.highlighted ? 2.5 : 0
      }
      return complete
    }
    try {
      const attributes = (record.primitive as Primitive).getGeometryInstanceAttributes(
        `vehicle:${vehicleId}`,
      )
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
    this.host.requestRender()
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
      this.host.requestRender()
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
      this.host.noteCameraFlight(FOLLOW_FLIGHT_SECONDS * 1000 + 200)
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
    this.host.requestRender()
  }

  private updateFollowCamera(lon: number, lat: number): void {
    // The approach flight is still running – lookAt would cut it short.
    if (performance.now() < this.followFlightUntil) return
    const camera = this.viewer.camera

    // Camera center at the height of the followed tram (its ground height
    // is already sampled on the 3D tiles and smoothed in syncVehicles).
    const record = this.followId ? this.vehicles.get(this.followId) : undefined
    const groundHeight = record?.groundHeight ?? this.host.defaultGroundHeight
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
    this.host.requestRender()
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
      // record.matrix is the live body matrix (box primitive or glTF model)
      const dx = record.matrix[12] - labelPos.x
      const dy = record.matrix[13] - labelPos.y
      const dz = record.matrix[14] - labelPos.z
      const drift = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (drift > maxDrift) maxDrift = drift
    }
    return maxDrift
  }

  /** Debug/tests: opacity currently applied to a vehicle body. */
  getVehicleOpacity(vehicleId: string): number | null {
    const record = this.vehicles.get(vehicleId)
    if (!record) return null
    if (record.isModelBody) {
      const model = record.models.find((m) => m !== undefined)
      // null while the async wagon loads are in flight
      return model ? (model.color?.alpha ?? 1) : null
    }
    try {
      const attributes = (record.primitive as Primitive).getGeometryInstanceAttributes(
        `vehicle:${vehicleId}`,
      )
      const alpha = attributes?.color?.[3]
      return typeof alpha === 'number' ? alpha / 255 : null
    } catch {
      // The primitive has not completed its first render yet.
      return null
    }
  }
}
