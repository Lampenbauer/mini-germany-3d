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
  CustomShader,
  DistanceDisplayCondition,
  type Entity,
  GeometryInstance,
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
  PrimitiveCollection,
  ShadowMode,
  Transforms,
  UniformType,
  VertexFormat,
  type Viewer,
} from 'cesium'
import { config } from '@/config'
import { FRAMING_SCALE } from './camera-fov'
import { cameraFramingScale } from './CameraLens'
import { FollowCamera } from '@/map/FollowCamera'
import type { VehicleSnapshot } from '@/engine/simulation'
import { tunnelOpacity } from './tunnel-view'
import { rectCoversBox, type ScreenRect } from './screen-rects'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'

/**
 * A rendered line badge, shared by every vehicle of that line (and delay).
 *
 * `image` is the badge as a data URL rather than the canvas it was drawn
 * on, and that is the whole point: Cesium keys a billboard's image in the
 * texture atlas by the URL when it gets one, but a canvas gets a fresh
 * GUID per billboard, and a texture atlas never gives a region back. With
 * canvases every vehicle that ever started a trip left its own copy of
 * the badge in the atlas – measured 2026-09-05 in Berlin at 60× speed:
 * one atlas image per trip, the atlas texture growing from 2048² to
 * 4096² in two minutes and on towards the 16384² the GPU allows. Keyed
 * by URL, a line's badge is in the atlas once.
 */
interface LineBadge {
  image: string
  width: number
  height: number
}

/** The badge floats this many CSS pixels above the vehicle (negative = up). */
const BADGE_PIXEL_OFFSET_Y = -30
/** The badge's extent on screen for the picture test: half its width and its height in CSS px. */
const BADGE_HALF_WIDTH_PX = 14
const BADGE_HEIGHT_PX = 22

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
  /** Screen rectangles the badges keep clear of (the webcam pictures). */
  obstacles?: () => readonly ScreenRect[]
  /** Window position of a world point (CSS px), undefined behind the camera. */
  windowPosition?: (position: Cartesian3) => Cartesian2 | undefined
}

interface VehicleRecord {
  /**
   * Everything of the vehicle that is a primitive – body, wagons, glow
   * pool – in one collection of its own on the scene. Its `show` is the
   * body cutoff: Cesium's PrimitiveCollection.update returns before
   * touching its children when it is hidden, whereas a hidden Model runs
   * its whole per-frame update (scene graph, environment map, draw
   * command build) and only skips the final submit. With Berlin's ~3000
   * wagons that difference was 3.6 ms of every frame for vehicles too far
   * to draw (measured 2026-09-05). Removing the collection destroys its
   * children, as removing them one by one did.
   */
  group: PrimitiveCollection
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
  /** Body is a glTF consist (see VEHICLE_CONSISTS) instead of a colored box. */
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
  /** Uniform model scale (VEHICLE_CONSISTS[…].scale). 0 for box bodies. */
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
  /**
   * Position as of the frame that was last RENDERED (not the last tick):
   * the reference the on-screen motion is measured against, so that slow
   * movement accumulates over several ticks instead of being compared
   * tick to tick and never reaching the threshold (see screen-motion.ts).
   * Kept lazily: renderedStamp records which render it belongs to, and
   * sync() refreshes it the first tick after a newer frame was drawn.
   */
  renderedPosition: Cartesian3
  renderedStamp: number
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
 * The three camera distances (in meters) a drawn vehicle passes through,
 * innermost first. The ship layer carries the same three – see
 * VESSEL_BODY_VISIBLE_RANGE / NAME_VISIBLE_RANGE / VESSEL_RENDER_RANGE,
 * set much wider there because a 200 m freighter stays readable where a
 * 30 m tram is long gone.
 *
 * BODY: up to here the 3D body is drawn. Beyond it the box is sub-pixel
 * noise while the label still reads fine.
 *
 * LABEL: how far the line badge stays up, applied by its own
 * DistanceDisplayCondition. Past the body range the label alone carries
 * the vehicle.
 *
 * RENDER: how far the layer cares at all. It holds the 30 fps render
 * pacing (anyVehicleInView) and gates the fallback tile-height sampling;
 * without it a camera dozens of kilometers away still "sees" the whole
 * fleet as soon as it faces the network.
 *
 * They need not be ordered, but crossing them has a price: past RENDER a
 * vehicle stops holding the render loop at its animation rate, so a label
 * still drawn out there follows in the loop's slow heartbeat steps unless
 * something nearer keeps the frames coming.
 *
 * All three say "from here on it is too small to be worth it", which is a
 * statement about the frame rather than about meters – so they follow the
 * field of view (see camera-fov.ts). A narrower angle needs a camera that
 * stands further back, and these ranges keep the same tram the same size
 * on screen when it does.
 *
 * BODY and RENDER are per-tick comparisons and follow the lens the camera
 * actually wears (cameraFramingScale); LABEL is baked into a
 * DistanceDisplayCondition and stays pinned to the narrower angle (see
 * FRAMING_SCALE). The body range used to be pinned too, which through the
 * plain 60° lens drew every body out to 7.7 km – three pixels of wagon –
 * and had Berlin's morning fleet cost 13 ms of every frame in Model
 * updates alone (measured 2026-09-05).
 */
const VEHICLE_BODY_VISIBLE_RANGE_AT_REFERENCE = 3_500
const VEHICLE_LABEL_VISIBLE_RANGE = 35_000 * FRAMING_SCALE
/**
 * Beyond this camera distance nothing of a vehicle is drawn and it does
 * not count as in view – measured at the reference lens and scaled per
 * tick by the lens the camera wears (cameraFramingScale): through the
 * miniature lens the same ground lies further out. Not pinned like the
 * display conditions above, because it is a comparison, not a baked
 * primitive property.
 */
const VEHICLE_RENDER_RANGE_AT_REFERENCE = 20_000

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
 * glTF vehicle consists, generated by scripts/build-vehicle-models.mjs
 * (procedural low-poly meshes dimensioned after the real fleets;
 * regenerate with `npm run models:build`), keyed by the consist id a
 * line carries (network.json `model`, resolved from the city's fleet by
 * prepareNetwork). Lines without one keep the colored box. Everything is
 * in real meters (scale 1), so a consist's wagon lengths plus gaps add up
 * to the line's configured vehicle length:
 *
 *   tram-6n2         Vossloh 6N2 – five sections, cab / panto / mid / mid / cab
 *   sbahn-talent2    Talent 2 – cab car / pantograph middle car / cab car
 *   ubahn-h          Berlin U-Bahn BR H – six third-rail sections, 79.5 m
 *   sbahn-481        Berlin S-Bahn BR 481 half train – the same six sections
 *   ubahn-dt5        Hamburg U-Bahn DT5 double unit – the same six sections, 79.5 m
 *   sbahn-490        Hamburg S-Bahn ET 490 unit – five of those sections, 66 m
 *   ubahn-c2         Munich U-Bahn C2 – nine of those sections, 119 m
 *   sbahn-423        Munich/Cologne S-Bahn ET 423 full train – two five-section units, 133 m
 *   tram-avenio      Munich Avenio – the 6N2's sections with one more middle, 38 m
 *   stadtbahn-k4000  Cologne Stadtbahn K4000/K5000 double unit – two four-section trams, 51 m
 *   stadtbahn-dt8    Stuttgart Stadtbahn DT8 pair – six third-rail sections, 79.5 m
 *   bus-12m          12 m rigid city bus
 *   ferry-warnow-fg  Gehlsdorf passenger ferry (19.9 m double-ender)
 *   ferry-warnow-fw  Breitling car ferry (39 m double-ender)
 *   ferry-hadag      HADAG harbour ferry (Typ 2000, 29.9 m double-ender) – the Breitling hull at 0.77
 *
 * baseLift is half the overall height (origin sits mid-height, the same
 * halfHeight semantics the boxes had). The models are tinted in the line
 * color (see applyVehicleAppearance).
 */
export const VEHICLE_CONSISTS: Record<string, VehicleModelSpec> = {
  'tram-6n2': {
    scale: 1,
    baseLift: 1.8,
    gap: 0.12,
    wagons: [
      { uri: 'models/tram-end.glb', length: 6.55 },
      { uri: 'models/tram-mid-panto.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      // Own mesh, not the front car flipped: the 180° turn would put
      // the door on the left of the car, and the 6N2 boards right-only.
      { uri: 'models/tram-end-rear.glb', length: 6.55, flipped: true },
    ],
  },
  'sbahn-talent2': {
    scale: 1,
    baseLift: 2.15,
    gap: 0.25,
    wagons: [
      { uri: 'models/sbahn-end.glb', length: 18.6 },
      { uri: 'models/sbahn-mid-panto.glb', length: 18.9 },
      { uri: 'models/sbahn-end.glb', length: 18.6, flipped: true },
    ],
  },
  // Berlin's third-rail trains share one 13 m section: cab / four
  // middle sections / cab, 0.3 m gaps – the BR H is 98 m over six
  // longer cars, the S-Bahn half train 74 m; both sit within a few
  // meters of the same silhouette.
  'ubahn-h': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  'sbahn-481': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  // Hamburg's third-rail trains use the same 13 m section. A DT5 is a
  // 39.6 m three-section unit that runs in pairs all day (79 m); an
  // ET 490 a 66 m three-car unit – five sections come to 66.2 m.
  'ubahn-dt5': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  'sbahn-490': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
   // Munich's U-Bahn runs six-car trains of 115 m (the C2, or three A/B
  // double units): nine of the 13 m third-rail sections come to 119 m.
  'ubahn-c2': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  // The ET 423 of the Munich and Cologne S-Bahn is a 67 m four-car unit
  // that runs in pairs through the day (a "Vollzug", 135 m): two of the
  // ET 490's five-section units, cab to cab.
  'sbahn-423': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  // Munich's trams (Avenio T, R3.3) are 37 m four-section cars: the
  // 6N2's sections with one middle section more, 38 m.
  'tram-avenio': {
    scale: 1,
    baseLift: 1.8,
    gap: 0.12,
    wagons: [
      { uri: 'models/tram-end.glb', length: 6.55 },
      { uri: 'models/tram-mid-panto.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-end-rear.glb', length: 6.55, flipped: true },
    ],
  },
  // Cologne's Stadtbahn cars (K4000/K4500 low-floor, K5000/K5200 high-floor)
  // are 28 m two-section units coupled in pairs, 57 m: two four-section
  // trams of the 6N2's sections, cab to cab, 51 m.
  'stadtbahn-k4000': {
    scale: 1,
    baseLift: 1.8,
    gap: 0.12,
    wagons: [
      { uri: 'models/tram-end.glb', length: 6.55 },
      { uri: 'models/tram-mid-panto.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-end-rear.glb', length: 6.55, flipped: true },
      { uri: 'models/tram-end.glb', length: 6.55 },
      { uri: 'models/tram-mid-panto.glb', length: 6.1 },
      { uri: 'models/tram-mid.glb', length: 6.1 },
      { uri: 'models/tram-end-rear.glb', length: 6.55, flipped: true },
    ],
  },
  // Stuttgart's Stadtbahn runs its DT8 units in pairs at peak (2 × 39 m):
  // the same six 13 m sections as Hamburg's DT5 double unit, four cabs and
  // two middles, 79.5 m. They take the current from an overhead wire
  // rather than a third rail, which is a detail of the roof – and a roof
  // is a few pixels from the height this map is looked at. Cologne's and
  // Hannover's shorter Stadtbahn trains use the tram sections instead
  // (stadtbahn-k4000), where the pantograph does show at street level.
  'stadtbahn-dt8': {
    scale: 1,
    baseLift: 1.7,
    gap: 0.3,
    wagons: [
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
      { uri: 'models/ubahn-end.glb', length: 13 },
      { uri: 'models/ubahn-mid.glb', length: 13 },
      { uri: 'models/ubahn-end.glb', length: 13, flipped: true },
    ],
  },
  'bus-12m': {
    scale: 1,
    baseLift: 1.55,
    gap: 0,
    wagons: [{ uri: 'models/bus.glb', length: 12 }],
  },
  // The ferries are double-ended like the real ships – the 180° turn on
  // the return leg is exactly what the real double-enders do (house on
  // the other side), not a vehicle sailing backwards. baseLift is half
  // the height plus FERRY_FLOAT_LIFT.
  'ferry-warnow-fw': {
    scale: 1,
    baseLift: 3 + 1.1,
    gap: 0,
    wagons: [{ uri: 'models/ferry-fw.glb', length: 39 }],
  },
  'ferry-warnow-fg': {
    scale: 1,
    baseLift: 1.75 + 1.1,
    gap: 0,
    wagons: [{ uri: 'models/ferry-fg.glb', length: 19.9 }],
  },
  // HADAG's Typ 2000 harbour ferries (29.9 × 8.2 m) are double-enders of
  // the Breitling ferry's proportions: her hull at 0.77 is 30 m by 8.5 m.
  'ferry-hadag': {
    scale: 0.77,
    baseLift: 3 + 1.1 / 0.77,
    gap: 0,
    wagons: [{ uri: 'models/ferry-fw.glb', length: 39 }],
  },
}

/**
 * Extra meters between the sampled water surface and the ferries' model
 * waterline, already folded into the ferry consists' baseLift above. The
 * Google mesh's water undulates (waves, wakes, reconstruction noise)
 * around the height sampled under the vessel, and a hull riding exactly
 * on the sample sits visibly sunk wherever the mesh crests – the same
 * reason the ferry ROUTES get their own extra lift in RoutesLayer.
 * Riding high reads as a shallow-draft vessel; riding low reads as
 * sinking, so the lift errs upward.
 */
export const FERRY_FLOAT_LIFT = 1.1

/** Model consist for a vehicle; undefined keeps the colored box. */
function modelSpecFor(snap: VehicleSnapshot): VehicleModelSpec | undefined {
  return snap.model ? VEHICLE_CONSISTS[snap.model] : undefined
}

/**
 * How strongly the line color covers the model's own livery (0–1).
 * Deliberately subtle: the real fleet is cream-white, and a vehicle
 * painted wall-to-wall in its line color is exactly the toy look the
 * models are meant to avoid – the line is identified by its badge and
 * route anyway. The tint leaves a hint of it on the body; selection adds
 * a white silhouette on top.
 */
const MODEL_TINT_AMOUNT = 0.25

// Scratches for the per-tick wagon pose composition.
const wagonTranslationScratch = new Cartesian3()
const wagonFlipMatrix = Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(Math.PI))

/**
 * Night-time window glow: the models' glazing lights up warm as the sun
 * goes down. One CustomShader shared by every wagon; it recognizes the
 * glazing by its darkness – the glass material is by far the darkest
 * surface (luminance 0.058; the next darkest, the bellows, sits at
 * 0.090) – and adds emissive light scaled by the night ramp. Detection
 * instead of per-material wiring keeps the GLBs plain PBR, and one
 * uniform write dims every window in the scene.
 */
const WINDOW_GLOW_COLOR = 'vec3(1.0, 0.83, 0.52)'
const WINDOW_GLOW_LUMINANCE_CUTOFF = '0.075'
const WINDOW_GLOW_MAX = 0.85

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

// Scratch objects for the per-tick hot path in syncVehicles: Cesium clones all
// values it retains (ConstantProperty, modelMatrix), so reusing these avoids
// ~2 allocations per tram per tick.
const positionScratch = new Cartesian3()

// Scratch for the per-tick glow pool pose (see syncVehicles).
const glowPositionScratch = new Cartesian3()

const hprScratch = new HeadingPitchRoll()

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
  private badgeCache = new Map<string, LineBadge>()
  private selectedId: string | null = null
  private followId: string | null = null
  private readonly followCamera: FollowCamera
  /** Until this time the approach flight runs and lookAt stays disengaged. */
  /**
   * Chase mode: the camera stays exactly behind the vehicle (heading
   * follows the travel bearing) until the user moves the camera by hand –
   * from then on manual orbit/zoom is adopted as before.
   */
  private frameCounter = 0
  private frustumSphere = new BoundingSphere()
  /**
   * Counts rendered frames (see markRendered). A record whose
   * renderedStamp lags behind it was drawn since its last tick, so the
   * position of that tick is what is on screen now.
   */
  private renderStamp = 0
  /** Lights the models' glazing at night (see WINDOW_GLOW_COLOR). */
  private readonly windowGlowShader = new CustomShader({
    uniforms: { u_windowGlow: { type: UniformType.FLOAT, value: 0 } },
    fragmentShaderText: `
      void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material)
      {
        float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
        if (luminance < ${WINDOW_GLOW_LUMINANCE_CUTOFF})
        {
          material.emissive += ${WINDOW_GLOW_COLOR} * u_windowGlow;
        }
      }
    `,
  })

  /** Radial gradient sprite of the glow pools (null: no 2D canvas). */
  private glowSpriteCanvas?: HTMLCanvasElement | null
  /** Material/appearance shared by ALL pools – one uniform sets the alpha. */
  private glowMaterial: Material | null = null
  private glowAppearance: MaterialAppearance | null = null

  /** Underground view (see setUnderground). */
  private underground = false

  /** Running line focus (see startLineFocus), null = none. */
  private lineFocus: { lineId: string; until: number } | null = null

  /** Vehicle number labels (see setLabelsVisible). */
  private labelsVisible = true

  constructor(
    private readonly viewer: Viewer,
    private readonly host: VehicleLayerHost,
  ) {
    this.followCamera = new FollowCamera(viewer, host)
  }

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

  /**
   * Vehicle numbers off – the vehicles' half of the Labels layer toggle.
   * sync() folds the flag into every label's show, but that runs at the
   * tick rate; hiding is applied here as well so the switch acts at once
   * (turning them back on, the next tick decides which ones qualify).
   */
  setLabelsVisible(visible: boolean): void {
    if (visible === this.labelsVisible) return
    this.labelsVisible = visible
    if (!visible) {
      for (const record of this.vehicles.values()) record.labelEntity.show = false
    }
    this.host.requestRender()
  }

  /** Id of the vehicle the camera is chasing, null when free. */
  get followedId(): string | null {
    return this.followId
  }

  /**
   * The map drew a frame: from here on, motion is measured against the
   * poses of the tick before this call (see VehicleRecord.renderedPosition).
   * O(1) – the records catch up lazily on their next tick.
   */
  markRendered(): void {
    this.renderStamp++
  }

  /**
   * Takes every vehicle off the map (the map is moving on to another
   * city): the chase and the selection let go first, then one sync with
   * nothing alive removes the bodies, badges and pools.
   */
  clear(): void {
    this.setFollow(null)
    this.setSelected(null)
    this.lineFocus = null
    this.sync([], new Set())
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
    this.windowGlowShader.setUniform('u_windowGlow', WINDOW_GLOW_MAX * night)
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
  ): {
    anyVehicleInView: boolean
    nearestBodyMeters: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
    // One collectionChanged event for the whole tick instead of one per
    // vehicle: every labelPosition.setValue below raised the entity's
    // definitionChanged, the collection copied its three change lists and
    // ran all visualizers' listeners on it – 18 000 times a second in
    // Berlin's morning rush (measured 2026-09-05). Suspended, the
    // collection folds them into one event on resume.
    const entities = this.viewer.entities
    entities.suspendEvents()
    try {
      return this.syncBatched(snapshots, visibleLines)
    } finally {
      entities.resumeEvents()
    }
  }

  private syncBatched(
    snapshots: VehicleSnapshot[],
    visibleLines: ReadonlySet<string>,
  ): {
    anyVehicleInView: boolean
    nearestBodyMeters: number
    maxScreenMotionPx: number
    maxTickMotionPx: number
  } {
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
    /**
     * Distance to the closest drawn vehicle BODY – not the same as
     * anyVehicleInView, which reaches out to the render range. The map's
     * shadow gate keys on it: with nothing near enough to cast, an
     * enabled shadow map still makes every fragment of the full-screen
     * tileset sample four cascade textures for nothing.
     */
    let nearestBodyMeters = Number.POSITIVE_INFINITY
    // Resolved once per tick: while a "zoom to line" focus runs, the other
    // lines' badges step aside (see startLineFocus).
    const focusedLine = this.focusedLine()
    const framingScale = cameraFramingScale(camera)
    const renderRange = VEHICLE_RENDER_RANGE_AT_REFERENCE * framingScale
    const bodyRange = VEHICLE_BODY_VISIBLE_RANGE_AT_REFERENCE * framingScale
    // Webcam pictures on screen – a badge that would sit on one steps aside
    const obstacles = this.host.obstacles?.() ?? []
    // On-screen motion since the last rendered frame (see screen-motion.ts):
    // the largest of any vehicle in view is what the app paces its ticks
    // by, and a vehicle past the threshold asks for a frame itself.
    const pxPerMeterAtUnit = cssPixelsPerMeterAtUnitDistance(this.viewer)
    const motionThreshold = motionThresholdCssPx(this.host.pixelRatio)
    let maxScreenMotionPx = 0
    // …and within this tick alone, for the app's speed estimate
    let maxTickMotionPx = 0

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
          billboard.image = new ConstantProperty(badge.image)
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
      let showLabel =
        this.labelsVisible && show && (focusedLine === null || focusedLine === snap.lineId)

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
      // render range (beyond that nothing of the vehicle is drawn). The
      // result drives the render pacing (anyVehicleInView) and whether the
      // fallback tile-height sampling below is worth doing at all.
      let inView = false
      const cameraDistance = Cartesian3.distance(camera.positionWC, position)
      if (show && cameraDistance < renderRange) {
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

      // A frame was drawn since this vehicle's last tick: the pose of that
      // tick is what is on screen, and the reference motion is measured
      // against from now on. Before lastPosition moves on below.
      if (record.renderedStamp !== this.renderStamp) {
        Cartesian3.clone(record.lastPosition, record.renderedPosition)
        record.renderedStamp = this.renderStamp
      }
      const tickMeters = Cartesian3.distance(position, record.lastPosition)
      if (tickMeters > 0.01) Cartesian3.clone(position, record.lastPosition)
      // Movement of an on-screen vehicle (sim tick, time jump, height
      // adjustment) must reach the screen – once it amounts to something
      // the screen can show. Far out, a tram advances a fortieth of a
      // pixel per tick, and drawing that every tick pinned the loop at
      // 30 fps for nothing visible; the motion accumulates against the
      // rendered pose and the frame comes when it adds up.
      if (inView) {
        const pxPerMeter = pxPerMeterAtUnit / Math.max(1, cameraDistance)
        const movedMeters = Cartesian3.distance(position, record.renderedPosition)
        const motionPx = movedMeters > 0 ? movedMeters * pxPerMeter : 0
        const tickPx = tickMeters > 0 ? tickMeters * pxPerMeter : 0
        if (motionPx > maxScreenMotionPx) maxScreenMotionPx = motionPx
        if (tickPx > maxTickMotionPx) maxTickMotionPx = tickPx
        if (motionPx >= motionThreshold) this.host.requestRender()
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
      // vehicle out to VEHICLE_LABEL_VISIBLE_RANGE. (Checked here on the
      // CPU – a DistanceDisplayCondition attribute on the Primitive
      // measures from the instance matrix, which is identity for these
      // boxes since the position lives in the primitive's own modelMatrix.)
      const showBody = show && cameraDistance < bodyRange
      // A vehicle under the street is lit by nothing and casts nothing.
      // It is still DRAWN – ghosted, so the route stays followable – so
      // without this it threw a sunlit shadow onto the road above it.
      const castsShadow = showBody && !record.inTunnel
      if (castsShadow && cameraDistance < nearestBodyMeters) nearestBodyMeters = cameraDistance
      let visibilityChanged = false
      // The whole group at once – body, wagons and pool – so a hidden
      // vehicle's primitives are not even updated (see VehicleRecord.group).
      if (record.group.show !== showBody) {
        record.group.show = showBody
        visibilityChanged = true
      }
      const wagonShadows = castsShadow ? ShadowMode.CAST_ONLY : ShadowMode.DISABLED
      for (const model of record.models) {
        if (model && model.shadows !== wagonShadows) model.shadows = wagonShadows
      }
      if (showLabel && obstacles.length > 0) {
        const window = this.host.windowPosition?.(position)
        if (
          window &&
          rectCoversBox(
            obstacles,
            window.x,
            window.y + BADGE_PIXEL_OFFSET_Y + BADGE_HEIGHT_PX / 2,
            BADGE_HALF_WIDTH_PX,
            BADGE_HEIGHT_PX,
          )
        ) {
          showLabel = false
        }
      }
      if (record.labelEntity.show !== showLabel) {
        record.labelEntity.show = showLabel
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
        // The group takes body, wagons and pool with it. Wagons may still
        // be loading (attachWagon then destroys the late arrivals itself).
        this.viewer.scene.primitives.remove(record.group)
        this.vehicles.delete(id)
        this.host.requestRender()
      }
    }

    return { anyVehicleInView, nearestBodyMeters, maxScreenMotionPx, maxTickMotionPx }
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
  private lineBadge(lineId: string, color: Color, delaySuffix = ''): LineBadge | undefined {
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
    ctx.fillStyle = 'oklch(1 0 0)'
    ctx.fillText(lineId, textX, textY)
    if (delaySuffix) {
      ctx.font = suffixFont
      ctx.fillStyle = 'oklch(1 0 0 / 0.88)'
      ctx.fillText(delaySuffix, textX + textWidth + suffixGap, textY)
    }

    const entry: LineBadge = {
      image: canvas.toDataURL('image/png'),
      width: width / ratio,
      height: height / ratio,
    }
    this.badgeCache.set(cacheKey, entry)
    return entry
  }

  private createVehicleEntity(snap: VehicleSnapshot): VehicleRecord {
    const color = Color.fromCssColorString(snap.color)
    const modelSpec = modelSpecFor(snap)
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
    // All of this vehicle's primitives live in here (see VehicleRecord.group)
    const group = new PrimitiveCollection({ destroyPrimitives: true })
    this.viewer.scene.primitives.add(group)
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
      group.add(primitive)
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
              image: badge.image,
              width: badge.width,
              height: badge.height,
              color: Color.WHITE.withAlpha(alpha),
              pixelOffset: new Cartesian2(0, BADGE_PIXEL_OFFSET_Y),
              distanceDisplayCondition: new DistanceDisplayCondition(0, VEHICLE_LABEL_VISIBLE_RANGE),
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
              pixelOffset: new Cartesian2(0, BADGE_PIXEL_OFFSET_Y),
              distanceDisplayCondition: new DistanceDisplayCondition(0, VEHICLE_LABEL_VISIBLE_RANGE),
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
    // The pool renders interior light spilling onto the ROAD – under a
    // vessel it would paint a lit disc onto open water, so ferries go
    // without one (their lit windows still mark them at night).
    const glowAppearance = snap.mode === 'ferry' ? null : this.glowPoolAppearance()
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
      group.add(glow)
      glowMatrix = glow.modelMatrix
    }

    const record: VehicleRecord = {
      group,
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
      renderedPosition: Cartesian3.clone(initialPosition),
      renderedStamp: this.renderStamp,
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
        // Casts onto the tiles, receives nothing: the tileset does not
        // cast, so a vehicle "in a building's shadow" would be lit
        // anyway – and self-shadowing a 500-triangle hull buys nothing
        // but acne on its own flanks. Kept in step with wagonShadows
        // above, which reassigns this every tick.
        shadows: ShadowMode.CAST_ONLY,
      })
    } catch (error) {
      console.warn('[MiniGermany3D] Vehicle model failed to load:', error)
      return
    }
    // The trip may have ended (or the viewer been torn down) during the load
    if (this.viewer.isDestroyed() || this.vehicles.get(vehicleId) !== record) {
      model.destroy()
      return
    }
    model.colorBlendMode = ColorBlendMode.MIX
    model.colorBlendAmount = MODEL_TINT_AMOUNT
    model.customShader = this.windowGlowShader
    record.group.add(model)
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
   * "Zoom to line": for these few seconds only that line's badges stay up.
   * The other routes fade out for the attention pulse (see RoutesLayer),
   * and their vehicle labels would otherwise keep covering the very route
   * the pulse is pointing at. Bodies are untouched – at the distance the
   * flight ends they are past their draw range anyway.
   */
  startLineFocus(lineId: string, durationMs: number): void {
    this.lineFocus = { lineId, until: performance.now() + durationMs }
    this.host.requestRender()
  }

  /**
   * Line id whose badges are alone on stage right now, null when no focus
   * runs. Clears an expired focus – sync() calls this per tick, so the
   * other labels come back within a tick of the pulse ending.
   */
  private focusedLine(): string | null {
    const focus = this.lineFocus
    if (!focus) return null
    if (performance.now() >= focus.until) {
      this.lineFocus = null
      return null
    }
    return focus.lineId
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
  /** Chase leash follows the lens (see CesiumMap.applyLensDistance). */
  applyLensDistance(factor: number): boolean {
    return this.followCamera.applyLensDistance(factor)
  }

  setFollow(vehicleId: string | null): void {
    this.followId = vehicleId
    if (!vehicleId) {
      this.followCamera.release()
      return
    }
    // The approach flight starts from where the vehicle stands now; a
    // vehicle that is not on the map yet (shared link, still loading) is
    // picked up by the first sync instead.
    const record = this.vehicles.get(vehicleId)
    if (!record) {
      this.followCamera.engage(null)
      return
    }
    const carto = Cartographic.fromCartesian(record.lastPosition)
    this.followCamera.engage({
      lon: CesiumMath.toDegrees(carto.longitude),
      lat: CesiumMath.toDegrees(carto.latitude),
      centerHeight: record.groundHeight + record.halfHeight * 2 + 2,
      bearingDeg: record.bearing,
    })
  }

  /** Per-tick chase for the followed vehicle (see FollowCamera). */
  private updateFollowCamera(lon: number, lat: number): void {
    // Ground height is already sampled on the 3D tiles and smoothed in
    // syncVehicles, so the camera centers on the vehicle's actual roof.
    const record = this.followId ? this.vehicles.get(this.followId) : undefined
    const groundHeight = record?.groundHeight ?? this.host.defaultGroundHeight
    const vehicleHeight = (record?.halfHeight ?? config.vehicles.tram.height / 2) * 2
    this.followCamera.update({
      lon,
      lat,
      centerHeight: groundHeight + vehicleHeight + 2,
      bearingDeg: record?.bearing ?? 0,
    })
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
