/**
 * The beams of the rotating lighthouses – what a lens throws into the
 * night as it turns (see lib/lighthouse-beam.ts for the optic itself).
 * Two things draw them, from one list the layer builds per frame
 * (LighthousesLayer):
 *
 * The shaft in the air is this primitive: one instanced draw command
 * after the smoke's pattern (FunnelSmoke), a strip along each beam that
 * turns its face to the camera, bright and narrow at the lantern, wider
 * and fainter out to BEAM_LENGTH_M – the haze a beam lights, additive
 * over whatever is behind it, so it glows on the sky and brightens the
 * tower it passes. Stateless like every animated effect here: the
 * lens's azimuth comes in per instance, the layer sets it from the
 * optic's clock, and any frame is right by itself whatever the last one
 * was. Render pass only – nothing to pick in a beam, and the offscreen
 * passes (the surface picks) must not set a buoy on a shaft of light.
 *
 * What the beam lights on the ground is the tiles' own shader
 * (CesiumMap's TIME_OF_DAY_SHADER): LIGHTHOUSE_BEAM_GLSL adds, per
 * fragment, the light of up to MAX_TILE_BEAMS lenses – the fragment's
 * bearing from the lantern against the lens's azimuth, a soft profile
 * across the beam that widens with the distance, a vertical spread about
 * the lantern's height (the near foreshore under a tower lies dark, as
 * it does), a fall-off with the distance – and mixes the baked daylight
 * colour back in by that much, in the beam's colour: the photo texture
 * lit where the beam falls, on water, quay and facade alike. The lenses
 * come as uniforms (lighthouseBeamUniforms), positions in one local
 * east-north-up frame at the city's lights (u_beamToLocal) so the
 * bearing is a plain atan; an unused slot has a reach of 0 and returns
 * nothing. u_beamLight is the night level and 0 by day, when the whole
 * block is skipped.
 */

import {
  BlendingState,
  BoundingSphere,
  Cartesian3,
  Cartesian4,
  ComponentDatatype,
  DepthFunction,
  Matrix4,
  PrimitiveType,
  UniformType,
} from 'cesium'
import { renderer, type Buffer, type DrawCommand, type FrameState } from './cesium-renderer'

/** How far a beam is drawn from the lantern, in metres – the haze it lights, not its range. */
export const BEAM_LENGTH_M = 900
/** Tangent of the beam's half angle: how the shaft widens with the distance (about 2°). */
export const BEAM_HALF_TAN = 0.035
/** The shaft's radius at the lantern, metres. */
export const BEAM_CORE_M = 2
/**
 * The beams fade with the camera's distance to the lantern, the way the
 * lanterns do (translucencyByDistance): full within BEAM_FULL_DISTANCE_M,
 * gone at BEAM_MAX_DISTANCE_M, linear between – numbers chosen by eye,
 * in place of a hard edge at 15 km where a beam popped in as the camera
 * came down. Both the shaft and the light on the tiles take the same
 * fade (beamDistanceFade), computed per light on the CPU.
 */
export const BEAM_FULL_DISTANCE_M = 10_000
export const BEAM_MAX_DISTANCE_M = 20_000

/** The beams' strength for a camera `distanceM` from the lantern, 1 … 0 along the ramp above. */
export function beamDistanceFade(distanceM: number): number {
  const t = (BEAM_MAX_DISTANCE_M - distanceM) / (BEAM_MAX_DISTANCE_M - BEAM_FULL_DISTANCE_M)
  return Math.min(1, Math.max(0, t))
}
/** The shaft's opacity at full night, on the axis at the lantern. */
const BEAM_OPACITY = 0.55
/** Lens slots the tile shader carries – four lights of two or three lenses fit. */
export const MAX_TILE_BEAMS = 8

/** Per-instance layout: anchor high (3), low (3), azimuth, colour (3), length, intensity. */
const FLOATS_PER_INSTANCE = 12
const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4
const AZIMUTH_OFFSET = 6
const COLOR_OFFSET = 7
const LENGTH_OFFSET = 10
const INTENSITY_OFFSET = 11
const INITIAL_CAPACITY = 16
/** Segments along the strip – the fade along it is per vertex. */
const SEGMENTS = 6
const VERTICES_PER_BEAM = SEGMENTS * 6

const ATTRIBUTE_LOCATIONS = {
  a_shape: 0,
  a_anchorHigh: 1,
  a_anchorLow: 2,
  a_azimuth: 3,
  a_color: 4,
  a_length: 5,
  a_intensity: 6,
}

/*
 * A strip along the beam from one buffer, the lens per instance. The
 * lantern goes through the relative-to-eye transform as high and low
 * floats like the stop discs, so a beam 6000 km from the origin does not
 * jitter. The strip's width lies across both the beam and the line of
 * sight, so it faces the camera from wherever it is looked at – except
 * straight along the beam, where it is a line, as a shaft of light is.
 */
const VERTEX_SHADER = /* glsl */ `
in vec2 a_shape;
in vec3 a_anchorHigh;
in vec3 a_anchorLow;
in float a_azimuth;
in vec3 a_color;
in float a_length;
in float a_intensity;

uniform float u_maxDistance;
uniform float u_halfTan;
uniform float u_core;

out float v_side;
out float v_along;
out vec3 v_color;
out float v_alpha;

void main()
{
    vec4 anchorEC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_anchorHigh, a_anchorLow);
    float cameraDistance = length(anchorEC.xyz);
    bool drawn = a_intensity > 0.0 && cameraDistance <= u_maxDistance;

    vec3 up = normalize(a_anchorHigh + a_anchorLow);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    // Clockwise from north: east by the sine, north by the cosine
    vec3 directionEC = czm_viewRotation * (east * sin(a_azimuth) + north * cos(a_azimuth));

    float along = a_shape.x * a_length;
    vec3 axisEC = anchorEC.xyz + directionEC * along;
    vec3 toEye = -normalize(axisEC);
    vec3 sideEC = cross(directionEC, toEye);
    float sideLength = length(sideEC);
    sideEC = sideLength > 1e-4 ? sideEC / sideLength : vec3(0.0, 1.0, 0.0);
    float radius = u_core + along * u_halfTan;
    vec3 positionEC = axisEC + sideEC * (a_shape.y * radius);
    // A hidden instance collapses behind the far plane
    gl_Position = drawn ? czm_projection * vec4(positionEC, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
#ifdef LOG_DEPTH
    czm_vertexLogDepth();
#endif
    v_side = a_shape.y;
    v_along = a_shape.x;
    v_color = a_color;
    v_alpha = drawn ? a_intensity : 0.0;
}
`

/*
 * Bright on the axis, soft to the rim, out by the far end – added to
 * what is behind (the blend state is additive), so the colour is
 * written premultiplied.
 */
const FRAGMENT_SHADER = /* glsl */ `
in float v_side;
in float v_along;
in vec3 v_color;
in float v_alpha;

uniform float u_opacity;

void main()
{
    float across = exp(-3.0 * v_side * v_side);
    float fade = (1.0 - v_along) * (1.0 - v_along);
    float alpha = across * fade * v_alpha * u_opacity;
    if (alpha <= 0.002)
    {
        discard;
    }
    out_FragColor = vec4(v_color * alpha, alpha);
}
`

/** The uniform names the tile shader's beam block reads. */
export const LIGHTHOUSE_BEAM_UNIFORMS = {
  toLocal: 'u_beamToLocal',
  light: 'u_beamLight',
  /** Slot i: position in the local frame (xyz) and azimuth in radians (w). */
  a: (slot: number) => `u_beamA${slot}`,
  /** Slot i: colour (rgb) and reach in metres (w); a reach of 0 is an empty slot. */
  b: (slot: number) => `u_beamB${slot}`,
} as const

/**
 * The tile shader's part: the function, to be placed before
 * fragmentMain. Distances in metres of the local frame; the constants
 * are the shaft's, so the two agree on the beam's width.
 */
export const LIGHTHOUSE_BEAM_GLSL = /* glsl */ `
const float BEAM_HALF_TAN = ${BEAM_HALF_TAN.toFixed(4)};
const float BEAM_CORE_M = 3.0;
// The beam's spread up and down – a little more than across, so the
// water a kilometre out, thirty metres under the lantern, is in it
const float BEAM_VERTICAL_TAN = 0.06;
// The fall-off with the distance: half the strength at this many metres
const float BEAM_FALL_M = 500.0;

vec3 lighthouseBeam(vec3 local, vec4 a, vec4 b)
{
    if (b.w <= 0.0) return vec3(0.0);
    vec3 d = local - a.xyz;
    float dist = length(d.xy);
    if (dist < 2.0 || dist > b.w) return vec3(0.0);
    float bearing = atan(d.x, d.y);
    float turn = mod(bearing - a.w + czm_pi, czm_twoPi) - czm_pi;
    float across = abs(turn) * dist;
    float halfWidth = BEAM_CORE_M + dist * BEAM_HALF_TAN;
    float profile = exp(-2.0 * across * across / (halfWidth * halfWidth));
    float halfHeight = BEAM_CORE_M + dist * BEAM_VERTICAL_TAN;
    float vertical = exp(-d.z * d.z / (halfHeight * halfHeight));
    float fall = (1.0 - smoothstep(0.6 * b.w, b.w, dist)) / (1.0 + dist / BEAM_FALL_M);
    return b.rgb * (profile * vertical * fall);
}
`

/**
 * The statements for fragmentMain: every slot's light summed and the
 * baked daylight colour mixed back in by it, never past the daylight
 * itself. `baked` is the material's colour before the grading.
 */
export const LIGHTHOUSE_BEAM_BLOCK = /* glsl */ `
  if (${LIGHTHOUSE_BEAM_UNIFORMS.light} > 0.0) {
    vec3 beamLocal = (${LIGHTHOUSE_BEAM_UNIFORMS.toLocal} * vec4(fsInput.attributes.positionWC, 1.0)).xyz;
    vec3 beam = vec3(0.0);
${Array.from({ length: MAX_TILE_BEAMS }, (_, i) => `    beam += lighthouseBeam(beamLocal, ${LIGHTHOUSE_BEAM_UNIFORMS.a(i)}, ${LIGHTHOUSE_BEAM_UNIFORMS.b(i)});`).join('\n')}
    material.diffuse = min(material.diffuse + baked * beam * ${LIGHTHOUSE_BEAM_UNIFORMS.light}, max(material.diffuse, baked));
  }
`

/** The uniforms the tile shader declares for the beams, all empty: the layer fills them per frame. */
export function lighthouseBeamUniforms(): Record<string, { type: UniformType; value: unknown }> {
  const uniforms: Record<string, { type: UniformType; value: unknown }> = {
    [LIGHTHOUSE_BEAM_UNIFORMS.toLocal]: { type: UniformType.MAT4, value: Matrix4.clone(Matrix4.IDENTITY) },
    [LIGHTHOUSE_BEAM_UNIFORMS.light]: { type: UniformType.FLOAT, value: 0 },
  }
  for (let slot = 0; slot < MAX_TILE_BEAMS; slot++) {
    uniforms[LIGHTHOUSE_BEAM_UNIFORMS.a(slot)] = { type: UniformType.VEC4, value: new Cartesian4() }
    uniforms[LIGHTHOUSE_BEAM_UNIFORMS.b(slot)] = { type: UniformType.VEC4, value: new Cartesian4() }
  }
  return uniforms
}

interface BeamResources {
  command: DrawCommand
  instances: Buffer
  capacity: number
}

/** A double as the two floats the relative-to-eye transform takes (see StopDiscs). */
function splitDouble(value: number): [high: number, low: number] {
  const magnitude = Math.floor(Math.abs(value) / 65536) * 65536
  return value >= 0 ? [magnitude, value - magnitude] : [-magnitude, value + magnitude]
}

export class LighthouseBeams {
  /** The instance buffer as the shader reads it – exposed for the tests that pin the packing. */
  instances = new Float32Array(INITIAL_CAPACITY * FLOATS_PER_INSTANCE)
  private count = 0
  private readonly anchors: Cartesian3[] = []
  private readonly boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0)
  private dirty = true
  private resources: BeamResources | null = null
  private unsupported = false
  private destroyed = false

  /** How many beams the next frame draws. */
  get drawn(): number {
    return this.count
  }

  /** Starts a new set – the layer adds one per lit lens, then commits. */
  begin(): void {
    this.count = 0
    this.anchors.length = 0
  }

  /**
   * One beam from `anchor` (the lantern, world) pointing at `azimuthRad`
   * (clockwise from north), in `color` (0 … 1 each), `lengthM` long, at
   * `intensity` (0 … 1, the night level).
   */
  add(anchor: Cartesian3, azimuthRad: number, color: readonly [number, number, number], lengthM: number, intensity: number): void {
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
    this.instances[base + AZIMUTH_OFFSET] = azimuthRad
    this.instances[base + COLOR_OFFSET] = color[0]
    this.instances[base + COLOR_OFFSET + 1] = color[1]
    this.instances[base + COLOR_OFFSET + 2] = color[2]
    this.instances[base + LENGTH_OFFSET] = lengthM
    this.instances[base + INTENSITY_OFFSET] = intensity
    this.anchors.push(Cartesian3.clone(anchor))
  }

  /** The set is complete for this frame. */
  commit(): void {
    if (this.count > 0) {
      BoundingSphere.fromPoints(this.anchors, this.boundingSphere)
      this.boundingSphere.radius += BEAM_LENGTH_M
    }
    this.dirty = true
  }

  /** What one instance holds – for the tests. */
  instanceAt(index: number): {
    anchor: Cartesian3
    azimuthRad: number
    color: [number, number, number]
    lengthM: number
    intensity: number
  } {
    const base = index * FLOATS_PER_INSTANCE
    const i = this.instances
    return {
      anchor: new Cartesian3(i[base] + i[base + 3], i[base + 1] + i[base + 4], i[base + 2] + i[base + 5]),
      azimuthRad: i[base + AZIMUTH_OFFSET],
      color: [i[base + COLOR_OFFSET], i[base + COLOR_OFFSET + 1], i[base + COLOR_OFFSET + 2]],
      lengthM: i[base + LENGTH_OFFSET],
      intensity: i[base + INTENSITY_OFFSET],
    }
  }

  /** Debug and tests. */
  get state(): { drawn: number; supported: boolean } {
    return { drawn: this.count, supported: !this.unsupported }
  }

  /** Everything that needs the GL context, built on the first frame and grown as needed. */
  private ensureResources(frameState: FrameState): BeamResources | null {
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
    const strip = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: beamStrip(),
      usage: renderer.BufferUsage.STATIC_DRAW,
    })
    const instances = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: this.instances,
      usage: renderer.BufferUsage.DYNAMIC_DRAW,
    })
    const perVertex = { vertexBuffer: strip, strideInBytes: 2 * 4 }
    const perInstance = { vertexBuffer: instances, strideInBytes: STRIDE_BYTES, instanceDivisor: 1 }
    const float = ComponentDatatype.FLOAT
    const vertexArray = new renderer.VertexArray({
      context,
      attributes: [
        { ...perVertex, index: ATTRIBUTE_LOCATIONS.a_shape, componentsPerAttribute: 2, componentDatatype: float },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_anchorHigh, componentsPerAttribute: 3, componentDatatype: float, offsetInBytes: 0 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_anchorLow, componentsPerAttribute: 3, componentDatatype: float, offsetInBytes: 3 * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_azimuth, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: AZIMUTH_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_color, componentsPerAttribute: 3, componentDatatype: float, offsetInBytes: COLOR_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_length, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: LENGTH_OFFSET * 4 },
        { ...perInstance, index: ATTRIBUTE_LOCATIONS.a_intensity, componentsPerAttribute: 1, componentDatatype: float, offsetInBytes: INTENSITY_OFFSET * 4 },
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
    // Light added to what is behind; behind the buildings, over the water
    // and the sky; writes no depth, so beams cross freely
    const renderState = renderer.RenderState.fromCache({
      depthMask: false,
      depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
      cull: { enabled: false },
      blending: BlendingState.ADDITIVE_BLEND,
    })
    const command = new renderer.DrawCommand({
      owner: this,
      boundingVolume: this.boundingSphere,
      modelMatrix: Matrix4.IDENTITY,
      primitiveType: PrimitiveType.TRIANGLES,
      count: VERTICES_PER_BEAM,
      instanceCount: this.count,
      vertexArray,
      shaderProgram,
      renderState,
      pass: renderer.Pass.TRANSLUCENT,
      uniformMap: {
        u_maxDistance: () => BEAM_MAX_DISTANCE_M,
        u_halfTan: () => BEAM_HALF_TAN,
        u_core: () => BEAM_CORE_M,
        u_opacity: () => BEAM_OPACITY,
      },
    })
    if (previous) previous.command.vertexArray.destroy()
    this.resources = { command, instances, capacity: this.instances.length / FLOATS_PER_INSTANCE }
    this.dirty = true
    return this.resources
  }

  /** Cesium's primitive contract: once per frame, before the commands run; the render pass only. */
  update(frameState: FrameState): void {
    if (this.destroyed || this.count === 0) return
    const passes = frameState.passes
    if (!passes.render || passes.pick || passes.offscreen) return
    const resources = this.ensureResources(frameState)
    if (!resources) return
    if (this.dirty) {
      resources.instances.copyFromArrayView(this.instances, 0)
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

/** The strip: SEGMENTS quads along the beam, each corner carrying (along, side). */
function beamStrip(): Float32Array {
  const data = new Float32Array(VERTICES_PER_BEAM * 2)
  let at = 0
  for (let segment = 0; segment < SEGMENTS; segment++) {
    const t0 = segment / SEGMENTS
    const t1 = (segment + 1) / SEGMENTS
    for (const [t, side] of [
      [t0, -1],
      [t1, -1],
      [t1, 1],
      [t0, -1],
      [t1, 1],
      [t0, 1],
    ]) {
      data[at++] = t
      data[at++] = side
    }
  }
  return data
}
