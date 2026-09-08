// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWeatherMode,
  weatherIsCurrentAt,
  WeatherClient,
  WEATHER_PRESETS,
  type WeatherStatus,
} from '@/lib/weather'
import { overcastGrade } from '@/map/WeatherOverlay'

describe('weatherIsCurrentAt', () => {
  const now = Date.UTC(2026, 8, 6, 10, 0, 0)

  it('accepts sim instants near the real clock', () => {
    expect(weatherIsCurrentAt(now, now, 600)).toBe(true)
    expect(weatherIsCurrentAt(now + 300_000, now, 600)).toBe(true)
    expect(weatherIsCurrentAt(now - 599_000, now, 600)).toBe(true)
  })

  it('rejects time-traveled sim clocks, the same hour on another day included', () => {
    expect(weatherIsCurrentAt(now - 4 * 3_600_000, now, 600)).toBe(false)
    expect(weatherIsCurrentAt(now + 601_000, now, 600)).toBe(false)
    expect(weatherIsCurrentAt(now + 86_400_000, now, 600)).toBe(false)
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

  it('polls the endpoint and reports precipitation, cloud cover and temperature', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            current: { precipitation: 1.4, cloud_cover: 82, temperature_2m: 11.7 },
          }),
        ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].precipitationMm).toBe(1.4)
    expect(statuses[0].cloudCoverPercent).toBe(82)
    expect(statuses[0].temperatureC).toBe(11.7)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('latitude=54.09')
    expect(url).toContain('longitude=12.14')
    // All three values ride on the same request – no extra call for either
    expect(url).toContain(
      'current=precipitation,cloud_cover,temperature_2m,wind_speed_10m,wind_direction_10m',
    )
    // Open-Meteo's default is km/h – the clouds drift in m/s
    expect(url).toContain('wind_speed_unit=ms')
    expect(fetchMock).toHaveBeenCalledOnce()

    // Next poll only after the interval; stop() cancels it
    await vi.advanceTimersByTimeAsync(600_000)
    expect(statuses).toHaveLength(2)
    client.stop()
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(statuses).toHaveLength(2)
  })

  it('reports the wind in m/s, and a calm without one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              current: {
                precipitation: 0,
                cloud_cover: 60,
                temperature_2m: 9,
                wind_speed_10m: 5.5,
                wind_direction_10m: 250,
              },
            }),
          ),
      ),
    )
    makeClient().start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].windSpeedMps).toBe(5.5)
    expect(statuses[0].windFromDeg).toBe(250)

    // A feed without the wind leaves the clouds standing, not the poll failing
    statuses.length = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ current: { precipitation: 0, cloud_cover: 60 } })),
      ),
    )
    makeClient().start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].windSpeedMps).toBe(0)
    expect(statuses[0].windFromDeg).toBe(0)
  })

  it('goes dry on HTTP errors instead of raining on stale data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('error')
    expect(statuses[0].precipitationMm).toBe(0)
    expect(statuses[0].cloudCoverPercent).toBe(0)
    // …and the button drops the reading rather than showing a stale one
    expect(statuses[0].temperatureC).toBeNull()
    client.stop()
  })

  it('treats malformed responses as errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ current: { precipitation: -3 } }))),
    )
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].state).toBe('error')
    expect(statuses[0].precipitationMm).toBe(0)
    client.stop()
  })

  it('keeps the rain alive when only the cloud cover is unusable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ current: { precipitation: 0.8 } })),
      ),
    )
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    // A missing sky must not fail the poll – it reads as an open one
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].precipitationMm).toBe(0.8)
    expect(statuses[0].cloudCoverPercent).toBe(0)
    // …and a missing temperature is a button without a number, no more
    expect(statuses[0].temperatureC).toBeNull()
    client.stop()
  })

  it('reads a temperature below zero as one', async () => {
    // The obvious way to reject a missing value would take -0.5 °C with it
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ current: { precipitation: 0, cloud_cover: 90, temperature_2m: -4.2 } }),
          ),
      ),
    )
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].temperatureC).toBe(-4.2)
    client.stop()
  })

  it('caps an out-of-range cloud cover at fully overcast', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ current: { precipitation: 0, cloud_cover: 140 } })),
      ),
    )
    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(statuses[0].cloudCoverPercent).toBe(100)
    client.stop()
  })
})

describe('the picked skies', () => {
  it('opens on the live sky, and on the clear one where there is none', () => {
    expect(defaultWeatherMode(true)).toBe('live')
    expect(defaultWeatherMode(false)).toBe('clear')
  })

  it('holds a sky for every mode but the live one', () => {
    expect(Object.keys(WEATHER_PRESETS).sort()).toEqual(['clear', 'cloudy', 'rain'])
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

