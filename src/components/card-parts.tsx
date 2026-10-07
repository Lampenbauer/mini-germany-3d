import {
  createContext,
  useContext,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Crosshair, X } from 'lucide-react'
import { ArrowsFromLineIcon, ArrowsToLineIcon } from '@/components/ArrowsToLineIcon'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { t } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { narrowViewport } from '@/lib/viewport'

/**
 * The parts the six cards are built from, so a city, a line, a vehicle,
 * a stop, a ship and an aircraft read as one family: a shell that folds,
 * a head with an eyebrow, a title and a lead, a body under it; figures
 * on tiles; section labels in the panel's own voice; and the line's
 * number in its colour.
 *
 * What differs between the cards is the head's ground, and that follows
 * the map's own divide (see PROJECT-PLAN-DECISIONS.md, "Four kinds of name"): the
 * network's green for the city and its stops, the line's colour for the
 * line and its vehicles, the harbour's slate for a ship, the sky's blue
 * for an aircraft.
 */

/**
 * The shell every card wears: glass over the map, 400 px wide beside it
 * on a desktop and no taller than the screen less its margin; on a phone
 * as wide as the sheet's slot at the foot of the screen (CARD_SLOT in
 * App.tsx) and at most a good half of the screen high, so the map keeps
 * the upper half. Past either cap the body scrolls under the head
 * (CardBody), never the card as a whole: the head, with the close
 * button and the card's action in it, stands whatever the body holds.
 * It scrolled as a whole on a phone before, and a long stop list took
 * the head, the close button and the follow off the top of the screen
 * with it.
 */
const CARD_SHELL =
  'pointer-events-auto w-100 gap-0 overflow-hidden border-border/60 bg-card/85 py-0 backdrop-blur-xl ' +
  'sm:max-h-[calc(100dvh-2rem)] max-sm:w-auto max-sm:max-h-[60dvh]'

/**
 * The one thing a card offers to do – follow the vehicle, the ship or
 * the aircraft, fly to the stop or the line – declared on the shell and
 * placed by the parts: on a desktop the body ends with it as a labelled
 * button, on a phone it is an icon button in the head, first in the
 * corner's row, so that it is there with the card folded to its head.
 * The icon is the crosshair every one of them wore.
 */
export interface CardAction {
  /** What the button says – its name, on a phone, where only the icon shows. */
  label: string
  onClick: () => void
  /** In force, as a follow that is running – shown pressed, and named for stopping it. */
  pressed?: boolean
}

/**
 * Every card folds to its head on a phone, the way the control panel
 * folds to its clock: the shell (CardShell) holds whether it is folded,
 * the head (CardHead) shows the panel's fold button beside the close
 * button, and the body (CardBody) leaves while folded, as the panel's
 * does – so a card is built from the three and carries nothing of it
 * itself. Folded, the head alone stays at the foot of the screen, its
 * own rows included (the stop's lines, the city's mode chips) and the
 * card's action in its corner, and still names what was picked, while
 * the map above it comes back into view: a follow ran behind a sheet
 * that covered a good half of the screen. A card opens unfolded (it was
 * asked for) and keeps its fold from one vehicle to the next while it
 * stays up; a new card starts afresh. On a desktop the card stands
 * beside the map with nothing to uncover, so the corner keeps to the
 * close button there and the action stays in the body.
 *
 * Whether it is a phone's sheet is read once, when the shell is made
 * (`narrowViewport`, the panel's way – a phone does not become a desktop
 * mid-session), rather than left to the `max-sm:` variants everything
 * else on a phone is done with: the action stands in a different place
 * of the DOM on the two, and the same button twice, one of them hidden
 * by a stylesheet, is two buttons of one name to every test and to
 * every reader without the stylesheet.
 */
interface CardShellState {
  /** A phone's sheet at the foot of the screen, not a desktop's card beside the map. */
  phone: boolean
  collapsed: boolean
  toggle: () => void
  action: CardAction | null
}

const CardShellContext = createContext<CardShellState | null>(null)

function useCardShell(): CardShellState {
  const shell = useContext(CardShellContext)
  if (!shell) throw new Error('A card head or body belongs inside a CardShell')
  return shell
}

/** The card itself, in the shell's clothes, holding the fold and the action for the head and the body in it. */
export function CardShell({
  action = null,
  className,
  ...props
}: ComponentProps<typeof Card> & { action?: CardAction | null }) {
  const [phone] = useState(narrowViewport)
  const [collapsed, setCollapsed] = useState(false)
  return (
    <CardShellContext value={{ phone, collapsed, toggle: () => setCollapsed((c) => !c), action }}>
      <Card className={cn(CARD_SHELL, className)} {...props} />
    </CardShellContext>
  )
}

/**
 * What stands under the head – left out entirely while the card is
 * folded, and ending, on a desktop, with the card's action as the
 * labelled button it always was there. It is the card's one scrolling
 * part: where the card would grow past its cap (CARD_SHELL) the body
 * gives way and scrolls, the head above it does not (`shrink-0` there,
 * `min-h-0` here – a flex item will not shrink below its content
 * otherwise). The app's own scroll area rather than the browser's bar
 * for the same reason every other list here uses it (ui/scroll-area.tsx),
 * with the fade that says what is cut off, and contained, so that a
 * finger running past the body's end does not pull at the page.
 */
export function CardBody({ className, children, ...props }: ComponentProps<typeof CardContent>) {
  const shell = useCardShell()
  if (shell.collapsed) return null
  return (
    <ScrollArea className="min-h-0" viewportClassName="scroll-fade-y overscroll-contain">
      <CardContent className={cn('flex flex-col gap-3 px-5 pt-4 pb-4', className)} {...props}>
        {children}
        {!shell.phone && shell.action && (
          <div className="flex items-center gap-2">
            <Button
              variant={shell.action.pressed ? 'default' : 'outline'}
              size="sm"
              aria-pressed={shell.action.pressed}
              onClick={shell.action.onClick}
            >
              <Crosshair aria-hidden />
              {shell.action.label}
            </Button>
          </div>
        )}
      </CardContent>
    </ScrollArea>
  )
}

/**
 * The head of a card: eyebrow over title over lead, the close button in
 * the corner – on a phone with the card's action and the fold button
 * before it – and whatever row the caller adds under it (mode chips, the
 * stop's lines). `behind` is drawn first and absolutely – the city card's
 * illustration – inside the head's own stacking context.
 */
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
  const shell = useCardShell()
  return (
    <CardHeader
      // shrink-0: the head keeps its height where the card is capped and
      // the body scrolls (CardBody); without it the flex column shrank
      // the head to its eyebrow – it clips its illustration with
      // overflow-hidden, so nothing held it open – and the title went first.
      className={cn('relative isolate shrink-0 gap-0 overflow-hidden px-5 pt-4 pb-4', props.className)}
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
        <div className="-mt-1 -mr-2 flex shrink-0 items-center">
          {shell.phone && shell.action && (
            // Pressed – a follow running – as a wash of the head's own ink,
            // which is white on the deep colours and near-black on the
            // light ones (headInk): a fixed white or black would sink into
            // one of the two.
            <Button
              variant="ghost"
              size="icon-sm"
              className="aria-pressed:bg-current/20"
              aria-label={shell.action.label}
              aria-pressed={shell.action.pressed}
              onClick={shell.action.onClick}
            >
              <Crosshair aria-hidden />
            </Button>
          )}
          {shell.phone && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={shell.collapsed ? t('card.expand') : t('card.collapse')}
              aria-expanded={!shell.collapsed}
              onClick={shell.toggle}
            >
              {shell.collapsed ? <ArrowsFromLineIcon /> : <ArrowsToLineIcon />}
            </Button>
          )}
          <Button variant="ghost" size="icon-sm" aria-label={props.closeLabel} onClick={props.onClose}>
            <X aria-hidden />
          </Button>
        </div>
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
