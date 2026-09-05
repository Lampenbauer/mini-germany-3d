import type { BoundingBox } from '../../src/lib/city.ts'

export function overpassBbox(box: BoundingBox): string
export const OVERPASS_MIRRORS: readonly string[]
export const REQUEST_HEADERS: Record<string, string>
export const RETRY_DELAY_MS: number
export const ROUNDS: number
export function isTransientOverpassFailure(status: number | undefined): boolean
export function postOverpass(
  query: string,
  options?: {
    validate?: (answer: unknown) => boolean
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
    sleepImpl?: (ms: number) => Promise<void>
  },
): Promise<unknown>
