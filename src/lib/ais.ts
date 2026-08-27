/**
 * AIS client: polls the filtered vessel endpoint /api/ais (served by the
 * Vite middleware in dev, by api/ais.php in production – see
 * src/lib/ais-extract.ts for the shared extraction) and hands the vessel
 * list to the app. Plus the ferry override: the simulated FG/FW ferries
 * snap onto their real AIS twins whenever a fresh fix is close by.
 */

import { deadReckon, type AisVessel } from '@/lib/ais-extract'

export interface AisStatus {
  state: 'connecting' | 'live' | 'error'
  vesselCount: number
  lastSuccessAt: number | null
  lastError: string | null
}

export type AisUpdateHandler = (status: AisStatus, vessels: AisVessel[]) => void

interface AisApiResponse {
  timestamp: number
  vessels: AisVessel[]
}

export class AisClient {
  private timer: number | null = null
  private stopped = false
  private vessels: AisVessel[] = []
  private status: AisStatus = {
    state: 'connecting',
    vesselCount: 0,
    lastSuccessAt: null,
    lastError: null,
  }

  constructor(
    private readonly url: string,
    private readonly onUpdate: AisUpdateHandler,
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
      const data = (await response.json()) as AisApiResponse
      if (typeof data !== 'object' || data === null || !Array.isArray(data.vessels)) {
        throw new Error('Unexpected response format from the AIS endpoint')
      }
      // The position stamps come from the server clock – shift them into
      // this browser's timeline so dead reckoning and expiry read them
      // correctly even against a skewed client clock.
      const skewMs = typeof data.timestamp === 'number' ? Date.now() - data.timestamp : 0
      for (const vessel of data.vessels) vessel.positionAt += skewMs
      this.vessels = data.vessels
      this.status = {
        state: 'live',
        vesselCount: data.vessels.length,
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      this.onUpdate(this.status, this.vessels)
    } catch (error) {
      this.status = { ...this.status, state: 'error', lastError: String(error) }
      // Unlike GTFS delays, the last picture stays up on errors: the
      // reckoning cap freezes the ships in place, and the layer's expiry
      // clears them if the outage lasts.
      this.onUpdate(this.status, this.vessels)
    }
  }
}

/** The slice of a vehicle snapshot the ferry override touches. */
export interface FerrySnapshotLike {
  lineId: string
  mode: string
  lon: number
  lat: number
  bearing: number
}

/** AIS fixes older than this cannot stand in for a ferry. */
const FERRY_FIX_MAX_AGE_MS = 3 * 60_000
/** Beyond this GTFS-to-AIS distance the fix belongs to no simulated trip. */
const FERRY_SNAP_MAX_METERS = 500

const METERS_PER_DEGREE_LATITUDE = 111_320

function distanceMeters(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const dLat = (aLat - bLat) * METERS_PER_DEGREE_LATITUDE
  const dLon = (aLon - bLon) * METERS_PER_DEGREE_LATITUDE * Math.cos((aLat * Math.PI) / 180)
  return Math.hypot(dLat, dLon)
}

/**
 * Moves the simulated ferries onto their real AIS positions. Vessels are
 * mapped to lines via `ferryLineByMmsi`; within a line, fixes and active
 * trips pair up greedily by distance, so on the two-vessel Warnemünde
 * crossing each boat corrects its own trip. Snapshots without a fresh fix
 * in range stay on their timetable position – AIS gaps degrade gracefully
 * to the simulation. Returns how many snapshots were overridden.
 */
export function overrideFerryPositions<T extends FerrySnapshotLike>(
  snapshots: T[],
  vessels: AisVessel[],
  ferryLineByMmsi: Record<number, string>,
  nowMs: number,
): number {
  const pairs: { snapshot: T; vessel: AisVessel; distance: number }[] = []
  for (const vessel of vessels) {
    const lineId = ferryLineByMmsi[vessel.mmsi]
    if (!lineId || nowMs - vessel.positionAt > FERRY_FIX_MAX_AGE_MS) continue
    for (const snapshot of snapshots) {
      if (snapshot.mode !== 'ferry' || snapshot.lineId !== lineId) continue
      const distance = distanceMeters(snapshot.lon, snapshot.lat, vessel.lon, vessel.lat)
      if (distance <= FERRY_SNAP_MAX_METERS) pairs.push({ snapshot, vessel, distance })
    }
  }
  pairs.sort((a, b) => a.distance - b.distance)

  const usedSnapshots = new Set<T>()
  const usedVessels = new Set<AisVessel>()
  let overridden = 0
  for (const { snapshot, vessel } of pairs) {
    if (usedSnapshots.has(snapshot) || usedVessels.has(vessel)) continue
    usedSnapshots.add(snapshot)
    usedVessels.add(vessel)
    const reckoned = deadReckon(vessel, nowMs)
    snapshot.lon = reckoned.lon
    snapshot.lat = reckoned.lat
    // A moored ferry reports no usable course – keep the timetable bearing
    // then, it points along the crossing.
    if (vessel.headingDeg !== null || vessel.cogDeg !== null) {
      snapshot.bearing = reckoned.bearingDeg
    }
    overridden++
  }
  return overridden
}
