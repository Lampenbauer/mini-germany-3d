/**
 * Server-/Node-side extraction from a decoded GTFS-RT feed: filters the
 * Germany-wide TripUpdates down to the Rostock trip_ids and returns their
 * delays. Used by the Vite middleware (dev) and the unit tests; in
 * production api/realtime.php does the same thing in PHP.
 */

import type GtfsRealtimeBindings from 'gtfs-realtime-bindings'

type IFeedMessage = GtfsRealtimeBindings.transit_realtime.IFeedMessage

/**
 * Reads an optional delay field. Important: in decoded protobuf messages,
 * scalars that are NOT set return the default 0 via the prototype – only
 * own properties count as "present in the feed".
 */
function readDelay(holder: { delay?: number | null } | null | undefined): number | null {
  if (!holder) return null
  if (!Object.hasOwn(holder, 'delay')) return null
  const value = holder.delay
  return value === null || value === undefined ? null : value
}

/**
 * Delays per GTFS trip_id for all trips in `tripIds`.
 * Prefers trip_update.delay; otherwise the first stop-time delay.
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

/** Response format of the filtered realtime endpoint (/api/realtime). */
export interface RealtimeApiResponse {
  /** Feed header timestamp (Unix seconds), 0 if unknown. */
  timestamp: number
  /** Total number of entities in the original feed. */
  total: number
  /** GTFS trip_id → delay in seconds (Rostock trips only). */
  delays: Record<string, number>
}
