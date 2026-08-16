/**
 * GTFS-Realtime client: polls the FILTERED endpoint /api/realtime
 * (a few KB of JSON) instead of the raw gtfs.de feed (>10 MB protobuf).
 *
 * The filtering happens server-side – in the dev/preview server via a Vite
 * middleware (vite.config.ts), in production via api/realtime.php
 * (all-inkl web hosting: Apache + PHP). Both fetch the Germany feed at most
 * once per minute, filter it down to the Rostock trip_ids from
 * schedule.json, and cache the result – so all open browser tabs share a
 * single upstream fetch.
 */

import type { RealtimeApiResponse } from '@/lib/rt-extract'

export interface RealtimeStatus {
  state: 'connecting' | 'live' | 'error'
  /** Number of TripUpdates that were matched to a simulation trip. */
  matchedCount: number
  /** Total number of entities in the original feed. */
  totalEntities: number
  lastSuccessAt: number | null
  lastError: string | null
}

/** Maps the filtered GTFS delays to the simulation trips. */
export function mapDelaysToSimTrips(
  response: RealtimeApiResponse,
  tripIdMap: ReadonlyMap<string, string>,
): Map<string, number> {
  const delays = new Map<string, number>()
  for (const [gtfsTripId, delay] of Object.entries(response.delays ?? {})) {
    if (typeof delay !== 'number' || !Number.isFinite(delay)) continue
    const simId = tripIdMap.get(gtfsTripId)
    if (simId) delays.set(simId, delay)
  }
  return delays
}

export type RealtimeUpdateHandler = (
  status: RealtimeStatus,
  delays: Map<string, number>,
) => void

export class RealtimeClient {
  private timer: number | null = null
  private stopped = false
  private status: RealtimeStatus = {
    state: 'connecting',
    matchedCount: 0,
    totalEntities: 0,
    lastSuccessAt: null,
    lastError: null,
  }

  constructor(
    private readonly url: string,
    private readonly tripIdMap: ReadonlyMap<string, string>,
    private readonly onUpdate: RealtimeUpdateHandler,
  ) {}

  start(intervalMs = 60_000): void {
    this.stopped = false
    const tick = async () => {
      if (this.stopped) return
      await this.poll()
      if (!this.stopped) {
        this.timer = window.setTimeout(tick, intervalMs)
      }
    }
    void tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async poll(): Promise<void> {
    try {
      const response = await fetch(this.url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as RealtimeApiResponse
      if (typeof data !== 'object' || data === null || typeof data.delays !== 'object') {
        throw new Error('Unexpected response format from the realtime endpoint')
      }
      const delays = mapDelaysToSimTrips(data, this.tripIdMap)
      this.status = {
        state: 'live',
        matchedCount: delays.size,
        totalEntities: data.total ?? 0,
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      this.onUpdate(this.status, delays)
    } catch (error) {
      this.status = {
        ...this.status,
        state: 'error',
        lastError: String(error),
      }
      // On errors, do not keep using stale delays
      this.onUpdate(this.status, new Map())
    }
  }
}
