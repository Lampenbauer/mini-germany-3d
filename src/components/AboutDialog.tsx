import { useRef } from 'react'
import { ArrowUpRight, Keyboard, Route, Ship, TrainFront } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { t, type MessageKey } from '@/lib/i18n'

const MINI_TOKYO_URL = 'https://minitokyo3d.com'
const LEGIBLE_CITIES_URL = 'https://github.com/richc117/legible-cities'
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
  'h-[51px] shrink-0 rounded-none border-b-2 border-transparent px-0 text-[12px] ' +
  'hover:bg-transparent hover:text-foreground ' +
  'aria-selected:border-b-[oklch(0.6283_0.0988_174.84)] aria-selected:bg-transparent aria-selected:text-foreground ' +
  'aria-selected:hover:bg-transparent ' +
  'focus-visible:ring-0 focus-visible:outline-2 focus-visible:-outline-offset-5 focus-visible:outline-ring ' +
  'max-sm:text-[11px] max-sm:[&_svg]:hidden'

/** One scrollable tab panel. Radix hides the inactive one with [hidden],
 *  which a display:flex of our own would otherwise talk over. */
const PANEL =
  'flex flex-col gap-[26px] px-8 pt-7 pb-8 text-[13px] leading-[1.7] text-muted-foreground ' +
  'data-[state=inactive]:hidden max-sm:p-6'

/** A section heading inside a panel, and the paragraphs under it. */
const HEADING = 'text-[15px] font-semibold tracking-[-0.025em] text-foreground'
const BODY = 'mt-[7px] text-pretty'

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
      className="inline-flex items-center gap-[3px] rounded-[2px] font-[550] text-foreground no-underline underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
    >
      {props.children}<ArrowUpRight aria-hidden className="size-3.5 opacity-50" />
    </a>
  )
}

/** A small, deliberately imaginary network, echoing the map's three readings. */
function NetworkIllustration() {
  return (
    <svg
      // Behind the hero's text (the hero isolates, so -z-10 stops there)
      // and faded out towards the headline it must not compete with.
      className="absolute top-0 -right-3 -z-10 h-full w-[260px] text-[oklch(0.9518_0.0254_171.96)] [mask-image:linear-gradient(to_right,transparent,black_32%)] max-sm:right-[-100px] max-sm:opacity-[.18]"
      viewBox="0 0 280 220"
      fill="none"
      aria-hidden="true"
    >
      <g stroke="currentColor" strokeWidth="1" opacity=".12">
        <path d="M0 45H280M0 85H280M0 125H280M0 165H280M0 205H280M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220" />
      </g>
      <g strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M-15 172H70Q88 172 101 159L183 77Q196 64 214 64H300" stroke="oklch(0.8254 0.1241 174.21)" />
        <path d="M62 -15V55Q62 72 75 85L154 164Q167 177 186 177H296" stroke="oklch(0.8189 0.1059 75.1)" />
        <path d="M-10 103H94Q111 103 124 116L183 175Q196 188 196 207V235" stroke="oklch(0.7382 0.1 252.77)" />
      </g>
      <g fill="oklch(0.3229 0.0448 183.84)" stroke="oklch(0.9518 0.0254 171.96)" strokeWidth="3">
        <circle cx="30" cy="172" r="5" /><circle cx="214" cy="64" r="5" />
        <circle cx="62" cy="32" r="5" /><circle cx="235" cy="177" r="5" />
        <circle cx="37" cy="103" r="5" /><circle cx="196" cy="214" r="5" />
        <circle cx="119" cy="128" r="9" /><circle cx="165" cy="158" r="7" />
      </g>
      <g transform="translate(153 87) rotate(-45)">
        <rect x="-17" y="-8" width="34" height="16" rx="6" fill="oklch(0.9787 0.0091 161.36)" stroke="oklch(0.3229 0.0448 183.84)" strokeWidth="2" />
        <path d="M-7 -4V4M0 -4V4M7 -4V4" stroke="oklch(0.3229 0.0448 183.84)" strokeWidth="3" />
      </g>
    </svg>
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
          'h-[min(740px,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden rounded-[20px] bg-card p-0 shadow-[0_24px_100px_oklch(0_0_0_/_0.33)] sm:max-w-[680px]',
          '[&>button:last-child]:z-1 [&>button:last-child]:text-[oklch(0.9698_0.0091_161.35)] [&>button:last-child:hover]:bg-[oklch(1_0_0_/_0.125)]',
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
            'max-sm:px-6 max-sm:py-[26px]',
            'sm:[@media(max-height:560px)]:px-8 sm:[@media(max-height:560px)]:py-5',
          )}
        >
          <NetworkIllustration />
          <span
            className={cn(
              'mb-[22px] flex items-center gap-2 text-[10px] font-semibold text-[oklch(0.8564_0.0404_176.63)]',
              'max-sm:mb-[18px] max-sm:text-[9px]',
              'sm:[@media(max-height:560px)]:mb-2.5',
            )}
          >
            <span className="size-1.5 rounded-full bg-[oklch(0.8254_0.1241_174.21)]" />
            {t('about.eyebrow')}
          </span>
          <DialogTitle
            className={cn(
              'max-w-[390px] text-[36px] leading-[1.12] font-[650] tracking-[-0.055em]',
              'max-sm:max-w-[260px] max-sm:text-[32px]',
              'sm:[@media(max-height:560px)]:text-[28px]',
            )}
          >
            {t('about.title')}
          </DialogTitle>
          <DialogDescription
            className={cn(
              'mt-3 max-w-[355px] text-[14px] leading-[1.65] text-pretty text-[oklch(0.8782_0.0268_172.79)]',
              'max-sm:max-w-[250px] max-sm:text-[13px]',
              'sm:[@media(max-height:560px)]:mt-[7px] sm:[@media(max-height:560px)]:max-w-[410px]',
            )}
          >
            {t('about.lead')}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="story" className="min-h-0 flex-1 gap-0">
          <TabsList
            aria-label={t('about.open')}
            className="w-full shrink-0 justify-start gap-[22px] rounded-none border-0 border-b border-b-border bg-transparent px-8 py-0 shadow-none backdrop-blur-none max-sm:gap-5 max-sm:px-6"
          >
            <TabsTrigger value="story" className={TAB}>{t('about.storyTab')}</TabsTrigger>
            <TabsTrigger value="details" className={TAB}>{t('about.detailsTab')}</TabsTrigger>
            <TabsTrigger value="keyboard" className={TAB}>
              <Keyboard aria-hidden className="size-3.5" />{t('keys.title')}
            </TabsTrigger>
          </TabsList>
          {/* One scroller for all three panels, so the hero and the tab bar
              stay put however long a panel gets. */}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
            <TabsContent value="story" className={PANEL}>
              <section className="flex gap-[18px] max-sm:flex-col max-sm:gap-3">
                <div
                  className="flex size-[46px] shrink-0 items-center justify-center rounded-[15px] border border-[oklch(0.6283_0.0988_174.84_/_0.149)] bg-[oklch(0.6283_0.0988_174.84_/_0.071)] text-[25px] font-semibold tracking-[-0.08em] text-[oklch(0.5577_0.0908_175.29)] dark:text-[oklch(0.8075_0.1028_174.78)]"
                  aria-hidden="true"
                >
                  m.
                </div>
                <div>
                  <h3 className="text-[21px] leading-[1.3] font-semibold tracking-[-0.025em] text-foreground">
                    {t('about.whoTitle')}
                  </h3>
                  <p className={BODY}>{t('about.who')}</p>
                  <p className={cn(BODY, 'text-foreground')}>{t('about.invitation')}</p>
                  <div className="mt-[15px] flex flex-wrap gap-x-4 gap-y-2 text-[11px]">
                    <Outward href={AUTHOR_URL}>{t('about.authorLink')}</Outward>
                    <Outward href={AUTHOR_SITE_URL}>lampenbauer.com</Outward>
                    <Outward href={AUTHOR_LINKEDIN_URL}>LinkedIn</Outward>
                  </div>
                </div>
              </section>
              <section className="border-t border-border pt-[22px]">
                <h3 className="mb-[14px] text-[11px] font-semibold tracking-[-0.025em] text-muted-foreground">
                  {t('about.rootsTitle')}
                </h3>
                <div className="grid grid-cols-2 gap-6 max-sm:grid-cols-1 max-sm:gap-[18px]">
                  <div className="relative pl-[15px]">
                    <span className="absolute top-[5px] bottom-[3px] left-0 w-[3px] rounded-[2px] bg-[oklch(0.6283_0.0988_174.84)]" />
                    <Outward href={MINI_TOKYO_URL}>mini-tokyo-3d</Outward>
                    <p className={cn(BODY, 'text-[12px]')}>{t('about.miniTokyo')}</p>
                  </div>
                  <div className="relative pl-[15px]">
                    <span className="absolute top-[5px] bottom-[3px] left-0 w-[3px] rounded-[2px] bg-[oklch(0.6764_0.0813_250.78)]" />
                    <Outward href={LEGIBLE_CITIES_URL}>legible-cities</Outward>
                    <p className={cn(BODY, 'text-[12px]')}>{t('about.legibleCities')}</p>
                  </div>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="details" className={PANEL}>
              <section className="flex items-start gap-[14px]">
                <TrainFront aria-hidden className="mt-[3px] size-[19px] shrink-0 text-[oklch(0.6283_0.0988_174.84)] dark:text-[oklch(0.8075_0.1028_174.78)]" />
                <div><h3 className={HEADING}>{t('about.notTitle')}</h3><p className={BODY}>{t('about.notLive')}</p></div>
              </section>
              <section className="flex items-start gap-[14px]">
                <Ship aria-hidden className="mt-[3px] size-[19px] shrink-0 text-[oklch(0.6283_0.0988_174.84)] dark:text-[oklch(0.8075_0.1028_174.78)]" />
                <div><h3 className={HEADING}>{t('about.shipsTitle')}</h3><p className={BODY}>{t('about.notShips')}</p></div>
              </section>
              <section className="flex items-start gap-[14px]">
                <Route aria-hidden className="mt-[3px] size-[19px] shrink-0 text-[oklch(0.6283_0.0988_174.84)] dark:text-[oklch(0.8075_0.1028_174.78)]" />
                <div>
                  <h3 className={HEADING}>{t('about.exploreTitle')}</h3>
                  <p className={BODY}>{t('about.notRouting')}</p>
                  <p className={BODY}>{t('about.notComplete')}</p>
                </div>
              </section>
              <section className="border-t border-border pt-5 text-[12px]">
                <h3 className={HEADING}>{t('about.builtTitle')}</h3>
                <p className={BODY}>{t('about.built')}</p>
              </section>
            </TabsContent>

            <TabsContent value="keyboard" className={PANEL}>
              <div>
                <h3 className={HEADING}>{t('keys.open')}</h3>
                <p className={BODY}>{t('about.keyboardLead')}</p>
              </div>
              <ul className="grid grid-cols-2 gap-x-[26px] gap-y-0 max-sm:grid-cols-1">
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
                          className="min-w-[23px] rounded-[5px] border border-b-2 border-border bg-muted px-[5px] py-[2px] text-center text-[10px] text-foreground [font-family:inherit]"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
