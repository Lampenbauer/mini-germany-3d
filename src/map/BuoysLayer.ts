/**
 * The buoys on the water: the fairways' red and green lateral marks and
 * the yellow special marks, as OpenStreetMap has them (see
 * scripts/fetch-buoys.mjs), one glTF each from the buoy fleet
 * (scripts/lib/buoy-fleet.mjs: a can, a cone, a spar, a pillar, a
 * sphere or a barrel in the mark's colour), set down on the tiles'
 * water and lit at night where the mark has a lantern.
 *
 * A buoy floats where the tiles put the water, like the ships
 * (VesselLayer): a clamp pick per buoy, made only for buoys on screen,
 * at most CLAMP_BUDGET_PER_TICK a tick, until it answers and again
 * after every load cycle (host.surfaceGeneration) so a height read off
 * a coarse tile is read again off the fine one; the fallback surface
 * until the first answer, for good offline. The buoys' own models and
 * their lights are kept off the pick, or a buoy would be set on its own
 * top.
 *
 * A few hundred marks in a harbour city, a few metres each: the models
 * are built per grid cell the first time the camera comes within
 * BODY_RANGE_M of it – a session over the city centre never loads one –
 * and a cell out of range hides its collection, so its models cost no
 * update (a hidden parent PrimitiveCollection is what skips a Model's
 * per-frame update, see CLAUDE.md). The lights are one
 * PointPrimitiveCollection for the whole city, always up: a lantern is
 * seen for miles, and at night the channel is what its lights draw
 * from the home view – faintly, the strength falling with the distance
 * to the camera (LANTERN_FULL_M … LANTERN_FAR_M), so a fairway seen
 * from high up is a trace of lights, not a string of LEDs. Lit along
 * the airfield's level – the night ramp,
 * or poor visibility by day (airfieldLightLevel) – and steady for now:
 * OSM has the character and period (Fl, Q, Oc … in the file), but a
 * flash would keep the loop ticking wherever a harbour is in view,
 * the price the airfield lighting declined too. Off underground with
 * the rest of the surface.
 */

import {
  BoundingSphere,
  Cartesian3,
  Color,
  Credit,
  Intersect,
  Matrix4,
  Model,
  NearFarScalar,
  PointPrimitiveCollection,
  PrimitiveCollection,
  ShadowMode,
  Transforms,
  type Viewer,
} from 'cesium'
import type { Buoy, BuoyData, BuoyLightColour, BuoyShape } from '@/data/buoys'
import { airfieldLightLevel } from './AirfieldLightsLayer'

/** What the layer needs from the map around it – the ships' host, plus the night. */
export interface BuoysLayerHost {
  requestRender(): void
  /** Ellipsoid height of the water surface, the fallback until a clamp answers (see VesselLayerHost). */
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
  /** 0 = day … 1 = full night; the lanterns come on along it. */
  readonly nightFactor: number
  /** The visibility over the city in metres as the weather has it, null while unknown. */
  readonly visibilityM: number | null
  /**
   * Loads a buoy's model – Model.fromGltfAsync by default; the tests hand
   * in a double, there being no WebGL to load a glTF into under Vitest.
   */
  loadModel?(url: string, modelMatrix: Matrix4): Promise<Model>
}

/**
 * The models per shape – the fleet's file and where its lantern is
 * (scripts/lib/buoy-fleet.mjs, BUOY_SHAPES; tests/buoy-models.test.ts
 * holds the two together).
 */
export const BUOY_MODELS: Record<BuoyShape, { lightHeight: number }> = {
  pillar: { lightHeight: 4.4 },
  spar: { lightHeight: 3.65 },
  can: { lightHeight: 1.6 },
  conical: { lightHeight: 2.0 },
  spherical: { lightHeight: 1.35 },
  barrel: { lightHeight: 1.1 },
}

/** The fleet's file for a shape in a colour. */
export function buoyModelUri(shape: BuoyShape, colour: Buoy[2]): string {
  return `models/buoy-${shape}-${colour}.glb`
}

/**
 * How far from the camera a cell's buoys are built and drawn. A buoy is
 * two to six metres: past four kilometres it is under a pixel, and the
 * home views stand higher than that – a session that never comes down
 * to the water loads no model at all.
 */
export const BODY_RANGE_M = 4_000
/** The grid the buoys are batched in, in degrees – about 2.2 × 1.1 km. */
const CELL_DEGREES = 0.02
/**
 * Meters a buoy is set above the water it was clamped to: Google's
 * water mesh undulates a little, and a float exactly on it dips under
 * the crests. Under the ships' fallback lift – a buoy has no keel.
 */
const SURFACE_LIFT_M = 0.25
/**
 * The clamps' ration per tick (see VesselLayer for the reasoning) –
 * twice the ships', because a harbour view has dozens of buoys to set
 * down at once and every one of them waits at the fallback until then,
 * which inland lies metres under the river.
 */
const CLAMP_BUDGET_PER_TICK = 6
/**
 * How far from the camera a buoy is clamped at all. A pick answers with
 * whatever tile is loaded under the mark, and far from the camera that
 * is a coarse one whose mesh lumps the water with its banks: measured
 * over the Breitling from a level 45 m view, the marks three
 * kilometres out came back between 9 m under and 18 m over the water,
 * and hopped there until the finer tiles arrived. Within this range the
 * tiles are fine enough for a metre; a mark further out keeps the
 * height it had, or the fallback, until the camera comes nearer.
 */
const CLAMP_RANGE_M = 1500

/** The lanterns' colours, hex because Cesium reads nothing newer (see CLAUDE.md). */
const LIGHT_COLOURS: Record<BuoyLightColour, Color> = {
  red: Color.fromCssColorString('#ff3b30'),
  green: Color.fromCssColorString('#30e060'),
  yellow: Color.fromCssColorString('#ffc93c'),
  white: Color.fromCssColorString('#ffffff'),
}
/** How big a lantern is drawn, in CSS pixels, a touch over the airfield's points – a lantern is one light, not one of a row – with a thin rim. */
const LIGHT_PX = 4
const RIM_PX = 1
/**
 * The lantern's strength over the distance to the camera: full within
 * LANTERN_FULL_M, down to LANTERN_FAR_STRENGTH at LANTERN_FAR_M and
 * that faint beyond – a chain of lights that burned as bright from
 * thirty kilometres up as from the quay read as a string of LEDs laid
 * over the map. The airfield's lights keep their
 * strength at any height on purpose; a runway is meant to be read from
 * the home view, a fairway is not. On the GPU per point
 * (translucencyByDistance), so the fade costs no repaint.
 */
const LANTERN_FULL_M = 1_500
const LANTERN_FAR_M = 12_000
const LANTERN_FAR_STRENGTH = 0.3
/** Repainted every ALPHA_STEP of the ramp; below the first step the lights are hidden rather than drawn at nothing. */
const ALPHA_STEP = 0.05
/**
 * Within this distance of the camera a lantern is drawn without the
 * depth test. The light sits where the lantern is, inside its housing,
 * under the topmark – and a point inside a mesh loses the depth test
 * against it from every side: from afar the point's four pixels reach
 * past the housing's one or two and the lantern shows, up close the
 * housing covered it entirely (seen from 88 m over a red
 * pillar buoy). Drawn over its own housing the point is the lantern's
 * glow, which is the picture; the price is a hull or a quay in front of
 * a buoy no longer hiding its light within this range, which is rare
 * and small. Beyond it the depth test holds, as it does for the ships'
 * lights, which stand clear of their hulls.
 */
const LANTERN_THROUGH_HOUSING_M = 600

interface BuoyRecord {
  readonly lon: number
  readonly lat: number
  readonly shape: BuoyShape
  readonly colour: Buoy[2]
  readonly light: BuoyLightColour | null
  /** The clamped water height, null until a pick answered. */
  clampedHeight: number | null
  /** The tiles the clamp was read off (host.surfaceGeneration). */
  clampedGeneration: number
  /** The model once loaded; null before, and for good where the load failed. */
  model: Model | null
  /** The lantern's point in the lights collection, by index; -1 for an unlit buoy. */
  lightIndex: number
  /** Where the model stands – the fallback or the clamped water plus the lift. */
  readonly position: Cartesian3
  /** The height the position was last placed at, to skip a re-place. */
  placedHeight: number
}

interface Cell {
  readonly buoys: BuoyRecord[]
  readonly collection: PrimitiveCollection
  /** The cell's middle, for the range test. */
  readonly centre: Cartesian3
  /** Half the cell's diagonal in metres – the range test allows for it. */
  readonly reach: number
  built: boolean
}

const colorScratch = new Color()
const rimScratch = new Color()
const positionScratch = new Cartesian3()
const sphereScratch = new BoundingSphere()

export class BuoysLayer {
  private readonly viewer: Viewer
  private readonly host: BuoysLayerHost
  /** The cells' collections hang under this one, so one switch takes every buoy off the map. */
  private readonly root = new PrimitiveCollection()
  private readonly lights = new PointPrimitiveCollection()
  private cells = new Map<string, Cell>()
  private records: BuoyRecord[] = []
  private credit: Credit | null = null
  private underground = false
  /** Alpha the lanterns currently carry (avoids redundant repaints). */
  private appliedAlpha = -1
  /** The lanterns' colours in the collection's order, for the repaints along the ramp. */
  private lightColours: BuoyLightColour[] = []
  /** The fallback surface the unclamped buoys were last placed on. */
  private placedFallback = Number.NaN

  constructor(viewer: Viewer, host: BuoysLayerHost) {
    this.viewer = viewer
    this.host = host
    this.lights.show = false
    viewer.scene.primitives.add(this.root)
    viewer.scene.primitives.add(this.lights)
  }

  /** Registers the city's buoys. Nothing is loaded yet: the models come as the camera does (see sync). */
  add(data: BuoyData): void {
    this.clear()
    if (data.buoys.length === 0) return
    this.credit = new Credit(data.meta.attribution, false)
    this.viewer.creditDisplay.addStaticCredit(this.credit)
    const surface = this.host.waterSurfaceHeight + SURFACE_LIFT_M
    for (const [lon, lat, colour, shape, light] of data.buoys) {
      const record: BuoyRecord = {
        lon,
        lat,
        shape,
        colour,
        light,
        clampedHeight: null,
        clampedGeneration: -1,
        model: null,
        lightIndex: -1,
        position: Cartesian3.fromDegrees(lon, lat, surface),
        placedHeight: surface,
      }
      this.records.push(record)
      const key = `${Math.floor(lon / CELL_DEGREES)}:${Math.floor(lat / CELL_DEGREES)}`
      let cell = this.cells.get(key)
      if (!cell) {
        const west = Math.floor(lon / CELL_DEGREES) * CELL_DEGREES
        const south = Math.floor(lat / CELL_DEGREES) * CELL_DEGREES
        const midLat = south + CELL_DEGREES / 2
        const collection = new PrimitiveCollection()
        collection.show = false
        this.root.add(collection)
        cell = {
          buoys: [],
          collection,
          centre: Cartesian3.fromDegrees(west + CELL_DEGREES / 2, midLat, surface),
          reach:
            0.5 *
            Math.hypot(
              CELL_DEGREES * 111_320 * Math.cos((midLat * Math.PI) / 180),
              CELL_DEGREES * 111_132,
            ),
          built: false,
        }
        this.cells.set(key, cell)
      }
      cell.buoys.push(record)
      if (light) {
        record.lightIndex = this.lights.length
        this.lights.add({
          position: this.lightPosition(record, positionScratch),
          pixelSize: LIGHT_PX,
          outlineWidth: RIM_PX,
          color: LIGHT_COLOURS[light],
          outlineColor: LIGHT_COLOURS[light],
          scaleByDistance: new NearFarScalar(2000, 1, 30_000, 0.6),
          translucencyByDistance: new NearFarScalar(
            LANTERN_FULL_M,
            1,
            LANTERN_FAR_M,
            LANTERN_FAR_STRENGTH,
          ),
          disableDepthTestDistance: LANTERN_THROUGH_HOUSING_M,
        })
        this.lightColours.push(light)
      }
    }
    this.placedFallback = surface
    this.appliedAlpha = -1
    this.host.requestRender()
  }

  /** Takes the buoys off the map (the map is moving on to another city). */
  clear(): void {
    // The cells' collections destroy their models with them
    this.root.removeAll()
    this.lights.removeAll()
    this.lights.show = false
    this.cells = new Map()
    this.records = []
    this.lightColours = []
    this.appliedAlpha = -1
    if (this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    this.host.requestRender()
  }

  /**
   * Forgets every height picked off the tiles – the water changed under
   * the marks (see CesiumMap.setBasemap): the next sync sets each on the
   * fallback surface again and picks anew where a pick can answer.
   */
  resetClamps(): void {
    for (const record of this.records) {
      record.clampedHeight = null
      record.clampedGeneration = -1
    }
    // A fallback that did not move still has to be applied again
    this.placedFallback = Number.NaN
    this.host.requestRender()
  }

  /** Underground view: the water is not down there. */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    this.root.show = !underground
    this.host.requestRender()
  }

  /**
   * Debug/tests: what is built, what is drawn, what floats on a clamp,
   * the lanterns' opacity – and how far apart the clamped heights lie
   * (`heightSpanM`): a harbour's water is one level to a metre, so a span
   * of lantern heights means the picks are landing on the marks
   * themselves (see CesiumMap.expandExclusions).
   */
  get info(): {
    buoys: number
    built: number
    shown: number
    clamped: number
    lit: number
    lightAlpha: number
    heightSpanM: number
    heightsOverFallbackM: number[]
  } {
    let built = 0
    let shown = 0
    let clamped = 0
    let lowest = Infinity
    let highest = -Infinity
    for (const cell of this.cells.values()) {
      for (const record of cell.buoys) {
        if (record.model) built++
        if (record.model && cell.collection.show && !this.underground) shown++
        if (record.clampedHeight !== null) {
          clamped++
          lowest = Math.min(lowest, record.clampedHeight)
          highest = Math.max(highest, record.clampedHeight)
        }
      }
    }
    return {
      buoys: this.records.length,
      built,
      shown,
      clamped,
      lit: this.lightColours.length,
      lightAlpha: this.lights.show ? Math.max(0, this.appliedAlpha) : 0,
      heightSpanM: clamped > 0 ? highest - lowest : 0,
      // The clamped heights over the fallback water surface, sorted, for a look
      heightsOverFallbackM: this.records
        .filter((r) => r.clampedHeight !== null)
        .map((r) => Math.round((r.clampedHeight! - this.host.waterSurfaceHeight) * 10) / 10)
        .sort((a, b) => a - b),
    }
  }

  /**
   * Per simulation tick (from CesiumMap.syncVehicles): the cells within
   * range built and shown, the rest hidden; the clamps for the buoys on
   * screen whose answer could have changed; the unclamped ones on the
   * fallback surface as it moves with the height bootstrap.
   */
  sync(): void {
    if (this.records.length === 0) return
    const camera = this.viewer.camera.positionWC
    const cullingVolume = this.viewer.camera.frustum.computeCullingVolume(
      camera,
      this.viewer.camera.directionWC,
      this.viewer.camera.upWC,
    )
    const fallback = this.host.waterSurfaceHeight + SURFACE_LIFT_M
    const surfaceGeneration = this.host.surfaceGeneration?.() ?? 0
    // No pick while the camera moves (see CesiumMap.cameraAtRest)
    let clampBudget = this.host.cameraAtRest !== false ? CLAMP_BUDGET_PER_TICK : 0
    let changed = false
    for (const cell of this.cells.values()) {
      const inRange = Cartesian3.distance(camera, cell.centre) < BODY_RANGE_M + cell.reach
      if (inRange && !cell.built) this.build(cell)
      if (cell.collection.show !== inRange) {
        cell.collection.show = inRange
        changed = true
      }
      for (const record of cell.buoys) {
        // The fallback surface moved (the height bootstrap): the buoys
        // still on it follow
        if (record.clampedHeight === null && fallback !== this.placedFallback) {
          this.place(record, fallback)
          changed = true
        }
        // Clamp to the tiles – the ships' rule: once per surface
        // generation, which for a buoy that never moves is the only thing
        // that changes the answer, a pick that found no tile included;
        // only on screen, at most CLAMP_BUDGET_PER_TICK a tick. The
        // generation advances every two seconds while tiles stream in
        // (CesiumMap.advanceSurfaceGeneration), so a view along the water
        // – thousands of tiles, over which a load cycle never finishes –
        // still sets its marks down within seconds of their tiles: the
        // Breitling's seventy-seven in half a minute (measured;
        // under the same rule keyed to allTilesLoaded six of them).
        if (!inRange || !this.host.clampToSurface || clampBudget <= 0) continue
        if (record.clampedGeneration === surfaceGeneration) continue
        if (Cartesian3.distance(camera, record.position) > CLAMP_RANGE_M) continue
        if (cullingVolume.computeVisibility(this.sphereOf(record)) === Intersect.OUTSIDE) continue
        clampBudget--
        record.clampedGeneration = surfaceGeneration
        // The pick answers with whatever the tiles have there – the
        // water, or the deck of a ship Google photographed at the mark,
        // which the ships suffer too; nothing here can tell the two apart
        const h = this.host.clampToSurface(record.lon, record.lat)
        if (h === undefined) continue
        record.clampedHeight = h
        this.place(record, h + SURFACE_LIFT_M)
        changed = true
      }
    }
    this.placedFallback = fallback
    if (changed) this.host.requestRender()
  }

  /** Per rendered frame: the lanterns along the airfield's level. */
  update(): void {
    if (this.lightColours.length === 0) return
    const alpha = this.underground ? 0 : airfieldLightLevel(this.host.nightFactor, this.host.visibilityM)
    if (alpha < ALPHA_STEP) {
      if (this.lights.show) {
        this.lights.show = false
        this.appliedAlpha = alpha
        this.host.requestRender()
      }
      return
    }
    if (Math.abs(alpha - this.appliedAlpha) >= ALPHA_STEP || !this.lights.show) {
      this.appliedAlpha = alpha
      for (let i = 0; i < this.lights.length; i++) {
        const point = this.lights.get(i)
        const base = LIGHT_COLOURS[this.lightColours[i]]
        Color.clone(base, colorScratch)
        colorScratch.alpha = alpha
        point.color = colorScratch
        Color.clone(base, rimScratch)
        rimScratch.alpha = alpha * 0.4
        point.outlineColor = rimScratch
      }
      this.lights.show = true
      this.host.requestRender()
    }
  }

  destroy(): void {
    this.clear()
    this.viewer.scene.primitives.remove(this.root)
    this.viewer.scene.primitives.remove(this.lights)
  }

  /** A sphere around the buoy for the frustum test – the mark and its lantern. */
  private sphereOf(record: BuoyRecord): BoundingSphere {
    Cartesian3.clone(record.position, sphereScratch.center)
    sphereScratch.radius = BUOY_MODELS[record.shape].lightHeight + 2
    return sphereScratch
  }

  /** Where the lantern is: the buoy's position plus the shape's lantern height, straight up. */
  private lightPosition(record: BuoyRecord, result: Cartesian3): Cartesian3 {
    const height = record.placedHeight + BUOY_MODELS[record.shape].lightHeight
    return Cartesian3.fromDegrees(record.lon, record.lat, height, undefined, result)
  }

  /** Sets the buoy down at an ellipsoid height: its model, and its lantern with it. */
  private place(record: BuoyRecord, height: number): void {
    record.placedHeight = height
    Cartesian3.fromDegrees(record.lon, record.lat, height, undefined, record.position)
    if (record.model) {
      Transforms.eastNorthUpToFixedFrame(record.position, undefined, record.model.modelMatrix)
    }
    if (record.lightIndex >= 0) {
      this.lights.get(record.lightIndex).position = this.lightPosition(record, positionScratch)
    }
  }

  /** Loads the cell's models – once, the first time the camera comes near. */
  private build(cell: Cell): void {
    cell.built = true
    for (const record of cell.buoys) void this.attachModel(cell, record)
  }

  private async attachModel(cell: Cell, record: BuoyRecord): Promise<void> {
    let model: Model
    try {
      const url = `${import.meta.env.BASE_URL}${buoyModelUri(record.shape, record.colour)}`
      const modelMatrix = Transforms.eastNorthUpToFixedFrame(record.position)
      model = this.host.loadModel
        ? await this.host.loadModel(url, modelMatrix)
        : await Model.fromGltfAsync({
            url,
            modelMatrix,
            // Casts onto the water, receives nothing – like the hulls
            shadows: ShadowMode.CAST_ONLY,
          })
    } catch (error) {
      console.warn('[MiniGermany3D] Buoy model failed to load:', error)
      return
    }
    // The city may have moved on meanwhile
    if (this.viewer.isDestroyed() || this.cells.get(this.keyOf(record)) !== cell) {
      model.destroy()
      return
    }
    record.model = model
    // The position may have been clamped while the load was on its way
    Transforms.eastNorthUpToFixedFrame(record.position, undefined, model.modelMatrix)
    cell.collection.add(model)
    this.host.requestRender()
  }

  private keyOf(record: BuoyRecord): string {
    return `${Math.floor(record.lon / CELL_DEGREES)}:${Math.floor(record.lat / CELL_DEGREES)}`
  }
}
