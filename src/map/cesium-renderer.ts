/**
 * Cesium's renderer classes, typed.
 *
 * The volumetric clouds (see CloudLayer) draw with a DrawCommand of their
 * own, the way Cesium's own primitives do: a vertex array, a shader
 * program, a render state and a 3D texture, handed to the scene through
 * a primitive's update(frameState). All of that is exported by the
 * `cesium` package and stable enough that Cesium's own Sandcastle
 * examples build on it – but it is marked @private and left out of the
 * type declarations. This module is the one place that knows the shapes
 * this app relies on, so a Cesium upgrade that changes them fails here
 * and nowhere else.
 */

import * as Cesium from 'cesium'
import type { BoundingSphere, Geometry, Matrix4, PixelDatatype, PixelFormat } from 'cesium'

/** The GL context of a scene (scene.context, private). */
export interface Context {
  /** True on a WebGL 2 context – 3D textures need one. */
  webgl2: boolean
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
}

/** What a scene expects of an object in scene.primitives. */
export interface FrameState {
  context: Context
  commandList: DrawCommand[]
  /** Which pass this update serves – a cloud draws in the render pass only. */
  passes: { render: boolean }
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
    source: { arrayBufferView: ArrayBufferView }
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
  VertexArray: {
    fromGeometry(options: {
      context: Context
      geometry: Geometry
      attributeLocations: Record<string, number>
    }): VertexArray
  }
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
  }) => DrawCommand
  Pass: { TRANSLUCENT: number }
}

/** The renderer classes, under the shapes above. */
export const renderer = Cesium as unknown as RendererModule

/** The GL context of a scene. */
export function sceneContext(scene: Cesium.Scene): Context {
  return (scene as unknown as { context: Context }).context
}
