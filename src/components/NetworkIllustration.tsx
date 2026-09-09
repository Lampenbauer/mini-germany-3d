import { cn } from '@/lib/utils'

/**
 * A small, deliberately imaginary network, echoing the map's three
 * readings: the About dialog's hero wears it large, the city card's head
 * small. Callers place and fade it; the glyph itself only knows its own
 * pale green for the grid behind the lines.
 */
export function NetworkIllustration(props: { className?: string }) {
  return (
    <svg
      className={cn('text-[oklch(0.9518_0.0254_171.96)]', props.className)}
      viewBox="0 0 280 220"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1" opacity=".12">
        <path d="M0 45H280M0 85H280M0 125H280M0 165H280M0 205H280M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220" />
      </g>
      <g strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M-15 172H70Q88 172 101 159L183 77Q196 64 214 64H300" className="stroke-brand-light" />
        <path d="M62 -15V55Q62 72 75 85L154 164Q167 177 186 177H296" stroke="oklch(0.8189 0.1059 75.1)" />
        <path d="M-10 103H94Q111 103 124 116L183 175Q196 188 196 207V235" stroke="oklch(0.7382 0.1 252.77)" />
      </g>
      <g fill="oklch(0.3229 0.0448 183.84)" stroke="oklch(0.9518 0.0254 171.96)" strokeWidth="3">
        <circle cx="30" cy="172" r="5" /><circle cx="214" cy="64" r="5" />
        <circle cx="62" cy="32" r="5" /><circle cx="235" cy="177" r="5" />
        <circle cx="37" cy="103" r="5" /><circle cx="196" cy="214" r="5" />
        <circle cx="119" cy="128" r="9" /><circle cx="165" cy="158" r="7" />
      </g>
      <g transform="translate(153 87) rotate(-45)">
        <rect x="-17" y="-8" width="34" height="16" rx="6" fill="oklch(0.9787 0.0091 161.36)" stroke="oklch(0.3229 0.0448 183.84)" strokeWidth="2" />
        <path d="M-7 -4V4M0 -4V4M7 -4V4" stroke="oklch(0.3229 0.0448 183.84)" strokeWidth="3" />
      </g>
    </svg>
  )
}
