import { ArrowLeftRight, ArrowRight, Crosshair } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CARD_SHELL, CardHead, LineChip, SectionLabel, Stat, headInk } from '@/components/card-parts'
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
 *
 * The head is the line's own colour, the way its vehicles wear it on the
 * map, with the ink the colour's lightness asks for (headInk); the number
 * inverts to that ink with the colour as its own, so the badge does not
 * vanish into its own ground. The figures
 * stand on tiles, the live rows – how much of the line is out, when it
 * next leaves – and the list of its vehicles follow.
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
  const ink = headInk(color)
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
      className={CARD_SHELL}
      data-testid="line-card"
    >
      <CardHead
        className={ink.text}
        style={{ backgroundColor: color }}
        eyebrow={
          <span className="flex items-center gap-1.5" data-testid="line-mode">
            <ModeIcon className="size-3.5" aria-hidden />
            {t(MODE_KEY[profile.mode])}
          </span>
        }
        eyebrowClassName={ink.muted}
        title={
          <>
            <LineChip id={profile.lineId} color={color} size="lg" inverted />
            <span className="truncate" data-testid="line-name">
              {name}
            </span>
          </>
        }
        // Both termini, with the double arrow the panel's toggles use – a
        // line is not the one direction its data happens to list first.
        lead={
          <span className="flex items-center gap-1.5">
            <span className="truncate">{profile.from}</span>
            <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{profile.to}</span>
          </span>
        }
        leadClassName={ink.muted}
        closeLabel={t('line.close')}
        onClose={onClose}
      />

      <CardContent className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label={t('line.service')}
            value={
              profile.service
                ? `${formatServiceTime(profile.service.first)}–${formatServiceTime(profile.service.last)}`
                : t('line.noSchedule')
            }
            muted={!profile.service}
            note={
              profile.service && profile.headway ? (
                <>
                  {t('line.everyMin', { count: minutes(profile.headway.median) })}
                  {/* Only worth naming when the peak is actually denser */}
                  {profile.headway.peak !== null &&
                    minutes(profile.headway.peak) < minutes(profile.headway.median) &&
                    ` · ${t('line.peakMin', { count: minutes(profile.headway.peak) })}`}
                </>
              ) : undefined
            }
            testId="line-service"
          />
          <Stat
            label={t('line.route')}
            value={formatLength(profile.lengthMeters)}
            note={
              <>
                {t('line.stops', { count: formatStopCount(profile.stopCount) })}
                {' · '}
                {t('line.spacing', { count: Math.round(profile.meanStopSpacing) })}
              </>
            }
            testId="line-route"
          />
          {profile.trips && (
            <Stat
              label={t('line.trips')}
              value={t('line.tripsPerDay', { count: profile.trips.total })}
              // The reason not every trip reaches the terminus above
              note={
                profile.trips.shortWorkings > 0
                  ? t('line.shortWorkings', { count: profile.trips.shortWorkings })
                  : undefined
              }
              testId="line-trips"
            />
          )}
          {activity && (
            <Stat
              label={t('line.running')}
              value={
                activity.vehicles.length > 0
                  ? t('line.runningCount', { count: activity.vehicles.length })
                  : t('line.runningNone')
              }
              muted={activity.vehicles.length === 0}
              // Only where the feed covers this line – see buildLineActivity
              note={
                activity.delay
                  ? minutes(Math.abs(activity.delay.medianSeconds)) < 1
                    ? t('line.punctual')
                    : activity.delay.medianSeconds > 0
                      ? t('line.delayed', { count: minutes(activity.delay.medianSeconds) })
                      : t('line.early', { count: minutes(-activity.delay.medianSeconds) })
                  : undefined
              }
              testId="line-running"
            />
          )}
        </div>

        {/* The sections under the tiles are ruled off from one another,
            as on the city card. */}
        {activity && (
          <div className="flex flex-col gap-1 border-t border-border pt-3">
            <SectionLabel>{t('line.nextOut')}</SectionLabel>
            <span className="text-sm" data-testid="line-next">
              {upcoming.length > 0
                ? upcoming.map((entry) => (
                    <span key={entry.destination} className="flex items-center gap-2 truncate">
                      <span className="font-mono text-xs tabular-nums">{formatServiceTime(entry.at)}</span>{' '}
                      <span className="truncate text-muted-foreground">→ {entry.destination}</span>
                    </span>
                  ))
                : t('line.nextNone')}
            </span>
          </div>
        )}

        {byDirection.length > 0 && (
          <ScrollArea
            className="max-h-48 border-t border-border pt-3"
            viewportClassName="scroll-fade-y"
            data-testid="line-vehicles"
          >
            <div className="flex flex-col gap-2">
              {byDirection.map((group) => (
                <div key={group.direction} className="flex flex-col gap-0.5">
                  <SectionLabel className="flex items-center gap-1 truncate normal-case tracking-normal">
                    <ArrowRight className="size-3 shrink-0" aria-hidden />
                    {group.destination}
                  </SectionLabel>
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
                            className="-mx-1 flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent"
                            onClick={() => onSelectVehicle(v.id)}
                            aria-label={t('line.showVehicle', {
                              name: position,
                              destination: group.destination,
                            })}
                          >
                            <ModeIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="min-w-0 flex-1 truncate text-sm">{position}</span>
                            {v.realtime && (
                              <Badge variant="secondary" className="shrink-0 text-2xs">
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
          </ScrollArea>
        )}

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onFlyTo}>
            <Crosshair aria-hidden />
            {t('line.flyTo')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
