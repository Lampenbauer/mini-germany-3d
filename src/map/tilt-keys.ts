/**
 * Shift and ⌘ tilt the camera as Ctrl does.
 *
 * Cesium's camera controller tilts and turns the view on a drag with Ctrl
 * held (its tiltEventTypes), looks round on the spot on one with Shift
 * held (lookEventTypes), and knows no ⌘ at all: its ScreenSpaceEventHandler
 * reads shiftKey, ctrlKey and altKey off the DOM event and nothing else, so
 * a ⌘-drag reached it as a plain one and moved the map. Google Maps tilts
 * and turns on all three keys, and that is the habit a reader's hand comes
 * with. So a press on the map's canvas with Shift or ⌘ held, and every move
 * and release of a drag begun there, is handed to Cesium as one with Ctrl
 * held instead – ctrlKey shadowed true and shiftKey false on the event
 * itself, in the capture phase on the window, before any of Cesium's
 * listeners reads it. Cesium cannot tell the three apart then, which is the
 * point: the gesture, its inertia, a key pressed or let go mid-drag (Cesium
 * hands a held drag over to the keys of each move), the click it swallows –
 * a ⌘-click selects nothing now, as a Ctrl- or Shift-click never did – all
 * of it is Ctrl's. Shift's free look goes with it, by design. Alt is left as
 * it is, and so is the wheel, which zooms with ⌘ held and would not with
 * Ctrl.
 *
 * Both event families are handled, because Cesium listens to pointer events
 * where it takes them and to mouse events in Firefox
 * (FeatureDetection.supportsPointerEvents), the moves and releases on the
 * document: a drag that leaves the canvas for a panel is still the map's,
 * which is why a drag is followed off the canvas until its last button comes
 * up (the pointer events are captured by the canvas anyway). A press
 * anywhere else is never touched – Radix's tabs and menus read ctrlKey on
 * their own presses, a Ctrl-click being the Mac's right click to them.
 * tests/tilt-keys.test.ts runs both families through Cesium's own
 * CameraEventAggregator.
 */

/** What Cesium reads the keys from: pointer events where it takes them, mouse events in Firefox. */
const EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mousemove',
  'mouseup',
] as const

/**
 * Hands Shift and ⌘ on `canvas` to Cesium as Ctrl, listening on `root`
 * (the window) ahead of Cesium's own listeners. Returns the removal.
 */
export function installTiltKeys(root: EventTarget, canvas: EventTarget): () => void {
  // A drag begun on the canvas, per family: a browser that fires both lets
  // go of each on its own release, pointerup before mouseup
  const dragging = { pointer: false, mouse: false }
  const listener = (event: Event) => {
    const e = event as MouseEvent
    const family = e.type.startsWith('pointer') ? 'pointer' : 'mouse'
    const press = e.type === 'pointerdown' || e.type === 'mousedown'
    if (press && e.target === canvas) dragging[family] = true
    // A press counts on the canvas alone, a move or a release wherever its drag has gone
    const onTheMap = e.target === canvas || (!press && dragging[family])
    if (onTheMap && (e.shiftKey || e.metaKey)) {
      Object.defineProperty(e, 'ctrlKey', { value: true, configurable: true })
      Object.defineProperty(e, 'shiftKey', { value: false, configurable: true })
    }
    // The last button up ends the drag – so does a move without one, should a release go missing
    if (!press && e.buttons === 0) dragging[family] = false
  }
  const options = { capture: true, passive: true }
  for (const type of EVENTS) root.addEventListener(type, listener, options)
  return () => {
    for (const type of EVENTS) root.removeEventListener(type, listener, options)
  }
}
