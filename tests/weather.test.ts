import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  defaultWeatherMode,
  weatherIsCurrent,
  WeatherClient,
  WEATHER_PRESETS,
  type WeatherStatus,
} from '@/lib/weather'
import { overcastGrade } from '@/map/WeatherOverlay'

describe('weatherIsCurrent', () => {
  it('accepts sim times near the real clock', () => {
    expect(weatherIsCurrent(12 * 3600, 12 * 3600, 600)).toBe(true)
    expect(weatherIsCurrent(12 * 3600 + 300, 12 * 3600, 600)).toBe(true)
    expect(weatherIsCurrent(12 * 3600 - 599, 12 * 3600, 600)).toBe(true)
  })

  it('rejects time-traveled sim clocks', () => {
    expect(weatherIsCurrent(8 * 3600, 12 * 3600, 600)).toBe(false)
    expect(weatherIsCurrent(12 * 3600 + 601, 12 * 3600, 600)).toBe(false)
  })

  it('wraps across midnight', () => {
    expect(weatherIsCurrent(10, 86390, 600)).toBe(true)
    expect(weatherIsCurrent(86390, 10, 600)).toBe(true)
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

  it('polls the endpoint and reports precipitation and cloud cover', async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ current: { precipitation: 1.4, cloud_cover: 82 } })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].precipitationMm).toBe(1.4)
    expect(statuses[0].cloudCoverPercent).toBe(82)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('latitude=54.09')
    expect(url).toContain('longitude=12.14')
    // Both values ride on the same request – no extra call for the sky
    expect(url).toContain('current=precipitation,cloud_cover')
    expect(fetchMock).toHaveBeenCalledOnce()

    // Next poll only after the interval; stop() cancels it
    await vi.advanceTimersByTimeAsync(600_000)
    expect(statuses).toHaveLength(2)
    client.stop()
    await vi.advanceTimersByTimeAsync(1_200_000)
    expect(statuses).toHaveLength(2)
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

