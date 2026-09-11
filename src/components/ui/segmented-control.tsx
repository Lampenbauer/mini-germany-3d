import * as React from 'react'
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import { cn } from '@/lib/utils'

/**
 * A segmented control: one choice of a few, side by side – Radix's
 * ToggleGroup of type "single", wearing exactly the look of the tabs list
 * (tabs.tsx), because it replaced one. The map's view switch was built as
 * tabs for that look and for the keyboard (arrows move the focus, Enter
 * picks), but a tab controls a panel, and these buttons swap what the
 * whole map shows: Radix gave every trigger an aria-controls pointing at a
 * panel that never existed, which an accessibility audit rightly flagged.
 * A radio group is what this is – Radix renders the single-choice group
 * as role="radiogroup", its items as role="radio" with aria-checked, no
 * panel anywhere – and its roving focus keeps the keys as they were.
 *
 * The lit item is styled by aria-checked rather than data-state, for the
 * reason the tabs give: another primitive wrapping an item would write
 * its own data-state over the group's. Pressing the chosen item again
 * would clear a single-choice group; the root swallows that – there is
 * always a reading on screen.
 */
function SegmentedControl({
  className,
  onValueChange,
  ...props
}: Omit<ToggleGroupPrimitive.ToggleGroupSingleProps, 'type' | 'onValueChange'> & {
  onValueChange?: (value: string) => void
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-slot="segmented-control"
      onValueChange={(value: string) => {
        if (value !== '') onValueChange?.(value)
      }}
      className={cn(
        'inline-flex w-fit items-center justify-center gap-1 rounded-md border border-border/60 bg-card/85 p-1 shadow-xs backdrop-blur-xl',
        className,
      )}
      {...props}
    />
  )
}

function SegmentedControlItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>) {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="segmented-control-item"
      className={cn(
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm px-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-checked:bg-primary/90 aria-checked:text-primary-foreground aria-checked:hover:bg-primary/80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

export { SegmentedControl, SegmentedControlItem }
