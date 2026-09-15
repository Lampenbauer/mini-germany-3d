import * as React from 'react'
import { useEffect, useState } from 'react'
import * as PopoverPrimitive from '@radix-ui/react-popover'
import { cn } from '@/lib/utils'
import { narrowViewport } from '@/lib/viewport'

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/** What a popover is placed against instead of its trigger, where one is given (see LayersPopover). */
function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />
}

/**
 * How close to the window's edges a popover may come, in px. Radix
 * flips and shifts a popover to keep it inside the window; this keeps
 * it a step short of the edge as well, so a tall one (the photo mode's
 * knobs) never touches the top or bottom and a wide one never sits
 * against a side. A scroll area inside a popover budgets for it – see
 * the photo popover's ceiling. It is the inset the controls keep from
 * the edges – `4` (16 px) on a desktop, `3` (12 px) on a phone (the
 * `max-sm:` variants in App.tsx) – so that a popover shifted to an edge
 * stands on the controls' own line: the weather's opened 4 px under
 * its button on a phone while the padding was 16 there too.
 */
export const POPOVER_EDGE_PADDING = 16
export const PHONE_POPOVER_EDGE_PADDING = 12

function PopoverContent({
  className,
  align = 'end',
  sideOffset = 8,
  collisionPadding = narrowViewport() ? PHONE_POPOVER_EDGE_PADDING : POPOVER_EDGE_PADDING,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        className={cn(
          // Same glass as the map controls it opens from: the panels over
          // the map are translucent cards, not opaque dialogs.
          'bg-card/95 text-card-foreground border-border/60 animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-64 origin-(--radix-popover-content-transform-origin) rounded-lg border p-3 shadow-lg outline-none backdrop-blur-xl',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverAnchor, PopoverContent }

/**
 * The open state of a popover that goes away with the interface. Radix
 * portals a popover's content to the body, so the wrapper that H hides
 * (see the ui-overlay in App.tsx) takes the trigger away and leaves the
 * content standing over a bare map. A popover in this app is therefore
 * controlled through this hook and closes the moment the interface is
 * hidden – by H, or by a dialog going up.
 */
export function usePopoverOpen(interfaceHidden: boolean): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (interfaceHidden) setOpen(false)
  }, [interfaceHidden])
  return [open, setOpen]
}
