import type { CSSProperties, ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * The parts the five cards are built from, so a city, a line, a vehicle,
 * a stop and a ship read as one family: a head with an eyebrow, a title
 * and a lead; figures on tiles; section labels in the panel's own voice;
 * and the line's number in its colour.
 *
 * What differs between the cards is the head's ground, and that follows
 * the map's own divide (see CLAUDE.md, "Three kinds of name"): the
 * network's green for the city and its stops, the line's colour for the
 * line and its vehicles, the harbour's slate for a ship.
 */

/**
 * The head of a card: eyebrow over title over lead, the close button in
 * the corner, and whatever row the caller adds under it (mode chips, the
 * stop's lines). `behind` is drawn first and absolutely – the city card's
 * illustration – inside the head's own stacking context.
 */
/**
 * The shell every card wears: glass over the map, 400 px wide beside it
 * on a desktop; on a phone as wide as the sheet's slot at the foot of
 * the screen (CARD_SLOT in App.tsx), at most a good half of the screen
 * high, and scrolling inside where its content runs past that.
 */
export const CARD_SHELL =
  'pointer-events-auto w-100 gap-0 overflow-hidden border-border/60 bg-card/85 py-0 backdrop-blur-xl ' +
  // Scrolling as a whole, so nothing inside may give way to make it fit:
  // the head clips its illustration (overflow-hidden), which lets a flex
  // column shrink it to its eyebrow – the title went first, on a phone.
  'max-sm:w-auto max-sm:max-h-[60dvh] max-sm:overflow-y-auto max-sm:[&>*]:shrink-0'

export function CardHead(props: {
  /** Ground and ink – `bg-brand`, `bg-slate-800 text-slate-50`, or a `style`. */
  className?: string
  style?: CSSProperties
  behind?: ReactNode
  eyebrow: ReactNode
  /** The eyebrow's ink; the base is the small semibold line. */
  eyebrowClassName?: string
  title: ReactNode
  titleClassName?: string
  titleTestId?: string
  lead?: ReactNode
  leadClassName?: string
  closeLabel: string
  onClose: () => void
  children?: ReactNode
}) {
  return (
    <CardHeader
      className={cn('relative isolate gap-0 overflow-hidden px-5 pt-4 pb-4', props.className)}
      style={props.style}
    >
      {props.behind}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <span
            className={cn('mb-1.5 flex items-center gap-2 text-2xs font-semibold', props.eyebrowClassName)}
          >
            {props.eyebrow}
          </span>
          <CardTitle
            className={cn(
              'flex min-w-0 items-center gap-2 text-2xl leading-tight font-semibold tracking-tight',
              props.titleClassName,
            )}
            data-testid={props.titleTestId}
          >
            {props.title}
          </CardTitle>
          {props.lead && <p className={cn('mt-1 text-sm', props.leadClassName)}>{props.lead}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="-mt-1 -mr-2 shrink-0"
          aria-label={props.closeLabel}
          onClick={props.onClose}
        >
          <X aria-hidden />
        </Button>
      </div>
      {props.children}
    </CardHeader>
  )
}

/**
 * The ink a head in a line's colour takes, chosen by the colour's own
 * lightness: white on the deep reds and purples, the near-black slate on
 * the light blues and yellows a white would sink into. The vehicles'
 * badges on the map stay white-on-colour – a number is small enough to
 * read either way – but a head is a paragraph, and Rostock's bus 19 on
 * its light blue and line 6 on its orange were not legible in white.
 *
 * The threshold is the colour's relative luminance (sRGB, the WCAG
 * formula); 0.4 puts the mid greens and teals on the white side, where
 * they read better than the formula's own contrast ratio would suggest.
 * Anything that is not a six-digit hex – every colour in the city data
 * is one – gets the white ink.
 */
export interface HeadInk {
  /** The head's own text. */
  text: string
  /** The eyebrow and the lead, a shade quieter. */
  muted: string
  /** An arrow or a separator, quieter still. */
  dim: string
  /** The ground of the line's number in the title, on which the colour is the ink. */
  chip: string
}

const LIGHT_INK: HeadInk = {
  text: 'text-white',
  muted: 'text-white/78',
  dim: 'text-white/60',
  chip: 'bg-white',
}

const DARK_INK: HeadInk = {
  text: 'text-slate-950',
  muted: 'text-slate-950/75',
  dim: 'text-slate-950/55',
  chip: 'bg-slate-950',
}

/** Relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white); null if not hex. */
export function relativeLuminance(color: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!match) return null
  const channel = (offset: number) => {
    const value = parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

const DARK_INK_ABOVE = 0.4

export function headInk(color: string): HeadInk {
  const luminance = relativeLuminance(color)
  return luminance !== null && luminance > DARK_INK_ABOVE ? DARK_INK : LIGHT_INK
}

/** The small dot in front of an eyebrow; `animate-pulse` where it means live. */
export function EyebrowDot(props: { className?: string }) {
  return <span className={cn('size-1.5 rounded-full bg-brand-light', props.className)} aria-hidden />
}

/**
 * One figure on a card: a small label over the value, a quieter note
 * under it where the data has a second thing to say. The tile's ground is
 * the same muted surface the keyboard tab's keys stand on, so a row of
 * them reads as one instrument panel rather than as a list.
 *
 * The test id sits on the value and its note, not on the tile: what a
 * test pins is what the card says, and the label is fixed text.
 */
export function Stat(props: {
  label: string
  value: ReactNode
  note?: ReactNode
  /** The value is a "not reported" – shown quiet, not as a figure. */
  muted?: boolean
  testId?: string
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col py-1', props.className)}>
      <SectionLabel>{props.label}</SectionLabel>
      <span data-testid={props.testId}>
        <span
          className={cn(
            'block text-base font-semibold tracking-tight text-pretty tabular-nums',
            props.muted && 'text-sm font-normal text-muted-foreground',
          )}
        >
          {props.value}
        </span>
        {props.note && <span className="block text-xs text-muted-foreground">{props.note}</span>}
      </span>
    </div>
  )
}

/** A section's heading on a card, in the voice of the panel's group headers. */
export function SectionLabel(props: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'text-2xs font-medium uppercase tracking-wide text-muted-foreground',
        props.className,
      )}
    >
      {props.children}
    </span>
  )
}

/**
 * A line's number in its colour – the badge the vehicles wear on the map.
 * `sm` is the chip of the lists and the stop's line row, `lg` the mark in
 * a card's title. As a class, for the rows that are buttons.
 */
export function lineChipClass(size: 'sm' | 'lg' = 'sm'): string {
  return cn(
    'inline-flex shrink-0 items-center justify-center text-white',
    size === 'sm' ? 'h-5 min-w-5 rounded px-1.5 text-xs font-semibold' : 'size-7 rounded-md text-sm font-bold',
  )
}

export function LineChip(props: {
  id: string
  color: string
  size?: 'sm' | 'lg'
  /**
   * On a head of the line's own colour the chip inverts: the head's ink
   * (`headInk(color).chip`) becomes its ground and the colour its ink.
   */
  inverted?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        lineChipClass(props.size),
        props.inverted && headInk(props.color).chip,
        props.className,
      )}
      style={props.inverted ? { color: props.color } : { backgroundColor: props.color }}
      aria-hidden
    >
      {props.id}
    </span>
  )
}
