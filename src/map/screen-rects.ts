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
