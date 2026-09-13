/**
 * The navigation lights of the aircraft and the ships: one point per
 * light in one PointPrimitiveCollection per layer, a few pixels across
 * whatever the distance – a light is a light, not a thing with a size –
 * with a softer rim so it reads as a glow rather than a dot. The layers
 * feed it per tick the way they feed the plumes and the wakes: begin(),
 * add() for every light that is on, commit() – and what is on is
 * decided from the clock alone (see lib/nav-lights.ts), so the picture
 * is right in any frame whatever the last one showed.
 *
 * The points are pooled: a light that is on this tick takes the next
 * point in the pool and only its position, colour and size are
 * written (each setter is a no-op for an unchanged value); the rest of
 * the pool is hidden at commit. A collection whose points come and go
 * rebuilds its vertex buffer, one whose points merely move updates it
 * in place – with a few dozen lights either is cheap, but the pool keeps
 * a tick that changes nothing from costing anything at all.
 *
 * Each point carries the id of the thing it belongs to, so a click on a
 * light picks the aircraft or the ship (see CesiumMap.pickTarget).
 */

import {
  Cartesian3,
  Color,
  NearFarScalar,
  PointPrimitiveCollection,
  type PointPrimitive,
  type PrimitiveCollection,
} from 'cesium'

/** How big a light is drawn, in CSS pixels, and how far its rim reaches. */
const LIGHT_PX = 4
const RIM_PX = 2
/** The strobes are brighter and bigger than the steady lights – a flash, not a lamp. */
export const STROBE_PX = 6

/** The colours, hex because Cesium reads nothing newer (see CLAUDE.md). */
export const LIGHT_RED = Color.fromCssColorString('#ff3b30')
export const LIGHT_GREEN = Color.fromCssColorString('#30e060')
export const LIGHT_WHITE = Color.fromCssColorString('#ffffff')

const colorScratch = new Color()
const rimScratch = new Color()

export class NavLights {
  private readonly collection = new PointPrimitiveCollection()
  private readonly points: PointPrimitive[] = []
  private used = 0
  /** How many lights the last commit left on – the debug API's count. */
  private lit = 0

  /** The points go into the layer's own root collection (see VesselLayer.root). */
  constructor(parent: PrimitiveCollection) {
    parent.add(this.collection)
  }

  begin(): void {
    this.used = 0
  }

  /**
   * One light that is on this tick, at a world position, in a colour at
   * an intensity (0 … 1, the night factor as a rule). `throughEverything`
   * draws it over whatever is in front of it – an aircraft in the air has
   * nothing in front of it but its own wing, which would otherwise hide
   * the far tip's light or flicker over it; a ship's lights stay behind
   * the quay and the superstructure, as they are.
   */
  add(
    position: Cartesian3,
    color: Color,
    intensity: number,
    id: string,
    sizePx = LIGHT_PX,
    throughEverything = false,
  ): void {
    let point = this.points[this.used]
    if (!point) {
      point = this.collection.add({
        position,
        // Half the size at the far end of the range, so a light far out
        // stays a point and not a blob over the aircraft it belongs to
        scaleByDistance: new NearFarScalar(2000, 1, 40_000, 0.6),
      })
      this.points.push(point)
    }
    this.used++
    point.show = true
    point.position = position
    point.id = id
    point.pixelSize = sizePx
    point.outlineWidth = RIM_PX
    Color.clone(color, colorScratch)
    colorScratch.alpha = intensity
    point.color = colorScratch
    Color.clone(color, rimScratch)
    rimScratch.alpha = intensity * 0.35
    point.outlineColor = rimScratch
    point.disableDepthTestDistance = throughEverything ? Number.POSITIVE_INFINITY : 0
  }

  /** Hides the points nothing claimed this tick. */
  commit(): void {
    for (let i = this.used; i < this.points.length; i++) this.points[i].show = false
    this.lit = this.used
  }

  /** The whole set on or off – the underground view takes the surface's lights with it. */
  setVisible(visible: boolean): void {
    this.collection.show = visible
  }

  /** Lights on at the last commit. */
  get count(): number {
    return this.lit
  }
}
