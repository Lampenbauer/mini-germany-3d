/** Type declarations so the buoy fleet can be unit-tested from Vitest. */

import type { Mesh } from './vehicle-mesh.mjs'

export type BuoyShapeName = 'pillar' | 'spar' | 'can' | 'conical' | 'spherical' | 'barrel'
export type BuoyColourName = 'red' | 'green' | 'yellow'

export const BUOY_SHAPES: Record<BuoyShapeName, { height: number; lightHeight: number; radius: number }>
export const BUOY_COLOURS: readonly BuoyColourName[]

export function pillar(colour: BuoyColourName): Mesh
export function spar(colour: BuoyColourName): Mesh
export function can(colour: BuoyColourName): Mesh
export function conical(colour: BuoyColourName): Mesh
export function spherical(colour: BuoyColourName): Mesh
export function barrel(colour: BuoyColourName): Mesh

export const BUOYS: Record<string, () => Mesh>
