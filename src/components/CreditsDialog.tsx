import { useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { t } from '@/lib/i18n'
import './credits-dialog.css'

/**
 * Where everything on screen comes from – Cesium's credits, in this
 * interface's own dialog rather than in the lightbox Cesium brings along.
 * The link at the bottom of the map opens it (see CesiumMap.
 * onCreditsRequested); the Google and Cesium terms want these names
 * reachable wherever their data is drawn, which is why the link itself
 * stays where it is.
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
  return <div ref={host} className="credits-list" />
}

export function CreditsDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  borrow: (host: HTMLElement | null) => void
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent closeLabel={t('credits.close')} className="credits-dialog sm:max-w-md">
        <DialogHeader>
          {/* The same eyebrow the About dialog wears, so the two read as
              siblings – this one without its hero, being a footnote. */}
          <p className="credits-eyebrow" aria-hidden>
            <span />
            {t('credits.eyebrow')}
          </p>
          <DialogTitle className="credits-title">{t('credits.title')}</DialogTitle>
          <DialogDescription className="credits-lead">{t('credits.lead')}</DialogDescription>
        </DialogHeader>
        <BorrowedCredits borrow={props.borrow} />
      </DialogContent>
    </Dialog>
  )
}
