import { ArrowRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { VehicleSnapshot } from '@/engine/simulation'

export interface VehicleCardProps {
  vehicle: VehicleSnapshot
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

/** "+3 min" / "-1 min" / "on time" */
function formatDelay(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return 'on time'
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes} min`
}

/** Mode-appropriate label for the follow button. */
const FOLLOW_LABEL: Record<VehicleSnapshot['mode'], string> = {
  tram: 'Follow tram',
  train: 'Follow train',
  bus: 'Follow bus',
  ferry: 'Follow ferry',
}

/** Status text; ferries dock at a pier, not at a stop. */
function statusText(vehicle: VehicleSnapshot): string {
  const base =
    vehicle.status === 'moving' ? 'Moving' : vehicle.mode === 'ferry' ? 'At pier' : 'At stop'
  // Explains why the vehicle is rendered as a 40 % ghost on the map
  return vehicle.inTunnel ? `${base} · in tunnel` : base
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
        <Button variant="ghost" size="icon-sm" aria-label="Close selection" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">Status</span>
          <span data-testid="vehicle-status">{statusText(vehicle)}</span>
          <span className="text-muted-foreground">Next stop</span>
          <span data-testid="vehicle-next-stop">{vehicle.nextStopName}</span>
          <span className="text-muted-foreground">Trip</span>
          <span className="font-mono text-xs">{vehicle.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={following ? 'default' : 'outline'}
            size="sm"
            onClick={onToggleFollow}
          >
            <Crosshair aria-hidden />
            {following ? 'Stop following' : FOLLOW_LABEL[vehicle.mode]}
          </Button>
          {vehicle.realtime ? (
            <Badge variant="secondary" data-testid="vehicle-delay">
              GTFS-RT · {formatDelay(vehicle.delaySeconds)}
            </Badge>
          ) : (
            <Badge variant="secondary">Schedule simulation</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
