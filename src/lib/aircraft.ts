/**
 * ADS-B client: polls the aircraft endpoint /api/aircraft (served by the
 * Vite middleware in dev, by api/aircraft.php in production – see
 * src/lib/aircraft-extract.ts for the shared extraction) and hands the
 * aircraft list to the app, which plays it back a few seconds behind
 * the wall clock (aircraftPlaybackSample in aircraft-extract.ts). The
 * AIS client's twin, with a much shorter interval: a transponder
 * reports every second where a ship reports every minute.
 */

import type { Aircraft, AircraftTrackPoint } from '@/lib/aircraft-extract'

export interface AircraftStatus {
  state: 'connecting' | 'live' | 'error'
  aircraftCount: number
  lastSuccessAt: number | null
  lastError: string | null
}

export type AircraftUpdateHandler = (status: AircraftStatus, aircraft: Aircraft[]) => void

interface AircraftApiResponse {
  timestamp: number
  /** Server clock at the moment the response left (skew anchor). */
  servedAt?: number
  aircraft: Aircraft[]
}

export class AircraftClient {
  private timer: number | null = null
  private stopped = false
  private aircraft: Aircraft[] = []
  private status: AircraftStatus = {
    state: 'connecting',
    aircraftCount: 0,
    lastSuccessAt: null,
    lastError: null,
  }

  constructor(
    private readonly url: string,
    private readonly onUpdate: AircraftUpdateHandler,
  ) {}

  start(intervalMs = 5_000): void {
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
      const data = (await response.json()) as AircraftApiResponse
      if (typeof data !== 'object' || data === null || !Array.isArray(data.aircraft)) {
        throw new Error('Unexpected response format from the aircraft endpoint')
      }
      // The position stamps come from the server clock – shifted into this
      // browser's timeline so the playback and the expiry read them right
      // against a skewed client clock (the AIS client's reasoning).
      const anchor = data.servedAt ?? data.timestamp
      const skewMs = typeof anchor === 'number' ? Date.now() - anchor : 0
      this.aircraft = data.aircraft.map((aircraft) => normalizeAircraft(aircraft, skewMs))
      this.status = {
        state: 'live',
        aircraftCount: data.aircraft.length,
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      this.onUpdate(this.status, this.aircraft)
    } catch (error) {
      this.status = { ...this.status, state: 'error', lastError: String(error) }
      // The last picture stays up on errors: the reckoning freezes the
      // aircraft after a while, and the layer's expiry clears them if
      // the outage lasts.
      this.onUpdate(this.status, this.aircraft)
    }
  }
}

/**
 * Brings one aircraft from the wire into the shape the app relies on,
 * and shifts its timestamps into this browser's timeline. A record
 * written by an older server may lack a field that was added since –
 * absent, not null – and one missing field must never cost more than
 * that field (see normalizeVessel in ais.ts for what it cost once).
 */
function normalizeAircraft(raw: Aircraft, skewMs: number): Aircraft {
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null)
  const str = (value: unknown): string => (typeof value === 'string' ? value : '')
  const track: AircraftTrackPoint[] = Array.isArray(raw.track) ? raw.track : []
  for (const point of track) point[0] += skewMs
  const source = raw.source
  return {
    hex: str(raw.hex),
    callsign: str(raw.callsign),
    registration: str(raw.registration),
    typeCode: str(raw.typeCode),
    description: str(raw.description),
    category: str(raw.category),
    lat: raw.lat,
    lon: raw.lon,
    altGeomM: num(raw.altGeomM),
    altBaroM: num(raw.altBaroM),
    onGround: raw.onGround === true,
    gsKn: num(raw.gsKn),
    trackDeg: num(raw.trackDeg),
    headingDeg: num(raw.headingDeg),
    verticalRateMps: num(raw.verticalRateMps),
    rollDeg: num(raw.rollDeg),
    squawk: str(raw.squawk),
    source: source === 'adsb' || source === 'mlat' ? source : 'other',
    positionAt: raw.positionAt + skewMs,
    track,
  }
}
