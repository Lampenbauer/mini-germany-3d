import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Building2,
  CircleHelp,
  Home,
  Maximize,
  Menu,
  Minimize,
  TrainFrontTunnel,
} from 'lucide-react'
import { ControlPanel, type CityChoice, type LineToggleInfo } from '@/components/ControlPanel'
import { LayersPopover, type WebcamChoice } from '@/components/LayersPopover'
import { CompassIcon } from '@/components/CompassIcon'
import { PhotoModePopover, type CameraPathControls } from '@/components/PhotoModePopover'
import { WeatherPopover } from '@/components/WeatherPopover'
import { CityCard } from '@/components/CityCard'
import { LineCard } from '@/components/LineCard'
import { VehicleCard } from '@/components/VehicleCard'
import { VesselCard } from '@/components/VesselCard'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { config } from '@/config'
import { cn } from '@/lib/utils'
import {
  CITIES,
  DEFAULT_CITY_SLUG,
  cityBySlug,
  isCitySlug,
  loadCityData,
  type CityData,
} from '@/cities'
import type { PreparedNetwork } from '@/data/network-types'
import { Simulation, type VehicleSnapshot } from '@/engine/simulation'
import { StopCard, type StopInfo } from '@/components/StopCard'
import {
  formatCameraHash,
  formatStopHash,
  formatUiStateHash,
  formatVehicleHash,
  formatVesselHash,
  parseCameraHash,
  parseStopHash,
  parseUiStateHash,
  parseVehicleHash,
  parseVesselHash,
  type CameraView,
} from '@/lib/camera-hash'
import {
  DEFAULT_DURATION_S,
  DEFAULT_EASE,
  formatCameraPathHash,
  isFlyable,
  parseCameraPathHash,
  type CameraPath,
  type CameraPathEase,
} from '@/lib/camera-path'
import {
  detectDeviceTier,
  readDevice,
  renderProfileFor,
  type RenderProfile,
} from '@/lib/render-profile'
import { formatSitePath, parseSitePath } from '@/lib/site-path'
import { narrowViewport } from '@/lib/viewport'
import { cityApiUrl } from '@/lib/city-api'
import { parseTimeOfDay, SimClock } from '@/lib/clock'
import { isInTunnel } from '@/lib/tunnels'
import {
  fullscreenElement,
  fullscreenSupported,
  onFullscreenChange,
  toggleFullscreen,
} from '@/lib/fullscreen'
import { nextQuarterHeading, windAngleTo } from '@/lib/geo'
import { getLanguage, localizeCityName, localizeLineName, t, type MessageKey } from '@/lib/i18n'
import type { MapView } from '@/lib/map-view'
import { AboutDialog } from '@/components/AboutDialog'
import { WelcomeScreen } from '@/components/WelcomeScreen'
import { CreditsDialog } from '@/components/CreditsDialog'
import { DEFAULT_PHOTO_SETTINGS, withTiltShift, type PhotoSettings } from '@/lib/photo-settings'
import { buildInterchangeIndex } from '@/lib/interchange'
import {
  buildCityActivity,
  buildCityProfile,
  sameActivity,
  type CityActivity,
} from '@/lib/city-profile'
import { buildLineActivity, buildLineProfile } from '@/lib/line-profile'
import { RealtimeClient, type RealtimeStatus } from '@/lib/realtime'
import { AisClient } from '@/lib/ais'
import { AisArchiveClient, aisReplayWanted, type AisArchiveHourStatus } from '@/lib/ais-archive'
import type { AisVessel } from '@/lib/ais-extract'
import {
  defaultWeatherMode,
  weatherIsCurrentAt,
  WeatherClient,
  WEATHER_PRESETS,
  type WeatherMode,
} from '@/lib/weather'
import { WebcamsClient, type Webcam } from '@/lib/webcams'
import { browserStorage, setWelcomeHidden, welcomeHidden, welcomeWanted } from '@/lib/welcome'
import type { ScheduleJson } from '@/lib/timetable'
import { CesiumMap, type TilesetStatus } from '@/map/CesiumMap'
import { buildLinearSeed, LinearView, type LinearBox } from '@/map/LinearView'

/** Debug/test API that the E2E tests use under window.__mrt. */
export interface MrtTestApi {
  /** The city's data is on the map and the simulation runs on it. */
  ready: boolean
  vehicleCount: () => number
  visibleVehicleCount: () => number
  vehicles: () => VehicleSnapshot[]
  setTime: (hhmm: string) => void
  /** The simulated calendar day, "YYYY-MM-DD" in Europe/Berlin. */
  setDate: (dateKey: string) => void
  dateKey: () => string
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
  /**
   * Whether the ships are replayed from the recording, and which hours of
   * it are held (see lib/ais-archive.ts) – the first stop for "the harbour
   * is empty at 09:00".
   */
  aisReplay: () => { active: boolean; hours: AisArchiveHourStatus[]; fleet: number }
  selectStop: (id: string | null) => void
  selectedStopId: () => string | null
  /** Ship selection by MMSI, as a click on a hull does it. */
  selectVessel: (mmsi: number | null) => void
  selectedMmsi: () => number | null
  /** Trip id of the current selection, null when nothing is selected. */
  selectedVehicleId: () => string | null
  /** Screen position of a vehicle in CSS px (null = off screen/unknown). */
  vehicleScreenPosition: (id: string) => { x: number; y: number } | null
  stopScreenPosition: (id: string) => { x: number; y: number } | null
  /** Data source of the city on the map ('' while none is loaded). */
  dataSource: string
  /** Slug of the city on the map. */
  city: () => string
  /** Whether the welcome screen is up – asking, or lingering over the city loading behind it. */
  welcomeOpen: () => boolean
  /** Whether the lines are drawn pulled straight instead of on the map. */
  linear: () => boolean
  setLinear: (linear: boolean) => void
  /** Switches to another city the way the panel's picker does (flies there). */
  setCity: (slug: string) => void
  /** Which basemap the map ended up on ('offline' with ?offline=1). */
  tilesetStatus: () => TilesetStatus
  /** GTFS-RT feed state and how many trips it matched (null = disabled). */
  realtimeStatus: () => RealtimeStatus | null
  lineIds: () => string[]
  secondsOfDay: () => number
  /** The time-lapse factor the clock runs at (1 = real time). */
  speed: () => number
  loopTicks: () => number
  lastLoopError: () => string | null
  groundHeights: () => { id: string; groundHeight: number }[]
  /**
   * Bridge decks measured on the tiles (see map/bridge-decks.ts): the
   * city's progress, or with a line id that line's vertices one by one.
   */
  bridgeDecks: (
    lineId?: string,
  ) => ReturnType<CesiumMap['getBridgeDeckInfo']> | ReturnType<CesiumMap['getBridgeDeckDetails']>
  anyVehicleInView: () => boolean
  /** Street lighting: lamps batched into the scene and their current opacity. */
  streetLamps: () => { drawn: number; alpha: number }
  /** Average render rate over the last 5 seconds (frames/s). */
  renderRate: () => number
  /**
   * Why the render loop is (not) idling – the four inputs of the pacing
   * gate. Diagnosing "the GPU stays busy" is guesswork without them.
   */
  /**
   * The miniature effect as the map has it: switched on, how much of it
   * the camera pose carries, and whether its passes are compiled and
   * running. The last one is what a test has to wait on before it can
   * judge a frame (see tilt-shift.spec.ts).
   */
  tiltShiftState: () => { enabled: boolean; strength: number; ready: boolean }
  /** The volumetric clouds: cover, threshold, whether drawn (see CloudLayer). */
  cloudState: () => ReturnType<CesiumMap['cloudState']>
  renderPacing: () => {
    /** Falling rain – the one animation that renders at a fixed rate. */
    animating: boolean
    rainActive: boolean
    vehicleInView: boolean
    /** A vessel whose drawn pose is still changing is on screen. */
    vesselInView: boolean
    interacting: boolean
    tilesLoading: boolean
    /** The fallback render interval; motion and camera changes request frames on their own. */
    intervalMs: number
    /** The simulation tick interval in force (33 … 500 ms, see the loop). */
    tickIntervalMs: number
    /** On-screen speed of the fastest vehicle or ship in view, CSS px/s. */
    motionPxPerSecond: number
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
  /** The sun shadow map: switched on, and whether its texture is currently allocated. */
  shadowMap: () => { enabled: boolean; allocated: boolean; size: number }
  /** The device tier and the numbers the map draws with (see lib/render-profile.ts). */
  renderProfile: () => RenderProfile
  /** The camera path (lib/camera-path.ts): what is set, whether it is being flown, how far along. */
  cameraPath: () => { path: CameraPath | null; playing: boolean; progress: number }
  setCameraPath: (path: CameraPath | null) => void
  playCameraPath: () => void
  stopCameraPath: () => void
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
  /** Live webcams floating over their spot (?webcams=0 disables them). */
  webcams: boolean
  /** Tile LOD budget override in drawing-buffer pixels (debug, ?sse=12). */
  maximumScreenSpaceError: number | undefined
  /** Cap on the rain drop pool (?drops=50) – keeps the E2E rain test cheap. */
  maxRainDrops: number | undefined
  /** The device tier forced by ?tier=mobile / ?tier=desktop; null reads the device. */
  tier: string | null
  /** ?play=1: fly the camera path the hash carries once the city is up. */
  play: boolean
}

/**
 * The camera path as the photo popover builds it (see lib/camera-path.ts):
 * two keyframes that stand apart until both are set, the time between
 * them and the pace. Only with both set is there a path to fly.
 */
interface CameraPathDraft {
  start: CameraView | null
  end: CameraView | null
  durationS: number
  ease: CameraPathEase
}

function draftToPath(draft: CameraPathDraft): CameraPath | null {
  return draft.start && draft.end
    ? { keyframes: [draft.start, draft.end], durationS: draft.durationS, ease: draft.ease }
    : null
}

/** A path's first and last keyframe as the draft – a hash may carry more, the popover shows two. */
function draftFromPath(path: CameraPath | null): CameraPathDraft {
  return path
    ? {
        start: path.keyframes[0],
        end: path.keyframes[path.keyframes.length - 1],
        durationS: path.durationS,
        ease: path.ease,
      }
    : { start: null, end: null, durationS: DEFAULT_DURATION_S, ease: DEFAULT_EASE }
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

/**
 * How long the map takes to become the diagram, in ms. Long enough to
 * read the lines straightening out of their own course, short enough
 * that it is a transition and not a title sequence.
 */
const LINEAR_MORPH_MS = 900

/**
 * The tabs, in the order a reader descends through them: the city as it
 * stands, the same city from underneath, and the network with the city
 * taken away entirely. Each icon shows what its tab draws – a tab is a
 * place to be, not an errand to run, so none of them names a press.
 */
const VIEW_TABS = [
  { value: 'surface', labelKey: 'view.surface', Icon: Building2 },
  { value: 'underground', labelKey: 'view.underground', Icon: TrainFrontTunnel },
  // Three plain bars: the diagram is every line pulled straight and
  // stacked, which is exactly that shape (Rows3 drew boxed rows instead).
  { value: 'linear', labelKey: 'view.diagram', Icon: Menu },
] as const satisfies readonly { value: MapView; labelKey: MessageKey; Icon: typeof Building2 }[]

/**
 * Whether Space belongs to the element the keyboard stands on rather than
 * to the simulation: a button, a link, or anything wearing a role that is
 * activated with it. See the keyboard effect below.
 */
const SPACE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY', 'DETAILS', 'OPTION'])
const SPACE_ROLES = new Set([
  'button',
  'checkbox',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'switch',
  'tab',
])
function usesSpaceItself(target: HTMLElement | null): boolean {
  if (!target) return false
  if (SPACE_TAGS.has(target.tagName)) return true
  const role = target.getAttribute?.('role')
  return role !== null && role !== undefined && SPACE_ROLES.has(role)
}

/**
 * The keys that mean something on their own (see the keyboard effect).
 * Space pauses and is handled beside them, because it is the one key that
 * has to give way to a focused control.
 */
const KEY_SHORTCUTS = new Set([
  'h', 'f', 'u', 's', 'r', 'l', 'n', 'c', 'm',
  '2', '3',
  '+', '=', '-', '_',
  '?', 'Escape',
])

/**
 * The two most layouts cannot type without Shift – a US keyboard puts +
 * over the equals sign and ? over the slash, a German one ? over the ß.
 * On a letter Shift still means somebody else's shortcut.
 */
const SHIFTED_SHORTCUTS = new Set(['?', '+', '_'])

/** The time-lapse speeds the keyboard steps through (the slider is free). */
const SPEED_STEPS = [1, 2, 5, 10, 20, 30, 60, 120] as const

/** No line at all – what the map's vehicles are filtered by while the diagram has them. */
const NO_LINES: ReadonlySet<string> = new Set()

/**
 * Frames a map raised behind an open diagram is still drawn for – about
 * four seconds at the animation rate, enough for a big city's route
 * polylines to compile (see mapWarmupRef).
 */
const LINEAR_MAP_WARMUP_FRAMES = 120

/** How long a shared vehicle (#vehicle=…) is waited for before the link is given up on. */
const SHARED_VEHICLE_TIMEOUT_MS = 20_000
/**
 * The same for a ship (#vessel=…), but longer: a trip is in the very first
 * snapshot the simulation makes, while a ship has to be reported – the AIS
 * poller's first answer can be a listen window away, and a ship on a
 * 60-second grid another minute behind that.
 */
const SHARED_VESSEL_TIMEOUT_MS = 90_000

/**
 * Where the last visited city is remembered between sessions. Nothing
 * reads it since the welcome screen: the boot opens on the link's city or
 * the default one (see initialCitySlug), and the screen asks rather than
 * guesses. Still written, so the wish to open on it again is one read
 * away.
 */
const CITY_STORAGE_KEY = 'mg3d.city'

/** A schedule that says nothing – lets the line card compute a profile without one. */
const EMPTY_SCHEDULE: ScheduleJson = {}

/**
 * How long the welcome screen stands after the pick, at least: the city
 * loads behind it in that time – its data, routes, stops, vehicles, the
 * first ships – so the map is a populated one when the screen goes, not
 * an empty one filling up. Longer where the data takes longer, up to
 * WELCOME_LINGER_MAX_MS, after which the screen goes whatever came.
 */
const WELCOME_LINGER_MS = 2000
const WELCOME_LINGER_MAX_MS = 10_000

/**
 * The welcome screen's life: up and asking, up with a spinner on the
 * card picked while the city loads behind it, gone.
 */
type WelcomePhase = 'open' | 'loading' | 'closed'

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
      Number.isFinite(groundHeight) && groundHeight > -100 && groundHeight < 3000
        ? groundHeight
        : undefined,
    realtime: params.get('rt') === '1' ? true : params.get('rt') === '0' ? false : null,
    rain: params.get('rain') !== '0',
    ais: params.get('ais') !== '0',
    lamps: params.get('lamps') !== '0',
    webcams: params.get('webcams') !== '0',
    maximumScreenSpaceError: Number.isFinite(sse) && sse >= 1 && sse <= 128 ? sse : undefined,
    maxRainDrops: Number.isFinite(drops) && drops >= 1 && drops <= 4000 ? drops : undefined,
    tier: params.get('tier'),
    play: params.get('play') === '1',
  }
}

function rememberCity(slug: string): void {
  try {
    window.localStorage.setItem(CITY_STORAGE_KEY, slug)
  } catch {
    // Private mode, blocked storage – a forgotten city is no harm.
  }
}

/**
 * The city the session opens on: the path says so (/kiel/, see
 * lib/site-path.ts), else the default. Not the city of the last visit:
 * on a plain visit the welcome screen asks, and once the reader has
 * turned it off the app opens on the default city, as they were told it
 * would. An unknown slug in the path is ignored rather than refused –
 * the rest of the link may still be good.
 */
function initialCitySlug(): string {
  const fromPath = parseSitePath(window.location.pathname).city
  if (fromPath && isCitySlug(fromPath)) return fromPath
  return DEFAULT_CITY_SLUG
}

/**
 * The sky a hash asks for, as this session can actually show it. A hash
 * that names none – and one that asks for the live sky where there is
 * nothing to poll (offline, in the tests, with ?rain=0) – gets the sky
 * such a session opens on rather than a promise it cannot keep.
 */
function hashWeatherMode(named: WeatherMode | null, liveAvailable: boolean): WeatherMode {
  const showable = named !== null && (named !== 'live' || liveAvailable)
  return showable ? named : defaultWeatherMode(liveAvailable)
}

/** Median terrain height of a network's stops in meters NHN (0 without heights). */
function medianStopNhn(network: PreparedNetwork): number {
  const heights: number[] = []
  for (const line of network.lines) {
    for (const stop of line.directions[0].stops) {
      if (stop.nhn !== undefined) heights.push(stop.nhn)
    }
  }
  if (heights.length === 0) return 0
  heights.sort((a, b) => a - b)
  return heights[Math.floor(heights.length / 2)]
}

/**
 * A button inside the view-control group at the lower right: the group
 * draws the frame and the glass, each button only its own hairline to the
 * one above it. Everything here has to beat the secondary variant, which
 * tailwind-merge lets the later class win.
 */
const GROUPED_CONTROL =
  'rounded-none border-t border-border/60 bg-transparent shadow-none first:border-t-0'

/**
 * The glass box a rail button sits in, whether it holds one button or
 * five. Built the same way in every case on purpose: a bordered box
 * around a borderless button is 2 px wider than the same button carrying
 * its own border, and a lone button styled by hand ended up narrower than
 * the group above it.
 */
/**
 * Where a card stands: the upper right, beside the map, on a desktop –
 * under the weather button, which keeps that corner while a card is
 * up (top-16 is its 1rem + h-9 + a 0.75rem gap) – and on a phone (under
 * Tailwind's sm, 640 px) a sheet across the foot of the screen, where a
 * thumb reaches it and the map stays in view above. The panel takes the
 * same place there and gives way while a card is up (see the panel's
 * wrapper below), and bottom-9 clears the Cesium credit line the way
 * bottom-8 does for the rail.
 */
const CARD_SLOT =
  'pointer-events-none absolute right-4 top-16 z-10 max-sm:inset-x-3 max-sm:top-auto max-sm:bottom-9'

const RAIL_BOX =
  'pointer-events-auto flex flex-col overflow-hidden rounded-md border border-border/60 bg-card/85 shadow-xs backdrop-blur-xl'

/**
 * A tooltip that also teaches the key: "Back to the city (R)". The key goes
 * on the tooltip and not on the button's aria-label – the name of a button
 * is what it does, and the keyboard tab of the About dialog is where a
 * screen reader is told the shortcuts, all of them at once.
 */
const withKey = (label: string, key: string) => `${label} (${key})`

/** What the compass button says it will do, by the quarter it aims at. */
const CARDINAL_KEY: Record<number, MessageKey> = {
  0: 'camera.faceNorth',
  90: 'camera.faceEast',
  180: 'camera.faceSouth',
  270: 'camera.faceWest',
}

/** The cities as the panel's picker lists them – static for the life of the app. */
const CITY_CHOICES: readonly CityChoice[] = CITIES.map((city) => ({
  slug: city.slug,
  name: city.name,
  modes: city.network.modes,
  ships: city.ais.enabled || city.network.modes.includes('ferry'),
}))

export default function App() {
  /**
   * The ?query options, read once. Nothing changes them while the app runs
   * – a shared view travels in the hash, which applyHash picks up – so the
   * render and the init effect can both read this one parse. First in the
   * component, because the refs and the state below seed themselves from it.
   */
  const [urlOpts] = useState(readUrlOptions)
  /**
   * What this device can afford to draw (lib/render-profile.ts), read
   * once: the map is built with it, and the numbers do not change while
   * it stands.
   */
  const [renderProfile] = useState(() => {
    const device = readDevice()
    return renderProfileFor(detectDeviceTier(device, urlOpts.tier), device.deviceMemoryGb)
  })
  /**
   * The city on the map, by slug. Changing it ends the current city
   * session (the effect below tears its layers and pollers down) and
   * starts the next one. cityTransitionRef says how the camera gets
   * there: a flight when the viewer picked the city, a jump when a link
   * or a hash edit did.
   */
  const [citySlug, setCitySlug] = useState(initialCitySlug)
  const citySlugRef = useRef(citySlug)
  const cityTransitionRef = useRef<'jump' | 'fly'>('jump')
  const city = cityBySlug(citySlug) ?? CITIES[0]
  /** The loaded data of the city on the map; null while it is on its way. */
  const [cityData, setCityData] = useState<CityData | null>(null)
  const cityDataRef = useRef<CityData | null>(null)
  /**
   * Whether the live AIS fleet is reachable at all. Without a configured
   * endpoint, in the tests, in offline mode and in a city without a
   * harbor there is no traffic for a switch to reach, and the panel
   * leaves its row out.
   *
   * ?ais=0 is deliberately NOT part of this: it decides whether the fleet
   * opens switched on, and the switch can still bring it back.
   */
  const aisAvailable =
    config.ais.url !== '' && import.meta.env.MODE !== 'test' && !urlOpts.offline && city.ais.enabled
  const aisAvailableRef = useRef(aisAvailable)
  aisAvailableRef.current = aisAvailable
  /**
   * Whether there is live weather to poll at all. Without an endpoint, in
   * the tests, offline and with ?rain=0 there is none – the scene popover
   * then offers its "Live weather" tile greyed out rather than as a
   * choice that would quietly leave the sky clear.
   */
  const liveWeatherAvailable =
    config.weather.url !== '' &&
    import.meta.env.MODE !== 'test' &&
    !urlOpts.offline &&
    urlOpts.rain

  const containerRef = useRef<HTMLDivElement>(null)
  /** The whole stage – the diagram is laid over the map inside it. */
  const stageRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<CesiumMap | null>(null)
  const linearViewRef = useRef<LinearView | null>(null)
  /** 0 = the map, 1 = the diagram; the render loop reads it per frame. */
  const morphRef = useRef(0)
  const morphFrameRef = useRef(0)
  const clockRef = useRef<SimClock | null>(null)
  const simRef = useRef<Simulation | null>(null)
  const visibleLinesRef = useRef<Set<string>>(new Set())
  const selectedIdRef = useRef<string | null>(null)
  const selectedStopIdRef = useRef<string | null>(null)
  const selectedMmsiRef = useRef<number | null>(null)
  /**
   * Latest AIS list – the one copy of it. The render loop draws from it,
   * a selected ship's card refreshes from it, and the panel switch empties
   * it when the fleet is turned back on (see handleToggleAisVessels).
   */
  const aisVesselsRef = useRef<AisVessel[]>([])
  /** The AIS poller of the city session, so the panel switch can stop and restart it. */
  const aisClientRef = useRef<AisClient | null>(null)
  /**
   * The recording of the city's harbour – the ships as they were, for a
   * clock set into the past (see lib/ais-archive.ts). Built with the
   * poller; the render loop asks it for the fleet as of the simulated
   * moment whenever that moment is far enough behind the real one.
   */
  const aisArchiveRef = useRef<AisArchiveClient | null>(null)
  /**
   * Whether the ships on the map are the recording's rather than the live
   * poll's – decided by the render loop, read by the poll's callback (a
   * live list must not close the card of a replayed ship) and by the
   * card itself, which says so and measures its fix age on the simulated
   * clock then.
   */
  const aisReplayRef = useRef(false)
  const [aisReplay, setAisReplay] = useState(false)
  /** How many ships the layer was last handed – the count the panel shows. */
  const aisFleetCountRef = useRef(0)
  /**
   * Panel switch for the AIS fleet, as the render loop reads it. Seeded
   * from ?ais=0 like the state it mirrors – a link that opens with the
   * ships off must not have the loop draw them anyway.
   */
  const showAisVesselsRef = useRef(urlOpts.ais)
  const followingRef = useRef(false)
  const snapshotsRef = useRef<VehicleSnapshot[]>([])
  /** Set by the viewer effect – selection changes write the URL immediately. */
  const writeHashRef = useRef<() => void>(() => {})
  /** Which reading is on screen – the hash and the tabs both read it here. */
  const currentViewRef = useRef<() => MapView>(() => 'surface')
  /** Picks a reading, so the viewer effect can reach selectView. */
  const selectViewRef = useRef<(view: MapView) => void>(() => {})
  /** Raises the diagram without a morph, for a link that opens into it. */
  const showLinearRef = useRef<() => void>(() => {})
  /** A boot hash asked for a reading before there was a map to show it in. */
  const pendingViewRef = useRef<MapView>('surface')
  /** Whether the map still draws the network (see setMapNetworkDrawn). */
  const mapNetworkDrawnRef = useRef(true)
  /**
   * Frames the map still owes the city it holds. A city raised behind an
   * open diagram is never drawn, and its route polylines only compile as
   * they are rendered – a big city's are over a thousand primitives. Without
   * this the map comes back empty and fills in over several seconds; with
   * it those frames are drawn into the hidden canvas instead. Counted
   * down by the render loop.
   */
  const mapWarmupRef = useRef(0)
  /** Measures the space the rows are laid out in (see linearBox). */
  const linearBoxRef = useRef<() => LinearBox>(() => ({ width: 0 }))
  /** The control panel, so the diagram can lay its rows out beside it. */
  const panelRef = useRef<HTMLDivElement>(null)
  /** The test API, so the city session can flip its ready flag. */
  const apiRef = useRef<MrtTestApi | null>(null)
  /**
   * A vehicle shared via the URL (#vehicle=…), restored as soon as its
   * trip shows up in the snapshots – it may take a moment for the
   * simulation to have it, and it may never appear (link opened while
   * the trip is not active), so the attempt expires silently.
   */
  const pendingSharedVehicleRef = useRef<string | null>(null)
  const sharedVehicleDeadlineRef = useRef(0)
  /**
   * A ship shared via the URL (#vessel=…), restored as soon as the AIS
   * poller reports her. Same mechanism as the vehicle above, with a longer
   * fuse – and it may well expire: whether she is still in the harbour is
   * not the link's to decide.
   */
  const pendingSharedVesselRef = useRef<number | null>(null)
  const sharedVesselDeadlineRef = useRef(0)
  /**
   * The sky in force: precipitation in mm and cloud cover in percent.
   * forced = not the live weather but a value set on purpose (a picked
   * sky, or the test API), which skips the near-real-time gate.
   */
  const rainRef = useRef({ mm: 0, forced: false })
  /** Cloud cover and the wind the clouds drift with (see CloudLayer). */
  const cloudRef = useRef({ percent: 0, forced: false, windSpeedMps: 0, windFromDeg: 0 })
  /**
   * What the weather client last reported, whichever sky is picked – so
   * switching back to live shows the real weather at once instead of
   * waiting out the poll interval.
   */
  const liveWeatherRef = useRef({
    precipitationMm: 0,
    cloudCoverPercent: 0,
    windSpeedMps: 0,
    windFromDeg: 0,
  })
  /** Which sky is in force (see defaultWeatherMode for what it opens on). */
  const weatherModeRef = useRef<WeatherMode>(defaultWeatherMode(liveWeatherAvailable))
  /** Rain currently visible – keeps the render loop at animation rate. */
  const rainActiveRef = useRef(false)

  const [visibleLines, setVisibleLines] = useState<Set<string>>(new Set())
  const [showRoutes, setShowRoutes] = useState(true)
  const [showStops, setShowStops] = useState(true)
  const [showLabels, setShowLabels] = useState(true)
  /** The Layers switch for the webcam pictures; the list stays either way. */
  const [showWebcams, setShowWebcams] = useState(true)
  /**
   * The switch in the weather popover for the volumetric clouds (see
   * CloudLayer). Opens on config.weather.clouds3dDefault; the URL hash
   * carries only a deviation from it.
   */
  const [showClouds, setShowClouds] = useState<boolean>(config.weather.clouds3dDefault)
  /** The city's webcams as last polled – what the panel lists. */
  const [webcams, setWebcams] = useState<Webcam[]>([])
  /**
   * The camera the city is shot with – lens, exposure, grade and the
   * miniature effect (see lib/photo-settings.ts). Only the effect's
   * on/off travels in the URL; the rest is the session's.
   */
  const [photo, setPhoto] = useState<PhotoSettings>(DEFAULT_PHOTO_SETTINGS)
  /**
   * The camera path (lib/camera-path.ts), set from the photo popover and
   * carried in the hash – a link brings its own. Whether it is being
   * flown and how far along are the map's to say (see the handlers
   * below); the refs are for the hash writer and the test API, which
   * live in the viewer effect's closures.
   */
  const [cameraPathDraft, setCameraPathDraft] = useState<CameraPathDraft>(() =>
    draftFromPath(parseCameraPathHash(window.location.hash)),
  )
  const [cameraPathPlaying, setCameraPathPlayingState] = useState(false)
  const [cameraPathProgress, setCameraPathProgressState] = useState(0)
  const cameraPath = useMemo(() => draftToPath(cameraPathDraft), [cameraPathDraft])
  const cameraPathRef = useRef(cameraPath)
  cameraPathRef.current = cameraPath
  const cameraPathDraftRef = useRef(cameraPathDraft)
  cameraPathDraftRef.current = cameraPathDraft
  // Written with the state, not mirrored from it on render: the test API
  // reads these in the same task as the click that changed them
  const cameraPathPlayingRef = useRef(false)
  const cameraPathProgressRef = useRef(0)
  const setCameraPathPlaying = useCallback((playing: boolean) => {
    cameraPathPlayingRef.current = playing
    setCameraPathPlayingState(playing)
  }, [])
  const setCameraPathProgress = useCallback((progress: number) => {
    cameraPathProgressRef.current = progress
    setCameraPathProgressState(progress)
  }, [])
  const playCameraPathRef = useRef<() => void>(() => {})
  const stopCameraPathRef = useRef<() => void>(() => {})
  /** ?play=1 flies the path once, for the city the link opened on. */
  const autoPlayedRef = useRef(false)
  const [weatherMode, setWeatherMode] = useState<WeatherMode>(weatherModeRef.current)
  /**
   * Air temperature over the city in °C, straight from the weather client
   * (every ten minutes), or null while there is none. The scene button
   * shows it whichever sky is picked – unlike the sky it is not gated on
   * the simulation clock, because it is a reading in a control rather
   * than something drawn into the scene.
   */
  const [temperatureC, setTemperatureC] = useState<number | null>(null)
  const [showAisVessels, setShowAisVessels] = useState(urlOpts.ais)
  /** H: the whole interface out of the way (see the effect below). */
  const [uiHidden, setUiHidden] = useState(false)
  /** The About dialog (press ?, or the button under the map controls). */
  const [aboutOpen, setAboutOpen] = useState(false)
  /** Cesium's credits, opened from the "Data attribution" link it draws. */
  const [creditsOpen, setCreditsOpen] = useState(false)
  /**
   * The welcome screen, the front door on a plain visit (see
   * lib/welcome.ts for when). While it is open the map is built and the
   * world loads behind it, but no city session runs – no data, no
   * vehicles, no stops, no pollers (the session effect waits for it) –
   * and no URL is written, or a reload would carry a city and walk past
   * the door. The pick starts the session at once and keeps the screen
   * up a little longer (WELCOME_LINGER_MS, see the effect below), so
   * what the screen uncovers is a city already there. The ref is for
   * the viewer effect's closures: the URL writer and the shortcuts.
   * What the boot read is read once: the screen's own state is its own
   * until the pick.
   */
  const [welcomeBoot] = useState(() => {
    const storage = browserStorage()
    return {
      open: welcomeWanted(
        window.location.pathname,
        window.location.search,
        window.location.hash,
        storage,
      ),
      hidden: welcomeHidden(storage),
    }
  })
  const [welcomePhase, setWelcomePhase] = useState<WelcomePhase>(welcomeBoot.open ? 'open' : 'closed')
  const welcomePhaseRef = useRef(welcomePhase)
  /** When the city was picked – the linger counts from here. */
  const welcomePickedAtRef = useRef(0)
  /** Whether the screen is up, asking or loading. */
  const welcomeShown = welcomePhase !== 'closed'
  /**
   * Whether it is still asking – the one phase the city session waits
   * out. A boolean of its own so the session effect, which depends on
   * it, is not run again when the screen merely goes from loading to
   * closed: that would take the city down and put it up again.
   */
  const welcomeAsking = welcomePhase === 'open'
  /**
   * A dialog is something to read, and it reads better over a bare map: for
   * as long as one is up the interface goes away exactly as H takes it, and
   * closing gives back whatever was there before.
   *
   * Derived rather than written into uiHidden, because the two mean
   * different things. H is a choice the reader made and it has to survive a
   * dialog: whoever cleared the map first, then opened this to look
   * something up, wants the map still clear afterwards, not the panel
   * springing back unasked. Pressing H while a dialog is up therefore
   * changes nothing on screen and everything after the close, which is the
   * only reading of it that keeps both meanings intact.
   *
   * The dialogs themselves are untouched by this: Radix portals them to the
   * body, so only their JSX sits inside the overlay below, never their DOM.
   */
  // The welcome screen covers everything, so nothing under it is laid
  // out or updated either – behind it the interface is not just unseen,
  // it has no city to show yet.
  const interfaceHidden = uiHidden || aboutOpen || creditsOpen || welcomeShown
  /** Lends Cesium's own credit list to the dialog while it is open. */
  const borrowCreditList = useCallback((host: HTMLElement | null) => {
    mapRef.current?.borrowCreditList(host)
  }, [])
  /** Whether the page is full screen right now – the button's face. */
  const [fullscreen, setFullscreen] = useState(false)
  /**
   * Whether this browser can go full screen at all. Read once: it is a
   * property of the browser, not of the session. False leaves the button
   * out instead of offering one that cannot work (iOS Safari).
   */
  const [fullscreenAvailable] = useState(fullscreenSupported)
  const [speed, setSpeed] = useState<number>(config.simulation.initialSpeed)
  /** The speed the keyboard steps from, without re-arming the listener. */
  const speedRef = useRef(1)
  speedRef.current = speed
  const [paused, setPaused] = useState(false)
  const [clockText, setClockText] = useState('--:--:--')
  // Nothing renders these any more – they exist so the map's basemap and
  // the realtime feed stay observable to the E2E suite (see __mrt below),
  // which is why they are refs rather than state.
  const tilesetStatusRef = useRef<TilesetStatus>('loading')
  const [selected, setSelected] = useState<VehicleSnapshot | null>(null)
  const [selectedVessel, setSelectedVessel] = useState<AisVessel | null>(null)
  /** Line whose profile card is open (id), null = none. */
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  /** The city card – the network in numbers – is up. */
  const [cityCardOpen, setCityCardOpen] = useState(false)
  /**
   * How much of the fleet is out, for the panel's counts and the city
   * card's last row. Set from the render loop's UI tick rather than
   * derived from simSeconds, because the counts have to be right with the
   * clock paused too – the first snapshot lands after the clock's last
   * change then. Null until a city's snapshots exist.
   */
  const [cityActivity, setCityActivity] = useState<CityActivity | null>(null)
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null)
  const [following, setFollowing] = useState(false)
  const realtimeStatusRef = useRef<RealtimeStatus | null>(null)
  // Top-down view (pitch ≈ -90°)? Drives the 2D/3D toggle button's face.
  const [cameraIs2D, setCameraIs2D] = useState(false)
  /**
   * Where the camera looks, in degrees clockwise from north – wound on
   * rather than wrapped to 0..360 (see windAngleTo), so the needle turns
   * the short way across north instead of unwinding the whole dial.
   * Refreshed with the rest of the UI four times a second, which the
   * needle's transition smooths into a turn.
   */
  const [cameraHeading, setCameraHeading] = useState(0)
  /** Sim clock in seconds of day – drives the vehicle card's countdown. */
  const [simSeconds, setSimSeconds] = useState(0)
  /** Underground view: tunnels solid, the surface ghosted (see CesiumMap). */
  const [underground, setUnderground] = useState(false)
  /** Same value for the render loop, which never sees the state updates. */
  const undergroundRef = useRef(false)
  /** The lines pulled straight instead of drawn on the city (see LinearView). */
  const [linear, setLinear] = useState(false)
  const linearRef = useRef(false)

  const network = cityData?.network ?? null

  /**
   * What the stop card shows about each stop: name, position, serving
   * lines, underground platform. Same aggregation the stops layer runs
   * for its names – a stop belongs to every line calling at it.
   */
  const stopInfoById = useMemo(() => {
    const byId = new Map<string, StopInfo>()
    if (!network) return byId
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
  /** Same map for the effects, which must not see a stale render's memo. */
  const stopInfoByIdRef = useRef(stopInfoById)
  stopInfoByIdRef.current = stopInfoById
  const showRoutesRef = useRef(showRoutes)
  // Mirrors for the hash writer (closures in the init effect must not see
  // stale React state): layer toggles and pause travel in the URL.
  const showStopsRef = useRef(showStops)
  const showLabelsRef = useRef(showLabels)
  const showWebcamsRef = useRef(showWebcams)
  const showCloudsRef = useRef(showClouds)
  const photoRef = useRef(photo)
  const pausedRef = useRef(paused)

  const applyRouteVisibility = useCallback(() => {
    const map = mapRef.current
    const lines = cityDataRef.current?.network.lines
    if (!map || !lines) return
    // Nothing goes back onto the map while the diagram is holding the
    // network (see setMapNetworkDrawn); it puts it back itself.
    const drawn = mapNetworkDrawnRef.current && showRoutesRef.current
    for (const line of lines) {
      map.setLineRouteVisible(line.id, drawn && visibleLinesRef.current.has(line.id))
    }
  }, [])

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
    if (id !== null) setSelectedLineId(null)
    // Selection is a discrete event – the shareable URL updates immediately
    writeHashRef.current()
    const map = mapRef.current
    map?.setSelected(id)
    linearViewRef.current?.setSelected(id)
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
   * Ship selection (click on a hull or its name label, or a #vessel= link).
   * Her MMSI goes into the URL like a trip id or a stop id does, and a
   * reload picks her up again and chases her – with the caveat the other
   * two do not have: which ships are in the harbour depends on the minute,
   * so the restore is allowed to find nothing (see pendingSharedVesselRef).
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
      mapRef.current?.setSelectedVessel(mmsi)
      writeHashRef.current()
      if (mmsi !== null) setSelectedLineId(null)
      if (mmsi === null) {
        setSelectedVessel(null)
        if (followingRef.current) {
          followingRef.current = false
          setFollowing(false)
          mapRef.current?.setFollowVessel(null)
        }
        return
      }
      // Her record comes from the fleet on the map: the recording's while
      // the clock replays it, the live list otherwise
      const fleet =
        aisReplayRef.current && aisArchiveRef.current && clockRef.current
          ? aisArchiveRef.current.vesselsAt(clockRef.current.now())
          : aisVesselsRef.current
      setSelectedVessel(fleet.find((v) => v.mmsi === mmsi) ?? null)
      if (followingRef.current) mapRef.current?.setFollowVessel(mmsi)
    },
    [selectVehicle],
  )

  /** Stop selection (click on a disc/name, or a #stop= link). */
  const selectStop = useCallback(
    (id: string | null) => {
      if (id !== null && selectedIdRef.current !== null) selectVehicle(null)
      if (id !== null && selectedMmsiRef.current !== null) selectVessel(null)
      if (id !== null) setSelectedLineId(null)
      selectedStopIdRef.current = id
      setSelectedStopId(id)
      writeHashRef.current()
    },
    [selectVehicle, selectVessel],
  )

  /**
   * The picker's way to another city: the session effect below tears the
   * current city down and the camera flies to the next one. A link or a
   * hash edit goes the same way through applyHash, only with a jump.
   */
  const selectCity = useCallback((slug: string) => {
    if (!isCitySlug(slug) || slug === citySlugRef.current) return
    cityTransitionRef.current = 'fly'
    // The numbers on the card are the old city's; the new one's are a
    // click away again once it has arrived.
    setCityCardOpen(false)
    setCitySlug(slug)
  }, [])

  /**
   * The welcome screen's choice: its checkbox is kept (or dropped), the
   * card picked gets its spinner, and the city session starts behind the
   * screen – with a jump, not a flight, since nothing is on the map yet
   * to fly away from. The map was built wearing the default city, so
   * picking that one starts the session where the camera already
   * stands. The screen itself stays up for the linger (see below). One
   * pick only: the cards are disabled from here, and a second click that
   * slips through changes nothing.
   */
  const handleWelcomePick = useCallback((slug: string, hideNextTime: boolean) => {
    if (welcomePhaseRef.current !== 'open' || !isCitySlug(slug)) return
    setWelcomeHidden(browserStorage(), hideNextTime)
    welcomePickedAtRef.current = performance.now()
    welcomePhaseRef.current = 'loading'
    setWelcomePhase('loading')
    if (slug !== citySlugRef.current) {
      cityTransitionRef.current = 'jump'
      setCitySlug(slug)
    }
  }, [])

  /**
   * The linger: the screen goes once the city's data is in and at least
   * WELCOME_LINGER_MS have passed since the pick – whichever is later –
   * so the routes, stops and the first vehicles are up before the map is
   * uncovered. A city that will not load (the ceiling) uncovers the map
   * anyway rather than holding the reader in front of a spinner.
   */
  useEffect(() => {
    if (welcomePhase !== 'loading') return
    const elapsed = performance.now() - welcomePickedAtRef.current
    const wait =
      cityData !== null
        ? Math.max(0, WELCOME_LINGER_MS - elapsed)
        : Math.max(0, WELCOME_LINGER_MAX_MS - elapsed)
    const timer = window.setTimeout(() => {
      welcomePhaseRef.current = 'closed'
      setWelcomePhase('closed')
    }, wait)
    return () => window.clearTimeout(timer)
  }, [welcomePhase, cityData])

  // The viewer: map, clock, render loop, URL persistence, test API. Built
  // once for the life of the app – the cities come and go on it (see the
  // city session effect below).
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Mirror the detected UI language for screen readers/translators
    document.documentElement.lang = getLanguage()

    // Layer/pause state restored from a shared URL. The ?paused search
    // param stays the boot flag (tests); the hash marks a user pause.
    const uiState = parseUiStateHash(window.location.hash)
    const startPaused = urlOpts.paused || uiState.paused
    const clock = new SimClock(Date.now(), urlOpts.speed)
    clockRef.current = clock
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
    if (uiState.webcamsHidden) {
      showWebcamsRef.current = false
      setShowWebcams(false)
    }
    if (uiState.clouds !== showCloudsRef.current) {
      showCloudsRef.current = uiState.clouds
      setShowClouds(uiState.clouds)
    }
    // The sky the link opens on. Through the same handler the popover
    // uses, so a picked one arrives with its rain and its cover already
    // forced – the tick reads those, not the mode.
    const bootWeather = hashWeatherMode(uiState.weather, liveWeatherAvailable)
    if (bootWeather !== weatherModeRef.current) handleWeatherMode(bootWeather)
    if (uiState.labelsHidden) {
      showLabelsRef.current = false
      setShowLabels(false)
    }
    if (uiState.tiltShift !== photoRef.current.tiltShift.enabled) {
      photoRef.current = withTiltShift(photoRef.current, uiState.tiltShift)
      setPhoto(photoRef.current)
    }
    // A shared link may open into any of the three readings. Neither of
    // the other two can go up here: the diagram has no network to lay out
    // yet, and the underground view has no map to sink.
    // A shared link may open into any of the three; both non-map readings
    // wait for the viewer below, which raises them once it is standing.
    if (uiState.view !== 'surface') pendingViewRef.current = uiState.view

    // Event-driven URL persistence: camera events debounce into one write
    // shortly after the pose settles; during sustained motion (flights,
    // chase cam) at most one write per HASH_MAX_WAIT_MS lands. replaceState
    // keeps the browser history clean. An idle map costs nothing – there is
    // no polling timer. The city and the language go into the path, the
    // rest into the hash (see lib/site-path.ts and lib/camera-hash.ts);
    // the search string is left as it came, it holds the boot options.
    let hashTimeout = 0
    let lastHashWriteAt = -Infinity
    const writeHash = () => {
      window.clearTimeout(hashTimeout)
      hashTimeout = 0
      const m = mapRef.current
      if (!m) return
      // Nothing is on the map behind the welcome screen, and a hash
      // written now would name a city the reader never picked – and skip
      // the screen on the next reload (see lib/welcome.ts). Once picked,
      // the city is theirs and the hash may say so.
      if (welcomePhaseRef.current === 'open') return
      lastHashWriteAt = performance.now()
      // While a vehicle is selected the URL carries ONLY its trip id – a
      // shared link then re-selects and follows the vehicle, no camera
      // pose needed. Without a selection the camera pose is the URL state.
      // The layer toggles and pause ride along in either form.
      const hash =
        (selectedIdRef.current
          ? formatVehicleHash(selectedIdRef.current)
          : selectedMmsiRef.current !== null
            ? formatVesselHash(selectedMmsiRef.current)
            : selectedStopIdRef.current
              ? formatStopHash(selectedStopIdRef.current)
              : formatCameraHash(m.getCameraView())) +
        formatUiStateHash({
          view: currentViewRef.current(),
          routesHidden: !showRoutesRef.current,
          stopsHidden: !showStopsRef.current,
          labelsHidden: !showLabelsRef.current,
          webcamsHidden: !showWebcamsRef.current,
          weather: weatherModeRef.current,
          clouds: showCloudsRef.current,
          tiltShift: photoRef.current.tiltShift.enabled,
          paused: pausedRef.current,
        }) +
        // The camera path rides along in either form (lib/camera-path.ts)
        formatCameraPathHash(cameraPathRef.current)
      // Every session's city, the default one included, so the address
      // bar always names the city on screen and a link copied from it
      // carries that name onward – in the language the interface speaks,
      // so the link opens the way it was seen.
      const path = formatSitePath(getLanguage(), citySlugRef.current)
      if (hash !== window.location.hash || path !== window.location.pathname) {
        window.history.replaceState(null, '', path + window.location.search + hash)
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
      city: cityBySlug(citySlugRef.current) ?? CITIES[0],
      offline: urlOpts.offline,
      renderProfile,
      // The map is built wearing the look the URL asked for (or the
      // default), so no swap has to run before the first frame.
      tiltShift: photoRef.current.tiltShift.enabled,
      clouds: showCloudsRef.current,
      fixedGroundHeight: urlOpts.groundHeight,
      maximumScreenSpaceError: urlOpts.maximumScreenSpaceError,
      maxRainDrops: urlOpts.maxRainDrops,
      onSelectVehicle: selectVehicle,
      onSelectVessel: selectVessel,
      // Windy's terms: a picture leads to its windy.com page
      onOpenWebcam: (url) => window.open(url, '_blank', 'noopener,noreferrer'),
      onSelectStop: selectStop,
      onTilesetStatus: (status) => {
        tilesetStatusRef.current = status
      },
      onCameraChanged: scheduleHashWrite,
    })
    mapRef.current = map

    // Cesium draws the "Data attribution" link itself and would raise its
    // own lightbox on it; the credits belong in the same dialog as the
    // rest of this interface (see CreditsDialog).
    map.onCreditsRequested(() => setCreditsOpen(true))

    // The diagram lives over the map inside the same stage, so the morph
    // can start from where the map has each line on screen right now.
    const stage = stageRef.current
    if (stage) {
      linearViewRef.current = new LinearView(stage, {
        onSelectVehicle: selectVehicle,
        onSelectStop: selectStop,
      })
    }
    // A narrower window – or the panel folding away – re-lays the rows
    const stageResize =
      stage && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => linearViewRef.current?.resize(linearBoxRef.current()))
        : null
    if (stage && stageResize) stageResize.observe(stage)
    if (stageResize && panelRef.current) stageResize.observe(panelRef.current)

    // Apply the layer visibility restored from the hash to the fresh map
    if (uiState.stopsHidden) map.setStopsVisible(false)
    if (uiState.labelsHidden) map.setLabelsVisible(false)
    if (uiState.webcamsHidden) map.setWebcamsVisible(false)

    // The hash IS the app state, but so far only the boot ever read it –
    // editing it in the address bar did nothing until a reload. Our own
    // writes go through replaceState, which fires no hashchange, so
    // everything arriving here comes from outside: a typed edit, a link,
    // a history step.
    const applyHash = () => {
      const hash = window.location.hash
      const ui = parseUiStateHash(hash)
      // The switches first – they mean the same in every city.
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
        map.setStopsVisible(mapNetworkDrawnRef.current && stopsVisible)
      }
      const webcamsVisible = !ui.webcamsHidden
      if (webcamsVisible !== showWebcamsRef.current) {
        showWebcamsRef.current = webcamsVisible
        setShowWebcams(webcamsVisible)
        map.setWebcamsVisible(webcamsVisible)
      }
      const wantedWeather = hashWeatherMode(ui.weather, liveWeatherAvailable)
      if (wantedWeather !== weatherModeRef.current) handleWeatherMode(wantedWeather)
      const cloudsVisible = ui.clouds
      if (cloudsVisible !== showCloudsRef.current) {
        showCloudsRef.current = cloudsVisible
        setShowClouds(cloudsVisible)
        map.setCloudsEnabled(cloudsVisible)
      }
      const labelsVisible = !ui.labelsHidden
      if (labelsVisible !== showLabelsRef.current) {
        showLabelsRef.current = labelsVisible
        setShowLabels(labelsVisible)
        map.setLabelsVisible(mapNetworkDrawnRef.current && labelsVisible)
      }
      const tiltShiftOn = ui.tiltShift
      if (tiltShiftOn !== photoRef.current.tiltShift.enabled) {
        photoRef.current = withTiltShift(photoRef.current, tiltShiftOn)
        setPhoto(photoRef.current)
        map.setPhotoSettings(photoRef.current)
      }
      // Any of the three, the same way the tabs pick them
      if (ui.view !== currentViewRef.current()) selectViewRef.current(ui.view)
      // The camera path, where the hash's differs from the one set
      const hashPath = parseCameraPathHash(hash)
      if (formatCameraPathHash(hashPath) !== formatCameraPathHash(cameraPathRef.current)) {
        setCameraPathDraft(draftFromPath(hashPath))
      }

      // The city is the path's, and an edited path is a page load, not a
      // hash change – so everything below refers to the city on screen.

      // A selection outranks a camera pose, the same order writeHash
      // builds the hash in – so a hash carrying neither clears both.
      const vehicleId = parseVehicleHash(hash)
      if (vehicleId) {
        // Same restore path as a shared link: the trip may not be in the
        // snapshots yet, so it waits for it and gives up silently.
        pendingSharedVehicleRef.current = vehicleId
        sharedVehicleDeadlineRef.current = performance.now() + SHARED_VEHICLE_TIMEOUT_MS
        return
      }
      pendingSharedVehicleRef.current = null
      const mmsi = parseVesselHash(hash)
      if (mmsi !== null) {
        // The fleet may not carry her yet – or at all any more.
        pendingSharedVesselRef.current = mmsi
        sharedVesselDeadlineRef.current = performance.now() + SHARED_VESSEL_TIMEOUT_MS
        return
      }
      pendingSharedVesselRef.current = null
      const stopId = parseStopHash(hash)
      const stop = stopId ? stopInfoByIdRef.current.get(stopId) : undefined
      if (stop) {
        selectStop(stop.id)
        map.flyToStop(stop.lon, stop.lat, stop.nhn)
        return
      }
      if (selectedIdRef.current) selectVehicle(null)
      if (selectedMmsiRef.current !== null) selectVessel(null)
      if (selectedStopIdRef.current) selectStop(null)
      const view = parseCameraHash(hash)
      // Instant, like the boot restore – an edited pose is a jump to it,
      // not a sightseeing flight. The camera fence still applies.
      if (view) map.setView(view)
    }
    window.addEventListener('hashchange', applyHash)

    /**
     * Whether the diagram has taken the map's place entirely – during the
     * morph both are on screen, so this only turns true once it is over.
     * A map that still owes its city its first frames is not hidden yet:
     * see mapWarmupRef.
     */
    const mapIsHidden = () =>
      linearRef.current && morphRef.current >= 1 && mapWarmupRef.current <= 0

    let rafId = 0
    let lastUiUpdate = 0
    let lastSimTick = 0
    // A real ship under way on screen paces ticks and rendering like a
    // tram in view does.
    let lastMovingVesselInView = false
    // Pause freezes the whole picture, ships included: the live AIS input
    // and its clock hold at the moment of pausing, so the playback stands
    // still and later polls cannot move a frozen world. Play unfreezes
    // into live data again – the display ease glides everything over.
    // The replayed fleet needs none of this: its clock is the simulated
    // one, which the pause holds by itself.
    let aisFrozen: { backdrop: AisVessel[]; atMs: number } | null = null
    /**
     * Which clock the ships are on. The recording replays a simulated
     * moment behind the real one (aisReplayWanted); the present and the
     * future are the live fleet. Decided only while the clock runs: a
     * pause holds the picture as it was, whichever source drew it, and
     * the real clock moving on underneath must not swap it out.
     */
    let aisReplaying = false
    /** Ships on the map right now – false before the first sync and while
        the panel switch is off, which is what tells the tick below that
        there is a fleet left to take down. */
    let aisDrawn = false
    let lastRender = 0
    let lastLightingMs = -Infinity
    let lastAnyVehicleInView = true
    /**
     * On-screen speed (CSS px/s) of the fastest vehicle or ship in view,
     * measured over the last tick – see map/screen-motion.ts. Drives the
     * tick rate: the ticks come as fast as they have to for the frames the
     * motion earns, and no faster.
     */
    let lastMotionPxPerSecond = 0
    let lastTickInterval = 33
    const motionThresholdPx = map.motionThresholdCssPx
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
          // The map's pacing hints – the tick rate reads them as well as
          // the render decision below. A map behind a finished diagram is
          // not worth a frame either.
          const hints =
            render && !mapIsHidden()
              ? (map.getRenderHints?.() ?? { interacting: true, tilesLoading: false })
              : null
          // Tick rate. Paused, or with nothing of either fleet in view,
          // 2 fps is plenty. Otherwise the ticks follow the motion on
          // screen: a tick is only worth taking when it can move something
          // by a visible step (motionThresholdPx, see map/screen-motion.ts),
          // so the interval is the time the fastest thing in view needs for
          // one such step – 30 fps close up, where a tram crosses many
          // pixels a second, down to 10 fps in the home view, where it
          // crawls at one pixel a second and every frame between was a
          // frame of nothing. Interaction, a chase cam and the diagram's
          // dots keep the full rate: there the camera or the picture moves
          // whatever the fleet does.
          const diagramLive =
            (linearRef.current || morphRef.current > 0) && snapshotsRef.current.length > 0
          const fleetMoving =
            !clock.paused && (lastAnyVehicleInView || lastMovingVesselInView || diagramLive)
          const tickInterval = !fleetMoving
            ? 500
            : hints?.interacting || diagramLive || map.isChasing()
              ? 33
              : Math.min(
                  100,
                  Math.max(33, (1000 * motionThresholdPx) / Math.max(1e-6, lastMotionPxPerSecond)),
                )
          lastTickInterval = tickInterval
          if (now - lastSimTick >= tickInterval) {
            const tickDtMs = Math.max(1, now - lastSimTick)
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

            // Between cities (data on its way) there is nothing to run
            const sim = simRef.current
            const snapshots = sim ? sim.snapshots() : []
            snapshotsRef.current = snapshots
            const wantAis = aisAvailableRef.current && showAisVesselsRef.current
            // The switch coming back drops whatever was frozen: it emptied
            // the vessel list with it, and a stale freeze would put the old
            // harbor back up. The upgrade below re-freezes on fresh data.
            if (wantAis && !aisDrawn) aisFrozen = null
            const aisArchive = aisArchiveRef.current
            if (!clock.paused) {
              aisReplaying = aisArchive !== null && aisReplayWanted(simMs, Date.now())
            }
            if (aisReplaying !== aisReplayRef.current) {
              aisReplayRef.current = aisReplaying
              setAisReplay(aisReplaying)
            }
            let aisBackdrop: AisVessel[]
            let aisNow: number
            // The recording, as of the simulated moment: the client keeps
            // the hours around it on hand – while the fleet is wanted at
            // all – and the layer renders it the way it renders the live
            // fleet, on the clock it is given. Until the hour of the moment
            // has been answered for, the picture that is up stays up.
            let replayed: AisVessel[] | null = null
            if (aisReplaying && aisArchive) {
              if (wantAis && !clock.paused) aisArchive.follow(simMs)
              if (aisArchive.ready(simMs)) replayed = wantAis ? aisArchive.vesselsAt(simMs) : []
            }
            if (replayed !== null) {
              aisBackdrop = replayed
              aisNow = simMs
              aisFrozen = null
            } else {
              if (clock.paused) {
                // A pause that started before the first poll upgrades once
                // when data lands – frozen, but not needlessly empty.
                if (
                  aisFrozen === null ||
                  (aisFrozen.backdrop.length === 0 && aisVesselsRef.current.length > 0)
                ) {
                  aisFrozen = { backdrop: aisVesselsRef.current, atMs: Date.now() }
                }
              } else {
                aisFrozen = null
              }
              aisBackdrop = aisFrozen?.backdrop ?? aisVesselsRef.current
              aisNow = aisFrozen?.atMs ?? Date.now()
            }
            // A map nobody can see is not worth moving the models on: the
            // first tick after the diagram closes syncs them, and that is
            // still before the frame that would show them.
            const viewInfo = mapIsHidden()
              ? null
              : map.syncVehicles(
                  snapshots,
                  mapNetworkDrawnRef.current ? visibleLinesRef.current : NO_LINES,
                )
            // The diagram reads the same snapshots on its own axis
            if (linearRef.current || morphRef.current > 0) {
              linearViewRef.current?.sync(snapshots)
            }
            // Switched off, one sync with an empty list takes the hulls,
            // their models and their names off the map; after that there is
            // nothing left to sync and the layer costs nothing per tick.
            let vesselInfo: {
              anyMovingVesselInView: boolean
              maxScreenMotionPx: number
              maxTickMotionPx: number
            } | null = null
            if (wantAis) {
              vesselInfo = map.syncVessels(aisBackdrop, aisNow)
              aisDrawn = true
            } else if (aisDrawn) {
              map.syncVessels([], aisNow)
              aisDrawn = false
            }
            aisFleetCountRef.current = wantAis ? aisBackdrop.length : 0
            // A diagram full of dots is vehicles in view, whatever the map is
            // drawing: the tick rate below is what moves them, and at the
            // 2 fps of an empty map they would step rather than run. It buys
            // no frames – a covered map is not rendered either way (see
            // mapIsHidden), this is the simulation's own rate.
            const diagramHasVehicles =
              (linearRef.current || morphRef.current > 0) && snapshots.length > 0
            lastAnyVehicleInView = (viewInfo?.anyVehicleInView ?? false) || diagramHasVehicles
            lastMovingVesselInView = !clock.paused && (vesselInfo?.anyMovingVesselInView ?? false)
            // Speed over this tick, not since the last frame: right after a
            // frame the elapsed time is a millisecond and any ratio over
            // it would read as a sprint.
            lastMotionPxPerSecond =
              (Math.max(viewInfo?.maxTickMotionPx ?? 0, vesselInfo?.maxTickMotionPx ?? 0) * 1000) /
              tickDtMs

            // After syncVehicles, so the selection highlight and the follow
            // camera find the vehicle record (setSelected/setFollow only act
            // on records that already exist). The restored vehicle starts
            // in follow mode: the link carries no camera pose, the approach
            // flight brings the viewer to the vehicle.
            const pendingSharedVehicle = pendingSharedVehicleRef.current
            if (pendingSharedVehicle) {
              if (snapshots.some((s) => s.id === pendingSharedVehicle)) {
                selectVehicle(pendingSharedVehicle)
                // A link into the diagram carries its selection too (the
                // hash holds both). There the vehicle is a dot on its row,
                // and a chase camera under a hidden map would only put the
                // Follow button and the view at odds.
                if (!linearRef.current) {
                  followingRef.current = true
                  setFollowing(true)
                  map.setFollow(pendingSharedVehicle)
                }
                pendingSharedVehicleRef.current = null
              } else if (now > sharedVehicleDeadlineRef.current) {
                pendingSharedVehicleRef.current = null
              }
            }

            // The same for a ship, and after syncVessels above for the same
            // reason. She is looked for in the fleet the layer was just
            // handed rather than in its records: a hull out of view is
            // reported all the same, and the chase brings the camera to her.
            const pendingSharedVessel = pendingSharedVesselRef.current
            if (pendingSharedVessel !== null) {
              if (aisDrawn && map.hasVessel(pendingSharedVessel)) {
                selectVessel(pendingSharedVessel)
                if (!linearRef.current) {
                  followingRef.current = true
                  setFollowing(true)
                  map.setFollowVessel(pendingSharedVessel)
                }
                pendingSharedVesselRef.current = null
              } else if (now > sharedVesselDeadlineRef.current) {
                pendingSharedVesselRef.current = null
              }
            }

            // Update UI state only ~4×/second, not every frame
            if (now - lastUiUpdate > 250) {
              lastUiUpdate = now
              setClockText(clock.formatted())
              // A replayed ship's card follows the recording the way a live
              // one follows the polls: her fix as of the simulated moment,
              // and closed once the recording has no fix for her there –
              // she has not arrived yet, or she left half an hour ago.
              const replayedMmsi = replayed !== null ? selectedMmsiRef.current : null
              if (replayedMmsi !== null) {
                const fresh = aisBackdrop.find((v) => v.mmsi === replayedMmsi) ?? null
                if (fresh === null) selectVessel(null)
                else {
                  setSelectedVessel((current) =>
                    current?.mmsi === fresh.mmsi && current.positionAt === fresh.positionAt
                      ? current
                      : fresh,
                  )
                }
              }
              // Whole seconds: every reader of this state counts minutes or
              // seconds, and the millisecond fraction only made the value
              // differ on every UI tick – four re-renders of the whole app
              // per second at real-time speed, where one is what the clock
              // shows. Same-value updates bail out inside React.
              setSimSeconds(Math.floor(clock.secondsOfDay()))
              // The fleet's counts: one pass over the snapshot list, and the
              // old state kept whenever nothing came or went (see sameActivity).
              const activity = cityDataRef.current ? buildCityActivity(snapshotsRef.current) : null
              setCityActivity((previous) => (sameActivity(previous, activity) ? previous : activity))
              const cameraView = map.getCameraView()
              setCameraIs2D(cameraView.pitch < -85)
              // Whole degrees: finer than the needle can show, and the
              // float jitter of a camera at rest would re-render the app
              // four times a second for nothing.
              setCameraHeading((wound) => windAngleTo(wound, Math.round(cameraView.heading)))
              // Rain: only with live precipitation AND a sim clock near the
              // real time – time travel must not show today's weather.
              const nearRealTime = weatherIsCurrentAt(
                clock.now(),
                Date.now(),
                config.weather.maxSimTimeDriftSeconds,
              )
              // Below ground there is no weather: no drops falling around the
              // camera, and no overcast grade on a city seen from underneath.
              const weatherVisible = !undergroundRef.current
              const rain = rainRef.current
              const rainNow =
                weatherVisible && rain.mm > 0 && (rain.forced || nearRealTime) ? rain.mm : 0
              map.setRain(rainNow)
              // Animation rate only while drops can be on screen – not with
              // the camera above the clouds the rain falls from
              rainActiveRef.current = rainNow > 0 && map.isRainVisible()
              // Same gate for the overcast grade – a grey sky is as much
              // "now" as the rain is.
              const cloud = cloudRef.current
              map.setCloudCover(
                weatherVisible && (cloud.forced || nearRealTime) ? cloud.percent : 0,
              )
              // The clouds drift with the wind on the simulated clock –
              // the layer asks for frames itself as the drift shows
              map.setWind(cloud.windSpeedMps, cloud.windFromDeg)
              map.advanceClouds(simMs)
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
          //   falling rain → ~30 fps: the drops are an animation of their
          //   own, with or without the sim
          //   only tiles streaming in → ~30 fps as well: the tile
          //   traversal (selecting, requesting, and swapping in loaded
          //   tiles) only advances once per rendered frame, and an LOD
          //   refinement is a cascade of several such rounds – at the
          //   previous 4 fps each round cost 250 ms and freshly loaded
          //   tiles visibly appeared seconds late after zooming. The
          //   streaming phase lasts a few seconds at most, then the idle
          //   states below take over again.
          //   otherwise → event-driven: the moving fleets ask for a frame
          //   through CesiumMap.requestRender() once something in view has
          //   moved by a visible step on screen (see map/screen-motion.ts)
          //   – every tick close up, every few seconds in the home view,
          //   where the vehicles used to hold the loop at 30 fps for
          //   motion of a fortieth of a pixel per frame; a camera that
          //   moved since the last frame (chase cam, leash) gets one too;
          //   one-off scene changes request theirs; apart from that only a
          //   slow heartbeat runs. A truly idle map renders nothing – even
          //   a cheap 1 fps keep-alive kept macOS GPU monitoring at ~30 %,
          //   because the utilization gauge counts any periodic activity.
          const animating = rainActiveRef.current
          const renderInterval = !hints
            ? Number.POSITIVE_INFINITY
            : hints.interacting
              ? 15
              : animating || hints.tilesLoading
                ? 33
                : 15000
          if (
            hints &&
            (map.consumeRenderRequest() ||
              map.cameraMovedSinceRender() ||
              now - lastRender >= renderInterval)
          ) {
            lastRender = now
            map.render()
            if (mapWarmupRef.current > 0) mapWarmupRef.current--
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
      ready: false,
      vehicleCount: () => snapshotsRef.current.length,
      visibleVehicleCount: () =>
        snapshotsRef.current.filter((s) => visibleLinesRef.current.has(s.lineId)).length,
      vehicles: () => snapshotsRef.current,
      setTime: (hhmm: string) => {
        const sec = parseTimeOfDay(hhmm)
        if (sec !== null) clock.setSecondsOfDay(sec)
      },
      setDate: (dateKey: string) => clock.setDate(dateKey),
      dateKey: () => clock.dateKey(),
      setSpeed: (s: number) => clock.setSpeed(s),
      setPaused: (p: boolean) => {
        clock.setPaused(p)
        pausedRef.current = p
        setPaused(p)
      },
      aisVesselCount: () => map.getVesselCount(),
      aisReplay: () => ({
        active: aisReplayRef.current,
        hours: aisArchiveRef.current?.status() ?? [],
        fleet: aisArchiveRef.current?.vesselsAt(clock.now()).length ?? 0,
      }),
      setRealtimeDelays: (delays: Record<string, number>) => {
        simRef.current?.setRealtimeDelays(new Map(Object.entries(delays)))
      },
      setRain: (precipitationMm: number) => {
        rainRef.current = { mm: precipitationMm, forced: precipitationMm > 0 }
      },
      setCloudCover: (cloudCoverPercent: number) => {
        cloudRef.current = {
          ...cloudRef.current,
          percent: cloudCoverPercent,
          forced: cloudCoverPercent > 0,
        }
      },
      rainDropsVisible: () => map.getRainDropsVisible(),
      selectVehicle,
      selectedVehicleId: () => selectedIdRef.current,
      selectStop,
      selectedStopId: () => selectedStopIdRef.current,
      selectVessel,
      selectedMmsi: () => selectedMmsiRef.current,
      vehicleScreenPosition: (id: string) => map.getVehicleScreenPosition(id),
      stopScreenPosition: (id: string) => map.getStopScreenPosition(id),
      dataSource: '',
      city: () => citySlugRef.current,
      welcomeOpen: () => welcomePhaseRef.current !== 'closed',
      setCity: selectCity,
      linear: () => linearRef.current,
      setLinear: (want: boolean) => selectViewRef.current(want ? 'linear' : 'surface'),
      tilesetStatus: () => tilesetStatusRef.current,
      realtimeStatus: () => realtimeStatusRef.current,
      lineIds: () => cityDataRef.current?.network.lines.map((l) => l.id) ?? [],
      secondsOfDay: () => clock.secondsOfDay(),
      speed: () => clock.speed,
      loopTicks: () => loopTicks,
      lastLoopError: () => lastLoopError,
      groundHeights: () => map.getGroundHeights(),
      bridgeDecks: (lineId?: string) =>
        lineId === undefined ? map.getBridgeDeckInfo() : map.getBridgeDeckDetails(lineId),
      tileMemory: () => map.getTileMemoryInfo(),
      shadowMap: () => map.getShadowMapInfo(),
      renderProfile: () => renderProfile,
      cameraPath: () => ({
        path: cameraPathRef.current,
        playing: cameraPathPlayingRef.current,
        progress: cameraPathProgressRef.current,
      }),
      setCameraPath: (path) => setCameraPathDraft(draftFromPath(path)),
      playCameraPath: () => playCameraPathRef.current(),
      stopCameraPath: () => stopCameraPathRef.current(),
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
      tiltShiftState: () => map.tiltShiftState(),
      cloudState: () => map.cloudState(),
      renderPacing: () => {
        const hints = map.getRenderHints?.() ?? { interacting: true, tilesLoading: false }
        const animating = rainActiveRef.current
        return {
          animating,
          rainActive: rainActiveRef.current,
          vehicleInView: lastAnyVehicleInView,
          vesselInView: lastMovingVesselInView,
          interacting: hints.interacting,
          tilesLoading: hints.tilesLoading,
          intervalMs: hints.interacting ? 15 : animating || hints.tilesLoading ? 33 : 15000,
          tickIntervalMs: lastTickInterval,
          motionPxPerSecond: lastMotionPxPerSecond,
        }
      },
      vehicleBoxDriftMeters: () => map.getVehicleBoxDriftMeters(),
      vehicleOpacity: (id: string) => map.getVehicleOpacity(id),
      tunnelTransition: () => {
        // Debug-only probe for E2E: step through service time until the same
        // active trip is found once inside and once outside a tunnel.
        const sim = simRef.current
        if (!sim) return null
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
    apiRef.current = api

    return () => {
      cancelAnimationFrame(rafId)
      cancelAnimationFrame(morphFrameRef.current)
      stageResize?.disconnect()
      linearViewRef.current?.destroy()
      linearViewRef.current = null
      window.clearInterval(rafWatchdog)
      window.removeEventListener('pagehide', writeHash)
      window.removeEventListener('hashchange', applyHash)
      window.clearTimeout(hashTimeout)
      writeHashRef.current = () => {}
      window.__mrt = undefined
      apiRef.current = null
      map.destroy()
      mapRef.current = null
      clockRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The city session: loads the city's data, puts its routes, stops and
  // lamps on the map, runs its simulation and pollers – and takes all of
  // it down again when the city changes or the app goes away. Declared
  // after the viewer effect so it finds the map on its first run.
  useEffect(() => {
    const map = mapRef.current
    const clock = clockRef.current
    if (!map || !clock) return
    // Behind the welcome screen the map stays bare: the world loads, the
    // city waits for the pick. Nothing was started, so there is nothing
    // to clean up until then. The pick starts the session while the
    // screen still stands (its 'loading' phase), which is the point of
    // that phase – see the linger effect above.
    if (welcomeAsking) return
    const sessionCity = cityBySlug(citySlug) ?? CITIES[0]
    citySlugRef.current = sessionCity.slug
    const transition = cityTransitionRef.current
    cityTransitionRef.current = 'jump'
    let cancelled = false

    // What the URL asked for, read before anything here writes to it.
    const bootHash = window.location.hash
    const sharedVehicle = transition === 'jump' ? parseVehicleHash(bootHash) : null
    const sharedVessel =
      transition === 'jump' && !sharedVehicle ? parseVesselHash(bootHash) : null
    const sharedStopId =
      transition === 'jump' && !sharedVehicle && sharedVessel === null
        ? parseStopHash(bootHash)
        : null

    /**
     * The map changes hands mid-flight, not at either end of it (see
     * CesiumMap.setCity). Until then the city being left keeps its
     * routes, stops, vehicles and ships, so nothing empties under a
     * camera still standing over it; from then on this city has the rest
     * of the flight to put itself up, so it is there to be seen when the
     * camera lands. The cleanup below hands the old one over rather than
     * dropping it, and here is where it goes. A jump changes hands at
     * once – there is no flight to spend.
     */
    const handoverWaiters: (() => void)[] = []
    let handedOver = transition !== 'fly'
    const handOver = () => {
      if (handedOver) return
      handedOver = true
      simRef.current = null
      snapshotsRef.current = []
      aisVesselsRef.current = []
      mapRef.current?.clearCity()
      for (const waiter of handoverWaiters.splice(0)) waiter()
    }
    /** Resolves once the map is this city's to fill – at once after a jump. */
    const whenHandedOver = () =>
      handedOver ? Promise.resolve() : new Promise<void>((resolve) => handoverWaiters.push(resolve))

    // The map was built wearing the first city; every later one is a
    // move – a flight from the picker, a jump from a link or hash edit.
    if (map.currentCity.slug !== sessionCity.slug) map.setCity(sessionCity, transition, handOver)
    else handOver()
    // A link's or an edited hash's pose belongs to this city: put the
    // camera there before the first frame rather than after the data.
    // A vehicle, ship or stop link carries no pose – those wait for what
    // they are about.
    if (transition === 'jump' && !sharedVehicle && sharedVessel === null && !sharedStopId) {
      const view = parseCameraHash(bootHash)
      if (view) map.setView(view)
    }
    document.title = t('city.title', { name: localizeCityName(sessionCity.slug, sessionCity.name) })
    rememberCity(sessionCity.slug)
    // The URL names the city at once, whichever form it is in – unless it
    // carries a selection still to be restored: writing now would replace
    // that with the camera pose, and the restore writes it back itself. A
    // camera that never moves after boot fires no change event, so the
    // first write cannot wait for one.
    if (!sharedVehicle && sharedVessel === null && !sharedStopId) writeHashRef.current()

    let realtimeClient: RealtimeClient | null = null
    let aisClient: AisClient | null = null
    let aisArchive: AisArchiveClient | null = null
    let weatherClient: WeatherClient | null = null
    let webcamsClient: WebcamsClient | null = null

    const start = async () => {
      const data = await loadCityData(sessionCity.slug)
      if (cancelled) return
      // The data is usually here before the map is free: the city being
      // left holds it until the flight is half over (see handOver above).
      await whenHandedOver()
      if (cancelled) return
      cityDataRef.current = data
      setCityData(data)

      const sim = new Simulation(data.network, clock, data.schedule ?? undefined)
      simRef.current = sim
      map.setGroundReference(medianStopNhn(data.network))

      const allLines = new Set(data.network.lines.map((l) => l.id))
      visibleLinesRef.current = allLines
      setVisibleLines(new Set(allLines))

      map.addRoutes(data.network)
      map.addStops(data.network)
      // Night-time street lighting. Nothing is built until the pools would
      // actually show, so a daytime session pays nothing for this.
      if (urlOpts.lamps && data.lamps) map.addStreetLamps(data.lamps)
      // The layer switches as they stand, applied to the fresh layers
      applyRouteVisibility()
      map.setStopsVisible(showStopsRef.current)
      map.setLabelsVisible(showLabelsRef.current)

      // GTFS-Realtime (delays from the free gtfs.de feed, filtered to this
      // city's trips): active by default, except in offline mode; ?rt=1/?rt=0
      // overrides.
      const realtimeEnabled =
        config.gtfsRealtimeUrl !== '' &&
        import.meta.env.MODE !== 'test' &&
        (urlOpts.realtime ?? !urlOpts.offline)
      if (realtimeEnabled) {
        realtimeClient = new RealtimeClient(
          cityApiUrl(config.gtfsRealtimeUrl, sessionCity.slug),
          sim.realtimeTripIdMap,
          (status, delays) => {
            sim.setRealtimeDelays(delays)
            realtimeStatusRef.current = status
          },
        )
        // Delay data changes slowly; polling every 2 minutes keeps the load
        // on the shared endpoint low (the server caches upstream for 60 s).
        realtimeClient.start(120_000)
      }

      // AIS harbor traffic (aisstream.io via /api/ais, this city's box):
      // real vessels as a backdrop, played back 4 minutes behind the wall
      // clock (see ais-extract.ts). The poller is built wherever AIS is
      // reachable at all, and started only if the fleet opens switched on
      // – ?ais=0 and the panel switch share the one state (see
      // handleToggleAisVessels).
      if (aisAvailableRef.current) {
        const simulated = sessionCity.ais.simulatedByMmsi
        aisClient = new AisClient(cityApiUrl(config.ais.url, sessionCity.slug), (_status, vessels) => {
          // The boats this map runs from a timetable sail here already –
          // drawing their AIS twins too would put two of each on one
          // crossing (see city.ais.simulatedByMmsi).
          const backdrop = vessels.filter((v) => !(String(v.mmsi) in simulated))
          aisVesselsRef.current = backdrop
          // An open ship card follows its ship's fixes; a ship that has left
          // the picture closes it rather than freezing at her last position.
          // Unless the map is replaying the recording: the card is on a
          // ship of the past then, and the render loop keeps it.
          const mmsi = aisReplayRef.current ? null : selectedMmsiRef.current
          if (mmsi !== null) {
            const fresh = backdrop.find((v) => v.mmsi === mmsi) ?? null
            if (fresh === null) selectVessel(null)
            else setSelectedVessel(fresh)
          }
        })
        aisClientRef.current = aisClient
        if (showAisVesselsRef.current) aisClient.start(config.ais.pollIntervalMs)
        // The recording of the same harbour, for a clock set into the past.
        // Pull-driven from the render loop, so it costs nothing until the
        // clock is; the same twins are left out of it.
        aisArchive = new AisArchiveClient(cityApiUrl(config.ais.url, sessionCity.slug), {
          exclude: new Set(Object.keys(simulated).map(Number)),
        })
        aisArchiveRef.current = aisArchive
      }

      // Rain overlay: live precipitation for the city (Open-Meteo).
      // Offline mode stays dry (no network, deterministic E2E tests) and
      // ?rain=0 opts out. Whether the rain is actually drawn is decided per
      // UI tick (sim time must be near the real clock).
      if (liveWeatherAvailable) {
        map.addWeatherCredit()
        weatherClient = new WeatherClient(
          config.weather.url,
          sessionCity.weather.longitude,
          sessionCity.weather.latitude,
          (status) => {
            liveWeatherRef.current = {
              precipitationMm: status.precipitationMm,
              cloudCoverPercent: status.cloudCoverPercent,
              windSpeedMps: status.windSpeedMps,
              windFromDeg: status.windFromDeg,
            }
            setTemperatureC(status.temperatureC)
            // A picked sky outranks the live one until the viewer asks for
            // it back (see handleWeatherMode).
            if (weatherModeRef.current !== 'live') return
            rainRef.current = { mm: status.precipitationMm, forced: false }
            cloudRef.current = {
              percent: status.cloudCoverPercent,
              forced: false,
              windSpeedMps: status.windSpeedMps,
              windFromDeg: status.windFromDeg,
            }
          },
        )
        weatherClient.start(config.weather.pollIntervalMs)
      }

      // Live webcams over the city (Windy via /api/webcams). Offline mode
      // has no network and the tests want a deterministic scene; ?webcams=0
      // opts out. A failed poll leaves the pictures already up in place.
      const webcamsEnabled =
        urlOpts.webcams && !urlOpts.offline && import.meta.env.MODE !== 'test'
      if (webcamsEnabled) {
        webcamsClient = new WebcamsClient(
          cityApiUrl(config.webcams.url, sessionCity.slug),
          (status, polled) => {
            if (status.state !== 'live') return
            map.syncWebcams(polled)
            setWebcams(polled)
          },
        )
        webcamsClient.start(config.webcams.pollIntervalMs)
      }

      // What the link asked for in this city, now that the city can
      // answer: a vehicle (#vehicle=…) is picked up by the render loop
      // once its trip is in the snapshots, a stop (#stop=…) opens its
      // card and flies there. Only after a jump – a flight from the
      // picker leaves the old city's pose in the hash until the camera
      // has settled, and there is no selection to restore.
      if (sharedVehicle) {
        pendingSharedVehicleRef.current = sharedVehicle
        sharedVehicleDeadlineRef.current = performance.now() + SHARED_VEHICLE_TIMEOUT_MS
      } else if (sharedVessel !== null) {
        // Waits for the AIS poller the way the vehicle waits for the
        // simulation – with the longer fuse, and prepared to find nothing.
        pendingSharedVesselRef.current = sharedVessel
        sharedVesselDeadlineRef.current = performance.now() + SHARED_VESSEL_TIMEOUT_MS
      } else if (sharedStopId) {
        // The memo of this render is stale: the data landed just now
        const stop = findStop(data.network, sharedStopId)
        if (stop) {
          selectStop(stop.id)
          map.flyToStop(stop.lon, stop.lat, stop.nhn)
        } else {
          // A stop this city does not have – the URL says so from now on
          writeHashRef.current()
        }
      }

      // A reading a shared link asked for goes up now that there is a
      // city to show it in. The diagram belongs to a network, so a city
      // switch redraws it for the one that arrived; the underground view
      // is the map's own scene and only has to be told once.
      const pending = pendingViewRef.current
      pendingViewRef.current = 'surface'
      if (pending === 'underground') {
        undergroundRef.current = true
        setUnderground(true)
        map.setUnderground(true)
      }
      if (pending === 'linear' || linearRef.current) {
        if (pending !== 'linear') linearViewRef.current?.setSeed(null)
        showLinearRef.current()
      }

      const api = apiRef.current
      if (api) {
        api.dataSource = data.network.meta.source
        api.ready = true
      }
      // ?play=1: a link that brings its own camera path flies it once the
      // city is up – once, for the city it opened on (lib/camera-path.ts)
      if (urlOpts.play && !autoPlayedRef.current && isFlyable(cameraPathRef.current)) {
        autoPlayedRef.current = true
        playCameraPathRef.current()
      }
    }
    start().catch((error) => {
      if (!cancelled) console.error(`[MiniGermany3D] Loading ${sessionCity.slug} failed:`, error)
    })

    return () => {
      cancelled = true
      realtimeClient?.stop()
      aisClient?.stop()
      aisArchive?.stop()
      weatherClient?.stop()
      webcamsClient?.stop()
      aisClientRef.current = null
      aisArchiveRef.current = null
      const api = apiRef.current
      if (api) {
        api.ready = false
        api.dataSource = ''
      }
      realtimeStatusRef.current = null
      cityDataRef.current = null
      setCityData(null)
      setWebcams([])
      pendingSharedVehicleRef.current = null
      pendingSharedVesselRef.current = null
      // What the map draws of this city – the simulation behind its
      // vehicles, the ships, the routes and stops – is handed to the
      // flight rather than dropped: it stays up until the flight to the
      // next city is half over, which is where the next session's
      // `handOver` takes it down. The transition ref still holds what
      // that session is about to read (see the body above), so it says
      // here whether a flight is coming at all; a jump has nowhere to
      // hold anything, and on unmount the viewer is gone already – its
      // cleanup ran first, leaving mapRef empty.
      const handedToFlight = cityTransitionRef.current === 'fly' && mapRef.current !== null
      if (!handedToFlight) {
        simRef.current = null
        snapshotsRef.current = []
        aisVesselsRef.current = []
        mapRef.current?.clearCity()
      }
      // A start() still waiting on a handover that will never come now
      for (const waiter of handoverWaiters.splice(0)) waiter()
      // The sky was a reading over the city that is leaving: 150 km away
      // it says nothing, and holding it would rain on the next city until
      // its own first poll lands. A picked sky is a choice about the
      // scene rather than a claim about a place, so that one stays.
      setTemperatureC(null)
      liveWeatherRef.current = {
        precipitationMm: 0,
        cloudCoverPercent: 0,
        windSpeedMps: 0,
        windFromDeg: 0,
      }
      if (weatherModeRef.current === 'live') {
        rainRef.current = { mm: 0, forced: false }
        cloudRef.current = { percent: 0, forced: false, windSpeedMps: 0, windFromDeg: 0 }
        rainActiveRef.current = false
        mapRef.current?.setRain(0)
        mapRef.current?.setCloudCover(0)
      }
      // Whatever was picked belonged to the city that is leaving
      if (selectedIdRef.current !== null) selectVehicle(null)
      if (selectedStopIdRef.current !== null) selectStop(null)
      if (selectedMmsiRef.current !== null) selectVessel(null)
      setSelectedLineId(null)
      if (followingRef.current) {
        followingRef.current = false
        setFollowing(false)
      }
      // The chase goes at once whatever happens next: a camera hanging on
      // a tram cannot also fly to another city.
      mapRef.current?.setFollow(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [citySlug, welcomeAsking])

  /**
   * Whether the map draws the network itself. It stops the moment a morph
   * starts: its routes, stops, vehicles and their names would otherwise
   * stay put on the city while their copies straighten away from them,
   * and two networks at once read as a smear rather than as one being
   * pulled straight. Nothing is lost by it – at rest the diagram's lines
   * lie exactly on the map's routes, so both handovers are invisible.
   *
   * The switches the reader set are never touched, only suspended: what
   * comes back is what the panel says, not everything.
   */
  const setMapNetworkDrawn = useCallback(
    (drawn: boolean) => {
      const map = mapRef.current
      if (!map) return
      mapNetworkDrawnRef.current = drawn
      applyRouteVisibility()
      map.setStopsVisible(drawn && showStopsRef.current)
      map.setLabelsVisible(drawn && showLabelsRef.current)
      // The vehicles go the way a switched-off line's do – see syncVehicles
      // in the render loop, which hands over an empty set meanwhile.
    },
    [applyRouteVisibility],
  )

  /**
   * The space the rows are laid out in. The control panel sits over the
   * left of the stage, so the rows start where it ends – a diagram whose
   * first third is behind a panel is not a diagram. When the panel folds
   * away, or the interface is hidden entirely, the rows take the width.
   */
  const linearBox = useCallback((): LinearBox => {
    const width = stageRef.current?.clientWidth ?? 0
    const panel = panelRef.current?.getBoundingClientRect()
    // The line badge hangs to the left of the row, so the gap has to
    // hold it as well as keep the rows off the panel.
    const clear = panel && panel.width > 0 ? panel.right + 46 : 0
    return { width, paddingLeft: Math.max(40, clear) }
  }, [])
  linearBoxRef.current = linearBox

  /**
   * Runs the transition between the two readings: 1 straightens the
   * lines, 0 lays them back onto the map. Both start from where the map
   * has each line on screen at this moment, so nothing may move the
   * camera while it runs – whatever should happen afterwards is `onDone`.
   */
  const morphTo = useCallback(
    (target: 0 | 1, onDone?: () => void) => {
      const view = linearViewRef.current
      const map = mapRef.current
      const container = containerRef.current
      const network = cityDataRef.current?.network
      if (!view || !map || !container || !network) return

      const drawn = network.lines.filter((line) => visibleLinesRef.current.has(line.id))
      view.setLines(drawn, linearBox())
      view.setSeed(
        buildLinearSeed((points) => map.projectToScreen(points), drawn, snapshotsRef.current),
      )
      view.setSelected(selectedIdRef.current)

      const from = morphRef.current
      // Drawn where it stands before it is shown: the diagram must not be
      // put on screen for even one frame in a pose it has not reached yet.
      view.setMorph(from)
      // On screen for the whole transition, either way round
      view.setActive(true)
      // The map lets go of the network now that the diagram holds a copy
      // of it, standing exactly where the map's own was.
      setMapNetworkDrawn(false)

      const started = performance.now()
      cancelAnimationFrame(morphFrameRef.current)
      const step = (now: number) => {
        const progress = Math.min(1, (now - started) / LINEAR_MORPH_MS)
        const eased = progress * progress * (3 - 2 * progress)
        const value = from + (target - from) * eased
        morphRef.current = value
        view.setMorph(value)
        // The city goes as the lines straighten, and comes back as they fold
        container.style.opacity = String(1 - value)
        if (progress < 1) {
          morphFrameRef.current = requestAnimationFrame(step)
          return
        }
        morphRef.current = target
        container.style.visibility = target === 1 ? 'hidden' : 'visible'
        if (target === 0) {
          // The lines have landed on their routes: the map takes the
          // network back where the diagram is holding it, and only then
          // does the diagram get out of the way.
          setMapNetworkDrawn(true)
          view.setActive(false)
          // A map that went unrendered while it was hidden owes a frame
          map.requestRender()
        }
        onDone?.()
      }
      container.style.visibility = 'visible'
      morphFrameRef.current = requestAnimationFrame(step)
    },
    [linearBox, setMapNetworkDrawn],
  )

  /**
   * Leaves the diagram because something was aimed at on it – a stop to
   * fly to, a vehicle to follow, a line to look at. The flight waits for
   * the lines to be back on the map: it moves the very ground the morph
   * measures itself against. Off the diagram it is simply the flight.
   */
  const leaveLinearFor = useCallback(
    (fly: () => void) => {
      if (!linearRef.current) {
        fly()
        return
      }
      linearRef.current = false
      setLinear(false)
      writeHashRef.current()
      morphTo(0, fly)
    },
    [morphTo],
  )

  /** The diagram draws the lines the panel shows – the same filter. */
  const applyLinearLines = useCallback(() => {
    const view = linearViewRef.current
    const network = cityDataRef.current?.network
    if (!view || !network || !linearRef.current) return
    view.setLines(
      network.lines.filter((line) => visibleLinesRef.current.has(line.id)),
      linearBoxRef.current(),
    )
  }, [])

  const handleToggleLine = useCallback(
    (lineId: string) => {
      setVisibleLines((prev) => {
        const next = new Set(prev)
        if (next.has(lineId)) next.delete(lineId)
        else next.add(lineId)
        visibleLinesRef.current = next
        mapRef.current?.setLineRouteVisible(
          lineId,
          mapNetworkDrawnRef.current && showRoutesRef.current && next.has(lineId),
        )
        // Stops no shown line serves disappear along with their lines
        mapRef.current?.setVisibleLines(next)
        applyLinearLines()
        return next
      })
    },
    [applyLinearLines],
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
        applyLinearLines()
        return next
      })
    },
    [applyLinearLines],
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
    // Suspended while the diagram has the network – see applyRouteVisibility
    mapRef.current?.setStopsVisible(mapNetworkDrawnRef.current && visible)
    writeHashRef.current()
  }, [])

  const handleToggleLabels = useCallback((visible: boolean) => {
    showLabelsRef.current = visible
    setShowLabels(visible)
    mapRef.current?.setLabelsVisible(mapNetworkDrawnRef.current && visible)
    writeHashRef.current()
  }, [])

  /** The clouds switch in the weather popover – a deviation from the default rides in the hash. */
  const handleToggleClouds = useCallback((visible: boolean) => {
    showCloudsRef.current = visible
    setShowClouds(visible)
    mapRef.current?.setCloudsEnabled(visible)
    writeHashRef.current()
  }, [])

  const handleToggleWebcams = useCallback((visible: boolean) => {
    showWebcamsRef.current = visible
    setShowWebcams(visible)
    mapRef.current?.setWebcamsVisible(visible)
    writeHashRef.current()
  }, [])

  /**
   * A camera in the panel's list: the map flies to its picture. Switched
   * off, the pictures come back on first – flying to one nobody can see
   * would be a flight to nothing.
   */
  const handleFlyToWebcam = useCallback(
    (id: number) => {
      if (!showWebcamsRef.current) handleToggleWebcams(true)
      if (followingRef.current) {
        followingRef.current = false
        setFollowing(false)
        mapRef.current?.setFollow(null)
      }
      leaveLinearFor(() => mapRef.current?.flyToWebcam(id))
    },
    [handleToggleWebcams, leaveLinearFor],
  )

  /** What the layers popover lists per camera – the array identity only changes with a poll. */
  const webcamChoices = useMemo<WebcamChoice[]>(
    () => webcams.map((webcam) => ({ id: webcam.id, title: webcam.title })),
    [webcams],
  )

  /** A knob turned in the photo popover – the whole settings object comes back. */
  const handlePhotoChange = useCallback((settings: PhotoSettings) => {
    photoRef.current = settings
    setPhoto(settings)
    mapRef.current?.setPhotoSettings(settings)
    // Only the miniature switch is in the hash; the writer skips a URL
    // that has not changed.
    writeHashRef.current()
  }, [])

  /**
   * Which sky to show. A picked one is written straight into the values
   * the UI tick reads, marked as set on purpose so it survives a
   * time-traveled clock; live puts the weather client's latest reading
   * back, whatever the sky was in between. The map is not touched here –
   * the tick applies both values a few times a second, and it is also
   * what keeps the sky off while the camera sits underground.
   */
  const handleWeatherMode = useCallback((mode: WeatherMode) => {
    weatherModeRef.current = mode
    setWeatherMode(mode)
    if (mode === 'live') {
      const live = liveWeatherRef.current
      rainRef.current = { mm: live.precipitationMm, forced: false }
      cloudRef.current = {
        percent: live.cloudCoverPercent,
        forced: false,
        windSpeedMps: live.windSpeedMps,
        windFromDeg: live.windFromDeg,
      }
    } else {
      const preset = WEATHER_PRESETS[mode]
      rainRef.current = { mm: preset.precipitationMm, forced: true }
      cloudRef.current = {
        percent: preset.cloudCoverPercent,
        forced: true,
        windSpeedMps: preset.windSpeedMps,
        windFromDeg: preset.windFromDeg,
      }
    }
    // The sky is in the URL, so a link shows the city under the one it
    // was copied from – the writer skips a hash that has not changed.
    writeHashRef.current()
  }, [])

  /** What the compass button will do from here (see CARDINAL_KEY). */
  const alignHeadingLabel = t(CARDINAL_KEY[nextQuarterHeading(cameraHeading)])

  const handleSpeedChange = useCallback((value: number) => {
    setSpeed(value)
    clockRef.current?.setSpeed(value)
  }, [])

  const handleTogglePause = useCallback(() => {
    setPaused((prev) => {
      const next = !prev
      // Play carries on from the simulated moment – a time set by hand
      // survives a pause. "Now" is the way back to the real time. The AIS
      // ships hold with the rest: the live ones frozen by the render loop,
      // the replayed ones by the simulated clock they are on.
      clockRef.current?.setPaused(next)
      pausedRef.current = next
      writeHashRef.current()
      return next
    })
  }, [])

  /**
   * The AIS fleet on or off. Off stops the polling along with the drawing –
   * a layer nobody is looking at has no business calling the endpoint every
   * ten seconds – and closes an open ship card, whose ship is about to leave
   * the map.
   *
   * On, the list in hand is dropped first. It is as old as the switch was
   * off, and an AIS fix stays drawable for half an hour (AIS_EXPIRE_MS), so
   * keeping it would raise a harbor full of ghosts for one poll interval.
   * Empty water for a few seconds is the honest picture.
   */
  const handleToggleAisVessels = useCallback(
    (visible: boolean) => {
      showAisVesselsRef.current = visible
      setShowAisVessels(visible)
      if (visible) {
        aisVesselsRef.current = []
        aisClientRef.current?.start(config.ais.pollIntervalMs)
      } else {
        aisClientRef.current?.stop()
        if (selectedMmsiRef.current !== null) selectVessel(null)
      }
    },
    [selectVessel],
  )

  /**
   * Full screen is state the browser owns: Escape and F11 change it behind
   * the app's back, so the button's face comes from the change event
   * rather than from what was last clicked.
   */
  useEffect(() => {
    const sync = () => setFullscreen(fullscreenElement() !== null)
    sync()
    return onFullscreenChange(sync)
  }, [])

  const handleToggleFullscreen = useCallback(() => {
    // The whole page, so the map and the interface over it fill the screen
    // together. A refused request is the helper's business, not this one's.
    void toggleFullscreen(document.documentElement)
  }, [])

  const handleSetTime = useCallback((hhmm: string) => {
    const sec = parseTimeOfDay(hhmm)
    if (sec !== null) clockRef.current?.setSecondsOfDay(sec)
  }, [])

  const handleSetDate = useCallback((dateKey: string) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) clockRef.current?.setDate(dateKey)
  }, [])

  const handleResetTime = useCallback(() => {
    const clock = clockRef.current
    if (!clock) return
    clock.resetToRealTime()
    // "Now" means now at real pace: a time-lapse left running would race
    // away from the moment just jumped to before it could be looked at.
    if (clock.speed !== 1) {
      clock.setSpeed(1)
      setSpeed(1)
    }
  }, [])

  const handleToggleFollow = useCallback(() => {
    const id = selectedIdRef.current
    const mmsi = selectedMmsiRef.current
    if (id === null && mmsi === null) return
    const next = !followingRef.current
    followingRef.current = next
    setFollowing(next)
    // Chasing a vehicle is something to watch, so it brings the map back
    const chase = () => {
      if (mmsi !== null) mapRef.current?.setFollowVessel(next ? mmsi : null)
      else mapRef.current?.setFollow(next && id !== null ? id : null)
    }
    if (next) leaveLinearFor(chase)
    else chase()
  }, [leaveLinearFor])

  /**
   * The camera path (lib/camera-path.ts) as the photo popover drives it.
   * Flying it, or standing on one of its keyframes, lets go of a follow
   * – a camera cannot chase a tram and dolly at once – and of the
   * diagram, which has no camera to move. The map drops the path itself
   * for a drag, a follow or the next city (see CesiumMap.playCameraPath)
   * and says so through onEnd, which is how the play button knows.
   *
   * Each of these writes the hash itself once the camera stands: the
   * writer otherwise waits for Cesium's moveEnd, which needs frames after
   * the motion – and after a flight set per frame the loop draws none
   * until its heartbeat, so the pose the link would carry was a moment
   * of the flight, not its end.
   */
  const releaseFollowForPath = useCallback(() => {
    if (followingRef.current) handleToggleFollow()
  }, [handleToggleFollow])
  const handleSetCameraKeyframe = useCallback((which: 'start' | 'end') => {
    const view = mapRef.current?.getCameraView()
    if (!view) return
    setCameraPathDraft((draft) => ({ ...draft, [which]: view }))
  }, [])
  const handleGoToCameraKeyframe = useCallback(
    (which: 'start' | 'end') => {
      const view = cameraPathDraftRef.current[which]
      const map = mapRef.current
      if (!view || !map) return
      map.stopCameraPath()
      releaseFollowForPath()
      leaveLinearFor(() => {
        map.setView(view)
        writeHashRef.current()
      })
      setCameraPathProgress(which === 'start' ? 0 : 1)
    },
    [leaveLinearFor, releaseFollowForPath],
  )
  const handlePlayCameraPath = useCallback(() => {
    const path = cameraPathRef.current
    const map = mapRef.current
    if (!map || !isFlyable(path)) return
    releaseFollowForPath()
    leaveLinearFor(() => {
      // The slider follows at 2 % steps – fifty renders a flight, not one a frame
      let reported = -1
      map.playCameraPath(path, {
        onProgress: (t) => {
          if (t >= reported + 0.02 || t >= 1) {
            reported = t
            setCameraPathProgress(t)
          }
        },
        onEnd: () => {
          setCameraPathPlaying(false)
          writeHashRef.current()
        },
      })
      setCameraPathPlaying(true)
    })
  }, [leaveLinearFor, releaseFollowForPath])
  const handleStopCameraPath = useCallback(() => {
    mapRef.current?.stopCameraPath()
    setCameraPathPlaying(false)
  }, [])
  const handleScrubCameraPath = useCallback(
    (t: number) => {
      const path = cameraPathRef.current
      const map = mapRef.current
      if (!map || !isFlyable(path)) return
      releaseFollowForPath()
      leaveLinearFor(() => {
        map.scrubCameraPath(path, t)
        writeHashRef.current()
      })
      setCameraPathPlaying(false)
      setCameraPathProgress(t)
    },
    [leaveLinearFor, releaseFollowForPath],
  )
  const handleCameraPathDuration = useCallback((durationS: number) => {
    setCameraPathDraft((draft) => ({ ...draft, durationS }))
  }, [])
  const handleCameraPathEase = useCallback((ease: CameraPathEase) => {
    setCameraPathDraft((draft) => ({ ...draft, ease }))
  }, [])
  const handleClearCameraPath = useCallback(() => {
    mapRef.current?.stopCameraPath()
    setCameraPathPlaying(false)
    setCameraPathProgress(0)
    setCameraPathDraft((draft) => ({ ...draft, start: null, end: null }))
  }, [])
  playCameraPathRef.current = handlePlayCameraPath
  stopCameraPathRef.current = handleStopCameraPath
  // A path set or cleared is a change to the URL that no camera event
  // announces, so the hash is written here
  useEffect(() => {
    writeHashRef.current()
  }, [cameraPath])
  const cameraPathControls: CameraPathControls = {
    ...cameraPathDraft,
    playing: cameraPathPlaying,
    progress: cameraPathProgress,
    onSetKeyframe: handleSetCameraKeyframe,
    onGoTo: handleGoToCameraKeyframe,
    onDurationChange: handleCameraPathDuration,
    onEaseChange: handleCameraPathEase,
    onPlay: handlePlayCameraPath,
    onStop: handleStopCameraPath,
    onScrub: handleScrubCameraPath,
    onClear: handleClearCameraPath,
  }

  const handleResetCamera = useCallback(() => {
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      mapRef.current?.setFollow(null)
      mapRef.current?.setFollowVessel(null)
    }
    mapRef.current?.setCameraHome(true)
  }, [])

  /**
   * The map becomes the diagram and back. Both readings share one
   * number – the distance along the route – so the switch is a morph
   * rather than a cut (see map/LinearView.ts and morphTo above).
   *
   * Both directions put the camera somewhere first or afterwards, and
   * never during: on the way in it climbs straight above the city and
   * only then do the lines straighten, because a line the camera does
   * not have on screen has no position to leave from; on the way out the
   * lines fold back onto the map they were taken off, and the camera
   * flies home once they are down.
   */
  /** Down among the tunnels, or back up – the map's own scene, not the diagram's. */
  const setUndergroundView = useCallback((want: boolean) => {
    if (want === undergroundRef.current) return
    undergroundRef.current = want
    setUnderground(want)
    mapRef.current?.setUnderground(want)
    // Which reading is on screen travels in the URL, and this one moves
    // no camera – without saying so here, nothing would ever write it.
    writeHashRef.current()
  }, [])

  /** Raises the diagram: the climb to the plan view, then the morph. */
  const enterLinear = useCallback(() => {
    const map = mapRef.current
    if (!map || !linearViewRef.current || !cityDataRef.current) return
    linearRef.current = true
    setLinear(true)
    writeHashRef.current()

    // Following a vehicle steers the camera, and the camera is what the
    // morph is measured against – let go of it before anything moves.
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      map.setFollow(null)
      map.setFollowVessel(null)
    }

    // The plan is of the lines the diagram is about to draw, not of the city
    map.flyToCityPlan(visibleLinesRef.current, () => {
      // Switched away again while the camera was still climbing – that
      // press has drawn its own conclusion.
      if (linearRef.current) morphTo(1)
    })
  }, [morphTo])

  /**
   * Puts one of the three readings on screen. Which one is current is
   * state rather than a guess, and the tabs read it back the same way.
   *
   * Leaving the diagram always waits for the lines to be down on the map
   * before the camera moves – the morph is measured against that ground
   * (see morphTo) – and only then does the camera go where the press was
   * aiming: home for the surface, under the city for the tunnels.
   */
  const selectView = useCallback(
    (next: MapView) => {
      const current = currentViewRef.current()
      if (next === current) return
      if (current === 'linear') {
        leaveLinearFor(() => {
          // The scene first, so the flight lands in the reading that was
          // asked for rather than arriving and then changing.
          if (next === 'underground') setUndergroundView(true)
          // Home either way. The plan view the diagram was left on is
          // 25 km straight down – a working position, not a place to be
          // put down in, and under the city it sees nothing at all.
          mapRef.current?.setCameraHome()
        })
        return
      }
      if (next === 'linear') {
        // The diagram lays its rows out for a wide screen and is not
        // offered on a phone (see VIEW_TABS); a link that asks for it
        // there gets the map.
        if (narrowViewport()) return
        // A diagram of the network has no above and below to stand in
        setUndergroundView(false)
        enterLinear()
        return
      }
      setUndergroundView(next === 'underground')
    },
    [enterLinear, leaveLinearFor, setUndergroundView],
  )

  // The hash, the tabs and the test API all reach the readings through these
  currentViewRef.current = () =>
    linearRef.current ? 'linear' : undergroundRef.current ? 'underground' : 'surface'
  selectViewRef.current = selectView

  /**
   * The diagram, already finished. A link that opens into it has no map
   * pose worth morphing from, and a city switch has a network that never
   * was on the map – both want the end state, not the transition.
   */
  const showLinear = useCallback(() => {
    const view = linearViewRef.current
    const container = containerRef.current
    const network = cityDataRef.current?.network
    if (!view || !container || !network) return
    linearRef.current = true
    setLinear(true)
    // The map under a raised diagram is the plan view too, so coming back
    // from a shared link lands where pressing the switch would have. No
    // flight: nobody is watching this one.
    mapRef.current?.flyToCityPlan(visibleLinesRef.current, undefined, false)
    // This city has never been on screen – let the map draw itself behind
    // the diagram, so it is finished when the reader comes back to it.
    mapWarmupRef.current = LINEAR_MAP_WARMUP_FRAMES
    cancelAnimationFrame(morphFrameRef.current)
    view.setLines(
      network.lines.filter((line) => visibleLinesRef.current.has(line.id)),
      linearBox(),
    )
    view.setSeed(null)
    view.setSelected(selectedIdRef.current)
    view.setActive(true)
    setMapNetworkDrawn(false)
    morphRef.current = 1
    view.setMorph(1)
    container.style.opacity = '0'
    container.style.visibility = 'hidden'
  }, [linearBox, setMapNetworkDrawn])
  showLinearRef.current = showLinear


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

  /**
   * The compass button: brings the view onto the nearest quarter – north,
   * east, south or west – and on to the next one when it already stands
   * on one, so pressing on walks the map round the dial. The heading comes
   * from the camera rather than from the state behind the needle, which
   * trails it by up to a quarter second and would aim at the wrong
   * quarter mid-turn.
   */
  const handleAlignHeading = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    if (followingRef.current) {
      followingRef.current = false
      setFollowing(false)
      map.setFollow(null)
    }
    map.setCameraOrientation({ headingDeg: nextQuarterHeading(map.getCameraView().heading) })
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
      leaveLinearFor(() => mapRef.current?.setFollow(tripId))
    },
    [selectVehicle, leaveLinearFor],
  )

  /** Fly the camera to a stop of the selected vehicle's trip. */
  const handleFlyToStop = useCallback(
    (stop: { lon: number; lat: number; nhn?: number }) => {
      const map = mapRef.current
      if (!map) return
      // A camera flight and the follow chase would fight – stop following
      if (followingRef.current) {
        followingRef.current = false
        setFollowing(false)
        map.setFollow(null)
      }
      // Flying somewhere means wanting to see it, which the diagram cannot
      leaveLinearFor(() => map.flyToStop(stop.lon, stop.lat, stop.nhn))
    },
    [leaveLinearFor],
  )

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
      // Same as a stop: the flight and the route pulse are on the map
      leaveLinearFor(() => mapRef.current?.focusLine(lineId))
      // The flight and the pulse say WHERE the line runs; the card says
      // what it is. One selection at a time, like the other three cards.
      selectVehicle(null)
      selectStop(null)
      selectVessel(null)
      setSelectedLineId(lineId)
    },
    [handleSetLinesVisible, leaveLinearFor, selectStop, selectVehicle, selectVessel],
  )

  /**
   * Where a passenger can change at each stop – including the platforms a
   * short walk away, which at a junction carry the interesting lines (see
   * src/lib/interchange.ts). The vehicle card reads its badges out of it.
   */
  const interchangeByStop = useMemo(
    () =>
      network
        ? buildInterchangeIndex(network, config.interchangeRadiusMeters)
        : new Map<string, never[]>(),
    [network],
  )

  /**
   * Profile of the selected line. Pure geometry and timetable arithmetic
   * over data that does not change while the city is on the map, so it is
   * computed once per selection rather than per tick.
   */
  const selectedLine = useMemo(
    () => (selectedLineId && network ? (network.lineById.get(selectedLineId) ?? null) : null),
    [network, selectedLineId],
  )
  const schedule = cityData?.schedule ?? EMPTY_SCHEDULE
  const lineProfile = useMemo(
    () => (selectedLine ? buildLineProfile(selectedLine, schedule) : null),
    [selectedLine, schedule],
  )

  /**
   * What the line is doing now. Unlike the profile this rides the UI tick
   * (simSeconds, ~4×/s) – a filter over the snapshot list the app already
   * has, plus one departure query per terminus.
   */
  const lineActivity = useMemo(
    () =>
      selectedLine
        ? buildLineActivity(selectedLine, schedule, snapshotsRef.current, simSeconds)
        : null,
    [selectedLine, schedule, simSeconds],
  )

  /**
   * The city in numbers: the line profile's arithmetic over every line at
   * once, computed once per city. (What the fleet is doing is
   * `cityActivity`, set from the render loop.)
   */
  const cityProfile = useMemo(
    () => (network ? buildCityProfile(network, schedule) : null),
    [network, schedule],
  )
  /** The longest line as the panel lists it, for the city card's link to it. */
  const longestLine = useMemo(() => {
    const line = cityProfile?.longest ? network?.lineById.get(cityProfile.longest.lineId) : undefined
    return line ? { id: line.id, name: localizeLineName(line.name), color: line.color } : null
  }, [cityProfile, network])

  // Stable across the 4×/s clock re-renders so the memoized line list in the
  // ControlPanel can bail out; only rebuilt when a line is toggled.
  const lineInfos: LineToggleInfo[] = useMemo(
    () =>
      (network?.lines ?? []).map((line) => ({
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

  const offlineMode = urlOpts.offline
  /**
   * Which card holds the upper right corner, at most one of them: a line
   * outranks a ship, a ship a stop, a stop nothing. Named here rather than
   * spelled into the JSX four times, because the scene button asks the
   * same question – it stands in that corner and gives it up when a card
   * comes for it.
   */
  /**
   * Escape, and the click on empty map it stands for: whichever card is
   * open goes away and the camera stops riding along. One key for all
   * four cards – a reader who wants out does not care which of them is
   * up.
   */
  const handleDismiss = useCallback(() => {
    setCityCardOpen(false)
    setSelectedLineId(null)
    if (selectedIdRef.current !== null) selectVehicle(null)
    if (selectedMmsiRef.current !== null) selectVessel(null)
    if (selectedStopIdRef.current !== null) selectStop(null)
  }, [selectStop, selectVehicle, selectVessel])

  /** The miniature lens on and off – the switch in the photo popover. */
  const handleToggleMiniature = useCallback(() => {
    handlePhotoChange(withTiltShift(photoRef.current, !photoRef.current.tiltShift.enabled))
  }, [handlePhotoChange])

  /**
   * The time-lapse a step up or down. The slider is continuous (1–120),
   * the keyboard walks the speeds worth stopping at: from where it stands
   * to the next one in that direction, so a slider left at ×7 still moves
   * to ×10 rather than snapping somewhere behind it.
   */
  const handleStepSpeed = useCallback(
    (direction: 1 | -1) => {
      const next =
        direction > 0
          ? (SPEED_STEPS.find((step) => step > speedRef.current) ?? SPEED_STEPS[SPEED_STEPS.length - 1])
          : ([...SPEED_STEPS].reverse().find((step) => step < speedRef.current) ?? SPEED_STEPS[0])
      handleSpeedChange(next)
    },
    [handleSpeedChange],
  )

  const lineCard = selectedLine !== null && lineProfile !== null
  const vesselCard = !lineCard && selectedLine === null && selectedVessel !== null
  const vehicleCard = selected !== null && selectedLine === null
  const stopCard = !vehicleCard && !vesselCard && selectedLine === null && selectedStop !== null
  const selectionCard = lineCard || vesselCard || vehicleCard || stopCard
  // The city card ranks below every selection: picking anything on the map
  // or in the panel takes its corner, and takes the card down for good
  // rather than leaving it to reappear when the selection goes (see the
  // effect below).
  const cityCard = cityCardOpen && !selectionCard && cityProfile !== null
  const cardOpen = selectionCard || cityCard
  useEffect(() => {
    if (selectionCard) setCityCardOpen(false)
  }, [selectionCard])

  /**
   * The info button in the panel's head: the city card up, or down again
   * on a second press. Up, it takes the corner from whatever selection
   * holds it – the button was pressed for the numbers, not for the
   * vehicle that happened to be selected.
   */
  const handleShowCityFacts = useCallback(() => {
    if (cityCardOpen) {
      setCityCardOpen(false)
      return
    }
    handleDismiss()
    setCityCardOpen(true)
  }, [cityCardOpen, handleDismiss])

  /** Which tab stands lit – the same three-way state selectView acts on. */
  const mapView: MapView = linear ? 'linear' : underground ? 'underground' : 'surface'

  /**
   * The bare keys. Every one of them is the keyboard's way to a control
   * that is on screen anyway, named by the first letter of what it does
   * in English: Space pauses, S/U/L pick the three readings of the
   * network, F goes full screen, R puts the camera on the city's home
   * view, N returns to the real time, C turns to the next quarter, M is
   * the miniature lens, 2 and 3 the flat and the tilted view, + and −
   * step the time-lapse, H takes the interface away, Escape closes
   * whichever card is open, and ? lists the lot.
   *
   * Bare letters rather than modifier combinations, because there is no
   * modifier combination that is free everywhere. Ctrl+Shift+letter is
   * crowded in both Chrome and Firefox, differently per browser, per
   * platform and per installed extension – Ctrl+Shift+H itself opens
   * Firefox's history library. Browsers reserve almost no unmodified
   * letters, so a bare key sidesteps that whole class, and it costs the
   * same keystroke on every keyboard layout. Not Tab, which every
   * creative tool uses to hide its interface: in a browser Tab is how the
   * keyboard reaches the switches and buttons in the panel, and taking it
   * would shut those users out. Shift is refused on a letter (Shift+H is
   * somebody else's shortcut, and the caps-lock H arrives without it) but
   * allowed on ? and +, which most layouts cannot type without it.
   *
   * Space is the one key that has to give way. On a focused button,
   * switch or tab it IS the click – taking it there would leave the
   * keyboard unable to work the interface – so it pauses only where the
   * focus is on nothing that uses it. Checked by what the focus is rather
   * than by "is it the page", because a click on the map leaves the focus
   * on Cesium's canvas, which is exactly where the pause has to work.
   *
   * What the MAP draws is deliberately untouched by H – stop names,
   * vehicle numbers, ship names and routes all live in the WebGL scene
   * rather than in the DOM, and the Layers switches are what turn those
   * off. Cesium's credit line stays for the same reason plus a better
   * one: it belongs to the map widget, and the Google and Cesium terms
   * want it visible wherever their data is (see README, "Attribution").
   *
   * Neither the hidden interface nor the shortcut list is persisted in
   * the URL. A shared link that opened with no interface would leave the
   * recipient hunting for a shortcut nobody told them about; a reload is
   * the way back for anyone who forgets it here. A pause is persisted,
   * because a link to a held moment is a picture worth sharing (see
   * writeHash).
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // With a modifier this is somebody else's shortcut, and a held key
      // would flicker rather than toggle.
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.repeat) return
      // The welcome screen has no map behind it for a key to act on
      if (welcomePhaseRef.current !== 'closed') return
      // key, not code: the shortcut is the character as the reader sees it
      // on the keycap. On Dvorak the physical KeyH carries a D, and hiding
      // the interface on D would be a surprise nobody asked for.
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
      if (event.shiftKey && !SHIFTED_SHORTCUTS.has(key)) return
      const pause = key === ' ' || key === 'spacebar'
      if (!pause && !KEY_SHORTCUTS.has(key)) return
      // Where a letter means a letter, it is not a shortcut. Only the time
      // field qualifies today, and it refuses typing anyway, but a bare key
      // has to check rather than assume that stays true.
      const target = event.target as HTMLElement | null
      if (target?.isContentEditable) return
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (pause && usesSpaceItself(target)) return
      // Escape belongs to whatever is open on top: the popovers, the
      // picker, the calendar and the shortcut dialog all close themselves
      // on it, and only when none of them is up does it reach the cards.
      if (
        key === 'Escape' &&
        document.querySelector('[data-slot="popover-content"], [data-slot="dialog-content"]')
      ) {
        return
      }
      // Nothing of the browser's own hangs on a bare letter, except
      // Firefox's opt-in type-ahead find; Space would scroll the page.
      event.preventDefault()
      if (pause) handleTogglePause()
      else if (key === 'Escape') handleDismiss()
      else if (key === '?') setAboutOpen((open) => !open)
      else if (key === 'h') setUiHidden((hidden) => !hidden)
      else if (key === 'f') {
        // Left out where the browser has no Fullscreen API (iOS Safari),
        // exactly as the button is.
        if (fullscreenAvailable) handleToggleFullscreen()
      } else if (key === 'r') handleResetCamera()
      else if (key === 'n') handleResetTime()
      else if (key === 'c') handleAlignHeading()
      else if (key === 'm') handleToggleMiniature()
      else if (key === '2' || key === '3') {
        // The digit says which view to be in, not which way to flip: 2
        // twice leaves the map flat rather than tipping it back up.
        if (cameraIs2D !== (key === '2')) handleToggleViewMode()
      } else if (key === '+' || key === '=') handleStepSpeed(1)
      else if (key === '-' || key === '_') handleStepSpeed(-1)
      else selectView(key === 'u' ? 'underground' : key === 'l' ? 'linear' : 'surface')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    cameraIs2D,
    fullscreenAvailable,
    handleAlignHeading,
    handleDismiss,
    handleResetCamera,
    handleResetTime,
    handleStepSpeed,
    handleToggleFullscreen,
    handleToggleMiniature,
    handleTogglePause,
    handleToggleViewMode,
    selectView,
  ])

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-background${offlineMode ? ' panels-opaque' : ''}`}
    >
      <div ref={containerRef} className="absolute inset-0" data-testid="cesium-container" />

      {/* The diagram mounts in here (see map/LinearView.ts): over the map,
          under the interface, and the full width the rows are laid out
          for. Clicks pass through until the diagram itself takes them. */}
      <div
        ref={stageRef}
        className="pointer-events-none absolute inset-0 z-[5]"
        data-testid="linear-stage"
      />

      {/* Everything the app draws over the map, in one wrapper so H can
          take the interface away in a single stroke (see the effect above). display:contents keeps the wrapper out of the
          layout – each overlay below still positions against the map
          container exactly as it did – and switching it to display:none
          hides all of them at once without unmounting any: the panel keeps
          whether it was collapsed, an open card stays open, and the time
          field keeps what was picked in it. */}
      {/* The front door: a city to choose before anything of one is on
          the map. Outside the wrapper below on purpose – it is not
          interface over the map but what hides the interface, and Radix
          portals it to the body either way (see WelcomeScreen). */}
      <WelcomeScreen
        open={welcomeShown}
        picked={welcomePhase === 'loading' ? citySlug : null}
        cities={CITY_CHOICES}
        hideNextTime={welcomeBoot.hidden}
        onPick={handleWelcomePick}
      />

      <div className={cn('contents', interfaceHidden && 'hidden')} data-testid="ui-overlay">
        {/* The framing guides from the photo popover – thirds, the way a
            phone camera draws them. Inside this wrapper on purpose: they
            are a guide for composing the shot, not part of it, so H takes
            them away with everything else a moment before the shutter.
            Hairlines with a dark halo, because they have to read over a
            white roof and over water in the same frame. */}
        {photo.grid && (
          <div
            aria-hidden
            data-testid="photo-grid"
            className="pointer-events-none absolute inset-0 z-[6]"
          >
            {[1, 2].map((third) => (
              <div
                key={`v${third}`}
                className="absolute inset-y-0 w-px bg-white/50 shadow-[0_0_2px_oklch(0_0_0_/_0.55)]"
                style={{ left: `${(third * 100) / 3}%` }}
              />
            ))}
            {[1, 2].map((third) => (
              <div
                key={`h${third}`}
                className="absolute inset-x-0 h-px bg-white/50 shadow-[0_0_2px_oklch(0_0_0_/_0.55)]"
                style={{ top: `${(third * 100) / 3}%` }}
              />
            ))}
          </div>
        )}

        {/* What this map is and is not, with the keyboard at the end –
            opened with ? or the question mark under the map controls,
            dismissed with ?, Escape, the close button or a click outside.
            Its JSX sits here, its DOM does not: Radix portals a dialog to
            the body, which is what lets opening one hide this wrapper –
            the map is left bare behind the dialog rather than under it. */}
        <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />

        {/* The credits behind Cesium's "Data attribution" link, in this
            interface's dialog rather than in Cesium's own lightbox. */}
        <CreditsDialog
          open={creditsOpen}
          onOpenChange={setCreditsOpen}
          borrow={borrowCreditList}
        />
        {/* The panel: the upper left on a desktop; on a phone the same
            sheet at the foot of the screen a card takes (CARD_SLOT) – and
            it leaves while one is up, since a phone has room for one
            sheet, and the card is the one the reader just asked for. */}
        <div
          ref={panelRef}
          className={cn(
            'pointer-events-none absolute left-4 top-4 z-10 max-sm:inset-x-3 max-sm:top-auto max-sm:bottom-9',
            cardOpen && 'max-sm:hidden',
          )}
        >
          <ControlPanel
            city={{
              slug: city.slug,
              name: city.name,
              modes: city.network.modes,
              ships: city.ais.enabled || city.network.modes.includes('ferry'),
            }}
            cities={CITY_CHOICES}
            cityLoading={cityData === null}
            onSelectCity={selectCity}
            clockText={clockText}
            speed={speed}
            paused={paused}
            onSpeedChange={handleSpeedChange}
            onTogglePause={handleTogglePause}
            onSetTime={handleSetTime}
            onSetDate={handleSetDate}
            onResetTime={handleResetTime}
            lines={lineInfos}
            onToggleLine={handleToggleLine}
            onFocusLine={handleFocusLine}
            onSetLinesVisible={handleSetLinesVisible}
            aisAvailable={aisAvailable}
            showAisVessels={showAisVessels}
            onToggleAisVessels={handleToggleAisVessels}
            activity={cityActivity}
            aisVesselCount={aisFleetCountRef.current}
            onShowCityFacts={handleShowCityFacts}
          />
        </div>

        {/* The weather is the map's dress rather than a command about it,
            so it sits in the opposite corner from the camera controls, out
            of the way of both. A card opens under it (CARD_SLOT) rather
            than in its place: the sky is picked with a card up as much as
            without one. Only the diagram, which has no sky, takes it away. */}
        {!linear && (
          // On a phone the upper right is the rail's, so the weather takes
          // the upper left the panel left free.
          <div className="pointer-events-none absolute right-4 top-4 z-10 flex justify-end max-sm:right-auto max-sm:left-3">
            <WeatherPopover
              interfaceHidden={interfaceHidden}
              weatherMode={weatherMode}
              onWeatherModeChange={handleWeatherMode}
              liveWeatherAvailable={liveWeatherAvailable}
              temperatureC={temperatureC}
              showClouds={showClouds}
              onToggleClouds={handleToggleClouds}
            />
          </div>
        )}

        {cityCard && cityProfile && (
          <div className={CARD_SLOT}>
            <CityCard
              profile={cityProfile}
              activity={cityActivity}
              name={localizeCityName(city.slug, city.name)}
              longestLine={longestLine}
              onFocusLine={handleFocusLine}
              onClose={() => setCityCardOpen(false)}
            />
          </div>
        )}

        {lineCard && selectedLine && lineProfile && (
          <div className={CARD_SLOT}>
            <LineCard
              profile={lineProfile}
              activity={lineActivity}
              name={localizeLineName(selectedLine.name)}
              color={selectedLine.color}
              onFlyTo={() => mapRef.current?.focusLine(selectedLine.id)}
              onSelectVehicle={handleSelectDeparture}
              onClose={() => setSelectedLineId(null)}
            />
          </div>
        )}

        {vesselCard && selectedVessel && (
          <div className={CARD_SLOT}>
            <VesselCard
              vessel={selectedVessel}
              // A replayed ship's fix is as old as the simulated clock says
              nowMs={aisReplay ? (clockRef.current?.now() ?? Date.now()) : Date.now()}
              recorded={aisReplay}
              following={following}
              onToggleFollow={handleToggleFollow}
              onClose={() => selectVessel(null)}
            />
          </div>
        )}

        {stopCard && selectedStop && (
          <div className={CARD_SLOT}>
            <StopCard
              stop={selectedStop}
              departures={stopDepartures}
              simSeconds={simSeconds}
              interchange={interchangeByStop.get(selectedStop.id) ?? []}
              onSelectVehicle={handleSelectDeparture}
              onSelectLine={handleFocusLine}
              onFlyTo={handleFlyToStop}
              onClose={() => selectStop(null)}
            />
          </div>
        )}

        {vehicleCard && selected && (
          <div className={CARD_SLOT}>
            <VehicleCard
              vehicle={selected}
              tripProgress={tripProgress}
              simSeconds={simSeconds}
              interchangeByStop={interchangeByStop}
              onFlyToStop={handleFlyToStop}
              onSelectLine={handleFocusLine}
              following={following}
              onToggleFollow={handleToggleFollow}
              onClose={() => selectVehicle(null)}
            />
          </div>
        )}

        {/* Which reading of the network is on screen. Centred at the foot of
            the map because it is the one control here that does not aim
            the camera – it replaces what the camera looks at, so it does
            not belong in the column of camera buttons at the right.
            bottom-8 clears the Cesium attribution line at the lower edge. */}
        <Tabs
          value={mapView}
          onValueChange={(value) => selectView(value as MapView)}
          // Arrow keys move the focus, Enter picks. Radix activates on
          // focus by default, and arrowing across this group would fly
          // the camera twice on the way to the tab actually wanted.
          activationMode="manual"
          // On a phone the foot of the screen is the sheet's, so the
          // readings go to the top, between the weather and the rail.
          className="pointer-events-none absolute bottom-8 left-1/2 z-10 -translate-x-1/2 max-sm:top-3 max-sm:bottom-auto"
        >
          <TabsList aria-label={t('view.readings')} className="pointer-events-auto">
            {VIEW_TABS.map(({ value, labelKey, Icon }) => (
              // The diagram stays a desktop reading (see lib/viewport.ts)
              <TabsTrigger key={value} value={value} className={cn(value === 'linear' && 'max-sm:hidden')}>
                <Icon aria-hidden />
                {/* Named at every width, spelled out only where the three
                    of them fit beside the panel. Centred at the foot of the
                    map the group is ~377px wide, so its left edge clears
                    the panel's 336 from about 1080px up; 1120 leaves a gap
                    rather than a graze, and it is a width Tailwind has no
                    name for. sr-only rather than hidden, so the label stays
                    the tab's own accessible name at every width. */}
                <span className="sr-only min-[1120px]:not-sr-only">{t(labelKey)}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Map controls at the lower right: the four that only ever aim
            the camera or the window, joined into one block – compass,
            2D/3D, camera reset, and full screen last. All of it belongs to
            the map, so the diagram keeps only full screen, which is the
            window's. */}
        {/* On a phone the column stands at the top instead, clear of the
            sheet at the foot; the boxes close up a little so the three of
            them end above where the sheet opens to. */}
        <div className="pointer-events-none absolute bottom-8 right-4 z-10 flex flex-col items-end gap-3 max-sm:top-3 max-sm:right-3 max-sm:bottom-auto max-sm:gap-2">
          {/* What is drawn on the map, above the block that aims the camera
              at it: routes, stops, the names, the webcams. Its own button
              rather than a fifth in the group below – that group is the
              camera's, and none of this points anywhere. It stays in the
              diagram too: the switches outlive the reading they were set
              in, and the map is what they are set for. */}
          <div className={RAIL_BOX}>
            <LayersPopover
              interfaceHidden={interfaceHidden}
              showRoutes={showRoutes}
              onToggleRoutes={handleToggleRoutes}
              showStops={showStops}
              onToggleStops={handleToggleStops}
              showLabels={showLabels}
              onToggleLabels={handleToggleLabels}
              webcams={webcamChoices}
              showWebcams={showWebcams}
              webcamsDisabled={underground}
              onToggleWebcams={handleToggleWebcams}
              onFlyToWebcam={handleFlyToWebcam}
              triggerClassName={GROUPED_CONTROL}
            />
          </div>
          <div role="group" aria-label={t('view.controls')} className={RAIL_BOX}>
            {!linear && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className={GROUPED_CONTROL}
                    aria-label={alignHeadingLabel}
                    onClick={handleAlignHeading}
                  >
                    {/* The needle points where the camera looks on a
                        north-up dial, so the icon reads as the view's own
                        compass – solid end north, hollow end south. */}
                    <CompassIcon
                      className="size-4 transition-transform duration-300 ease-out"
                      style={{ transform: `rotate(${cameraHeading}deg)` }}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{withKey(alignHeadingLabel, 'C')}</TooltipContent>
              </Tooltip>
            )}
            {!linear && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className={cn(GROUPED_CONTROL, 'font-bold')}
                    aria-label={cameraIs2D ? t('camera.to3d') : t('camera.to2d')}
                    onClick={handleToggleViewMode}
                  >
                    {cameraIs2D ? '3D' : '2D'}
                  </Button>
                </TooltipTrigger>
                {/* The digit names the view to be in, not the flip: from
                    2D the key that gets you out is 3 (see the key handler). */}
                <TooltipContent side="left">
                  {cameraIs2D ? withKey(t('camera.to3d'), '3') : withKey(t('camera.to2d'), '2')}
                </TooltipContent>
              </Tooltip>
            )}
            {!linear && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className={GROUPED_CONTROL}
                    aria-label={t('camera.reset')}
                    onClick={handleResetCamera}
                  >
                    <Home aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">{withKey(t('camera.reset'), 'R')}</TooltipContent>
              </Tooltip>
            )}
            {/* The photo mode – lens, exposure, grade and the miniature
                look – is a camera on the map, not a command to it, so it
                goes with the map and not with the diagram. */}
            {!linear && (
              // A lens, an exposure and a miniature blur are a desktop's
              // pleasures: on a phone the button leaves (see lib/viewport.ts)
              <PhotoModePopover
                interfaceHidden={interfaceHidden}
                settings={photo}
                onChange={handlePhotoChange}
                cameraPath={cameraPathControls}
                triggerClassName={cn(GROUPED_CONTROL, 'max-sm:hidden')}
              />
            )}
            {/* Full screen is the window's, not the camera's – it stays */}
            {fullscreenAvailable && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    // A phone's browser is its own full screen
                    className={cn(GROUPED_CONTROL, 'max-sm:hidden')}
                    aria-label={fullscreen ? t('view.exitFullscreen') : t('view.fullscreen')}
                    aria-pressed={fullscreen}
                    onClick={handleToggleFullscreen}
                  >
                    {fullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">
                  {withKey(fullscreen ? t('view.exitFullscreen') : t('view.fullscreen'), 'F')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
          {/* What the map is, and the keyboard at the end of it – on its
              own below the block. It is not a control of the map: it
              commands nothing and aims nothing, it is where the reader is
              told what they are looking at, so it stands apart from the
              group rather than in it. */}
          <div className={RAIL_BOX}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  className={GROUPED_CONTROL}
                  aria-label={t('about.open')}
                  aria-pressed={aboutOpen}
                  onClick={() => setAboutOpen((open) => !open)}
                >
                  <CircleHelp aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{t('about.open')}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </div>
  )
}

/** A stop of a network by id, as the stop card needs it (see stopInfoById). */
function findStop(network: PreparedNetwork, stopId: string): StopInfo | undefined {
  for (const line of network.lines) {
    for (const dir of line.directions) {
      const stop = dir.stops.find((s) => s.id === stopId)
      if (stop) {
        return {
          id: stop.id,
          name: stop.name,
          lon: stop.coord[0],
          lat: stop.coord[1],
          nhn: stop.nhn,
          lines: [{ id: line.id, color: line.color }],
          inTunnel: isInTunnel(dir.tunnels, stop.dist),
        }
      }
    }
  }
  return undefined
}
