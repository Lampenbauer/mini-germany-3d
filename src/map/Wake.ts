/**
 * The wake of a ship under way, as an aerial photograph shows one: the
 * propeller's wash – a narrow, bright, streaky band straight behind the
 * stern that widens and fades – the two thin Kelvin arms spreading from
 * the bow at their fixed angle, and the bow wave itself, a white
 * moustache along the forward flanks of the hull. One instanced draw
 * command per fleet; every instance is one segment of a ribbon.
 *
 * Built like the funnel smoke (FunnelSmoke.ts) and for the same reason
 * not with a particle system: this map renders only when something on
 * screen moves, so an effect has to be right in any frame by itself.
 * The wake is placed from the ship's own past. For every age up to
 * WAKE_LIFE_S the layer asks where the ship was that many seconds ago –
 * the AIS track for a real ship, the timetable for a scheduled ferry –
 * and the trailing end of her hull at that moment is where the wash of
 * that age lies. So a turning ship leaves a curved wake, a ship that
 * stops leaves hers behind to fade, and a ship going astern – her
 * course over the ground against her heading – washes at the bow: the
 * trailing end is whichever end the motion leaves behind, and the bow
 * wave and the arms belong to the end that leads. How bright the wash
 * starts follows the speed at the moment it was made, so a ship that
 * slowed shows it in her wake.
 *
 * The ribbons lie flat in the water's tangent plane, sized in metres,
 * so a wake reads right from above and from a chase camera alike. They
 * sit on the ship's own water level (the height her hull is clamped to)
 * with a small lift, and the depth they are tested with is taken a
 * little nearer the eye than they are (WAKE_DEPTH_BIAS): Google's water
 * is a mesh of baked waves, and a ribbon laid on it would sink into
 * every crest; with the bias the foam stays over the water it lies on
 * and still goes behind a quay or a hull in front of it. Polygon offset
 * cannot do this here – the logarithmic depth buffer writes the depth
 * from the fragment shader, which polygon offset does not touch.
 *
 * The foam's streaks come from a small value noise in the fragment
 * shader, long along the ribbon and fine across it, seeded per ship –
 * and the foam lies in the WATER, not on the ship: every point of a
 * ribbon carries the moment its foam was made (the ships' clock less
 * the pose's age, as a distance at WAKE_STREAK_MPS), so a streak stays
 * where it was laid while the ship runs on from it, and the bow wave's
 * foam streams aft along the flank. Until 2026-09-15 the pattern was
 * measured from the stern and rode along with the hull, which read as
 * painted on. On top of that the pattern churns: the noise has a third
 * axis the shader walks along with the ships' clock (u_churn, held by a
 * pause, no faster than PLUME_MAX_RATE under the time-lapse like the
 * smoke), so a patch of foam breaks up and re-forms where it lies and
 * the ribbon's edge frays and mends. Stateless still: any frame is right
 * by itself. The churn asks for frames the way the smoke does – once its
 * own motion since the frame last drawn (WAKE_CHURN_MPS) is a visible
 * step at the ship's distance – and a wake fading behind a stopped ship
 * asks for one now and then besides (WAKE_FADE_FRAME_S). Lit like the
 * clouds and the smoke. Off in the mobile profile (RenderProfile.shipEffects).
 */

import {
  BlendingState,
  BoundingSphere,
  Cartesian3,
  ComponentDatatype,
  DepthFunction,
  Matrix4,
  PrimitiveType,
} from 'cesium'
import { renderer, type Buffer, type DrawCommand, type FrameState } from './cesium-renderer'
import { cloudLight } from './CloudLayer'
import { PLUME_MAX_RATE } from './FunnelSmoke'

/** How long the wash lasts, and how far apart the ship's poses are read, in seconds. */
export const WAKE_LIFE_S = 40
export const WAKE_STEP_S = 2
/** Speed over the ground below which a ship leaves no wake, and the speed of a full one, in m/s. */
export const WAKE_MIN_SPEED_MPS = 0.5
export const WAKE_FULL_SPEED_MPS = 5
/** Beyond this camera distance no wake is drawn. */
export const WAKE_MAX_DISTANCE_M = 4000
/** A wake behind a ship that stopped fades; a frame this often shows it going. */
export const WAKE_FADE_FRAME_S = 1
/**
 * The nominal speed the foam pattern is laid at: a second of the ships'
 * clock is this many metres of pattern along the wake, so the streaks
 * keep their length in the water whatever the ship's own speed.
 */
export const WAKE_STREAK_MPS = 4
/** How fast the churning foam moves on screen, for the frame rule – like the smoke's PLUME_MOTION_MPS. */
export const WAKE_CHURN_MPS = 2
/** The Kelvin angle: the arms spread this much to either side per metre behind the bow. */
export const KELVIN_SPREAD = Math.tan((19.47 * Math.PI) / 180)
/** Metres the foam floats over the water level it is given, and more with distance for the coarse far tiles. */
const WAKE_LIFT_M = 0.5
const WAKE_LIFT_PER_METER = 0.001
/** Fraction of the eye distance the depth is taken nearer than the ribbon (see the header). */
const WAKE_DEPTH_BIAS = 0.003
/** The wash's opacity fresh at full speed; the bow wave's; the arms'. */
const WASH_OPACITY = 0.62
const BOW_OPACITY = 0.8
const ARM_OPACITY = 0.22
/** The wash's half-width in beams, fresh and at the end of its life. */
const WASH_HALF_WIDTH_FRESH = 0.45
const WASH_HALF_WIDTH_OLD = 1.6
/** How much of the sky's and the sun's light the foam wears. */
const WAKE_AMBIENT = 0.9
const WAKE_SUNLIT = 0.9
/** Movement between two samples below which the ship stood still. */
const STILL_M = 0.2

/**
 * Per-instance layout, one ribbon segment: its two ends as high and low
 * floats (12), the unit vector across the ribbon at each end (6), the
 * half-width and opacity at each end (4), the foam pattern's phase at
 * each end (2) and the seed (1).
 */
const FLOATS_PER_INSTANCE = 25
const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4
const P0_OFFSET = 0
const P1_OFFSET = 6
const PERP0_OFFSET = 12
const PERP1_OFFSET = 15
const PROFILE_OFFSET = 18
const PHASE_OFFSET = 22
const SEED_OFFSET = 24
const INITIAL_CAPACITY = 2048
/** Margin on the bounding sphere for the ribbons' width. */
const BOUNDS_MARGIN_M = 100
const METERS_PER_DEGREE_LATITUDE = 111_132
const METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR = 111_320

const ATTRIBUTE_LOCATIONS = {
  a_corner: 0,
  a_p0High: 1,
  a_p0Low: 2,
  a_p1High: 3,
  a_p1Low: 4,
  a_perp0: 5,
  a_perp1: 6,
  a_profile: 7,
  a_phase: 8,
  a_seed: 9,
}

/*
 * One segment of a ribbon: a quad between its two ends, laid across by
 * the unit vector each end carries (the average of its neighbours'
 * directions, so a bend joins without a step), as wide as the segment's
 * profile says at either end. The ends go through the relative-to-eye
 * transform as high and low floats, like the stop discs; the depth is
 * written from a point pulled toward the eye (see the header).
 */
const VERTEX_SHADER = /* glsl */ `
in vec2 a_corner;
in vec3 a_p0High;
in vec3 a_p0Low;
in vec3 a_p1High;
in vec3 a_p1Low;
in vec3 a_perp0;
in vec3 a_perp1;
in vec4 a_profile;
in vec2 a_phase;
in float a_seed;

uniform float u_maxDistance;
uniform float u_lift;
uniform float u_liftPerMeter;
uniform float u_depthBias;

out float v_across;
out float v_along;
out float v_alpha;
out float v_seed;

void main()
{
    vec4 p0EC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_p0High, a_p0Low);
    vec4 p1EC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_p1High, a_p1Low);
    float s = a_corner.x;
    float t = a_corner.y;
    vec3 centerEC = mix(p0EC.xyz, p1EC.xyz, s);
    float distance = length(centerEC);
    float halfWidth = mix(a_profile.x, a_profile.y, s);
    float alpha = mix(a_profile.z, a_profile.w, s);
    bool drawn = max(a_profile.z, a_profile.w) > 0.0 && distance <= u_maxDistance;

    vec3 up = normalize(a_p0High + a_p0Low);
    vec3 acrossWC = normalize(mix(a_perp0, a_perp1, s));
    vec3 offsetWC = acrossWC * (halfWidth * t) + up * (u_lift + u_liftPerMeter * distance);
    vec3 positionEC = centerEC + czm_viewRotation * offsetWC;
    // A hidden instance collapses behind the far plane
    gl_Position = drawn ? czm_projection * vec4(positionEC, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
#ifdef LOG_DEPTH
    czm_vertexLogDepth(czm_projection * vec4(positionEC * (1.0 - u_depthBias), 1.0));
#endif
    v_across = t;
    v_along = mix(a_phase.x, a_phase.y, s);
    v_alpha = drawn ? alpha : 0.0;
    v_seed = a_seed;
}
`

/*
 * The foam: soft across the ribbon, and streaked along it by a value
 * noise that is stretched lengthwise – a wake is combed by its own
 * motion. Two octaves, seeded per ship so no two wakes share a pattern.
 * The noise is three-dimensional: the third axis is the churn clock, so
 * the pattern morphs in place with time, and the fine octave frays the
 * ribbon's edge. The lattice is periodic (NOISE_PERIOD cells) so the
 * hash never sees the large coordinates a long session grows.
 */
const FRAGMENT_SHADER = /* glsl */ `
in float v_across;
in float v_along;
in float v_alpha;
in float v_seed;

uniform vec3 u_color;
uniform float u_churn;

const float NOISE_PERIOD = 4096.0;

float hash(vec3 p)
{
    p = mod(p, NOISE_PERIOD);
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7)) + v_seed * 0.731) * 43758.5453123);
}

float noise(vec3 p)
{
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float x00 = mix(hash(i), hash(i + vec3(1.0, 0.0, 0.0)), f.x);
    float x10 = mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x);
    float x01 = mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x);
    float x11 = mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x);
    return mix(mix(x00, x10, f.y), mix(x01, x11, f.y), f.z);
}

void main()
{
    // Long along the wake, fine across it; the fine octave churns faster
    float coarse = noise(vec3(v_along * 0.09, v_across * 2.5, u_churn * 0.3));
    float fine = noise(vec3(v_along * 0.31, v_across * 6.0, u_churn * 0.7));
    float n = coarse * 0.65 + fine * 0.35;
    float foam = smoothstep(0.28, 0.8, n);
    // The edge frays with the fine foam
    float across = 1.0 - smoothstep(0.35, 1.0, abs(v_across) + (fine - 0.5) * 0.25);
    float alpha = across * v_alpha * (0.3 + 0.7 * foam);
    if (alpha <= 0.003)
    {
        discard;
    }
    out_FragColor = vec4(u_color, alpha);
}
`

/** Everything that needs the GL context – built on the first frame drawn, again when the fleet outgrows the buffer. */
interface WakeResources {
  command: DrawCommand
  /** The per-instance buffer, uploaded whole after a change; owned by the vertex array. */
  instances: Buffer
  capacity: number
}

/** A double as the two floats the relative-to-eye transform takes (see StopDiscs). */
function splitDouble(value: number): [high: number, low: number] {
  const magnitude = Math.floor(Math.abs(value) / 65536) * 65536
  return value >= 0 ? [magnitude, value - magnitude] : [-magnitude, value + magnitude]
}

/** The foam's colour for a sun height and an overcast grade: white in daylight, grey at dusk, dark at night. */
export function wakeColor(sunUp: number, overcast: number): Cartesian3 {
  const light = cloudLight(sunUp, overcast)
  return new Cartesian3(
    Math.min(1, light.ambient.x * WAKE_AMBIENT + light.sun.x * WAKE_SUNLIT),
    Math.min(1, light.ambient.y * WAKE_AMBIENT + light.sun.y * WAKE_SUNLIT),
    Math.min(1, light.ambient.z * WAKE_AMBIENT + light.sun.z * WAKE_SUNLIT),
  )
}

/** How much foam a speed over the ground makes, 0 = none. */
export function wakeIntensity(speedMps: number): number {
  if (!(speedMps >= WAKE_MIN_SPEED_MPS)) return 0
  const t = Math.min(1, (speedMps - WAKE_MIN_SPEED_MPS) / (WAKE_FULL_SPEED_MPS - WAKE_MIN_SPEED_MPS))
  return 0.35 + 0.65 * t * t * (3 - 2 * t)
}

/**
 * Where a ship was some seconds ago: her centre, and the way her hull
 * pointed – the heading where it is known, the course otherwise (a
 * double-ended ferry's is always her course).
 */
export interface WakeSample {
  ageS: number
  lon: number
  lat: number
  bearingDeg: number
}

export interface WakeHull {
  /** Overall length and beam of the hull as drawn, in metres. */
  lengthM: number
  beamM: number
  /** Ellipsoid height of the water she floats on. */
  surfaceHeight: number
  /** Gives the wake its own foam pattern. */
  seed: number
}

export interface WakeHost {
  /** Unit sun direction in the earth-fixed frame, null before the first scene time. */
  readonly sunDirection: Cartesian3 | null
  /** How overcast the tiles are graded, 0 … 1. */
  readonly overcast: number
}

/** A point of a ribbon: where, how wide, how bright, and where in the foam pattern (see phaseAt). */
interface RibbonPoint {
  position: Cartesian3
  halfWidth: number
  alpha: number
  phase: number
}

/** One of the ship's past poses, resolved on the water: her ends, the way she moved, how hard. */
interface Pose {
  ageS: number
  lat: number
  lon: number
  bearingRad: number
  /** Over the step into this pose; zero when she stood. */
  speedMps: number
  /** +1 when her bow trails (going astern), −1 when her stern does. */
  trailing: number
}

const upScratch = new Cartesian3()
const dirScratch = new Cartesian3()
const perpScratch = new Cartesian3()

export class Wake {
  /** The instance buffer as the shader reads it – exposed for the tests that pin the packing. */
  instances = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_INSTANCE)
  private count = 0
  private readonly anchors: Cartesian3[] = []
  private readonly boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0)
  private dirty = true
  private resources: WakeResources | null = null
  private unsupported = false
  private destroyed = false
  private readonly color = new Cartesian3(0.95, 0.97, 1)
  /** The ships' clock as of the last frame drawn – what a fading wake's frames are measured from. */
  private renderedMs = Number.NaN
  private clockMs = Number.NaN
  /** The ships' clock at the first tick: the foam pattern's phases are seconds from here (see phaseAt). */
  private epochMs = Number.NaN
  /** Seconds the foam has churned – the shader's clock (see begin). */
  private churnS = 0
  /** The churn as of the frame last drawn (see markRendered). */
  private renderedChurnS = 0
  private lastRealMs: number | null = null

  constructor(private readonly host: WakeHost) {}

  /** How many ribbon segments the next frame draws. */
  get drawn(): number {
    return this.count
  }

  /**
   * Starts a new set for the tick – the layer adds its ships' wakes, then
   * commits. `nowMs` is the ships' clock, the one the samples' ages are
   * measured on. The churn runs on it: by the time that passed, paused
   * with it, and no faster than PLUME_MAX_RATE times the real time – the
   * time-lapse must not flicker the foam; a clock jumped back leaves it
   * standing.
   */
  begin(nowMs: number, realNowMs = performance.now()): void {
    this.count = 0
    this.anchors.length = 0
    if (Number.isNaN(this.epochMs)) this.epochMs = nowMs
    if (!Number.isNaN(this.clockMs) && this.lastRealMs !== null) {
      const dt = (nowMs - this.clockMs) / 1000
      const realDt = Math.max(0, (realNowMs - this.lastRealMs) / 1000)
      // Either way: the rewind churns the foam back, under the same cap
      const step = Math.min(Math.abs(dt), realDt * PLUME_MAX_RATE)
      if (dt > 0) this.churnS += step
      else if (dt < 0) this.churnS -= step
    }
    this.clockMs = nowMs
    this.lastRealMs = realNowMs
  }

  /**
   * Where in the foam pattern a point lies: the moment its foam was made
   * – the ships' clock less the pose's age – as metres at the nominal
   * speed, so the same water keeps the same foam from tick to tick while
   * the ship runs on. `alongM` metres further back along the hull are
   * that much earlier (the bow wave's foam streams aft).
   */
  private phaseAt(ageS: number, alongM = 0): number {
    return ((this.clockMs - this.epochMs) / 1000 - ageS) * WAKE_STREAK_MPS - alongM
  }

  /**
   * One ship's wake from where she has been: `samples` in order of age,
   * the first her present pose, each WAKE_STEP_S older than the last;
   * a list that ends early ends the wake (nothing known before that).
   */
  add(samples: readonly WakeSample[], hull: WakeHull): void {
    if (samples.length < 2) return
    const poses = this.resolve(samples)
    if (poses.length === 0) return
    const halfLength = hull.lengthM / 2
    const now = poses[0]

    // The wash: from the trailing end at every age she was making way,
    // fresh and narrow at the hull, wide and faint at the end of its
    // life. A pose she stood in breaks the ribbon – a ship that stopped
    // keeps the wash she left, with a gap where she lay
    let wash: RibbonPoint[] = []
    for (const pose of poses) {
      if (pose.speedMps === 0) {
        this.addRibbon(wash, hull.seed)
        wash = []
        continue
      }
      const f = pose.ageS / WAKE_LIFE_S
      wash.push({
        position: this.onWater(pose, pose.trailing * halfLength, 0, hull.surfaceHeight),
        halfWidth: hull.beamM * (WASH_HALF_WIDTH_FRESH + (WASH_HALF_WIDTH_OLD - WASH_HALF_WIDTH_FRESH) * f),
        alpha: WASH_OPACITY * wakeIntensity(pose.speedMps) * Math.pow(1 - f, 1.5),
        phase: this.phaseAt(pose.ageS),
      })
    }
    this.addRibbon(wash, hull.seed)
    if (now.speedMps === 0) return

    // The bow wave: a moustache along the forward flanks of the end that
    // leads, from the stem back over the first third of the hull
    const intensity = wakeIntensity(now.speedMps)
    const stem = -now.trailing * halfLength
    for (const side of [-1, 1]) {
      const flank: RibbonPoint[] = []
      for (const [back, spread, width, fade] of [
        [0, 0, 0.16, 1],
        [0.12, 0.42, 0.24, 0.75],
        [0.33, 0.55, 0.14, 0],
      ]) {
        flank.push({
          position: this.onWater(now, stem + now.trailing * back * hull.lengthM, side * spread * hull.beamM, hull.surfaceHeight),
          halfWidth: width * hull.beamM,
          alpha: BOW_OPACITY * intensity * fade,
          phase: this.phaseAt(0, back * hull.lengthM),
        })
      }
      this.addRibbon(flank, hull.seed + 50 + side)
    }

    // The Kelvin arms: from the bow, spreading at their angle with the
    // distance run behind it, thin and faint, and only as long as the
    // way she made
    for (const side of [-1, 1]) {
      const arm: RibbonPoint[] = [
        {
          position: this.onWater(now, stem, 0, hull.surfaceHeight),
          halfWidth: 0.08 * hull.beamM,
          alpha: ARM_OPACITY * intensity,
          phase: this.phaseAt(0),
        },
      ]
      let behind = halfLength
      for (let i = 1; i < poses.length; i++) {
        const pose = poses[i]
        if (pose.speedMps === 0) break
        behind += pose.speedMps * (pose.ageS - poses[i - 1].ageS)
        const f = pose.ageS / WAKE_LIFE_S
        arm.push({
          position: this.onWater(pose, 0, side * behind * KELVIN_SPREAD, hull.surfaceHeight),
          halfWidth: 0.08 * hull.beamM + 0.02 * behind,
          alpha: ARM_OPACITY * wakeIntensity(pose.speedMps) * Math.pow(1 - f, 2),
          phase: this.phaseAt(pose.ageS),
        })
      }
      this.addRibbon(arm, hull.seed + 70 + side)
    }
  }

  /** The poses on the water: which way she moved into each, how fast, and which end trailed. */
  private resolve(samples: readonly WakeSample[]): Pose[] {
    const poses: Pose[] = []
    for (let i = 0; i + 1 < samples.length; i++) {
      const now = samples[i]
      const before = samples[i + 1]
      const northM = (now.lat - before.lat) * METERS_PER_DEGREE_LATITUDE
      const eastM =
        (now.lon - before.lon) * METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR * Math.cos((now.lat * Math.PI) / 180)
      const movedM = Math.hypot(northM, eastM)
      const dtS = Math.max(0.001, before.ageS - now.ageS)
      const bearingRad = (now.bearingDeg * Math.PI) / 180
      let trailing = -1
      if (movedM >= STILL_M) {
        // Going astern: the motion against the way the hull points
        const along = eastM * Math.sin(bearingRad) + northM * Math.cos(bearingRad)
        trailing = along < 0 ? 1 : -1
      }
      poses.push({
        ageS: now.ageS,
        lat: now.lat,
        lon: now.lon,
        bearingRad,
        speedMps: movedM >= STILL_M ? movedM / dtS : 0,
        trailing,
      })
    }
    return poses
  }

  /** A point on the water `along` metres ahead along the hull and `across` to starboard of a pose's centre. */
  private onWater(pose: Pose, along: number, across: number, height: number): Cartesian3 {
    const eastM = Math.sin(pose.bearingRad) * along + Math.cos(pose.bearingRad) * across
    const northM = Math.cos(pose.bearingRad) * along - Math.sin(pose.bearingRad) * across
    const lat = pose.lat + northM / METERS_PER_DEGREE_LATITUDE
    const lon = pose.lon + eastM / (METERS_PER_DEGREE_LONGITUDE_AT_EQUATOR * Math.cos((pose.lat * Math.PI) / 180))
    return Cartesian3.fromDegrees(lon, lat, height)
  }

  /**
   * A ribbon through its points: a segment per pair, the direction
   * across each point averaged from its neighbours so the bends join.
   */
  private addRibbon(points: readonly RibbonPoint[], seed: number): void {
    if (points.length < 2) return
    const perps = points.map((point, i) => {
      const prev = points[Math.max(0, i - 1)].position
      const next = points[Math.min(points.length - 1, i + 1)].position
      Cartesian3.subtract(next, prev, dirScratch)
      Cartesian3.normalize(point.position, upScratch)
      Cartesian3.cross(upScratch, dirScratch, perpScratch)
      return Cartesian3.magnitude(perpScratch) > 0
        ? Cartesian3.normalize(perpScratch, new Cartesian3())
        : new Cartesian3(1, 0, 0)
    })
    for (let i = 0; i + 1 < points.length; i++) {
      this.addSegment(points[i], points[i + 1], perps[i], perps[i + 1], seed)
    }
  }

  private addSegment(a: RibbonPoint, b: RibbonPoint, perpA: Cartesian3, perpB: Cartesian3, seed: number): void {
    const index = this.count++
    if ((index + 1) * FLOATS_PER_INSTANCE > this.instances.length) {
      const grown = new Float32Array(this.instances.length * 2)
      grown.set(this.instances)
      this.instances = grown
    }
    const base = index * FLOATS_PER_INSTANCE
    const write = (offset: number, position: Cartesian3) => {
      const [hx, lx] = splitDouble(position.x)
      const [hy, ly] = splitDouble(position.y)
      const [hz, lz] = splitDouble(position.z)
      this.instances[base + offset] = hx
      this.instances[base + offset + 1] = hy
      this.instances[base + offset + 2] = hz
      this.instances[base + offset + 3] = lx
      this.instances[base + offset + 4] = ly
      this.instances[base + offset + 5] = lz
    }
    write(P0_OFFSET, a.position)
    write(P1_OFFSET, b.position)
    this.instances[base + PERP0_OFFSET] = perpA.x
    this.instances[base + PERP0_OFFSET + 1] = perpA.y
    this.instances[base + PERP0_OFFSET + 2] = perpA.z
    this.instances[base + PERP1_OFFSET] = perpB.x
    this.instances[base + PERP1_OFFSET + 1] = perpB.y
    this.instances[base + PERP1_OFFSET + 2] = perpB.z
    this.instances[base + PROFILE_OFFSET] = a.halfWidth
    this.instances[base + PROFILE_OFFSET + 1] = b.halfWidth
    this.instances[base + PROFILE_OFFSET + 2] = a.alpha
    this.instances[base + PROFILE_OFFSET + 3] = b.alpha
    this.instances[base + PHASE_OFFSET] = a.phase
    this.instances[base + PHASE_OFFSET + 1] = b.phase
    this.instances[base + SEED_OFFSET] = seed
    this.anchors.push(Cartesian3.clone(a.position), Cartesian3.clone(b.position))
  }

  /** The set is complete for this tick. */
  commit(): void {
    if (this.count > 0) {
      BoundingSphere.fromPoints(this.anchors, this.boundingSphere)
      this.boundingSphere.radius += BOUNDS_MARGIN_M
    }
    this.dirty = true
  }

  /** What one segment holds – for the tests. */
  segmentAt(index: number): {
    from: Cartesian3
    to: Cartesian3
    halfWidthFrom: number
    halfWidthTo: number
    alphaFrom: number
    alphaTo: number
    phaseFrom: number
    phaseTo: number
    seed: number
  } {
    const base = index * FLOATS_PER_INSTANCE
    const i = this.instances
    const read = (offset: number) =>
      new Cartesian3(
        i[base + offset] + i[base + offset + 3],
        i[base + offset + 1] + i[base + offset + 4],
        i[base + offset + 2] + i[base + offset + 5],
      )
    return {
      from: read(P0_OFFSET),
      to: read(P1_OFFSET),
      halfWidthFrom: i[base + PROFILE_OFFSET],
      halfWidthTo: i[base + PROFILE_OFFSET + 1],
      alphaFrom: i[base + PROFILE_OFFSET + 2],
      alphaTo: i[base + PROFILE_OFFSET + 3],
      phaseFrom: i[base + PHASE_OFFSET],
      phaseTo: i[base + PHASE_OFFSET + 1],
      seed: i[base + SEED_OFFSET],
    }
  }

  /**
   * Whether a frame is owed for the foam's own fading: the ships' clock
   * has moved WAKE_FADE_FRAME_S past the frame last drawn. A ship under
   * way earns frames herself; this is for the wake she leaves standing.
   */
  get fadeFrameDue(): boolean {
    return Number.isNaN(this.renderedMs) || this.clockMs - this.renderedMs >= WAKE_FADE_FRAME_S * 1000
  }

  /** How far the churning foam has moved on its own since the frame last drawn, in metres. */
  get metersSinceRendered(): number {
    return (this.churnS - this.renderedChurnS) * WAKE_CHURN_MPS
  }

  /** The map drew a frame. */
  markRendered(): void {
    this.renderedMs = this.clockMs
    this.renderedChurnS = this.churnS
  }

  /** Debug and tests. */
  get state(): { drawn: number; supported: boolean; churnS: number } {
    return { drawn: this.count, supported: !this.unsupported, churnS: this.churnS }
  }

  /** The foam's colour for the sun over the first segment – one fleet, one harbour. */
  private updateColor(): void {
    const sun = this.host.sunDirection
    if (!sun || this.anchors.length === 0) return
    const up = Cartesian3.normalize(this.anchors[0], upScratch)
    Cartesian3.clone(wakeColor(Cartesian3.dot(sun, up), this.host.overcast), this.color)
  }

  private ensureResources(frameState: FrameState): WakeResources | null {
    const context = frameState.context
    if (this.unsupported) return null
    if (this.resources && this.resources.capacity * FLOATS_PER_INSTANCE >= this.instances.length) {
      return this.resources
    }
    if (!context.instancedArrays) {
      this.unsupported = true
      return null
    }
    const previous = this.resources
    // The quad's corners as (along, across): a strip from one end to the other
    const quad = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]),
      usage: renderer.BufferUsage.STATIC_DRAW,
    })
    const instances = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: this.instances,
      usage: renderer.BufferUsage.DYNAMIC_DRAW,
    })
    const perInstance = { vertexBuffer: instances, strideInBytes: STRIDE_BYTES, instanceDivisor: 1 }
    const float = ComponentDatatype.FLOAT
    const attribute = (index: number, components: number, offset: number) => ({
      ...perInstance,
      index,
      componentsPerAttribute: components,
      componentDatatype: float,
      offsetInBytes: offset * 4,
    })
    const vertexArray = new renderer.VertexArray({
      context,
      attributes: [
        { index: ATTRIBUTE_LOCATIONS.a_corner, vertexBuffer: quad, componentsPerAttribute: 2, componentDatatype: float },
        attribute(ATTRIBUTE_LOCATIONS.a_p0High, 3, P0_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_p0Low, 3, P0_OFFSET + 3),
        attribute(ATTRIBUTE_LOCATIONS.a_p1High, 3, P1_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_p1Low, 3, P1_OFFSET + 3),
        attribute(ATTRIBUTE_LOCATIONS.a_perp0, 3, PERP0_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_perp1, 3, PERP1_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_profile, 4, PROFILE_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_phase, 2, PHASE_OFFSET),
        attribute(ATTRIBUTE_LOCATIONS.a_seed, 1, SEED_OFFSET),
      ],
    })
    const shaderProgram =
      previous?.command.shaderProgram ??
      renderer.ShaderProgram.fromCache({
        context,
        attributeLocations: ATTRIBUTE_LOCATIONS,
        vertexShaderSource: VERTEX_SHADER,
        fragmentShaderSource: FRAGMENT_SHADER,
      })
    // Translucent over the water, behind whatever stands in front of it;
    // no depth written, so the ribbons blend over each other in any order
    const renderState = renderer.RenderState.fromCache({
      depthMask: false,
      depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
      cull: { enabled: false },
      blending: BlendingState.ALPHA_BLEND,
    })
    const command = new renderer.DrawCommand({
      owner: this,
      boundingVolume: this.boundingSphere,
      modelMatrix: Matrix4.IDENTITY,
      primitiveType: PrimitiveType.TRIANGLE_STRIP,
      count: 4,
      instanceCount: this.count,
      vertexArray,
      shaderProgram,
      renderState,
      pass: renderer.Pass.TRANSLUCENT,
      uniformMap: {
        u_maxDistance: () => WAKE_MAX_DISTANCE_M,
        u_lift: () => WAKE_LIFT_M,
        u_liftPerMeter: () => WAKE_LIFT_PER_METER,
        u_depthBias: () => WAKE_DEPTH_BIAS,
        u_color: () => this.color,
        u_churn: () => this.churnS,
      },
    })
    // The old vertex array takes its buffers with it; the program lives on
    if (previous) previous.command.vertexArray.destroy()
    this.resources = { command, instances, capacity: this.instances.length / FLOATS_PER_INSTANCE }
    this.dirty = true
    return this.resources
  }

  /**
   * Cesium's primitive contract: once per frame, before the commands run.
   * The render pass only – nothing to pick in foam, and the offscreen
   * passes (clampToHeight, the ray picks) must not set a hull on it.
   */
  update(frameState: FrameState): void {
    if (this.destroyed || this.count === 0) return
    const passes = frameState.passes
    if (!passes.render || passes.pick || passes.offscreen) return
    const resources = this.ensureResources(frameState)
    if (!resources) return
    if (this.dirty) {
      resources.instances.copyFromArrayView(this.instances, 0)
      this.updateColor()
      this.dirty = false
    }
    resources.command.instanceCount = this.count
    frameState.commandList.push(resources.command)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const resources = this.resources
    this.resources = null
    if (!resources) return
    resources.command.vertexArray.destroy()
    resources.command.shaderProgram.destroy()
  }
}
