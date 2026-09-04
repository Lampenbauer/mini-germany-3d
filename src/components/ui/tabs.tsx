import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '@/lib/utils'

/**
 * shadcn-style tabs on Radix. The map's view switch is the only user so
 * far, and it wears icons rather than words – hence the square triggers
 * and no assumption about text width. Content panels are unused there:
 * what a tab selects is the whole map, not a box below the list.
 */
function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  )
}

function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'inline-flex w-fit items-center justify-center gap-1 rounded-md border border-border/60 bg-card/85 p-1 shadow-xs backdrop-blur-md',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      // Lit by aria-selected rather than by data-state, which shadcn's own
      // tabs use: a trigger wrapped in a tooltip carries the tooltip's
      // data-state instead of the tab's, and two Radix primitives writing
      // the same attribute is a fight neither wins. aria-selected is the
      // tab's regardless, and it is the attribute that means this anyway.
      className={cn(
        "inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-sm px-2.5 text-sm font-medium text-muted-foreground transition-colors outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-selected:bg-primary/90 aria-selected:text-primary-foreground aria-selected:hover:bg-primary/80 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('flex-1 outline-none', className)}
      {...props}
    />
  )
}

export { Tabs, TabsContent, TabsList, TabsTrigger }
