import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Compass, Home } from 'lucide-react'
import { ControlPanel, type LineToggleInfo } from '@/components/ControlPanel'
import { VehicleCard } from '@/components/VehicleCard'
import { Button } from '@/components/ui/button'
import { config } from '@/config'
import { loadBundledNetwork } from '@/data/network'
import type { PreparedNetwork } from '@/data/network-types'
import schedule from '@/data/schedule.json'
import { Simulation, type TramSnapshot } from '@/engine/simulation'
import { formatCameraHash, parseCameraHash, parseVehicleHash } from '@/lib/camera-hash'
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
  /**
   * Tile memory diagnostics: whether Cesium's memory ratchet is currently
   * degrading the LOD (effectiveSse > configuredSse means yes).
   */
  tileMemory: () => {
    usedMB: number
    cacheMB: number
    configuredSse: number
    effectiveSse: number
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
  /** Tile LOD budget override in drawing-buffer pixels (debug, ?sse=12). */
  maximumScreenSpaceError: number | undefined
}

/** Delay of the URL update after the camera settled (moveEnd) in ms. */
const HASH_DEBOUNCE_MS = 300

/**
 * Throttle between URL updates while the camera keeps moving (drags,
 * flights, chase cam) in ms. Also keeps Safari's replaceState rate limit
 * (~100 calls per 30 s) far away.
 */
const HASH_MAX_WAIT_MS = 2000

function readUrlOptions(): UrlOptions {
  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get('speed') ?? config.simulation.initialSpeed)
  const groundHeightRaw = params.get('groundHeight')
  const groundHeight = groundHeightRaw === null ? NaN : Number(groundHeightRaw)
  const sseRaw = params.get('sse')
  const sse = sseRaw === null ? NaN : Number(sseRaw)
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
    maximumScreenSpaceError: Number.isFinite(sse) && sse >= 1 && sse <= 128 ? sse : undefined,
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
  /** Set by the init effect – selection changes write the URL immediately. */
  const writeHashRef = useRef<() => void>(() => {})

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
  // Top-down view (pitch ≈ -90°)? Drives the 2D/3D toggle button's face.
  const [cameraIs2D, setCameraIs2D] = useState(false)

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
    // Selection is a discrete event – the shareable URL updates immediately
    writeHashRef.current()
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
      // Delay data changes slowly; polling every 2 minutes keeps the load
      // on the shared endpoint low (the server caches upstream for 60 s).
      realtimeClient.start(120_000)
    }

    const allLines = new Set(network.lines.map((l) => l.id))
    visibleLinesRef.current = allLines
    setVisibleLines(new Set(allLines))

    // Event-driven URL persistence: camera events debounce into one write
    // shortly after the pose settles; during sustained motion (flights,
    // chase cam) at most one write per HASH_MAX_WAIT_MS lands. replaceState
    // keeps the browser history clean. An idle map costs nothing – there is
    // no polling timer.
    let hashTimeout = 0
    let lastHashWriteAt = -Infinity
    const writeHash = () => {
      window.clearTimeout(hashTimeout)
      hashTimeout = 0
      const m = mapRef.current
      if (!m) return
      lastHashWriteAt = performance.now()
      const hash = formatCameraHash(m.getCameraView(), selectedIdRef.current)
      if (hash !== window.location.hash) {
        window.history.replaceState(null, '', hash)
      }
    }
    const scheduleHashWrite = (settled: boolean) => {
      if (settled) {
        // Movement over (camera.moveEnd) – one final write shortly after
        window.clearTimeout(hashTimeout)
        hashTimeout = window.setTimeout(writeHash, HASH_DEBOUNCE_MS)
        return
      }
      // Still moving: throttle. A plain trailing debounce fires mid-gesture
      // whenever slow rendering stretches the frame gaps beyond the
      // debounce, so the pending write is aimed at the throttle boundary.
      const since = performance.now() - lastHashWriteAt
      if (since >= HASH_MAX_WAIT_MS) {
        writeHash()
        return
      }
      window.clearTimeout(hashTimeout)
      hashTimeout = window.setTimeout(writeHash, HASH_MAX_WAIT_MS - since)
    }
    writeHashRef.current = writeHash
    // The last state must still land in the URL when the tab goes away
    window.addEventListener('pagehide', writeHash)

    const map = new CesiumMap(container, {
      offline: urlOpts.offline,
      fixedGroundHeight: urlOpts.groundHeight,
      maximumScreenSpaceError: urlOpts.maximumScreenSpaceError,
      onSelectTram: selectTram,
      onTilesetStatus: setTilesetStatus,
      onCameraChanged: scheduleHashWrite,
    })
    mapRef.current = map
    // Restore the saved camera orientation from the URL hash
    const hashView = parseCameraHash(window.location.hash)
    if (hashView) map.setView(hashView)
    map.addRoutes(network)
    map.addStops(network)

    // A vehicle selection shared via the URL (&vehicle=…) is restored as
    // soon as its trip shows up in the snapshots – it may take a moment
    // for the simulation to have it, and it may never appear (link opened
    // while the trip is not active), so the attempt expires silently.
    let pendingSharedVehicle = parseVehicleHash(window.location.hash)
    const sharedVehicleDeadline = performance.now() + 20_000

    // First write right away: a camera that never moves after boot fires no
    // change event (the first rendered frame establishes the baseline), yet
    // the URL must be shareable immediately.
    writeHash()

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

            // After syncTrams, so the selection highlight finds the tram
            // record (setSelected only marks records that already exist).
            if (pendingSharedVehicle) {
              if (snapshots.some((s) => s.id === pendingSharedVehicle)) {
                selectTram(pendingSharedVehicle)
                pendingSharedVehicle = null
              } else if (now > sharedVehicleDeadline) {
                pendingSharedVehicle = null
              }
            }

            // Update UI state only ~4×/second, not every frame
            if (now - lastUiUpdate > 250) {
              lastUiUpdate = now
              setClockText(clock.formatted())
              setCameraIs2D(map.getCameraView().pitch < -85)
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
          //   interaction/camera flight → ~60 fps (15 ms threshold: one
          //   16.7 ms display frame plus ~2 ms vsync-jitter margin, so the
          //   gate does not flip-flop between 60 and 30)
          //   vehicles visibly moving → ~30 fps
          //   only tiles streaming in → ~30 fps as well: the tile
          //   traversal (selecting, requesting, and swapping in loaded
          //   tiles) only advances once per rendered frame, and an LOD
          //   refinement is a cascade of several such rounds – at the
          //   previous 4 fps each round cost 250 ms and freshly loaded
          //   tiles visibly appeared seconds late after zooming. The
          //   streaming phase lasts a few seconds at most, then the idle
          //   states below take over again.
          //   otherwise → event-driven: one-off scene changes request a
          //   frame via CesiumMap.requestRender(); apart from that only a
          //   slow heartbeat runs. A truly idle map renders nothing – even
          //   a cheap 1 fps keep-alive kept macOS GPU monitoring at ~30 %,
          //   because the utilization gauge counts any periodic activity.
          const hints = map.getRenderHints?.() ?? { interacting: true, tilesLoading: false }
          const animating = lastAnyTramInView && !clock.paused
          const renderInterval = hints.interacting
            ? 15
            : animating || hints.tilesLoading
              ? 33
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
      tileMemory: () => map.getTileMemoryInfo(),
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
      window.removeEventListener('pagehide', writeHash)
      window.clearTimeout(hashTimeout)
      writeHashRef.current = () => {}
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
        // Stops no shown line serves disappear along with their lines
        mapRef.current?.setVisibleLines(next)
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
        mapRef.current?.setVisibleLines(next)
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

  /** Toggle between the tilted 3D view (pitch -60°) and top-down 2D (-90°). */
  const handleToggleViewMode = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      map.setFollow(null)
    }
    const is2D = map.getCameraView().pitch < -85
    map.setCameraOrientation({ pitchDeg: is2D ? -60 : -90 })
    setCameraIs2D(!is2D)
  }, [])

  const handleFaceNorth = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      map.setFollow(null)
    }
    map.setCameraOrientation({ headingDeg: 0 })
  }, [])

  /** Fly the camera to a line's route (keeps the compass heading). */
  const handleFocusLine = useCallback(
    (lineId: string) => {
      // Zooming to a hidden line implies wanting to see it – switch it
      // back on exactly like its toggle would (routes, stops, vehicles).
      if (!visibleLinesRef.current.has(lineId)) {
        handleSetLinesVisible([lineId], true)
      }
      if (followingRef.current) {
        followingRef.current = false
        setFollowing(false)
        mapRef.current?.setFollow(null)
      }
      mapRef.current?.focusLine(lineId)
    },
    [handleSetLinesVisible],
  )

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
        />
      </div>

      {selected && (
        <div className="pointer-events-none absolute right-4 top-4 z-10">
          <VehicleCard
            tram={selected}
            following={following}
            onToggleFollow={handleToggleFollow}
            onClose={() => selectTram(null)}
          />
        </div>
      )}

      {/* Map controls: 2D/3D, face north, camera reset. bottom-8 keeps them
          clear of the Cesium attribution line at the lower screen edge. */}
      <div className="pointer-events-none absolute bottom-8 right-4 z-10 flex flex-col gap-2">
        <Button
          variant="secondary"
          size="icon"
          className="pointer-events-auto border border-border/60 bg-card/85 font-bold backdrop-blur-md"
          title={cameraIs2D ? 'Switch to 3D view' : 'Switch to 2D view'}
          aria-label={cameraIs2D ? 'Switch to 3D view' : 'Switch to 2D view'}
          onClick={handleToggleViewMode}
        >
          {cameraIs2D ? '3D' : '2D'}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="pointer-events-auto border border-border/60 bg-card/85 backdrop-blur-md"
          title="Face north"
          aria-label="Face north"
          onClick={handleFaceNorth}
        >
          <Compass aria-hidden />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          className="pointer-events-auto border border-border/60 bg-card/85 backdrop-blur-md"
          title="Reset camera"
          aria-label="Reset camera"
          onClick={handleResetCamera}
        >
          <Home aria-hidden />
        </Button>
      </div>
    </div>
  )
}
