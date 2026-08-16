import { useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Gauge,
  Home,
  Layers,
  Pause,
  Play,
  RadioTower,
  TimerReset,
  TramFront,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { RealtimeStatus } from '@/lib/realtime'
import type { TilesetStatus } from '@/map/CesiumMap'

export interface LineToggleInfo {
  id: string
  name: string
  color: string
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
  /** Simulationszeit auf "HH:MM" setzen. */
  onSetTime: (hhmm: string) => void
  /** Simulationszeit zurück auf die echte Uhrzeit. */
  onResetTime: () => void
  lines: LineToggleInfo[]
  onToggleLine: (lineId: string) => void
  showRoutes: boolean
  onToggleRoutes: (visible: boolean) => void
  showStops: boolean
  onToggleStops: (visible: boolean) => void
  tramCount: number
  tilesetStatus: TilesetStatus
  dataSource: string
  /** Status des GTFS-Realtime-Feeds (null = deaktiviert). */
  realtimeStatus: RealtimeStatus | null
  onResetCamera: () => void
}

const TILESET_LABEL: Record<TilesetStatus, string> = {
  loading: 'Lade 3D-Kacheln …',
  'google-3d-tiles': 'Google 3D Tiles',
  offline: 'Offline-Modus',
  failed: '3D-Kacheln nicht verfügbar',
}

export function ControlPanel(props: ControlPanelProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <Card className="pointer-events-auto w-80 max-h-[calc(100vh-2rem)] overflow-y-auto border-border/60 bg-card/85 backdrop-blur-md">
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <TramFront className="size-5 text-primary" aria-hidden />
            Mini Rostock 3D
          </CardTitle>
          <CardDescription>Straßenbahnnetz der RSAG – Fahrplansimulation</CardDescription>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? 'Panel ausklappen' : 'Panel einklappen'}
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </Button>
      </CardHeader>

      {!collapsed && (
        <CardContent className="flex flex-col gap-4">
          {/* Uhr + Zeitraffer */}
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
              aria-label={props.paused ? 'Simulation fortsetzen' : 'Simulation pausieren'}
              onClick={props.onTogglePause}
            >
              {props.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            </Button>
          </div>

          {/* Simulationszeit setzen (z.B. auf den Berufsverkehr springen) */}
          <div className="flex items-center gap-2">
            <Input
              type="time"
              aria-label="Simulationszeit setzen"
              className="h-8 flex-1"
              onChange={(e) => {
                if (e.target.value) props.onSetTime(e.target.value)
              }}
            />
            <Button variant="outline" size="sm" onClick={props.onResetTime}>
              <TimerReset aria-hidden />
              Jetzt
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Gauge className="size-4" aria-hidden />
                Zeitraffer
              </span>
              <span className="font-mono tabular-nums" data-testid="speed-value">
                ×{props.speed}
              </span>
            </div>
            <Slider
              aria-label="Zeitraffer"
              min={1}
              max={120}
              step={1}
              value={[props.speed]}
              onValueChange={([v]) => props.onSpeedChange(v)}
            />
          </div>

          <div className="h-px bg-border" role="separator" />

          {/* Linien */}
          <div className="flex flex-col gap-2">
            <div className="text-sm font-medium">Linien</div>
            <ul className="flex flex-col gap-1.5">
              {props.lines.map((line) => (
                <li key={line.id} className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
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
                  </div>
                  <Switch
                    aria-label={`${line.name} anzeigen`}
                    checked={line.visible}
                    onCheckedChange={() => props.onToggleLine(line.id)}
                  />
                </li>
              ))}
            </ul>
          </div>

          <div className="h-px bg-border" role="separator" />

          {/* Ebenen */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Layers className="size-4" aria-hidden />
              Ebenen
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">Routen</span>
              <Switch
                aria-label="Routen anzeigen"
                checked={props.showRoutes}
                onCheckedChange={props.onToggleRoutes}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">Haltestellen</span>
              <Switch
                aria-label="Haltestellen anzeigen"
                checked={props.showStops}
                onCheckedChange={props.onToggleStops}
              />
            </div>
          </div>

          <div className="h-px bg-border" role="separator" />

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary" data-testid="tram-count">
              <TramFront aria-hidden />
              {props.tramCount} {props.tramCount === 1 ? 'Bahn' : 'Bahnen'} unterwegs
            </Badge>
            <Badge variant="outline" data-testid="tileset-status">
              {TILESET_LABEL[props.tilesetStatus]}
            </Badge>
            <Badge variant="outline" data-testid="data-source">
              {props.dataSource}
            </Badge>
            {props.realtimeStatus?.state === 'live' && (
              <Badge variant="secondary" data-testid="rt-status">
                <RadioTower aria-hidden />
                GTFS-RT · {props.realtimeStatus.matchedCount} live
              </Badge>
            )}
          </div>

          <Button variant="outline" size="sm" onClick={props.onResetCamera}>
            <Home aria-hidden />
            Kamera zurücksetzen
          </Button>
        </CardContent>
      )}
    </Card>
  )
}
