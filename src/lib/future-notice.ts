/**
 * The notice for a clock set into the future.
 *
 * The trains and buses follow their timetable at whatever moment the
 * clock shows, but the ships and the aircraft are live: a clock set back
 * replays their recordings (lib/archive-hours.ts), a clock set ahead
 * leaves them in the present, moving in real time under a timetable that
 * has run on. The panel's help says so, but nobody reads it before
 * setting the clock – so the first time the clock moves past the present
 * in a session, a toast says it, and then not again for a while: the
 * fact does not change, and a reader who steps back to the present and
 * ahead again a minute later has just read it.
 *
 * Pure – the loop's UI tick feeds it the two clocks, it says when to
 * show – so the rule is tested without a scene (tests/clock.test.ts).
 */

import { REPLAY_EDGE_MS } from './archive-hours.ts'

/**
 * How far ahead of the real clock the simulated one has to be to count
 * as the future: the replay edge, mirrored. Between the two edges the
 * fleets are live on either side, so the moment a set clock leaves the
 * present is the moment the ships and the aircraft stop following it –
 * whether it was set by the time field, the calendar or a time-lapse
 * that ran on past the present.
 */
export const CLOCK_AHEAD_MS = REPLAY_EDGE_MS

/** How long after a notice the next entry into the future goes without one. */
export const FUTURE_NOTICE_COOLDOWN_MS = 15 * 60_000

/** How long the notice stands: two sentences, read once. */
export const FUTURE_NOTICE_DURATION_MS = 8000

/** Whether the simulated moment is past the present – see CLOCK_AHEAD_MS. */
export function clockAhead(simMs: number, nowMs: number): boolean {
  return simMs > nowMs + CLOCK_AHEAD_MS
}

export class FutureNotice {
  /**
   * Whether the clock stood in the future at the last check; null before
   * the first. The first check sets the baseline without a notice: a link
   * that names a time ahead opens the map on it, and that is where the
   * reader starts, not a move they made.
   */
  private wasAhead: boolean | null = null
  /** The real time (epoch ms) of the last notice, null before the first. */
  private lastShownAt: number | null = null

  /**
   * One check per UI tick: whether a notice is due now. Due when the
   * clock has just crossed from the present into the future, and the
   * last notice is FUTURE_NOTICE_COOLDOWN_MS or more ago on the real
   * clock. A crossing during the cooldown is swallowed for good – the
   * notice is for the move, not for the state.
   */
  update(simMs: number, nowMs: number): boolean {
    const ahead = clockAhead(simMs, nowMs)
    const entered = ahead && this.wasAhead === false
    this.wasAhead = ahead
    if (!entered) return false
    if (this.lastShownAt !== null && nowMs - this.lastShownAt < FUTURE_NOTICE_COOLDOWN_MS) {
      return false
    }
    this.lastShownAt = nowMs
    return true
  }
}
