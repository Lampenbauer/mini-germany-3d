/**
 * Live webcams as pictures floating over the spot they look from. Windy's
 * Webcams API (src/lib/webcams.ts) delivers a preview per camera every
 * ten minutes; each is a world-sized billboard: its longest side spans
 * WEBCAM_LONG_SIDE_METERS, the aspect ratio is the picture's own – read
 * off the loaded picture, and the terms forbid stretching anyway – and
 * its bottom edge hovers WEBCAM_FLOAT_METERS above the ground, a signpost
 * over the place rather than a texture on it. Billboards face the camera,
 * so a picture stays legible from every side.
 *
 * The ground under a camera is measured on the photo tiles like the
 * vehicles' is; until the tiles are in, the city's ground first guess
 * holds the picture and update() re-measures on a slow cadence.
 *
 * Windy's terms: every picture links to its windy.com page (the map
 * opens it on a click, see CesiumMap), a courtesy line stands in the
 * credit display, and the pictures are used as delivered.
 *
 * The pictures also tell the other layers where they are on screen
 * (screenRects): a stop name, a vehicle badge or a ship name that would
 * sit on a picture steps aside for it – a label is always drawn on top
 * of everything, so the picture cannot win that any other way.
 */

import {
  BillboardCollection,
  Cartesian3,
  Credit,
  Matrix4,
  VerticalOrigin,
  type Billboard,
  type Cartesian2,
  type Viewer,
} from 'cesium'
import type { Webcam } from '@/lib/webcams-extract'
import { sameRects, type ScreenRect } from './screen-rects'

/** The picture's longest side on the map, in meters. */
export const WEBCAM_LONG_SIDE_METERS = 150
/** How high the picture's bottom edge floats above the ground, in meters. */
export const WEBCAM_FLOAT_METERS = 180
/** Frames between two ground re-measurements of pictures still on the first guess. */
const REMEASURE_FRAMES = 30

export interface LoadedPicture {
  image: HTMLImageElement | HTMLCanvasElement
  width: number
  height: number
}

export interface WebcamsLayerHost {
  requestRender(): void
  /** Ellipsoidal ground height on the loaded tiles, undefined until they are in. */
  sampleGroundHeight(lon: number, lat: number): number | undefined
  /** The city's ground first guess, ellipsoidal (see CesiumMap). */
  readonly defaultGroundHeight: number
  /** Picture loader – the browser's Image by default, a stub in the tests. */
  loadPicture?: (url: string) => Promise<LoadedPicture>
  /** Window position of a world point (CSS px), undefined behind the camera. */
  windowPosition?: (position: Cartesian3) => Cartesian2 | undefined
  /** Meters one CSS pixel covers at a world point's distance. */
  metersPerPixel?: (position: Cartesian3) => number
}

interface WebcamRecord {
  webcam: Webcam
  billboard: Billboard
  groundHeight: number
  /** true once the ground came off the tiles rather than the first guess. */
  measured: boolean
  /** Bumped per (re)load so a late picture of an earlier poll is dropped. */
  generation: number
}

/** The browser's own picture loader: cross-origin so the texture can be read. */
function loadPictureInBrowser(url: string): Promise<LoadedPicture> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve({ image, width: image.naturalWidth, height: image.naturalHeight })
    image.onerror = () => reject(new Error(`Webcam picture failed to load: ${url}`))
    image.src = url
  })
}

/** Billboard size in meters: the longest side at WEBCAM_LONG_SIDE_METERS, the ratio kept. */
export function pictureSizeMeters(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height, 1)
  return {
    width: (WEBCAM_LONG_SIDE_METERS * width) / longest,
    height: (WEBCAM_LONG_SIDE_METERS * height) / longest,
  }
}

export class WebcamsLayer {
  private collection: BillboardCollection | null = null
  private records = new Map<number, WebcamRecord>()
  private credit: Credit | null = null
  private frame = 0
  /** The pictures' screen rectangles as of rectsViewMatrix (see screenRects). */
  private rects: ScreenRect[] = []
  private rectsViewMatrix = new Matrix4()
  private rectsDirty = true
  private rectsVersion = 0
  /** The panel's switch: off keeps the cameras polled and listed, but nothing drawn. */
  private visible = true
  /** Underground view: pictures floating over a sunken surface have no place there. */
  private underground = false

  constructor(
    private readonly viewer: Viewer,
    private readonly host: WebcamsLayerHost,
  ) {}

  /** Number of cameras on the map (pictures loaded or still loading). */
  get count(): number {
    return this.records.size
  }

  /** The windy.com page of a camera on the map, for the click handler. */
  detailUrl(id: number): string | null {
    return this.records.get(id)?.webcam.detailUrl ?? null
  }

  /**
   * Where the pictures stand on screen right now, in CSS pixels – for the
   * labels to keep clear of. Refreshed when the camera has moved or a
   * picture came, went or changed size; the same array otherwise, so the
   * callers' per-tick checks cost a few comparisons.
   */
  get screenRects(): readonly ScreenRect[] {
    if (!this.shown) {
      if (this.rects.length > 0) {
        this.rects = []
        this.rectsVersion++
      }
      return this.rects
    }
    const camera = this.viewer.camera
    if (!this.rectsDirty && Matrix4.equals(this.rectsViewMatrix, camera.viewMatrix)) {
      return this.rects
    }
    this.rectsDirty = false
    Matrix4.clone(camera.viewMatrix, this.rectsViewMatrix)
    const rects: ScreenRect[] = []
    const { windowPosition, metersPerPixel } = this.host
    if (windowPosition && metersPerPixel) {
      for (const record of this.records.values()) {
        const billboard = record.billboard
        if (!billboard.show) continue
        const position = billboard.position
        const window = windowPosition(position)
        if (!window) continue
        const perPixel = metersPerPixel(position)
        if (!(perPixel > 0)) continue
        const halfWidth = (billboard.width ?? 0) / perPixel / 2
        const height = (billboard.height ?? 0) / perPixel
        // Anchored bottom-center (VerticalOrigin.BOTTOM); window y grows down
        rects.push({
          left: window.x - halfWidth,
          right: window.x + halfWidth,
          top: window.y - height,
          bottom: window.y,
        })
      }
    }
    if (!sameRects(rects, this.rects)) {
      this.rects = rects
      this.rectsVersion++
    }
    return this.rects
  }

  /** The Layers switch: pictures drawn or not (the list in the panel stays). */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return
    this.visible = visible
    this.applyShown()
  }

  /**
   * Underground view: the pictures go out wholesale, whatever the switch
   * says – they float over a surface that has just sunk to a dark relief,
   * and the tunnels are the point down there. The switch's state survives
   * the trip and applies again on the way up.
   */
  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    this.applyShown()
  }

  /** Whether the pictures are drawn: the switch on and the view on the surface. */
  private get shown(): boolean {
    return this.visible && !this.underground
  }

  private applyShown(): void {
    if (this.collection) this.collection.show = this.shown
    this.rectsDirty = true
    this.host.requestRender()
  }

  /**
   * What a flight to a camera aims at: the picture's center and half its
   * longest side, null for a camera not on the map (or not loaded yet).
   */
  focusTarget(id: number): { center: Cartesian3; radius: number } | null {
    const record = this.records.get(id)
    if (!record || !record.billboard.show) return null
    const width = record.billboard.width ?? 0
    const height = record.billboard.height ?? 0
    return {
      center: Cartesian3.fromDegrees(
        record.webcam.lon,
        record.webcam.lat,
        record.groundHeight + WEBCAM_FLOAT_METERS + height / 2,
      ),
      radius: Math.max(width, height) / 2,
    }
  }

  /** Bumped whenever screenRects changed – the stop declutter reruns on it. */
  get screenRectsVersion(): number {
    void this.screenRects
    return this.rectsVersion
  }

  /**
   * Puts the polled cameras on the map: new ones go up, gone ones come
   * down, and every picture is (re)loaded – a poll is the cadence the
   * cameras refresh at, and the same URL serves the newer picture.
   */
  sync(webcams: Webcam[]): void {
    const alive = new Set<number>()
    for (const webcam of webcams) {
      alive.add(webcam.id)
      let record = this.records.get(webcam.id)
      if (!record) {
        record = this.createRecord(webcam)
        this.records.set(webcam.id, record)
      } else {
        record.webcam = webcam
      }
      void this.loadPicture(record)
    }
    for (const [id, record] of this.records) {
      if (alive.has(id)) continue
      this.collection?.remove(record.billboard)
      this.records.delete(id)
      this.rectsDirty = true
      this.host.requestRender()
    }
    this.applyCredit()
  }

  /** Takes every camera off the map (the map is moving on to another city). */
  clear(): void {
    // The whole collection goes, not just its billboards: a collection's
    // texture atlas only ever grows (every picture ever set stays in it,
    // and the pictures change with each poll), so the city's pictures are
    // let go of with the city. sync() builds a fresh one for the next.
    if (this.collection) {
      this.viewer.scene.primitives.remove(this.collection)
      this.collection = null
    }
    this.records.clear()
    this.rectsDirty = true
    this.applyCredit()
    this.host.requestRender()
  }

  /**
   * Per-frame upkeep: pictures still standing on the ground first guess
   * are re-measured on the tiles every REMEASURE_FRAMES frames until the
   * tiles answer.
   */
  update(): void {
    if (this.records.size === 0) return
    this.frame++
    if (this.frame % REMEASURE_FRAMES !== 0) return
    for (const record of this.records.values()) {
      if (record.measured) continue
      const height = this.host.sampleGroundHeight(record.webcam.lon, record.webcam.lat)
      if (height === undefined) continue
      record.groundHeight = height
      record.measured = true
      record.billboard.position = this.positionOf(record)
      this.rectsDirty = true
      this.host.requestRender()
    }
  }

  private createRecord(webcam: Webcam): WebcamRecord {
    const measuredHeight = this.host.sampleGroundHeight(webcam.lon, webcam.lat)
    const record: WebcamRecord = {
      webcam,
      billboard: null as unknown as Billboard,
      groundHeight: measuredHeight ?? this.host.defaultGroundHeight,
      measured: measuredHeight !== undefined,
      generation: 0,
    }
    record.billboard = this.ensureCollection().add({
      id: `webcam:${webcam.id}`,
      position: this.positionOf(record),
      sizeInMeters: true,
      verticalOrigin: VerticalOrigin.BOTTOM,
      // Nothing to show until the picture is in
      show: false,
    })
    return record
  }

  private async loadPicture(record: WebcamRecord): Promise<void> {
    const generation = ++record.generation
    const url = record.webcam.image
    let picture: LoadedPicture
    try {
      picture = await (this.host.loadPicture ?? loadPictureInBrowser)(url)
    } catch (error) {
      console.warn('[MiniGermany3D]', error instanceof Error ? error.message : error)
      return
    }
    // The camera may have left, or a newer poll has loaded a newer picture
    if (this.records.get(record.webcam.id) !== record || record.generation !== generation) return
    const size = pictureSizeMeters(picture.width, picture.height)
    const billboard = record.billboard
    // A fresh image id per load: the same URL serves a newer picture, and
    // Cesium's texture atlas would otherwise keep the old one.
    billboard.setImage(`webcam:${record.webcam.id}:${generation}`, picture.image)
    billboard.width = size.width
    billboard.height = size.height
    billboard.show = true
    this.rectsDirty = true
    this.host.requestRender()
  }

  private positionOf(record: WebcamRecord): Cartesian3 {
    return Cartesian3.fromDegrees(
      record.webcam.lon,
      record.webcam.lat,
      record.groundHeight + WEBCAM_FLOAT_METERS,
    )
  }

  private ensureCollection(): BillboardCollection {
    if (!this.collection) {
      this.collection = new BillboardCollection()
      this.collection.show = this.shown
      this.viewer.scene.primitives.add(this.collection)
    }
    return this.collection
  }

  /** The courtesy line Windy's terms ask for, shown while cameras are on the map. */
  private applyCredit(): void {
    const wanted = this.records.size > 0
    if (wanted && !this.credit) {
      this.credit = new Credit(
        '<a href="https://www.windy.com/webcams" target="_blank" rel="noopener">Webcams: Windy.com</a>',
        true,
      )
      this.viewer.creditDisplay.addStaticCredit(this.credit)
    } else if (!wanted && this.credit) {
      this.viewer.creditDisplay.removeStaticCredit(this.credit)
      this.credit = null
    }
  }
}
