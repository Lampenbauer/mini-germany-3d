/**
 * The wagons of the scheduled fleet, drawn by instancing: one draw
 * command per wagon model (a GLB in public/models), every wagon of that
 * model on the map an instance of it.
 *
 * They were a Cesium `Model` each – a tram of three wagons three
 * Models, Berlin's morning fleet some 2 900 of them – and a Model is a
 * scene graph with an update of its own every frame and a draw command
 * of its own every pass: 1 200 vehicle commands against 280 for the
 * tiles over Hamburg's harbour, three quarters of a busy view's
 * commands (see "One primitive per part" in CLAUDE.md, which halved
 * them once by merging each wagon's materials into one primitive). A
 * wagon's GLB is, since that change, exactly one primitive – positions,
 * normals, a vertex colour, a palette coordinate, triangles – so the
 * geometry is read here from the file itself (a GLB is a JSON header
 * and a binary chunk) into one vertex array per model, and the wagons
 * ride in a per-instance buffer: the pose as the rotation's three
 * columns and the translation split into a high and a low float (the
 * relative-to-eye transform Cesium's own primitives use, so a wagon
 * 4 000 km from the origin does not jitter), the line colour the body
 * is tinted with, the opacity, a pick colour. A wagon that is not
 * drawn – its body out of range – has opacity 0 and its slot is kept,
 * so a vehicle coming back into range costs nothing; what reaches the
 * GPU is the shown slots alone, packed together (see `drawn`).
 *
 * What the Model did and the shader does here: the metallic-roughness
 * material from the palette texel the vertex points at (roughness in
 * green, metalness in blue – `paletteTexturePng` in the model
 * workshop), lit by the scene's sun through `czm_pbrLighting`, the
 * Model's own function, plus an ambient term in place of the Model's
 * image-based lighting (an environment map of the sky, which this
 * shader has no access to – the term follows the night ramp so a body
 * at night is as dark as a Model's); the line colour mixed in by
 * MODEL_TINT_AMOUNT, which is what `ColorBlendMode.MIX` did; the window
 * glow at night by the glazing's darkness, the rule of the Models'
 * custom shader; the tunnel ghosting as a translucent instance, drawn
 * by a second command in the translucent pass (the packed buffer holds
 * the opaque wagons first and the ghosts after them; the opaque command
 * draws the head, the translucent one the whole and its shader
 * collapses the opaque ones – WebGL 2 has no base instance to start a
 * command further in); the
 * neutral tonemapping and the sRGB conversion the Model's lighting
 * stage ends with. The command casts shadows and receives none, the
 * Models' `ShadowMode.CAST_ONLY`. What it does NOT do is the selection
 * silhouette: Cesium draws that through a stencil pass of the Model's
 * own, and the selected vehicle keeps its Models for it (VehicleLayer
 * loads them on selection and lets them go after).
 *
 * The slot buffer is the CPU's copy of the truth; the frame after a
 * change packs the shown slots and uploads them – 80 bytes a wagon, a
 * quarter megabyte for all of Berlin's. Everything that needs the GL context is built on
 * the first frame drawn, so the layer and its tests never touch one;
 * a GLB that cannot be read (the tests, a broken file) leaves its
 * batch empty and nothing else.
 */

import {
  BlendingState,
  BoundingSphere,
  Cartesian3,
  Color,
  ComponentDatatype,
  CullFace,
  DepthFunction,
  IndexDatatype,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  PrimitiveType,
} from 'cesium'
import {
  renderer,
  type Buffer,
  type DrawCommand,
  type FrameState,
  type IndexBuffer,
  type PickId,
  type Texture,
  type VertexArray,
} from './cesium-renderer'

/** Per-instance layout in floats: translation high (3), low (3), the rotation's columns (9), tint (3), alpha (1), pick colour (4 bytes in 1). */
const FLOATS_PER_INSTANCE = 20
const STRIDE_BYTES = FLOATS_PER_INSTANCE * 4
const COLUMNS_OFFSET = 6
const TINT_OFFSET = 15
const ALPHA_OFFSET = 18
const PICK_OFFSET = 19

/** Slots a batch starts with; doubled whenever the fleet outgrows them. */
const INITIAL_CAPACITY = 64

/** An instance below this opacity is a ghost, drawn translucent. */
const OPAQUE_ALPHA = 0.999

/** Margin on the bounding sphere for a wagon's own extent. */
const BOUNDS_MARGIN_M = 150

/**
 * The ambient light a body gets beside the sun, as a share of the
 * diffuse colour: by day what the Model's sky environment map gave it
 * (chosen beside a Model, headed), fading along the night ramp to a
 * trace, so a body at night is as dark as the Model was.
 */
const AMBIENT_DAY = 0.55
const AMBIENT_NIGHT = 0.25
/** The sky's reflection in a smooth surface, as a multiple of the ambient on its specular colour. */
const SKY_REFLECTION = 1.6

const ATTRIBUTE_LOCATIONS = {
  a_position: 0,
  a_normal: 1,
  a_color: 2,
  a_uv: 3,
  a_high: 4,
  a_low: 5,
  a_col0: 6,
  a_col1: 7,
  a_col2: 8,
  a_tint: 9,
  a_alpha: 10,
  a_pickColor: 11,
}

/*
 * The wagon in eye space: the instance's rotation (its three columns,
 * scale included) turns the model vertex into a world offset, the
 * translation comes through the relative-to-eye transform as high and
 * low floats, and the view's rotation turns the offset into eye space.
 * An instance of the other pass (the translucent command runs over the
 * opaque wagons too, see the header) collapses behind the far plane.
 */
const VERTEX_SHADER = /* glsl */ `
in vec3 a_position;
in vec3 a_normal;
in vec4 a_color;
in vec2 a_uv;
in vec3 a_high;
in vec3 a_low;
in vec3 a_col0;
in vec3 a_col1;
in vec3 a_col2;
in vec3 a_tint;
in float a_alpha;
in vec4 a_pickColor;

uniform float u_translucentPass;

out vec3 v_positionEC;
out vec3 v_normalEC;
out vec3 v_color;
out vec2 v_uv;
out vec3 v_tint;
out float v_alpha;
out vec4 v_pickColor;

void main()
{
    bool translucent = a_alpha < ${OPAQUE_ALPHA};
    bool drawn = a_alpha > 0.0 && (translucent == (u_translucentPass > 0.5));
    mat3 rotation = mat3(a_col0, a_col1, a_col2);
    vec4 centerEC = czm_modelViewRelativeToEye * czm_translateRelativeToEye(a_high, a_low);
    vec3 positionEC = centerEC.xyz + czm_viewRotation * (rotation * a_position);
    v_positionEC = positionEC;
    v_normalEC = normalize(czm_viewRotation * (rotation * a_normal));
    gl_Position = drawn ? czm_projection * vec4(positionEC, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
#ifdef LOG_DEPTH
    czm_vertexLogDepth();
#endif
    v_color = a_color.rgb;
    v_uv = a_uv;
    v_tint = a_tint;
    v_alpha = a_alpha;
    v_pickColor = a_pickColor;
}
`

/*
 * The Model's shading, in short: the metallic-roughness material from
 * the vertex colour and the palette texel, lit by the sun with
 * czm_pbrLighting, an ambient share for the sky, the glazing lit from
 * inside at night, tonemapped and converted to sRGB the way the Model's
 * lighting stage ends, and the line colour mixed over the lit body
 * last, as the Model's colour stage does it (ColorBlendMode.MIX).
 */
const FRAGMENT_SHADER = /* glsl */ `
in vec3 v_positionEC;
in vec3 v_normalEC;
in vec3 v_color;
in vec2 v_uv;
in vec3 v_tint;
in float v_alpha;
in vec4 v_pickColor;

uniform sampler2D u_palette;
uniform float u_tintAmount;
uniform float u_windowGlow;
uniform float u_ambient;

void main()
{
    vec3 base = v_color;
    vec2 metallicRoughness = texture(u_palette, v_uv).gb;
    float roughness = clamp(metallicRoughness.x, 0.04, 1.0);
    float metallic = clamp(metallicRoughness.y, 0.0, 1.0);

    czm_modelMaterial material;
    material.baseColor = vec4(base, 1.0);
    material.diffuse = mix(base, vec3(0.0), metallic);
    material.alpha = v_alpha;
    material.specular = mix(vec3(0.04), base, metallic);
    material.roughness = roughness;
    material.normalEC = normalize(v_normalEC) * (gl_FrontFacing ? 1.0 : -1.0);
    material.occlusion = 1.0;
    material.emissive = vec3(0.0);
    // The glazing is by far the darkest surface (see VehicleLayer's
    // WINDOW_GLOW_LUMINANCE_CUTOFF): it lights up warm as night falls
    float luminance = dot(material.diffuse, vec3(0.2126, 0.7152, 0.0722));
    if (luminance < 0.075)
    {
        material.emissive += vec3(1.0, 0.83, 0.52) * u_windowGlow;
    }

    vec3 viewDirection = -normalize(v_positionEC);
    vec3 lightDirection = normalize(czm_lightDirectionEC);
    vec3 color = czm_lightColorHdr * czm_pbrLighting(viewDirection, material.normalEC, lightDirection, material);
    // The sky: a diffuse share, and its reflection in the smooth
    // surfaces – the glazing above all, which the Model's environment
    // map lights noticeably (chosen beside a Model, see AMBIENT_DAY)
    color += material.diffuse * u_ambient;
    color += material.specular * (1.0 - roughness) * u_ambient * ${SKY_REFLECTION};
    color += material.emissive;
    color = czm_pbrNeutralTonemapping(color);
    color = czm_linearToSrgb(color);
    // The line colour over the LIT body, as the Model's colour stage
    // mixes it (after its lighting stage, in sRGB)
    color = mix(color, v_tint, u_tintAmount);
    out_FragColor = vec4(color, v_alpha);
}
`

/** The one primitive of a wagon's GLB, as the vertex array wants it. */
interface WagonGeometry {
  positions: Float32Array
  normals: Float32Array
  /** RGBA bytes, normalized in the shader. */
  colors: Uint8Array
  /** Unsigned shorts, normalized in the shader. */
  uvs: Uint16Array
  indices: Uint16Array
  /** The palette PNG's bytes. */
  palettePng: Uint8Array
  /** The vertices' extent, for the bounding sphere's margin. */
  radius: number
}

/**
 * Reads the one primitive out of a GLB's JSON header and binary chunk.
 * The models are written by the workshop in one shape (one node, one
 * mesh, one primitive, the attributes named here, unsigned short
 * indices, one PNG image) and nothing else is read.
 */
export function parseWagonGlb(bytes: ArrayBuffer): WagonGeometry {
  const view = new DataView(bytes)
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB')
  const jsonLength = view.getUint32(12, true)
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, jsonLength))) as {
    bufferViews: { byteOffset?: number; byteLength: number }[]
    accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string }[]
    meshes: { primitives: { attributes: Record<string, number>; indices: number }[] }[]
    images?: { bufferView: number }[]
  }
  const binOffset = 20 + jsonLength + 8
  const binLength = view.getUint32(20 + jsonLength, true)
  const bin = new Uint8Array(bytes, binOffset, binLength)
  const viewBytes = (index: number): Uint8Array => {
    const bufferView = json.bufferViews[index]
    return bin.subarray(bufferView.byteOffset ?? 0, (bufferView.byteOffset ?? 0) + bufferView.byteLength)
  }
  const components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
  const accessor = (index: number): { data: Uint8Array; count: number; componentType: number; size: number } => {
    const a = json.accessors[index]
    const size = components[a.type]
    const bufferView = json.bufferViews[a.bufferView]
    const start = (bufferView.byteOffset ?? 0) + (a.byteOffset ?? 0)
    const bytesPer = a.componentType === 5126 ? 4 : a.componentType === 5123 ? 2 : 1
    return { data: bin.subarray(start, start + a.count * size * bytesPer), count: a.count, componentType: a.componentType, size }
  }
  const primitive = json.meshes[0].primitives[0]
  const floats = (index: number): Float32Array => {
    const { data, count, size } = accessor(index)
    const copy = new Uint8Array(data.length)
    copy.set(data)
    return new Float32Array(copy.buffer, 0, count * size)
  }
  const shorts = (index: number): Uint16Array => {
    const { data, count, size } = accessor(index)
    const copy = new Uint8Array(data.length)
    copy.set(data)
    return new Uint16Array(copy.buffer, 0, count * size)
  }
  const bytesOf = (index: number): Uint8Array => {
    const { data } = accessor(index)
    const copy = new Uint8Array(data.length)
    copy.set(data)
    return copy
  }
  // Cesium's own axis correction for a glTF – Y up and Z forward in the
  // file, Z up and X forward in the Model (ModelUtility.getAxisCorrectionMatrix:
  // Y_UP_TO_Z_UP then Z_UP_TO_X_UP, which together take (x, y, z) to
  // (z, x, y)) – baked into the vertices, so an instance matrix is the
  // very modelMatrix the Model took
  const positions = correctAxes(floats(primitive.attributes.POSITION))
  const normals = correctAxes(floats(primitive.attributes.NORMAL))
  let radius = 0
  for (let i = 0; i < positions.length; i += 3) {
    radius = Math.max(radius, Math.hypot(positions[i], positions[i + 1], positions[i + 2]))
  }
  const image = json.images?.[0]
  if (!image) throw new Error('a wagon GLB without its palette')
  const palette = viewBytes(image.bufferView)
  const palettePng = new Uint8Array(palette.length)
  palettePng.set(palette)
  return {
    positions,
    normals,
    colors: bytesOf(primitive.attributes.COLOR_0),
    uvs: shorts(primitive.attributes.TEXCOORD_0),
    indices: shorts(primitive.indices),
    palettePng,
    radius,
  }
}

/** glTF's Y-up, Z-forward to Cesium's Z-up, X-forward: (x, y, z) → (z, x, y), in place. */
function correctAxes(vectors: Float32Array): Float32Array {
  for (let i = 0; i < vectors.length; i += 3) {
    const x = vectors[i]
    const y = vectors[i + 1]
    const z = vectors[i + 2]
    vectors[i] = z
    vectors[i + 1] = x
    vectors[i + 2] = y
  }
  return vectors
}

/** Everything that needs the GL context – built on the first frame drawn. */
interface BatchResources {
  buffers: Buffer[]
  indexBuffer: IndexBuffer
  instances: Buffer
  vertexArray: VertexArray
  palette: Texture
  opaque: DrawCommand
  translucent: DrawCommand
}

/**
 * A double as the two floats the relative-to-eye transform takes (the
 * stop discs' splitDouble): exact in float32 for anything on the globe.
 */
function splitDouble(value: number): [high: number, low: number] {
  const magnitude = Math.floor(Math.abs(value) / 65536) * 65536
  return value >= 0 ? [magnitude, value - magnitude] : [-magnitude, value + magnitude]
}

/**
 * The wagons of one model. Slots are handed out per wagon and kept for
 * the wagon's life (allocate / release); the pose, tint and opacity are
 * written per tick (write) or taken off the map (hide).
 */
export class WagonBatch {
  /** The per-slot buffer, every wagon of the model – exposed for the tests that pin the packing. */
  instances: Float32Array
  private pickBytes: Uint8Array
  private capacity = INITIAL_CAPACITY
  /**
   * What the GPU draws: the shown slots packed together, the opaque
   * ones first, then the ghosts. A hidden wagon costs the shader
   * nothing then – with every slot drawn and the hidden ones collapsed
   * in the vertex shader, Berlin's 2 900 wagons went through the vertex
   * stage of every cascade of the shadow map and both passes for the
   * 300 in range, and the GPU frame grew where it should have shrunk.
   */
  private drawn: Float32Array
  private drawnOpaque = 0
  private drawnTranslucent = 0
  /** Slots in use, and the pick object of each (the id scene.pick answers with). */
  private readonly pickObjects: (unknown | undefined)[] = []
  private readonly pickIds: (PickId | undefined)[] = []
  private readonly free: number[] = []
  private used = 0
  private geometry: WagonGeometry | null = null
  private paletteImage: ImageBitmap | null = null
  private failed = false
  private resources: BatchResources | null = null
  private dirty = true
  private rebuild = false
  private readonly boundingSphere = new BoundingSphere(Cartesian3.ZERO, 0)
  private destroyed = false

  constructor(
    readonly uri: string,
    private readonly host: WagonBatchHost,
    load: Promise<ArrayBuffer>,
  ) {
    this.instances = new Float32Array(this.capacity * FLOATS_PER_INSTANCE)
    this.pickBytes = new Uint8Array(this.instances.buffer)
    this.drawn = new Float32Array(this.capacity * FLOATS_PER_INSTANCE)
    void load
      .then(async (bytes) => {
        const geometry = parseWagonGlb(bytes)
        const image = await decodePalette(geometry.palettePng)
        if (this.destroyed) return
        this.geometry = geometry
        this.paletteImage = image
        this.host.requestRender()
      })
      .catch((error: unknown) => {
        this.failed = true
        if (typeof console !== 'undefined') {
          console.warn(`[MiniGermany3D] Wagon model ${uri} could not be read:`, error)
        }
      })
  }

  /** Whether the geometry is in – the batch draws nothing before. */
  get ready(): boolean {
    return this.geometry !== null && !this.failed
  }

  /** Slots in use. */
  get count(): number {
    return this.used
  }

  /** A slot for one wagon, with the object scene.pick answers with for it. Hidden until written. */
  allocate(pickObject: unknown): number {
    let slot: number
    if (this.free.length > 0) {
      slot = this.free.pop() as number
    } else {
      slot = this.used
      if (slot >= this.capacity) this.grow()
    }
    this.used = Math.max(this.used, slot + 1)
    this.pickObjects[slot] = pickObject
    this.pickIds[slot]?.destroy()
    this.pickIds[slot] = undefined
    this.instances.fill(0, slot * FLOATS_PER_INSTANCE, (slot + 1) * FLOATS_PER_INSTANCE)
    this.dirty = true
    return slot
  }

  /** The wagon left the map: its slot goes back to the pool. */
  release(slot: number): void {
    this.instances[slot * FLOATS_PER_INSTANCE + ALPHA_OFFSET] = 0
    this.pickObjects[slot] = undefined
    this.pickIds[slot]?.destroy()
    this.pickIds[slot] = undefined
    this.free.push(slot)
    this.dirty = true
  }

  /**
   * The wagon's pose (a world matrix with uniform scale, as the Model
   * had), the line colour it is tinted with and its opacity – 1 solid,
   * under that a ghost in the translucent pass.
   */
  write(slot: number, matrix: Matrix4, tint: Color, alpha: number): void {
    const base = slot * FLOATS_PER_INSTANCE
    const instances = this.instances
    const [hx, lx] = splitDouble(matrix[12])
    const [hy, ly] = splitDouble(matrix[13])
    const [hz, lz] = splitDouble(matrix[14])
    instances[base] = hx
    instances[base + 1] = hy
    instances[base + 2] = hz
    instances[base + 3] = lx
    instances[base + 4] = ly
    instances[base + 5] = lz
    // Column-major: the upper 3×3's columns as the shader's mat3 wants them
    instances[base + COLUMNS_OFFSET] = matrix[0]
    instances[base + COLUMNS_OFFSET + 1] = matrix[1]
    instances[base + COLUMNS_OFFSET + 2] = matrix[2]
    instances[base + COLUMNS_OFFSET + 3] = matrix[4]
    instances[base + COLUMNS_OFFSET + 4] = matrix[5]
    instances[base + COLUMNS_OFFSET + 5] = matrix[6]
    instances[base + COLUMNS_OFFSET + 6] = matrix[8]
    instances[base + COLUMNS_OFFSET + 7] = matrix[9]
    instances[base + COLUMNS_OFFSET + 8] = matrix[10]
    instances[base + TINT_OFFSET] = tint.red
    instances[base + TINT_OFFSET + 1] = tint.green
    instances[base + TINT_OFFSET + 2] = tint.blue
    instances[base + ALPHA_OFFSET] = alpha
    this.dirty = true
  }

  /** The wagon's body is out of range: not drawn, the slot kept. */
  hide(slot: number): void {
    const at = slot * FLOATS_PER_INSTANCE + ALPHA_OFFSET
    if (this.instances[at] === 0) return
    this.instances[at] = 0
    this.dirty = true
  }

  /** The opacity a slot is drawn with (0 hidden) – the tests' and the debug API's reading. */
  alphaOf(slot: number): number {
    return this.instances[slot * FLOATS_PER_INSTANCE + ALPHA_OFFSET]
  }

  /** The tint a slot is drawn with. */
  tintOf(slot: number): Color {
    const base = slot * FLOATS_PER_INSTANCE + TINT_OFFSET
    return new Color(this.instances[base], this.instances[base + 1], this.instances[base + 2], 1)
  }

  private grow(): void {
    const capacity = this.capacity * 2
    const instances = new Float32Array(capacity * FLOATS_PER_INSTANCE)
    instances.set(this.instances)
    this.instances = instances
    this.pickBytes = new Uint8Array(instances.buffer)
    this.drawn = new Float32Array(capacity * FLOATS_PER_INSTANCE)
    this.capacity = capacity
    this.rebuild = true
    this.dirty = true
  }

  /** The shown slots packed into the draw buffer, opaque ones first (see `drawn`). Public for the test that pins the order. */
  pack(): void {
    const instances = this.instances
    const drawn = this.drawn
    let at = 0
    for (let pass = 0; pass < 2; pass++) {
      for (let slot = 0; slot < this.used; slot++) {
        const base = slot * FLOATS_PER_INSTANCE
        const alpha = instances[base + ALPHA_OFFSET]
        if (alpha <= 0) continue
        const translucent = alpha < OPAQUE_ALPHA
        if (translucent !== (pass === 1)) continue
        drawn.set(instances.subarray(base, base + FLOATS_PER_INSTANCE), at)
        at += FLOATS_PER_INSTANCE
      }
      if (pass === 0) this.drawnOpaque = at / FLOATS_PER_INSTANCE
    }
    this.drawnTranslucent = at / FLOATS_PER_INSTANCE - this.drawnOpaque
  }

  /** Wagons drawn this frame – opaque and ghosted (tests and the debug API). */
  get drawnCount(): { opaque: number; translucent: number } {
    return { opaque: this.drawnOpaque, translucent: this.drawnTranslucent }
  }

  /** The opacity of the n-th wagon in the packed draw buffer (the test that pins the order). */
  drawnAlphaAt(index: number): number {
    return this.drawn[index * FLOATS_PER_INSTANCE + ALPHA_OFFSET]
  }

  /** Every pick colour in place – a slot allocated since the last frame gets one. */
  private writePickColours(frameState: FrameState): void {
    for (let slot = 0; slot < this.used; slot++) {
      const object = this.pickObjects[slot]
      if (object === undefined || this.pickIds[slot]) continue
      const pickId = frameState.context.createPickId(object)
      this.pickIds[slot] = pickId
      const at = (slot * FLOATS_PER_INSTANCE + PICK_OFFSET) * 4
      this.pickBytes[at] = Math.round(pickId.color.red * 255)
      this.pickBytes[at + 1] = Math.round(pickId.color.green * 255)
      this.pickBytes[at + 2] = Math.round(pickId.color.blue * 255)
      this.pickBytes[at + 3] = Math.round(pickId.color.alpha * 255)
      this.dirty = true
    }
  }

  /** The sphere around the drawn wagons, for the scene's culling and the shadow map's. */
  private updateBounds(): void {
    const instances = this.instances
    let n = 0
    let cx = 0
    let cy = 0
    let cz = 0
    for (let slot = 0; slot < this.used; slot++) {
      const base = slot * FLOATS_PER_INSTANCE
      if (instances[base + ALPHA_OFFSET] <= 0) continue
      cx += instances[base] + instances[base + 3]
      cy += instances[base + 1] + instances[base + 4]
      cz += instances[base + 2] + instances[base + 5]
      n++
    }
    if (n === 0) {
      this.boundingSphere.radius = 0
      return
    }
    cx /= n
    cy /= n
    cz /= n
    let radius = 0
    for (let slot = 0; slot < this.used; slot++) {
      const base = slot * FLOATS_PER_INSTANCE
      if (instances[base + ALPHA_OFFSET] <= 0) continue
      const dx = instances[base] + instances[base + 3] - cx
      const dy = instances[base + 1] + instances[base + 4] - cy
      const dz = instances[base + 2] + instances[base + 5] - cz
      radius = Math.max(radius, dx * dx + dy * dy + dz * dz)
    }
    this.boundingSphere.center.x = cx
    this.boundingSphere.center.y = cy
    this.boundingSphere.center.z = cz
    this.boundingSphere.radius = Math.sqrt(radius) + (this.geometry?.radius ?? 0) * 4 + BOUNDS_MARGIN_M
  }

  private ensureResources(frameState: FrameState): BatchResources | null {
    if (this.resources && !this.rebuild) return this.resources
    const geometry = this.geometry
    const image = this.paletteImage
    if (!geometry || !image) return null
    const context = frameState.context
    if (!context.instancedArrays) return null
    if (this.resources) {
      // The instance buffer outgrew its vertex array: a new one over
      // the same geometry buffers. A VertexArray destroys the buffers
      // attached to it unless they say otherwise – every buffer here
      // does (vertexArrayDestroyable), and destroy() takes them down.
      this.resources.vertexArray.destroy()
      this.resources.instances.destroy()
    }
    this.rebuild = false
    const previous = this.resources
    const owned = <B extends Buffer>(buffer: B): B => {
      buffer.vertexArrayDestroyable = false
      return buffer
    }
    const buffers =
      previous?.buffers ??
      [geometry.positions, geometry.normals, geometry.colors, geometry.uvs].map((typedArray) =>
        owned(
          renderer.Buffer.createVertexBuffer({ context, typedArray, usage: renderer.BufferUsage.STATIC_DRAW }),
        ),
      )
    const indexBuffer =
      previous?.indexBuffer ??
      owned(
        renderer.Buffer.createIndexBuffer({
          context,
          typedArray: geometry.indices,
          usage: renderer.BufferUsage.STATIC_DRAW,
          indexDatatype: IndexDatatype.UNSIGNED_SHORT,
        }),
      )
    const instances = owned(
      renderer.Buffer.createVertexBuffer({
        context,
        typedArray: this.drawn,
        usage: renderer.BufferUsage.DYNAMIC_DRAW,
      }),
    )
    const perInstance = { vertexBuffer: instances, strideInBytes: STRIDE_BYTES, instanceDivisor: 1 }
    const perInstanceFloats = (index: number, components: number, offset: number) => ({
      ...perInstance,
      index,
      componentsPerAttribute: components,
      componentDatatype: ComponentDatatype.FLOAT,
      offsetInBytes: offset * 4,
    })
    const vertexArray = new renderer.VertexArray({
      context,
      indexBuffer,
      attributes: [
        {
          index: ATTRIBUTE_LOCATIONS.a_position,
          vertexBuffer: buffers[0],
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_normal,
          vertexBuffer: buffers[1],
          componentsPerAttribute: 3,
          componentDatatype: ComponentDatatype.FLOAT,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_color,
          vertexBuffer: buffers[2],
          componentsPerAttribute: 4,
          componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
          normalize: true,
        },
        {
          index: ATTRIBUTE_LOCATIONS.a_uv,
          vertexBuffer: buffers[3],
          componentsPerAttribute: 2,
          componentDatatype: ComponentDatatype.UNSIGNED_SHORT,
          normalize: true,
        },
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_high, 3, 0),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_low, 3, 3),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_col0, 3, COLUMNS_OFFSET),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_col1, 3, COLUMNS_OFFSET + 3),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_col2, 3, COLUMNS_OFFSET + 6),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_tint, 3, TINT_OFFSET),
        perInstanceFloats(ATTRIBUTE_LOCATIONS.a_alpha, 1, ALPHA_OFFSET),
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
    const palette =
      previous?.palette ??
      new renderer.Texture({
        context,
        width: image.width,
        height: image.height,
        pixelFormat: PixelFormat.RGBA,
        pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
        flipY: false,
        sampler: new renderer.Sampler({
          wrapS: renderer.TextureWrap.CLAMP_TO_EDGE,
          wrapT: renderer.TextureWrap.CLAMP_TO_EDGE,
          minificationFilter: renderer.TextureMinificationFilter.NEAREST,
          magnificationFilter: renderer.TextureMagnificationFilter.NEAREST,
        }),
        source: image,
      })
    const shaderProgram = renderer.ShaderProgram.fromCache({
      context,
      attributeLocations: ATTRIBUTE_LOCATIONS,
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: FRAGMENT_SHADER,
    })
    const uniforms = (translucentPass: number) => ({
      u_palette: () => palette,
      u_tintAmount: () => this.host.tintAmount,
      u_windowGlow: () => this.host.windowGlow,
      u_ambient: () => AMBIENT_DAY + (AMBIENT_NIGHT - AMBIENT_DAY) * this.host.night,
      u_translucentPass: () => translucentPass,
    })
    const common = {
      owner: this,
      boundingVolume: this.boundingSphere,
      modelMatrix: Matrix4.IDENTITY,
      primitiveType: PrimitiveType.TRIANGLES,
      count: indexBuffer.numberOfIndices,
      instanceCount: this.used,
      vertexArray,
      shaderProgram,
      pickId: 'v_pickColor',
    }
    const opaque = new renderer.DrawCommand({
      ...common,
      renderState: renderer.RenderState.fromCache({
        depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
        depthMask: true,
        cull: { enabled: true, face: CullFace.BACK },
      }),
      pass: renderer.Pass.OPAQUE,
      uniformMap: uniforms(0),
      castShadows: true,
      receiveShadows: false,
    })
    const translucent = new renderer.DrawCommand({
      ...common,
      renderState: renderer.RenderState.fromCache({
        depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
        depthMask: false,
        cull: { enabled: true, face: CullFace.BACK },
        blending: BlendingState.ALPHA_BLEND,
      }),
      pass: renderer.Pass.TRANSLUCENT,
      uniformMap: uniforms(1),
    })
    this.resources = { buffers, indexBuffer, instances, vertexArray, palette, opaque, translucent }
    this.dirty = true
    return this.resources
  }

  /**
   * Cesium's primitive contract. The render pass draws, the pick pass
   * picks; the offscreen passes (the surface picks) get nothing – the
   * layer's root is hidden for those anyway.
   */
  update(frameState: FrameState): void {
    if (this.destroyed || this.used === 0) return
    const passes = frameState.passes
    if (!(passes.render || passes.pick) || passes.offscreen) return
    const resources = this.ensureResources(frameState)
    if (!resources) return
    this.writePickColours(frameState)
    if (this.dirty) {
      this.pack()
      const count = this.drawnOpaque + this.drawnTranslucent
      if (count > 0) {
        resources.instances.copyFromArrayView(this.drawn.subarray(0, count * FLOATS_PER_INSTANCE), 0)
      }
      this.updateBounds()
      this.dirty = false
    }
    if (this.boundingSphere.radius === 0) return
    // The opaque pass draws the opaque wagons at the buffer's head, the
    // translucent pass the ghosts after them – each command runs over
    // the whole packed range and the shader collapses the other pass's
    if (this.drawnOpaque > 0) {
      resources.opaque.instanceCount = this.drawnOpaque
      frameState.commandList.push(resources.opaque)
    }
    if (this.drawnTranslucent > 0) {
      resources.translucent.instanceCount = this.drawnOpaque + this.drawnTranslucent
      frameState.commandList.push(resources.translucent)
    }
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const pickId of this.pickIds) pickId?.destroy()
    this.pickIds.length = 0
    const resources = this.resources
    this.resources = null
    if (!resources) return
    resources.vertexArray.destroy()
    resources.instances.destroy()
    for (const buffer of resources.buffers) buffer.destroy()
    resources.indexBuffer.destroy()
    resources.palette.destroy()
    resources.opaque.shaderProgram.destroy()
  }
}

/** What the batches read from the layer around them. */
export interface WagonBatchHost {
  requestRender(): void
  /** How much of the line colour covers the body (MODEL_TINT_AMOUNT). */
  readonly tintAmount: number
  /** The glazing's glow, 0 by day to WINDOW_GLOW_MAX at night. */
  readonly windowGlow: number
  /** The night ramp, 0 by day to 1 at night – the ambient light follows it. */
  readonly night: number
}

/** The palette PNG decoded as the texture wants it – no colour management, no premultiplication. */
async function decodePalette(png: Uint8Array): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap unavailable')
  return createImageBitmap(new Blob([png.slice().buffer as ArrayBuffer], { type: 'image/png' }), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  })
}

/**
 * The batches of a layer, one per wagon model, created on first use –
 * the GLB fetched once, however many vehicles ride it.
 */
export class InstancedWagons {
  private readonly batches = new Map<string, WagonBatch>()
  private destroyed = false

  constructor(
    private readonly host: WagonBatchHost,
    private readonly fetchModel: (uri: string) => Promise<ArrayBuffer>,
    private readonly attach: (batch: WagonBatch) => void,
  ) {}

  /** The batch of a model, made (and its GLB fetched) the first time it is asked for. */
  batch(uri: string): WagonBatch {
    let batch = this.batches.get(uri)
    if (!batch) {
      batch = new WagonBatch(uri, this.host, this.fetchModel(uri))
      this.batches.set(uri, batch)
      this.attach(batch)
    }
    return batch
  }

  /** Every batch, for the debug API. */
  get all(): readonly WagonBatch[] {
    return [...this.batches.values()]
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const batch of this.batches.values()) batch.destroy()
    this.batches.clear()
  }
}
