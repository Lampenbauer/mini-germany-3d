import { memo, useMemo, useState } from 'react'
import {
  Bus,
  ChevronDown,
  ChevronUp,
  Gauge,
  Layers,
  Pause,
  Play,
  RadioTower,
  Ship,
  TimerReset,
  TrainFront,
  TramFront,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TransitMode } from '@/data/network-types'
import { t, type MessageKey } from '@/lib/i18n'
import type { RealtimeStatus } from '@/lib/realtime'
import type { TilesetStatus } from '@/map/CesiumMap'

export interface LineToggleInfo {
  id: string
  name: string
  color: string
  mode: TransitMode
  from: string
  to: string
  visible: boolean
}

export interface ControlPanelProps {
  clockText: string
  speed: number
  paused: boolean
  onSpeedChange: (speed: number) => void
  onTogglePause: () => void
  /** Set the simulation time to "HH:MM". */
  onSetTime: (hhmm: string) => void
  /** Reset the simulation time to the real clock. */
  onResetTime: () => void
  lines: LineToggleInfo[]
  onToggleLine: (lineId: string) => void
  /** Fly the camera to the line's route (click on the line name). */
  onFocusLine: (lineId: string) => void
  /** Alle Linien einer Gruppe auf einmal ein-/ausblenden. */
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
  showRoutes: boolean
  onToggleRoutes: (visible: boolean) => void
  showStops: boolean
  onToggleStops: (visible: boolean) => void
  vehicleCount: number
  tilesetStatus: TilesetStatus
  /** Warning badge for approximated geometry; null = no badge. */
  dataSource: string | null
  /** Status des GTFS-Realtime-Feeds (null = deaktiviert). */
  realtimeStatus: RealtimeStatus | null
}

// The healthy state (google-3d-tiles) shows no badge – only loading and
// degraded states are called out in the panel.
const TILESET_KEY: Record<Exclude<TilesetStatus, 'google-3d-tiles'>, MessageKey> = {
  loading: 'status.loadingTiles',
  offline: 'status.offline',
  failed: 'status.tilesFailed',
}

/** Display order and label keys of the transit-mode groups. */
const MODE_ORDER: TransitMode[] = ['tram', 'train', 'bus', 'ferry']
const MODE_KEY: Record<TransitMode, MessageKey> = {
  tram: 'mode.tram',
  train: 'mode.train',
  bus: 'mode.bus',
  ferry: 'mode.ferry',
}
const MODE_ICON: Record<TransitMode, typeof TramFront> = {
  tram: TramFront,
  train: TrainFront,
  bus: Bus,
  ferry: Ship,
}

/**
 * One transit-mode group of the line list (header only when >1 group).
 * Memoized: the panel re-renders 4×/s for the clock, but the line rows only
 * change when a line is toggled (the `lines` array identity comes from the
 * useMemo in App/ControlPanel).
 */
const LineGroup = memo(function LineGroup(props: {
  mode: TransitMode
  lines: LineToggleInfo[]
  showHeader: boolean
  onToggleLine: (lineId: string) => void
  onFocusLine: (lineId: string) => void
  onSetLinesVisible: (lineIds: string[], visible: boolean) => void
}) {
  const Icon = MODE_ICON[props.mode]
  const allVisible = props.lines.every((l) => l.visible)
  return (
    <div className="flex flex-col gap-1.5 mb-1.5 last:mb-0">
      {props.showHeader && (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Icon className="size-3.5" aria-hidden />
            {t(MODE_KEY[props.mode])}
          </span>
          <Switch
            aria-label={t('lines.showAll', { mode: t(MODE_KEY[props.mode]) })}
            checked={allVisible}
            onCheckedChange={(checked) =>
              props.onSetLinesVisible(
                props.lines.map((l) => l.id),
                checked,
              )
            }
          />
        </div>
      )}
      <ul className="flex flex-col gap-1.5">
        {props.lines.map((line) => (
          <li key={line.id} className="flex items-center justify-between gap-2">
            {/* Delayed so scanning the list does not pop a tooltip per row */}
            <Tooltip delayDuration={500}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="-mx-1 flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-accent/60"
                  aria-label={t('lines.zoomTo', { name: line.name })}
                  onClick={() => props.onFocusLine(line.id)}
                >
                  <span
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
                    style={{ backgroundColor: line.color }}
                    aria-hidden
                  >
                    {line.id}
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-sm leading-tight">{line.name}</div>
                    <div className="truncate text-xs leading-tight text-muted-foreground">
                      {line.from} ↔ {line.to}
                    </div>
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t('lines.zoomTo', { name: line.name })}
              </TooltipContent>
            </Tooltip>
            <Switch
              aria-label={t('lines.show', { name: line.name })}
              checked={line.visible}
              onCheckedChange={() => props.onToggleLine(line.id)}
            />
          </li>
        ))}
      </ul>
    </div>
  )
})

export function ControlPanel(props: ControlPanelProps) {
  const [collapsed, setCollapsed] = useState(false)

  // Stable group arrays so the memoized LineGroups skip the clock re-renders
  const lineGroups = useMemo(() => {
    return MODE_ORDER.map((mode) => ({
      mode,
      lines: props.lines.filter((l) => l.mode === mode),
    })).filter((g) => g.lines.length > 0)
  }, [props.lines])

  return (
    // max-h leaves ~2.5rem below the panel so it cannot cover the Cesium
    // attribution line at the bottom edge of the map
    <Card className="pointer-events-auto w-80 max-h-[calc(100vh-3.5rem)] overflow-y-auto border-border/60 bg-card/85 backdrop-blur-md">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <TramFront className="size-5 text-primary" aria-hidden />
          Mini Rostock 3D
        </CardTitle>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? t('panel.expand') : t('panel.collapse')}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Clock + pause: also visible while the panel is collapsed */}
        <div className="flex items-center justify-between gap-2">
          <div
            className="font-mono text-2xl font-semibold tabular-nums"
            data-testid="sim-clock"
          >
            {props.clockText}
          </div>
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={props.paused ? t('sim.resume') : t('sim.pause')}
            onClick={props.onTogglePause}
          >
            {props.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
          </Button>
        </div>

        {!collapsed && (
          <>
            {/* Set the simulation time (e.g. jump to rush hour). The field is
                picker-only: typing is blocked and a click anywhere on it opens
                the native time dropdown, so no invalid input can be entered. */}
            <div className="flex items-center gap-2">
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <Input
                    type="time"
                    aria-label={t('sim.setTime')}
                    className="h-8 flex-1 cursor-pointer [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                    inputMode="none"
                    onKeyDown={(e) => {
                      // Only block typing where the picker can take over
                      if (
                        'showPicker' in e.currentTarget &&
                        e.key !== 'Tab' &&
                        e.key !== 'Escape' &&
                        e.key !== 'Enter'
                      ) {
                        e.preventDefault()
                      }
                    }}
                    onClick={(e) => {
                      // Not supported by every browser (Safari < 16) – typing
                      // into the field parts still works as the fallback there.
                      try {
                        e.currentTarget.showPicker()
                      } catch {
                        /* picker already open or unsupported */
                      }
                    }}
                    onChange={(e) => {
                      if (e.target.value) props.onSetTime(e.target.value)
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent side="top">{t('sim.setTime')}</TooltipContent>
              </Tooltip>
              <Button variant="outline" size="sm" onClick={props.onResetTime}>
                <TimerReset aria-hidden />
                {t('sim.now')}
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Gauge className="size-4" aria-hidden />
                  {t('sim.timeLapse')}
                </span>
                <span className="font-mono tabular-nums" data-testid="speed-value">
                  ×{props.speed}
                </span>
              </div>
              <Slider
                aria-label={t('sim.timeLapse')}
                min={1}
                max={120}
                step={1}
                value={[props.speed]}
                onValueChange={([v]) => props.onSpeedChange(v)}
              />
            </div>

            <div className="h-px bg-border" role="separator" />

            {/* Layers */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Layers className="size-4" aria-hidden />
                {t('layers.title')}
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('layers.routes')}</span>
                <Switch
                  aria-label={t('layers.showRoutes')}
                  checked={props.showRoutes}
                  onCheckedChange={props.onToggleRoutes}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">{t('layers.stops')}</span>
                <Switch
                  aria-label={t('layers.showStops')}
                  checked={props.showStops}
                  onCheckedChange={props.onToggleStops}
                />
              </div>
            </div>

            <div className="h-px bg-border" role="separator" />

            {/* Lines, grouped by transit mode (headers only when >1 group) */}
            <div className="flex flex-col gap-2">
              <div className="text-sm font-medium">{t('lines.title')}</div>
              {lineGroups.map((g) => (
                <LineGroup
                  key={g.mode}
                  mode={g.mode}
                  lines={g.lines}
                  showHeader={lineGroups.length > 1}
                  onToggleLine={props.onToggleLine}
                  onFocusLine={props.onFocusLine}
                  onSetLinesVisible={props.onSetLinesVisible}
                />
              ))}
            </div>

            <div className="h-px bg-border" role="separator" />

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" data-testid="vehicle-count">
                <TramFront aria-hidden />
                {new Set(props.lines.map((l) => l.mode)).size > 1
                  ? t(props.vehicleCount === 1 ? 'count.vehicle' : 'count.vehicles', {
                      count: props.vehicleCount,
                    })
                  : t(props.vehicleCount === 1 ? 'count.tram' : 'count.trams', {
                      count: props.vehicleCount,
                    })}
              </Badge>
              {props.tilesetStatus !== 'google-3d-tiles' && (
                <Badge variant="outline" data-testid="tileset-status">
                  {t(TILESET_KEY[props.tilesetStatus])}
                </Badge>
              )}
              {props.dataSource !== null && (
                <Badge variant="outline" data-testid="data-source">
                  {props.dataSource}
                </Badge>
              )}
              {props.realtimeStatus?.state === 'live' && (
                <Badge variant="secondary" data-testid="rt-status">
                  <RadioTower aria-hidden />
                  {t('rt.live', { count: props.realtimeStatus.matchedCount })}
                </Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
