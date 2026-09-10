import { Crosshair } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CardHead, LineChip, SectionLabel } from '@/components/card-parts'
import { MODE_ICON } from '@/components/mode-icon'
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

/**
 * The stop clicked on the map: its lines, the next hour's departures and
 * the lines a short walk away. A stop is the network's furniture, not a
 * line's, so the head is the network's green like the city card's, with
 * the serving lines' chips on it in their own colours.
 */
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
      className="pointer-events-auto w-100 gap-0 overflow-hidden border-border/60 bg-card/85 py-0 backdrop-blur-xl"
      data-testid="stop-card"
    >
      <CardHead
        eyebrow={
          <>
            {t('stop.eyebrow')}
            {stop.inTunnel && (
              <span className="font-normal">
                {' · '}
                <span>{t('stop.underground')}</span>
              </span>
            )}
          </>
        }
        title={<span className="text-pretty">{stop.name}</span>}
        titleClassName="text-xl"
        closeLabel={t('stop.close')}
        onClose={onClose}
      >
        <span className="mt-3 flex flex-wrap gap-1" data-testid="stop-lines">
          {stop.lines.map((line) => (
            <LineChip key={line.id} id={line.id} color={line.color} />
          ))}
        </span>
      </CardHead>

      <CardContent className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="flex flex-col gap-1">
          <SectionLabel>{t('stop.departures')}</SectionLabel>
          {departures.length === 0 ? (
            <span className="text-sm text-muted-foreground" data-testid="stop-no-departures">
              {t('stop.noDepartures')}
            </span>
          ) : (
            <ol className="flex flex-col" data-testid="stop-departures">
              {departures.map((dep) => {
                const VehicleIcon = MODE_ICON[dep.mode]
                const row = (
                  <>
                    {/* Whether the vehicle is out there is the difference
                        between a clickable row and a plain one – this
                        column says so without hovering. The slot stays in
                        the layout when empty so the rows stay aligned. */}
                    <span className="flex w-3.5 shrink-0 justify-center text-muted-foreground">
                      {dep.active && (
                        <VehicleIcon
                          className="size-3.5"
                          data-testid="departure-on-map"
                          aria-hidden
                        />
                      )}
                    </span>
                    <span className="w-11 shrink-0 font-mono text-xs tabular-nums">
                      {formatArrival(dep.departureSec)}
                    </span>
                    <LineChip id={dep.lineId} color={dep.color} />
                    <span className="min-w-0 flex-1 truncate text-left text-sm">
                      {dep.destination}
                    </span>
                    {dep.realtime && (
                      <Badge variant="secondary" className="shrink-0 text-2xs">
                        {formatDelay(dep.delaySeconds)}
                      </Badge>
                    )}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
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
                        className="-mx-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent"
                        title={t('stop.flyToVehicle')}
                        onClick={() => onSelectVehicle(dep.tripId)}
                      >
                        {row}
                      </button>
                    ) : (
                      <div className="-mx-1 flex w-full items-center gap-2 px-1 py-1">{row}</div>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>

        {nearby.length > 0 && (
          <div className="flex flex-col gap-1">
            <SectionLabel>{t('stop.nearby')}</SectionLabel>
            <div className="flex flex-wrap gap-1" data-testid="stop-nearby">
              {nearby.map((line) => (
                <LineChip key={line.id} id={line.id} color={line.color} />
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
