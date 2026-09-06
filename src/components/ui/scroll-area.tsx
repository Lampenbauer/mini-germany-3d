import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { cn } from '@/lib/utils'

/**
 * shadcn-style scroll area on Radix: the browser's own scrollbar is
 * hidden and a thin, rounded one is drawn in its place, the same on
 * every platform. Windows' native bars are wide, square and grey and
 * sat badly in the translucent cards; macOS' overlay bars looked fine
 * and are matched here rather than replaced with something else.
 *
 * `viewportClassName` reaches the element that actually scrolls – the
 * scroll-fade-y mask (index.css) has to sit on that one, not on the
 * root, or the fade would clip the scrollbar with the content.
 *
 * Unlike shadcn's original, the root is a flex column and the viewport
 * takes its height by flexing (`flex-1 min-h-0`) rather than by `h-full`.
 * A percentage height needs a definite height above it, and none of the
 * places this scrolls in has one: the panel is capped by a max-height,
 * the cards' lists by a max-height of their own. With `h-full` the
 * viewport grew to its content and the root clipped it – a list cut off
 * where it should have scrolled. A flex item sizes without asking its
 * ancestors, so the same component serves `max-h-48` and `flex-1` alike.
 *
 * Radix wraps the viewport's children in a `display: table` div so that
 * wide content can define a horizontal scroll width. Everything here
 * scrolls vertically only, and a table sizes itself to its content: a
 * long webcam title or line destination then widened that wrapper past
 * the viewport instead of being cut with an ellipsis, and `truncate` on
 * the rows had nothing to truncate against. The wrapper is made a plain
 * block (`!important`, it is an inline style) and so is as wide as the
 * viewport, no wider.
 */
function ScrollArea({
  className,
  viewportClassName,
  children,
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportClassName?: string }) {
  return (
    <ScrollAreaPrimitive.Root
      data-slot="scroll-area"
      className={cn('relative flex min-h-0 flex-col', className)}
      {...props}
    >
      <ScrollAreaPrimitive.Viewport
        data-slot="scroll-area-viewport"
        className={cn(
          'min-h-0 w-full flex-1 rounded-[inherit] outline-none transition-[color,box-shadow] focus-visible:ring-[3px] focus-visible:ring-ring/50 [&>div]:block!',
          viewportClassName,
        )}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollBar />
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  )
}

function ScrollBar({
  className,
  orientation = 'vertical',
  ...props
}: React.ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      data-slot="scroll-area-scrollbar"
      orientation={orientation}
      className={cn(
        'flex touch-none select-none p-px transition-colors',
        orientation === 'vertical' && 'h-full w-2 border-l border-l-transparent',
        orientation === 'horizontal' && 'h-2 flex-col border-t border-t-transparent',
        className,
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb
        data-slot="scroll-area-thumb"
        className="relative flex-1 rounded-full bg-border"
      />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
}

export { ScrollArea, ScrollBar }
