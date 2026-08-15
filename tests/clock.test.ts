import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  berlinSecondsOfDay,
  formatSecondsOfDay,
  parseTimeOfDay,
  SimClock,
} from '@/lib/clock'

describe('berlinSecondsOfDay', () => {
  it('rechnet UTC korrekt nach Europe/Berlin um (Sommerzeit)', () => {
    // 2026-08-15T10:00:00Z = 12:00:00 MESZ
    expect(berlinSecondsOfDay(Date.UTC(2026, 7, 15, 10, 0, 0))).toBe(12 * 3600)
  })

  it('rechnet UTC korrekt nach Europe/Berlin um (Winterzeit)', () => {
    // 2026-01-15T10:00:00Z = 11:00:00 MEZ
    expect(berlinSecondsOfDay(Date.UTC(2026, 0, 15, 10, 0, 0))).toBe(11 * 3600)
  })
})

describe('formatSecondsOfDay / parseTimeOfDay', () => {
  it('formatiert und parst Uhrzeiten', () => {
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

  it('läuft in Echtzeit mit Faktor 1', () => {
    const clock = new SimClock(Date.now(), 1)
    const t0 = clock.now()
    vi.advanceTimersByTime(5000)
    expect(clock.now() - t0).toBe(5000)
  })

  it('beschleunigt mit dem Zeitraffer-Faktor', () => {
    const clock = new SimClock(Date.now(), 60)
    const t0 = clock.now()
    vi.advanceTimersByTime(1000)
    expect(clock.now() - t0).toBe(60_000)
  })

  it('friert die Zeit bei Pause ein und läuft danach weiter', () => {
    const clock = new SimClock(Date.now(), 1)
    clock.setPaused(true)
    const frozen = clock.now()
    vi.advanceTimersByTime(10_000)
    expect(clock.now()).toBe(frozen)
    clock.setPaused(false)
    vi.advanceTimersByTime(2000)
    expect(clock.now()).toBe(frozen + 2000)
  })

  it('springt mit setSecondsOfDay zur gewünschten Uhrzeit', () => {
    const clock = new SimClock(Date.now(), 1)
    clock.setSecondsOfDay(8 * 3600 + 30 * 60)
    expect(Math.floor(clock.secondsOfDay())).toBe(8 * 3600 + 30 * 60)
  })

  it('Geschwindigkeitswechsel verursacht keinen Zeitsprung', () => {
    const clock = new SimClock(Date.now(), 1)
    vi.advanceTimersByTime(1000)
    const before = clock.now()
    clock.setSpeed(120)
    expect(Math.abs(clock.now() - before)).toBeLessThan(2)
  })
})
