/**
 * Rectangles on the screen that labels keep clear of – the webcam pictures
 * (see WebcamsLayer.screenRects). Window coordinates in CSS pixels, y
 * growing downward, the same frame the stop declutter works in.
 */
export interface ScreenRect {
  left: number
  right: number
  top: number
  bottom: number
}

/** Whether a point lies inside any of the rectangles. */
export function rectCoversPoint(rects: readonly ScreenRect[], x: number, y: number): boolean {
  for (const rect of rects) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true
  }
  return false
}

/**
 * Whether a label's box overlaps any of the rectangles: the box is
 * anchored bottom-center at (x, y) – the billboard's own anchor after
 * its pixel offset – `halfWidth` to each side and `height` upward.
 */
export function rectCoversBox(
  rects: readonly ScreenRect[],
  x: number,
  y: number,
  halfWidth: number,
  height: number,
): boolean {
  const left = x - halfWidth
  const right = x + halfWidth
  const top = y - height
  for (const rect of rects) {
    if (left < rect.right && right > rect.left && top < rect.bottom && y > rect.top) return true
  }
  return false
}

/** Whether two rectangle lists hold the same rectangles, in order. */
export function sameRects(a: readonly ScreenRect[], b: readonly ScreenRect[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const p = a[i]
    const q = b[i]
    if (p.left !== q.left || p.right !== q.right || p.top !== q.top || p.bottom !== q.bottom) {
      return false
    }
  }
  return true
}

/** One label's anchor on screen (CSS px) and half its rendered width. */
export interface LabelBox {
  x: number
  y: number
  halfWidth: number
}

/**
 * How a label sits over its anchor: how far its bottom edge floats above
 * the anchor (negative = up), how tall it is, and the clearance it keeps
 * from its neighbours. Every layer has its own plate, so the geometry is
 * passed in rather than baked into the declutter.
 */
export interface LabelMetrics {
  offsetY: number
  height: number
  gap: number
}

/**
 * Screen-space label pruning. The boxes come in nearest-first order, and a
 * label stays visible only where its box overlaps none of the boxes already
 * kept – so the nearest object wins a collision. `obstacles` are kept before
 * any label: the webcam pictures, which no label may sit on.
 *
 * Pure on purpose: this is the part of a declutter worth testing, and it
 * needs neither a scene nor a camera to do it. Used by the stop names
 * (StopsLayer) and by the fleet's ship names (VesselLayer), which is why
 * it takes the plate's geometry per call rather than baking one layer's
 * in – the two plates are different sizes.
 *
 * The fleet has no alternative: Cesium cannot be made to stack labels. A
 * LabelCollection keeps two BillboardCollections of its own and draws
 * every background before every glyph, so a name is never covered by the
 * plate in front of it however opaque that plate is – hiding the loser is
 * the only thing that works.
 */
export function keepNonOverlappingLabels(
  boxes: readonly LabelBox[],
  metrics: LabelMetrics,
  obstacles: readonly ScreenRect[] = [],
): boolean[] {
  const kept: ScreenRect[] = [...obstacles]
  return boxes.map((box) => {
    const halfWidth = box.halfWidth + metrics.gap
    // Window y grows downward; the label is anchored bottom-center at
    // its offset above the object.
    const bottom = box.y + metrics.offsetY
    const top = bottom - metrics.height - metrics.gap
    const left = box.x - halfWidth
    const right = box.x + halfWidth
    const free = !kept.some(
      (rect) => left < rect.right && right > rect.left && top < rect.bottom && bottom > rect.top,
    )
    if (free) kept.push({ left, right, top, bottom })
    return free
  })
}
