import { memo, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { de, enGB } from 'react-day-picker/locale'
import {
  Check,
  Gauge,
  Info,
  Pause,
  Play,
  Plane,
  Rewind,
  Ship,
  TimerReset,
  TramFront,
  type LucideIcon,
} from 'lucide-react'
import { ArrowsFromLineIcon, ArrowsToLineIcon } from '@/components/ArrowsToLineIcon'
import { CaretDownIcon } from '@/components/CaretDownIcon'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MODE_ICON } from '@/components/mode-icon'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScrollArea } from '@/components/ui/scroll-area'
import { narrowViewport } from '@/lib/viewport'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import {
  berlinDateKey,
  formatSpeed,
  SLIDER_MAX,
  SLIDER_MIN,
  SLIDER_ORIGIN,
  sliderFromSpeed,
  speedFromSlider,
} from '@/lib/clock'
import type { TransitMode } from '@/data/network-types'
import type { CityActivity } from '@/lib/city-profile'
import { MODE_KEY, getLanguage, localizeCityName, sortCitiesByName, t, type MessageKey } from '@/lib/i18n'
import { TRANSIT_MODES } from '@/lib/transit-mode'

export interface LineToggleInfo {
  id: string
  name: string
  color: string
  mode: TransitMode
  from: string
  to: string
  visible: boolean
}

/** A city as the picker and the welcome screen list it. */
export interface CityChoice {
  slug: string
  name: string
  /** Transit modes the city's network has – shown as icons in the list. */
  modes: readonly TransitMode[]
  /**
   * Whether ships sail here at all – scheduled ferries or the live AIS
   * fleet. The list's ship icon stands for both: Lübeck runs no ferry
   * line and has a harbour full of AIS traffic, and the icon says so.
   */
  ships: boolean
}

/** One icon in a city's row, with the word it stands for. */
export interface CityChoiceIcon {
  key: string
  Icon: LucideIcon
  labelKey: MessageKey
}

/**
 * The icons a city wears in a list: one per transit mode, and one ship
 * for ships in general, last. The ferry mode's own glyph is that same
 * ship, so it folds into the one icon rather than standing beside it.
 */
export function cityChoiceIcons(city: CityChoice): CityChoiceIcon[] {
  const icons: CityChoiceIcon[] = city.modes
    .filter((mode) => mode !== 'ferry')
    .map((mode) => ({ key: mode, Icon: MODE_ICON[mode], labelKey: MODE_KEY[mode] }))
  if (city.ships) icons.push({ key: 'ships', Icon: MODE_ICON.ferry, labelKey: 'city.ships' })
  return icons
}

export interface ControlPanelProps {
  /** The city on the map – its name is the panel title. */
  city: CityChoice
  /** Every city this build knows, in picker order. */
  cities: readonly CityChoice[]
  /** The city's data is still on its way: the picker waits, the list is empty. */
  cityLoading: boolean
  onSelectCity: (slug: string) => void
  clockText: string
  speed: number
  paused: boolean
  onSpeedChange: (speed: number) => void
  onTogglePause: () => void
  /**
   * The clock as the reader set it, shown in the field and on the date
   * button: the day picked in the calendar ("YYYY-MM-DD") and the time
   * typed ("HH:MM"), null for a half still on the real clock. The app
   * owns both – they ride in the URL hash as entered (lib/camera-hash.ts),
   * and a link that carries them opens the panel showing them.
   */
  pickedDate: string | null
  enteredTime: string | null
  /** Set the simulation time to "HH:MM"; '' withdraws the entry (the clock runs on). */
  onSetTime: (hhmm: string) => void
  /** Set the simulated calendar day, "YYYY-MM-DD" (four days back to a week ahead). */
  onSetDate: (dateKey: string) => void
  /** Reset the simulation time to the real clock, giving up the day and the time entered. */
  onResetTime: () => void
  lines: LineToggleInfo[]
  onToggleLine: (lineId: string) => void
  /** Fly the camera to the line's route (click on the line name). */
  onFocusLine: (lineId: string) => void
  /** Alle Linien einer Gruppe auf einmal ein-/ausblenden. */
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
  /**
   * Whether the AIS fleet can be shown at all. False leaves its row out
   * entirely – offline, in the tests, and without a configured endpoint
   * there is no live traffic for a switch to reach.
   */
  aisAvailable: boolean
  showAisVessels: boolean
  onToggleAisVessels: (visible: boolean) => void
  /**
   * How much of the fleet is out at this instant – the counts in brackets after the
   * group headers and the traffic heading. Null before the first snapshot,
   * when the panel shows no counts rather than zeros.
   */
  activity: CityActivity | null
  /** Ships the AIS backdrop currently holds for this city. */
  aisVesselCount: number
  /**
   * Whether the air traffic can be shown at all – false offline, in the
   * tests and without an endpoint, like the AIS row; unlike it, every
   * city has a sky, so no city leaves the row out.
   */
  aircraftAvailable: boolean
  showAircraft: boolean
  onToggleAircraft: (visible: boolean) => void
  /** Aircraft the ADS-B feed currently reports over this city. */
  aircraftCount: number
  /** The info button in the head: opens the city card (the network in numbers). */
  onShowCityFacts: () => void
}

/**
 * A live count as the panel writes it beside a heading: quiet and
 * tabular, so a change of digit does not shift the switch next to it.
 */
const HEADER_COUNT = 'shrink-0 text-xs tabular-nums text-muted-foreground'

/** The ⓘ behind the AIS and the aircraft hint – a real button, so the keyboard reaches the note too. */
const CLOCK_NOTE_BUTTON =
  'cursor-help rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none'

/** Display order of the transit-mode groups. */
const MODE_ORDER: readonly TransitMode[] = TRANSIT_MODES

/**
 * How far ahead the day picker reaches. A week is as far as a timetable
 * can be trusted to stay what it is. The sky does not follow the clock
 * there: a forecast is not a fact, so a day ahead wears the present's
 * weather, as it carries the present's ships and aircraft.
 */
const DATE_PICKER_DAYS_AHEAD = 7
/**
 * How far back: the four days whose harbour and air traffic the
 * recordings still hold (ARCHIVE_KEEP_HOURS in lib/archive-hours.ts –
 * five days, this one included) and whose weather the feed answers for
 * (WEATHER_PAST_DAYS in lib/weather.ts). The timetable is the same on
 * any day; the ships, the aircraft and the sky are what a day in the
 * past has to show.
 */
const DATE_PICKER_DAYS_BACK = 4

/** A "YYYY-MM-DD" day as the local-time Date the calendar shows it as. */
function localDay(dateKey: string): Date {
  const [y, m, d] = dateKey.split('-').map((part) => parseInt(part, 10))
  return new Date(y, m - 1, d)
}
/**
 * One transit-mode group of the line list (header only when >1 group).
 * Memoized: the panel re-renders 4×/s for the clock, but the line rows only
 * change when a line is toggled (the `lines` array identity comes from the
 * useMemo in App/ControlPanel).
 */
const LineGroup = memo(function LineGroup(props: {
  mode: TransitMode
  lines: LineToggleInfo[]
  showHeader: boolean
  /** Vehicles of this mode out now; null before the first snapshot. */
  running: number | null
  onToggleLine: (lineId: string) => void
  onFocusLine: (lineId: string) => void
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
}) {
  const Icon = MODE_ICON[props.mode]
  const allVisible = props.lines.every((l) => l.visible)
  return (
    <div className="flex flex-col gap-1.5 mb-3 last:mb-0">
      {props.showHeader && (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
            {t(MODE_KEY[props.mode])}
            {/* How many of the mode are out, in brackets right after the
                name – "Tram (23)" – so the number reads as part of the
                title rather than as a control beside the switch. The bare
                number: the Traffic heading above says "out now" once for
                all of them, and four groups repeating it read as noise.
                It swells with the rush hour and empties at night under
                the time-lapse. */}
            {props.running !== null && (
              <span
                className="font-normal tabular-nums"
                title={t('traffic.running', { count: props.running })}
                data-testid={`running-${props.mode}`}
              >
                ({props.running})
              </span>
            )}
          </span>
          <Switch
            aria-label={t('lines.showAll', { mode: t(MODE_KEY[props.mode]) })}
            checked={allVisible}
            onCheckedChange={(checked) =>
              props.onSetLinesVisible(
                props.lines.map((l) => l.id),
                checked,
              )
            }
          />
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {props.lines.map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="-mx-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
              aria-label={t('lines.flyTo', { name: line.name })}
              title={t('lines.flyTo', { name: line.name })}
              onClick={() => props.onFocusLine(line.id)}
            >
              <span
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
                style={{ backgroundColor: line.color }}
                aria-hidden
              >
                {line.id}
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm leading-tight">{line.name}</div>
                <div className="truncate text-xs leading-tight text-muted-foreground">
                  {line.from} ↔ {line.to}
                </div>
              </div>
            </button>
            <Switch
              aria-label={t('lines.show', { name: line.name })}
              checked={line.visible}
              onCheckedChange={() => props.onToggleLine(line.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
})

export function ControlPanel(props: ControlPanelProps) {
  // On a phone the panel is a sheet at the foot of the screen (see
  // App.tsx) and opens folded: unfolded it would cover the map it stands
  // on, and the map is what a visitor came for. Read once, when made.
  const [collapsed, setCollapsed] = useState(narrowViewport)
  const [cityOpen, setCityOpen] = useState(false)
  // Whether the calendar is open: it closes itself on a pick, as shadcn's
  // does. The day picked and the time typed are the app's (pickedDate,
  // enteredTime): they go into the URL, and a link brings them back.
  const [dateOpen, setDateOpen] = useState(false)
  // The picker's range: four days back to a week ahead, as calendar days in
  // the timetable's zone. Re-read on every render – the panel renders once
  // a second for the clock, so midnight moves the range on its own. The
  // calendar speaks local Dates; a Berlin day is handed to it as the local
  // day of the same name, and the day picked goes back by name too, so
  // the key that reaches the clock is the day on the calendar whatever
  // zone the browser is in.
  const today = localDay(berlinDateKey(Date.now()))
  const minDay = localDay(berlinDateKey(Date.now() - DATE_PICKER_DAYS_BACK * 86_400_000))
  const maxDay = localDay(berlinDateKey(Date.now() + DATE_PICKER_DAYS_AHEAD * 86_400_000))
  const calendarLocale = getLanguage() === 'de' ? de : enGB
  // The day the simulation stands on: the one picked, or today until one
  // is – null rather than seeded with today's date, so that midnight moves
  // it on its own, the way the range above moves. The button carries it
  // from the start rather than the word "Date" – a select shows what is
  // selected, and something is, whether or not the viewer put it there.
  const shownDay = props.pickedDate ? localDay(props.pickedDate) : today
  // That day on the button, in the one shape every language gets here:
  // "12. Sep 2026". A named month cannot be read the wrong way round,
  // which an all-numeric date can (08/09 is two different days on either
  // side of the Channel), and it fits beside the caret where a written-out
  // month would not. Only the month's name follows the interface language.
  // The month's own abbreviation, minus the full stop some locales append
  // to it ("Sep." in German): the trailing dot belongs to the day here, and
  // the same shape in every language is the point.
  const shownDayLabel = `${shownDay.getDate()}. ${format(shownDay, 'MMM', {
    locale: calendarLocale,
  }).replace(/\.$/, '')} ${shownDay.getFullYear()}`

  // The cities the picker lists, by name and in the language the interface
  // speaks – the same order the welcome screen shows them in.
  const cityChoices = useMemo(() => sortCitiesByName(props.cities), [props.cities])

  // Stable group arrays so the memoized LineGroups skip the clock re-renders
  const lineGroups = useMemo(() => {
    return MODE_ORDER.map((mode) => ({
      mode,
      lines: props.lines.filter((l) => l.mode === mode),
    })).filter((g) => g.lines.length > 0)
  }, [props.lines])

  // The city on screen, named as the app is – the panel's title, and the
  // face of the picker where there is one to open.
  const cityTitle = (
    <span className="truncate" data-testid="app-title">
      {t('city.title', { name: localizeCityName(props.city.slug, props.city.name) })}
    </span>
  )

  return (
    // max-h leaves ~2.5rem below the panel so it cannot cover the Cesium
    // attribution line at the bottom edge of the map. The panel itself does
    // not scroll – only the line list inside it does, so the clock, the
    // time-lapse and the layer switches stay put however long the list gets.
    <Card
      className={cn(
        // On a phone it is as wide as the sheet's slot and at most a good
        // half of the screen high, so the map keeps the upper half.
        'pointer-events-auto flex w-80 max-h-[calc(100vh-3.5rem)] flex-col overflow-hidden bg-card/85 backdrop-blur-xl shadow-[0_8px_28px_oklch(0_0_0_/_0.35)] max-sm:w-auto max-sm:max-h-[55dvh]',
        // Folded away, the panel is head and clock and nothing else: green
        // all through, edge included, rather than a green head sitting on a
        // stub of card. Unfolded it keeps the card's own quiet border.
        collapsed ? 'border-brand' : 'border-border/60',
      )}
    >
      {/*
          The panel wears the About dialog's head: the same deep green
          (--brand), solid down to where the card's content begins and then
          run out into the card's own colour, so the panel reads as one
          surface rather than as a green box stacked on a grey one. The
          negative margins let the header's background bleed over the
          card's top padding and over the gap below it, which is what makes
          the green and the gradient below meet without a seam; the padding
          added back leaves everything inside exactly where it sat.
      */}
      <CardHeader className="-mt-4 -mb-4 flex flex-row items-center justify-between gap-2 bg-brand pt-4 pb-4">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-base">
          <TramFront className="size-5 shrink-0 text-primary" aria-hidden />
          {/* The title itself opens the list of cities – it names the one
              on screen, which is exactly what a select's face does. Only
              where there is somewhere else to go, though: a single city
              needs no picker, and a caret that opens a list of one would
              promise a choice it cannot give. Then the title is plain
              text, as it was before there was more than one city. */}
          {props.cities.length > 1 ? (
            <Popover open={cityOpen} onOpenChange={setCityOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  // Under the pointer it darkens and nothing more, like
                  // the other three controls of the panel's head – the
                  // title has to read as a title first and as a control
                  // second, or the panel gains a box at its top edge that
                  // competes with the card's. Only the open list draws the
                  // outline, so the trigger stays lit under it.
                  // The negative margin hangs the button's own padding
                  // outside the row, which leaves the title exactly where
                  // it sat when it was a plain span.
                  className="-ml-2.5 min-w-0 shrink gap-1 border border-transparent text-base font-semibold hover:bg-accent data-[state=open]:border-input data-[state=open]:bg-accent"
                  // The name of the button is the city on it, the way a
                  // select is named by its value; what it opens is said
                  // by the popup type and by the list's own label.
                  aria-haspopup="listbox"
                  disabled={props.cityLoading}
                >
                  {cityTitle}
                  <CaretDownIcon className="size-4 shrink-0 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                // Close under the trigger: these two lists open inside the
                // panel, not out over the map like the weather and photo
                // popovers, and the shared 8 px gap read as a list that had
                // come loose from the control it belongs to.
                sideOffset={2}
                className="w-56 p-1.5 ring-1 ring-border/80 shadow-xl/60"
              >
                <ul role="listbox" aria-label={t('city.pick')} className="flex flex-col gap-0.5">
                  {cityChoices.map(({ city, name }) => {
                    const current = city.slug === props.city.slug
                    return (
                      <li key={city.slug}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={current}
                          aria-label={current ? name : t('city.switchTo', { name })}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60',
                            current && 'bg-accent/40',
                          )}
                          onClick={() => {
                            setCityOpen(false)
                            if (!current) props.onSelectCity(city.slug)
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{name}</span>
                          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                            {cityChoiceIcons(city).map(({ key, Icon }) => (
                              <Icon key={key} className="size-3.5" aria-hidden />
                            ))}
                          </span>
                          {current ? (
                            <Check className="size-4 shrink-0 text-primary" aria-hidden />
                          ) : (
                            <span className="size-4 shrink-0" aria-hidden />
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </PopoverContent>
            </Popover>
          ) : (
            cityTitle
          )}
        </CardTitle>
        <div className="flex shrink-0 items-center">
          {/* The city in numbers – a card, because the panel's head has
              no room for eight facts and the panel body is the simulation,
              not the network's statistics. Dimmed like the fold button
              beside it, for the same reason: it is a door, not a control
              the card is for. Disabled while the city's data is still on
              its way, when there is nothing to count yet. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={t('city.facts', {
                  name: localizeCityName(props.city.slug, props.city.name),
                })}
                disabled={props.cityLoading}
                onClick={props.onShowCityFacts}
              >
                <Info />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('city.facts', {
                name: localizeCityName(props.city.slug, props.city.name),
              })}
            </TooltipContent>
          </Tooltip>
          {/* The tooltip teaches the bigger version of this button: H takes
            the whole interface away, panel included, and nothing else in
            the app says so. It is the description, not the name – the
            button is still announced by what it does (see aria-label). */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                // Dimmed to the weight of the panel's secondary text: folding
                // the panel away is housekeeping, not one of the controls the
                // card is for, and at full strength it pulled against the
                // title beside it. It comes up to full weight under the
                // pointer, so it still answers like a button.
                className="text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={collapsed ? t('panel.expand') : t('panel.collapse')}
                onClick={() => setCollapsed((c) => !c)}
              >
                {collapsed ? <ArrowsFromLineIcon /> : <ArrowsToLineIcon />}
              </Button>
            </TooltipTrigger>
            {/* Out over the map: below is the clock, left is the title */}
            <TooltipContent side="right">{t('panel.hideAll')}</TooltipContent>
          </Tooltip>
        </div>
      </CardHeader>

      <CardContent
        className={cn(
          'relative isolate flex min-h-0 flex-1 flex-col gap-4 overflow-hidden',
          // Collapsed, the green has to reach the bottom edge as well: the
          // card keeps 16 px of padding under its last child, and the same
          // bleed the header uses at the top carries the fill over it.
          collapsed && '-mb-4 pb-4',
        )}
      >
        {/* Where the green gives out. Behind the content (-z-10 inside the
            content's own stacking context), so the clock and the controls
            sit on it rather than under it. Collapsed there is nothing left
            for it to give out into, so it fills instead of fading. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-x-0 -z-10',
            collapsed ? 'inset-y-0 bg-brand' : 'top-0 h-40 bg-linear-to-b from-brand to-transparent',
          )}
        />
        {/* Clock + pause: also visible while the panel is collapsed */}
        <div className="flex items-center justify-between gap-2">
          <div
            className="font-mono text-2xl font-semibold tabular-nums"
            data-testid="sim-clock"
          >
            {props.clockText}
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="hover:bg-accent"
            aria-label={props.paused ? t('sim.resume') : t('sim.pause')}
            onClick={props.onTogglePause}
          >
            {props.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </Button>
        </div>

        {!collapsed && (
          <>
            {/* Set the simulated day and time (e.g. jump to rush hour, or to
                tomorrow's sunset) – shadcn's date picker with a time field:
                the day from a calendar in a popover, bounded to the week
                ahead, the time typed into a plain time field. The sun follows
                the day; the timetable is built for one service day and does
                not (see SimClock.setDate). */}
            {/* Closer to the clock than the gap the card sets between its
                sections: these three set the clock above them, so they
                read as one block with it rather than as the next section
                down. */}
            <div className="-mt-2 flex items-center gap-2">
              {/*
                Day and time read as one field: the two halves set one
                moment, and side by side as separate boxes they read as two
                unrelated controls. One input-shaped frame around both, a
                hairline between the halves, and the frame lights up
                whichever half is focused – the shape a date-time field has
                everywhere else.
              */}
              <div className="flex h-8 min-w-0 flex-1 items-center rounded-md border border-input bg-accent shadow-xs transition-colors focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/50">
                <Popover open={dateOpen} onOpenChange={setDateOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('sim.setDate')}
                      className="h-full min-w-0 flex-1 justify-between gap-1 rounded-r-none px-2 font-normal hover:bg-transparent focus-visible:ring-0"
                    >
                      <span className="truncate">{shownDayLabel}</span>
                      <CaretDownIcon className="size-4 shrink-0 opacity-60" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent
                    className="w-auto overflow-hidden p-0"
                    align="start"
                    sideOffset={2}
                  >
                    <Calendar
                      mode="single"
                      locale={calendarLocale}
                      selected={shownDay}
                      defaultMonth={shownDay}
                      startMonth={minDay}
                      endMonth={maxDay}
                      disabled={{ before: minDay, after: maxDay }}
                      onSelect={(day) => {
                        if (!day) return
                        props.onSetDate(format(day, 'yyyy-MM-dd'))
                        setDateOpen(false)
                      }}
                    />
                  </PopoverContent>
                </Popover>
                <span className="h-4 w-px shrink-0 bg-border" aria-hidden />
                {/* Controlled by the entry: the native picker yields a whole
                    time or nothing, and nothing withdraws the entry while
                    the clock runs on – so the field never shows a time the
                    URL does not carry, and "Now" empties it through the app. */}
                <Input
                  type="time"
                  aria-label={t('sim.setTime')}
                  className="h-full w-17 shrink-0 appearance-none rounded-l-none border-0 bg-transparent px-2 text-center shadow-none focus-visible:ring-0 [&::-webkit-calendar-picker-indicator]:hidden [&::-webkit-calendar-picker-indicator]:appearance-none"
                  value={props.enteredTime ?? ''}
                  onChange={(e) => props.onSetTime(e.target.value)}
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                // Back to the real clock – the app gives up the time and the
                // day with it, which empties the field and puts today back
                // on the date button.
                onClick={props.onResetTime}
              >
                <TimerReset aria-hidden />
                {t('sim.now')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              {/* The row says the direction: "Rewind" with its own icon
                  while the clock runs backward, the number reads ×10 either
                  way – a sign before it (×−10) was tried and found ugly */}
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5" data-testid="speed-label">
                  {props.speed < 0 ? (
                    <Rewind className="size-4" aria-hidden />
                  ) : (
                    <Gauge className="size-4" aria-hidden />
                  )}
                  {t(props.speed < 0 ? 'sim.rewind' : 'sim.timeLapse')}
                </span>
                <span className="font-mono tabular-nums" data-testid="speed-value">
                  {formatSpeed(props.speed)}
                </span>
              </div>
              {/* Both ways: real pace in the middle, faster to the right,
                  backward to the left, resting on the keyboard's steps (the
                  scale is the clock's, sliderFromSpeed) – the fill runs
                  from the middle */}
              <Slider
                aria-label={t('sim.timeLapse')}
                aria-valuetext={
                  props.speed < 0
                    ? t('sim.speedBackward', { speed: formatSpeed(props.speed) })
                    : formatSpeed(props.speed)
                }
                min={SLIDER_MIN}
                max={SLIDER_MAX}
                step={1}
                origin={SLIDER_ORIGIN}
                value={[sliderFromSpeed(props.speed)]}
                onValueChange={([v]) => props.onSpeedChange(speedFromSlider(v))}
              />
            </div>

            <div className="h-px bg-border" role="separator" />

            {/* Traffic: the lines grouped by transit mode (headers only when
                >1 group), and the AIS fleet after them.
                The only scrolling part of the panel: its heading stays, the
                groups scroll under it, and scroll-fade-y (the same utility
                the vehicle card's stop list uses) signals what is cut off. */}
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-medium">{t('traffic.title')}</div>
                {/* The whole fleet – the one count a city with a single
                    mode gets, since its group draws no header. */}
                {props.activity && (
                  <span className={HEADER_COUNT} data-testid="running-total">
                    {t('traffic.running', { count: props.activity.total })}
                  </span>
                )}
              </div>
              <ScrollArea
                className="min-h-0 flex-1"
                viewportClassName="scroll-fade-y"
                data-testid="line-list"
              >
                <div className="flex flex-col gap-2">
                  {lineGroups.map((g) => (
                    <LineGroup
                      key={g.mode}
                      mode={g.mode}
                      lines={g.lines}
                      showHeader={lineGroups.length > 1}
                      running={props.activity ? (props.activity.byMode[g.mode] ?? 0) : null}
                      onToggleLine={props.onToggleLine}
                      onFocusLine={props.onFocusLine}
                      onSetLinesVisible={props.onSetLinesVisible}
                    />
                  ))}
                  {/* The AIS fleet closes the list, after the ferries it
                      shares the water with. Styled as a group header rather
                      than a line row because that is what it is – a whole
                      category behind one switch – and it carries a subtitle
                      the mode groups do not need: "AIS" says nothing to
                      anyone who has not met the acronym. */}
                  {props.aisAvailable && (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          <Ship className="size-3.5" aria-hidden />
                          {t('traffic.ais')}
                          {/* In brackets after the name like the mode counts
                              above, and only while the switch is on: off, the
                              count would promise ships the map is not drawing. */}
                          {props.showAisVessels && props.aisVesselCount > 0 && (
                            <span
                              className="font-normal tabular-nums"
                              title={t('traffic.aisCount', { count: props.aisVesselCount })}
                              data-testid="ais-count"
                            >
                              ({props.aisVesselCount})
                            </span>
                          )}
                        </span>
                        <Switch
                          aria-label={t('traffic.showAis')}
                          checked={props.showAisVessels}
                          onCheckedChange={props.onToggleAisVessels}
                        />
                      </div>
                      {/* pl-5 lines the hint up with the label above it, past
                          the icon (size-3.5) and its gap-1.5. The note behind
                          the ⓘ is the one thing about this layer that surprises
                          people: every other moving thing on the map obeys the
                          panel's clock, and the ships do not. A real button, so
                          the keyboard reaches the note too – Radix opens the
                          tooltip on focus as well as on hover. */}
                      <div className="flex items-center gap-1 pl-5 text-xs leading-tight text-muted-foreground">
                        {t('traffic.aisHint')}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={CLOCK_NOTE_BUTTON}
                              aria-label={t('traffic.aisClockLabel')}
                            >
                              <Info className="size-3.5" aria-hidden />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-56">
                            {t('traffic.aisClockNote')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )}
                  {/* The air traffic last of all, above the ships it flies
                      over: the same kind of row – a whole category behind
                      one switch, a count while it is on, and a note about
                      the clock, which does even less to the aircraft than
                      to the ships (there is no recording of them). */}
                  {props.aircraftAvailable && (
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          <Plane className="size-3.5" aria-hidden />
                          {t('traffic.aircraft')}
                          {props.showAircraft && props.aircraftCount > 0 && (
                            <span
                              className="font-normal tabular-nums"
                              title={t('traffic.aircraftCount', { count: props.aircraftCount })}
                              data-testid="aircraft-count"
                            >
                              ({props.aircraftCount})
                            </span>
                          )}
                        </span>
                        <Switch
                          aria-label={t('traffic.showAircraft')}
                          checked={props.showAircraft}
                          onCheckedChange={props.onToggleAircraft}
                        />
                      </div>
                      <div className="flex items-center gap-1 pl-5 text-xs leading-tight text-muted-foreground">
                        {t('traffic.aircraftHint')}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className={CLOCK_NOTE_BUTTON}
                              aria-label={t('traffic.aircraftClockLabel')}
                            >
                              <Info className="size-3.5" aria-hidden />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-56">
                            {t('traffic.aircraftClockNote')}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
