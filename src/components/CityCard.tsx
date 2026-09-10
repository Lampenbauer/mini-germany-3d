import { Crosshair } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { CARD_SHELL, CardHead, EyebrowDot, LineChip, Stat } from '@/components/card-parts'
import { MODE_ICON } from '@/components/mode-icon'
import { NetworkIllustration } from '@/components/NetworkIllustration'
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
 *
 * The card opens from the panel's head and wears the same green, with
 * the About dialog's small network in it: the four big figures stand on
 * tiles below, the rows that need a phrase (the longest line, the
 * heights, the service day) follow as a list, and the live row closes
 * the card under its own rule.
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

/** A label in the list under the tiles, and the label of the live row. */
const ROW_LABEL = 'text-muted-foreground'

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
      className={CARD_SHELL}
      data-testid="city-card"
    >
      <CardHead
        className="bg-brand"
        // Behind the text (-z-10 stops at the head), faded towards the name
        // it must not compete with and towards the top, where the close
        // button has to stay legible over it.
        behind={
          <NetworkIllustration className="absolute top-0 -right-4 -z-10 h-full opacity-80 mask-l-from-45% mask-t-from-35%" />
        }
        eyebrow={
          <>
            <EyebrowDot />
            {t('city.factsSubtitle')}
          </>
        }
        eyebrowClassName="text-brand-light"
        title={<span className="truncate">{name}</span>}
        titleTestId="city-card-name"
        closeLabel={t('city.close')}
        onClose={onClose}
      >
        {/* One chip per mode with its line count; "7/8" where a line of
            the mode stands still today. On the green they wear a wash of
            white rather than the card's grey. */}
        <span className="mt-3 flex flex-wrap gap-1" data-testid="city-modes">
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
                className="bg-white/12 text-inherit tabular-nums"
                title={t(MODE_KEY[entry.mode])}
                aria-label={`${t(MODE_KEY[entry.mode])} ${count}`}
              >
                <Icon aria-hidden />
                {count}
              </Badge>
            )
          })}
        </span>
      </CardHead>

      <CardContent className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label={t('city.lines')}
            value={t('city.linesCount', { count: formatCount(profile.lines.total) })}
            // Only with a timetable to say so – and only when it says
            // something: a network where every line runs today has no
            // second number worth a word.
            note={
              profile.lines.running !== null && profile.lines.running < profile.lines.total
                ? t('city.linesRunning', { count: formatCount(profile.lines.running) })
                : undefined
            }
            testId="city-lines"
          />
          <Stat
            label={t('city.stops')}
            value={t('city.stopPositions', { count: formatCount(profile.stopPositions) })}
            testId="city-stops"
          />
          <Stat
            label={t('city.route')}
            value={t('city.lineKm', { km: formatKilometres(profile.lineMeters) })}
            // A tunnel share below half a percent is Kiel's 1.2 km of
            // underpass – not worth a phrase.
            note={
              tunnelPercent(profile) > 0
                ? t('city.tunnelShare', {
                    km: formatKilometres(profile.tunnelMeters),
                    percent: tunnelPercent(profile),
                  })
                : undefined
            }
            testId="city-route"
          />
          <Stat
            label={t('city.trips')}
            value={
              profile.trips
                ? t('city.tripsPerDay', { count: formatCount(profile.trips.total) })
                : t('city.noSchedule')
            }
            muted={!profile.trips}
            note={
              profile.trips && profile.trips.shortWorkings > 0
                ? t('city.shortWorkings', { count: formatCount(profile.trips.shortWorkings) })
                : undefined
            }
            testId="city-trips"
          />
        </div>

        {(longestLine || profile.elevation || profile.service) && (
          <div className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 border-t border-border pt-3 text-sm">
            {profile.longest && longestLine && (
              <>
                <span className={ROW_LABEL}>{t('city.longest')}</span>
                <span data-testid="city-longest">
                  {/* The line is on the map by definition, so its row is a
                      link there, the way the panel's line names are. */}
                  <button
                    type="button"
                    className="-mx-1 -my-0.5 flex max-w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent"
                    onClick={() => onFocusLine(longestLine.id)}
                    aria-label={t('city.flyToLongest', {
                      name: longestLine.name,
                      km: formatKilometres(profile.longest.meters, 1),
                    })}
                  >
                    <LineChip id={longestLine.id} color={longestLine.color} className="size-6 rounded-md text-xs font-bold" />
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
                <span className={ROW_LABEL}>{t('city.elevation')}</span>
                <span data-testid="city-elevation">
                  {t('city.elevationRange', {
                    min: Math.round(profile.elevation.min),
                    max: Math.round(profile.elevation.max),
                  })}
                  <span className="text-muted-foreground">
                    {' · '}
                    {t('city.highestStop', { name: profile.elevation.highestStop })}
                  </span>
                </span>
              </>
            )}

            {profile.service && (
              <>
                <span className={ROW_LABEL}>{t('city.service')}</span>
                <span data-testid="city-service">
                  {isRoundTheClock(profile.service)
                    ? t('city.roundTheClock')
                    : `${formatServiceTime(profile.service.first)}–${formatServiceTime(profile.service.last)}`}
                </span>
              </>
            )}
          </div>
        )}

        {/* The one row that is the simulation's, not the data's: it moves
            with the clock, and the dot in front of the label marks it as
            the live one, the way the panel's counts change under the
            time-lapse. */}
        {activity && (
          // items-start, not items-baseline: the label is a flex box whose
          // first item is the dot, and a box with no text of its own lends
          // its bottom edge as baseline – the label then sat a few pixels
          // above the value. Both are one text-sm line high, so their tops
          // meeting aligns their first lines.
          <div className="flex items-start gap-3 border-t border-border pt-3 text-sm">
            <span className={`flex shrink-0 items-center gap-1.5 ${ROW_LABEL}`}>
              <EyebrowDot className="bg-brand-mid" />
              {t('city.running')}
            </span>
            <span data-testid="city-running">
              {activity.total > 0
                ? t('city.runningCount', { count: formatCount(activity.total) })
                : t('city.runningNone')}
              {/* Only where the feed covers anything – see buildCityActivity */}
              {activity.delay && (
                <span className="text-muted-foreground">
                  {' · '}
                  {t('city.liveCovered', { count: formatCount(activity.delay.vehicles) })}
                  {' · '}
                  {minutes(Math.abs(activity.delay.medianSeconds)) < 1
                    ? t('line.punctual')
                    : activity.delay.medianSeconds > 0
                      ? t('line.delayed', { count: minutes(activity.delay.medianSeconds) })
                      : t('line.early', { count: minutes(-activity.delay.medianSeconds) })}
                </span>
              )}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
