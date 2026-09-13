import type { MouseEvent } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { getLanguage, t } from '@/lib/i18n'
import { legalText } from '@/lib/legal'
import { formatLegalPath, type LegalKind } from '@/lib/site-path'
import { cn } from '@/lib/utils'

/**
 * The legal notice and the privacy notice (lib/legal.ts), one dialog
 * for either – a small sibling of the Credits dialog: the same eyebrow,
 * the same tight title, no hero, because it is a footnote to the site
 * and not a story. Deliberately not a fourth tab of the About dialog:
 * the tabs there are about the map, and these two are about the site.
 *
 * The same text stands as a page of its own under the map
 * (lib/site-pages.ts, `/impressum/`, `/en/privacy/` …) for whoever gets
 * no dialog – a crawler, a browser without WebGL – and the links that
 * open this dialog (LegalLinks below) are real links to those pages,
 * so a middle click, a copied address or a reader without scripts
 * still lands on the text.
 */

/** The dialog's body, a section per heading. */
const SECTION = 'text-[13px] leading-relaxed text-muted-foreground'
const HEADING = 'text-[15px] font-semibold tracking-tight text-foreground'
/** A paragraph; an address block keeps its line breaks. */
const BODY = 'mt-1.75 whitespace-pre-line text-pretty'

export function LegalDialog(props: {
  /** Which notice is up, or null for none. */
  kind: LegalKind | null
  onOpenChange: (open: boolean) => void
}) {
  // The text of the last kind shown stays for the closing animation;
  // nothing is rendered while the dialog was never opened.
  const text = props.kind ? legalText(props.kind, getLanguage()) : null
  return (
    <Dialog open={props.kind !== null} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t('legal.close')}
        data-testid="legal-dialog"
        className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-lg"
      >
        <DialogHeader className="shrink-0 p-6 pb-4">
          {/* The Credits dialog's eyebrow, so the two read as siblings */}
          <p
            className="mb-3.5 flex items-center gap-2 text-2xs font-semibold text-muted-foreground"
            aria-hidden
          >
            <span className="size-1.5 rounded-full bg-brand-light" />
            {t('legal.title')}
          </p>
          <DialogTitle className="text-2xl leading-tight font-semibold tracking-tight">
            {text?.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-[13px] leading-relaxed text-pretty">
            {text?.lead}
          </DialogDescription>
        </DialogHeader>
        {/* The sections scroll under the head, which stays put – the
            privacy notice is longer than any screen. */}
        <ScrollArea className="min-h-0 flex-1" viewportClassName="scroll-fade-y overscroll-contain">
          <div className="flex flex-col gap-5 border-t border-border px-6 pt-5 pb-6">
            {text?.sections.map((section) => (
              <section key={section.heading} className={SECTION}>
                <h3 className={HEADING}>{section.heading}</h3>
                {section.paragraphs.map((paragraph, i) => (
                  <p key={i} className={BODY}>
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}

/** Whether a click is the plain kind a link may take over – no modifier, no middle button. */
function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

/**
 * The two links, side by side: real links to the pages under the map,
 * which the app takes over to open the dialog instead. A modified click
 * (a new tab) goes to the page as any link would. The caller styles
 * them for its ground – pale on the welcome screen's green, muted on
 * the About dialog's card – through `linkClassName`, which every link
 * wears; `className` places the row itself.
 */
export function LegalLinks(props: {
  className?: string
  linkClassName?: string
  onOpen: (kind: LegalKind) => void
}) {
  const lang = getLanguage()
  const kinds: readonly LegalKind[] = ['imprint', 'privacy']
  return (
    <nav aria-label={t('legal.title')} className={cn('flex items-center gap-4', props.className)}>
      {kinds.map((kind) => (
        <a
          key={kind}
          href={formatLegalPath(lang, kind)}
          className={cn(
            'rounded-xs no-underline underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4',
            props.linkClassName,
          )}
          onClick={(event) => {
            if (!plainClick(event)) return
            event.preventDefault()
            props.onOpen(kind)
          }}
        >
          {t(kind === 'imprint' ? 'legal.imprint' : 'legal.privacy')}
        </a>
      ))}
    </nav>
  )
}
