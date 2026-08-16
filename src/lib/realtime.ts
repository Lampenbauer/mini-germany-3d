/**
 * GTFS-Realtime-Client: pollt den GEFILTERTEN Endpunkt /api/realtime
 * (wenige KB JSON) statt des rohen gtfs.de-Feeds (>10 MB Protobuf).
 *
 * Die Filterung passiert serverseitig – im Dev-/Preview-Server durch eine
 * Vite-Middleware (vite.config.ts), in Produktion durch api/realtime.php
 * (all-inkl-Webhosting: Apache + PHP). Beide laden den Deutschland-Feed
 * höchstens einmal pro Minute, filtern ihn auf die Rostocker trip_ids aus
 * schedule.json und cachen das Ergebnis – alle offenen Browser-Tabs teilen
 * sich so einen einzigen Upstream-Abruf.
 */

import type { RealtimeApiResponse } from '@/lib/rt-extract'

export interface RealtimeStatus {
  state: 'connecting' | 'live' | 'error'
  /** Anzahl der TripUpdates, die einer Simulations-Fahrt zugeordnet wurden. */
  matchedCount: number
  /** Gesamtzahl der Entities im Original-Feed. */
  totalEntities: number
  lastSuccessAt: number | null
  lastError: string | null
}

/** Ordnet die gefilterten GTFS-Verspätungen den Simulations-Fahrten zu. */
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
        throw new Error('Unerwartetes Antwortformat des Realtime-Endpunkts')
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
      // Bei Fehlern keine veralteten Verspätungen weiterverwenden
      this.onUpdate(this.status, new Map())
    }
  }
}
