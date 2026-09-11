/**
 * Whether the reader has left the pointer alone for a while – what the
 * map's rail at the lower right fades out on (see App.tsx): a hand that
 * has come to rest is looking at the city, and the boxes in the corner
 * are not what it is looking at. Any pointer movement, press, wheel or
 * key brings them back at once; the keyboard counts because a reader
 * without a mouse still has to see what they are stepping through.
 *
 * Only where the device can hover at all. A phone reports `(hover:
 * none)`, and there a finger never moves between touches – the rail
 * would fade ten seconds into every visit and never return but for a
 * tap into the dark. Read once, as viewport.ts reads its width: a phone
 * does not grow a mouse mid-session.
 */

/** The events that count as the reader being there. */
const ACTIVITY_EVENTS = ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const

/** Whether the device has no pointer that hovers – a phone, a tablet. */
export function hoverUnavailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(hover: none)').matches
  )
}

/**
 * Watches `target` for activity and reports the idle state as it
 * changes: `onIdle(true)` once `idleMs` pass without any, `onIdle(false)`
 * on the first event after that. Starts the count at once – the reader
 * is taken to be there when the watch begins. Returns the stop.
 */
export function watchPointerIdle(
  target: EventTarget,
  idleMs: number,
  onIdle: (idle: boolean) => void,
): () => void {
  let idle = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      idle = true
      onIdle(true)
    }, idleMs)
  }
  const onActivity = () => {
    if (idle) {
      idle = false
      onIdle(false)
    }
    arm()
  }
  // Passive: none of these is ever prevented here, and a wheel listener
  // that is not passive costs the scroll a round trip
  for (const type of ACTIVITY_EVENTS) target.addEventListener(type, onActivity, { passive: true })
  arm()
  return () => {
    if (timer !== null) clearTimeout(timer)
    for (const type of ACTIVITY_EVENTS) target.removeEventListener(type, onActivity)
  }
}
