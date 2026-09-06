/**
 * Live weather client for the rain and overcast overlays: polls the
 * Open-Meteo current-weather API (CC-BY 4.0, free, no key) for one point
 * – the center of the Rostock bounding box, see config.weather – and
 * reports the current precipitation in mm, the cloud cover in percent and
 * the temperature in °C. Errors report 0 mm – the map must never keep
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
  /**
   * Current air temperature in °C, or null when the feed did not carry
   * one (and after an error). Nothing in the scene is drawn from it – it
   * is the number the scene button shows.
   */
  temperatureC: number | null
  /**
   * Wind at 10 m: speed in m/s and the direction it blows from in degrees
   * (meteorological, 0 = north). The clouds drift with it (see
   * map/CloudLayer.ts); a feed without it leaves them standing, which is
   * a calm day rather than a failure.
   */
  windSpeedMps: number
  windFromDeg: number
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
  { precipitationMm: number; cloudCoverPercent: number; windSpeedMps: number; windFromDeg: number }
> = {
  clear: { precipitationMm: 0, cloudCoverPercent: 0, windSpeedMps: 3, windFromDeg: 250 },
  // A brisk westerly – the wind northern Germany's cloudy days come on
  cloudy: { precipitationMm: 0, cloudCoverPercent: 100, windSpeedMps: 6, windFromDeg: 250 },
  rain: { precipitationMm: 1.5, cloudCoverPercent: 100, windSpeedMps: 8, windFromDeg: 240 },
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
    temperatureC: null,
    windSpeedMps: 0,
    windFromDeg: 0,
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
        `&current=precipitation,cloud_cover,temperature_2m,wind_speed_10m,wind_direction_10m` +
        // Open-Meteo answers wind in km/h unless told otherwise
        `&wind_speed_unit=ms`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = (await response.json()) as {
        current?: {
          precipitation?: unknown
          cloud_cover?: unknown
          temperature_2m?: unknown
          wind_speed_10m?: unknown
          wind_direction_10m?: unknown
        }
      }
      const precipitation = Number(data?.current?.precipitation)
      if (!Number.isFinite(precipitation) || precipitation < 0) {
        throw new Error('Unexpected response format from the weather endpoint')
      }
      // Cloud cover is graceful: a feed that ever drops the field leaves the
      // city under an open sky instead of failing the rain overlay with it.
      const cloudCover = Number(data?.current?.cloud_cover)
      // The temperature is graceful in the same way, and it is nothing but
      // a label: a feed without one leaves the scene button showing its
      // icon alone rather than failing the poll the sky depends on.
      const temperature = Number(data?.current?.temperature_2m)
      // The wind is graceful too: without it the clouds stand still
      const windSpeed = Number(data?.current?.wind_speed_10m)
      const windFrom = Number(data?.current?.wind_direction_10m)
      this.status = {
        state: 'live',
        precipitationMm: precipitation,
        cloudCoverPercent:
          Number.isFinite(cloudCover) && cloudCover >= 0 ? Math.min(100, cloudCover) : 0,
        temperatureC: Number.isFinite(temperature) ? temperature : null,
        windSpeedMps: Number.isFinite(windSpeed) && windSpeed >= 0 ? windSpeed : 0,
        windFromDeg: Number.isFinite(windFrom) ? ((windFrom % 360) + 360) % 360 : 0,
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
        temperatureC: null,
        windSpeedMps: 0,
        lastError: String(error),
      }
      this.onUpdate(this.status)
    }
  }
}
