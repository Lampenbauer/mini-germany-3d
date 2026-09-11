/**
 * The weather over the city, for the rain, the overcast grade, the
 * clouds' drift and the reading on the weather button: Open-Meteo's
 * forecast API (CC-BY 4.0, free, no key) for one point – the centre of
 * the city's box, see city.weather – on the quarter-hour grid its models
 * run on, the last WEATHER_PAST_DAYS days and the rest of today in one
 * request. The app takes the step of the simulated moment (weatherAt):
 * a clock set into the past shows the sky of that quarter hour, and a
 * day under the time-lapse clouds over and clears as the day did. No
 * recording of our own, unlike the ships and the aircraft – the feed
 * keeps its past, and the same series is what the live sky is the
 * newest step of. A clock set ahead shows the present's sky: the rest of
 * today in the answer is a forecast, and the map shows nothing it cannot
 * vouch for (the ships and the aircraft stay in the present too). Errors
 * report an empty series – the map must never keep raining on stale
 * data.
 */

/**
 * How many days back the series reaches. The calendar offers two days
 * behind today (DATE_PICKER_DAYS_BACK in ControlPanel.tsx – the days the
 * ships' and the aircraft's recordings hold), and the feed counts its
 * days in UTC: the earliest day's midnight in Berlin is 22:00 UTC of the
 * evening before, so three UTC days cover the calendar's two.
 */
export const WEATHER_PAST_DAYS = 3
/** The feed's grid, and what a series without a second step is assumed to run on. */
export const WEATHER_STEP_MS = 900_000

/** The weather as of one quarter hour. */
export interface WeatherReading {
  /** Precipitation in mm over the quarter hour. */
  precipitationMm: number
  /** Total cloud cover in percent (0–100); a step without a usable value reads as an open sky. */
  cloudCoverPercent: number
  /** Air temperature in °C, or null when the feed did not carry one – the number the scene button shows. */
  temperatureC: number | null
  /**
   * Wind at 10 m: speed in m/s and the direction it blows from in degrees
   * (meteorological, 0 = north). The clouds drift with it (see
   * map/CloudLayer.ts); a step without it leaves them standing, which is
   * a calm day rather than a failure.
   */
  windSpeedMps: number
  windFromDeg: number
}

/** The readings on the feed's grid: the one at `startMs`, then every `stepMs`. */
export interface WeatherSeries {
  startMs: number
  stepMs: number
  readings: WeatherReading[]
}

export const EMPTY_WEATHER_SERIES: WeatherSeries = { startMs: 0, stepMs: WEATHER_STEP_MS, readings: [] }

export interface WeatherStatus {
  state: 'connecting' | 'live' | 'error'
  /** What the feed holds – empty until the first answer, and after an error. */
  series: WeatherSeries
  lastSuccessAt: number | null
  lastError: string | null
}

/**
 * The reading of the quarter hour a moment falls into, null where the
 * series says nothing – before it begins, after it ends, and while it
 * is empty. Nothing is interpolated: the sky is a grade, not a position.
 */
export function weatherAt(series: WeatherSeries, atMs: number): WeatherReading | null {
  if (series.readings.length === 0 || series.stepMs <= 0) return null
  const index = Math.floor((atMs - series.startMs) / series.stepMs)
  return index >= 0 && index < series.readings.length ? series.readings[index] : null
}

/** A finite number, or null – the feed leaves a step it has no value for as null. */
function finite(value: unknown): number | null {
  const n = typeof value === 'number' ? value : NaN
  return Number.isFinite(n) ? n : null
}

/**
 * The series out of an Open-Meteo answer (`minutely_15` with
 * `timeformat=unixtime`). The times and the precipitation have to be
 * there and usable – a negative precipitation is a malformed answer, not
 * a dry one – while a missing cloud cover reads as an open sky, a
 * missing temperature as no number and a missing wind as a calm: none
 * of them is worth failing the rain over.
 */
export function parseWeatherSeries(data: unknown): WeatherSeries {
  const block = (data as { minutely_15?: Record<string, unknown> } | null)?.minutely_15
  const times = block?.time
  const precipitation = block?.precipitation
  if (!Array.isArray(times) || times.length === 0 || !Array.isArray(precipitation) || precipitation.length !== times.length) {
    throw new Error('Unexpected response format from the weather endpoint')
  }
  const column = (name: string): unknown[] => {
    const values = block?.[name]
    return Array.isArray(values) && values.length === times.length ? values : []
  }
  const cloudCover = column('cloud_cover')
  const temperature = column('temperature_2m')
  const windSpeed = column('wind_speed_10m')
  const windFrom = column('wind_direction_10m')
  const start = finite(times[0])
  const second = times.length > 1 ? finite(times[1]) : null
  if (start === null) throw new Error('Unexpected response format from the weather endpoint')
  const stepMs = second !== null && second > start ? (second - start) * 1000 : WEATHER_STEP_MS
  const readings: WeatherReading[] = []
  for (let i = 0; i < times.length; i++) {
    const mm = precipitation[i] === null ? 0 : finite(precipitation[i])
    if (mm === null || mm < 0) throw new Error('Unexpected response format from the weather endpoint')
    const cover = finite(cloudCover[i])
    const speed = finite(windSpeed[i])
    const from = finite(windFrom[i])
    readings.push({
      precipitationMm: mm,
      cloudCoverPercent: cover !== null && cover >= 0 ? Math.min(100, cover) : 0,
      temperatureC: finite(temperature[i]),
      windSpeedMps: speed !== null && speed >= 0 ? speed : 0,
      windFromDeg: from !== null ? ((from % 360) + 360) % 360 : 0,
    })
  }
  return { startMs: start * 1000, stepMs, readings }
}

export type WeatherUpdateHandler = (status: WeatherStatus) => void

/**
 * Which sky the map shows: the live weather over Rostock, or one the
 * viewer picked from the scene controls. A picked sky is shown whatever
 * the simulation clock says – it is not a claim about right now, so the
 * near-real-time gate the live weather runs behind does not apply to it.
 */
export type WeatherMode = 'live' | 'clear' | 'cloudy' | 'rain'

/** Every sky, in the order the popover offers them. */
export const WEATHER_MODES = ['live', 'clear', 'cloudy', 'rain'] as const

/** Whether a string names a sky – the `weather=` the URL hash carries. */
export function isWeatherMode(value: string | null): value is WeatherMode {
  return value !== null && (WEATHER_MODES as readonly string[]).includes(value)
}

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

export class WeatherClient {
  private timer: number | null = null
  private stopped = false
  private status: WeatherStatus = {
    state: 'connecting',
    series: EMPTY_WEATHER_SERIES,
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
        `&minutely_15=precipitation,cloud_cover,temperature_2m,wind_speed_10m,wind_direction_10m` +
        // The days the calendar reaches back, and today to its end – the
        // present is the newest step that has come to pass
        `&past_days=${WEATHER_PAST_DAYS}&forecast_days=1` +
        // Open-Meteo answers wind in km/h unless told otherwise, and the
        // times as ISO strings without a zone
        `&wind_speed_unit=ms&timeformat=unixtime`
      const response = await fetch(url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      this.status = {
        state: 'live',
        series: parseWeatherSeries(await response.json()),
        lastSuccessAt: Date.now(),
        lastError: null,
      }
      this.onUpdate(this.status)
    } catch (error) {
      // On errors the map goes dry and clear instead of grading stale data
      this.status = {
        ...this.status,
        state: 'error',
        series: EMPTY_WEATHER_SERIES,
        lastError: String(error),
      }
      this.onUpdate(this.status)
    }
  }
}
