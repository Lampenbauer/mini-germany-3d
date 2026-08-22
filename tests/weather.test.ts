import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rainIsCurrent, WeatherClient, type WeatherStatus } from '@/lib/weather'

describe('rainIsCurrent', () => {
  it('accepts sim times near the real clock', () => {
    expect(rainIsCurrent(12 * 3600, 12 * 3600, 600)).toBe(true)
    expect(rainIsCurrent(12 * 3600 + 300, 12 * 3600, 600)).toBe(true)
    expect(rainIsCurrent(12 * 3600 - 599, 12 * 3600, 600)).toBe(true)
  })

  it('rejects time-traveled sim clocks', () => {
    expect(rainIsCurrent(8 * 3600, 12 * 3600, 600)).toBe(false)
    expect(rainIsCurrent(12 * 3600 + 601, 12 * 3600, 600)).toBe(false)
  })

  it('wraps across midnight', () => {
    expect(rainIsCurrent(10, 86390, 600)).toBe(true)
    expect(rainIsCurrent(86390, 10, 600)).toBe(true)
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

  it('polls the endpoint and reports the current precipitation', async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ current: { precipitation: 1.4 } })),
    )
    vi.stubGlobal('fetch', fetchMock)

    const client = makeClient()
    client.start(600_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(statuses).toHaveLength(1)
    expect(statuses[0].state).toBe('live')
    expect(statuses[0].precipitationMm).toBe(1.4)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('latitude=54.09')
    expect(url).toContain('longitude=12.14')
    expect(url).toContain('current=precipitation')

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
})
