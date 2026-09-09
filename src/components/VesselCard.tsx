import { Crosshair, Ship } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CardHead, EyebrowDot, Stat } from '@/components/card-parts'
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
 * The selected AIS ship, in the vehicle card's shell but not its clothes:
 * a ship has none of what the vehicle card is built around – no line, no
 * trip, no timetable of stops – and everything it does have (the static
 * report and the navigational status) the vehicle card has no place for.
 *
 * The head is the ship's name plate from the map, dark slate with light
 * text (VesselLayer, NAME_PLATE): on the map a dark plate on water is how
 * the live fleet is told from the timetabled network, and the card keeps
 * that – the city card wears the network's green, this one the harbour's
 * slate. The eyebrow says where the ship comes from, with the age of her
 * last update, because nothing else on the map ignores the panel's clock.
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
      className="pointer-events-auto w-100 gap-0 overflow-hidden border-border/60 bg-card/85 py-0 backdrop-blur-xl"
      data-testid="vessel-card"
    >
      <CardHead
        className="bg-slate-800 text-slate-50"
        eyebrow={
          <>
            {/* The pulse is the one animation on a card: it says "live"
                where every other figure on the map is the timetable's. */}
            <EyebrowDot className="animate-pulse" />
            {t('vessel.live')}
            <span className="font-normal text-slate-400">
              {' · '}
              {formatFixAge(vessel.positionAt, nowMs)}
            </span>
          </>
        }
        eyebrowClassName="text-slate-300"
        title={
          <>
            <Ship className="size-5 shrink-0 text-slate-400" aria-hidden />
            <span className="truncate" data-testid="vessel-name">
              {vesselTitle(vessel)}
            </span>
          </>
        }
        // Type, status and the MMSI in one line; a Class B transponder
        // sends no status at all and a small craft often no static
        // report, so each says "unknown" with its own name rather than
        // as a bare word twice over.
        lead={
          <>
            <span data-testid="vessel-type">{typeKey ? t(typeKey) : t('vessel.typeUnknown')}</span>
            {' · '}
            <span data-testid="vessel-status">
              {statusKey ? t(statusKey) : t('vessel.statusUnknown')}
            </span>
            {' · '}
            <span className="whitespace-nowrap tabular-nums" data-testid="vessel-mmsi">
              {t('vessel.mmsi')} {vessel.mmsi}
            </span>
          </>
        }
        leadClassName="text-slate-300"
        closeLabel={t('vehicle.close')}
        onClose={onClose}
      />

      <CardContent className="flex flex-col gap-3 px-5 pt-4 pb-4">
        <div className="grid grid-cols-3 gap-2">
          <Stat
            label={t('vessel.speed')}
            value={formatSpeed(vessel.sogKn)}
            muted={vessel.sogKn === null}
            testId="vessel-speed"
          />
          <Stat
            label={t('vessel.dimensions')}
            value={dimensions ?? t('vessel.notReported')}
            muted={dimensions === null}
            testId="vessel-dimensions"
          />
          <Stat
            label={t('vessel.draught')}
            value={draughtM === null ? t('vessel.notReported') : `${draughtM.toFixed(1)} m`}
            muted={draughtM === null}
            testId="vessel-draught"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant={following ? 'default' : 'outline'} size="sm" onClick={onToggleFollow}>
            <Crosshair aria-hidden />
            {following ? t('follow.stop') : t('follow.vessel')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
