// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CameraEventAggregator,
  CameraEventType,
  FeatureDetection,
  KeyboardEventModifier,
} from 'cesium'
import { installTiltKeys } from '@/map/tilt-keys'

/**
 * Shift and ⌘ on the map are Ctrl to Cesium (see tilt-keys.ts). Run
 * through Cesium's own CameraEventAggregator – what its camera controller
 * asks which drag is under way, the Ctrl drag being the one it tilts on –
 * in both families of events: pointer events, as Chrome and Safari get
 * them, and mouse events, as Firefox does, where Cesium follows a drag on
 * the document. The first test is Cesium's behaviour itself: it fails the
 * day Cesium reads the keys some other way, and the module wants a look
 * then.
 */

type Family = 'pointer' | 'mouse'
type Keys = Pick<MouseEventInit, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>

const { LEFT_DRAG } = CameraEventType
const { SHIFT, CTRL, ALT } = KeyboardEventModifier

/** Cesium's choice of the family (private, so left out of its types). */
const detection = FeatureDetection as typeof FeatureDetection & {
  supportsPointerEvents(): boolean
}

let cleanUp: (() => void)[] = []

afterEach(() => {
  for (const step of cleanUp.reverse()) step()
  cleanUp = []
  vi.restoreAllMocks()
})

/** A canvas with a panel beside it, Cesium listening to the canvas as it does in `family`'s browsers. */
function mapFor(family: Family, { tiltKeys = true } = {}) {
  vi.spyOn(detection, 'supportsPointerEvents').mockReturnValue(family === 'pointer')
  const canvas = document.createElement('canvas')
  // Cesium captures the pointer on a press; jsdom has no capture to give
  canvas.setPointerCapture = () => {}
  const panel = document.createElement('div')
  document.body.append(canvas, panel)
  const aggregator = new CameraEventAggregator(canvas)
  cleanUp.push(() => {
    aggregator.destroy()
    canvas.remove()
    panel.remove()
  })
  if (tiltKeys) cleanUp.push(installTiltKeys(window, canvas))
  return { canvas, panel, aggregator }
}

/** A left button going down, moving held or coming up on `target`, with `keys` held. */
function fire(target: EventTarget, family: Family, phase: 'down' | 'move' | 'up', keys: Keys = {}) {
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: phase === 'up' ? 0 : 1,
    clientX: 40,
    clientY: phase === 'down' ? 40 : 90,
    ...keys,
  }
  const event =
    family === 'pointer'
      ? new window.PointerEvent(`pointer${phase}`, { ...init, pointerId: 1, pointerType: 'mouse' })
      : new window.MouseEvent(`mouse${phase}`, init)
  target.dispatchEvent(event)
  return event
}

/** The keys the left drag held is filed under – undefined for none – among the single ones. */
function dragKeys(aggregator: CameraEventAggregator) {
  return [undefined, SHIFT, CTRL, ALT].filter((keys) => aggregator.isButtonDown(LEFT_DRAG, keys))
}

describe('Shift and ⌘ on the map', () => {
  it('reach Cesium as a plain drag and as its free look on their own', () => {
    const { canvas, aggregator } = mapFor('pointer', { tiltKeys: false })
    fire(canvas, 'pointer', 'down', { metaKey: true })
    fire(canvas, 'pointer', 'move', { metaKey: true })
    expect(dragKeys(aggregator)).toEqual([undefined])
    fire(canvas, 'pointer', 'up', { metaKey: true })

    fire(canvas, 'pointer', 'down', { shiftKey: true })
    fire(canvas, 'pointer', 'move', { shiftKey: true })
    expect(dragKeys(aggregator)).toEqual([SHIFT])
  })

  it.each<Family>(['pointer', 'mouse'])('drag as Ctrl does, in %s events', (family) => {
    const { canvas, aggregator } = mapFor(family)
    const held: Keys[] = [
      { metaKey: true },
      { shiftKey: true },
      { shiftKey: true, metaKey: true },
      { ctrlKey: true, shiftKey: true },
    ]
    for (const keys of held) {
      fire(canvas, family, 'down', keys)
      fire(canvas, family, 'move', keys)
      expect(dragKeys(aggregator), JSON.stringify(keys)).toEqual([CTRL])
      expect(aggregator.isMoving(LEFT_DRAG, CTRL)).toBe(true)
      fire(canvas, family, 'up', keys)
      expect(dragKeys(aggregator)).toEqual([])
      // The frame the camera controller would have drawn
      aggregator.reset()
    }
  })

  it('leave the plain drag, Ctrl and Alt as they are', () => {
    const { canvas, aggregator } = mapFor('pointer')
    const held: [Keys, KeyboardEventModifier | undefined][] = [
      [{}, undefined],
      [{ ctrlKey: true }, CTRL],
      [{ altKey: true }, ALT],
    ]
    for (const [keys, filed] of held) {
      fire(canvas, 'pointer', 'down', keys)
      fire(canvas, 'pointer', 'move', keys)
      expect(dragKeys(aggregator), JSON.stringify(keys)).toEqual([filed])
      fire(canvas, 'pointer', 'up', keys)
    }
  })

  it('hand a drag over to Ctrl when ⌘ comes mid-drag, and back when it goes, as Cesium does Ctrl', () => {
    const { canvas, aggregator } = mapFor('pointer')
    fire(canvas, 'pointer', 'down')
    fire(canvas, 'pointer', 'move')
    expect(dragKeys(aggregator)).toEqual([undefined])
    fire(canvas, 'pointer', 'move', { metaKey: true })
    expect(dragKeys(aggregator)).toEqual([CTRL])
    fire(canvas, 'pointer', 'move')
    expect(dragKeys(aggregator)).toEqual([undefined])
  })

  it('follow a Firefox drag off the canvas to its release', () => {
    const { canvas, panel, aggregator } = mapFor('mouse')
    fire(canvas, 'mouse', 'down', { metaKey: true })
    fire(panel, 'mouse', 'move', { metaKey: true })
    expect(dragKeys(aggregator)).toEqual([CTRL])
    expect(fire(panel, 'mouse', 'up', { metaKey: true }).ctrlKey).toBe(true)
    expect(dragKeys(aggregator)).toEqual([])

    // The drag is over: the panel's own events are its own again
    const hover = new window.MouseEvent('mousemove', { bubbles: true, metaKey: true })
    panel.dispatchEvent(hover)
    expect(hover.ctrlKey).toBe(false)
  })

  it.each<Family>(['pointer', 'mouse'])('leave %s events off the map alone', (family) => {
    const { panel } = mapFor(family)
    // A press elsewhere – Radix's tabs read ctrlKey on theirs – and the drag it begins
    for (const phase of ['down', 'move', 'up'] as const) {
      const event = fire(panel, family, phase, { shiftKey: true, metaKey: true })
      expect([event.shiftKey, event.ctrlKey], phase).toEqual([true, false])
    }
  })

  it('are their own keys again once removed', () => {
    const { canvas, aggregator } = mapFor('pointer', { tiltKeys: false })
    installTiltKeys(window, canvas)()
    fire(canvas, 'pointer', 'down', { metaKey: true })
    fire(canvas, 'pointer', 'move', { metaKey: true })
    expect(dragKeys(aggregator)).toEqual([undefined])
  })
})
