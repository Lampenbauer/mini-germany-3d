/**
 * Server-/Node-seitige Extraktion aus einem dekodierten GTFS-RT-Feed:
 * filtert die deutschlandweiten TripUpdates auf die Rostocker trip_ids und
 * liefert deren Verspätungen. Wird von der Vite-Middleware (Dev) und den
 * Unit-Tests genutzt; in Produktion macht api/realtime.php das Gleiche in PHP.
 */

import type GtfsRealtimeBindings from 'gtfs-realtime-bindings'

type IFeedMessage = GtfsRealtimeBindings.transit_realtime.IFeedMessage

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
 * Verspätungen je GTFS-trip_id für alle Fahrten aus `tripIds`.
 * Bevorzugt trip_update.delay; sonst die erste Stop-Time-Verspätung.
 */
export function extractGtfsDelays(
  feed: IFeedMessage,
  tripIds: ReadonlySet<string>,
): Record<string, number> {
  const delays: Record<string, number> = {}
  for (const entity of feed.entity ?? []) {
    const tripUpdate = entity.tripUpdate
    const gtfsTripId = tripUpdate?.trip?.tripId
    if (!gtfsTripId || !tripIds.has(gtfsTripId)) continue

    let delay = readDelay(tripUpdate)
    if (delay === null) {
      for (const stu of tripUpdate.stopTimeUpdate ?? []) {
        delay = readDelay(stu.departure) ?? readDelay(stu.arrival)
        if (delay !== null) break
      }
    }
    if (delay === null) continue
    delays[gtfsTripId] = delay
  }
  return delays
}

/** Antwortformat des gefilterten Realtime-Endpunkts (/api/realtime). */
export interface RealtimeApiResponse {
  /** Feed-Header-Timestamp (Unix-Sekunden), 0 wenn unbekannt. */
  timestamp: number
  /** Gesamtzahl der Entities im Original-Feed. */
  total: number
  /** GTFS-trip_id → Verspätung in Sekunden (nur Rostocker Fahrten). */
  delays: Record<string, number>
}
