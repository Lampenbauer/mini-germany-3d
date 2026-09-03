/**
 * The scene button in the map controls: what the city is shown under.
 *
 * Two things live behind it. The sky – the live weather over Rostock, or
 * one of three the viewer picks – and the miniature look, which used to
 * sit among the layer switches in the control panel. Neither is a layer:
 * they do not add or remove anything from the map, they change how the
 * same city reads, which is why they are here rather than there.
 *
 * The button wears the icon of the sky in force, and lights up like the
 * underground button whenever that sky is not the one the session opens
 * on – a hand-set sky is a state worth seeing from outside the popover.
 */

import { Cloudy, CloudRain, CloudSun, Sun, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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

export interface ScenePopoverProps {
  weatherMode: WeatherMode
  onWeatherModeChange: (mode: WeatherMode) => void
  /**
   * Whether live weather can be reached at all. Offline, in the tests and
   * with ?rain=0 there is nothing to poll, so its tile is offered greyed
   * out with the reason rather than silently doing nothing.
   */
  liveWeatherAvailable: boolean
  tiltShift: boolean
  onToggleTiltShift: (enabled: boolean) => void
}

export function ScenePopover(props: ScenePopoverProps) {
  const active = WEATHER_CHOICES.find((choice) => choice.mode === props.weatherMode)
  const ActiveIcon = active?.icon ?? CloudSun
  // Lit like the underground button: the sky is one the viewer picked,
  // not the one this session opens on.
  const picked = props.weatherMode !== defaultWeatherMode(props.liveWeatherAvailable)

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              // The picked-sky state has to beat the shared bg-card/85,
              // which tailwind-merge would otherwise let win over a variant.
              className={cn(
                'pointer-events-auto border border-border/60 backdrop-blur-md',
                picked
                  ? 'bg-primary/90 text-primary-foreground hover:bg-primary/80'
                  : 'bg-card/85',
              )}
              aria-label={t('scene.title')}
            >
              <ActiveIcon aria-hidden />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="left">{t('scene.title')}</TooltipContent>
      </Tooltip>
      <PopoverContent side="left" className="pointer-events-auto">
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

          <div className="h-px bg-border" role="separator" />

          <div className="flex items-center justify-between gap-2">
            <span className="text-sm">{t('scene.tiltShift')}</span>
            <Switch
              aria-label={t('scene.showTiltShift')}
              checked={props.tiltShift}
              onCheckedChange={props.onToggleTiltShift}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
