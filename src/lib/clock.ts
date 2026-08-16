/**
 * Simulation clock with time-lapse and pause.
 *
 * The clock runs on epoch milliseconds and can provide seconds-of-day in the
 * Europe/Berlin time zone – the timetable is computed in local time,
 * regardless of which time zone the browser runs in.
 */

const BERLIN_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** Seconds since midnight (Europe/Berlin) for an epoch-ms instant. */
export function berlinSecondsOfDay(epochMs: number): number {
  const parts = BERLIN_FORMATTER.formatToParts(epochMs)
  let h = 0
  let m = 0
  let s = 0
  for (const part of parts) {
    if (part.type === 'hour') h = parseInt(part.value, 10)
    else if (part.type === 'minute') m = parseInt(part.value, 10)
    else if (part.type === 'second') s = parseInt(part.value, 10)
  }
  // Midnight can be formatted as "24"
  if (h === 24) h = 0
  return h * 3600 + m * 60 + s
}

export function formatSecondsOfDay(sec: number): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400
  const hh = String(Math.floor(s / 3600)).padStart(2, '0')
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${hh}:${mm}:${ss}`
}

/** "HH:MM" → seconds since midnight, or null for an invalid format. */
export function parseTimeOfDay(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(text.trim())
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  const s = m[3] ? parseInt(m[3], 10) : 0
  if (h > 23 || min > 59 || s > 59) return null
  return h * 3600 + min * 60 + s
}

export class SimClock {
  private anchorReal: number
  private anchorSim: number
  private _speed: number
  private _paused = false

  constructor(startEpochMs: number = Date.now(), speed = 1) {
    this.anchorReal = Date.now()
    this.anchorSim = startEpochMs
    this._speed = speed
  }

  /** Current simulation time in epoch milliseconds. */
  now(): number {
    if (this._paused) return this.anchorSim
    return this.anchorSim + (Date.now() - this.anchorReal) * this._speed
  }

  get speed(): number {
    return this._speed
  }

  get paused(): boolean {
    return this._paused
  }

  setSpeed(speed: number): void {
    const now = this.now()
    this.anchorSim = now
    this.anchorReal = Date.now()
    this._speed = Math.max(0.1, speed)
  }

  setPaused(paused: boolean): void {
    if (paused === this._paused) return
    const now = this.now()
    this.anchorSim = now
    this.anchorReal = Date.now()
    this._paused = paused
  }

  /** Back to the real current time (time-lapse/pause are preserved). */
  resetToRealTime(): void {
    this.anchorSim = Date.now()
    this.anchorReal = Date.now()
  }

  /** Jumps to a time of day (seconds since midnight, Europe/Berlin) on the same day. */
  setSecondsOfDay(targetSec: number): void {
    const now = this.now()
    // Including the ms fraction so the target time is hit exactly (to the
    // millisecond) – important for deterministic visual tests.
    const currentSec = berlinSecondsOfDay(now) + (((now % 1000) + 1000) % 1000) / 1000
    this.anchorSim = now + (targetSec - currentSec) * 1000
    this.anchorReal = Date.now()
  }

  secondsOfDay(): number {
    const now = this.now()
    // berlinSecondsOfDay returns whole seconds; for smooth movement we
    // add the millisecond fraction.
    return berlinSecondsOfDay(now) + (((now % 1000) + 1000) % 1000) / 1000
  }

  formatted(): string {
    return formatSecondsOfDay(this.secondsOfDay())
  }
}
