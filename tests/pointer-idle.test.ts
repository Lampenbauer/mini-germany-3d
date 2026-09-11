import { afterEach, describe, expect, it, vi } from 'vitest'
import { hoverUnavailable, watchPointerIdle } from '@/lib/pointer-idle'

/**
 * The rest detector behind the fading rail (see App.tsx). Run against a
 * bare EventTarget under fake timers: what it watches is only events and
 * time, and neither needs a DOM.
 */

afterEach(() => {
  vi.useRealTimers()
})

describe('watchPointerIdle', () => {
  it('reports idle once the time has passed without a move, and back on the first one', () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const onIdle = vi.fn()
    const stop = watchPointerIdle(target, 10_000, onIdle)
    // Taken to be there when the watch begins: nothing yet
    vi.advanceTimersByTime(9_999)
    expect(onIdle).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenCalledTimes(1)
    expect(onIdle).toHaveBeenLastCalledWith(true)
    // Idle is said once, however long it goes on
    vi.advanceTimersByTime(60_000)
    expect(onIdle).toHaveBeenCalledTimes(1)
    target.dispatchEvent(new Event('pointermove'))
    expect(onIdle).toHaveBeenCalledTimes(2)
    expect(onIdle).toHaveBeenLastCalledWith(false)
    // And the count starts over from the movement
    vi.advanceTimersByTime(9_999)
    expect(onIdle).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(1)
    expect(onIdle).toHaveBeenLastCalledWith(true)
    stop()
  })

  it('counts a press, the wheel and a key as the reader being there, and stops when told', () => {
    vi.useFakeTimers()
    const target = new EventTarget()
    const onIdle = vi.fn()
    const stop = watchPointerIdle(target, 10_000, onIdle)
    for (const type of ['pointerdown', 'wheel', 'keydown']) {
      vi.advanceTimersByTime(9_000)
      target.dispatchEvent(new Event(type))
    }
    // Three resets: 27 s on the clock and still not idle
    expect(onIdle).not.toHaveBeenCalled()
    stop()
    vi.advanceTimersByTime(20_000)
    expect(onIdle).not.toHaveBeenCalled()
  })

  it('never says a device without a hovering pointer is one', () => {
    // No window here at all: nothing to ask, so nothing is unavailable –
    // the guard fails safe towards fading (a desktop) rather than towards
    // a rail that never fades on a device the guard cannot read
    expect(hoverUnavailable()).toBe(false)
  })
})
