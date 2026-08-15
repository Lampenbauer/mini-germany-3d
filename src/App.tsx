import { useCallback, useEffect, useRef, useState } from 'react'
import { ControlPanel, type LineToggleInfo } from '@/components/ControlPanel'
import { TramCard } from '@/components/TramCard'
import { config } from '@/config'
import { loadBundledNetwork } from '@/data/network'
import type { PreparedNetwork } from '@/data/network-types'
import schedule from '@/data/schedule.json'
import { Simulation, type TramSnapshot } from '@/engine/simulation'
import { parseTimeOfDay, SimClock } from '@/lib/clock'
import type { ScheduleJson } from '@/lib/timetable'
import { CesiumMap, type TilesetStatus } from '@/map/CesiumMap'

/** Debug-/Test-API, die die E2E-Tests unter window.__mrt verwenden. */
export interface MrtTestApi {
  ready: boolean
  tramCount: () => number
  visibleTramCount: () => number
  trams: () => TramSnapshot[]
  setTime: (hhmm: string) => void
  setSpeed: (speed: number) => void
  setPaused: (paused: boolean) => void
  selectTram: (id: string | null) => void
  dataSource: string
}

declare global {
  interface Window {
    __mrt?: MrtTestApi
  }
}

interface UrlOptions {
  offline: boolean
  speed: number
  paused: boolean
  timeSec: number | null
}

function readUrlOptions(): UrlOptions {
  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get('speed') ?? config.simulation.initialSpeed)
  return {
    offline: params.get('offline') === '1',
    speed: Number.isFinite(speed) ? Math.min(600, Math.max(1, speed)) : 1,
    paused: params.get('paused') === '1',
    timeSec: params.get('time') ? parseTimeOfDay(params.get('time')!) : null,
  }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<CesiumMap | null>(null)
  const simRef = useRef<Simulation | null>(null)
  const networkRef = useRef<PreparedNetwork | null>(null)
  const visibleLinesRef = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string | null>(null)
  const followingRef = useRef(false)
  const snapshotsRef = useRef<TramSnapshot[]>([])

  const [visibleLines, setVisibleLines] = useState<Set<string>>(new Set())
  const [showRoutes, setShowRoutes] = useState(true)
  const [showStops, setShowStops] = useState(true)
  const [speed, setSpeed] = useState<number>(config.simulation.initialSpeed)
  const [paused, setPaused] = useState(false)
  const [clockText, setClockText] = useState('--:--:--')
  const [tramCount, setTramCount] = useState(0)
  const [tilesetStatus, setTilesetStatus] = useState<TilesetStatus>('loading')
  const [selected, setSelected] = useState<TramSnapshot | null>(null)
  const [following, setFollowing] = useState(false)

  const network = networkRef.current ?? (networkRef.current = loadBundledNetwork())
  const showRoutesRef = useRef(showRoutes)

  const applyRouteVisibility = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    for (const line of network.lines) {
      map.setLineRouteVisible(line.id, showRoutesRef.current && visibleLinesRef.current.has(line.id))
    }
  }, [network])

  const selectTram = useCallback((id: string | null) => {
    selectedIdRef.current = id
    const map = mapRef.current
    map?.setSelected(id)
    if (!id) {
      setSelected(null)
      if (followingRef.current) {
        followingRef.current = false
        setFollowing(false)
        map?.setFollow(null)
      }
      return
    }
    const snap = snapshotsRef.current.find((s) => s.id === id) ?? null
    setSelected(snap)
    if (followingRef.current) map?.setFollow(id)
  }, [])

  // Initialisierung: Karte, Simulation, Render-Schleife
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const urlOpts = readUrlOptions()
    const clock = new SimClock(Date.now(), urlOpts.speed)
    if (urlOpts.timeSec !== null) clock.setSecondsOfDay(urlOpts.timeSec)
    if (urlOpts.paused) clock.setPaused(true)
    setSpeed(urlOpts.speed)
    setPaused(urlOpts.paused)

    const sim = new Simulation(network, clock, schedule as ScheduleJson)
    simRef.current = sim

    const allLines = new Set(network.lines.map((l) => l.id))
    visibleLinesRef.current = allLines
    setVisibleLines(new Set(allLines))

    const map = new CesiumMap(container, {
      offline: urlOpts.offline,
      onSelectTram: selectTram,
      onTilesetStatus: setTilesetStatus,
    })
    mapRef.current = map
    map.addRoutes(network)
    map.addStops(network)

    let rafId = 0
    let lastUiUpdate = 0
    const loop = (now: number) => {
      const snapshots = sim.snapshots()
      snapshotsRef.current = snapshots
      map.syncTrams(snapshots, visibleLinesRef.current)

      // UI-State nur ~4×/Sekunde aktualisieren, nicht in jedem Frame
      if (now - lastUiUpdate > 250) {
        lastUiUpdate = now
        setClockText(clock.formatted())
        setTramCount(snapshots.filter((s) => visibleLinesRef.current.has(s.lineId)).length)
        const selId = selectedIdRef.current
        if (selId) {
          const snap = snapshots.find((s) => s.id === selId) ?? null
          if (!snap) {
            // Fahrt beendet → Auswahl auflösen
            selectTram(null)
          } else {
            setSelected(snap)
          }
        }
      }
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    // Test-/Debug-API
    const api: MrtTestApi = {
      ready: true,
      tramCount: () => snapshotsRef.current.length,
      visibleTramCount: () =>
        snapshotsRef.current.filter((s) => visibleLinesRef.current.has(s.lineId)).length,
      trams: () => snapshotsRef.current,
      setTime: (hhmm: string) => {
        const sec = parseTimeOfDay(hhmm)
        if (sec !== null) clock.setSecondsOfDay(sec)
      },
      setSpeed: (s: number) => clock.setSpeed(s),
      setPaused: (p: boolean) => clock.setPaused(p),
      selectTram,
      dataSource: network.meta.source,
    }
    window.__mrt = api

    return () => {
      cancelAnimationFrame(rafId)
      window.__mrt = undefined
      map.destroy()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleToggleLine = useCallback(
    (lineId: string) => {
      setVisibleLines((prev) => {
        const next = new Set(prev)
        if (next.has(lineId)) next.delete(lineId)
        else next.add(lineId)
        visibleLinesRef.current = next
        mapRef.current?.setLineRouteVisible(lineId, showRoutesRef.current && next.has(lineId))
        return next
      })
    },
    [],
  )

  const handleToggleRoutes = useCallback(
    (visible: boolean) => {
      showRoutesRef.current = visible
      setShowRoutes(visible)
      applyRouteVisibility()
    },
    [applyRouteVisibility],
  )

  const handleToggleStops = useCallback((visible: boolean) => {
    setShowStops(visible)
    mapRef.current?.setStopsVisible(visible)
  }, [])

  const handleSpeedChange = useCallback((value: number) => {
    setSpeed(value)
    simRef.current?.clock.setSpeed(value)
  }, [])

  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      simRef.current?.clock.setPaused(!prev)
      return !prev
    })
  }, [])

  const handleToggleFollow = useCallback(() => {
    const id = selectedIdRef.current
    if (!id) return
    const next = !followingRef.current
    followingRef.current = next
    setFollowing(next)
    mapRef.current?.setFollow(next ? id : null)
  }, [])

  const handleResetCamera = useCallback(() => {
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      mapRef.current?.setFollow(null)
    }
    mapRef.current?.setCameraHome(true)
  }, [])

  const lineInfos: LineToggleInfo[] = network.lines.map((line) => ({
    id: line.id,
    name: line.name,
    color: line.color,
    from: line.directions[0].from,
    to: line.directions[0].to,
    visible: visibleLines.has(line.id),
  }))

  const dataSource =
    network.meta.source === 'osm' ? 'OSM-Geometrie' : 'Demo-Daten (approximiert)'

  return (
    <div className="relative h-full w-full overflow-hidden bg-background">
      <div ref={containerRef} className="absolute inset-0" data-testid="cesium-container" />

      <div className="pointer-events-none absolute left-4 top-4 z-10">
        <ControlPanel
          clockText={clockText}
          speed={speed}
          paused={paused}
          onSpeedChange={handleSpeedChange}
          onTogglePause={handleTogglePause}
          lines={lineInfos}
          onToggleLine={handleToggleLine}
          showRoutes={showRoutes}
          onToggleRoutes={handleToggleRoutes}
          showStops={showStops}
          onToggleStops={handleToggleStops}
          tramCount={tramCount}
          tilesetStatus={tilesetStatus}
          dataSource={dataSource}
          onResetCamera={handleResetCamera}
        />
      </div>

      {selected && (
        <div className="pointer-events-none absolute bottom-8 left-4 z-10">
          <TramCard
            tram={selected}
            following={following}
            onToggleFollow={handleToggleFollow}
            onClose={() => selectTram(null)}
          />
        </div>
      )}
    </div>
  )
}
