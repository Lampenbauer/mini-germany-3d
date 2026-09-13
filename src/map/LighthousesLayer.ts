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
 * day – and steady, like the buoys' lanterns, the character kept in the
 * file for a flashing rule one day. A major light (a range of ten miles
 * and more) is drawn bigger and fades later than a pier head's; both
 * fade with the distance to the camera like the lanterns. Drawn without
 * the depth test up close – the point sits a hand over the lantern's
 * mesh, whose dome would otherwise clip it at a grazing angle. Off
 * underground with the rest of the surface.
 */

import {
  BoundingSphere,
  Cartesian3,
  Color,
  Credit,
  Intersect,
  NearFarScalar,
  PointPrimitiveCollection,
  type Viewer,
} from 'cesium'
import type { LightColour, LighthouseData, LighthouseKind, LightSector } from '@/data/lighthouses'
import { bearingToDeg, sectorColourTowards } from '@/lib/seamark-lights'
import { airfieldLightLevel } from './AirfieldLightsLayer'

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
  readonly sectors: LightSector[]
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

export class LighthousesLayer {
  private readonly viewer: Viewer
  private readonly host: LighthousesLayerHost
  private readonly lights = new PointPrimitiveCollection()
  private records: LightRecord[] = []
  private credit: Credit | null = null
  private underground = false
  /** The night level the points were last painted at (avoids redundant repaints). */
  private appliedAlpha = -1
  /** The fallback surface the unclamped lights were last placed over. */
  private placedFallback = Number.NaN

  constructor(viewer: Viewer, host: LighthousesLayerHost) {
    this.viewer = viewer
    this.host = host
    this.lights.show = false
    viewer.scene.primitives.add(this.lights)
  }

  /** Registers the city's lights, at their elevations over the fallback water until the tiles say otherwise. */
  add(data: LighthouseData): void {
    this.clear()
    if (data.lights.length === 0) return
    this.credit = new Credit(data.meta.attribution, false)
    this.viewer.creditDisplay.addStaticCredit(this.credit)
    for (const [lon, lat, kind, elevationM, , sectors] of data.lights) {
      const record: LightRecord = {
        lon,
        lat,
        kind,
        elevationM,
        sectors,
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
    if (this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    this.host.requestRender()
  }

  /** Underground view: the towers are not down there. */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    this.host.requestRender()
  }

  /** Debug/tests: the lights registered, clamped to a tower top, shown towards the camera right now, and the level. */
  get info(): { lights: number; clamped: number; shown: number; alpha: number } {
    let clamped = 0
    let shown = 0
    for (const record of this.records) {
      if (record.clampedHeight !== null) clamped++
      if (record.drawn !== null && this.lights.show) shown++
    }
    return {
      lights: this.records.length,
      clamped,
      shown,
      alpha: this.lights.show ? Math.max(0, this.appliedAlpha) : 0,
    }
  }

  /**
   * Per simulation tick (from CesiumMap.syncVehicles): the clamps for
   * the lights near the camera and on screen whose answer could have
   * changed; the unclamped ones over the fallback surface as it moves
   * with the height bootstrap.
   */
  sync(): void {
    if (this.records.length === 0) return
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
    for (const record of this.records) {
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
  }

  /** Per rendered frame: the night level, and each light's colour towards the camera. */
  update(): void {
    if (this.records.length === 0) return
    const alpha = this.underground ? 0 : airfieldLightLevel(this.host.nightFactor, this.host.visibilityM)
    if (alpha < ALPHA_STEP) {
      if (this.lights.show) {
        this.lights.show = false
        this.appliedAlpha = alpha
        this.host.requestRender()
      }
      return
    }
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
  }

  /** Sets a light down at an ellipsoid height. */
  private place(record: LightRecord, height: number): void {
    Cartesian3.fromDegrees(record.lon, record.lat, height, undefined, record.position)
    if (record.index < this.lights.length) this.lights.get(record.index).position = record.position
  }
}
