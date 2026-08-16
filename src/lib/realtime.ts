/**
 * GTFS-Realtime-Client für den freien Deutschland-Feed von gtfs.de
 * (https://realtime.gtfs.de/realtime-free.pb).
 *
 * Der Feed liefert TripUpdates (Verspätungen) – KEINE Fahrzeugpositionen.
 * Die trip_ids passen zum statischen gtfs.de-Feed; schedule.json speichert
 * sie seit `npm run data:gtfs` parallel zu den Abfahrten, sodass Updates den
 * Simulations-Fahrten zugeordnet werden können.
 *
 * Hinweis CORS: Der Feed selbst sendet keine CORS-Header. Im Dev-Server
 * übernimmt der Vite-Proxy (/gtfs-rt → realtime.gtfs.de, siehe
 * vite.config.ts); ein Produktions-Deployment braucht einen entsprechenden
 * Reverse-Proxy.
 */

import GtfsRealtimeBindings from 'gtfs-realtime-bindings'

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime
type IFeedMessage = GtfsRealtimeBindings.transit_realtime.IFeedMessage

export interface RealtimeStatus {
  state: 'connecting' | 'live' | 'error'
  /** Anzahl der TripUpdates, die einer Simulations-Fahrt zugeordnet wurden. */
  matchedCount: number
  /** Gesamtzahl der Entities im Feed. */
  totalEntities: number
  lastSuccessAt: number | null
  lastError: string | null
}

/**
 * Liest ein optionales delay-Feld. Wichtig: Bei dekodierten
 * Protobuf-Nachrichten liefern NICHT gesetzte Skalare den Default 0 über
 * den Prototyp – nur eigene Properties gelten als "im Feed vorhanden".
 */
function readDelay(holder: { delay?: number | null } | null | undefined): number | null {
  if (!holder) return null
  if (!Object.hasOwn(holder, 'delay')) return null
  const value = holder.delay
  return value === null || value === undefined ? null : value
}

/**
 * Extrahiert Verspätungen (Simulations-Fahrt-ID → Sekunden) aus einem Feed.
 * Bevorzugt trip_update.delay; sonst die erste Stop-Time-Verspätung.
 */
export function extractDelays(
  feed: IFeedMessage,
  tripIdMap: ReadonlyMap<string, string>,
): Map<string, number> {
  const delays = new Map<string, number>()
  for (const entity of feed.entity ?? []) {
    const tripUpdate = entity.tripUpdate
    const gtfsTripId = tripUpdate?.trip?.tripId
    if (!gtfsTripId) continue
    const simId = tripIdMap.get(gtfsTripId)
    if (!simId) continue

    let delay = readDelay(tripUpdate)
    if (delay === null) {
      for (const stu of tripUpdate.stopTimeUpdate ?? []) {
        delay = readDelay(stu.departure) ?? readDelay(stu.arrival)
        if (delay !== null) break
      }
    }
    if (delay === null) continue
    delays.set(simId, delay)
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

  start(intervalMs = 30_000): void {
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
      const buffer = new Uint8Array(await response.arrayBuffer())
      const feed = FeedMessage.decode(buffer)
      const delays = extractDelays(feed, this.tripIdMap)
      this.status = {
        state: 'live',
        matchedCount: delays.size,
        totalEntities: feed.entity?.length ?? 0,
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
