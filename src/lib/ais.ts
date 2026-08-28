/**
 * AIS client: polls the filtered vessel endpoint /api/ais (served by the
 * Vite middleware in dev, by api/ais.php in production – see
 * src/lib/ais-extract.ts for the shared extraction) and hands the vessel
 * list to the app, which plays it back four minutes behind the wall
 * clock (playbackSample in ais-extract.ts).
 */

import type { AisTrackPoint, AisVessel } from '@/lib/ais-extract'

export interface AisStatus {
  state: 'connecting' | 'live' | 'error'
  vesselCount: number
  lastSuccessAt: number | null
  lastError: string | null
}

export type AisUpdateHandler = (status: AisStatus, vessels: AisVessel[]) => void

interface AisApiResponse {
  timestamp: number
  /** Server clock at the moment the response left (skew anchor). */
  servedAt?: number
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
      // correctly even against a skewed client clock. The anchor is the
      // moment the response left the server, NOT the state's write time:
      // a cached answer is old, and anchoring on its age would make every
      // fix look that much fresher than it is.
      const anchor = data.servedAt ?? data.timestamp
      const skewMs = typeof anchor === 'number' ? Date.now() - anchor : 0
      this.vessels = data.vessels.map((vessel) => normalizeVessel(vessel, skewMs))
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

/**
 * Brings one vessel from the wire into the shape the app relies on, and
 * shifts its timestamps into this browser's timeline.
 *
 * The server's state file outlives deploys, so a record written before a
 * field existed comes back without that key – absent, which is not null.
 * That is not hypothetical: it reached production and took the whole view
 * down, because `undefined` slips past a `=== null` guard and then throws
 * on the first method call. The server fills those in now too, but a
 * client that renders somebody else's JSON has no business trusting its
 * shape, and one missing field should never cost more than one field.
 */
function normalizeVessel(raw: AisVessel, skewMs: number): AisVessel {
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const track: AisTrackPoint[] = Array.isArray(raw.track) ? raw.track : []
  for (const point of track) point[0] += skewMs
  return {
    mmsi: raw.mmsi,
    name: typeof raw.name === 'string' ? raw.name : '',
    lat: raw.lat,
    lon: raw.lon,
    sogKn: num(raw.sogKn),
    cogDeg: num(raw.cogDeg),
    headingDeg: num(raw.headingDeg),
    navStatus: num(raw.navStatus),
    typeCode: num(raw.typeCode) ?? 0,
    lengthM: num(raw.lengthM),
    widthM: num(raw.widthM),
    draughtM: num(raw.draughtM),
    positionAt: raw.positionAt + skewMs,
    track,
  }
}
