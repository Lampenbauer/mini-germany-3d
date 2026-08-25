import { useEffect, useRef } from 'react'
import { ArrowRight, Crosshair, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { TripProgress, TripStop, VehicleSnapshot } from '@/engine/simulation'
import type { InterchangeOption } from '@/lib/interchange'
import { MODE_KEY, t, type MessageKey } from '@/lib/i18n'

export interface VehicleCardProps {
  vehicle: VehicleSnapshot
  /** All stops of the trip plus the vehicle's position (null = inactive). */
  tripProgress: TripProgress | null
  /** Simulation clock in seconds of day – basis for the arrival countdown. */
  simSeconds: number
  /** Stop id → the lines reachable from it (drives the interchange badges). */
  interchangeByStop: ReadonlyMap<string, InterchangeOption[]>
  /** Click on a stop – the camera flies to it. */
  onFlyToStop: (stop: TripStop) => void
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

/** "08:31" from seconds since midnight (arrival seconds are already 0–24 h). */
export function formatArrival(arrivalSec: number): string {
  const clamped = ((arrivalSec % 86400) + 86400) % 86400
  const h = Math.floor(clamped / 3600)
  const m = Math.floor((clamped % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** "+3 min" / "-1 min" / "on time" */
export function formatDelay(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return t('vehicle.onTime')
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes} min`
}

/**
 * Minutes from now until an arrival, wrapping across midnight.
 *
 * Both values are floored to whole minutes first, so the countdown agrees
 * with the clock time shown right next to it: an arrival at 08:33:40 seen
 * at 08:30:00 reads as three minutes, not the four a rounded difference
 * would give.
 */
export function minutesUntil(arrivalSec: number, nowSec: number): number {
  const diff = Math.floor(arrivalSec / 60) - Math.floor(nowSec / 60)
  return diff < -720 ? diff + 1440 : diff > 720 ? diff - 1440 : diff
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

export function VehicleCard({
  vehicle,
  tripProgress,
  simSeconds,
  interchangeByStop,
  onFlyToStop,
  following,
  onToggleFollow,
  onClose,
}: VehicleCardProps) {
  const stops = tripProgress?.stops ?? []
  const position = tripProgress?.position ?? 0
  // Row that carries the vehicle marker and how far along its segment the
  // marker sits (0 = on the row's own dot, i.e. dwelling at that stop).
  const markerIndex = Math.min(Math.floor(position), Math.max(stops.length - 1, 0))
  const markerFraction = position - Math.floor(position)
  // The snapshot's "next stop" row (E2E contract for vehicle-next-stop)
  const nextIndex = Math.min(markerIndex + 1, Math.max(stops.length - 1, 0))

  // Arrival at the destination: the value is already in the list (delay
  // applied), just buried at its bottom – this lifts it into the summary.
  const finalStop = stops.length > 0 ? stops[stops.length - 1] : null
  const stopsLeft = Math.max(0, stops.length - 1 - markerIndex)
  /**
   * The stop whose interchange options are shown. While the vehicle dwells
   * (markerFraction 0 – the marker sits on the stop's own dot) that is the
   * stop it stands at: those are the connections a passenger can take right
   * now. Only once it pulls away does the stop ahead become the useful one.
   */
  const interchangeStop = stops.length > 0 ? stops[markerFraction === 0 ? markerIndex : nextIndex] : null
  const interchange = interchangeStop
    ? (interchangeByStop.get(interchangeStop.id) ?? []).filter(
        (line) => line.id !== vehicle.lineId,
      )
    : []

  // Bring the vehicle marker into view when a (new) vehicle is selected –
  // the list keeps the user's scroll position afterwards.
  const listRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-vehicle-position]')
      ?.scrollIntoView?.({ block: 'center' })
  }, [vehicle.id])

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
          {finalStop && (
            <>
              <span className="text-muted-foreground">{t('vehicle.arrival')}</span>
              <span data-testid="vehicle-arrival">
                {formatArrival(finalStop.arrivalSec)}
                <span className="text-muted-foreground">
                  {' · '}
                  {stopsLeft === 0
                    ? t('vehicle.lastStop')
                    : `${
                        minutesUntil(finalStop.arrivalSec, simSeconds) < 1
                          ? t('vehicle.arriving')
                          : t('vehicle.inMinutes', {
                              count: minutesUntil(finalStop.arrivalSec, simSeconds),
                            })
                      } · ${t('vehicle.stopsLeft', { count: stopsLeft })}`}
                </span>
              </span>
            </>
          )}
          <span className="text-muted-foreground">{t('vehicle.vehicle')}</span>
          <span data-testid="vehicle-type">
            {t(MODE_KEY[vehicle.mode])}
            <span className="text-muted-foreground">
              {' · '}
              {Math.round(vehicle.vehicle.length)} m
            </span>
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-sm text-muted-foreground">
            {stops.length > 0 ? t('vehicle.stops') : t('vehicle.nextStop')}
          </span>
          {stops.length > 0 ? (
            // Vertical timeline: one dot per stop, each row draws the line
            // segment from its dot down to the next one, and the vehicle
            // marker sits on that segment at its current travel progress
            // (on the dot itself while dwelling). Served stops are dimmed;
            // the destination dot is filled in the line color.
            <ol
              ref={listRef}
              className="scroll-fade-y flex max-h-52 flex-col overflow-y-auto text-sm"
              data-testid="vehicle-trip-stops"
            >
              {stops.map((stop, index) => {
                const isLast = index === stops.length - 1
                const hasMarker = index === markerIndex
                return (
                  <li
                    key={`${index}-${stop.name}`}
                    className="relative"
                    data-vehicle-position={hasMarker ? 'true' : undefined}
                  >
                    <button
                      type="button"
                      className="-mx-1 flex w-full cursor-pointer gap-2 rounded-md px-1 text-left transition-colors hover:bg-accent/60"
                      aria-label={t('vehicle.flyToStop', { name: stop.name })}
                      onClick={() => onFlyToStop(stop)}
                    >
                      <span className="relative flex w-3 shrink-0 justify-center" aria-hidden>
                        {/* Segment to the next stop (dot center to dot center) */}
                        {!isLast && (
                          <span className="absolute -bottom-2.5 left-1/2 top-2.5 w-0.5 -translate-x-1/2 bg-border" />
                        )}
                        <span
                          className={`relative mt-[5px] size-2.5 rounded-full border-2 bg-card ${
                            stop.passed && !hasMarker ? 'opacity-40' : ''
                          }`}
                          style={{
                            borderColor: vehicle.color,
                            backgroundColor: isLast ? vehicle.color : undefined,
                          }}
                        />
                        {hasMarker && (
                          <span
                            data-testid="vehicle-position"
                            className="absolute left-1/2 z-10 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
                            style={{
                              top: `calc(${markerFraction * 100}% + 0.625rem)`,
                              backgroundColor: vehicle.color,
                            }}
                          />
                        )}
                      </span>
                      <span
                        className={`flex min-w-0 items-baseline gap-2 pb-2 ${
                          stop.passed ? 'opacity-50' : ''
                        }`}
                      >
                        <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                          {formatArrival(stop.arrivalSec)}
                        </span>
                        <span
                          className="truncate"
                          data-testid={index === nextIndex ? 'vehicle-next-stop' : undefined}
                        >
                          {stop.name}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ol>
          ) : (
            // No timetable window (edge case) – at least name the next stop
            <span className="text-sm" data-testid="vehicle-next-stop">
              {vehicle.nextStopName}
            </span>
          )}
        </div>
        {interchange.length > 0 && interchangeStop && (
          <div className="flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">
              {t('vehicle.interchange', { name: interchangeStop.name })}
            </span>
            <div className="flex flex-wrap gap-1" data-testid="vehicle-interchange">
              {interchange.map((line) => (
                <span
                  key={line.id}
                  className="inline-flex h-5 min-w-5 items-center justify-center rounded px-1.5 text-xs font-semibold text-white"
                  style={{ backgroundColor: line.color }}
                >
                  {line.id}
                </span>
              ))}
            </div>
          </div>
        )}
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
