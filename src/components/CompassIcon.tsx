/**
 * The compass on the button that turns the view: a dial with one arrow in
 * it, pointing north as drawn.
 *
 * It is drawn here rather than taken from lucide because lucide's compass
 * needle is the same shape at both ends. That reads as an angle but never
 * as a direction – north and south, east and west look alike – and an
 * unreadable needle is worse than none on a button whose whole job is to
 * say where the view faces. A solid-and-hollow needle, the way a paper
 * compass rose tells its ends apart, blurs into a blob at 16 px; a single
 * arrow with a notched tail still reads there.
 *
 * Otherwise it follows lucide's idiom (24×24, a 2 px round-joined ring),
 * so it sits with the icons above and below it in the control column.
 */

import type { CSSProperties } from 'react'

export function CompassIcon({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
      style={style}
    >
      <circle cx="12" cy="12" r="9.5" />
      {/* Filled rather than stroked: at this size a stroke would close the
          tail notch, and the notch is what tells the tip from the tail. */}
      <path d="M12 4.8 L16 17.4 L12 14.2 L8 17.4 Z" fill="currentColor" stroke="none" />
    </svg>
  )
}
