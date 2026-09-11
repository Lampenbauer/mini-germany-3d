import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  berlinDateKey,
  berlinEpoch,
  berlinSecondsOfDay,
  formatSecondsOfDay,
  parseTimeOfDay,
  SimClock,
} from '@/lib/clock'
import { CLOCK_AHEAD_MS, FUTURE_NOTICE_COOLDOWN_MS, FutureNotice, clockAhead } from '@/lib/future-notice'

describe('berlinEpoch / SimClock.setDate', () => {
  it('lands on the requested day and second in Berlin, in winter and in summer', () => {
    for (const [key, sec] of [
      ['2026-01-15', 8 * 3600 + 30 * 60],
      ['2026-07-15', 23 * 3600 + 59 * 60 + 59],
    ] as const) {
      const epoch = berlinEpoch(key, sec)
      expect(berlinDateKey(epoch)).toBe(key)
      expect(berlinSecondsOfDay(epoch)).toBe(sec)
    }
    // Fractions of a second carry over
    expect(berlinEpoch('2026-07-15', 12 * 3600 + 0.25) - berlinEpoch('2026-07-15', 12 * 3600)).toBe(250)
  })

  it('moves the clock to another day at the same time of day', () => {
    const clock = new SimClock(berlinEpoch('2026-09-06', 12 * 3600))
    clock.setDate('2026-09-10')
    expect(clock.dateKey()).toBe('2026-09-10')
    expect(Math.abs(clock.secondsOfDay() - 12 * 3600)).toBeLessThan(1)
  })

  it('keeps the time of day across the night the clocks go back', () => {
    const clock = new SimClock(berlinEpoch('2026-10-24', 15 * 3600))
    clock.setDate('2026-10-25')
    expect(clock.dateKey()).toBe('2026-10-25')
    expect(Math.round(clock.secondsOfDay())).toBe(15 * 3600)
    // …and forward again, past the night they go forward
    clock.setDate('2026-03-28')
    clock.setDate('2026-03-29')
    expect(clock.dateKey()).toBe('2026-03-29')
    expect(Math.round(clock.secondsOfDay())).toBe(15 * 3600)
  })
})

describe('berlinSecondsOfDay', () => {
  it('converts UTC to Europe/Berlin correctly (daylight saving time)', () => {
    // 2026-08-15T10:00:00Z = 12:00:00 CEST
    expect(berlinSecondsOfDay(Date.UTC(2026, 7, 15, 10, 0, 0))).toBe(12 * 3600)
  })

  it('converts UTC to Europe/Berlin correctly (standard time)', () => {
    // 2026-01-15T10:00:00Z = 11:00:00 CET
    expect(berlinSecondsOfDay(Date.UTC(2026, 0, 15, 10, 0, 0))).toBe(11 * 3600)
  })
})

describe('formatSecondsOfDay / parseTimeOfDay', () => {
  it('formats and parses times of day', () => {
    expect(formatSecondsOfDay(0)).toBe('00:00:00')
    expect(formatSecondsOfDay(12 * 3600 + 34 * 60 + 56)).toBe('12:34:56')
    expect(parseTimeOfDay('08:30')).toBe(8 * 3600 + 30 * 60)
    expect(parseTimeOfDay('23:59:59')).toBe(86399)
    expect(parseTimeOfDay('25:00')).toBeNull()
    expect(parseTimeOfDay('quatsch')).toBeNull()
  })
})

describe('SimClock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs in real time at factor 1', () => {
    const clock = new SimClock(Date.now(), 1)
    const t0 = clock.now()
    vi.advanceTimersByTime(5000)
    expect(clock.now() - t0).toBe(5000)
  })

  it('speeds up with the time-lapse factor', () => {
    const clock = new SimClock(Date.now(), 60)
    const t0 = clock.now()
    vi.advanceTimersByTime(1000)
    expect(clock.now() - t0).toBe(60_000)
  })

  it('freezes time while paused and keeps running afterwards', () => {
    const clock = new SimClock(Date.now(), 1)
    clock.setPaused(true)
    const frozen = clock.now()
    vi.advanceTimersByTime(10_000)
    expect(clock.now()).toBe(frozen)
    clock.setPaused(false)
    vi.advanceTimersByTime(2000)
    expect(clock.now()).toBe(frozen + 2000)
  })

  it('jumps to the requested time of day with setSecondsOfDay', () => {
    const clock = new SimClock(Date.now(), 1)
    clock.setSecondsOfDay(8 * 3600 + 30 * 60)
    expect(Math.floor(clock.secondsOfDay())).toBe(8 * 3600 + 30 * 60)
  })

  it('changing the speed causes no time jump', () => {
    const clock = new SimClock(Date.now(), 1)
    vi.advanceTimersByTime(1000)
    const before = clock.now()
    clock.setSpeed(120)
    expect(Math.abs(clock.now() - before)).toBeLessThan(2)
  })

  it('resetToRealTime jumps back to the real time', () => {
    const clock = new SimClock(Date.now(), 1)
    clock.setSecondsOfDay(8 * 3600) // far away from real time
    clock.resetToRealTime()
    expect(clock.now()).toBe(Date.now())
    // The time-lapse factor is preserved
    const fast = new SimClock(Date.now(), 60)
    fast.setSecondsOfDay(8 * 3600)
    fast.resetToRealTime()
    vi.advanceTimersByTime(1000)
    expect(fast.now() - Date.now()).toBeCloseTo(59_000, -3)
  })
})

describe('FutureNotice (the toast for a clock moved past the present)', () => {
  const T0 = Date.UTC(2026, 8, 11, 10, 0, 0)

  it('the future begins where the replay edge ends, mirrored', () => {
    expect(clockAhead(T0, T0)).toBe(false)
    expect(clockAhead(T0 + CLOCK_AHEAD_MS, T0)).toBe(false)
    expect(clockAhead(T0 + CLOCK_AHEAD_MS + 1, T0)).toBe(true)
    expect(clockAhead(T0 - 3_600_000, T0)).toBe(false)
  })

  it('says it once as the clock crosses into the future, not while it stays there', () => {
    const notice = new FutureNotice()
    expect(notice.update(T0, T0)).toBe(false)
    expect(notice.update(T0 + 3_600_000, T0 + 250)).toBe(true)
    // Still ahead on the next ticks: nothing new
    expect(notice.update(T0 + 3_600_500, T0 + 500)).toBe(false)
    expect(notice.update(T0 + 7_200_000, T0 + 750)).toBe(false)
  })

  it('a second crossing goes without a notice until the cooldown is over', () => {
    const notice = new FutureNotice()
    notice.update(T0, T0)
    expect(notice.update(T0 + 3_600_000, T0)).toBe(true)
    // Back to the present ("Now"), and ahead again a minute later
    expect(notice.update(T0 + 60_000, T0 + 60_000)).toBe(false)
    expect(notice.update(T0 + 3_600_000, T0 + 61_000)).toBe(false)
    // Back again, and ahead once the cooldown has run – measured on the
    // real clock from the last notice shown, not from the swallowed one
    const later = T0 + FUTURE_NOTICE_COOLDOWN_MS
    expect(notice.update(later - 1000, later - 1000)).toBe(false)
    expect(notice.update(later + 3_600_000, later)).toBe(true)
  })

  it('a clock that opens in the future is the starting point, not a move', () => {
    const notice = new FutureNotice()
    expect(notice.update(T0 + 3_600_000, T0)).toBe(false)
    expect(notice.update(T0 + 3_600_250, T0 + 250)).toBe(false)
    // Back to the present and ahead again is the first move
    expect(notice.update(T0 + 500, T0 + 500)).toBe(false)
    expect(notice.update(T0 + 3_600_000, T0 + 750)).toBe(true)
  })
})
