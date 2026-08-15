/**
 * Imperativer Wrapper um den Cesium-Viewer: Google Photorealistic 3D Tiles,
 * Linien-Routen, Haltestellen und die animierten Straßenbahn-Quader.
 *
 * Bewusst ohne React-Abhängigkeit gehalten – React steuert diese Klasse über
 * eine schmale API (syncTrams, setLineVisibility, …), damit die Render-Schleife
 * nicht durch React-Re-Renders läuft.
 */

import {
  Cartesian2,
  Cartesian3,
  ClassificationType,
  Color,
  ColorMaterialProperty,
  ConstantPositionProperty,
  ConstantProperty,
  DistanceDisplayCondition,
  Entity,
  GridImageryProvider,
  HeadingPitchRoll,
  HeightReference,
  Ion,
  LabelStyle,
  Math as CesiumMath,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  Transforms,
  Viewer,
  createGooglePhotorealistic3DTileset,
} from 'cesium'
import { config } from '@/config'
import type { PreparedNetwork } from '@/data/network-types'
import type { TramSnapshot } from '@/engine/simulation'

export type TilesetStatus = 'loading' | 'google-3d-tiles' | 'offline' | 'failed'

export interface CesiumMapOptions {
  /** Offline-Modus: keine Ion/Google-Anfragen (für Tests/Entwicklung ohne Netz). */
  offline?: boolean
  onSelectTram?: (tramId: string | null) => void
  onTilesetStatus?: (status: TilesetStatus) => void
}

interface TramEntityRecord {
  entity: Entity
  position: ConstantPositionProperty
  orientation: ConstantProperty
  color: Color
}

const TRAM_HALF_HEIGHT = config.tram.height / 2

export class CesiumMap {
  readonly viewer: Viewer
  private readonly opts: CesiumMapOptions
  private trams = new Map<string, TramEntityRecord>()
  private routeEntities = new Map<string, Entity[]>()
  private stopEntities: Entity[] = []
  private handler: ScreenSpaceEventHandler
  private selectedId: string | null = null
  private destroyed = false

  constructor(container: HTMLElement, opts: CesiumMapOptions = {}) {
    this.opts = opts

    if (!opts.offline) {
      Ion.defaultAccessToken = config.cesiumIonToken
    }

    this.viewer = new Viewer(container, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      msaaSamples: 4,
    })

    const scene = this.viewer.scene
    scene.globe.baseColor = Color.fromCssColorString('#0c1322')
    scene.backgroundColor = Color.fromCssColorString('#05080f')

    // Doppelklick-Zoom des Viewers stört die eigene Auswahl-Logik
    this.viewer.screenSpaceEventHandler.removeInputAction(
      ScreenSpaceEventType.LEFT_DOUBLE_CLICK,
    )

    if (opts.offline) {
      // Software-Rendering (Tests) nicht unnötig belasten
      this.viewer.targetFrameRate = 20
      // Dezentes Gitter statt Satellitenbild – vollständig offline berechenbar
      scene.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          color: Color.fromCssColorString('#22304a').withAlpha(0.6),
          glowColor: Color.TRANSPARENT,
          backgroundColor: Color.fromCssColorString('#0c1322'),
          cells: 4,
        }),
      )
      opts.onTilesetStatus?.('offline')
    } else {
      opts.onTilesetStatus?.('loading')
      void this.loadGoogleTiles()
    }

    this.setCameraHome(false)

    this.handler = new ScreenSpaceEventHandler(scene.canvas)
    this.handler.setInputAction((movement: { position: Cartesian2 }) => {
      const picked = scene.pick(movement.position) as { id?: unknown } | undefined
      const entity = picked?.id
      if (entity instanceof Entity && entity.id.startsWith('tram:')) {
        this.opts.onSelectTram?.(entity.id.slice('tram:'.length))
      } else {
        this.opts.onSelectTram?.(null)
      }
    }, ScreenSpaceEventType.LEFT_CLICK)
  }

  private async loadGoogleTiles(): Promise<void> {
    try {
      const tileset = await createGooglePhotorealistic3DTileset()
      if (this.destroyed) return
      this.viewer.scene.primitives.add(tileset)
      // Der Globus würde unter den photorealistischen Kacheln doppelt rendern
      this.viewer.scene.globe.show = false
      this.opts.onTilesetStatus?.('google-3d-tiles')
    } catch (error) {
      console.error('Google Photorealistic 3D Tiles konnten nicht geladen werden:', error)
      if (this.destroyed) return
      // Fallback: dunkler Globus mit Gitter, damit die Simulation nutzbar bleibt
      this.viewer.scene.imageryLayers.addImageryProvider(
        new GridImageryProvider({
          color: Color.fromCssColorString('#22304a').withAlpha(0.6),
          glowColor: Color.TRANSPARENT,
          backgroundColor: Color.fromCssColorString('#0c1322'),
          cells: 4,
        }),
      )
      this.opts.onTilesetStatus?.('failed')
    }
  }

  private homeView: {
    longitude: number
    latitude: number
    height: number
    heading: number
    pitch: number
  } = config.home

  /** Setzt die Home-Ansicht (z.B. aus der Netz-Bounding-Box) und springt dorthin. */
  setHomeView(view: typeof this.homeView): void {
    this.homeView = view
    this.setCameraHome(false)
  }

  setCameraHome(animate = true): void {
    const { longitude, latitude, height, heading, pitch } = this.homeView
    const destination = Cartesian3.fromDegrees(longitude, latitude, height)
    const orientation = {
      heading: CesiumMath.toRadians(heading),
      pitch: CesiumMath.toRadians(pitch),
      roll: 0,
    }
    if (animate) {
      this.viewer.camera.flyTo({ destination, orientation, duration: 2 })
    } else {
      this.viewer.camera.setView({ destination, orientation })
    }
  }

  /** Zeichnet die Routen-Polylinien aller Linien (auf Boden/3D-Tiles drapiert). */
  addRoutes(network: PreparedNetwork): void {
    network.lines.forEach((line, index) => {
      const color = Color.fromCssColorString(line.color)
      const entities: Entity[] = []

      const dirs = [line.directions[0]]
      // Zweite Richtung nur zeichnen, wenn sie eine eigene Geometrie hat
      // (bei gespiegelten Richtungen ist der Pfad identisch)
      const d1 = line.directions[1]
      const d0 = line.directions[0]
      const mirrored =
        d1.path.length === d0.path.length &&
        d1.path[0][0] === d0.path[d0.path.length - 1][0] &&
        d1.path[0][1] === d0.path[d0.path.length - 1][1]
      if (!mirrored) dirs.push(d1)

      for (const dir of dirs) {
        const positions = Cartesian3.fromDegreesArray(dir.path.flat())
        entities.push(
          this.viewer.entities.add({
            id: `route:${line.id}:${dir.direction}`,
            polyline: {
              positions,
              width: 5,
              clampToGround: true,
              material: new ColorMaterialProperty(color.withAlpha(0.85)),
              classificationType: ClassificationType.BOTH,
              zIndex: 10 + index,
            },
          }),
        )
      }
      this.routeEntities.set(line.id, entities)
    })
  }

  /** Zeichnet alle Haltestellen (dedupliziert über die Linien hinweg). */
  addStops(network: PreparedNetwork): void {
    const seen = new Set<string>()
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          if (seen.has(stop.id)) continue
          seen.add(stop.id)
          this.stopEntities.push(
            this.viewer.entities.add({
              id: `stop:${stop.id}`,
              position: Cartesian3.fromDegrees(stop.coord[0], stop.coord[1]),
              point: {
                pixelSize: 7,
                color: Color.fromCssColorString('#f8fafc'),
                outlineColor: Color.fromCssColorString('#334155'),
                outlineWidth: 2,
                heightReference: HeightReference.CLAMP_TO_GROUND,
                distanceDisplayCondition: new DistanceDisplayCondition(0, 9000),
                disableDepthTestDistance: 3000,
              },
              label: {
                text: stop.name,
                font: '13px "Inter Variable", system-ui, sans-serif',
                fillColor: Color.fromCssColorString('#e2e8f0'),
                outlineColor: Color.fromCssColorString('#0f172a'),
                outlineWidth: 3,
                style: LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cartesian2(0, -16),
                heightReference: HeightReference.CLAMP_TO_GROUND,
                distanceDisplayCondition: new DistanceDisplayCondition(0, 2600),
                disableDepthTestDistance: 3000,
              },
            }),
          )
        }
      }
    }
  }

  setRoutesVisible(visible: boolean): void {
    for (const entities of this.routeEntities.values()) {
      for (const e of entities) e.show = visible
    }
  }

  setStopsVisible(visible: boolean): void {
    for (const e of this.stopEntities) e.show = visible
  }

  setLineRouteVisible(lineId: string, visible: boolean): void {
    for (const e of this.routeEntities.get(lineId) ?? []) e.show = visible
  }

  /**
   * Gleicht die Straßenbahn-Entities mit den aktuellen Snapshots ab.
   * Wird jeden Frame aufgerufen: aktualisiert Positionen in-place,
   * legt neue Entities an und entfernt beendete Fahrten.
   */
  syncTrams(snapshots: TramSnapshot[], visibleLines: ReadonlySet<string>): void {
    const alive = new Set<string>()

    for (const snap of snapshots) {
      alive.add(snap.id)
      let record = this.trams.get(snap.id)
      if (!record) {
        record = this.createTramEntity(snap)
        this.trams.set(snap.id, record)
      }

      const position = Cartesian3.fromDegrees(snap.lon, snap.lat, TRAM_HALF_HEIGHT + 0.4)
      record.position.setValue(position)
      const hpr = new HeadingPitchRoll(CesiumMath.toRadians(snap.bearing - 90), 0, 0)
      record.orientation.setValue(Transforms.headingPitchRollQuaternion(position, hpr))
      record.entity.show = visibleLines.has(snap.lineId)
    }

    for (const [id, record] of this.trams) {
      if (!alive.has(id)) {
        this.viewer.entities.remove(record.entity)
        this.trams.delete(id)
      }
    }
  }

  private createTramEntity(snap: TramSnapshot): TramEntityRecord {
    const color = Color.fromCssColorString(snap.color)
    const position = new ConstantPositionProperty(
      Cartesian3.fromDegrees(snap.lon, snap.lat, TRAM_HALF_HEIGHT + 0.4),
    )
    const orientation = new ConstantProperty(
      Transforms.headingPitchRollQuaternion(
        Cartesian3.fromDegrees(snap.lon, snap.lat, TRAM_HALF_HEIGHT + 0.4),
        new HeadingPitchRoll(CesiumMath.toRadians(snap.bearing - 90), 0, 0),
      ),
    )

    const entity = this.viewer.entities.add({
      id: `tram:${snap.id}`,
      position,
      orientation,
      box: {
        dimensions: new Cartesian3(config.tram.length, config.tram.width, config.tram.height),
        material: color,
        outline: true,
        outlineColor: Color.fromCssColorString('#0f172a').withAlpha(0.9),
        heightReference: HeightReference.RELATIVE_TO_GROUND,
      },
      label: {
        text: snap.lineId,
        font: 'bold 14px "Inter Variable", system-ui, sans-serif',
        fillColor: Color.WHITE,
        outlineColor: Color.fromCssColorString(snap.color),
        outlineWidth: 4,
        style: LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cartesian2(0, -28),
        distanceDisplayCondition: new DistanceDisplayCondition(0, 12000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })

    return { entity, position, orientation, color }
  }

  setSelected(tramId: string | null): void {
    if (this.selectedId) {
      const prev = this.trams.get(this.selectedId)
      if (prev?.entity.box) {
        prev.entity.box.outlineColor = new ConstantProperty(
          Color.fromCssColorString('#0f172a').withAlpha(0.9),
        )
      }
    }
    this.selectedId = tramId
    if (tramId) {
      const record = this.trams.get(tramId)
      if (record?.entity.box) {
        record.entity.box.outlineColor = new ConstantProperty(Color.WHITE)
      }
    }
  }

  /** Kamera an eine Straßenbahn heften (null = lösen). */
  setFollow(tramId: string | null): void {
    if (!tramId) {
      this.viewer.trackedEntity = undefined
      return
    }
    const record = this.trams.get(tramId)
    this.viewer.trackedEntity = record?.entity
  }

  hasTram(tramId: string): boolean {
    return this.trams.has(tramId)
  }

  destroy(): void {
    this.destroyed = true
    this.handler.destroy()
    this.viewer.destroy()
  }
}
