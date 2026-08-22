import { ArrowRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { VehicleSnapshot } from '@/engine/simulation'
import { t, type MessageKey } from '@/lib/i18n'

export interface VehicleCardProps {
  vehicle: VehicleSnapshot
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

/** "+3 min" / "-1 min" / "on time" */
function formatDelay(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return t('vehicle.onTime')
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes} min`
}

/** Mode-appropriate label key for the follow button. */
const FOLLOW_KEY: Record<VehicleSnapshot['mode'], MessageKey> = {
  tram: 'follow.tram',
  train: 'follow.train',
  bus: 'follow.bus',
  ferry: 'follow.ferry',
}

/** Status text; ferries dock at a pier, not at a stop. */
function statusText(vehicle: VehicleSnapshot): string {
  const base =
    vehicle.status === 'moving'
      ? t('vehicle.moving')
      : vehicle.mode === 'ferry'
        ? t('vehicle.atPier')
        : t('vehicle.atStop')
  // Explains why the vehicle is rendered as a 40 % ghost on the map
  return vehicle.inTunnel ? `${base} · ${t('vehicle.inTunnel')}` : base
}

export function VehicleCard({ vehicle, following, onToggleFollow, onClose }: VehicleCardProps) {
  return (
    <Card
      className="pointer-events-auto w-100 border-border/60 bg-card/85 backdrop-blur-md"
      data-testid="vehicle-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="flex size-7 items-center justify-center rounded-md text-sm font-bold text-white"
            style={{ backgroundColor: vehicle.color }}
          >
            {vehicle.lineId}
          </span>
          <span className="flex items-center gap-1.5">
            {vehicle.origin}
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            {vehicle.destination}
          </span>
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label={t('vehicle.close')} onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">{t('vehicle.status')}</span>
          <span data-testid="vehicle-status">{statusText(vehicle)}</span>
          <span className="text-muted-foreground">{t('vehicle.nextStop')}</span>
          <span data-testid="vehicle-next-stop">{vehicle.nextStopName}</span>
          <span className="text-muted-foreground">{t('vehicle.trip')}</span>
          <span className="font-mono text-xs">{vehicle.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={following ? 'default' : 'outline'}
            size="sm"
            onClick={onToggleFollow}
          >
            <Crosshair aria-hidden />
            {following ? t('follow.stop') : t(FOLLOW_KEY[vehicle.mode])}
          </Button>
          {vehicle.realtime ? (
            <Badge variant="secondary" data-testid="vehicle-delay">
              GTFS-RT · {formatDelay(vehicle.delaySeconds)}
            </Badge>
          ) : (
            <Badge variant="secondary">{t('vehicle.onSchedule')}</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
