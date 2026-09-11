/** Type declarations so the aircraft fleet can be unit-tested from Vitest. */

import type { Mesh } from './vehicle-mesh.mjs'

export const AIRCRAFT_DIMS: Record<string, { length: number; width: number; height: number }>

export function aircraftNarrowbody(): Mesh
export function aircraftWidebody(): Mesh
export function aircraftJumbo(): Mesh
export function aircraftBizjet(): Mesh
export function aircraftTurboprop(): Mesh
export function aircraftLight(): Mesh
export function aircraftHelicopter(): Mesh

export const AIRCRAFT: Record<string, () => Mesh>
