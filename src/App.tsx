import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ControlPanel, type LineToggleInfo } from '@/components/ControlPanel'
import { TramCard } from '@/components/TramCard'
import { config } from '@/config'
import { loadBundledNetwork } from '@/data/network'
import type { PreparedNetwork } from '@/data/network-types'
import schedule from '@/data/schedule.json'
import { Simulation, type TramSnapshot } from '@/engine/simulation'
import { formatCameraHash, parseCameraHash } from '@/lib/camera-hash'
import { parseTimeOfDay, SimClock } from '@/lib/clock'
import { RealtimeClient, type RealtimeStatus } from '@/lib/realtime'
import type { ScheduleJson } from '@/lib/timetable'
import { CesiumMap, type TilesetStatus } from '@/map/CesiumMap'

/** Debug/test API that the E2E tests use under window.__mrt. */
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
  lineIds: () => string[]
  secondsOfDay: () => number
  loopTicks: () => number
  lastLoopError: () => string | null
  groundHeights: () => { id: string; groundHeight: number }[]
  anyTramInView: () => boolean
  /** Average render rate over the last 5 seconds (frames/s). */
  renderRate: () => number
  /** Maximum distance between vehicle box and label in meters (must be ~0). */
  tramBoxDriftMeters: () => number
  /** Color-attribute opacity currently applied to one rendered vehicle body. */
  tramOpacity: (id: string) => number | null
  /** Finds a deterministic real trip that crosses a tunnel portal. */
  tunnelTransition: () => {
    id: string
    tunnelTime: number
    surfaceTime: number
  } | null
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
  /** Fixed ground height in meters (debug, skips tile sampling). */
  groundHeight: number | undefined
  /** Force GTFS-Realtime (?rt=1) or disable it (?rt=0); null = auto. */
  realtime: boolean | null
}

function readUrlOptions(): UrlOptions {
  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get('speed') ?? config.simulation.initialSpeed)
  const groundHeightRaw = params.get('groundHeight')
  const groundHeight = groundHeightRaw === null ? NaN : Number(groundHeightRaw)
  return {
    offline: params.get('offline') === '1',
    speed: Number.isFinite(speed) ? Math.min(600, Math.max(1, speed)) : 1,
    paused: params.get('paused') === '1',
    timeSec: params.get('time') ? parseTimeOfDay(params.get('time')!) : null,
    groundHeight:
      Number.isFinite(groundHeight) && groundHeight > -100 && groundHeight < 500
        ? groundHeight
        : undefined,
    realtime: params.get('rt') === '1' ? true : params.get('rt') === '0' ? false : null,
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
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus | null>(null)

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

  // Initialization: map, simulation, render loop
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

    // GTFS-Realtime (delays from the free gtfs.de feed):
    // active by default, except in offline mode; ?rt=1/?rt=0 overrides.
    const realtimeEnabled =
      config.gtfsRealtimeUrl !== '' &&
      import.meta.env.MODE !== 'test' &&
      (urlOpts.realtime ?? !urlOpts.offline)
    let realtimeClient: RealtimeClient | null = null
    if (realtimeEnabled) {
      realtimeClient = new RealtimeClient(
        config.gtfsRealtimeUrl,
        sim.realtimeTripIdMap,
        (status, delays) => {
          sim.setRealtimeDelays(delays)
          setRealtimeStatus(status)
        },
      )
      realtimeClient.start(30_000)
    }

    const allLines = new Set(network.lines.map((l) => l.id))
    visibleLinesRef.current = allLines
    setVisibleLines(new Set(allLines))

    const map = new CesiumMap(container, {
      offline: urlOpts.offline,
      fixedGroundHeight: urlOpts.groundHeight,
      onSelectTram: selectTram,
      onTilesetStatus: setTilesetStatus,
    })
    mapRef.current = map
    // Restore the saved camera orientation from the URL hash
    const hashView = parseCameraHash(window.location.hash)
    if (hashView) map.setView(hashView)
    map.addRoutes(network)
    map.addStops(network)

    // Write the camera orientation to the URL hash every 1500 ms
    const hashTimer = window.setInterval(() => {
      const hash = formatCameraHash(map.getCameraView())
      if (hash !== window.location.hash) {
        window.history.replaceState(null, '', hash)
      }
    }, 1500)

    let rafId = 0
    let lastUiUpdate = 0
    let lastSimTick = 0
    let lastRender = 0
    let lastLightingMs = -Infinity
    let lastAnyTramInView = true
    let loopTicks = 0
    let lastLoopError: string | null = null
    const renderTimes: number[] = []
    const loop = (now: number) => {
      // The loop must not die permanently on a transient error (e.g. Cesium
      // internals while bulk-removing entities) – otherwise the entire
      // simulation freezes.
      try {
        loopTicks++
        if (!document.hidden) {
          // Tick the simulation at ~30 fps max; when paused or with no
          // vehicle in view, 2 fps is plenty.
          const tickInterval = clock.paused || !lastAnyTramInView ? 500 : 33
          if (now - lastSimTick >= tickInterval) {
            lastSimTick = now

            // Scene lighting follows the simulated time in ~1-minute steps:
            // sun position, atmosphere, and the tiles' day/night grading.
            // At real-time speed that is one extra render per minute; jumps
            // (time input, midnight wrap) apply on the next tick.
            const simMs = clock.now()
            if (Math.abs(simMs - lastLightingMs) >= 60_000) {
              lastLightingMs = simMs
              map.setSceneTime(simMs)
            }

            const snapshots = sim.snapshots()
            snapshotsRef.current = snapshots
            const viewInfo = map.syncTrams(snapshots, visibleLinesRef.current)
            lastAnyTramInView = viewInfo?.anyTramInView ?? false

            // Update UI state only ~4×/second, not every frame
            if (now - lastUiUpdate > 250) {
              lastUiUpdate = now
              setClockText(clock.formatted())
              setTramCount(
                snapshots.filter((s) => visibleLinesRef.current.has(s.lineId)).length,
              )
              const selId = selectedIdRef.current
              if (selId) {
                const snap = snapshots.find((s) => s.id === selId) ?? null
                if (!snap) {
                  // Trip ended → clear the selection
                  selectTram(null)
                } else {
                  setSelected(snap)
                }
              }
            }
          }

          // Render pacing (the app owns the Cesium render loop):
          //   interaction/camera flight → full frame rate
          //   vehicles visibly moving → ~30 fps
          //   only tiles streaming in → ~4 fps (enough to drive the tile
          //   traversal without burning GPU on identical frames)
          //   otherwise → event-driven: one-off scene changes request a
          //   frame via CesiumMap.requestRender(); apart from that only a
          //   slow heartbeat runs. A truly idle map renders nothing – even
          //   a cheap 1 fps keep-alive kept macOS GPU monitoring at ~30 %,
          //   because the utilization gauge counts any periodic activity.
          const hints = map.getRenderHints?.() ?? { interacting: true, tilesLoading: false }
          const animating = lastAnyTramInView && !clock.paused
          const renderInterval = hints.interacting
            ? 0
            : animating
              ? 33
              : hints.tilesLoading
                ? 250
                : 15000
          if (map.consumeRenderRequest() || now - lastRender >= renderInterval) {
            lastRender = now
            map.render()
            renderTimes.push(now)
            while (renderTimes.length > 0 && renderTimes[0] < now - 5000) {
              renderTimes.shift()
            }
          }
        }
      } catch (error) {
        const message = String(error)
        if (message !== lastLoopError) {
          lastLoopError = message
          console.error('Render loop error:', error)
        }
      }
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    // Test/debug API
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
      lineIds: () => network.lines.map((l) => l.id),
      secondsOfDay: () => clock.secondsOfDay(),
      loopTicks: () => loopTicks,
      lastLoopError: () => lastLoopError,
      groundHeights: () => map.getGroundHeights(),
      anyTramInView: () => lastAnyTramInView,
      renderRate: () => renderTimes.length / 5,
      tramBoxDriftMeters: () => map.getTramBoxDriftMeters(),
      tramOpacity: (id: string) => map.getTramOpacity(id),
      tunnelTransition: () => {
        // Debug-only probe for E2E: step through service time until the same
        // active trip is found once inside and once outside a tunnel.
        for (let time = 4 * 3600; time < 24 * 3600; time += 30) {
          const inside = sim.snapshotsAt(time).find((snap) => snap.inTunnel)
          if (!inside) continue
          for (const offset of [-120, -60, 60, 120]) {
            const surfaceTime = time + offset
            const outside = sim
              .snapshotsAt(surfaceTime)
              .find((snap) => snap.id === inside.id && !snap.inTunnel)
            if (outside) return { id: inside.id, tunnelTime: time, surfaceTime }
          }
        }
        return null
      },
    }
    window.__mrt = api

    return () => {
      cancelAnimationFrame(rafId)
      window.clearInterval(hashTimer)
      realtimeClient?.stop()
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

  /** Show/hide several lines at once (group switches in the panel). */
  const handleSetLinesVisible = useCallback(
    (lineIds: string[], visible: boolean) => {
      setVisibleLines((prev) => {
        const next = new Set(prev)
        for (const id of lineIds) {
          if (visible) next.add(id)
          else next.delete(id)
          mapRef.current?.setLineRouteVisible(id, showRoutesRef.current && visible)
        }
        visibleLinesRef.current = next
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

  const handleSetTime = useCallback((hhmm: string) => {
    const sec = parseTimeOfDay(hhmm)
    if (sec !== null) simRef.current?.clock.setSecondsOfDay(sec)
  }, [])

  const handleResetTime = useCallback(() => {
    simRef.current?.clock.resetToRealTime()
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

  /** Fly the camera to a line's route (keeps the compass heading). */
  const handleFocusLine = useCallback((lineId: string) => {
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      mapRef.current?.setFollow(null)
    }
    mapRef.current?.focusLine(lineId)
  }, [])

  // Stable across the 4×/s clock re-renders so the memoized line list in the
  // ControlPanel can bail out; only rebuilt when a line is toggled.
  const lineInfos: LineToggleInfo[] = useMemo(
    () =>
      network.lines.map((line) => ({
        id: line.id,
        name: line.name,
        color: line.color,
        mode: line.mode,
        from: line.directions[0].from,
        to: line.directions[0].to,
        visible: visibleLines.has(line.id),
      })),
    [network, visibleLines],
  )

  // Badge only as a warning for approximated geometry; real OSM data (the
  // normal case) needs no callout in the panel.
  const dataSource = network.meta.source === 'osm' ? null : 'Demo data (approximated)'

  const offlineMode =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('offline') === '1'

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-background${offlineMode ? ' panels-opaque' : ''}`}
    >
      <div ref={containerRef} className="absolute inset-0" data-testid="cesium-container" />

      <div className="pointer-events-none absolute left-4 top-4 z-10">
        <ControlPanel
          clockText={clockText}
          speed={speed}
          paused={paused}
          onSpeedChange={handleSpeedChange}
          onTogglePause={handleTogglePause}
          onSetTime={handleSetTime}
          onResetTime={handleResetTime}
          lines={lineInfos}
          onToggleLine={handleToggleLine}
          onFocusLine={handleFocusLine}
          onSetLinesVisible={handleSetLinesVisible}
          showRoutes={showRoutes}
          onToggleRoutes={handleToggleRoutes}
          showStops={showStops}
          onToggleStops={handleToggleStops}
          tramCount={tramCount}
          tilesetStatus={tilesetStatus}
          dataSource={dataSource}
          realtimeStatus={realtimeStatus}
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
