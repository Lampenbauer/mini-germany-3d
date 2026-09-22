/**
 * The lighthouses and the lesser fixed lights at night – the harbour's
 * towers, the mole and pier heads, the leading and sector lights on the
 * shore – as OpenStreetMap has them (scripts/fetch-lighthouses.mjs), one
 * point each in the colour the light shows towards the camera. No model
 * of their own: Google's tiles carry the towers, and the light is set on
 * the top of its tower as the mesh has it – a clamp pick straight down
 * at the light's position lands on the highest thing there, which is
 * the lantern (the ships' pick, rationed like the buoys'; the tiles
 * near the camera only, CLAMP_RANGE_M, for the coarse-tile reason the
 * buoys found). Where the mesh lost a thin mast – a pier light's – the
 * pick lands on the pier, and OSM's elevation of the light over the
 * water (seamark:light:height) is the floor: a pick more than
 * MESH_LOST_TOWER_M under it is not the tower's top. Until a pick
 * answers, and for good offline, the light stands at that elevation
 * over the fallback water surface, or DEFAULT_ELEVATION_M without one.
 *
 * Most of them are sector lights (see lib/seamark-lights.ts): the colour
 * depends on the bearing from the camera to the light, and outside every
 * sector the light is obscured – a viewer on the land side of Bülk sees
 * nothing, as at sea. Repainted per frame only where the sector or the
 * night level changed; a few dozen bearings a frame cost nothing.
 *
 * Lit along the airfield's level – the night ramp, or poor visibility by
 * day – and steady, like the buoys' lanterns. A major light (a range of
 * ten miles and more) is drawn bigger and fades later than a pier head's;
 * both fade with the distance to the camera like the lanterns. Drawn
 * without the depth test up close – the point sits a hand over the
 * lantern's mesh, whose dome would otherwise clip it at a grazing angle.
 * Off underground with the rest of the surface.
 *
 * The one exception to "steady" (since 2026-09-16, the user's call): a
 * major light that flashes with a known period is a rotating optic
 * (lib/lighthouse-beam.ts), and its beams turn – a shaft in the air per
 * lens and the light it throws on the tiles (LighthouseBeams.ts, for
 * both). The optic runs on the simulated clock like the ships' smoke: a
 * pause holds it, the time-lapse turns it no faster than BEAM_MAX_RATE
 * times real time. A turning beam is motion, and motion is what this
 * map renders for: with a lit beam in view the layer asks for frames the
 * way the fleets do (screen-motion.ts) – at most every BEAM_MIN_FRAME_MS,
 * the loop's fastest tick – and reports its motion to the loop so the
 * ticks keep pace. That is the cost the user accepted for what the buoys
 * and the airfield were kept steady to avoid, tamed to where it applies:
 * only within the beams' reach of the camera (beamDistanceFade in
 * LighthouseBeams: full to 10 km, gone at 20, the pacing weighed by
 * it), in the frustum and on the night level; by day, and with every
 * tower far off or out of the frame, the loop is as quiet as before.
 */

import {
  BoundingSphere,
  Cartesian3,
  Cartesian4,
  Color,
  Credit,
  Intersect,
  Math as CesiumMath,
  Matrix4,
  NearFarScalar,
  PointPrimitiveCollection,
  Transforms,
  type CustomShader,
  type Viewer,
} from 'cesium'
import type { LightColour, LighthouseData, LighthouseKind, LightSector } from '@/data/lighthouses'
import { beamColour, lensAzimuthsDeg, rotatingOptic, type RotatingOptic } from '@/lib/lighthouse-beam'
import { bearingToDeg, sectorColourTowards } from '@/lib/seamark-lights'
import { airfieldLightLevel } from './AirfieldLightsLayer'
import { PLUME_MAX_RATE } from './FunnelSmoke'
import {
  BEAM_LENGTH_M,
  beamDistanceFade,
  LIGHTHOUSE_BEAM_UNIFORMS,
  LighthouseBeams,
  MAX_TILE_BEAMS,
} from './LighthouseBeams'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'

/** What the layer needs from the map around it – the buoys' host. */
export interface LighthousesLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface (see VesselLayerHost) – what OSM's elevations are measured from. */
  readonly waterSurfaceHeight: number
  /** Height of the loaded tiles under a position (see VesselLayerHost). */
  clampToSurface?(lon: number, lat: number): number | undefined
  /**
   * Whether the camera stood still since the last tick – the surface
   * picks wait for that (see CesiumMap.cameraAtRest); absent, it is
   * taken to rest.
   */
  readonly cameraAtRest?: boolean
  /** Bumped when the loaded tiles changed (see VesselLayerHost). */
  surfaceGeneration?(): number
  /** 0 = day … 1 = full night; the lights come on along it. */
  readonly nightFactor: number
  /** The visibility over the city in metres as the weather has it, null while unknown. */
  readonly visibilityM: number | null
  /** Device pixels per CSS pixel the map draws at – the motion threshold's scale (see screen-motion.ts); 1 when absent. */
  readonly pixelRatio?: number
}

/** How far from the camera a light is clamped to the tiles (see the header; the buoys' reasoning). */
export const CLAMP_RANGE_M = 3_000
const CLAMP_BUDGET_PER_TICK = 2
/** Metres the point stands over the top the pick found – clear of the lantern's own mesh. */
const LIGHT_LIFT_M = 0.6
/** A pick this far under OSM's elevation of the light missed the mast (see the header). */
const MESH_LOST_TOWER_M = 3
/** Elevation over the water for a light OSM gives none, until a pick answers. */
const DEFAULT_ELEVATION_M = 10
/** How big a light is drawn, in CSS pixels, by kind, and its rim. */
const LIGHT_PX: Record<LighthouseKind, number> = { major: 7, minor: 4 }
const RIM_PX = 1
/** The strength over the distance to the camera, by kind – a tower's light carries further than a pier head's. */
const FADE: Record<LighthouseKind, NearFarScalar> = {
  major: new NearFarScalar(5_000, 1, 40_000, 0.5),
  minor: new NearFarScalar(1_500, 1, 12_000, 0.3),
}
/** Within this distance the point is drawn without the depth test (see the header). */
const THROUGH_TOWER_M = 1_000
/** Repainted every ALPHA_STEP of the ramp. */
const ALPHA_STEP = 0.05
/** The optic turns no faster than this multiple of real time under the time-lapse – the smoke's rate. */
export const BEAM_MAX_RATE = PLUME_MAX_RATE
/**
 * The pace a turning beam holds the loop's ticks to at most: the loop's
 * own fastest tick, the rate the beam turns at anyway while the camera
 * moves, so the two look alike – the user's call (2026-09-16, after
 * looking at the true 20 twice and at the 30 twice; 20 is the number to
 * come back to if the frames ever weigh). It caps the motion the layer
 * reports, not the frames it
 * asks for: a frame is asked for whenever the beam has moved a visible
 * step since the last one, once per tick at most by construction. A cap
 * on the requests measured from the last frame's end was tried and
 * halved the rate – a tick later, less than a tick had passed since the
 * frame finished, and every second tick drew nothing (15 fps at a 33 ms
 * tick, headed, 2026-09-16).
 */
export const BEAM_MIN_FRAME_MS = 33
/** How far over the tiles a beam lights the ground, in metres – its haze's reach, not the light's range. */
export const BEAM_REACH_M = 6_000

/** The colours, hex because Cesium reads nothing newer (see CLAUDE.md); the buoys' lanterns' own. */
const COLOURS: Record<LightColour, Color> = {
  white: Color.fromCssColorString('#ffffff'),
  red: Color.fromCssColorString('#ff3b30'),
  green: Color.fromCssColorString('#30e060'),
  yellow: Color.fromCssColorString('#ffc93c'),
}

interface LightRecord {
  readonly lon: number
  readonly lat: number
  readonly kind: LighthouseKind
  /** OSM's elevation of the light over the water, metres, or null. */
  readonly elevationM: number | null
  /** The light's range in nautical miles, or null – how far its beam lights the tiles. */
  readonly rangeNm: number | null
  readonly sectors: LightSector[]
  /** The turning optic, null for a steady light (see lib/lighthouse-beam.ts). */
  readonly optic: RotatingOptic | null
  /** The index of the point in the collection. */
  readonly index: number
  /** The clamped top of the tower, null until a pick answered. */
  clampedHeight: number | null
  clampedGeneration: number
  /** Where the point stands. */
  readonly position: Cartesian3
  /** The colour the point was last painted in, null while obscured or dark. */
  drawn: LightColour | null
}

const colorScratch = new Color()
const rimScratch = new Color()
const sphereScratch = new BoundingSphere()
const localScratch = new Cartesian3()
const enuScratch = new Matrix4()

/** The beams' colours as the shader takes them, 0 … 1 – the points' own. */
const BEAM_RGB: Record<LightColour, readonly [number, number, number]> = {
  white: [COLOURS.white.red, COLOURS.white.green, COLOURS.white.blue],
  red: [COLOURS.red.red, COLOURS.red.green, COLOURS.red.blue],
  green: [COLOURS.green.red, COLOURS.green.green, COLOURS.green.blue],
  yellow: [COLOURS.yellow.red, COLOURS.yellow.green, COLOURS.yellow.blue],
}

export class LighthousesLayer {
  private readonly viewer: Viewer
  private readonly host: LighthousesLayerHost
  private readonly lights = new PointPrimitiveCollection()
  /** The turning beams' shafts (see LighthouseBeams). */
  private readonly beams = new LighthouseBeams()
  private records: LightRecord[] = []
  private credit: Credit | null = null
  private underground = false
  /** The night level the points were last painted at (avoids redundant repaints). */
  private appliedAlpha = -1
  /** The fallback surface the unclamped lights were last placed over. */
  private placedFallback = Number.NaN
  /** The tiles' shader, once the tileset has one – where the beams light the ground. */
  private tileShader: CustomShader | null = null
  /** World → east-north-up at the city's lights, for the shader's bearings (set with the data). */
  private readonly toLocal = Matrix4.clone(Matrix4.IDENTITY)
  /** The shader's slots, written per frame; a reach of 0 in `b` empties a slot. */
  private readonly slotA = Array.from({ length: MAX_TILE_BEAMS }, () => new Cartesian4())
  private readonly slotB = Array.from({ length: MAX_TILE_BEAMS }, () => new Cartesian4())
  /** The night level the shader was last given (0 skips its block). */
  private appliedBeamLight = -1
  /** Seconds the optics have turned – their clock (see advanceOptics). */
  private opticTime = 0
  /** The optics' clock as of the frame last drawn. */
  private renderedOpticTime = 0
  private lastAdvanceMs: number | null = null
  private lastAdvanceReal: number | null = null

  constructor(viewer: Viewer, host: LighthousesLayerHost) {
    this.viewer = viewer
    this.host = host
    this.lights.show = false
    viewer.scene.primitives.add(this.lights)
    viewer.scene.primitives.add(this.beams)
  }

  /** The tiles' shader, for the light the beams throw on the ground (see CesiumMap.createTileset). */
  attachTileShader(shader: CustomShader | null): void {
    this.tileShader = shader
    this.appliedBeamLight = -1
    if (shader) shader.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.toLocal, this.toLocal)
  }

  /** Registers the city's lights, at their elevations over the fallback water until the tiles say otherwise. */
  add(data: LighthouseData): void {
    this.clear()
    if (data.lights.length === 0) return
    this.credit = new Credit(data.meta.attribution, false)
    this.viewer.creditDisplay.addStaticCredit(this.credit)
    // One local frame for the shader's bearings, at the middle of the
    // lights: within a city's box the tangent plane is flat enough
    let sumLon = 0
    let sumLat = 0
    for (const light of data.lights) {
      sumLon += light[0]
      sumLat += light[1]
    }
    const centre = Cartesian3.fromDegrees(sumLon / data.lights.length, sumLat / data.lights.length, 0)
    Matrix4.inverseTransformation(Transforms.eastNorthUpToFixedFrame(centre, undefined, enuScratch), this.toLocal)
    this.tileShader?.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.toLocal, this.toLocal)
    for (const light of data.lights) {
      const [lon, lat, kind, elevationM, rangeNm, sectors] = light
      const record: LightRecord = {
        lon,
        lat,
        kind,
        elevationM,
        rangeNm,
        sectors,
        optic: rotatingOptic(light),
        index: this.lights.length,
        clampedHeight: null,
        clampedGeneration: -1,
        position: new Cartesian3(),
        drawn: null,
      }
      this.place(record, this.host.waterSurfaceHeight + (elevationM ?? DEFAULT_ELEVATION_M))
      this.lights.add({
        position: record.position,
        pixelSize: LIGHT_PX[kind],
        outlineWidth: RIM_PX,
        color: Color.TRANSPARENT,
        outlineColor: Color.TRANSPARENT,
        show: false,
        scaleByDistance: new NearFarScalar(2000, 1, 30_000, 0.6),
        translucencyByDistance: FADE[kind],
        disableDepthTestDistance: THROUGH_TOWER_M,
      })
      this.records.push(record)
    }
    this.placedFallback = this.host.waterSurfaceHeight
    this.appliedAlpha = -1
    this.host.requestRender()
  }

  /** Takes the lights off the map (the map is moving on to another city). */
  clear(): void {
    this.lights.removeAll()
    this.lights.show = false
    this.records = []
    this.appliedAlpha = -1
    this.beams.begin()
    this.beams.commit()
    this.pushBeamLight(0)
    if (this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    this.host.requestRender()
  }

  /**
   * Forgets every tower top picked off the tiles – the ground changed
   * under the lights (see CesiumMap.setBasemap): the next sync sets each
   * at its charted elevation over the fallback water again.
   */
  resetClamps(): void {
    for (const record of this.records) {
      record.clampedHeight = null
      record.clampedGeneration = -1
    }
    this.placedFallback = Number.NaN
    this.host.requestRender()
  }

  /** Underground view: the towers are not down there. */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    this.host.requestRender()
  }

  /**
   * Debug/tests: the lights registered, clamped to a tower top, shown
   * towards the camera right now, and the level; the turning optics, the
   * beams drawn this frame and their clock.
   */
  get info(): {
    lights: number
    clamped: number
    shown: number
    alpha: number
    rotating: number
    beams: number
    opticTime: number
  } {
    let clamped = 0
    let shown = 0
    let rotating = 0
    for (const record of this.records) {
      if (record.clampedHeight !== null) clamped++
      if (record.drawn !== null && this.lights.show) shown++
      if (record.optic) rotating++
    }
    return {
      lights: this.records.length,
      clamped,
      shown,
      alpha: this.lights.show ? Math.max(0, this.appliedAlpha) : 0,
      rotating,
      beams: this.beams.drawn,
      opticTime: this.opticTime,
    }
  }

  /** The map drew a frame: the beams' motion from here on is what has not been shown. */
  markRendered(): void {
    this.renderedOpticTime = this.opticTime
  }

  /**
   * Carries the optics on the simulated clock: by its own elapsed time,
   * paused with it, backward under the rewind, and no faster than
   * BEAM_MAX_RATE times the real time that passed either way – the
   * smoke's rule (FunnelSmoke.advance). Returns the seconds the optics
   * turned this tick, negative for a turn back.
   */
  private advanceOptics(simMs: number, realNowMs: number): number {
    let advanced = 0
    if (this.lastAdvanceMs !== null && this.lastAdvanceReal !== null) {
      const dt = (simMs - this.lastAdvanceMs) / 1000
      const realDt = Math.max(0, (realNowMs - this.lastAdvanceReal) / 1000)
      if (dt !== 0) {
        advanced = Math.sign(dt) * Math.min(Math.abs(dt), realDt * BEAM_MAX_RATE)
        this.opticTime += advanced
      }
    }
    this.lastAdvanceMs = simMs
    this.lastAdvanceReal = realNowMs
    return advanced
  }

  /** The night level the beams light the tiles at – written once per change, 0 skips the shader's block. */
  private pushBeamLight(level: number): void {
    if (!this.tileShader || level === this.appliedBeamLight) return
    this.appliedBeamLight = level
    this.tileShader.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.light, level)
  }

  /**
   * Per simulation tick (from CesiumMap.syncVehicles): the clamps for
   * the lights near the camera and on screen whose answer could have
   * changed; the unclamped ones over the fallback surface as it moves
   * with the height bootstrap; and the optics turned on the simulated
   * clock (`simMs`, absent in a test without one), their motion measured
   * for the loop's pace and a frame asked for once it shows – the
   * fleets' rule. Returns whether a lit beam turned in view this tick
   * and how far its far end moved on screen (CSS px), capped so the
   * loop's tick never falls under BEAM_MIN_FRAME_MS.
   */
  sync(simMs?: number): { beamInView: boolean; tickMotionPx: number } {
    const still = { beamInView: false, tickMotionPx: 0 }
    if (this.records.length === 0) return still
    const camera = this.viewer.camera.positionWC
    const cullingVolume = this.viewer.camera.frustum.computeCullingVolume(
      camera,
      this.viewer.camera.directionWC,
      this.viewer.camera.upWC,
    )
    const fallback = this.host.waterSurfaceHeight
    const surfaceGeneration = this.host.surfaceGeneration?.() ?? 0
    // No pick while the camera moves (see CesiumMap.cameraAtRest)
    let clampBudget = this.host.cameraAtRest !== false ? CLAMP_BUDGET_PER_TICK : 0
    let changed = false
    // The optics: turned on the clock, and paced against the screen
    const realNow = performance.now()
    const realDtMs = this.lastAdvanceReal === null ? 0 : Math.max(1, realNow - this.lastAdvanceReal)
    const turned = simMs === undefined ? 0 : this.advanceOptics(simMs, realNow)
    const level = this.underground ? 0 : airfieldLightLevel(this.host.nightFactor, this.host.visibilityM)
    const pxPerMeterAtUnit = cssPixelsPerMeterAtUnitDistance(this.viewer)
    const motionThreshold = motionThresholdCssPx(this.host.pixelRatio ?? 1)
    let beamInView = false
    let tickMotionPx = 0
    let sinceRenderedPx = 0
    for (const record of this.records) {
      if (record.optic && turned !== 0 && level >= ALPHA_STEP) {
        const distance = Cartesian3.distance(camera, record.position)
        const fade = beamDistanceFade(distance)
        if (fade > 0) {
          Cartesian3.clone(record.position, sphereScratch.center)
          sphereScratch.radius = BEAM_LENGTH_M
          if (cullingVolume.computeVisibility(sphereScratch) !== Intersect.OUTSIDE) {
            beamInView = true
            // The far end of the beam sweeps at the optic's rate – weighed
            // by the fade: a beam mostly gone with the distance earns
            // frames in proportion to what is left of it
            const sweepMetersPerSecond = ((2 * Math.PI) / record.optic.turnS) * BEAM_LENGTH_M
            const pxPerMeter = Number.isFinite(pxPerMeterAtUnit) ? pxPerMeterAtUnit / Math.max(1, distance) : 1
            const pxPerSecond = sweepMetersPerSecond * pxPerMeter * fade
            tickMotionPx = Math.max(tickMotionPx, Math.abs(turned) * pxPerSecond)
            sinceRenderedPx = Math.max(
              sinceRenderedPx,
              Math.abs(this.opticTime - this.renderedOpticTime) * pxPerSecond,
            )
          }
        }
      }
      if (record.clampedHeight === null && fallback !== this.placedFallback) {
        this.place(record, fallback + (record.elevationM ?? DEFAULT_ELEVATION_M))
        changed = true
      }
      if (!this.host.clampToSurface || clampBudget <= 0) continue
      // Once per surface generation, answered or not (the buoys' rule)
      if (record.clampedGeneration === surfaceGeneration) continue
      if (Cartesian3.distance(camera, record.position) > CLAMP_RANGE_M) continue
      Cartesian3.clone(record.position, sphereScratch.center)
      sphereScratch.radius = 50
      if (cullingVolume.computeVisibility(sphereScratch) === Intersect.OUTSIDE) continue
      clampBudget--
      record.clampedGeneration = surfaceGeneration
      const h = this.host.clampToSurface(record.lon, record.lat)
      if (h === undefined) continue
      record.clampedHeight = h
      // The tower's top, unless the mesh lost the mast: then OSM's elevation
      const top = h + LIGHT_LIFT_M
      const charted = record.elevationM !== null ? fallback + record.elevationM : null
      this.place(record, charted !== null && top < charted - MESH_LOST_TOWER_M ? charted : top)
      changed = true
    }
    this.placedFallback = fallback
    if (changed) this.host.requestRender()
    if (!beamInView) return still
    // A frame once the beams have moved a visible step since the last one
    if (sinceRenderedPx >= motionThreshold) this.host.requestRender()
    // Reported so that the loop's tick, threshold over motion, comes out
    // at BEAM_MIN_FRAME_MS and not under it
    const cappedMotionPx = (motionThreshold * realDtMs) / BEAM_MIN_FRAME_MS
    return { beamInView, tickMotionPx: Math.min(tickMotionPx, cappedMotionPx) }
  }

  /**
   * Per rendered frame: the night level, each light's colour towards the
   * camera, and the turning beams – a shaft per lit lens for the air, a
   * slot per lens for the tiles' shader.
   */
  update(): void {
    if (this.records.length === 0) return
    const alpha = this.underground ? 0 : airfieldLightLevel(this.host.nightFactor, this.host.visibilityM)
    if (alpha < ALPHA_STEP) {
      if (this.lights.show) {
        this.lights.show = false
        this.appliedAlpha = alpha
        this.host.requestRender()
      }
      if (this.beams.drawn > 0) {
        this.beams.begin()
        this.beams.commit()
      }
      this.pushBeamLight(0)
      return
    }
    this.updateBeams(alpha)
    const repaintAll = Math.abs(alpha - this.appliedAlpha) >= ALPHA_STEP || !this.lights.show
    if (repaintAll) this.appliedAlpha = alpha
    const camera = this.viewer.camera.positionCartographic
    const cameraLon = (camera.longitude * 180) / Math.PI
    const cameraLat = (camera.latitude * 180) / Math.PI
    let changed = repaintAll
    for (const record of this.records) {
      const colour = sectorColourTowards(record.sectors, bearingToDeg(cameraLon, cameraLat, record.lon, record.lat))
      if (colour === record.drawn && !repaintAll) continue
      const point = this.lights.get(record.index)
      if (colour === null) {
        point.show = false
      } else {
        Color.clone(COLOURS[colour], colorScratch)
        colorScratch.alpha = this.appliedAlpha
        point.color = colorScratch
        Color.clone(COLOURS[colour], rimScratch)
        rimScratch.alpha = this.appliedAlpha * 0.4
        point.outlineColor = rimScratch
        point.show = true
      }
      record.drawn = colour
      changed = true
    }
    if (!this.lights.show) {
      this.lights.show = true
      changed = true
    }
    if (changed) this.host.requestRender()
  }

  destroy(): void {
    this.clear()
    this.viewer.scene.primitives.remove(this.lights)
    this.viewer.scene.primitives.remove(this.beams)
  }

  /**
   * The beams for this frame: each turning optic within reach of the
   * camera, each lens of it pointing into a lit sector – the shaft in
   * the air, and one of the shader's slots while they last (the nearest
   * optics first: the records are walked in file order, major lights
   * ahead, and a city has a handful at most). Both fade with the
   * camera's distance to the lantern (beamDistanceFade): the shaft in
   * its intensity, the light on the tiles in its colour.
   */
  private updateBeams(alpha: number): void {
    const camera = this.viewer.camera.positionWC
    this.beams.begin()
    let slot = 0
    for (const record of this.records) {
      if (!record.optic) continue
      const fade = beamDistanceFade(Cartesian3.distance(camera, record.position))
      if (fade <= 0) continue
      const strength = alpha * fade
      const reach = Math.min(BEAM_REACH_M, record.rangeNm !== null ? record.rangeNm * 1852 : BEAM_REACH_M)
      for (const azimuthDeg of lensAzimuthsDeg(this.opticTime, record.optic)) {
        const colour = beamColour(record.sectors, azimuthDeg)
        if (colour === null) continue
        const rgb = BEAM_RGB[colour]
        const azimuthRad = CesiumMath.toRadians(azimuthDeg)
        this.beams.add(record.position, azimuthRad, rgb, BEAM_LENGTH_M, strength)
        if (slot < MAX_TILE_BEAMS && this.tileShader) {
          Matrix4.multiplyByPoint(this.toLocal, record.position, localScratch)
          Cartesian4.fromElements(localScratch.x, localScratch.y, localScratch.z, azimuthRad, this.slotA[slot])
          Cartesian4.fromElements(rgb[0] * fade, rgb[1] * fade, rgb[2] * fade, reach, this.slotB[slot])
          this.tileShader.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.a(slot), this.slotA[slot])
          this.tileShader.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.b(slot), this.slotB[slot])
          slot++
        }
      }
    }
    this.beams.commit()
    if (this.tileShader) {
      for (; slot < MAX_TILE_BEAMS; slot++) {
        if (this.slotB[slot].w === 0) continue
        Cartesian4.fromElements(0, 0, 0, 0, this.slotB[slot])
        this.tileShader.setUniform(LIGHTHOUSE_BEAM_UNIFORMS.b(slot), this.slotB[slot])
      }
      this.pushBeamLight(this.beams.drawn > 0 ? alpha : 0)
    }
  }

  /** Sets a light down at an ellipsoid height. */
  private place(record: LightRecord, height: number): void {
    Cartesian3.fromDegrees(record.lon, record.lat, height, undefined, record.position)
    if (record.index < this.lights.length) this.lights.get(record.index).position = record.position
  }
}
