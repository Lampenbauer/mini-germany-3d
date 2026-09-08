/**
 * The scene button in the map controls: what the city is shown under.
 *
 * Two things live behind it. The sky – the live weather over Rostock, or
 * one of three the viewer picks – and the miniature look, which used to
 * sit among the layer switches in the control panel. Neither is a layer:
 * they do not add or remove anything from the map, they change how the
 * same city reads, which is why they are here rather than there.
 *
 * The button wears the icon of the sky in force and the temperature over
 * Rostock beside it, and lights up like the underground button whenever
 * that sky is not the one the session opens on – a hand-set sky is a
 * state worth seeing from outside the popover.
 *
 * The temperature stays the live reading whichever sky is picked: a
 * chosen sky is a way to look at the city, not a claim about the weather,
 * and inventing a temperature to go with it would be one.
 *
 * Below the skies sits the switch for the volumetric clouds (see
 * map/CloudLayer.ts). It is not a sky: the cover the weather reports
 * keeps grading the tiles either way, the switch only decides whether
 * that cover is also drawn as clouds – which is why it is a switch and
 * not a fifth tile, and why it does not light the button up.
 */

import { Cloudy, CloudRain, CloudSun, Sun, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { t, type MessageKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { defaultWeatherMode, type WeatherMode } from '@/lib/weather'

/** The four skies, in the order they are offered. */
const WEATHER_CHOICES: { mode: WeatherMode; icon: LucideIcon; label: MessageKey }[] = [
  { mode: 'live', icon: CloudSun, label: 'weather.live' },
  { mode: 'clear', icon: Sun, label: 'weather.clear' },
  { mode: 'cloudy', icon: Cloudy, label: 'weather.cloudy' },
  { mode: 'rain', icon: CloudRain, label: 'weather.rain' },
]

export interface WeatherPopoverProps {
  weatherMode: WeatherMode
  onWeatherModeChange: (mode: WeatherMode) => void
  /**
   * Whether live weather can be reached at all. Offline, in the tests and
   * with ?rain=0 there is nothing to poll, so its tile is offered greyed
   * out with the reason rather than silently doing nothing.
   */
  liveWeatherAvailable: boolean
  /** Live air temperature in °C, or null while there is none to show. */
  temperatureC: number | null
  /** Whether the volumetric clouds are drawn (see CloudLayer). */
  showClouds: boolean
  onToggleClouds: (visible: boolean) => void
}

export function WeatherPopover(props: WeatherPopoverProps) {
  const active = WEATHER_CHOICES.find((choice) => choice.mode === props.weatherMode)
  const ActiveIcon = active?.icon ?? CloudSun
  // Lit like the underground button: the sky is one the viewer picked,
  // not the one this session opens on.
  const picked = props.weatherMode !== defaultWeatherMode(props.liveWeatherAvailable)
  const temperature =
    props.temperatureC === null ? null : `${Math.round(props.temperatureC)}°`
  const buttonLabel =
    temperature === null
      ? t('weather.title')
      : `${t('weather.title')}, ${t('weather.temperature', { degrees: Math.round(props.temperatureC!) })}`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          // The picked-sky state has to beat the shared bg-card/85, which
          // tailwind-merge would otherwise let win over a variant.
          className={cn(
            'pointer-events-auto h-9 border border-border/60 backdrop-blur-xl',
            // With a reading beside the icon the button grows into a pill
            temperature !== null && 'w-auto gap-1.5 px-2.5',
            picked
              ? 'bg-primary/90 text-primary-foreground hover:bg-primary/80'
              : 'bg-card/85',
          )}
          // No tooltip on this one: the reading stands in the button and a
          // hover card over it would cover the corner it sits in. The name
          // lives here, which is what a screen reader announces.
          aria-label={buttonLabel}
        >
          <ActiveIcon aria-hidden />
          {temperature !== null && (
            <span className="text-xs font-medium tabular-nums">{temperature}</span>
          )}
        </Button>
      </PopoverTrigger>
      {/* align="start" rather than the popover's own default of "end":
          that one hangs the panel's bottom edge on the trigger's, which
          grows it upward – right for a button at the foot of the map,
          wrong for this one at the head of it, where there is nothing
          above to grow into and it ends up flat against the window's top
          edge instead of beside the button. */}
      <PopoverContent side="left" align="start" className="pointer-events-auto">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">{t('weather.title')}</div>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t('weather.title')}>
              {WEATHER_CHOICES.map(({ mode, icon: Icon, label }) => {
                const selected = props.weatherMode === mode
                const disabled = mode === 'live' && !props.liveWeatherAvailable
                return (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t(label)}
                    disabled={disabled}
                    title={disabled ? t('weather.liveUnavailable') : undefined}
                    onClick={() => props.onWeatherModeChange(mode)}
                    className={cn(
                      'flex h-16 flex-col items-center justify-center gap-1 rounded-md border text-xs transition-colors',
                      'focus-visible:ring-ring/50 outline-none focus-visible:ring-2',
                      selected
                        ? 'border-primary bg-primary/15 text-foreground font-medium'
                        : 'border-border/60 bg-background/40 text-muted-foreground hover:bg-background/70',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-background/40',
                    )}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span className="px-1 text-center leading-tight">{t(label)}</span>
                  </button>
                )
              })}
            </div>
            {!props.liveWeatherAvailable && (
              <p className="text-muted-foreground text-xs">{t('weather.liveUnavailable')}</p>
            )}
          </div>
          <div className="bg-border h-px" role="separator" />
          <div className="flex items-center justify-between">
            <span className="text-sm">{t('weather.clouds')}</span>
            <Switch
              aria-label={t('weather.showClouds')}
              checked={props.showClouds}
              onCheckedChange={props.onToggleClouds}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
