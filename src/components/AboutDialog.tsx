import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { t, type MessageKey } from '@/lib/i18n'

/**
 * What this map is, where it comes from, and – the part that saves the
 * most misunderstandings – what it is not. A city moving to a timetable
 * looks like live tracking, and it is worth saying plainly, once, in the
 * only place where prose belongs in this interface, that it is not.
 *
 * A real dialog rather than a card in a fixed div: the focus goes into it
 * when it opens, stays there while it is up and returns afterwards, and a
 * screen reader is handed the text instead of the map behind it. The
 * headings are set in the serif (font-display) that appears nowhere else
 * – this is the one place in the app that is read rather than used.
 *
 * The keyboard closes the dialog: the shortcuts sit at the end, after the
 * prose, because they are what a reader comes back for once the story has
 * been read the first time.
 */

/** Where the map's two ancestors live. */
const MINI_TOKYO_URL = 'https://minitokyo3d.com'
const LEGIBLE_CITIES_URL = 'https://github.com/richc117/legible-cities'

/** And where the person who built it does. */
const AUTHOR_URL = 'https://www.lampenbauer.com/mario-fotograf/'
const AUTHOR_SITE_URL = 'https://www.lampenbauer.com/'
const AUTHOR_LINKEDIN_URL = 'https://www.linkedin.com/in/mario-m%C3%BCller-1ba877266/'

/**
 * The keys are printed as they sit on the cap, not as the event names
 * them: "Space", "Esc", "+ −". Each row says what the key does rather
 * than which button it stands in for – somebody reading this is looking
 * for a verb.
 */
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

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="font-display text-[0.95rem] font-semibold tracking-tight text-foreground">
        {props.title}
      </h3>
      {props.children}
    </section>
  )
}

/** An outward link, marked as one and safe to open. */
function Outward(props: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
    >
      {props.children}
    </a>
  )
}

export function AboutDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {/* Wider than a dialog that only asks something, and capped in
          height: on a laptop in landscape the prose and the twelve keys
          are taller than the window, so the body scrolls and the title
          stays. */}
      <DialogContent
        closeLabel={t('keys.close')}
        className="max-h-[85vh] gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="font-display text-2xl font-semibold tracking-tight">
            {t('about.title')}
          </DialogTitle>
          <DialogDescription className="text-pretty">{t('about.lead')}</DialogDescription>
        </DialogHeader>

        {/* scroll-fade-y: the text runs past the bottom edge on a laptop,
            and a hard cut there reads as the end of it. */}
        <div className="scroll-fade-y flex flex-col gap-5 overflow-y-auto px-5 pb-5 text-sm leading-relaxed text-muted-foreground">
          <Section title={t('about.rootsTitle')}>
            <p className="text-pretty">
              <Outward href={MINI_TOKYO_URL}>mini-tokyo-3d</Outward> {t('about.miniTokyo')}
            </p>
            <p className="text-pretty">
              <Outward href={LEGIBLE_CITIES_URL}>legible-cities</Outward> {t('about.legibleCities')}
            </p>
          </Section>

          <Section title={t('about.notTitle')}>
            {/* The one that matters: a city running to its timetable looks
                live, and only saying so stops it being read as a claim. */}
            <p className="text-pretty">{t('about.notLive')}</p>
            <p className="text-pretty">{t('about.notShips')}</p>
            <p className="text-pretty">{t('about.notRouting')}</p>
            <p className="text-pretty">{t('about.notComplete')}</p>
          </Section>

          <Section title={t('about.builtTitle')}>
            <p className="text-pretty">{t('about.built')}</p>
          </Section>

          <Section title={t('about.whoTitle')}>
            <p className="text-pretty">
              <Outward href={AUTHOR_URL}>Mario</Outward> {t('about.who')}
            </p>
            <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <Outward href={AUTHOR_SITE_URL}>lampenbauer.com</Outward>
              <Outward href={AUTHOR_LINKEDIN_URL}>LinkedIn</Outward>
            </p>
          </Section>

          <Section title={t('keys.title')}>
            {/* Two columns where the dialog is wide enough for them – a
                dozen keys in one column would push the prose off screen. */}
            <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {SHORTCUTS.map(({ keys, labelKey }) => (
                <li key={labelKey} className="flex items-baseline justify-between gap-3">
                  <span className="flex shrink-0 items-center gap-1">
                    {keys.map((key) => (
                      <kbd
                        key={key}
                        className="min-w-6 rounded border border-border bg-muted px-1.5 py-0.5 text-center font-mono text-xs text-foreground"
                      >
                        {key}
                      </kbd>
                    ))}
                  </span>
                  <span className="min-w-0 text-right text-xs">{t(labelKey)}</span>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
