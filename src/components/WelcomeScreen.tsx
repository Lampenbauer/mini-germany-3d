import { useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ArrowRight, Loader2 } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { NetworkIllustration } from '@/components/NetworkIllustration'
import { MODE_ICON } from '@/components/mode-icon'
import type { CityChoice } from '@/components/ControlPanel'
import { MODE_KEY, sortCitiesByName, t } from '@/lib/i18n'
import { cn } from '@/lib/utils'

/**
 * The front door: the whole screen, in the About dialog's green, with a
 * card per city and nothing of the map showing behind it. Whether it
 * opens at all is lib/welcome.ts's decision; the app builds the map and
 * lets the world load while it is up, and starts the city the reader
 * picks the moment they pick it – with a jump, not a flight (see
 * handleWelcomePick in App.tsx).
 *
 * A Radix dialog rather than a div, for what a div cannot do: the focus
 * goes into it and stays there, the rest of the page is hidden from
 * screen readers while it is up. It has no close button and does not
 * close on Escape or a click beside it – a city is the only way through
 * – and it is portalled to the body, outside the wrapper that hides the
 * interface (see the ui-overlay in App.tsx).
 *
 * The hovers here lighten rather than darken: on the deep green a wash
 * of black sinks in, so the cards take the white wash the About dialog's
 * close button wears on the same ground.
 */

/** The pale ink of the About dialog's hero, for the same green. */
const INK = 'text-[oklch(0.9698_0.0091_161.35)]'
/** The hero's secondary ink: the eyebrow and the mode icons. */
const INK_MUTED = 'text-[oklch(0.8564_0.0404_176.63)]'
/** The hero's paragraph ink: the lead and the footer. */
const INK_SOFT = 'text-[oklch(0.8782_0.0268_172.79)]'

/** A city's card: glass on the green, lifted a touch under the pointer – not once the pick is made. */
const CARD =
  'group relative flex w-full flex-col rounded-xl border border-white/10 bg-white/6 p-4 text-left ' +
  'transition-[background-color,border-color,transform,opacity] duration-150 ' +
  'enabled:hover:-translate-y-0.5 enabled:hover:border-white/22 enabled:hover:bg-white/12 disabled:cursor-default ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-light ' +
  'max-sm:p-3.5'

export interface WelcomeScreenProps {
  open: boolean
  /**
   * The city picked and loading behind the screen, while the screen
   * still stands: its card wears a spinner, every card is disabled.
   * Null while the screen is still asking.
   */
  picked: string | null
  /** Every city this build knows, in definition order – sorted here by name. */
  cities: readonly CityChoice[]
  /** Whether the checkbox starts ticked (the screen forced open over a kept wish). */
  hideNextTime: boolean
  onPick: (slug: string, hideNextTime: boolean) => void
}

export function WelcomeScreen(props: WelcomeScreenProps) {
  const [hideNextTime, setHideNextTime] = useState(props.hideNextTime)
  const cities = sortCitiesByName(props.cities)
  const stay = (event: Event) => event.preventDefault()
  const loading = props.picked !== null

  return (
    <DialogPrimitive.Root open={props.open}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-slot="welcome-screen"
          data-testid="welcome-screen"
          onEscapeKeyDown={stay}
          onPointerDownOutside={stay}
          onInteractOutside={stay}
          // The focus goes to the screen itself, not to the first card:
          // a card wearing the focus ring before anyone touched a key
          // reads as picked. Tab reaches the cards from here.
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement | null)?.focus()
          }}
          className={cn(
            'fixed inset-0 z-50 isolate overflow-y-auto overscroll-contain bg-brand outline-none',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-300',
            INK,
          )}
        >
          {/* The About dialog's network, large in the corner and faded
              to almost nothing towards the middle – behind the text (the
              content isolates, so -z-10 stops there) and faint enough
              under the cards that a name still reads over a line. */}
          <NetworkIllustration
            className={cn(
              'pointer-events-none fixed -top-14 -right-16 -z-10 h-[min(62vh,540px)] w-auto opacity-35',
              '[mask-image:radial-gradient(ellipse_at_top_right,black_40%,transparent_70%)]',
              'max-sm:-right-28 max-sm:h-[44vh] max-sm:opacity-20',
            )}
          />
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center gap-9 px-6 py-12 sm:px-10 max-sm:gap-7 max-sm:py-9">
            <header className="max-w-[640px]">
              <span className={cn('mb-5 flex items-center gap-2 text-xs font-semibold', INK_MUTED, 'max-sm:mb-4 max-sm:text-[9px]')}>
                <span className="size-1.5 rounded-full bg-brand-light" />
                {t('welcome.eyebrow')}
              </span>
              <DialogPrimitive.Title className="text-[44px] leading-[1.08] font-[650] tracking-tighter text-balance max-sm:text-[32px]">
                {t('welcome.title')}
              </DialogPrimitive.Title>
              {/* Two paragraphs, both the dialog's description: the story
                  first, the invitation on a line of its own. */}
              <DialogPrimitive.Description asChild>
                <div className={cn('mt-4 flex max-w-[600px] flex-col gap-3 text-[15px] leading-relaxed text-pretty', INK_SOFT, 'max-sm:mt-3 max-sm:text-sm')}>
                  <p>{t('welcome.lead')}</p>
                  <p className={INK}>{t('welcome.invitation')}</p>
                </div>
              </DialogPrimitive.Description>
            </header>

            <ul
              aria-label={t('welcome.cities')}
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 max-sm:gap-2.5"
            >
              {cities.map(({ city, name }) => {
                const picked = city.slug === props.picked
                return (
                  <li key={city.slug}>
                    <button
                      type="button"
                      aria-label={picked ? t('city.loading', { name }) : t('welcome.open', { name })}
                      aria-busy={picked || undefined}
                      disabled={loading}
                      className={cn(CARD, loading && !picked && 'opacity-60', picked && 'border-white/22 bg-white/12')}
                      onClick={() => props.onPick(city.slug, hideNextTime)}
                    >
                      <span className="text-lg leading-tight font-semibold tracking-tight max-sm:text-base">
                        {name}
                      </span>
                      <span className={cn('mt-4 flex items-center gap-1.5', INK_MUTED, 'max-sm:mt-3')}>
                        {city.modes.map((mode) => {
                          const Icon = MODE_ICON[mode]
                          return <Icon key={mode} className="size-4" aria-hidden />
                        })}
                        {/* What the icons say, for whoever cannot see them */}
                        <span className="sr-only">{city.modes.map((mode) => t(MODE_KEY[mode])).join(', ')}</span>
                        {picked ? (
                          /* The arrow's place, so nothing shifts when it turns */
                          <Loader2 aria-hidden data-testid="welcome-spinner" className="ml-auto size-4 animate-spin" />
                        ) : (
                          <ArrowRight
                            aria-hidden
                            className="ml-auto size-4 opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100"
                          />
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>

            <footer className="border-t border-white/12 pt-6 max-sm:pt-5">
              <label className={cn('flex w-fit items-center gap-3 text-sm font-[550]', loading ? 'opacity-60' : 'cursor-pointer')}>
                <Checkbox
                  checked={hideNextTime}
                  disabled={loading}
                  onCheckedChange={(checked) => setHideNextTime(checked === true)}
                  className={cn(
                    'size-4.5 border-white/40 bg-white/5 shadow-none',
                    'data-[state=checked]:border-brand-light data-[state=checked]:bg-brand-light data-[state=checked]:text-brand',
                    'focus-visible:border-brand-light focus-visible:ring-brand-light/35',
                  )}
                />
                {t('welcome.skip')}
              </label>
            </footer>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
