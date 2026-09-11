/** Type declarations so the vessel fleet can be unit-tested from Vitest. */

import type { Mesh } from './vehicle-mesh.mjs'

export const VESSEL_DIMS: Record<string, { length: number; width: number; height: number }>

export function vesselContainer(): Mesh
export function vesselCargo(): Mesh
export function vesselBarge(): Mesh
export function vesselDredger(): Mesh
export function vesselTender(): Mesh
export function vesselPilot(): Mesh
export function vesselTanker(): Mesh
export function vesselPassenger(): Mesh
export function vesselTug(): Mesh
export function vesselFishing(): Mesh
export function vesselSail(): Mesh
export function vesselMotor(): Mesh
export function vesselGeneric(): Mesh

export const VESSELS: Record<string, () => Mesh>

/** Half the hull's beam at a length z, as hull() builds it. */
export function hullHalfWidthAt(
  z: number,
  hull: { length: number; width: number; bow?: number; stern?: number; taper?: number },
): number
