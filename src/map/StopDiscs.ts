/**
 * The stop discs: one flat circle on the ground per stop position, all
 * of them one instanced draw command.
 *
 * They were billboards until 2026-09-11 – a disc image facing the camera,
 * which turned with it: a dot that stands up on the street and swings
 * round as the camera orbits is a pin, not a mark on the ground. A
 * billboard cannot lie flat, and nothing else Cesium offers draws a flat
 * mark whose position moves (the heights are refined stop by stop as the
 * camera nears, see StopsLayer.resolveHeights) and whose size follows the
 * camera: a batched Primitive bakes its positions in, a GroundPrimitive
 * classifies the tiles every frame. So the discs draw the way the clouds
 * do (CloudLayer): a hand-built DrawCommand – one quad, drawn once per
 * stop by instancing, with the stop's position, its opacity and its pick
 * colour in a per-instance buffer. The vertex shader lays the quad in the
 * tangent plane at the stop and sizes it to a fixed number of CSS pixels,
 * so the disc keeps the on-screen size the billboard had and foreshortens
 * with the view; the fragment shader draws the circle and its ring from
 * the quad's own coordinates.
 *
 * Two things the billboard did are kept. It ignored the depth buffer
 * within DEPTH_FREE_DISTANCE_M (Cesium's disableDepthTestDistance), so a
 * stop whose height the tiles had not been asked about yet did not vanish
 * into them; the vertex shader does the same the way Cesium's billboard
 * shader does, pushing the vertex to the near plane. And it was pickable
 * by its id: every instance carries a pick colour of its own
 * (context.createPickId), and the pick pass hands scene.pick the object
 * behind that colour – one with the same "stop:"-prefixed id the
 * billboard had, which is all CesiumMap.pickTarget reads.
 *
 * The buffer is the CPU's copy of the truth: the layer writes positions,
 * opacities and visibility into it as they change, and the frame after a
 * change uploads it whole – 32 bytes a stop, 86 KB for Berlin, nothing
 * beside a badge canvas. Everything that needs the GL context is built on
 * the first frame drawn, so the layer and its tests never touch one.
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
import {
  renderer,
  type Buffer,
  type DrawCommand,
  type FrameState,
  type PickId,
} from './cesium-renderer'

/** Rendered diameter of a stop disc in CSS px, ring included. */
export const STOP_DISC_SIZE = 12
/** Width of the disc's ring in CSS px. */
const STOP_DISC_RING = 2

/**
 * Within this camera distance in meters a disc is drawn over whatever
 * the tiles put in front of it – the billboard's disableDepthTestDistance,
 * kept: a stop still on its fallback height would otherwise sink into a
 * hillside until the layer got round to measuring it, and a stop in a
 * street is a stop to see, not to hunt for behind the roof in front.
 */
const DEPTH_FREE_DISTANCE_M = 3000

/**
 * Beyond that a disc is depth-tested, and the tiles there are coarse:
 * a far level sits up to ~10 m above the fine one the height was measured
 * on. The disc rises with its distance to stay on top of that – 6 m at
 * 3 km, 12 m at the home view, a pixel or two of displacement either way.
 */
const LIFT_PER_METER = 0.002

/** Per-instance layout: position high (3), low (3), alpha (1), pick colour (4 bytes in 1). */
const FLOATS_PER_INSTANCE = 8
const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4
const ALPHA_OFFSET = 6
const PICK_OFFSET = 7

/** Margin on the bounding sphere for the lift and the height refinement. */
const BOUNDS_MARGIN_M = 100

const ATTRIBUTE_LOCATIONS = {
  a_offset: 0,
  a_positionHigh: 1,
  a_positionLow: 2,
  a_alpha: 3,
  a_pickColor: 4,
}

/*
 * The disc in the stop's tangent plane, a fixed size on screen. The
 * centre comes through the relative-to-eye transform Cesium's own
 * primitives use, as high and low floats, so a stop 6000 km from the
 * origin does not jitter; the quad's corners are laid out east and north
 * around it in world metres and turned into eye space with the view's
 * rotation. Up is the geocentric normal – the geodetic one differs by a
 * fifth of a degree at most, nothing a disc shows.
 */
const VERTEX_SHADER = /* glsl */ `
in vec2 a_offset;
in vec3 a_positionHigh;
in vec3 a_positionLow;
in float a_alpha;
in vec4 a_pickColor;

uniform float u_halfSizeCss;
uniform float u_maxDistance;
uniform float u_depthFreeDistance;
uniform float u_liftPerMeter;

out vec2 v_offset;
out float v_alpha;
out vec4 v_pickColor;

void main()
{
    vec4 centerEC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_positionHigh, a_positionLow);
    float distance = length(centerEC.xyz);
    bool drawn = a_alpha > 0.0 && distance <= u_maxDistance;

    vec3 up = normalize(a_positionHigh + a_positionLow);
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    // czm_metersPerPixel takes the pixel ratio in: metres per CSS pixel
    float radius = u_halfSizeCss * czm_metersPerPixel(centerEC);
    vec3 offsetWC = (east * a_offset.x + north * a_offset.y) * radius + up * (u_liftPerMeter * distance);
    vec3 positionEC = centerEC.xyz + czm_viewRotation * offsetWC;
    // A hidden instance collapses behind the far plane
    gl_Position = drawn ? czm_projection * vec4(positionEC, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
#ifdef LOG_DEPTH
    czm_vertexLogDepth();
#endif
    // Over everything up close, the way a billboard's disableDepthTestDistance
    // is: the vertex goes to the near plane, and with the logarithmic depth
    // buffer the depth it writes from does too.
    if (drawn && distance < u_depthFreeDistance)
    {
        float zclip = gl_Position.z / gl_Position.w;
        if (zclip >= -1.0 && zclip <= 1.0)
        {
            gl_Position.z = -gl_Position.w;
#ifdef LOG_DEPTH
            v_depthFromNearPlusOne = 1.0;
#endif
        }
    }
    v_offset = a_offset;
    v_alpha = a_alpha;
    v_pickColor = a_pickColor;
}
`

/*
 * The circle and its ring, anti-aliased by the quad coordinate's screen
 * derivative. The disc wears the name's colours, so a stop reads as one
 * mark: light fill in a dark ring, the ink and the halo of StopsLayer's
 * stopNameImage – slate-50 and slate-700 written out, because a shader
 * reads no oklch(). Outside the circle the fragment is discarded, which is
 * also what keeps the pick pass to the disc itself.
 */
const FRAGMENT_SHADER = /* glsl */ `
in vec2 v_offset;
in float v_alpha;
in vec4 v_pickColor;

uniform float u_ringFraction;

const vec3 FILL = vec3(0.973, 0.980, 0.988);
const vec3 RING = vec3(0.200, 0.255, 0.333);

void main()
{
    float d = length(v_offset);
    float edge = fwidth(d);
    float disc = 1.0 - smoothstep(1.0 - edge, 1.0, d);
    if (disc <= 0.0)
    {
        discard;
    }
    float inner = 1.0 - u_ringFraction;
    float fill = 1.0 - smoothstep(inner - edge, inner, d);
    out_FragColor = vec4(mix(RING, FILL, fill), disc * v_alpha);
}
`

/** What the layer says about one stop. */
export interface StopDiscEntry {
  id: string
  position: Cartesian3
}

/** Everything that needs the GL context – built on the first frame drawn. */
interface DiscResources {
  quad: Buffer
  instances: Buffer
  command: DrawCommand
  pickIds: PickId[]
}

/**
 * A double as the two floats the relative-to-eye transform takes: the
 * multiple of 65536 below it and the rest – Cesium's EncodedCartesian3
 * .encode, which the type declarations leave out. The pair is exact in
 * float32 for anything on the globe.
 */
function splitDouble(value: number): [high: number, low: number] {
  const magnitude = Math.floor(Math.abs(value) / 65536) * 65536
  return value >= 0 ? [magnitude, value - magnitude] : [-magnitude, value + magnitude]
}

export class StopDiscs {
  /** The layer's switch: off draws nothing and picks nothing. */
  show = true
  /**
   * The per-instance buffer as the shader reads it – position high and
   * low, the alpha the shader draws with (zero while hidden), the pick
   * colour. Exposed for the tests that pin the packing.
   */
  readonly instances: Float32Array
  /** The pick colours' bytes, over the same memory as `instances`. */
  private readonly pickBytes: Uint8Array
  private readonly ids: string[]
  private readonly positions: Cartesian3[]
  /** Opacity and visibility apart, so a re-shown stop keeps its ghosting. */
  private readonly alphas: Float32Array
  private readonly shown: Uint8Array
  private readonly boundingSphere: BoundingSphere
  private readonly maxDistance: number
  /** The buffer changed since the last upload. */
  private dirty = true
  private resources: DiscResources | null = null
  private unsupported = false
  private destroyed = false

  constructor(entries: readonly StopDiscEntry[], options: { maxDistance: number }) {
    this.ids = entries.map((entry) => entry.id)
    this.positions = entries.map((entry) => Cartesian3.clone(entry.position))
    this.maxDistance = options.maxDistance
    this.instances = new Float32Array(entries.length * FLOATS_PER_INSTANCE)
    this.pickBytes = new Uint8Array(this.instances.buffer)
    this.alphas = new Float32Array(entries.length).fill(1)
    this.shown = new Uint8Array(entries.length).fill(1)
    entries.forEach((entry, index) => this.writePosition(index, entry.position))
    for (let index = 0; index < entries.length; index++) this.writeAlpha(index)
    this.boundingSphere =
      entries.length > 0
        ? BoundingSphere.fromPoints(this.positions)
        : new BoundingSphere(Cartesian3.ZERO, 0)
    this.boundingSphere.radius += BOUNDS_MARGIN_M
  }

  get count(): number {
    return this.ids.length
  }

  /** What the shader will draw for one stop – for the tests, and the layer's own reading. */
  stateOf(index: number): { shown: boolean; alpha: number; position: Cartesian3 } {
    return { shown: this.shown[index] === 1, alpha: this.alphas[index], position: this.positions[index] }
  }

  positionOf(index: number): Cartesian3 {
    return this.positions[index]
  }

  setPosition(index: number, position: Cartesian3): void {
    Cartesian3.clone(position, this.positions[index])
    this.writePosition(index, position)
  }

  /** The disc's opacity when shown – the underground view's ghosting. */
  setAlpha(index: number, alpha: number): void {
    this.alphas[index] = alpha
    this.writeAlpha(index)
  }

  setShown(index: number, shown: boolean): void {
    this.shown[index] = shown ? 1 : 0
    this.writeAlpha(index)
  }

  private writePosition(index: number, position: Cartesian3): void {
    const base = index * FLOATS_PER_INSTANCE
    const [hx, lx] = splitDouble(position.x)
    const [hy, ly] = splitDouble(position.y)
    const [hz, lz] = splitDouble(position.z)
    this.instances[base] = hx
    this.instances[base + 1] = hy
    this.instances[base + 2] = hz
    this.instances[base + 3] = lx
    this.instances[base + 4] = ly
    this.instances[base + 5] = lz
    this.dirty = true
  }

  private writeAlpha(index: number): void {
    this.instances[index * FLOATS_PER_INSTANCE + ALPHA_OFFSET] =
      this.shown[index] === 1 ? this.alphas[index] : 0
    this.dirty = true
  }

  /** Everything that needs the GL context, built on the first frame. */
  private ensureResources(frameState: FrameState): DiscResources | null {
    if (this.resources) return this.resources
    if (this.unsupported) return null
    const context = frameState.context
    if (!context.instancedArrays) {
      this.unsupported = true
      return null
    }
    // One pick colour per stop; the object behind it is what scene.pick
    // returns, and it carries the id the billboard used to
    const pickIds = this.ids.map((id) => context.createPickId({ id: `stop:${id}`, primitive: this }))
    pickIds.forEach((pickId, index) => {
      const at = (index * FLOATS_PER_INSTANCE + PICK_OFFSET) * 4
      this.pickBytes[at] = Math.round(pickId.color.red * 255)
      this.pickBytes[at + 1] = Math.round(pickId.color.green * 255)
      this.pickBytes[at + 2] = Math.round(pickId.color.blue * 255)
      this.pickBytes[at + 3] = Math.round(pickId.color.alpha * 255)
    })
    this.dirty = true

    const quad = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      usage: renderer.BufferUsage.STATIC_DRAW,
    })
    const instances = renderer.Buffer.createVertexBuffer({
      context,
      typedArray: this.instances,
      usage: renderer.BufferUsage.DYNAMIC_DRAW,
    })
    const perInstance = { vertexBuffer: instances, strideInBytes: STRIDE_BYTES, instanceDivisor: 1 }
    const vertexArray = new renderer.VertexArray({
      context,
      attributes: [
        {
          index: ATTRIBUTE_LOCATIONS.a_offset,
          vertexBuffer: quad,
          componentsPerAttribute: 2,
          componentDatatype: ComponentDatatype.FLOAT,
        },
        {
          ...perInstance,
          index: ATTRIBUTE_LOCATIONS.a_positionHigh,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 0,
        },
        {
          ...perInstance,
          index: ATTRIBUTE_LOCATIONS.a_positionLow,
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: 3 * 4,
        },
        {
          ...perInstance,
          index: ATTRIBUTE_LOCATIONS.a_alpha,
          componentsPerAttribute: 1,
          componentDatatype: ComponentDatatype.FLOAT,
          offsetInBytes: ALPHA_OFFSET * 4,
        },
        {
          ...perInstance,
          index: ATTRIBUTE_LOCATIONS.a_pickColor,
          componentsPerAttribute: 4,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          normalize: true,
          offsetInBytes: PICK_OFFSET * 4,
        },
      ],
    })
    const shaderProgram = renderer.ShaderProgram.fromCache({
      context,
      attributeLocations: ATTRIBUTE_LOCATIONS,
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: FRAGMENT_SHADER,
    })
    // Translucent like the billboards were: the ring's edge and the
    // underground ghosting blend. No culling – the underground view looks
    // up at the surface stops from below.
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
      // The pick pass writes this in place of the colour (see DerivedCommand)
      pickId: 'v_pickColor',
      uniformMap: {
        u_halfSizeCss: () => STOP_DISC_SIZE / 2,
        u_maxDistance: () => this.maxDistance,
        u_depthFreeDistance: () => DEPTH_FREE_DISTANCE_M,
        u_liftPerMeter: () => LIFT_PER_METER,
        u_ringFraction: () => STOP_DISC_RING / (STOP_DISC_SIZE / 2),
      },
    })
    this.resources = { quad, instances, command, pickIds }
    return this.resources
  }

  /**
   * Cesium's primitive contract: once per frame, before the commands run.
   * The render pass draws, the pick pass picks; the offscreen passes
   * (clampToHeight, the ray picks) get nothing – a ship's hull is not to
   * be set on a disc at the pier.
   */
  update(frameState: FrameState): void {
    if (this.destroyed || !this.show || this.count === 0) return
    const passes = frameState.passes
    if (!(passes.render || passes.pick) || passes.offscreen) return
    const resources = this.ensureResources(frameState)
    if (!resources) return
    if (this.dirty) {
      resources.instances.copyFromArrayView(this.instances, 0)
      this.dirty = false
    }
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
    for (const pickId of resources.pickIds) pickId.destroy()
    resources.command.vertexArray.destroy()
    resources.command.shaderProgram.destroy()
  }
}
