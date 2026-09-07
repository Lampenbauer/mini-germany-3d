/**
 * The caret every picker in the app wears on its trigger: a small solid
 * triangle pointing down, after Font Awesome's caret-down.
 *
 * Lucide has no caret. Its chevron is the nearest thing, but a two-stroke
 * arrowhead reads as "there is more below" – the same glyph the panel's
 * own scroll hints and its accordion use – where a filled wedge reads as
 * "this opens a list", which is what a select promises. Drawn here in
 * lucide's box (24×24, currentColor) so it sits level with the lucide
 * glyphs beside it, and filled through a round-joined stroke so its
 * corners are as soft as the rest of the set.
 */

import type { CSSProperties } from 'react'

export function CaretDownIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={style}
    >
      {/* Wider than tall, as a caret is: the stroke around it carries the
          wedge out to roughly Font Awesome's 5:3, and hangs its box a
          quarter unit low so the tip does not look like it is sinking. */}
      <path d="M12 15 7 9.5h10z" />
    </svg>
  )
}
