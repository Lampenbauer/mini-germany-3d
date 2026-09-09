import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * One figure on a card, the way the city and the vessel card state theirs:
 * a small label over the value, a quieter note under it where the data has
 * a second thing to say. The tile's ground is the same muted surface the
 * keyboard tab's keys stand on, so a row of them reads as one instrument
 * panel rather than as a list.
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
    <div className={cn('flex min-w-0 flex-col rounded-lg bg-muted/40 px-3 py-2.5', props.className)}>
      <span className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </span>
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
