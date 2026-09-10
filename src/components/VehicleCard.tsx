import { useEffect, useRef } from 'react'
import { ArrowRight, Crosshair } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ScrollArea } from '@/components/ui/scroll-area'
import { CARD_SHELL, CardHead, LineChip, SectionLabel, Stat, headInk, lineChipClass } from '@/components/card-parts'
import { MODE_ICON } from '@/components/mode-icon'
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
  /**
   * Click on one of the interchange badges – does what clicking that line
   * in the control panel does: fly to its route and open its card.
   */
  onSelectLine: (lineId: string) => void
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

/**
 * "+3 min" / "-1 min" / "on time" – the compact form for the stop card's
 * departure rows, where the badge sits between a line number and a
 * countdown and has no room to spell anything out.
 */
export function formatDelay(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return t('vehicle.onTime')
  const minutes = Math.round(delaySeconds / 60)
  return `${minutes > 0 ? '+' : ''}${minutes} min`
}

/**
 * The same fact in words, for the vehicle card, which has the room: "3 min
 * late" / "1 min early" / "on time". Early is not a theoretical case – the
 * DELFI feed reports it for a few percent of trips, in whole minutes like
 * every other value it carries.
 */
export function formatDelayLong(delaySeconds: number): string {
  if (Math.abs(delaySeconds) < 60) return t('vehicle.onTime')
  const minutes = Math.abs(Math.round(delaySeconds / 60))
  return delaySeconds > 0 ? t('vehicle.late', { count: minutes }) : t('vehicle.early', { count: minutes })
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
  subway: 'follow.subway',
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
  onSelectLine,
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
  // the list keeps the user's scroll position afterwards. The list's own
  // viewport is scrolled, not the marker brought into view: scrollIntoView
  // scrolls every scrollable ancestor too, and on a phone the card itself
  // is one (CARD_SHELL) – it went to the marker and took its head along.
  const listRef = useRef<HTMLOListElement | null>(null)
  useEffect(() => {
    const marker = listRef.current?.querySelector<HTMLElement>('[data-vehicle-position]')
    const viewport = marker?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')
    if (!marker || !viewport) return
    const markerRect = marker.getBoundingClientRect()
    const viewportRect = viewport.getBoundingClientRect()
    viewport.scrollTop +=
      markerRect.top - viewportRect.top - viewport.clientHeight / 2 + markerRect.height / 2
  }, [vehicle.id])

  const ModeIcon = MODE_ICON[vehicle.mode]
  const ink = headInk(vehicle.color)
  return (
    <Card
      className={CARD_SHELL}
      data-testid="vehicle-card"
    >
      {/* The line's colour as the head, the way the vehicle wears it on
          the map; the ink follows the colour's lightness (headInk) and
          the number inverts to it with the colour as its own ink. */}
      <CardHead
        className={ink.text}
        style={{ backgroundColor: vehicle.color }}
        eyebrow={
          <span className="flex items-center gap-1.5">
            <ModeIcon className="size-3.5" aria-hidden />
            {t(MODE_KEY[vehicle.mode])}
            <span className={`font-normal ${ink.dim}`}>{' · '}{vehicle.lineName}</span>
          </span>
        }
        eyebrowClassName={ink.muted}
        title={
          <>
            <LineChip id={vehicle.lineId} color={vehicle.color} size="lg" inverted />
            <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-pretty">
              {vehicle.origin}
              <ArrowRight className={`size-4 shrink-0 ${ink.dim}`} aria-hidden />
              {vehicle.destination}
            </span>
          </>
        }
        titleClassName="items-center text-xl"
        lead={
          <>
            <span data-testid="vehicle-status">{statusText(vehicle)}</span>
            {' · '}
            {vehicle.realtime ? (
              <span data-testid="vehicle-delay">{formatDelayLong(vehicle.delaySeconds)}</span>
            ) : (
              <span>{t('vehicle.onSchedule')}</span>
            )}
          </>
        }
        leadClassName={ink.muted}
        closeLabel={t('vehicle.close')}
        onClose={onClose}
      />

      <CardContent className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="grid grid-cols-2 gap-2">
          {/* Arrival at the destination: the value is already in the list
              (delay applied), just buried at its bottom – this lifts it
              into the summary. */}
          {finalStop && (
            <Stat
              label={t('vehicle.arrival')}
              value={formatArrival(finalStop.arrivalSec)}
              note={
                stopsLeft === 0
                  ? t('vehicle.lastStop')
                  : `${
                      minutesUntil(finalStop.arrivalSec, simSeconds) < 1
                        ? t('vehicle.arriving')
                        : t('vehicle.inMinutes', {
                            count: minutesUntil(finalStop.arrivalSec, simSeconds),
                          })
                    } · ${t('vehicle.stopsLeft', { count: stopsLeft })}`
              }
              testId="vehicle-arrival"
            />
          )}
          <Stat
            label={t('vehicle.vehicle')}
            value={t(MODE_KEY[vehicle.mode])}
            note={`${Math.round(vehicle.vehicle.length)} m`}
            testId="vehicle-type"
          />
        </div>

        <div className="flex flex-col gap-1">
          <SectionLabel>{stops.length > 0 ? t('vehicle.stops') : t('vehicle.nextStop')}</SectionLabel>
          {stops.length > 0 ? (
            // Vertical timeline: one dot per stop, each row draws the line
            // segment from its dot down to the next one, and the vehicle
            // marker sits on that segment at its current travel progress
            // (on the dot itself while dwelling). Served stops are dimmed;
            // the destination dot is filled in the line color.
            <ScrollArea
              className="max-h-52"
              viewportClassName="scroll-fade-y"
              data-testid="vehicle-trip-stops"
            >
              <ol ref={listRef} className="flex flex-col text-sm">
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
                        className="-mx-1 flex w-full cursor-pointer gap-2 rounded-md px-1 text-left transition-colors hover:bg-accent"
                        aria-label={t('vehicle.flyToStop', { name: stop.name })}
                        title={t('vehicle.flyToThisStop')}
                        onClick={() => onFlyToStop(stop)}
                      >
                        <span className="relative flex w-3 shrink-0 justify-center" aria-hidden>
                          {/* Segment to the next stop (dot center to dot center) */}
                          {!isLast && (
                            <span className="absolute -bottom-2.5 left-1/2 top-2.5 w-0.5 -translate-x-1/2 bg-border" />
                          )}
                          <span
                            className={`relative mt-1.25 size-2.5 rounded-full border-2 bg-card ${
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
                              // Ringed in the same white the line diagram rings
                              // its vehicle dots with (LinearView.sync), so a
                              // vehicle reads the same mark in both readings.
                              className="absolute left-1/2 z-10 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[oklch(0.9842_0.0034_247.86)]"
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
            </ScrollArea>
          ) : (
            // No timetable window (edge case) – at least name the next stop
            <span className="text-sm" data-testid="vehicle-next-stop">
              {vehicle.nextStopName}
            </span>
          )}
        </div>

        {interchange.length > 0 && interchangeStop && (
          <div className="flex flex-col gap-1">
            <SectionLabel>{t('vehicle.interchange', { name: interchangeStop.name })}</SectionLabel>
            <div className="flex flex-wrap gap-1" data-testid="vehicle-interchange">
              {interchange.map((line) => (
                <button
                  key={line.id}
                  type="button"
                  className={`${lineChipClass()} cursor-pointer transition-opacity hover:opacity-80`}
                  style={{ backgroundColor: line.color }}
                  aria-label={t('lines.flyTo', { name: line.id })}
                  title={t('lines.flyTo', { name: line.id })}
                  onClick={() => onSelectLine(line.id)}
                >
                  {line.id}
                </button>
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
        </div>
      </CardContent>
    </Card>
  )
}
