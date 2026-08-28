import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Compass, Home, Layers2, Mountain } from 'lucide-react'
import { ControlPanel, type LineToggleInfo } from '@/components/ControlPanel'
import { VehicleCard } from '@/components/VehicleCard'
import { VesselCard } from '@/components/VesselCard'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { config } from '@/config'
import { cn } from '@/lib/utils'
import { loadBundledNetwork } from '@/data/network'
import type { PreparedNetwork } from '@/data/network-types'
import schedule from '@/data/schedule.json'
import { loadStreetLamps } from '@/data/street-lamps'
import { Simulation, type VehicleSnapshot } from '@/engine/simulation'
import { StopCard, type StopInfo } from '@/components/StopCard'
import {
  formatCameraHash,
  formatStopHash,
  formatUiStateHash,
  formatVehicleHash,
  parseCameraHash,
  parseStopHash,
  parseUiStateHash,
  parseVehicleHash,
} from '@/lib/camera-hash'
import { berlinSecondsOfDay, parseTimeOfDay, SimClock } from '@/lib/clock'
import { isInTunnel } from '@/lib/tunnels'
import { getLanguage, localizeLineName, t } from '@/lib/i18n'
import { buildInterchangeIndex } from '@/lib/interchange'
import { RealtimeClient, type RealtimeStatus } from '@/lib/realtime'
import { AisClient } from '@/lib/ais'
import type { AisVessel } from '@/lib/ais-extract'
import { weatherIsCurrent, WeatherClient } from '@/lib/weather'
import type { ScheduleJson } from '@/lib/timetable'
import { CesiumMap, type TilesetStatus } from '@/map/CesiumMap'

/** Debug/test API that the E2E tests use under window.__mrt. */
export interface MrtTestApi {
  ready: boolean
  vehicleCount: () => number
  visibleVehicleCount: () => number
  vehicles: () => VehicleSnapshot[]
  setTime: (hhmm: string) => void
  setSpeed: (speed: number) => void
  setPaused: (paused: boolean) => void
  /** Injects GTFS-RT delays for tests (sim trip id → seconds). */
  setRealtimeDelays: (delays: Record<string, number>) => void
  /** Forces the rain overlay for tests/previews (mm; 0 = dry again). */
  setRain: (precipitationMm: number) => void
  /** Forces the overcast grade for tests/previews (percent; 0 = clear again). */
  setCloudCover: (cloudCoverPercent: number) => void
  /** Raindrops currently drawn (0 = dry or below ground). */
  rainDropsVisible: () => number
  selectVehicle: (id: string | null) => void
  /** AIS backdrop vessels currently drawn (0 = layer off or no data yet). */
  aisVesselCount: () => number
  selectStop: (id: string | null) => void
  selectedStopId: () => string | null
  /** Trip id of the current selection, null when nothing is selected. */
  selectedVehicleId: () => string | null
  /** Screen position of a vehicle in CSS px (null = off screen/unknown). */
  vehicleScreenPosition: (id: string) => { x: number; y: number } | null
  stopScreenPosition: (id: string) => { x: number; y: number } | null
  dataSource: string
  lineIds: () => string[]
  secondsOfDay: () => number
  loopTicks: () => number
  lastLoopError: () => string | null
  groundHeights: () => { id: string; groundHeight: number }[]
  anyVehicleInView: () => boolean
  /** Street lighting: lamps batched into the scene and their current opacity. */
  streetLamps: () => { drawn: number; alpha: number }
  /** Average render rate over the last 5 seconds (frames/s). */
  renderRate: () => number
  /**
   * Why the render loop is (not) idling – the four inputs of the pacing
   * gate. Diagnosing "the GPU stays busy" is guesswork without them.
   */
  renderPacing: () => {
    animating: boolean
    rainActive: boolean
    vehicleInView: boolean
    /** A vessel whose drawn pose is still changing is on screen. */
    vesselInView: boolean
    interacting: boolean
    tilesLoading: boolean
    intervalMs: number
  }
  /** Maximum distance between vehicle box and label in meters (must be ~0). */
  vehicleBoxDriftMeters: () => number
  /** Color-attribute opacity currently applied to one rendered vehicle body. */
  vehicleOpacity: (id: string) => number | null
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
  /** Live-weather rain overlay (?rain=0 disables it). */
  rain: boolean
  /** false only with ?ais=0 – live AIS vessels are on by default. */
  ais: boolean
  /** Night-time street lighting from OSM lamps (?lamps=0 disables it). */
  lamps: boolean
  /** Tile LOD budget override in drawing-buffer pixels (debug, ?sse=12). */
  maximumScreenSpaceError: number | undefined
  /** Cap on the rain drop pool (?drops=50) – keeps the E2E rain test cheap. */
  maxRainDrops: number | undefined
}

/** Delay of the URL update after the camera settled (moveEnd) in ms. */
const HASH_DEBOUNCE_MS = 300

/**
 * Throttle between URL updates while the camera keeps moving (drags,
 * flights, chase cam) in ms. Also keeps Safari's replaceState rate limit
 * (~100 calls per 30 s) far away.
 */
const HASH_MAX_WAIT_MS = 2000

/**
 * requestAnimationFrame is driven by the compositor: when it stops sending
 * frames – heavy software rendering (SwiftShader on CI), a weak GPU, an
 * occluded window – the callbacks simply stop arriving while the page itself
 * stays responsive. The simulation would then freeze at its last tick even
 * though the (wall-clock based) SimClock keeps running, so vehicles jump the
 * moment frames resume. The watchdog below runs a frame from a timer whenever
 * rAF has not delivered one for this long.
 */
const RAF_STALL_MS = 500

/** Poll interval of that watchdog (a timestamp comparison while rAF is healthy). */
const RAF_WATCHDOG_INTERVAL_MS = 250

function readUrlOptions(): UrlOptions {
  const params = new URLSearchParams(window.location.search)
  const speed = Number(params.get('speed') ?? config.simulation.initialSpeed)
  const groundHeightRaw = params.get('groundHeight')
  const groundHeight = groundHeightRaw === null ? NaN : Number(groundHeightRaw)
  const sseRaw = params.get('sse')
  const sse = sseRaw === null ? NaN : Number(sseRaw)
  const dropsRaw = params.get('drops')
  const drops = dropsRaw === null ? NaN : Number(dropsRaw)
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
    rain: params.get('rain') !== '0',
    ais: params.get('ais') !== '0',
    lamps: params.get('lamps') !== '0',
    maximumScreenSpaceError: Number.isFinite(sse) && sse >= 1 && sse <= 128 ? sse : undefined,
    maxRainDrops: Number.isFinite(drops) && drops >= 1 && drops <= 4000 ? drops : undefined,
  }
}

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<CesiumMap | null>(null)
  const simRef = useRef<Simulation | null>(null)
  const networkRef = useRef<PreparedNetwork | null>(null)
  const visibleLinesRef = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string | null>(null)
  const selectedStopIdRef = useRef<string | null>(null)
  const selectedMmsiRef = useRef<number | null>(null)
  /** Latest AIS list, so a selected ship's card refreshes with the polls. */
  const aisVesselsRef = useRef<AisVessel[]>([])
  const followingRef = useRef(false)
  const snapshotsRef = useRef<VehicleSnapshot[]>([])
  /** Set by the init effect – selection changes write the URL immediately. */
  const writeHashRef = useRef<() => void>(() => {})
  /** Live precipitation in mm; forced = set via the test API (skips gating). */
  const rainRef = useRef({ mm: 0, forced: false })
  /** Live cloud cover in percent; forced works like the rain's. */
  const cloudRef = useRef({ percent: 0, forced: false })
  /** Rain currently visible – keeps the render loop at animation rate. */
  const rainActiveRef = useRef(false)

  const [visibleLines, setVisibleLines] = useState<Set<string>>(new Set())
  const [showRoutes, setShowRoutes] = useState(true)
  const [showStops, setShowStops] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  const [speed, setSpeed] = useState<number>(config.simulation.initialSpeed)
  const [paused, setPaused] = useState(false)
  const [clockText, setClockText] = useState('--:--:--')
  const [vehicleCount, setVehicleCount] = useState(0)
  const [tilesetStatus, setTilesetStatus] = useState<TilesetStatus>('loading')
  const [selected, setSelected] = useState<VehicleSnapshot | null>(null)
  const [selectedVessel, setSelectedVessel] = useState<AisVessel | null>(null)
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeStatus | null>(null)
  // Top-down view (pitch ≈ -90°)? Drives the 2D/3D toggle button's face.
  const [cameraIs2D, setCameraIs2D] = useState(false)
  /** Sim clock in seconds of day – drives the vehicle card's countdown. */
  const [simSeconds, setSimSeconds] = useState(0)
  /** Underground view: tunnels solid, the surface ghosted (see CesiumMap). */
  const [underground, setUnderground] = useState(false)
  /** Same value for the render loop, which never sees the state updates. */
  const undergroundRef = useRef(false)

  const network = networkRef.current ?? (networkRef.current = loadBundledNetwork())

  /**
   * What the stop card shows about each stop: name, position, serving
   * lines, underground platform. Same aggregation the stops layer runs
   * for its name plates – a stop belongs to every line calling at it.
   */
  const stopInfoById = useMemo(() => {
    const byId = new Map<string, StopInfo>()
    for (const line of network.lines) {
      for (const dir of line.directions) {
        for (const stop of dir.stops) {
          const underground = isInTunnel(dir.tunnels, stop.dist)
          const known = byId.get(stop.id)
          if (known) {
            if (!known.lines.some((l) => l.id === line.id)) {
              known.lines.push({ id: line.id, color: line.color })
            }
            if (underground) known.inTunnel = true
            continue
          }
          byId.set(stop.id, {
            id: stop.id,
            name: stop.name,
            lon: stop.coord[0],
            lat: stop.coord[1],
            nhn: stop.nhn,
            lines: [{ id: line.id, color: line.color }],
            inTunnel: underground,
          })
        }
      }
    }
    return byId
  }, [network])
  const showRoutesRef = useRef(showRoutes)
  // Mirrors for the hash writer (closures in the init effect must not see
  // stale React state): layer toggles and pause travel in the URL.
  const showStopsRef = useRef(showStops)
  const showLabelsRef = useRef(showLabels)
  const pausedRef = useRef(paused)

  const applyRouteVisibility = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    for (const line of network.lines) {
      map.setLineRouteVisible(line.id, showRoutesRef.current && visibleLinesRef.current.has(line.id))
    }
  }, [network])

  const selectVehicle = useCallback((id: string | null) => {
    selectedIdRef.current = id
    // One selection at a time: picking a vehicle dismisses the stop card
    if (id !== null && selectedStopIdRef.current !== null) {
      selectedStopIdRef.current = null
      setSelectedStopId(null)
    }
    // …and the ship card, which shares the same corner of the screen
    if (id !== null && selectedMmsiRef.current !== null) {
      selectedMmsiRef.current = null
      setSelectedVessel(null)
      mapRef.current?.setFollowVessel(null)
    }
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

  /**
   * Ship selection (click on a hull or its name label). Ships carry no
   * hash state – they are not reproducible the way a stop or a scheduled
   * trip is, since which ships are in the harbor depends on the minute.
   */
  const selectVessel = useCallback(
    (mmsi: number | null) => {
      if (mmsi !== null) {
        if (selectedIdRef.current !== null) selectVehicle(null)
        if (selectedStopIdRef.current !== null) {
          selectedStopIdRef.current = null
          setSelectedStopId(null)
        }
      }
      selectedMmsiRef.current = mmsi
      if (mmsi === null) {
        setSelectedVessel(null)
        if (followingRef.current) {
          followingRef.current = false
          setFollowing(false)
          mapRef.current?.setFollowVessel(null)
        }
        return
      }
      setSelectedVessel(aisVesselsRef.current.find((v) => v.mmsi === mmsi) ?? null)
      if (followingRef.current) mapRef.current?.setFollowVessel(mmsi)
    },
    [selectVehicle],
  )

  /** Stop selection (click on a disc/name plate, or a #stop= link). */
  const selectStop = useCallback(
    (id: string | null) => {
      if (id !== null && selectedIdRef.current !== null) selectVehicle(null)
      if (id !== null && selectedMmsiRef.current !== null) selectVessel(null)
      selectedStopIdRef.current = id
      setSelectedStopId(id)
      writeHashRef.current()
    },
    [selectVehicle, selectVessel],
  )

  // Initialization: map, simulation, render loop
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Mirror the detected UI language for screen readers/translators
    document.documentElement.lang = getLanguage()

    const urlOpts = readUrlOptions()
    // Layer/pause state restored from a shared URL. The ?paused search
    // param stays the boot flag (tests); the hash marks a user pause.
    const uiState = parseUiStateHash(window.location.hash)
    const startPaused = urlOpts.paused || uiState.paused
    const clock = new SimClock(Date.now(), urlOpts.speed)
    if (urlOpts.timeSec !== null) clock.setSecondsOfDay(urlOpts.timeSec)
    if (startPaused) clock.setPaused(true)
    setSpeed(urlOpts.speed)
    setPaused(startPaused)
    pausedRef.current = startPaused
    if (uiState.routesHidden) {
      showRoutesRef.current = false
      setShowRoutes(false)
    }
    if (uiState.stopsHidden) {
      showStopsRef.current = false
      setShowStops(false)
    }
    if (uiState.labelsHidden) {
      showLabelsRef.current = false
      setShowLabels(false)
    }

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

    // AIS harbor traffic (aisstream.io via /api/ais): real vessels as a
    // backdrop, played back 4 minutes behind the wall clock (see
    // ais-extract.ts). Off in offline mode and tests, ?ais=0 opts out.
    const aisEnabled =
      config.ais.url !== '' && import.meta.env.MODE !== 'test' && !urlOpts.offline && urlOpts.ais
    let aisClient: AisClient | null = null
    let aisBackdrop: AisVessel[] = []
    if (aisEnabled) {
      aisClient = new AisClient(config.ais.url, (_status, vessels) => {
        // The city ferries sail as simulated vehicles on their timetable –
        // drawing their AIS twins too would put two boats on one crossing.
        aisBackdrop = vessels.filter((v) => !(v.mmsi in config.ais.ferryLineByMmsi))
        aisVesselsRef.current = aisBackdrop
        // An open ship card follows its ship's fixes; a ship that has left
        // the picture closes it rather than freezing at her last position.
        const mmsi = selectedMmsiRef.current
        if (mmsi !== null) {
          const fresh = aisBackdrop.find((v) => v.mmsi === mmsi) ?? null
          if (fresh === null) selectVessel(null)
          else setSelectedVessel(fresh)
        }
      })
      aisClient.start(config.ais.pollIntervalMs)
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
      // While a vehicle is selected the URL carries ONLY its trip id – a
      // shared link then re-selects and follows the vehicle, no camera
      // pose needed. Without a selection the camera pose is the URL state.
      // Layer toggles and pause ride along in either form.
      const hash =
        (selectedIdRef.current
          ? formatVehicleHash(selectedIdRef.current)
          : selectedStopIdRef.current
            ? formatStopHash(selectedStopIdRef.current)
            : formatCameraHash(m.getCameraView())) +
        formatUiStateHash({
          routesHidden: !showRoutesRef.current,
          stopsHidden: !showStopsRef.current,
          labelsHidden: !showLabelsRef.current,
          paused: pausedRef.current,
        })
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
      maxRainDrops: urlOpts.maxRainDrops,
      onSelectVehicle: selectVehicle,
      onSelectVessel: selectVessel,
      onSelectStop: selectStop,
      onTilesetStatus: setTilesetStatus,
      onCameraChanged: scheduleHashWrite,
    })
    mapRef.current = map
    // Restore the saved camera orientation from the URL hash
    const hashView = parseCameraHash(window.location.hash)
    if (hashView) map.setView(hashView)
    // Fence the camera in around the network – a shared link may carry a
    // pose from anywhere on the globe, so this runs after the restore.
    map.limitCameraToNetwork(network)
    map.addRoutes(network)
    map.addStops(network)
    // Night-time street lighting. Nothing is built until the pools would
    // actually show, so a daytime session pays nothing for this.
    if (urlOpts.lamps) map.addStreetLamps(loadStreetLamps())
    // Apply the layer visibility restored from the hash to the fresh map
    if (uiState.routesHidden) applyRouteVisibility()
    if (uiState.stopsHidden) map.setStopsVisible(false)
    if (uiState.labelsHidden) map.setLabelsVisible(false)

    // Rain overlay: live precipitation for the city center (Open-Meteo).
    // Offline mode stays dry (no network, deterministic E2E tests) and
    // ?rain=0 opts out. Whether the rain is actually drawn is decided per
    // UI tick (sim time must be near the real clock).
    let weatherClient: WeatherClient | null = null
    const weatherEnabled =
      config.weather.url !== '' &&
      import.meta.env.MODE !== 'test' &&
      !urlOpts.offline &&
      urlOpts.rain
    if (weatherEnabled) {
      map.addWeatherCredit()
      weatherClient = new WeatherClient(
        config.weather.url,
        config.weather.longitude,
        config.weather.latitude,
        (status) => {
          rainRef.current = { mm: status.precipitationMm, forced: false }
          cloudRef.current = { percent: status.cloudCoverPercent, forced: false }
        },
      )
      weatherClient.start(config.weather.pollIntervalMs)
    }

    // A vehicle shared via the URL (#vehicle=…) is restored as soon as its
    // trip shows up in the snapshots – it may take a moment for the
    // simulation to have it, and it may never appear (link opened while
    // the trip is not active), so the attempt expires silently. The
    // restored vehicle starts in follow mode: the link carries no camera
    // pose, the approach flight brings the viewer to the vehicle.
    let pendingSharedVehicle = parseVehicleHash(window.location.hash)
    let sharedVehicleDeadline = performance.now() + 20_000

    // A stop shared via the URL (#stop=…) opens its card right away –
    // stops are static, nothing to wait for – and flies the camera there,
    // since the link carries no pose. A vehicle hash takes precedence.
    if (!pendingSharedVehicle) {
      const sharedStopId = parseStopHash(window.location.hash)
      const sharedStop = sharedStopId ? stopInfoById.get(sharedStopId) : undefined
      if (sharedStop) {
        selectStop(sharedStop.id)
        map.flyToStop(sharedStop.lon, sharedStop.lat, sharedStop.nhn)
      }
    }

    // The hash IS the app state, but so far only the boot ever read it –
    // editing it in the address bar did nothing until a reload. Our own
    // writes go through replaceState, which fires no hashchange, so
    // everything arriving here comes from outside: a typed edit, a link,
    // a history step.
    const applyHash = () => {
      const hash = window.location.hash
      const ui = parseUiStateHash(hash)
      if (ui.paused !== pausedRef.current) {
        clock.setPaused(ui.paused)
        pausedRef.current = ui.paused
        setPaused(ui.paused)
      }
      const routesVisible = !ui.routesHidden
      if (routesVisible !== showRoutesRef.current) {
        showRoutesRef.current = routesVisible
        setShowRoutes(routesVisible)
        applyRouteVisibility()
      }
      const stopsVisible = !ui.stopsHidden
      if (stopsVisible !== showStopsRef.current) {
        showStopsRef.current = stopsVisible
        setShowStops(stopsVisible)
        map.setStopsVisible(stopsVisible)
      }
      const labelsVisible = !ui.labelsHidden
      if (labelsVisible !== showLabelsRef.current) {
        showLabelsRef.current = labelsVisible
        setShowLabels(labelsVisible)
        map.setLabelsVisible(labelsVisible)
      }

      // A selection outranks a camera pose, the same order writeHash
      // builds the hash in – so a hash carrying neither clears both.
      const vehicleId = parseVehicleHash(hash)
      if (vehicleId) {
        // Same restore path as a shared link: the trip may not be in the
        // snapshots yet, so it waits for it and gives up silently.
        pendingSharedVehicle = vehicleId
        sharedVehicleDeadline = performance.now() + 20_000
        return
      }
      pendingSharedVehicle = null
      const stopId = parseStopHash(hash)
      const stop = stopId ? stopInfoById.get(stopId) : undefined
      if (stop) {
        selectStop(stop.id)
        map.flyToStop(stop.lon, stop.lat, stop.nhn)
        return
      }
      if (selectedIdRef.current) selectVehicle(null)
      if (selectedStopIdRef.current) selectStop(null)
      const view = parseCameraHash(hash)
      // Instant, like the boot restore – an edited pose is a jump to it,
      // not a sightseeing flight. The camera fence still applies.
      if (view) map.setView(view)
    }
    window.addEventListener('hashchange', applyHash)

    // First write right away: a camera that never moves after boot fires no
    // change event (the first rendered frame establishes the baseline), yet
    // the URL must be shareable immediately.
    writeHash()

    let rafId = 0
    let lastUiUpdate = 0
    let lastSimTick = 0
    // A real ship under way on screen paces ticks and rendering like a
    // tram in view does.
    let lastMovingVesselInView = false
    // Pause freezes the whole picture, ships included: the AIS input and
    // its clock hold at the moment of pausing, so the playback stands
    // still and later polls cannot move a frozen world. Play unfreezes
    // into live data (and snaps the sim clock to real time, see
    // handleTogglePause) – the display ease glides everything over.
    let aisFrozen: { backdrop: AisVessel[]; atMs: number } | null = null
    let lastRender = 0
    let lastLightingMs = -Infinity
    let lastAnyVehicleInView = true
    let loopTicks = 0
    let lastLoopError: string | null = null
    const renderTimes: number[] = []
    let lastFrameAt = performance.now()
    /**
     * One frame of work: simulation tick, UI state, render pacing. Driven by
     * requestAnimationFrame – and by the watchdog below whenever rAF stalls.
     *
     * The watchdog passes render: false. A stalled compositor is not showing
     * frames anyway, so rendering into the canvas would be wasted work – and
     * under software rendering it would keep the machine busy while it is
     * trying to catch up. Pending render requests survive (consumeRenderRequest
     * is not called), so the next real frame draws the current state.
     */
    const runFrame = (now: number, render = true) => {
      lastFrameAt = now
      // The loop must not die permanently on a transient error (e.g. Cesium
      // internals while bulk-removing entities) – otherwise the entire
      // simulation freezes.
      try {
        loopTicks++
        if (!document.hidden) {
          // Tick the simulation at ~30 fps max; when paused or with no
          // vehicle in view, 2 fps is plenty.
          const tickInterval =
            (clock.paused || !lastAnyVehicleInView) && !lastMovingVesselInView ? 500 : 33
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
            if (clock.paused) {
              // A pause that started before the first poll upgrades once
              // when data lands – frozen, but not needlessly empty.
              if (aisFrozen === null || (aisFrozen.backdrop.length === 0 && aisBackdrop.length > 0)) {
                aisFrozen = { backdrop: aisBackdrop, atMs: Date.now() }
              }
            } else {
              aisFrozen = null
            }
            const aisNow = aisFrozen?.atMs ?? Date.now()
            const viewInfo = map.syncVehicles(snapshots, visibleLinesRef.current)
            const vesselInfo = aisEnabled
              ? map.syncVessels(aisFrozen?.backdrop ?? aisBackdrop, aisNow)
              : null
            lastAnyVehicleInView = viewInfo?.anyVehicleInView ?? false
            lastMovingVesselInView = !clock.paused && (vesselInfo?.anyMovingVesselInView ?? false)

            // After syncVehicles, so the selection highlight and the follow
            // camera find the vehicle record (setSelected/setFollow only act
            // on records that already exist).
            if (pendingSharedVehicle) {
              if (snapshots.some((s) => s.id === pendingSharedVehicle)) {
                selectVehicle(pendingSharedVehicle)
                followingRef.current = true
                setFollowing(true)
                map.setFollow(pendingSharedVehicle)
                pendingSharedVehicle = null
              } else if (now > sharedVehicleDeadline) {
                pendingSharedVehicle = null
              }
            }

            // Update UI state only ~4×/second, not every frame
            if (now - lastUiUpdate > 250) {
              lastUiUpdate = now
              setClockText(clock.formatted())
              setSimSeconds(clock.secondsOfDay())
              setCameraIs2D(map.getCameraView().pitch < -85)
              // Rain: only with live precipitation AND a sim clock near the
              // real time – time travel must not show today's weather.
              const nearRealTime = weatherIsCurrent(
                clock.secondsOfDay(),
                berlinSecondsOfDay(Date.now()),
                config.weather.maxSimTimeDriftSeconds,
              )
              // Below ground there is no weather: no drops falling around the
              // camera, and no overcast grade on a city seen from underneath.
              const weatherVisible = !undergroundRef.current
              const rain = rainRef.current
              const rainNow =
                weatherVisible && rain.mm > 0 && (rain.forced || nearRealTime) ? rain.mm : 0
              map.setRain(rainNow)
              rainActiveRef.current = rainNow > 0
              // Same gate for the overcast grade – a grey sky is as much
              // "now" as the rain is.
              const cloud = cloudRef.current
              map.setCloudCover(
                weatherVisible && (cloud.forced || nearRealTime) ? cloud.percent : 0,
              )
              setVehicleCount(
                snapshots.filter((s) => visibleLinesRef.current.has(s.lineId)).length,
              )
              const selId = selectedIdRef.current
              if (selId) {
                const snap = snapshots.find((s) => s.id === selId) ?? null
                if (!snap) {
                  // Trip ended → clear the selection
                  selectVehicle(null)
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
          const hints = render
            ? (map.getRenderHints?.() ?? { interacting: true, tilesLoading: false })
            : null
          // Falling rain is an animation too – even with the sim paused
          const animating =
            (lastAnyVehicleInView && !clock.paused) ||
            lastMovingVesselInView ||
            rainActiveRef.current
          const renderInterval = !hints
            ? Number.POSITIVE_INFINITY
            : hints.interacting
              ? 15
              : animating || hints.tilesLoading
                ? 33
                : 15000
          if (hints && (map.consumeRenderRequest() || now - lastRender >= renderInterval)) {
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
    }

    const loop = (now: number) => {
      runFrame(now)
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    // Timers keep firing when the compositor stops handing out frames, so a
    // stalled rAF no longer freezes the simulation (see RAF_STALL_MS). While
    // rAF is healthy this only compares two timestamps – no tick, no render,
    // and therefore no periodic GPU load on an idle map.
    const rafWatchdog = window.setInterval(() => {
      if (document.hidden) return
      const now = performance.now()
      if (now - lastFrameAt >= RAF_STALL_MS) runFrame(now, false)
    }, RAF_WATCHDOG_INTERVAL_MS)

    // Test/debug API
    const api: MrtTestApi = {
      ready: true,
      vehicleCount: () => snapshotsRef.current.length,
      visibleVehicleCount: () =>
        snapshotsRef.current.filter((s) => visibleLinesRef.current.has(s.lineId)).length,
      vehicles: () => snapshotsRef.current,
      setTime: (hhmm: string) => {
        const sec = parseTimeOfDay(hhmm)
        if (sec !== null) clock.setSecondsOfDay(sec)
      },
      setSpeed: (s: number) => clock.setSpeed(s),
      setPaused: (p: boolean) => {
        clock.setPaused(p)
        pausedRef.current = p
        setPaused(p)
      },
      aisVesselCount: () => map.getVesselCount(),
      setRealtimeDelays: (delays: Record<string, number>) => {
        sim.setRealtimeDelays(new Map(Object.entries(delays)))
      },
      setRain: (precipitationMm: number) => {
        rainRef.current = { mm: precipitationMm, forced: precipitationMm > 0 }
      },
      setCloudCover: (cloudCoverPercent: number) => {
        cloudRef.current = { percent: cloudCoverPercent, forced: cloudCoverPercent > 0 }
      },
      rainDropsVisible: () => map.getRainDropsVisible(),
      selectVehicle,
      selectedVehicleId: () => selectedIdRef.current,
      selectStop,
      selectedStopId: () => selectedStopIdRef.current,
      vehicleScreenPosition: (id: string) => map.getVehicleScreenPosition(id),
      stopScreenPosition: (id: string) => map.getStopScreenPosition(id),
      dataSource: network.meta.source,
      lineIds: () => network.lines.map((l) => l.id),
      secondsOfDay: () => clock.secondsOfDay(),
      loopTicks: () => loopTicks,
      lastLoopError: () => lastLoopError,
      groundHeights: () => map.getGroundHeights(),
      tileMemory: () => map.getTileMemoryInfo(),
      anyVehicleInView: () => lastAnyVehicleInView,
      streetLamps: () => map.getStreetLampInfo(),
      renderRate: () => {
        // Prune on read, not only when a frame is drawn: otherwise the
        // value freezes at its last level the moment rendering stops, and
        // an idle loop keeps reporting the rate it had while it was busy.
        const cutoff = performance.now() - 5000
        while (renderTimes.length > 0 && renderTimes[0] < cutoff) renderTimes.shift()
        return renderTimes.length / 5
      },
      renderPacing: () => {
        const hints = map.getRenderHints?.() ?? { interacting: true, tilesLoading: false }
        const animating =
          (lastAnyVehicleInView && !clock.paused) ||
          lastMovingVesselInView ||
          rainActiveRef.current
        return {
          animating,
          rainActive: rainActiveRef.current,
          vehicleInView: lastAnyVehicleInView,
          vesselInView: lastMovingVesselInView,
          interacting: hints.interacting,
          tilesLoading: hints.tilesLoading,
          intervalMs: hints.interacting ? 15 : animating || hints.tilesLoading ? 33 : 15000,
        }
      },
      vehicleBoxDriftMeters: () => map.getVehicleBoxDriftMeters(),
      vehicleOpacity: (id: string) => map.getVehicleOpacity(id),
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
      window.clearInterval(rafWatchdog)
      window.removeEventListener('pagehide', writeHash)
      window.removeEventListener('hashchange', applyHash)
      window.clearTimeout(hashTimeout)
      writeHashRef.current = () => {}
      realtimeClient?.stop()
      aisClient?.stop()
      weatherClient?.stop()
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
      // Discrete event – the shareable URL updates immediately
      writeHashRef.current()
    },
    [applyRouteVisibility],
  )

  const handleToggleStops = useCallback((visible: boolean) => {
    showStopsRef.current = visible
    setShowStops(visible)
    mapRef.current?.setStopsVisible(visible)
    writeHashRef.current()
  }, [])

  const handleToggleLabels = useCallback((visible: boolean) => {
    showLabelsRef.current = visible
    setShowLabels(visible)
    mapRef.current?.setLabelsVisible(visible)
    writeHashRef.current()
  }, [])

  const handleSpeedChange = useCallback((value: number) => {
    setSpeed(value)
    simRef.current?.clock.setSpeed(value)
  }, [])

  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev
      simRef.current?.clock.setPaused(next)
      // Play never resumes a past moment: releasing the pause snaps the
      // clock to the real time, so trams (GTFS) and ships (AIS) carry on
      // where reality actually is – not where it was when paused.
      if (!next) simRef.current?.clock.resetToRealTime()
      pausedRef.current = next
      writeHashRef.current()
      return next
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
    const mmsi = selectedMmsiRef.current
    if (id === null && mmsi === null) return
    const next = !followingRef.current
    followingRef.current = next
    setFollowing(next)
    if (mmsi !== null) mapRef.current?.setFollowVessel(next ? mmsi : null)
    else mapRef.current?.setFollow(next && id !== null ? id : null)
  }, [])

  const handleResetCamera = useCallback(() => {
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      mapRef.current?.setFollow(null)
      mapRef.current?.setFollowVessel(null)
    }
    mapRef.current?.setCameraHome(true)
  }, [])

  /** Toggle between the normal view and the underground one. */
  const handleToggleUnderground = useCallback(() => {
    setUnderground((wasUnderground) => {
      const next = !wasUnderground
      undergroundRef.current = next
      mapRef.current?.setUnderground(next)
      return next
    })
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

  /**
   * A departure clicked in the stop card: select its vehicle and ride
   * along. The tram is somewhere off screen – following both flies the
   * camera there and keeps it there while the trip runs.
   */
  const handleSelectDeparture = useCallback(
    (tripId: string) => {
      selectVehicle(tripId)
      followingRef.current = true
      setFollowing(true)
      mapRef.current?.setFollow(tripId)
    },
    [selectVehicle],
  )

  /** Fly the camera to a stop of the selected vehicle's trip. */
  const handleFlyToStop = useCallback((stop: { lon: number; lat: number; nhn?: number }) => {
    const map = mapRef.current
    if (!map) return
    // A camera flight and the follow chase would fight – stop following
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      map.setFollow(null)
    }
    map.flyToStop(stop.lon, stop.lat, stop.nhn)
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

  /**
   * Where a passenger can change at each stop – including the platforms a
   * short walk away, which at a junction carry the interesting lines (see
   * src/lib/interchange.ts). The vehicle card reads its badges out of it.
   */
  const interchangeByStop = useMemo(
    () => buildInterchangeIndex(network, config.interchangeRadiusMeters),
    [network],
  )

  // Stable across the 4×/s clock re-renders so the memoized line list in the
  // ControlPanel can bail out; only rebuilt when a line is toggled.
  const lineInfos: LineToggleInfo[] = useMemo(
    () =>
      network.lines.map((line) => ({
        id: line.id,
        name: localizeLineName(line.name),
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
  const dataSource = network.meta.source === 'osm' ? null : t('status.demoData')

  // All stops of the selected trip plus the vehicle's position among them.
  // `selected` is refreshed on every UI tick, so the position marker and
  // the passed-stop dimming track the vehicle.
  const selectedStop = selectedStopId ? (stopInfoById.get(selectedStopId) ?? null) : null
  // Recomputed with the 4-Hz clock state – the countdowns tick with the
  // simulation, and GTFS-RT delays land as they arrive. ~200 stop calls
  // filtered per pass, far below the snapshot work of the same tick.
  const stopDepartures = useMemo(
    () =>
      selectedStop && simRef.current
        ? simRef.current.upcomingDepartures(selectedStop.id, simSeconds)
        : [],
    [selectedStop, simSeconds],
  )

  const tripProgress = useMemo(
    () => (selected ? (simRef.current?.tripProgress(selected.id) ?? null) : null),
    [selected],
  )

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
          showLabels={showLabels}
          onToggleLabels={handleToggleLabels}
          vehicleCount={vehicleCount}
          tilesetStatus={tilesetStatus}
          dataSource={dataSource}
          realtimeStatus={realtimeStatus}
        />
      </div>

      {selectedVessel && (
        <div className="pointer-events-none absolute right-4 top-4 z-10">
          <VesselCard
            vessel={selectedVessel}
            nowMs={Date.now()}
            following={following}
            onToggleFollow={handleToggleFollow}
            onClose={() => selectVessel(null)}
          />
        </div>
      )}

      {!selected && !selectedVessel && selectedStop && (
        <div className="pointer-events-none absolute right-4 top-4 z-10">
          <StopCard
            stop={selectedStop}
            departures={stopDepartures}
            simSeconds={simSeconds}
            interchange={interchangeByStop.get(selectedStop.id) ?? []}
            onSelectVehicle={handleSelectDeparture}
            onFlyTo={handleFlyToStop}
            onClose={() => selectStop(null)}
          />
        </div>
      )}

      {selected && (
        <div className="pointer-events-none absolute right-4 top-4 z-10">
          <VehicleCard
            vehicle={selected}
            tripProgress={tripProgress}
            simSeconds={simSeconds}
            interchangeByStop={interchangeByStop}
            onFlyToStop={handleFlyToStop}
            following={following}
            onToggleFollow={handleToggleFollow}
            onClose={() => selectVehicle(null)}
          />
        </div>
      )}

      {/* Map controls: underground, 2D/3D, face north, camera reset. bottom-8
          keeps them clear of the Cesium attribution line at the lower edge. */}
      <div className="pointer-events-none absolute bottom-8 right-4 z-10 flex flex-col gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              // The active state has to beat the shared bg-card/85 below,
              // which tailwind-merge would otherwise let win over a variant.
              className={cn(
                'pointer-events-auto border border-border/60 backdrop-blur-md',
                underground
                  ? 'bg-primary/90 text-primary-foreground hover:bg-primary/80'
                  : 'bg-card/85',
              )}
              aria-label={underground ? t('camera.toSurface') : t('camera.toUnderground')}
              aria-pressed={underground}
              onClick={handleToggleUnderground}
            >
              {underground ? <Mountain aria-hidden /> : <Layers2 aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {underground ? t('camera.toSurface') : t('camera.toUnderground')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="pointer-events-auto border border-border/60 bg-card/85 font-bold backdrop-blur-md"
              aria-label={cameraIs2D ? t('camera.to3d') : t('camera.to2d')}
              onClick={handleToggleViewMode}
            >
              {cameraIs2D ? '3D' : '2D'}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">
            {cameraIs2D ? t('camera.to3d') : t('camera.to2d')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="pointer-events-auto border border-border/60 bg-card/85 backdrop-blur-md"
              aria-label={t('camera.faceNorth')}
              onClick={handleFaceNorth}
            >
              <Compass aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('camera.faceNorth')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="icon"
              className="pointer-events-auto border border-border/60 bg-card/85 backdrop-blur-md"
              aria-label={t('camera.reset')}
              onClick={handleResetCamera}
            >
              <Home aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left">{t('camera.reset')}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
