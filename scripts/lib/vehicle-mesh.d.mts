/** Type declarations so the mesh library can be unit-tested from Vitest. */

export interface MeshGroup {
  positions: number[]
  normals: number[]
  indices: number[]
}

export interface Mesh {
  groups: Map<string, MeshGroup>
}

export const MATERIALS: Record<
  string,
  { color: [number, number, number, number]; metallic: number; roughness: number }
>

export function createMesh(): Mesh
export function quad(
  mesh: Mesh,
  material: string,
  a: number[],
  b: number[],
  c: number[],
  d: number[],
): void
export function box(
  mesh: Mesh,
  material: string,
  cx: number,
  cy: number,
  cz: number,
  sx: number,
  sy: number,
  sz: number,
): void
export function bodyProfile(w: number, y0: number, y1: number, bevel: number): [number, number][]
export function extrude(
  mesh: Mesh,
  profile: [number, number][],
  stations: { z: number; sx?: number; sy?: number; yOff?: number; material?: string }[],
  opts?: { material?: string; yAnchor?: number; capMaterials?: [string, string] },
): void
export function windowBand(
  mesh: Mesh,
  w: number,
  y0: number,
  y1: number,
  z0: number,
  z1: number,
  opts?: { panes?: number },
): void
export function doors(mesh: Mesh, w: number, y0: number, y1: number, z: number, leafWidth?: number): void
export function pantograph(mesh: Mesh, roofY: number, z: number): void
export function bogie(mesh: Mesh, y0: number, z: number, width: number): void
export function toGlb(mesh: Mesh, opts: { name: string }): Uint8Array
export function triangleCount(mesh: Mesh): number
