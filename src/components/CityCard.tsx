import { Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MODE_ICON } from '@/components/mode-icon'
import { MODE_KEY, t } from '@/lib/i18n'
import {
  formatCount,
  formatKilometres,
  isRoundTheClock,
  tunnelPercent,
  type CityActivity,
  type CityProfile,
} from '@/lib/city-profile'
import { formatServiceTime } from '@/lib/line-profile'

/**
 * What the city's network is, behind the info button in the control
 * panel's head: how many lines and stops, how far the lines run and how
 * much of that underground, how high the network climbs, how many trips
 * the day holds – and, live, how much of the fleet is out. Everything
 * shown is stated by the data (see city-profile.ts); nothing is a
 * simulation result except the last row, which says so by changing.
 */
export interface CityCardProps {
  profile: CityProfile
  /**
   * What the fleet is doing at this instant, refreshed on the app's UI
   * tick. Null while the simulation has not produced a snapshot yet.
   */
  activity: CityActivity | null
  /** The city's name as the interface speaks it – the card's title. */
  name: string
  /**
   * The longest line as the panel lists it: its badge and name. Null
   * only for a network with no lines, when the row is left out.
   */
  longestLine: { id: string; name: string; color: string } | null
  /** Camera flight to a line, as clicking its name in the panel does. */
  onFocusLine: (lineId: string) => void
  onClose: () => void
}

export function CityCard({
  profile,
  activity,
  name,
  longestLine,
  onFocusLine,
  onClose,
}: CityCardProps) {
  const minutes = (seconds: number) => Math.round(seconds / 60)
  return (
    <Card
      className="pointer-events-auto w-100 border-border/60 bg-card/85 backdrop-blur-xl"
      data-testid="city-card"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <CardTitle className="flex min-w-0 flex-col gap-1 text-base">
          <span className="truncate" data-testid="city-card-name">
            {name}
          </span>
          <span className="text-sm font-normal text-muted-foreground">
            {t('city.factsSubtitle')}
          </span>
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('city.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('city.lines')}</span>
          <span data-testid="city-lines">
            {t('city.linesCount', { count: formatCount(profile.lines.total) })}
            {/* Only with a timetable to say so – and only when it says
                something: a network where every line runs today has no
                second number worth a word. */}
            {profile.lines.running !== null && profile.lines.running < profile.lines.total && (
              <span className="text-muted-foreground">
                {' · '}
                {t('city.linesRunning', {
                  count: formatCount(profile.lines.running),
                })}
              </span>
            )}
            {/* One badge per mode with its line count; "7/8" where a line
                of the mode stands still today. */}
            <span className="mt-1 flex flex-wrap gap-1" data-testid="city-modes">
              {profile.modes.map((entry) => {
                const Icon = MODE_ICON[entry.mode]
                const count =
                  entry.running !== null && entry.running < entry.lines
                    ? `${entry.running}/${entry.lines}`
                    : String(entry.lines)
                return (
                  <Badge
                    key={entry.mode}
                    variant="secondary"
                    title={t(MODE_KEY[entry.mode])}
                    aria-label={`${t(MODE_KEY[entry.mode])} ${count}`}
                  >
                    <Icon aria-hidden />
                    {count}
                  </Badge>
                )
              })}
            </span>
          </span>

          <span className="text-muted-foreground">{t('city.stops')}</span>
          <span data-testid="city-stops">
            {t('city.stopPositions', {
              count: formatCount(profile.stopPositions),
            })}
          </span>

          <span className="text-muted-foreground">{t('city.route')}</span>
          <span data-testid="city-route">
            {t('city.lineKm', { km: formatKilometres(profile.lineMeters) })}
            {/* A tunnel share below half a percent is Kiel's 1.2 km of
                underpass – not worth a phrase. */}
            {tunnelPercent(profile) > 0 && (
              <span className="text-muted-foreground">
                {' · '}
                {t('city.tunnelShare', {
                  km: formatKilometres(profile.tunnelMeters),
                  percent: tunnelPercent(profile),
                })}
              </span>
            )}
          </span>

          {profile.longest && longestLine && (
            <>
              <span className="text-muted-foreground">{t('city.longest')}</span>
              <span data-testid="city-longest">
                {/* The line is on the map by definition, so its row is a
                    link there, the way the panel's line names are. */}
                <button
                  type="button"
                  className="-mx-1 flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                  onClick={() => onFocusLine(longestLine.id)}
                  aria-label={t('city.flyToLongest', {
                    name: longestLine.name,
                    km: formatKilometres(profile.longest.meters, 1),
                  })}
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
                    style={{ backgroundColor: longestLine.color }}
                    aria-hidden
                  >
                    {longestLine.id}
                  </span>
                  <span className="min-w-0 truncate">{longestLine.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatKilometres(profile.longest.meters, 1)}
                  </span>
                  <Crosshair className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </span>
            </>
          )}

          {profile.elevation && (
            <>
              <span className="text-muted-foreground">{t('city.elevation')}</span>
              <span data-testid="city-elevation">
                {t('city.elevationRange', {
                  min: Math.round(profile.elevation.min),
                  max: Math.round(profile.elevation.max),
                })}
                <span className="text-muted-foreground">
                  {' · '}
                  {t('city.highestStop', {
                    name: profile.elevation.highestStop,
                  })}
                </span>
              </span>
            </>
          )}

          <span className="text-muted-foreground">{t('city.trips')}</span>
          <span data-testid="city-trips">
            {profile.trips ? (
              <>
                {t('city.tripsPerDay', {
                  count: formatCount(profile.trips.total),
                })}
                {profile.trips.shortWorkings > 0 && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('city.shortWorkings', {
                      count: formatCount(profile.trips.shortWorkings),
                    })}
                  </span>
                )}
              </>
            ) : (
              t('city.noSchedule')
            )}
          </span>

          {profile.service && (
            <>
              <span className="text-muted-foreground">{t('city.service')}</span>
              <span data-testid="city-service">
                {isRoundTheClock(profile.service)
                  ? t('city.roundTheClock')
                  : `${formatServiceTime(profile.service.first)}–${formatServiceTime(profile.service.last)}`}
              </span>
            </>
          )}

          {activity && (
            <>
              <span className="text-muted-foreground">{t('city.running')}</span>
              <span data-testid="city-running">
                {activity.total > 0
                  ? t('city.runningCount', {
                      count: formatCount(activity.total),
                    })
                  : t('city.runningNone')}
                {/* Only where the feed covers anything – see buildCityActivity */}
                {activity.delay && (
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('city.liveCovered', {
                      count: formatCount(activity.delay.vehicles),
                    })}
                    {' · '}
                    {minutes(Math.abs(activity.delay.medianSeconds)) < 1
                      ? t('line.punctual')
                      : activity.delay.medianSeconds > 0
                        ? t('line.delayed', {
                            count: minutes(activity.delay.medianSeconds),
                          })
                        : t('line.early', {
                            count: minutes(-activity.delay.medianSeconds),
                          })}
                  </span>
                )}
              </span>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
