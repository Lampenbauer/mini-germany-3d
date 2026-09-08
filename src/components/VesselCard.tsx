import { Crosshair, Ship, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { AisVessel } from '@/lib/ais-extract'
import { t } from '@/lib/i18n'
import {
  formatDimensions,
  formatFixAge,
  formatSpeed,
  navStatusKey,
  vesselTitle,
  vesselTypeKey,
} from '@/lib/vessel-info'

/**
 * The selected AIS ship, in the vehicle card's clothes: same shell, same
 * follow button, different contents. A ship has none of what the vehicle
 * card is built around – no line, no trip, no timetable of stops – and
 * everything it does have (the static report and the navigational status)
 * the vehicle card has no place for, so the two share a look rather than
 * a component.
 *
 * Every field can be missing: static reports arrive only every six minutes
 * and small craft often send none at all, so a nameless ship shows her
 * MMSI and unreported fields say so instead of showing a made-up zero.
 */
export interface VesselCardProps {
  vessel: AisVessel
  /** Wall clock the fix age is measured against. */
  nowMs: number
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

export function VesselCard({ vessel, nowMs, following, onToggleFollow, onClose }: VesselCardProps) {
  const typeKey = vesselTypeKey(vessel.typeCode)
  const statusKey = navStatusKey(vessel.navStatus)
  const dimensions = formatDimensions(vessel)
  // A field the server never sent arrives as undefined, not null – see
  // formatDimensions in vessel-info.ts for what that cost once.
  const draughtM = vessel.draughtM ?? null

  return (
    <Card
      className="pointer-events-auto w-100 border-border/60 bg-card/85 backdrop-blur-xl"
      data-testid="vessel-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex min-w-0 items-center gap-2 text-base">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Ship className="size-4" aria-hidden />
          </span>
          <span className="truncate" data-testid="vessel-name">
            {vesselTitle(vessel)}
          </span>
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('vehicle.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('vehicle.status')}</span>
          <span data-testid="vessel-status">
            {statusKey ? t(statusKey) : t('vessel.unknown')}
            <span className="text-muted-foreground">
              {' · '}
              {formatFixAge(vessel.positionAt, nowMs)}
            </span>
          </span>

          <span className="text-muted-foreground">{t('vessel.speed')}</span>
          <span data-testid="vessel-speed">{formatSpeed(vessel.sogKn)}</span>

          <span className="text-muted-foreground">{t('vessel.type')}</span>
          <span data-testid="vessel-type">{typeKey ? t(typeKey) : t('vessel.unknown')}</span>

          <span className="text-muted-foreground">{t('vessel.dimensions')}</span>
          <span data-testid="vessel-dimensions">{dimensions ?? t('vessel.notReported')}</span>

          <span className="text-muted-foreground">{t('vessel.draught')}</span>
          <span data-testid="vessel-draught">
            {draughtM === null ? t('vessel.notReported') : `${draughtM.toFixed(1)} m`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant={following ? 'default' : 'outline'} size="sm" onClick={onToggleFollow}>
            <Crosshair aria-hidden />
            {following ? t('follow.stop') : t('follow.vessel')}
          </Button>
          <Badge variant="secondary" data-testid="vessel-mmsi">
            {t('vessel.mmsi')} {vessel.mmsi}
          </Badge>
        </div>
      </CardContent>
    </Card>
  )
}
