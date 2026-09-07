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
import { t, type MessageKey } from '@/lib/i18n'
import './about-dialog.css'

const MINI_TOKYO_URL = 'https://minitokyo3d.com'
const LEGIBLE_CITIES_URL = 'https://github.com/richc117/legible-cities'
const AUTHOR_URL = 'https://www.lampenbauer.com/mario-fotograf/'
const AUTHOR_SITE_URL = 'https://www.lampenbauer.com/'
const AUTHOR_LINKEDIN_URL = 'https://www.linkedin.com/in/mario-m%C3%BCller-1ba877266/'

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
    <a href={props.href} target="_blank" rel="noopener noreferrer" className="about-link">
      {props.children}<ArrowUpRight aria-hidden className="size-3.5" />
    </a>
  )
}

/** A small, deliberately imaginary network, echoing the map's three readings. */
function NetworkIllustration() {
  return (
    <svg className="about-network" viewBox="0 0 280 220" fill="none" aria-hidden="true">
      <g stroke="currentColor" strokeWidth="1" opacity=".12">
        <path d="M0 45H280M0 85H280M0 125H280M0 165H280M0 205H280M40 0V220M80 0V220M120 0V220M160 0V220M200 0V220M240 0V220" />
      </g>
      <g strokeWidth="9" strokeLinecap="round" strokeLinejoin="round">
        <path d="M-15 172H70Q88 172 101 159L183 77Q196 64 214 64H300" stroke="#5ee0c0" />
        <path d="M62 -15V55Q62 72 75 85L154 164Q167 177 186 177H296" stroke="#ecba73" />
        <path d="M-10 103H94Q111 103 124 116L183 175Q196 188 196 207V235" stroke="#7caee8" />
      </g>
      <g fill="#143b36" stroke="#dff5ed" strokeWidth="3">
        <circle cx="30" cy="172" r="5" /><circle cx="214" cy="64" r="5" />
        <circle cx="62" cy="32" r="5" /><circle cx="235" cy="177" r="5" />
        <circle cx="37" cy="103" r="5" /><circle cx="196" cy="214" r="5" />
        <circle cx="119" cy="128" r="9" /><circle cx="165" cy="158" r="7" />
      </g>
      <g transform="translate(153 87) rotate(-45)">
        <rect x="-17" y="-8" width="34" height="16" rx="6" fill="#f3faf6" stroke="#143b36" strokeWidth="2" />
        <path d="M-7 -4V4M0 -4V4M7 -4V4" stroke="#143b36" strokeWidth="3" />
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
        className="about-dialog gap-0 overflow-hidden p-0 sm:max-w-[680px]"
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
        <DialogHeader className="about-hero">
          <NetworkIllustration />
          <span className="about-eyebrow"><span />{t('about.eyebrow')}</span>
          <DialogTitle className="about-title">{t('about.title')}</DialogTitle>
          <DialogDescription className="about-lead">{t('about.lead')}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="story" className="about-tabs">
          <TabsList aria-label={t('about.open')} className="about-tab-list">
            <TabsTrigger value="story">{t('about.storyTab')}</TabsTrigger>
            <TabsTrigger value="details">{t('about.detailsTab')}</TabsTrigger>
            <TabsTrigger value="keyboard"><Keyboard aria-hidden className="size-3.5" />{t('keys.title')}</TabsTrigger>
          </TabsList>
          <div className="about-scroll">
            <TabsContent value="story" className="about-panel">
              <section className="about-intro">
                <div className="about-monogram" aria-hidden="true">m.</div>
                <div>
                  <h3>{t('about.whoTitle')}</h3>
                  <p>{t('about.who')}</p>
                  <p className="about-invitation">{t('about.invitation')}</p>
                  <div className="about-author-links">
                    <Outward href={AUTHOR_URL}>{t('about.authorLink')}</Outward>
                    <Outward href={AUTHOR_SITE_URL}>lampenbauer.com</Outward>
                    <Outward href={AUTHOR_LINKEDIN_URL}>LinkedIn</Outward>
                  </div>
                </div>
              </section>
              <section className="about-roots">
                <h3>{t('about.rootsTitle')}</h3>
                <div className="about-inspirations">
                  <div><span className="about-line-mark" /><Outward href={MINI_TOKYO_URL}>mini-tokyo-3d</Outward><p>{t('about.miniTokyo')}</p></div>
                  <div><span className="about-line-mark about-line-mark-blue" /><Outward href={LEGIBLE_CITIES_URL}>legible-cities</Outward><p>{t('about.legibleCities')}</p></div>
                </div>
              </section>
            </TabsContent>

            <TabsContent value="details" className="about-panel">
              <section className="about-fact"><TrainFront aria-hidden /><div><h3>{t('about.notTitle')}</h3><p>{t('about.notLive')}</p></div></section>
              <section className="about-fact"><Ship aria-hidden /><div><h3>{t('about.shipsTitle')}</h3><p>{t('about.notShips')}</p></div></section>
              <section className="about-fact"><Route aria-hidden /><div><h3>{t('about.exploreTitle')}</h3><p>{t('about.notRouting')}</p><p>{t('about.notComplete')}</p></div></section>
              <section className="about-sources"><h3>{t('about.builtTitle')}</h3><p>{t('about.built')}</p></section>
            </TabsContent>

            <TabsContent value="keyboard" className="about-panel">
              <div><h3>{t('keys.open')}</h3><p>{t('about.keyboardLead')}</p></div>
              <ul className="about-shortcuts">
                {SHORTCUTS.map(({ keys, labelKey }) => (
                  <li key={labelKey}>
                    <span>{t(labelKey)}</span>
                    <span className="about-key-group">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
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
