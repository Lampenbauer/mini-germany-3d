/**
 * Cesium's renderer classes, typed.
 *
 * The volumetric clouds (see CloudLayer) and the stop discs (StopDiscs)
 * draw with a DrawCommand of their own, the way Cesium's own primitives
 * do: a vertex array, a shader program, a render state, a texture or an
 * instance buffer, handed to the scene through a primitive's
 * update(frameState). All of that is exported by the
 * `cesium` package and stable enough that Cesium's own Sandcastle
 * examples build on it – but it is marked @private and left out of the
 * type declarations. This module is the one place that knows the shapes
 * this app relies on, so a Cesium upgrade that changes them fails here
 * and nowhere else – the one private class beyond the renderer included,
 * the Heap the request scheduler queues tile requests in.
 */

import * as Cesium from 'cesium'
import type {
  BoundingSphere,
  Color,
  ComponentDatatype,
  Geometry,
  Matrix4,
  PixelDatatype,
  PixelFormat,
} from 'cesium'
import type { ReadbackBufferPrototype } from './buffer-readback-cache'
import type { HeapPrototype } from './heap-trailing-reference'

/** The GL context of a scene (scene.context, private). */
export interface Context {
  /** True on a WebGL 2 context – 3D textures need one. */
  webgl2: boolean
  /** Instanced drawing – WebGL 2, or the ANGLE extension on WebGL 1. */
  instancedArrays: boolean
  /**
   * A colour for the pick pass and the object scene.pick returns for
   * it. Destroy it with what it stands for.
   */
  createPickId(object: unknown): PickId
}

export interface PickId {
  readonly color: Color
  destroy(): void
}

/** A vertex buffer (Buffer, private). */
export interface Buffer {
  copyFromArrayView(view: ArrayBufferView, offsetInBytes: number): void
  destroy(): void
  /**
   * Whether a VertexArray this buffer is attached to destroys it along
   * with itself (Cesium's default, true). A buffer shared between vertex
   * arrays – the wagons' geometry, under one array per growth of the
   * instance buffer – sets it false and is destroyed by its owner.
   */
  vertexArrayDestroyable: boolean
}

/** An index buffer (Buffer.createIndexBuffer, private). */
export interface IndexBuffer extends Buffer {
  readonly numberOfIndices: number
}

/** One attribute of a hand-built VertexArray. */
export interface VertexArrayAttribute {
  index: number
  vertexBuffer: Buffer
  componentsPerAttribute: number
  componentDatatype: ComponentDatatype
  normalize?: boolean
  offsetInBytes?: number
  strideInBytes?: number
  /** 1 steps the attribute once per instance rather than per vertex. */
  instanceDivisor?: number
}

export interface Sampler {
  readonly wrapS: number
}

export interface Texture {
  destroy(): void
}

export interface Texture3D extends Texture {
  generateMipmap(): void
}

export interface VertexArray {
  destroy(): void
}

export interface ShaderProgram {
  destroy(): void
}

export interface RenderState {
  readonly depthMask: boolean
}

export interface DrawCommand {
  boundingVolume: BoundingSphere
  modelMatrix: Matrix4
  shaderProgram: ShaderProgram
  vertexArray: VertexArray
  uniformMap: Record<string, () => unknown>
  renderState: RenderState
  /** Instances drawn – settable per frame where the set changes (the funnel smoke). */
  instanceCount: number
  /** Whether the scene's shadow map draws this command into its cascades. */
  castShadows: boolean
}

/** What a scene expects of an object in scene.primitives. */
export interface FrameState {
  context: Context
  commandList: DrawCommand[]
  /**
   * Which pass this update serves – a cloud draws in the render pass
   * only, a disc in the render and the pick pass, neither in the
   * offscreen ones (the ray picks and clampToHeight).
   */
  passes: { render: boolean; pick?: boolean; offscreen?: boolean }
}

interface RendererModule {
  Texture: new (options: {
    context: Context
    width: number
    height: number
    pixelFormat: PixelFormat
    pixelDatatype: PixelDatatype
    flipY?: boolean
    sampler?: Sampler
    /** Raw texels, or a decoded picture (an ImageBitmap – the wagons' palette). */
    source: { arrayBufferView: ArrayBufferView } | ImageBitmap
  }) => Texture
  Texture3D: new (options: {
    context: Context
    width: number
    height: number
    depth: number
    pixelFormat: PixelFormat
    pixelDatatype: PixelDatatype
    flipY?: boolean
    sampler?: Sampler
    source: { arrayBufferView: ArrayBufferView; width: number; height: number; depth: number }
  }) => Texture3D
  Sampler: new (options: {
    wrapS?: number
    wrapT?: number
    wrapR?: number
    minificationFilter?: number
    magnificationFilter?: number
  }) => Sampler
  TextureWrap: { REPEAT: number; CLAMP_TO_EDGE: number }
  TextureMinificationFilter: { NEAREST: number; LINEAR: number }
  TextureMagnificationFilter: { NEAREST: number; LINEAR: number }
  VertexArray: {
    new (options: {
      context: Context
      attributes: VertexArrayAttribute[]
      /** Indexed geometry – the wagons' triangles. */
      indexBuffer?: IndexBuffer
    }): VertexArray
    fromGeometry(options: {
      context: Context
      geometry: Geometry
      attributeLocations: Record<string, number>
    }): VertexArray
  }
  Buffer: {
    createVertexBuffer(options: { context: Context; typedArray: ArrayBufferView; usage: number }): Buffer
    createIndexBuffer(options: {
      context: Context
      typedArray: ArrayBufferView
      usage: number
      indexDatatype: number
    }): IndexBuffer
    /** The class's prototype – where the GPU readback cache is installed (buffer-readback-cache.ts). */
    prototype: ReadbackBufferPrototype
  }
  BufferUsage: { STATIC_DRAW: number; DYNAMIC_DRAW: number }
  ShaderProgram: {
    fromCache(options: {
      context: Context
      attributeLocations: Record<string, number>
      vertexShaderSource: string
      fragmentShaderSource: string
    }): ShaderProgram
  }
  RenderState: {
    fromCache(options: unknown): RenderState
  }
  DrawCommand: new (options: {
    owner: unknown
    boundingVolume: BoundingSphere
    modelMatrix: Matrix4
    primitiveType: number
    vertexArray: VertexArray
    shaderProgram: ShaderProgram
    uniformMap: Record<string, () => unknown>
    renderState: RenderState
    pass: number
    /** Vertices per draw – set it where the vertex array is instanced. */
    count?: number
    instanceCount?: number
    /**
     * A GLSL expression for the pick colour; with one set, the scene
     * derives a pick shader that writes it in place of the fragment.
     */
    pickId?: string
    /** Drawn into the shadow map's cascades (the scene derives the cast command). */
    castShadows?: boolean
    receiveShadows?: boolean
  }) => DrawCommand
  Pass: { OPAQUE: number; TRANSLUCENT: number }
  /**
   * Core/Heap.js – the queue RequestScheduler keeps a frame's tile
   * requests in. Its prototype is where the trailing-reference fix is
   * installed (heap-trailing-reference.ts); the rest is what its test reads.
   */
  Heap: {
    new <T>(options: { comparator: (a: T, b: T) => number }): Heap<T>
    prototype: HeapPrototype
  }
}

/** A Heap (Core/Heap.js, private): a priority queue, optionally capped. */
export interface Heap<T> {
  /** The cap: an insert past it pushes an element out and returns it. */
  maximumLength: number | undefined
  readonly length: number
  /** The backing array – it can be longer than the heap. */
  readonly internalArray: (T | undefined)[]
  insert(element: T): T | undefined
  pop(index?: number): T | undefined
}

/** The renderer classes, under the shapes above. */
export const renderer = Cesium as unknown as RendererModule

/** The GL context of a scene. */
export function sceneContext(scene: Cesium.Scene): Context {
  return (scene as unknown as { context: Context }).context
}
