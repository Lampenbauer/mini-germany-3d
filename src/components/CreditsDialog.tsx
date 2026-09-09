import { useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { t } from '@/lib/i18n'

/**
 * Where everything on screen comes from – Cesium's credits, in this
 * interface's own dialog rather than in the lightbox Cesium brings along.
 * The link at the bottom of the map opens it (see CesiumMap.
 * onCreditsRequested); the Google and Cesium terms want these names
 * reachable wherever their data is drawn, which is why the link itself
 * stays where it is.
 *
 * A small sibling of the About dialog: the same eyebrow, the same tight
 * title, the same links – but no hero, being a footnote rather than a
 * story.
 *
 * The list is Cesium's own element, borrowed while the dialog is up: it
 * is rewritten on every frame as tiles load and layers come and go, and
 * copying it here would freeze it at the moment the dialog opened.
 */
function BorrowedCredits(props: { borrow: (host: HTMLElement | null) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const { borrow } = props
  useEffect(() => {
    borrow(host.current)
    // Handed back the moment the dialog closes – Cesium goes on writing
    // to it either way, and a list left in an unmounted node would be
    // updated into nothing.
    return () => borrow(null)
  }, [borrow])
  return (
    /*
     * Cesium's rules only reach its list inside .cesium-credit-lightbox, so
     * here it arrives unstyled: a bare <ul> of <li>s, each holding whatever
     * markup the source gave – plain text, a link, or a logo bitmap. Those
     * are not ours to put classes on, hence the descendant selectors. The
     * logos ship as bitmaps at their natural size, as in the credit line.
     */
    <div
      ref={host}
      className="border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground [&_a:hover]:underline [&_a]:font-[550] [&_a]:text-foreground [&_a]:no-underline [&_a]:underline-offset-4 [&_img]:[zoom:0.7] [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2.5"
    />
  )
}

export function CreditsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  borrow: (host: HTMLElement | null) => void
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t('credits.close')}
        className="max-h-[calc(100dvh-2rem)] rounded-2xl shadow-2xl sm:max-w-md"
      >
        <DialogHeader>
          {/* The same eyebrow the About dialog wears, so the two read as
              siblings – this one without its hero, being a footnote. */}
          <p
            className="mb-3.5 flex items-center gap-2 text-2xs font-semibold text-muted-foreground"
            aria-hidden
          >
            <span className="size-1.5 rounded-full bg-brand-light" />
            {t('credits.eyebrow')}
          </p>
          <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight">
            {t('credits.title')}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] leading-relaxed text-pretty">
            {t('credits.lead')}
          </DialogDescription>
        </DialogHeader>
        <BorrowedCredits borrow={props.borrow} />
      </DialogContent>
    </Dialog>
  )
}
