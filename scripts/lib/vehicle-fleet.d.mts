/** Type declarations so the fleet generator can be unit-tested from Vitest. */

import type { Mesh } from './vehicle-mesh.mjs'

export const HEIGHTS: { tram: number; train: number; bus: number; subway: number; sbahn490: number }
export const FLEET: Record<string, () => Mesh>
export function tramEnd(opts?: { doorSides?: number[] }): Mesh
export function tramMid(opts?: { withPantograph?: boolean }): Mesh
export function sbahnEnd(): Mesh
export function sbahnMid(): Mesh
export function bus(): Mesh
export function ferryGehlsdorf(): Mesh
export function ferryBreitling(): Mesh
export function ubahnEnd(): Mesh
export function ubahnMid(): Mesh
export function sbahn490End(): Mesh
export function sbahn490Mid(): Mesh
export function ferryHadag(): Mesh
