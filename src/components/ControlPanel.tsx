import { memo, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  Gauge,
  Info,
  Layers,
  Pause,
  Play,
  Ship,
  TimerReset,
  TramFront,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MODE_ICON } from '@/components/mode-icon'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { TransitMode } from '@/data/network-types'
import { MODE_KEY, t } from '@/lib/i18n'
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

/** A city as the picker lists it. */
export interface CityChoice {
  slug: string
  name: string
  /** Transit modes the city's network has – shown as icons in the list. */
  modes: readonly TransitMode[]
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
  /** Set the simulation time to "HH:MM". */
  onSetTime: (hhmm: string) => void
  /** Reset the simulation time to the real clock. */
  onResetTime: () => void
  lines: LineToggleInfo[]
  onToggleLine: (lineId: string) => void
  /** Fly the camera to the line's route (click on the line name). */
  onFocusLine: (lineId: string) => void
  /** Alle Linien einer Gruppe auf einmal ein-/ausblenden. */
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
  showRoutes: boolean
  onToggleRoutes: (visible: boolean) => void
  showStops: boolean
  onToggleStops: (visible: boolean) => void
  /** Vehicle numbers and ship names – one switch for every name on the map. */
  showLabels: boolean
  onToggleLabels: (visible: boolean) => void
  /**
   * Whether the AIS fleet can be shown at all. False leaves its row out
   * entirely – offline, in the tests, and without a configured endpoint
   * there is no live traffic for a switch to reach.
   */
  aisAvailable: boolean
  showAisVessels: boolean
  onToggleAisVessels: (visible: boolean) => void
}

/** Display order of the transit-mode groups. */
const MODE_ORDER: readonly TransitMode[] = TRANSIT_MODES
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
  onToggleLine: (lineId: string) => void
  onFocusLine: (lineId: string) => void
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
}) {
  const Icon = MODE_ICON[props.mode]
  const allVisible = props.lines.every((l) => l.visible)
  return (
    <div className="flex flex-col gap-1.5 mb-2 last:mb-0">
      {props.showHeader && (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
            {t(MODE_KEY[props.mode])}
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
  const [collapsed, setCollapsed] = useState(false)
  const [cityOpen, setCityOpen] = useState(false)
  /**
   * The time field is uncontrolled – the native picker owns its value. "Now"
   * therefore has to clear it explicitly, otherwise the field keeps showing a
   * time the simulation left behind.
   */
  const timeInputRef = useRef<HTMLInputElement>(null)

  // Stable group arrays so the memoized LineGroups skip the clock re-renders
  const lineGroups = useMemo(() => {
    return MODE_ORDER.map((mode) => ({
      mode,
      lines: props.lines.filter((l) => l.mode === mode),
    })).filter((g) => g.lines.length > 0)
  }, [props.lines])

  return (
    // max-h leaves ~2.5rem below the panel so it cannot cover the Cesium
    // attribution line at the bottom edge of the map. The panel itself does
    // not scroll – only the line list inside it does, so the clock, the
    // time-lapse and the layer switches stay put however long the list gets.
    <Card className="pointer-events-auto flex w-80 max-h-[calc(100vh-3.5rem)] flex-col overflow-hidden border-border/60 bg-card/85 backdrop-blur-md">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex min-w-0 items-center gap-1.5 text-base">
          <TramFront className="size-5 shrink-0 text-primary" aria-hidden />
          <span className="truncate" data-testid="app-title">
            {t('city.title', { name: props.city.name })}
          </span>
          {/* The caret beside the title opens the list of cities. Only
              offered when there is somewhere else to go – a single city
              needs no picker, and a caret that opens a list of one would
              promise a choice it cannot give. */}
          {props.cities.length > 1 && (
            <Popover open={cityOpen} onOpenChange={setCityOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0"
                  aria-label={t('city.pick')}
                  disabled={props.cityLoading}
                >
                  <ChevronDown aria-hidden />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-1.5">
                <ul role="listbox" aria-label={t('city.pick')} className="flex flex-col gap-0.5">
                  {props.cities.map((city) => {
                    const current = city.slug === props.city.slug
                    return (
                      <li key={city.slug}>
                        <button
                          type="button"
                          role="option"
                          aria-selected={current}
                          aria-label={current ? city.name : t('city.switchTo', { name: city.name })}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/60',
                            current && 'bg-accent/40',
                          )}
                          onClick={() => {
                            setCityOpen(false)
                            if (!current) props.onSelectCity(city.slug)
                          }}
                        >
                          <span className="min-w-0 flex-1 truncate">{city.name}</span>
                          <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
                            {city.modes.map((mode) => {
                              const Icon = MODE_ICON[mode]
                              return <Icon key={mode} className="size-3.5" aria-hidden />
                            })}
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
          )}
        </CardTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? t('panel.expand') : t('panel.collapse')}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {/* Clock + pause: also visible while the panel is collapsed */}
        <div className="flex items-center justify-between gap-2">
          <div
            className="font-mono text-2xl font-semibold tabular-nums"
            data-testid="sim-clock"
          >
            {props.clockText}
          </div>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={props.paused ? t('sim.resume') : t('sim.pause')}
            onClick={props.onTogglePause}
          >
            {props.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </Button>
        </div>

        {!collapsed && (
          <>
            {/* Set the simulation time (e.g. jump to rush hour). The field is
                picker-only: typing is blocked and a click anywhere on it opens
                the native time dropdown, so no invalid input can be entered. */}
            <div className="flex items-center gap-2">
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <Input
                    ref={timeInputRef}
                    type="time"
                    aria-label={t('sim.setTime')}
                    className="h-8 flex-1 cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                    inputMode="none"
                    onKeyDown={(e) => {
                      // Only block typing where the picker can take over
                      if (
                        'showPicker' in e.currentTarget &&
                        e.key !== 'Tab' &&
                        e.key !== 'Escape' &&
                        e.key !== 'Enter'
                      ) {
                        e.preventDefault()
                      }
                    }}
                    onClick={(e) => {
                      // Not supported by every browser (Safari < 16) – typing
                      // into the field parts still works as the fallback there.
                      try {
                        e.currentTarget.showPicker()
                      } catch {
                        /* picker already open or unsupported */
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.value) props.onSetTime(e.target.value)
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">{t('sim.setTime')}</TooltipContent>
              </Tooltip>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  // Back to the real clock – and back to an empty field, so it
                  // does not keep advertising a time that is no longer set.
                  if (timeInputRef.current) timeInputRef.current.value = ''
                  props.onResetTime()
                }}
              >
                <TimerReset aria-hidden />
                {t('sim.now')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Gauge className="size-4" aria-hidden />
                  {t('sim.timeLapse')}
                </span>
                <span className="font-mono tabular-nums" data-testid="speed-value">
                  ×{props.speed}
                </span>
              </div>
              <Slider
                aria-label={t('sim.timeLapse')}
                min={1}
                max={120}
                step={1}
                value={[props.speed]}
                onValueChange={([v]) => props.onSpeedChange(v)}
              />
            </div>

            <div className="h-px bg-border" role="separator" />

            {/* Layers */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Layers className="size-4" aria-hidden />
                {t('layers.title')}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('layers.routes')}</span>
                <Switch
                  aria-label={t('layers.showRoutes')}
                  checked={props.showRoutes}
                  onCheckedChange={props.onToggleRoutes}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('layers.stops')}</span>
                <Switch
                  aria-label={t('layers.showStops')}
                  checked={props.showStops}
                  onCheckedChange={props.onToggleStops}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('layers.labels')}</span>
                <Switch
                  aria-label={t('layers.showLabels')}
                  checked={props.showLabels}
                  onCheckedChange={props.onToggleLabels}
                />
              </div>
            </div>

            <div className="h-px bg-border" role="separator" />

            {/* Traffic: the lines grouped by transit mode (headers only when
                >1 group), and the AIS fleet after them.
                The only scrolling part of the panel: its heading stays, the
                groups scroll under it, and scroll-fade-y (the same utility
                the vehicle card's stop list uses) signals what is cut off. */}
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <div className="text-sm font-medium">{t('traffic.title')}</div>
              <div
                className="scroll-fade-y flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
                data-testid="line-list"
              >
                {lineGroups.map((g) => (
                  <LineGroup
                    key={g.mode}
                    mode={g.mode}
                    lines={g.lines}
                    showHeader={lineGroups.length > 1}
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
                            className="cursor-help rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none"
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
              </div>
            </div>

          </>
        )}
      </CardContent>
    </Card>
  )
}
