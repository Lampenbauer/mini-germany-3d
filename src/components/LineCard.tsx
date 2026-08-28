import { ArrowLeftRight, ArrowRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MODE_ICON } from '@/components/mode-icon'
import { formatDelay } from '@/components/VehicleCard'
import { MODE_KEY, t } from '@/lib/i18n'
import {
  formatLength,
  formatServiceTime,
  formatStopCount,
  type LineActivity,
  type LineProfile,
} from '@/lib/line-profile'

/**
 * What a line is, for the line clicked in the control panel: the shape of
 * its route and the shape of its service day. Everything shown is stated
 * by the data (see line-profile.ts) – nothing here is simulated, which is
 * why there is no travel time and no average speed.
 */
export interface LineCardProps {
  profile: LineProfile
  /**
   * What the line is doing at this instant, refreshed on the app's UI
   * tick. Null while the simulation has not produced a snapshot yet.
   */
  activity: LineActivity | null
  /** Line name and color from the network – the card's identity. */
  name: string
  color: string
  /** Camera flight to the route, as clicking the name in the panel does. */
  onFlyTo: () => void
  /** Click on one of the line's vehicles – the map selects and follows it. */
  onSelectVehicle: (tripId: string) => void
  onClose: () => void
}

export function LineCard({
  profile,
  activity,
  name,
  color,
  onFlyTo,
  onSelectVehicle,
  onClose,
}: LineCardProps) {
  const ModeIcon = MODE_ICON[profile.mode]
  const minutes = (seconds: number) => Math.round(seconds / 60)
  // Both termini's next departures, soonest first – which end it leaves
  // from matters less than when something next moves.
  // Grouped by direction: within one, every vehicle carries the same
  // destination, and six rows repeating "Hafenallee" say nothing. As a
  // heading it says which way the group runs, once.
  const byDirection = ([0, 1] as const)
    .map((direction) => ({
      direction,
      destination: direction === 0 ? profile.to : profile.from,
      vehicles: (activity?.vehicles ?? []).filter((v) => v.direction === direction),
    }))
    .filter((group) => group.vehicles.length > 0)

  // Each direction's next departure with where it is headed – direction 0
  // runs toward `to`, direction 1 back toward `from`. Naming the
  // destination is what makes a single line unambiguous when only one
  // direction still has service.
  const upcoming = [profile.to, profile.from]
    .map((destination, i) => ({ destination, at: activity?.nextDeparture[i] ?? null }))
    .filter((entry): entry is { destination: string; at: number } => entry.at !== null)
    .sort((a, b) => a.at - b.at)

  return (
    <Card
      className="pointer-events-auto w-100 border-border/60 bg-card/85 backdrop-blur-md"
      data-testid="line-card"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="flex min-w-0 flex-col gap-1 text-base">
          <span className="flex items-center gap-2">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-md text-sm font-bold text-white"
              style={{ backgroundColor: color }}
            >
              {profile.lineId}
            </span>
            <span className="truncate" data-testid="line-name">
              {name}
            </span>
          </span>
          {/* Both termini, with the double arrow the panel's toggles use –
              a line is not the one direction its data happens to list first. */}
          <span className="flex items-center gap-1.5 text-sm font-normal text-muted-foreground">
            {profile.from}
            <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden />
            {profile.to}
          </span>
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('line.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('line.service')}</span>
          <span data-testid="line-service">
            {profile.service ? (
              <>
                {formatServiceTime(profile.service.first)}–{formatServiceTime(profile.service.last)}
                {profile.headway && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('line.everyMin', { count: minutes(profile.headway.median) })}
                    {/* Only worth naming when the peak is actually denser */}
                    {profile.headway.peak !== null &&
                      minutes(profile.headway.peak) < minutes(profile.headway.median) &&
                      ` · ${t('line.peakMin', { count: minutes(profile.headway.peak) })}`}
                  </span>
                )}
              </>
            ) : (
              t('line.noSchedule')
            )}
          </span>

          <span className="text-muted-foreground">{t('line.route')}</span>
          <span data-testid="line-route">
            {formatLength(profile.lengthMeters)}
            <span className="text-muted-foreground">
              {' · '}
              {t('line.stops', { count: formatStopCount(profile.stopCount) })}
              {' · '}
              {t('line.spacing', { count: Math.round(profile.meanStopSpacing) })}
            </span>
          </span>

          {profile.trips && (
            <>
              <span className="text-muted-foreground">{t('line.trips')}</span>
              <span data-testid="line-trips">
                {t('line.tripsPerDay', { count: profile.trips.total })}
                {/* The reason not every trip reaches the terminus above */}
                {profile.trips.shortWorkings > 0 && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('line.shortWorkings', { count: profile.trips.shortWorkings })}
                  </span>
                )}
              </span>
            </>
          )}

          {activity && (
            <>
              <span className="text-muted-foreground">{t('line.running')}</span>
              <span data-testid="line-running">
                {activity.vehicles.length > 0
                  ? t('line.runningCount', { count: activity.vehicles.length })
                  : t('line.runningNone')}
                {/* Only where the feed covers this line – see buildLineActivity */}
                {activity.delay && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {minutes(Math.abs(activity.delay.medianSeconds)) < 1
                      ? t('line.punctual')
                      : activity.delay.medianSeconds > 0
                        ? t('line.delayed', { count: minutes(activity.delay.medianSeconds) })
                        : t('line.early', { count: minutes(-activity.delay.medianSeconds) })}
                  </span>
                )}
              </span>

              <span className="text-muted-foreground">{t('line.nextOut')}</span>
              <span data-testid="line-next">
                {upcoming.length > 0
                  ? upcoming.map((entry) => (
                      <span key={entry.destination} className="block truncate">
                        {formatServiceTime(entry.at)}
                        <span className="text-muted-foreground"> → {entry.destination}</span>
                      </span>
                    ))
                  : t('line.nextNone')}
              </span>
            </>
          )}
        </div>
        {byDirection.length > 0 && (
          <div
            className="scroll-fade-y flex max-h-48 flex-col gap-1 overflow-y-auto"
            data-testid="line-vehicles"
          >
            {byDirection.map((group) => (
              <div key={group.direction} className="flex flex-col">
                <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                  <ArrowRight className="size-3 shrink-0" aria-hidden />
                  {group.destination}
                </span>
                <ol className="flex flex-col">
                  {group.vehicles.map((v) => {
                    // Where it is, in one phrase – the row's text and its
                    // accessible name say the same thing.
                    const position =
                      v.status === 'dwell'
                        ? t('line.atStop', { name: v.nextStopName })
                        : t('line.towards', { name: v.nextStopName })
                    return (
                      <li key={v.id}>
                        {/* Every vehicle here is on the map by definition, so
                            unlike the stop card's departures each row is a link. */}
                        <button
                          type="button"
                          className="-mx-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                          onClick={() => onSelectVehicle(v.id)}
                          aria-label={t('line.showVehicle', {
                            name: position,
                            destination: group.destination,
                          })}
                        >
                          <ModeIcon
                            className={`size-3.5 shrink-0 ${v.inTunnel ? 'opacity-40' : ''}`}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate text-sm">{position}</span>
                          {v.realtime && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {formatDelay(v.delaySeconds)}
                            </Badge>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFlyTo}>
            <Crosshair aria-hidden />
            {t('line.flyTo')}
          </Button>
          <Badge variant="secondary" data-testid="line-mode">
            <ModeIcon aria-hidden />
            {t(MODE_KEY[profile.mode])}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
