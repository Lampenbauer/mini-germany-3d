/**
 * Night-time street lighting: a warm light pool under every OSM street
 * lamp that stands along a route (see scripts/fetch-street-lamps.mjs).
 * Same idea as the vehicles' cabin glow – a flat radial-gradient quad on
 * the ground whose opacity follows the sun ramp – only there are seven
 * thousand of them, which drives every decision here:
 *
 *   - the pools are batched into one primitive per grid cell, so Cesium
 *     frustum-culls whole neighborhoods instead of drawing the city;
 *   - all cells share one material, so the day→night ramp is a single
 *     uniform write rather than seven thousand;
 *   - nothing is built until the pools are actually visible. A session
 *     that never sees night pays nothing at all, and by the time night
 *     falls the NHN→ellipsoid offset is long calibrated, so the lazy
 *     build also saves the rebuild an early build would need.
 */

import {
  Cartesian3,
  Color,
  Credit,
  GeometryInstance,
  Material,
  MaterialAppearance,
  Matrix4,
  PlaneGeometry,
  Primitive,
  Transforms,
  VertexFormat,
  type Viewer,
} from 'cesium'
import type { StreetLamp, StreetLampData } from '@/data/street-lamps'

/** What the lamps layer needs from the map around it. */
export interface StreetLampsLayerHost {
  requestRender(): void
  /** 0 = day … 1 = full night; the pools fade in along it. */
  readonly nightFactor: number
  /**
   * Ellipsoidal height for a lamp's NHN terrain height – the same source
   * the routes are anchored to, and the measured ground where there are no
   * NHN heights to anchor against (offline, fixed ground height).
   */
  groundHeightForNhn(nhn: number): number
}

/**
 * Warm sodium/LED white, a touch cooler than the vehicles' cabin glow:
 * street lighting reads as the brighter, whiter light of the two.
 */
const LAMP_COLOR = Color.fromCssColorString('#ffdcae')

/**
 * Pool opacity in full night. Well below the vehicles' 0.95 – lamps stand
 * every ~15 m along a street, so their pools overlap, and at cabin-glow
 * strength a lit street turns into one solid white band.
 */
const LAMP_MAX_ALPHA = 0.42

/** Diameter of one light pool in meters (a lamp lights about that much road). */
const LAMP_POOL_DIAMETER = 15

/**
 * Meters above the terrain height. Below ROUTE_BASE_LIFT (0.8 m), so the
 * route polylines stay clearly readable on top of a lit street.
 */
const LAMP_LIFT = 0.12

/**
 * Camera heights between which the lighting fades out. Individual pools
 * become sub-pixel from far up, where they would only add shimmer; the
 * lit streets resolve as the view comes down into the city.
 */
const LAMP_FADE_FULL_HEIGHT = 3_000
const LAMP_FADE_OUT_HEIGHT = 9_000

/** Below this the pools are not worth a draw call – nothing is shown. */
const LAMP_MIN_ALPHA = 0.01

/**
 * Grid cell size in degrees for the batching (~2.2 km × ~1.3 km at
 * Rostock's latitude). Small enough that the frustum culls most of the
 * city out of a street-level view, large enough to keep the draw call
 * count in the low tens when looking across it.
 */
const LAMP_CELL_DEGREES = 0.02

export class StreetLampsLayer {
  private readonly viewer: Viewer
  private readonly host: StreetLampsLayerHost
  private data: StreetLampData | null = null
  /** One batched primitive per grid cell; empty until the lazy build runs. */
  private cells: Primitive[] = []
  private material: Material | null = null
  private appearance: MaterialAppearance | null = null
  private spriteCanvas?: HTMLCanvasElement | null
  /** Underground view: surface lighting has no place down there. */
  private underground = false
  /** Alpha the material currently carries (avoids redundant writes). */
  private appliedAlpha = -1
  /** Ground anchor the cells were built at – a change forces a rebuild. */
  private builtAnchor = Number.NaN
  /** The data attribution add() registered, taken down again by clear(). */
  private credit: Credit | null = null

  constructor(viewer: Viewer, host: StreetLampsLayerHost) {
    this.viewer = viewer
    this.host = host
  }

  /**
   * Registers the lamp data. Nothing is drawn yet: the pools are built on
   * the first frame that would actually show them (see update).
   */
  add(data: StreetLampData): void {
    this.clear()
    this.data = data
    // OSM (ODbL) and the DGM heights both require visible attribution.
    this.credit = new Credit(data.meta.attribution, false)
    this.viewer.creditDisplay.addStaticCredit(this.credit)
  }

  /** Takes the lamps off the map (the map is moving on to another city). */
  clear(): void {
    this.destroyCells()
    this.data = null
    if (this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    this.host.requestRender()
  }

  /** Debug/tests: lamps batched into the scene and their current opacity. */
  get info(): { drawn: number; alpha: number } {
    return {
      drawn: this.cells.length === 0 ? 0 : (this.data?.lamps.length ?? 0),
      alpha: Math.max(0, this.appliedAlpha),
    }
  }

  /**
   * Underground view: the pools go out. Down there the surface is dimmed
   * to a dark relief so the tunnels show through it, and a lit street grid
   * lying over that only muddies them – the same reason the weather grade
   * drops out (see the tile shader).
   */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    // update() applies it on the frame this requests.
    this.host.requestRender()
  }

  /**
   * Per-frame upkeep: the fade from sun elevation and camera height, and
   * the lazy build once the pools would be visible. Costs one comparison
   * while the pools are dark, which is most of the time.
   */
  update(): void {
    if (!this.data) return
    const alpha = this.underground ? 0 : this.targetAlpha()
    if (alpha < LAMP_MIN_ALPHA) {
      if (this.appliedAlpha >= LAMP_MIN_ALPHA) {
        this.appliedAlpha = alpha
        for (const cell of this.cells) cell.show = false
      }
      return
    }
    // The height bootstrap re-anchors the routes against the loaded tiles;
    // the pools sit on the same offset and follow it. Usually never fires –
    // the offset settles seconds after startup, long before night falls.
    if (this.cells.length > 0 && this.builtAnchor !== this.host.groundHeightForNhn(0)) {
      this.destroyCells()
    }
    if (this.cells.length === 0 && !this.build()) return
    if (Math.abs(alpha - this.appliedAlpha) > 0.005 || this.appliedAlpha < LAMP_MIN_ALPHA) {
      const wasHidden = this.appliedAlpha < LAMP_MIN_ALPHA
      this.appliedAlpha = alpha
      if (this.material) {
        ;(this.material.uniforms as { color: Color }).color.alpha = alpha
      }
      if (wasHidden) {
        // Only reached with a lit alpha, so the cells belong on screen.
        for (const cell of this.cells) cell.show = true
      }
      this.host.requestRender()
    }
    // The cells are assembled in a worker over several frames. The app
    // only renders on request, so keep asking until they are in – an idle
    // map would otherwise stop rendering with half the city still dark.
    if (this.cells.some((cell) => !cell.ready)) this.host.requestRender()
  }

  /** Night ramp × camera-height fade, both 0..1. */
  private targetAlpha(): number {
    const night = this.host.nightFactor
    if (night <= 0) return 0
    const height = this.viewer.camera.positionCartographic.height
    const fade =
      height <= LAMP_FADE_FULL_HEIGHT
        ? 1
        : height >= LAMP_FADE_OUT_HEIGHT
          ? 0
          : 1 - (height - LAMP_FADE_FULL_HEIGHT) / (LAMP_FADE_OUT_HEIGHT - LAMP_FADE_FULL_HEIGHT)
    return LAMP_MAX_ALPHA * night * fade
  }

  /** Builds the batched cells. Returns false where no 2D canvas exists. */
  private build(): boolean {
    const data = this.data
    const appearance = this.poolAppearance()
    if (!data || !appearance) return false

    const byCell = new Map<string, StreetLamp[]>()
    for (const lamp of data.lamps) {
      const key = `${Math.floor(lamp[0] / LAMP_CELL_DEGREES)}:${Math.floor(lamp[1] / LAMP_CELL_DEGREES)}`
      let cell = byCell.get(key)
      if (!cell) byCell.set(key, (cell = []))
      cell.push(lamp)
    }

    const scale = new Cartesian3(LAMP_POOL_DIAMETER, LAMP_POOL_DIAMETER, 1)
    for (const lamps of byCell.values()) {
      const instances = lamps.map(
        ([lon, lat, nhn]) =>
          new GeometryInstance({
            geometry: new PlaneGeometry({ vertexFormat: VertexFormat.POSITION_AND_ST }),
            modelMatrix: Matrix4.multiplyByScale(
              Transforms.eastNorthUpToFixedFrame(
                Cartesian3.fromDegrees(lon, lat, this.host.groundHeightForNhn(nhn) + LAMP_LIFT),
              ),
              scale,
              new Matrix4(),
            ),
          }),
      )
      const primitive = new Primitive({
        geometryInstances: instances,
        appearance,
        // The cells are built off the render loop; a synchronous build of
        // seven thousand quads would drop frames.
        asynchronous: true,
        allowPicking: false,
        show: false, // update() turns the cells on once the alpha is set
      })
      this.viewer.scene.primitives.add(primitive)
      this.cells.push(primitive)
    }
    this.builtAnchor = this.host.groundHeightForNhn(0)
    return true
  }

  private destroyCells(): void {
    for (const cell of this.cells) this.viewer.scene.primitives.remove(cell)
    this.cells = []
    this.appliedAlpha = -1
    this.builtAnchor = Number.NaN
  }

  /** Shared radial-gradient sprite of the pools (null: no 2D canvas). */
  private poolSprite(): HTMLCanvasElement | null {
    if (this.spriteCanvas !== undefined) return this.spriteCanvas
    this.spriteCanvas = null
    if (typeof document !== 'undefined') {
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 128
      const ctx = canvas.getContext('2d')
      if (ctx) {
        // Softer shoulder than the vehicles' pool: a lamp's light falls off
        // gradually, and overlapping hard edges would tile the street.
        const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
        gradient.addColorStop(0, 'rgba(255,255,255,0.95)')
        gradient.addColorStop(0.3, 'rgba(255,255,255,0.5)')
        gradient.addColorStop(0.65, 'rgba(255,255,255,0.16)')
        gradient.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = gradient
        ctx.fillRect(0, 0, 128, 128)
        this.spriteCanvas = canvas
      }
    }
    return this.spriteCanvas
  }

  /** Appearance shared by every cell (lazy; null without a 2D canvas). */
  private poolAppearance(): MaterialAppearance | null {
    if (this.appearance) return this.appearance
    const sprite = this.poolSprite()
    if (!sprite) return null
    this.material = new Material({
      fabric: {
        type: 'StreetLampGlow',
        uniforms: {
          image: sprite,
          color: LAMP_COLOR.withAlpha(0),
        },
        components: {
          diffuse: 'color.rgb',
          alpha: 'texture(image, materialInput.st).a * color.a',
        },
      },
    })
    this.appearance = new MaterialAppearance({
      flat: true,
      translucent: true,
      material: this.material,
    })
    return this.appearance
  }

  destroy(): void {
    this.clear()
  }
}
