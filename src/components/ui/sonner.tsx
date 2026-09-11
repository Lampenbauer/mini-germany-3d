import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import type { CSSProperties } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * shadcn's Sonner wrapper. Stock shadcn reads the theme from next-themes;
 * this app has one theme, the dark one on the root element (index.html),
 * so it is named here. The toast's colours are the popover's, so a
 * notice reads as the same surface as the panel's popovers. Every toast
 * carries a close button (it still leaves on its own after its
 * duration), in the upper right corner rather than Sonner's upper left –
 * that is where every dialog and card of this app keeps its X.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      closeButton
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          '--toast-close-button-start': 'unset',
          '--toast-close-button-end': '0',
          '--toast-close-button-transform': 'translate(35%, -35%)',
        } as CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
