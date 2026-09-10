import { useRef } from 'react'
import { ArrowUpRight, Keyboard, Route, Ship, TrainFront } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { NetworkIllustration } from '@/components/NetworkIllustration'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { t, type MessageKey } from '@/lib/i18n'

const MINI_TOKYO_URL = 'https://minitokyo3d.com'
const LEGIBLE_CITIES_URL = 'https://richc117.github.io/legible-cities/'
const AUTHOR_URL = 'https://www.lampenbauer.com/mario-fotograf/'
const AUTHOR_SITE_URL = 'https://www.lampenbauer.com/'
const AUTHOR_LINKEDIN_URL = 'https://www.linkedin.com/in/mario-m%C3%BCller-1ba877266/'

/*
 * Class strings that more than one element wears, kept here rather than
 * repeated inline – the styling still lives with the markup, this is only
 * the markup saying the same thing once. Written out in full: Tailwind
 * finds its classes by reading the source as text, so a name assembled
 * from pieces at runtime is a name it never generates a rule for.
 *
 * A laptop turned on its side is the one viewport the hero has to give
 * ground on, hence the stacked `sm:[@media(max-height:560px)]` variants
 * below: wide enough for the desktop layout, too short for its
 * full-height headline.
 */

/** A tab in the dialog's own tab bar: an underline, not the app's pill. */
const TAB =
  'h-12 shrink-0 rounded-none border-b-2 border-transparent px-0 text-xs ' +
  'hover:bg-transparent hover:text-foreground ' +
  'aria-selected:border-b-brand-light aria-selected:bg-transparent aria-selected:text-foreground ' +
  'aria-selected:hover:bg-transparent ' +
  'focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-5 focus-visible:outline-ring ' +
  'max-sm:text-[11px] max-sm:[&_svg]:hidden'

/** One scrollable tab panel. Radix hides the inactive one with [hidden],
 *  which a display:flex of our own would otherwise talk over. */
const PANEL =
  'flex flex-col gap-6.5 px-8 pt-7 pb-8 text-[13px] leading-relaxed text-muted-foreground ' +
  'data-[state=inactive]:hidden max-sm:p-6'

/** A section heading inside a panel, and the paragraphs under it. */
const HEADING = 'text-[15px] font-semibold tracking-tight text-foreground'
const BODY = 'mt-1.75 text-pretty'

/** The muted heading over the story tab's lower sections. */
const SMALL_HEADING = 'mb-3 text-xs font-semibold tracking-tight text-muted-foreground'

/** The icon beside a section on the details tab, in the dialog's green. */
const ICON =
  'mt-0.75 size-4.75 shrink-0 text-brand-mid'

const SHORTCUTS: readonly { keys: readonly string[]; labelKey: MessageKey }[] = [
  { keys: ['Space'], labelKey: 'keys.pause' },
  { keys: ['+', '−'], labelKey: 'keys.speed' },
  { keys: ['N'], labelKey: 'keys.now' },
  { keys: ['S', 'U', 'L'], labelKey: 'keys.readings' },
  { keys: ['R'], labelKey: 'keys.home' },
  { keys: ['C'], labelKey: 'keys.compass' },
  { keys: ['2', '3'], labelKey: 'keys.pitch' },
  { keys: ['M'], labelKey: 'keys.miniature' },
  { keys: ['F'], labelKey: 'keys.fullscreen' },
  { keys: ['H'], labelKey: 'keys.hideUi' },
  { keys: ['Esc'], labelKey: 'keys.dismiss' },
  { keys: ['?'], labelKey: 'keys.help' },
]

function Outward(props: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.75 rounded-xs font-[550] text-foreground no-underline underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    >
      {props.children}<ArrowUpRight aria-hidden className="size-3.5 opacity-50" />
    </a>
  )
}

export function AboutDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  // This controlled dialog also opens via ?, so it has no Radix DialogTrigger.
  const returnFocus = useRef<HTMLElement | null>(null)

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent
        closeLabel={t('about.close')}
        // The dialog's own close button sits on the green hero, so it is
        // lifted over the illustration and turned light – DialogContent
        // renders it itself, which is why it is reached by selector.
        className={cn(
          'h-[min(740px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-2xl bg-card p-0 shadow-2xl sm:max-w-170',
          // On a phone the dialog is the screen: edge to edge, no frame,
          // no corner – a window inside a window of that size is only a
          // border around less room.
          'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-screen max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-none max-sm:border-0',
          '[&>button:last-child]:z-1 [&>button:last-child]:text-[oklch(0.9698_0.0091_161.35)] [&>button:last-child:hover]:bg-white/12',
        )}
        onOpenAutoFocus={() => {
          returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
        onCloseAutoFocus={(event) => {
          if (returnFocus.current?.isConnected) {
            event.preventDefault()
            returnFocus.current.focus()
          }
        }}
      >
        <DialogHeader
          className={cn(
            'relative isolate shrink-0 gap-0 overflow-hidden bg-brand p-8 text-[oklch(0.9698_0.0091_161.35)]',
            'max-sm:px-6 max-sm:py-6.5',
            'sm:[@media(max-height:560px)]:px-8 sm:[@media(max-height:560px)]:py-5',
          )}
        >
          {/* Behind the hero's text (the hero isolates, so -z-10 stops there)
              and faded out towards the headline it must not compete with. */}
          <NetworkIllustration className="absolute top-0 -right-3 -z-10 h-full w-65 [mask-image:linear-gradient(to_right,transparent,black_32%)] max-sm:-right-25 max-sm:opacity-18" />
          <span
            className={cn(
              'mb-5.5 flex items-center gap-2 text-2xs font-semibold text-[oklch(0.8564_0.0404_176.63)]',
              'max-sm:mb-4.5 max-sm:text-[9px]',
              'sm:[@media(max-height:560px)]:mb-2.5',
            )}
          >
            <span className="size-1.5 rounded-full bg-brand-light" />
            {t('about.eyebrow')}
          </span>
          <DialogTitle
            className={cn(
              'max-w-[390px] text-4xl leading-[1.12] font-[650] tracking-tighter',
              'max-sm:max-w-[260px] max-sm:text-[32px]',
              'sm:[@media(max-height:560px)]:text-[28px]',
            )}
          >
            {t('about.title')}
          </DialogTitle>
          <DialogDescription
            className={cn(
              'mt-3 max-w-[355px] text-sm leading-relaxed text-pretty text-[oklch(0.8782_0.0268_172.79)]',
              'max-sm:max-w-[250px] max-sm:text-[13px]',
              'sm:[@media(max-height:560px)]:mt-1.75 sm:[@media(max-height:560px)]:max-w-[410px]',
            )}
          >
            {t('about.lead')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="story" className="min-h-0 flex-1 gap-0">
          <TabsList
            aria-label={t('about.open')}
            className="w-full shrink-0 justify-start gap-5.5 rounded-none border-0 border-b border-b-border bg-transparent px-8 py-0 shadow-none backdrop-blur-none max-sm:gap-5 max-sm:px-6"
          >
            <TabsTrigger value="story" className={TAB}>{t('about.storyTab')}</TabsTrigger>
            <TabsTrigger value="details" className={TAB}>{t('about.detailsTab')}</TabsTrigger>
            {/* A phone has no keyboard to explain (see lib/viewport.ts) */}
            <TabsTrigger value="keyboard" className={cn(TAB, 'max-sm:hidden')}>
              <Keyboard aria-hidden className="size-3.5" />{t('keys.title')}
            </TabsTrigger>
          </TabsList>
          {/* One scroller for all three panels, so the hero and the tab bar
              stay put however long a panel gets – the app's own scroll area,
              with the fade at both ends that the panel and the cards wear. */}
          <ScrollArea className="flex-1" viewportClassName="scroll-fade-y overscroll-contain">
            <TabsContent value="story" className={PANEL}>
              {/* The project first, the person after it: the tab is
                  named after the project, so that is what it opens on. */}
              <section>
                <h3 className="text-[21px] leading-tight font-semibold tracking-tight text-foreground">
                  {t('about.projectTitle')}
                </h3>
                <p className={BODY}>{t('about.project')}</p>
                <p className={BODY}>{t('about.projectRealism')}</p>
                <p className={cn(BODY, 'text-foreground')}>{t('about.invitation')}</p>
              </section>
              <section className="border-t border-border pt-5.5">
                <h3 className={SMALL_HEADING}>{t('about.whoTitle')}</h3>
                <p className="text-pretty">{t('about.who')}</p>
                <div className="mt-3.75 flex flex-wrap gap-x-4 gap-y-2 text-[11px]">
                  <Outward href={AUTHOR_URL}>{t('about.authorLink')}</Outward>
                  <Outward href={AUTHOR_SITE_URL}>lampenbauer.com</Outward>
                  <Outward href={AUTHOR_LINKEDIN_URL}>LinkedIn</Outward>
                </div>
              </section>
              <section className="border-t border-border pt-5.5">
                <h3 className={SMALL_HEADING}>{t('about.rootsTitle')}</h3>
                <div className="grid grid-cols-2 gap-6 max-sm:grid-cols-1 max-sm:gap-4.5">
                  <div className="relative pl-3.75">
                    <span className="absolute top-1.25 bottom-0.75 left-0 w-0.75 rounded-xs bg-brand-mid" />
                    <Outward href={MINI_TOKYO_URL}>mini-tokyo-3d</Outward>
                    <p className={cn(BODY, 'text-xs leading-relaxed')}>{t('about.miniTokyo')}</p>
                  </div>
                  <div className="relative pl-3.75">
                    <span className="absolute top-1.25 bottom-0.75 left-0 w-0.75 rounded-xs bg-[oklch(0.6764_0.0813_250.78)]" />
                    <Outward href={LEGIBLE_CITIES_URL}>legible-cities</Outward>
                    <p className={cn(BODY, 'text-xs leading-relaxed')}>{t('about.legibleCities')}</p>
                  </div>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="details" className={PANEL}>
              <section className="flex items-start gap-3.5">
                <TrainFront aria-hidden className={ICON} />
                <div><h3 className={HEADING}>{t('about.notTitle')}</h3><p className={BODY}>{t('about.notLive')}</p></div>
              </section>
              <section className="flex items-start gap-3.5">
                <Ship aria-hidden className={ICON} />
                <div><h3 className={HEADING}>{t('about.shipsTitle')}</h3><p className={BODY}>{t('about.notShips')}</p></div>
              </section>
              <section className="flex items-start gap-3.5">
                <Route aria-hidden className={ICON} />
                <div>
                  <h3 className={HEADING}>{t('about.exploreTitle')}</h3>
                  <p className={BODY}>{t('about.notRouting')}</p>
                  <p className={BODY}>{t('about.notComplete')}</p>
                </div>
              </section>
              <section className="border-t border-border pt-5 text-xs leading-relaxed">
                <h3 className={HEADING}>{t('about.builtTitle')}</h3>
                <p className={BODY}>{t('about.built')}</p>
              </section>
            </TabsContent>

            <TabsContent value="keyboard" className={PANEL}>
              <div>
                <h3 className={HEADING}>{t('keys.open')}</h3>
                <p className={BODY}>{t('about.keyboardLead')}</p>
              </div>
              <ul className="grid grid-cols-2 gap-x-6.5 gap-y-0 max-sm:grid-cols-1">
                {SHORTCUTS.map(({ keys, labelKey }) => (
                  <li
                    key={labelKey}
                    className="flex items-center justify-between gap-3 border-b border-border py-3 text-[11px]"
                  >
                    <span>{t(labelKey)}</span>
                    <span className="flex shrink-0 gap-1">
                      {keys.map((key) => (
                        <kbd
                          key={key}
                          className="min-w-5.75 rounded-sm border border-b-2 border-border bg-muted px-1.25 py-0.5 text-center text-2xs text-foreground [font-family:inherit]"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
