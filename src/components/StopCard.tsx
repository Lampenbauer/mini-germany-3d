import { Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { StopDeparture } from '@/engine/simulation'
import type { InterchangeOption } from '@/lib/interchange'
import { t } from '@/lib/i18n'
import { formatArrival, formatDelay, minutesUntil } from './VehicleCard'

/** What the card shows about the stop itself (looked up in App). */
export interface StopInfo {
  id: string
  name: string
  lon: number
  lat: number
  nhn?: number
  /** Lines calling at this stop, in network order. */
  lines: { id: string; color: string }[]
  /** Served underground by at least one line. */
  inTunnel: boolean
}

export interface StopCardProps {
  stop: StopInfo
  /** Upcoming departures, soonest first (see Simulation.upcomingDepartures). */
  departures: StopDeparture[]
  /** Simulation clock in seconds of day – basis for the countdowns. */
  simSeconds: number
  /** Lines reachable within walking distance (the stop's own included). */
  interchange: InterchangeOption[]
  /** Click on a departure whose vehicle is on the map. */
  onSelectVehicle: (tripId: string) => void
  /** Camera flight to the stop. */
  onFlyTo: (stop: StopInfo) => void
  onClose: () => void
}

/** "in 3 min", "now" under a minute. */
function countdown(departureSec: number, nowSec: number): string {
  const minutes = minutesUntil(departureSec, nowSec)
  return minutes <= 0 ? t('stop.now') : t('vehicle.inMinutes', { count: minutes })
}

export function StopCard({
  stop,
  departures,
  simSeconds,
  interchange,
  onSelectVehicle,
  onFlyTo,
  onClose,
}: StopCardProps) {
  // Reachable a short walk away but not calling here – the same
  // walking-distance relation the vehicle card's interchange row uses.
  const nearby = interchange.filter(
    (option) => !stop.lines.some((line) => line.id === option.id),
  )

  return (
    <Card
      className="pointer-events-auto w-100 border-border/60 bg-card/85 backdrop-blur-md"
      data-testid="stop-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <span className="truncate">{stop.name}</span>
          {stop.inTunnel && (
            <Badge variant="secondary" className="shrink-0">
              {t('stop.underground')}
            </Badge>
          )}
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('stop.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1" data-testid="stop-lines">
          {stop.lines.map((line) => (
            <span
              key={line.id}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-xs font-semibold text-white"
              style={{ backgroundColor: line.color }}
            >
              {line.id}
            </span>
          ))}
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">{t('stop.departures')}</span>
          {departures.length === 0 ? (
            <span className="text-sm" data-testid="stop-no-departures">
              {t('stop.noDepartures')}
            </span>
          ) : (
            <ol className="flex flex-col" data-testid="stop-departures">
              {departures.map((dep) => {
                const row = (
                  <>
                    <span className="w-11 shrink-0 font-mono text-xs tabular-nums">
                      {formatArrival(dep.departureSec)}
                    </span>
                    <span
                      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded px-1.5 text-xs font-semibold text-white"
                      style={{ backgroundColor: dep.color }}
                    >
                      {dep.lineId}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-left text-sm">
                      {dep.destination}
                    </span>
                    {dep.realtime && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {formatDelay(dep.delaySeconds)}
                      </Badge>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {countdown(dep.departureSec, simSeconds)}
                    </span>
                  </>
                )
                // A departure whose vehicle is already on the map is a
                // link to it; one still waiting at the depot is plain text.
                return (
                  <li key={`${dep.tripId}:${dep.departureSec}`}>
                    {dep.active ? (
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-accent"
                        title={t('stop.flyToVehicle')}
                        onClick={() => onSelectVehicle(dep.tripId)}
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="flex w-full items-center gap-2 px-1 py-0.5">{row}</div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        {nearby.length > 0 && (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">{t('stop.nearby')}</span>
            <div className="flex flex-wrap gap-1" data-testid="stop-nearby">
              {nearby.map((line) => (
                <span
                  key={line.id}
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-xs font-semibold text-white"
                  style={{ backgroundColor: line.color }}
                >
                  {line.id}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onFlyTo(stop)}>
            <Crosshair aria-hidden />
            {t('stop.flyTo')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
