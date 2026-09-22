/**
 * Simulation clock with time-lapse and pause.
 *
 * The clock runs on epoch milliseconds and can provide seconds-of-day in the
 * Europe/Berlin time zone – the timetable is computed in local time,
 * regardless of which time zone the browser runs in.
 *
 * The time-lapse factor is signed (since 2026-09-22): ×30 runs the clock
 * thirty times as fast, ×−30 runs it backward at the same pace – the
 * panel's slider spans both, real pace in the middle. The clock itself
 * needs nothing for it, it is an anchor plus the real time elapsed times
 * the factor; what runs backward with it is the fleets and the sky, each
 * a function of the moment.
 */

/** The farthest the panel's slider goes, either way. */
export const TIME_LAPSE_MAX = 120
/** The farthest `?speed=` goes, either way. */
export const URL_SPEED_MAX = 600

/**
 * The time-lapse factor a URL asks for, kept within reach: the magnitude
 * between 1 and URL_SPEED_MAX, the sign as given, ×1 for anything that
 * is no number.
 */
export function clampUrlSpeed(raw: number): number {
  if (!Number.isFinite(raw)) return 1
  const magnitude = Math.min(URL_SPEED_MAX, Math.max(1, Math.abs(raw)))
  return raw < 0 ? -magnitude : magnitude
}

/**
 * The time-lapse factors worth stopping at – what the keyboard's `+`/`-`
 * walk and the panel's slider rests on: the same steps either way, real
 * pace in the middle, and no ×0 – the step down from ×1 is ×−1, the
 * clock running backward at real pace.
 */
export const SPEED_STEPS = [
  -TIME_LAPSE_MAX, -60, -30, -20, -10, -5, -2, -1, 1, 2, 5, 10, 20, 30, 60, TIME_LAPSE_MAX,
] as const

/**
 * The slider's own scale is the index into SPEED_STEPS, one detent per
 * step spaced evenly along the track – so a drag rests on ×2, ×5, ×10
 * rather than gliding through ×7, and the middle of the track has room
 * for the paces that matter. A linear scale was tried first (2026-09-22):
 * ×1 to ×10 lay on eleven pixels of it and the thumb slid without a
 * stop; the user asked for detents.
 */
export const SLIDER_MIN = 0
export const SLIDER_MAX = SPEED_STEPS.length - 1
/**
 * The middle of the track, between ×−1 and ×1 – where the slider's fill
 * starts from, so that real pace either way shows as half a step of fill
 * on its side.
 */
export const SLIDER_ORIGIN = SPEED_STEPS.indexOf(1) - 0.5

/** The detent nearest a factor – a factor off the steps (a URL's ×50) rests on the closest. */
export function sliderFromSpeed(speed: number): number {
  let best = 0
  for (let i = 1; i < SPEED_STEPS.length; i++) {
    if (Math.abs(SPEED_STEPS[i] - speed) < Math.abs(SPEED_STEPS[best] - speed)) best = i
  }
  return best
}

export function speedFromSlider(position: number): number {
  const index = Math.min(SLIDER_MAX, Math.max(SLIDER_MIN, Math.round(position)))
  return SPEED_STEPS[index]
}

/**
 * The factor as the panel writes it: ×30 either way. The direction is
 * the row's to say, not the number's – it read ×−30 for a day, and the
 * user found the two signs before the number ugly; the row's label and
 * icon switch to "Rewind" instead (ControlPanel), the number stays.
 */
export function formatSpeed(speed: number): string {
  return `×${Math.abs(speed)}`
}

const BERLIN_FORMATTER = new Intl.DateTimeFormat('de-DE', {
  timeZone: 'Europe/Berlin',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const BERLIN_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The calendar day (Europe/Berlin) of an epoch-ms instant as "YYYY-MM-DD". */
export function berlinDateKey(epochMs: number): string {
  // en-CA formats as YYYY-MM-DD, which is also what <input type="date"> speaks
  return BERLIN_DATE_FORMATTER.format(epochMs)
}

/**
 * The epoch-ms instant of a time of day on a calendar day, both in
 * Europe/Berlin. The zone's offset is one or two hours; the candidate
 * that formats back to the requested day and second is the one – on the
 * spring-forward night, when the requested time does not exist, the
 * standard-time candidate stands in. Fractions of a second carry over.
 */
export function berlinEpoch(dateKey: string, secondsOfDay: number): number {
  const [y, m, d] = dateKey.split('-').map((part) => parseInt(part, 10))
  const wholeSeconds = Math.floor(secondsOfDay)
  const fraction = secondsOfDay - wholeSeconds
  const midnightUtc = Date.UTC(y, m - 1, d, 0, 0, 0)
  let fallback = Number.NaN
  for (const offsetHours of [2, 1]) {
    const candidate = midnightUtc - offsetHours * 3_600_000 + wholeSeconds * 1000
    if (Number.isNaN(fallback)) fallback = candidate
    if (berlinDateKey(candidate) === dateKey && berlinSecondsOfDay(candidate) === wholeSeconds) {
      return candidate + fraction * 1000
    }
  }
  return fallback + fraction * 1000
}

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

  /** The time-lapse factor: a magnitude of at least 0.1, negative to run backward. */
  setSpeed(speed: number): void {
    const now = this.now()
    this.anchorSim = now
    this.anchorReal = Date.now()
    const magnitude = Math.max(0.1, Math.abs(speed))
    this._speed = speed < 0 ? -magnitude : magnitude
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

  /**
   * Jumps to a calendar day ("YYYY-MM-DD", Europe/Berlin) at the same time
   * of day. What the day changes is the sun and, for a day in the past,
   * the ships (the AIS archive, see lib/ais-archive.ts) – and the
   * timetable does not change with it: the schedule is built for one
   * service day – the busiest of the weeks ahead, a typical weekday
   * (scripts/fetch-gtfs-schedule.mjs) – so a Sunday runs the weekday
   * service.
   */
  setDate(dateKey: string): void {
    this.anchorSim = berlinEpoch(dateKey, this.secondsOfDay())
    this.anchorReal = Date.now()
  }

  /** The simulated calendar day (Europe/Berlin) as "YYYY-MM-DD". */
  dateKey(): string {
    return berlinDateKey(this.now())
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
