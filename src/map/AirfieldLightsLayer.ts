/**
 * The airfield lighting at night: one point per light OpenStreetMap maps
 * at the city's airfield (see scripts/fetch-airfield-lights.mjs) – runway
 * edge, centre line, threshold and touchdown zone, the approach system,
 * the PAPIs, taxiway edge and centre line, stop bars, guard lights – in
 * the colour ICAO gives each kind, a few pixels across whatever the
 * distance, in one PointPrimitiveCollection per city: one draw call for
 * Frankfurt's ten thousand. Where the street lamps are pools on the
 * ground for the close-up views, these are the lights themselves, meant
 * to read as the lit runway from the home view too – they do not fade
 * with the camera's height, they only shrink a little far out so a row
 * of them stays a row and not a smear.
 *
 * Lit from dusk along the night ramp, and by day when the visibility
 * the weather reports drops – the tower switches the lighting on in fog
 * and heavy rain, and so does the layer under LOW_VISIBILITY_M – and off
 * underground with the rest of the surface. All of them steady: OSM does
 * not tell the approach system's running flashers or the guard lights'
 * wig-wags apart from the steady lights beside them, and a flash would
 * keep the loop ticking wherever an airfield is in view, which the
 * aircraft's strobes pay for only while a body is on screen.
 *
 * Built lazily on the first frame that would show them, like the street
 * lamps: a daytime session pays nothing, and by then the NHN→ellipsoid
 * offset is calibrated. The points stand LIGHT_LIFT above the terrain
 * height – Google's runway lies within a few decimetres of the
 * bare-earth model, and a point half under the mesh would flicker.
 */

import {
  Cartesian3,
  Color,
  Credit,
  NearFarScalar,
  PointPrimitiveCollection,
  type Viewer,
} from 'cesium'
import type { AirfieldLightColour, AirfieldLightData } from '@/data/airfield-lights'

/** What the layer needs from the map around it – the street lamps' host. */
export interface AirfieldLightsLayerHost {
  requestRender(): void
  /** 0 = day … 1 = full night; the lights come on along it. */
  readonly nightFactor: number
  /** Ellipsoidal height for a light's NHN terrain height (see StreetLampsLayerHost). */
  groundHeightForNhn(nhn: number): number
  /** The visibility over the city in metres as the weather has it, null while unknown. */
  readonly visibilityM: number | null
}

/** The colours, hex because Cesium reads nothing newer (see CLAUDE.md); the aircraft's red and green. */
const COLOURS: Record<AirfieldLightColour, Color> = {
  white: Color.fromCssColorString('#ffffff'),
  green: Color.fromCssColorString('#30e060'),
  red: Color.fromCssColorString('#ff3b30'),
  blue: Color.fromCssColorString('#4d7dff'),
  yellow: Color.fromCssColorString('#ffc93c'),
}

/** How big a light is drawn, in CSS pixels, and how far its rim reaches – a size under the aircraft's lights. */
const LIGHT_PX = 3
const RIM_PX = 1.5
/** Meters above the terrain height (see the header). */
const LIGHT_LIFT = 1.5
/**
 * The night ramp the lights come on along: from NIGHT_ON of the night
 * factor to full at NIGHT_FULL – the runway is lit before the streets
 * are. Repainted every ALPHA_STEP of the way; below the first step the
 * collection is hidden rather than drawn at nothing.
 */
const NIGHT_ON = 0.05
const NIGHT_FULL = 0.3
const ALPHA_STEP = 0.05
/**
 * The visibility below which the lighting burns by day too: fully from
 * LOW_VISIBILITY_M down, fading in from LOW_VISIBILITY_OFF_M – the
 * tower's practice is the lighting on under roughly five kilometres,
 * and a ramp keeps a reading hovering near the threshold from flicking
 * the runway on and off every quarter hour.
 */
export const LOW_VISIBILITY_M = 4_000
export const LOW_VISIBILITY_OFF_M = 6_000

const colorScratch = new Color()
const rimScratch = new Color()

export class AirfieldLightsLayer {
  private readonly viewer: Viewer
  private readonly host: AirfieldLightsLayerHost
  private readonly collection = new PointPrimitiveCollection()
  private data: AirfieldLightData | null = null
  /** The colour of each point in the collection, in its order – for the repaints along the ramp. */
  private colours: AirfieldLightColour[] = []
  private built = false
  /** Ground anchor the points were built at – a change forces a rebuild. */
  private builtAnchor = Number.NaN
  /** Underground view: surface lighting has no place down there. */
  private underground = false
  /** Alpha the points currently carry (avoids redundant repaints). */
  private appliedAlpha = -1
  /** The data attribution add() registered, taken down again by clear(). */
  private credit: Credit | null = null

  constructor(viewer: Viewer, host: AirfieldLightsLayerHost) {
    this.viewer = viewer
    this.host = host
    this.collection.show = false
    viewer.scene.primitives.add(this.collection)
  }

  /**
   * Registers the lights. Nothing is drawn yet: the points are built on
   * the first frame that would actually show them (see update).
   */
  add(data: AirfieldLightData): void {
    this.clear()
    this.data = data
    if (data.lights.length === 0) return
    // OSM (ODbL) and the DGM heights both require visible attribution.
    this.credit = new Credit(data.meta.attribution, false)
    this.viewer.creditDisplay.addStaticCredit(this.credit)
    this.host.requestRender()
  }

  /** Takes the lights off the map (the map is moving on to another city). */
  clear(): void {
    this.collection.removeAll()
    this.collection.show = false
    this.colours = []
    this.built = false
    this.appliedAlpha = -1
    this.data = null
    if (this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
    this.host.requestRender()
  }

  /** The collection, for the clamp exclusion lists – an aircraft on the apron must not stand on a light. */
  get primitive(): PointPrimitiveCollection {
    return this.collection
  }

  /** Debug/tests: lights built into the scene and their current opacity. */
  get info(): { drawn: number; alpha: number } {
    return {
      drawn: this.built ? (this.data?.lights.length ?? 0) : 0,
      alpha: Math.max(0, this.appliedAlpha),
    }
  }

  /** Underground view: the lights go out with the rest of the surface. */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    // update() applies it on the frame this requests.
    this.host.requestRender()
  }

  /**
   * Per-frame upkeep: the ramp from the sun elevation, and the lazy
   * build once the lights would be visible. Costs one comparison while
   * they are dark, which is most of the time.
   */
  update(): void {
    if (!this.data || this.data.lights.length === 0) return
    const alpha = this.underground ? 0 : this.targetAlpha()
    if (alpha < ALPHA_STEP) {
      if (this.collection.show) {
        this.collection.show = false
        this.appliedAlpha = alpha
        this.host.requestRender()
      }
      return
    }
    // The height bootstrap re-anchors the routes against the loaded tiles;
    // the lights sit on the same offset and follow it. Usually never fires –
    // the offset settles seconds after startup, long before night falls.
    if (this.built && this.builtAnchor !== this.host.groundHeightForNhn(0)) {
      this.collection.removeAll()
      this.colours = []
      this.built = false
      this.appliedAlpha = -1
    }
    if (!this.built) this.build()
    if (Math.abs(alpha - this.appliedAlpha) >= ALPHA_STEP || !this.collection.show) {
      this.appliedAlpha = alpha
      this.applyAlpha(alpha)
      this.collection.show = true
      this.host.requestRender()
    }
  }

  /** The night ramp or the low-visibility ramp, whichever is higher, 0..1. */
  private targetAlpha(): number {
    const night = this.host.nightFactor
    const byNight = Math.min(1, Math.max(0, (night - NIGHT_ON) / (NIGHT_FULL - NIGHT_ON)))
    const visibility = this.host.visibilityM
    const byVisibility =
      visibility === null
        ? 0
        : Math.min(1, Math.max(0, (LOW_VISIBILITY_OFF_M - visibility) / (LOW_VISIBILITY_OFF_M - LOW_VISIBILITY_M)))
    return Math.max(byNight, byVisibility)
  }

  /** One point per light, at its colour; the alpha follows in applyAlpha. */
  private build(): void {
    const data = this.data
    if (!data) return
    for (const [lon, lat, nhn, , colour] of data.lights) {
      this.collection.add({
        position: Cartesian3.fromDegrees(lon, lat, this.host.groundHeightForNhn(nhn) + LIGHT_LIFT),
        pixelSize: LIGHT_PX,
        outlineWidth: RIM_PX,
        color: COLOURS[colour] ?? COLOURS.white,
        outlineColor: COLOURS[colour] ?? COLOURS.white,
        // Half the size far out, so ten thousand lights seen from the
        // home view stay rows of points rather than a white smear
        scaleByDistance: new NearFarScalar(2000, 1, 30_000, 0.5),
      })
      this.colours.push(colour in COLOURS ? colour : 'white')
    }
    this.built = true
    this.builtAnchor = this.host.groundHeightForNhn(0)
  }

  /** Repaints every point at the ramp's alpha – a handful of times per dusk. */
  private applyAlpha(alpha: number): void {
    for (let i = 0; i < this.collection.length; i++) {
      const point = this.collection.get(i)
      const base = COLOURS[this.colours[i]]
      Color.clone(base, colorScratch)
      colorScratch.alpha = alpha
      point.color = colorScratch
      Color.clone(base, rimScratch)
      rimScratch.alpha = alpha * 0.35
      point.outlineColor = rimScratch
    }
  }

  destroy(): void {
    this.clear()
    this.viewer.scene.primitives.remove(this.collection)
  }
}
