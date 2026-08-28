import { ArrowLeftRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MODE_ICON } from '@/components/mode-icon'
import { MODE_KEY, t } from '@/lib/i18n'
import {
  formatLength,
  formatServiceTime,
  formatStopCount,
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
  /** Line name and color from the network – the card's identity. */
  name: string
  color: string
  /** Camera flight to the route, as clicking the name in the panel does. */
  onFlyTo: () => void
  onClose: () => void
}

export function LineCard({ profile, name, color, onFlyTo, onClose }: LineCardProps) {
  const ModeIcon = MODE_ICON[profile.mode]
  const minutes = (seconds: number) => Math.round(seconds / 60)

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

          {(profile.heightRange || profile.tunnelShare > 0.005) && (
            <>
              <span className="text-muted-foreground">{t('line.terrain')}</span>
              <span data-testid="line-terrain">
                {profile.heightRange &&
                  `${Math.round(profile.heightRange.min)}–${Math.round(profile.heightRange.max)} m NHN`}
                {profile.tunnelShare > 0.005 && (
                  <span className="text-muted-foreground">
                    {profile.heightRange ? ' · ' : ''}
                    {t('line.tunnelShare', { count: Math.round(profile.tunnelShare * 100) })}
                  </span>
                )}
              </span>
            </>
          )}
        </div>
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
