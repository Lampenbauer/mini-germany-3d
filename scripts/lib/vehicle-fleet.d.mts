/** Type declarations so the fleet generator can be unit-tested from Vitest. */

import type { Mesh } from './vehicle-mesh.mjs'

export const HEIGHTS: { tram: number; train: number; bus: number }
export const FLEET: Record<string, () => Mesh>
export function tramEnd(): Mesh
export function tramMid(opts?: { withPantograph?: boolean }): Mesh
export function sbahnEnd(): Mesh
export function sbahnMid(): Mesh
export function bus(): Mesh
