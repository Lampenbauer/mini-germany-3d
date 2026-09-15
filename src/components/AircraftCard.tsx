import { Crosshair, Plane } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CardBody, CardHead, CardShell, EyebrowDot, Stat } from '@/components/card-parts'
import type { Aircraft } from '@/lib/aircraft-extract'
import {
  aircraftTitle,
  aircraftTypeLabel,
  formatAltitude,
  formatGroundSpeed,
  formatVerticalRate,
} from '@/lib/aircraft-info'
import { t } from '@/lib/i18n'
import { formatFixAge } from '@/lib/vessel-info'

/**
 * The selected aircraft, in the ship card's shape: no line, no trip, no
 * timetable – what a transponder says about its aircraft and nothing
 * else. The head is the callsign plate from the map, blue with light
 * text (AircraftLayer, NAME_PLATE): the fourth ground a card wears,
 * after the network's green, the line's colour and the harbour's slate,
 * and like each of those it says which kind of thing was picked before
 * a word is read.
 *
 * Every field can be missing: a light aircraft broadcasts no callsign,
 * an older transponder no geometric altitude, a multilaterated position
 * comes without speed or track – so the card says "not reported" rather
 * than showing a made-up zero, and names an aircraft without a callsign
 * by its registration or, failing that, its address.
 */
export interface AircraftCardProps {
  aircraft: Aircraft
  /** The clock the fix age is measured against – the wall clock, or the simulated one for a replayed aircraft. */
  nowMs: number
  /**
   * Whether the aircraft is replayed from the recording rather than live –
   * the eyebrow says so, and the pulse that means "live" stays off.
   */
  recorded?: boolean
  following: boolean
  onToggleFollow: () => void
  onClose: () => void
}

export function AircraftCard({
  aircraft,
  nowMs,
  recorded = false,
  following,
  onToggleFollow,
  onClose,
}: AircraftCardProps) {
  return (
    <CardShell data-testid="aircraft-card">
      <CardHead
        className="bg-blue-800 text-blue-50"
        eyebrow={
          <>
            {/* The pulse says "live", as on the ship card – and a replayed
                aircraft is not live, so its dot stands still */}
            <EyebrowDot className={recorded ? undefined : 'animate-pulse'} />
            {t(recorded ? 'aircraft.recorded' : 'aircraft.live')}
            <span className="font-normal text-blue-300">
              {' · '}
              {formatFixAge(aircraft.positionAt, nowMs)}
            </span>
          </>
        }
        eyebrowClassName="text-blue-200"
        title={
          <>
            <Plane className="size-5 shrink-0 text-blue-300" aria-hidden />
            <span className="truncate" data-testid="aircraft-name">
              {aircraftTitle(aircraft)}
            </span>
          </>
        }
        // Type, registration and the address in one line – the registration
        // only where it differs from the title, or a club aircraft would
        // read its own name twice
        lead={
          <>
            <span data-testid="aircraft-type">{aircraftTypeLabel(aircraft)}</span>
            {aircraft.registration && aircraft.registration !== aircraftTitle(aircraft) && (
              <>
                {' · '}
                <span className="whitespace-nowrap" data-testid="aircraft-registration">
                  {aircraft.registration}
                </span>
              </>
            )}
            {' · '}
            <span className="whitespace-nowrap font-mono text-[0.95em] uppercase" data-testid="aircraft-hex">
              {t('aircraft.icao')} {aircraft.hex}
            </span>
            {aircraft.source === 'mlat' && (
              <>
                {' · '}
                <span data-testid="aircraft-mlat">{t('aircraft.mlat')}</span>
              </>
            )}
          </>
        }
        leadClassName="text-blue-200"
        closeLabel={t('vehicle.close')}
        onClose={onClose}
      />

      <CardBody>
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label={t('aircraft.altitude')}
            value={formatAltitude(aircraft)}
            muted={!aircraft.onGround && aircraft.altGeomM === null && aircraft.altBaroM === null}
            testId="aircraft-altitude"
          />
          <Stat
            label={t('aircraft.groundSpeed')}
            value={formatGroundSpeed(aircraft.gsKn)}
            muted={aircraft.gsKn === null}
            testId="aircraft-speed"
          />
          <Stat
            label={t('aircraft.verticalRate')}
            value={aircraft.onGround ? t('aircraft.onGround') : formatVerticalRate(aircraft.verticalRateMps)}
            muted={aircraft.onGround || aircraft.verticalRateMps === null}
            testId="aircraft-climb"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant={following ? 'default' : 'outline'} size="sm" onClick={onToggleFollow}>
            <Crosshair aria-hidden />
            {following ? t('follow.stop') : t('follow.aircraft')}
          </Button>
        </div>
      </CardBody>
    </CardShell>
  )
}
