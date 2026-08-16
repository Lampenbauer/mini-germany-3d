import { ArrowRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TramSnapshot } from '@/engine/simulation'

export interface TramCardProps {
  tram: TramSnapshot
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

/** "+3 min" / "-1 min" / "pünktlich" */
function formatDelay(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return 'pünktlich'
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes} min`
}

/** Verkehrsmittel-gerechte Beschriftung des Folgen-Buttons. */
const FOLLOW_LABEL: Record<TramSnapshot['mode'], string> = {
  tram: 'Bahn folgen',
  bus: 'Bus folgen',
  ferry: 'Fähre folgen',
}

/** Status-Text; Fähren halten am Anleger, nicht an einer Haltestelle. */
function statusText(tram: TramSnapshot): string {
  if (tram.status === 'moving') return 'In Fahrt'
  return tram.mode === 'ferry' ? 'Halt am Anleger' : 'Halt an Haltestelle'
}

export function TramCard({ tram, following, onToggleFollow, onClose }: TramCardProps) {
  return (
    <Card
      className="pointer-events-auto w-80 border-border/60 bg-card/85 backdrop-blur-md"
      data-testid="tram-card"
    >
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <span
            className="flex size-7 items-center justify-center rounded-md text-sm font-bold text-white"
            style={{ backgroundColor: tram.color }}
          >
            {tram.lineId}
          </span>
          <span className="flex items-center gap-1.5">
            {tram.origin}
            <ArrowRight className="size-4 text-muted-foreground" aria-hidden />
            {tram.destination}
          </span>
        </CardTitle>
        <Button variant="ghost" size="icon-sm" aria-label="Auswahl schließen" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <span className="text-muted-foreground">Status</span>
          <span data-testid="tram-status">{statusText(tram)}</span>
          <span className="text-muted-foreground">Nächster Halt</span>
          <span data-testid="tram-next-stop">{tram.nextStopName}</span>
          <span className="text-muted-foreground">Fahrt</span>
          <span className="font-mono text-xs">{tram.id}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={following ? 'default' : 'outline'}
            size="sm"
            onClick={onToggleFollow}
          >
            <Crosshair aria-hidden />
            {following ? 'Verfolgung beenden' : FOLLOW_LABEL[tram.mode]}
          </Button>
          {tram.realtime ? (
            <Badge variant="secondary" data-testid="tram-delay">
              GTFS-RT · {formatDelay(tram.delaySeconds)}
            </Badge>
          ) : (
            <Badge variant="secondary">Fahrplansimulation</Badge>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
