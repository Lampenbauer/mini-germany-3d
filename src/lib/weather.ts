/**
 * Live weather client for the rain and overcast overlays: polls the
 * Open-Meteo current-weather API (CC-BY 4.0, free, no key) for the
 * city-center point and reports the current precipitation in mm plus the
 * cloud cover in percent. Errors report 0 mm – the map must never keep
 * raining on stale data.
 */

export interface WeatherStatus {
  state: 'connecting' | 'live' | 'error'
  /** Current precipitation in mm (Open-Meteo 15-minutely current value). */
  precipitationMm: number
  /**
   * Current total cloud cover in percent (0–100). A response without a
   * usable value reports 0 – an open sky is the harmless fallback, and
   * unlike the rain it must not fail the whole poll.
   */
  cloudCoverPercent: number
  lastSuccessAt: number | null
  lastError: string | null
}

export type WeatherUpdateHandler = (status: WeatherStatus) => void

/**
 * Which sky the map shows: the live weather over Rostock, or one the
 * viewer picked from the scene controls. A picked sky is shown whatever
 * the simulation clock says – it is not a claim about right now, so the
 * near-real-time gate the live weather runs behind does not apply to it.
 */
export type WeatherMode = 'live' | 'clear' | 'cloudy' | 'rain'

/**
 * What each picked sky is made of. 'live' has no entry – it is whatever
 * the client last reported.
 *
 * The rain figure is a steady, unmistakable rain rather than a downpour:
 * it puts ~2300 drops in the air and grades the tiles about three
 * quarters of the way to the heaviest sky (see WeatherOverlay).
 */
/**
 * The sky a session opens on: the live one wherever it can be reached,
 * and otherwise the clear one the map would show anyway – offering the
 * live sky where nothing can be polled would promise what it cannot
 * deliver. It is also the mark the scene button lights up against: a sky
 * other than this one is a viewer's choice.
 */
export function defaultWeatherMode(liveWeatherAvailable: boolean): WeatherMode {
  return liveWeatherAvailable ? 'live' : 'clear'
}

export const WEATHER_PRESETS: Record<
  Exclude<WeatherMode, 'live'>,
  { precipitationMm: number; cloudCoverPercent: number }
> = {
  clear: { precipitationMm: 0, cloudCoverPercent: 0 },
  cloudy: { precipitationMm: 0, cloudCoverPercent: 100 },
  rain: { precipitationMm: 1.5, cloudCoverPercent: 100 },
}

/**
 * The live overlays only make sense near real time: the current weather
 * knows nothing about time-traveled simulation clocks. Both times are
 * seconds of day; the comparison wraps across midnight.
 */
export function weatherIsCurrent(
  simSecondsOfDay: number,
  realSecondsOfDay: number,
  maxDriftSeconds: number,
): boolean {
  const diff = Math.abs(simSecondsOfDay - realSecondsOfDay)
  return Math.min(diff, 86400 - diff) <= maxDriftSeconds
}

export class WeatherClient {
  private timer: number | null = null
  private stopped = false
  private status: WeatherStatus = {
    state: 'connecting',
    precipitationMm: 0,
    cloudCoverPercent: 0,
    lastSuccessAt: null,
    lastError: null,
  }

  constructor(
    private readonly baseUrl: string,
    private readonly longitude: number,
    private readonly latitude: number,
    private readonly onUpdate: WeatherUpdateHandler,
  ) {}

  start(intervalMs = 600_000): void {
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
      const url =
        `${this.baseUrl}?latitude=${this.latitude}&longitude=${this.longitude}` +
        `&current=precipitation,cloud_cover`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        current?: { precipitation?: unknown; cloud_cover?: unknown }
      }
      const precipitation = Number(data?.current?.precipitation)
      if (!Number.isFinite(precipitation) || precipitation < 0) {
        throw new Error('Unexpected response format from the weather endpoint')
      }
      // Cloud cover is graceful: a feed that ever drops the field leaves the
      // city under an open sky instead of failing the rain overlay with it.
      const cloudCover = Number(data?.current?.cloud_cover)
      this.status = {
        state: 'live',
        precipitationMm: precipitation,
        cloudCoverPercent:
          Number.isFinite(cloudCover) && cloudCover >= 0 ? Math.min(100, cloudCover) : 0,
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      this.onUpdate(this.status)
    } catch (error) {
      // On errors the map goes dry and clear instead of grading stale data
      this.status = {
        ...this.status,
        state: 'error',
        precipitationMm: 0,
        cloudCoverPercent: 0,
        lastError: String(error),
      }
      this.onUpdate(this.status)
    }
  }
}
