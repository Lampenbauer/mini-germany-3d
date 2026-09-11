/**
 * Exhaust over the funnels of the ships under way: one thin plume per
 * ship, all of them one instanced draw command.
 *
 * Not Cesium's ParticleSystem. That one simulates its particles from
 * frame to frame, and this map renders only when something on screen
 * moves – five or six frames a second in the home view, one every
 * fifteen seconds at rest – so after a long gap it would let every puff
 * die and emit the whole gap's worth at once: a cloud where a plume
 * should be. So the plume is stateless: a fixed number of puffs per
 * ship, each with a phase of its own along the stream, and the vertex
 * shader puts every puff where it is at the moment's time – born at the
 * funnel that many seconds ago, risen since, carried by the apparent
 * wind aboard (the weather's wind minus the ship's own speed, so the
 * plume trails aft of a ship under way and leans with the breeze at a
 * berth), grown and thinned with age. Any frame is right by itself,
 * whatever the last one was. For a ship on a steady course that is
 * exactly where the puffs would be had they been left behind at her
 * earlier positions.
 *
 * The plume runs on the ships' own clock (VesselLayer.sync's nowMs –
 * the wall clock live, the simulated one in a replay), so a pause holds
 * it with the ships, and no faster than PLUME_MAX_RATE times real time
 * under the time-lapse, where puffs cycling at ×120 would only flicker.
 * A frame is asked for once the puffs have moved a visible step on
 * screen since the frame last drawn – the rule the ships and the clouds
 * follow (screen-motion.ts); the layer measures it at each smoking ship
 * it draws. Off in the mobile profile (RenderProfile.shipEffects).
 *
 * Which ships smoke is the layer's call (VesselLayer): a hull with a
 * funnel in its model (VESSEL_MODELS[…].funnel – five of the thirteen
 * archetypes) and speed over ground of SMOKE_MIN_SOG_KN or more, within
 * SMOKE_MAX_DISTANCE_M of the camera. Thin and light grey, lit by the
 * time of day the way the clouds are (cloudLight) – a miniature's
 * exhaust, not a steamer's; modern ships hardly show any, and this is
 * decoration, not data.
 */

import {
  BlendingState,
  BoundingSphere,
  Cartesian2,
  Cartesian3,
  ComponentDatatype,
  DepthFunction,
  Matrix4,
  PrimitiveType,
} from 'cesium'
import { renderer, type Buffer, type DrawCommand, type FrameState } from './cesium-renderer'
import { cloudLight } from './CloudLayer'

/** Ships slower than this over the ground show no plume. */
export const SMOKE_MIN_SOG_KN = 1.5
/** Speed at which the plume is at its fullest. */
export const SMOKE_FULL_SOG_KN = 10
/** Beyond this camera distance no plume is drawn – it would be pixels. */
export const SMOKE_MAX_DISTANCE_M = 2500
/** Puffs per plume; each lives PLUME_LIFE_S seconds. */
export const PUFFS_PER_PLUME = 20
export const PLUME_LIFE_S = 8
/**
 * How fast a puff moves at most on its own – the rise plus the wander –
 * in metres per second: what the layer's frame request is measured in.
 */
export const PLUME_MOTION_MPS = 2
/** The plume runs no faster than this multiple of real time. */
export const PLUME_MAX_RATE = 3
/** A puff's climb over its life in metres, and its wander either side. */
const PLUME_RISE_M = 14
const PLUME_WANDER_M = 3
/** A puff's opacity at birth; twenty of them overlap into a plume. */
const PUFF_OPACITY = 0.3
/** How much of the sky's and the sun's light the smoke wears. */
const SMOKE_AMBIENT = 1.1
const SMOKE_SUNLIT = 0.5
const SMOKE_GREY = 0.72

/** Per-instance layout: anchor high (3), low (3), velocity east/north (2), size, intensity, seed, pad. */
const FLOATS_PER_INSTANCE = 12
const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4
const VELOCITY_OFFSET = 6
const SIZE_OFFSET = 8
const INTENSITY_OFFSET = 9
const SEED_OFFSET = 10
const INITIAL_CAPACITY = 64
/** Margin on the bounding sphere for the plume's reach downwind. */
const BOUNDS_MARGIN_M = 200

const ATTRIBUTE_LOCATIONS = {
  a_corner: 0,
  a_puff: 1,
  a_anchorHigh: 2,
  a_anchorLow: 3,
  a_velocity: 4,
  a_size: 5,
  a_intensity: 6,
  a_seed: 7,
}

/*
 * Every puff of every plume from one buffer of quads: the puff's index
 * rides with its corners, the ship's anchor and motion come per instance.
 * The anchor goes through the relative-to-eye transform as high and low
 * floats, like the stop discs, so a plume 6000 km from the origin does
 * not jitter; the puff's offset is laid out east, north and up in world
 * metres and turned into eye space, where the quad faces the camera.
 */
const VERTEX_SHADER = /* glsl */ `
in vec2 a_corner;
in float a_puff;
in vec3 a_anchorHigh;
in vec3 a_anchorLow;
in vec2 a_velocity;
in float a_size;
in float a_intensity;
in float a_seed;

uniform float u_time;
uniform vec2 u_wind;
uniform float u_maxDistance;
uniform float u_life;
uniform float u_puffCount;
uniform float u_rise;
uniform float u_wander;

out vec2 v_corner;
out float v_alpha;

float hash(float n)
{
    return fract(sin(n) * 43758.5453123);
}

void main()
{
    vec4 anchorEC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_anchorHigh, a_anchorLow);
    float distance = length(anchorEC.xyz);
    bool drawn = a_intensity > 0.0 && distance <= u_maxDistance;

    // The puff's place on the stream: its own phase, so no two are born
    // together and the plume is continuous whatever the time
    float phase = a_puff / u_puffCount + hash(a_seed + a_puff * 7.31);
    float age = fract(u_time / u_life + phase);
    float seconds = age * u_life;

    vec3 up = normalize(a_anchorHigh + a_anchorLow);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    // Born at the funnel where the ship then was, carried since by the
    // apparent wind: the weather's wind less the ship's own way
    vec2 carried = (u_wind - a_velocity) * seconds;
    // A fast climb that slows, and a wander that grows with it
    float climb = u_rise * sqrt(age);
    float spread = u_wander * age;
    float wobble = hash(a_seed * 1.7 + a_puff * 3.1) * 6.2831853;
    vec2 wander = vec2(cos(wobble + age * 4.0), sin(wobble + age * 3.0)) * spread;
    vec3 offsetWC = east * (carried.x + wander.x) + north * (carried.y + wander.y) + up * climb;

    float radius = a_size * (0.6 + 3.0 * age);
    vec3 centerEC = anchorEC.xyz + czm_viewRotation * offsetWC;
    vec3 positionEC = centerEC + vec3(a_corner * radius, 0.0);
    // A hidden instance collapses behind the far plane
    gl_Position = drawn ? czm_projection * vec4(positionEC, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
#ifdef LOG_DEPTH
    czm_vertexLogDepth();
#endif
    // In quickly, out slowly – and the plume thins with the ship's speed
    float fade = smoothstep(0.0, 0.08, age) * pow(1.0 - age, 1.5);
    v_corner = a_corner;
    v_alpha = drawn ? a_intensity * fade : 0.0;
}
`

/*
 * A soft disc; twenty of them, overlapping and thinning with age, are
 * the plume. Outside the disc the fragment is discarded.
 */
const FRAGMENT_SHADER = /* glsl */ `
in vec2 v_corner;
in float v_alpha;

uniform vec3 u_color;
uniform float u_opacity;

void main()
{
    float d = length(v_corner);
    float soft = 1.0 - smoothstep(0.25, 1.0, d);
    float alpha = soft * v_alpha * u_opacity;
    if (alpha <= 0.002)
    {
        discard;
    }
    out_FragColor = vec4(u_color, alpha);
}
`

/**
 * Everything that needs the GL context – built on the first frame drawn,
 * and again with a bigger instance buffer when the fleet outgrows it.
 * The command's vertex array owns its buffers (Cesium destroys them with
 * it), the shader program is kept across rebuilds.
 */
interface SmokeResources {
  command: DrawCommand
  /** The per-instance buffer, uploaded whole after a change; owned by the vertex array. */
  instances: Buffer
  /** Its capacity, in instances. */
  capacity: number
}

/** A double as the two floats the relative-to-eye transform takes (see StopDiscs). */
function splitDouble(value: number): [high: number, low: number] {
  const magnitude = Math.floor(Math.abs(value) / 65536) * 65536
  return value >= 0 ? [magnitude, value - magnitude] : [-magnitude, value + magnitude]
}

/**
 * The plume's colour for a sun height (sine of its elevation) and an
 * overcast grade: the sky's light with some of the sun's, greyed – a
 * light grey by day, near dark at night. Pure, for the tests.
 */
export function smokeColor(sunUp: number, overcast: number): Cartesian3 {
  const light = cloudLight(sunUp, overcast)
  return new Cartesian3(
    Math.min(1, light.ambient.x * SMOKE_AMBIENT + light.sun.x * SMOKE_SUNLIT) * SMOKE_GREY,
    Math.min(1, light.ambient.y * SMOKE_AMBIENT + light.sun.y * SMOKE_SUNLIT) * SMOKE_GREY,
    Math.min(1, light.ambient.z * SMOKE_AMBIENT + light.sun.z * SMOKE_SUNLIT) * SMOKE_GREY,
  )
}

/** How full a plume a ship at this speed over the ground shows, 0 = none. */
export function smokeIntensity(sogKn: number | null): number {
  if (sogKn === null || sogKn < SMOKE_MIN_SOG_KN) return 0
  const t = Math.min(1, (sogKn - SMOKE_MIN_SOG_KN) / (SMOKE_FULL_SOG_KN - SMOKE_MIN_SOG_KN))
  return 0.45 + 0.55 * t * t * (3 - 2 * t)
}

export interface FunnelSmokeHost {
  /** Unit sun direction in the earth-fixed frame, null before the first scene time. */
  readonly sunDirection: Cartesian3 | null
  /** How overcast the tiles are graded, 0 … 1. */
  readonly overcast: number
}

const upScratch = new Cartesian3()

export class FunnelSmoke {
  /** The instance buffer as the shader reads it – exposed for the tests that pin the packing. */
  instances = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_INSTANCE)
  private count = 0
  /** Anchors of the current instances, for the bounding sphere. */
  private readonly anchors: Cartesian3[] = []
  private readonly boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0)
  /** The wind's velocity east and north in m/s, as the shader takes it. */
  private readonly wind = new Cartesian2(0, 0)
  /** Seconds the plume has run – the shader's clock (see advance). */
  private time = 0
  /** The plume time as of the frame last drawn (see markRendered). */
  private renderedTime = 0
  private lastAdvanceMs: number | null = null
  private lastAdvanceReal: number | null = null
  private dirty = true
  private resources: SmokeResources | null = null
  private unsupported = false
  private destroyed = false
  private readonly color = new Cartesian3(0.6, 0.63, 0.68)

  constructor(private readonly host: FunnelSmokeHost) {}

  /** How many plumes the next frame draws. */
  get drawn(): number {
    return this.count
  }

  get plumeTime(): number {
    return this.time
  }

  /** How far the puffs have moved on their own since the frame last drawn, in metres. */
  get metersSinceRendered(): number {
    return (this.time - this.renderedTime) * PLUME_MOTION_MPS
  }

  /**
   * Carries the plume forward on the ships' clock: by its own elapsed
   * time, paused with it, and no faster than PLUME_MAX_RATE times the
   * real time that passed – the time-lapse must not spin the puffs. A
   * clock jumped back re-seeds and the plume simply stands.
   */
  advance(nowMs: number, realNowMs = performance.now()): void {
    if (this.lastAdvanceMs !== null && this.lastAdvanceReal !== null) {
      const dt = (nowMs - this.lastAdvanceMs) / 1000
      const realDt = Math.max(0, (realNowMs - this.lastAdvanceReal) / 1000)
      if (dt > 0) this.time += Math.min(dt, realDt * PLUME_MAX_RATE)
    }
    this.lastAdvanceMs = nowMs
    this.lastAdvanceReal = realNowMs
    // The plume is periodic in its life: wrapping the clock at a multiple
    // of it changes nothing on screen and keeps the shader's float exact
    // through a long session
    const period = PLUME_LIFE_S * 1024
    if (this.time >= period) {
      this.time -= period
      this.renderedTime -= period
    }
  }

  /** The map drew a frame: the plume's motion from here on is what has not been shown. */
  markRendered(): void {
    this.renderedTime = this.time
  }

  /** The wind the puffs are carried by: speed in m/s, the direction it blows from in degrees. */
  setWind(windSpeedMps: number, windFromDeg: number): void {
    const from = (windFromDeg * Math.PI) / 180
    // Blowing FROM there: the air moves the opposite way
    this.wind.x = -windSpeedMps * Math.sin(from)
    this.wind.y = -windSpeedMps * Math.cos(from)
  }

  /** Starts a new set of plumes – the layer adds one per smoking ship, then commits. */
  begin(): void {
    this.count = 0
    this.anchors.length = 0
  }

  /**
   * One plume: from `anchor` (the funnel top, world), for a ship moving
   * `velocityEast`/`velocityNorth` m/s, of a funnel `size` metres across,
   * at `intensity` (0 … 1), with a `seed` that gives the plume its own
   * timing.
   */
  add(
    anchor: Cartesian3,
    velocityEast: number,
    velocityNorth: number,
    size: number,
    intensity: number,
    seed: number,
  ): void {
    const index = this.count++
    if ((index + 1) * FLOATS_PER_INSTANCE > this.instances.length) {
      const grown = new Float32Array(this.instances.length * 2)
      grown.set(this.instances)
      this.instances = grown
    }
    const base = index * FLOATS_PER_INSTANCE
    const [hx, lx] = splitDouble(anchor.x)
    const [hy, ly] = splitDouble(anchor.y)
    const [hz, lz] = splitDouble(anchor.z)
    this.instances[base] = hx
    this.instances[base + 1] = hy
    this.instances[base + 2] = hz
    this.instances[base + 3] = lx
    this.instances[base + 4] = ly
    this.instances[base + 5] = lz
    this.instances[base + VELOCITY_OFFSET] = velocityEast
    this.instances[base + VELOCITY_OFFSET + 1] = velocityNorth
    this.instances[base + SIZE_OFFSET] = size
    this.instances[base + INTENSITY_OFFSET] = intensity
    this.instances[base + SEED_OFFSET] = seed
    this.anchors.push(Cartesian3.clone(anchor))
  }

  /** The set is complete for this tick. */
  commit(): void {
    if (this.count > 0) {
      BoundingSphere.fromPoints(this.anchors, this.boundingSphere)
      this.boundingSphere.radius += BOUNDS_MARGIN_M
    }
    this.dirty = true
  }

  /** What one instance holds – for the tests. */
  instanceAt(index: number): {
    anchor: Cartesian3
    velocityEast: number
    velocityNorth: number
    size: number
    intensity: number
    seed: number
  } {
    const base = index * FLOATS_PER_INSTANCE
    const i = this.instances
    return {
      anchor: new Cartesian3(i[base] + i[base + 3], i[base + 1] + i[base + 4], i[base + 2] + i[base + 5]),
      velocityEast: i[base + VELOCITY_OFFSET],
      velocityNorth: i[base + VELOCITY_OFFSET + 1],
      size: i[base + SIZE_OFFSET],
      intensity: i[base + INTENSITY_OFFSET],
      seed: i[base + SEED_OFFSET],
    }
  }

  /** Debug and tests. */
  get state(): { drawn: number; supported: boolean; plumeTime: number; wind: { east: number; north: number } } {
    return {
      drawn: this.count,
      supported: !this.unsupported,
      plumeTime: this.time,
      wind: { east: this.wind.x, north: this.wind.y },
    }
  }

  /** The plume's colour for the sun over the first plume – all of them are in one harbour. */
  private updateColor(): void {
    const sun = this.host.sunDirection
    if (!sun || this.anchors.length === 0) return
    const up = Cartesian3.normalize(this.anchors[0], upScratch)
    const tint = smokeColor(Cartesian3.dot(sun, up), this.host.overcast)
    Cartesian3.clone(tint, this.color)
  }

  /** Everything that needs the GL context, built on the first frame and grown with the fleet. */
  private ensureResources(frameState: FrameState): SmokeResources | null {
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
    const quads = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: puffQuads(),
      usage: renderer.BufferUsage.STATIC_DRAW,
    })
    const instances = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: this.instances,
      usage: renderer.BufferUsage.DYNAMIC_DRAW,
    })
    const perVertex = { vertexBuffer: quads, strideInBytes: 3 * 4 }
    const perInstance = { vertexBuffer: instances, strideInBytes: STRIDE_BYTES, instanceDivisor: 1 }
    const float = ComponentDatatype.FLOAT
    const vertexArray = new renderer.VertexArray({
      context,
      attributes: [
        { ...perVertex, index: ATTRIBUTE_LOCATIONS.a_corner, componentsPerAttribute: 2, componentDatatype: float },
        { ...perVertex, index: ATTRIBUTE_LOCATIONS.a_puff, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: 2 * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_anchorHigh, componentsPerAttribute: 3, componentDatatype: float, offsetInBytes: 0 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_anchorLow, componentsPerAttribute: 3, componentDatatype: float, offsetInBytes: 3 * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_velocity, componentsPerAttribute: 2, componentDatatype: float, offsetInBytes: VELOCITY_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_size, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: SIZE_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_intensity, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: INTENSITY_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_seed, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: SEED_OFFSET * 4 },
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
    // Translucent over the hulls and the water, behind the buildings;
    // writes no depth, so puffs blend over each other in any order
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
      primitiveType: PrimitiveType.TRIANGLES,
      count: PUFFS_PER_PLUME * 6,
      instanceCount: this.count,
      vertexArray,
      shaderProgram,
      renderState,
      pass: renderer.Pass.TRANSLUCENT,
      uniformMap: {
        u_time: () => this.time,
        u_wind: () => this.wind,
        u_maxDistance: () => SMOKE_MAX_DISTANCE_M,
        u_life: () => PLUME_LIFE_S,
        u_puffCount: () => PUFFS_PER_PLUME,
        u_rise: () => PLUME_RISE_M,
        u_wander: () => PLUME_WANDER_M,
        u_color: () => this.color,
        u_opacity: () => PUFF_OPACITY,
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
   * The render pass only – nothing to pick in a plume, and the offscreen
   * passes (clampToHeight, the ray picks) must not set a hull on its own
   * smoke.
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

/** The quads: two triangles per puff, each corner carrying the puff's index. */
function puffQuads(): Float32Array {
  const corners = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, -1],
    [1, 1],
    [-1, 1],
  ]
  const data = new Float32Array(PUFFS_PER_PLUME * 6 * 3)
  let at = 0
  for (let puff = 0; puff < PUFFS_PER_PLUME; puff++) {
    for (const [x, y] of corners) {
      data[at++] = x
      data[at++] = y
      data[at++] = puff
    }
  }
  return data
}
