// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWeatherMode,
  EMPTY_WEATHER_SERIES,
  parseWeatherSeries,
  weatherAt,
  WeatherClient,
  WEATHER_PAST_DAYS,
  WEATHER_PRESETS,
  WEATHER_STEP_MS,
  type WeatherStatus,
} from '@/lib/weather'
import { LOW_VISIBILITY_M, LOW_VISIBILITY_OFF_M } from '@/map/AirfieldLightsLayer'
import { overcastGrade } from '@/map/WeatherOverlay'

/**
 * The weather: the last days on Open-Meteo's quarter-hour grid, and the
 * step of the simulated moment picked out of them – no recording of our
 * own, the feed keeps the past.
 */

/** 2026-09-06T10:00:00Z, on the grid. */
const START = Date.UTC(2026, 8, 6, 10, 0, 0)

/** An Open-Meteo answer with `n` quarter hours from START, as `timeformat=unixtime` delivers it. */
function answer(n: number, overrides: Record<string, unknown[]> = {}) {
  const times = Array.from({ length: n }, (_, i) => START / 1000 + i * 900)
  return {
    minutely_15: {
      time: times,
      precipitation: times.map((_, i) => (i % 3 === 0 ? 0.6 : 0)),
      cloud_cover: times.map((_, i) => 40 + i),
      temperature_2m: times.map((_, i) => 10 + i / 10),
      wind_speed_10m: times.map(() => 5.5),
      wind_direction_10m: times.map(() => 250),
      visibility: times.map((_, i) => 20_000 - i * 5_000),
      ...overrides,
    },
  }
}

describe('weatherAt', () => {
  const series = parseWeatherSeries(answer(4))

  it('picks the quarter hour a moment falls into, and nothing outside the series', () => {
    expect(series.startMs).toBe(START)
    expect(series.stepMs).toBe(WEATHER_STEP_MS)
    expect(weatherAt(series, START)?.precipitationMm).toBe(0.6)
    expect(weatherAt(series, START + 14 * 60_000)?.precipitationMm).toBe(0.6)
    expect(weatherAt(series, START + 15 * 60_000)?.precipitationMm).toBe(0)
    expect(weatherAt(series, START + 45 * 60_000)?.temperatureC).toBe(10.3)
    // The moment before the first step, and the one at the end of the last
    expect(weatherAt(series, START - 1)).toBeNull()
    expect(weatherAt(series, START + 60 * 60_000)).toBeNull()
    expect(weatherAt(EMPTY_WEATHER_SERIES, START)).toBeNull()
  })

  it('reaches back over the days the calendar offers, counted in UTC', () => {
    // Four Berlin days back begin at 22:00 UTC of the evening before – the
    // fifth UTC day back covers it (see WEATHER_PAST_DAYS)
    expect(WEATHER_PAST_DAYS).toBeGreaterThanOrEqual(5)
  })
})

describe('parseWeatherSeries', () => {
  it('reads every column, and takes the grid from the times', () => {
    const series = parseWeatherSeries(answer(2, { time: [START / 1000, START / 1000 + 3600] }))
    expect(series.stepMs).toBe(3_600_000)
    expect(series.readings[1]).toEqual({
      precipitationMm: 0,
      cloudCoverPercent: 41,
      temperatureC: 10.1,
      windSpeedMps: 5.5,
      windFromDeg: 250,
      visibilityM: 15_000,
    })
  })

  it('takes a step the feed left empty as dry, open, calm and of unknown visibility, and a missing column too', () => {
    const series = parseWeatherSeries(
      answer(2, {
        precipitation: [null, 0.2],
        cloud_cover: [null, 140],
        temperature_2m: [-4.2, null],
        wind_speed_10m: [null, 3],
        wind_direction_10m: [null, -90],
        visibility: [null, 400],
      }),
    )
    // A temperature below zero is one; a cloud cover over the top is overcast
    expect(series.readings[0]).toEqual({
      precipitationMm: 0,
      cloudCoverPercent: 0,
      temperatureC: -4.2,
      windSpeedMps: 0,
      windFromDeg: 0,
      visibilityM: null,
    })
    expect(series.readings[1]).toEqual({
      precipitationMm: 0.2,
      cloudCoverPercent: 100,
      temperatureC: null,
      windSpeedMps: 3,
      windFromDeg: 270,
      visibilityM: 400,
    })
    const bare = parseWeatherSeries({ minutely_15: { time: [START / 1000], precipitation: [0.8] } })
    expect(bare.readings[0]).toEqual({
      precipitationMm: 0.8,
      cloudCoverPercent: 0,
      temperatureC: null,
      windSpeedMps: 0,
      windFromDeg: 0,
      visibilityM: null,
    })
  })

  it('rejects an answer without the grid or with a precipitation that is no amount', () => {
    expect(() => parseWeatherSeries({ current: { precipitation: 0 } })).toThrow()
    expect(() => parseWeatherSeries({ minutely_15: { time: [], precipitation: [] } })).toThrow()
    expect(() => parseWeatherSeries(answer(2, { precipitation: [0] }))).toThrow()
    expect(() => parseWeatherSeries(answer(2, { precipitation: [0, -3] }))).toThrow()
  })
})

describe('WeatherClient', () => {
  const statuses: WeatherStatus[] = []

  beforeEach(() => {
    statuses.length = 0
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const makeClient = () =>
    new WeatherClient('https://weather.test/v1', 12.14, 54.09, (status) =>
      statuses.push({ ...status }),
    )

  it('polls the endpoint for the last days on the quarter-hour grid and reports the series', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) => new Response(JSON.stringify(answer(8))),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].series.readings).toHaveLength(8)
    expect(weatherAt(statuses[0].series, START + 20 * 60_000)?.cloudCoverPercent).toBe(41)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('latitude=54.09')
    expect(url).toContain('longitude=12.14')
    // Every value rides on the same request – no extra call for any
    expect(url).toContain(
      'minutely_15=precipitation,cloud_cover,temperature_2m,wind_speed_10m,wind_direction_10m,visibility',
    )
    // The days the calendar reaches back, and today to its end
    expect(url).toContain(`past_days=${WEATHER_PAST_DAYS}`)
    expect(url).toContain('forecast_days=1')
    // Open-Meteo's default is km/h – the clouds drift in m/s – and ISO times without a zone
    expect(url).toContain('wind_speed_unit=ms')
    expect(url).toContain('timeformat=unixtime')
    expect(fetchMock).toHaveBeenCalledOnce()

    // Next poll only after the interval; stop() cancels it
    await vi.advanceTimersByTimeAsync(600_000)
    expect(statuses).toHaveLength(2)
    client.stop()
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(statuses).toHaveLength(2)
  })

  it('goes dry on HTTP errors and malformed answers instead of raining on stale data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('error')
    expect(statuses[0].series.readings).toEqual([])
    client.stop()

    statuses.length = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ current: { precipitation: 0.4 } }))))
    const client2 = makeClient()
    client2.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].state).toBe('error')
    expect(statuses[0].series.readings).toEqual([])
    client2.stop()
  })
})

describe('the picked skies', () => {
  it('opens on the live sky, and on the clear one where there is none', () => {
    expect(defaultWeatherMode(true)).toBe('live')
    expect(defaultWeatherMode(false)).toBe('clear')
  })

  it('holds a sky for every mode but the live one, the rainy one short-sighted enough to light the airfield', () => {
    expect(Object.keys(WEATHER_PRESETS).sort()).toEqual(['clear', 'cloudy', 'rain'])
    expect(WEATHER_PRESETS.rain.visibilityM).toBeLessThanOrEqual(LOW_VISIBILITY_M)
    expect(WEATHER_PRESETS.clear.visibilityM).toBeGreaterThan(LOW_VISIBILITY_OFF_M)
    expect(WEATHER_PRESETS.cloudy.visibilityM).toBeGreaterThan(LOW_VISIBILITY_OFF_M)
  })

  it('reads as clear, overcast and rainy on the grade the tiles use', () => {
    const grade = (mode: keyof typeof WEATHER_PRESETS) =>
      overcastGrade(
        WEATHER_PRESETS[mode].precipitationMm,
        WEATHER_PRESETS[mode].cloudCoverPercent,
      )
    expect(grade('clear')).toBe(0)
    expect(grade('cloudy')).toBeGreaterThan(0)
    expect(grade('rain')).toBeGreaterThan(grade('cloudy'))
    // Rain is rain, not a drizzle that reads as a grey day
    expect(WEATHER_PRESETS.rain.precipitationMm).toBeGreaterThan(0.5)
    expect(grade('rain')).toBeLessThan(1)
  })
})

