/**
 * The pair on the panel's collapse button, after Font Awesome's
 * arrows-to-line and arrows-from-line: a line with two arrows folding in
 * onto it, and the same line with the arrows opening away from it. The
 * button shows what its click will do – fold in while the panel is open,
 * open out while it is collapsed.
 *
 * Lucide's fold-vertical draws that middle line as four separate dashes,
 * which at 16 px reads as grit rather than as an edge to fold onto – and
 * the line is the whole point of the glyph, so it is drawn solid here.
 * Everything else follows lucide's idiom (24×24, 2 px round-capped
 * strokes), so it matches the icons it shares the panel with.
 */

import type { CSSProperties } from 'react'

interface ArrowsLineIconProps {
  className?: string
  style?: CSSProperties
}

/** The line, plus whichever pair of arrows meets or leaves it. */
function ArrowsLineIcon({ arrows, className, style }: ArrowsLineIconProps & { arrows: string[] }) {
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
      <path d="M3 12h18" />
      {arrows.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}

/** Arrows meeting the line from above and below: fold this away. */
export function ArrowsToLineIcon(props: ArrowsLineIconProps) {
  return (
    <ArrowsLineIcon
      {...props}
      arrows={['M12 2.5v6', 'm9 5.5 3 3 3-3', 'M12 21.5v-6', 'm9 18.5 3-3 3 3']}
    />
  )
}

/** Arrows leaving the line for the top and the bottom: open this up. */
export function ArrowsFromLineIcon(props: ArrowsLineIconProps) {
  return (
    <ArrowsLineIcon
      {...props}
      arrows={['M12 8.5v-6', 'm9 5.5 3-3 3 3', 'M12 15.5v6', 'm9 18.5 3 3 3-3']}
    />
  )
}
