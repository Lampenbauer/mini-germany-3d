/**
 * The flat map's pictures: Mapbox raster tiles on the bare globe (see
 * lib/basemap.ts for what the flat map is, CesiumMap.setBasemap for how
 * the ground under everything is flattened with it).
 *
 * Two imagery layers, two styles of the site's own – one drawn for the
 * day, one for the night – and the night one is laid over the day one
 * at the sun ramp's opacity (flatMapStyleBlend), the way the tiles' own
 * time-of-day shader grades the photo tiles. Cesium loads tiles for
 * every layer it shows whatever its alpha, so a style that would be
 * invisible is switched off rather than faded to nothing: by day and by
 * full night one style is requested, through dusk and dawn both. Mapbox
 * counts every tile against the account's monthly allowance.
 *
 * Mapbox's terms want their attribution on the map itself, so the
 * credit is an on-screen one (the Windy pictures' is the other); Cesium
 * shows it while a layer renders and takes it away with the layer.
 */

import { Credit, ImageryLayer, MapboxStyleImageryProvider, type Viewer } from 'cesium'
import { config } from '@/config'
import { flatMapStyleBlend } from '@/lib/basemap'

const MAPBOX_CREDIT =
  '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener">Mapbox</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' +
  '<a href="https://www.mapbox.com/map-feedback/" target="_blank" rel="noopener">Improve this map</a>'

/**
 * The imagery in the underground view: dimmed to the same dark relief
 * the tile shader makes of the photo tiles (UNDERGROUND_DIM there is in
 * linear light; an imagery layer's brightness is applied in the same
 * space, and this lands at about the same luminance on screen).
 */
const UNDERGROUND_BRIGHTNESS = 0.06

export interface FlatBasemapHost {
  requestRender(): void
  /** Drawing-buffer pixels per CSS pixel – above 1 the tiles come at @2x. */
  readonly pixelRatio: number
}

export class FlatBasemap {
  private day: ImageryLayer | null = null
  private night: ImageryLayer | null = null
  private underground = false

  constructor(
    private readonly viewer: Viewer,
    private readonly host: FlatBasemapHost,
  ) {}

  /** Whether a token is configured – without one the flat map is the bare globe. */
  static get available(): boolean {
    return config.flatMap.mapboxToken !== ''
  }

  /** The pictures are on the globe. */
  get shown(): boolean {
    return this.day !== null
  }

  /** Puts both styles on the globe, blended for the night level (nothing without a token). */
  show(nightLevel: number): void {
    if (this.day || !FlatBasemap.available) return
    const layers = this.viewer.scene.imageryLayers
    this.day = layers.addImageryProvider(this.provider(config.flatMap.day))
    this.night = layers.addImageryProvider(this.provider(config.flatMap.night))
    this.applyNight(nightLevel)
    this.applyUnderground()
    this.host.requestRender()
  }

  /** Takes the pictures off the globe; their tiles go with the layers. */
  hide(): void {
    if (!this.day) return
    const layers = this.viewer.scene.imageryLayers
    layers.remove(this.day, true)
    if (this.night) layers.remove(this.night, true)
    this.day = null
    this.night = null
    this.host.requestRender()
  }

  /** The sun ramp moved (see CesiumMap.updateNightFactor): the night style's share follows. */
  applyNight(nightLevel: number): void {
    if (!this.day || !this.night) return
    const blend = flatMapStyleBlend(nightLevel)
    let changed = false
    if (this.day.show !== blend.day.show) {
      this.day.show = blend.day.show
      changed = true
    }
    if (this.night.show !== blend.night.show) {
      this.night.show = blend.night.show
      changed = true
    }
    if (this.night.alpha !== blend.night.alpha) {
      this.night.alpha = blend.night.alpha
      changed = true
    }
    if (changed) this.host.requestRender()
  }

  /** Underground view: the map dims to a dark relief like the photo tiles do. */
  setUnderground(underground: boolean): void {
    if (this.underground === underground) return
    this.underground = underground
    this.applyUnderground()
  }

  /** Debug/tests: which styles are up and how the night one is blended. */
  get state(): { shown: boolean; day: boolean; night: boolean; nightAlpha: number } {
    return {
      shown: this.shown,
      day: this.day?.show === true,
      night: this.night?.show === true,
      nightAlpha: this.night?.alpha ?? 0,
    }
  }

  private applyUnderground(): void {
    const brightness = this.underground ? UNDERGROUND_BRIGHTNESS : 1
    for (const layer of [this.day, this.night]) {
      if (layer && layer.brightness !== brightness) layer.brightness = brightness
    }
    this.host.requestRender()
  }

  private provider(style: { user: string; styleId: string }): MapboxStyleImageryProvider {
    return new MapboxStyleImageryProvider({
      username: style.user,
      styleId: style.styleId,
      accessToken: config.flatMap.mapboxToken,
      tilesize: 512,
      // Cesium reads the option's presence, not its value: name it only
      // where the @2x tiles are wanted
      ...(this.host.pixelRatio > 1 ? { scaleFactor: true } : {}),
      credit: new Credit(MAPBOX_CREDIT, true),
    })
  }
}
