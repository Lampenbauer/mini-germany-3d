/**
 * Central configuration of Mini Rostock 3D.
 */

import { offsetLonLat } from '@/lib/geo'
import { boundingBoxCenter, rostockBoundingBox } from '@/lib/rostock-bounding-box'

/**
 * How far the home view's center is moved from the center of the Rostock
 * bounding box, in meters – east and north, negative is west and south.
 * The plain center lies on the Warnow north of the old town; a kilometer
 * south brings more of the city into the frame.
 */
export const HOME_VIEW_OFFSET_METERS = { east: -2000, north: -7000 }

const boxCenter = boundingBoxCenter(rostockBoundingBox)
/** The ground point the home view is centered on (see `home` below). */
const [homeLongitude, homeLatitude] = offsetLonLat(
  [boxCenter.longitude, boxCenter.latitude],
  HOME_VIEW_OFFSET_METERS.east,
  HOME_VIEW_OFFSET_METERS.north,
)

export const config = {
  /**
   * Cesium Ion token, always from the environment – no token lives in the
   * source. Ion tokens are client-side and end up in the browser bundle
   * either way, which is why the deployed site is built with one that is
   * restricted to its own domain (see .github/workflows/ci.yml); every
   * other build takes the unrestricted one from the CESIUM_ION_TOKEN
   * secret, and a local checkout from .env (see .env.example).
   *
   * Empty means no Ion access: the map falls back to the wireframe globe
   * and the panel shows the fallback badge.
   */
  cesiumIonToken: (import.meta.env?.VITE_CESIUM_ION_TOKEN as string | undefined) ?? '',

  /**
   * Filtered GTFS-Realtime endpoint (JSON, a few KB). Served by the Vite
   * middleware in the dev server, by api/realtime.php in production – both
   * fetch and filter the >10 MB Germany feed server-side (60 s cache).
   * Overridable via VITE_GTFS_RT_URL; an empty string disables realtime.
   */
  gtfsRealtimeUrl:
    (import.meta.env?.VITE_GTFS_RT_URL as string | undefined) ?? '/api/realtime',

  /**
   * Live precipitation and cloud cover for the rain and overcast overlays:
   * the Open-Meteo forecast API (CC-BY 4.0, free, no key) – both values
   * come from one request. An empty string disables the live weather.
   * The weather is queried for a single point, the center of the Rostock
   * bounding box (lib/rostock-bounding-box.ts) – the camera cannot leave
   * that box, and Rostock is small enough that one value covers the
   * visible map.
   */
  weather: {
    url:
      (import.meta.env?.VITE_WEATHER_URL as string | undefined) ??
      'https://api.open-meteo.com/v1/forecast',
    /** longitude/latitude of the point the weather is queried for. */
    ...boundingBoxCenter(rostockBoundingBox),
    /** Poll interval in ms (Open-Meteo updates its model every ~15 min). */
    pollIntervalMs: 600_000,
    /**
     * Rain and the overcast grade are only drawn while the simulation time
     * is within this many seconds of the real clock – the live weather
     * knows only "now", and time-traveled views must not show today's sky.
     */
    maxSimTimeDriftSeconds: 600,
  },

  /**
   * AIS vessel positions (aisstream.io, via the filtered /api/ais
   * endpoint – Vite middleware in dev, api/ais.php in production). Real
   * harbor traffic as backdrop, and the city ferries snap onto their AIS
   * twins. An empty URL disables the layer, and so does offline mode –
   * neither has live traffic to reach. ?ais=0 is softer: it opens with the
   * fleet switched off, and the panel's "AIS ships" switch turns it back
   * on (see handleToggleAisVessels in App.tsx).
   */
  ais: {
    url: (import.meta.env?.VITE_AIS_URL as string | undefined) ?? '/api/ais',
    /**
     * Poll interval in ms. Costs the server a state-file read, not a
     * listen window, so it is cheap – and it has to be well under the
     * window's 8 s flush for that flush to reach anyone at all.
     */
    pollIntervalMs: 10_000,
    /**
     * Which real vessel sails which simulated ferry line (MMSI → line
     * id): the Gehlsdorf solar ferry and the two boats sharing the
     * Warnemünde–Hohe Düne crossing. The ferries run purely on their
     * timetable – this map only EXCLUDES their AIS twins from the
     * backdrop fleet, one boat per crossing. Identified from live AIS
     * 2026-08-27; a replacement vessel would need its MMSI added here.
     */
    ferryLineByMmsi: {
      211825200: 'FG', // WARNOWSTROMER
      211624750: 'FW', // BREITLING
      211624870: 'FW', // MF WARNOW
    } as Record<number, string>,
  },

  /**
   * Camera optics: the horizontal field of view in degrees. Cesium's own
   * default is 60°, a ~30 mm wide angle – and the wide end is where the
   * miniature look works worst. The tilt-shift band is a stand-in for a
   * plane of focus, and how well it stands in depends on how much depth
   * one band of screen rows spans: at 60° and a -35° pitch the fully
   * blurred edges sit about a quarter further and a sixth nearer than the
   * sharp band, at 25° it is well under half of that either way – a band
   * that a real lens could almost have drawn. A narrower angle also stops the foreground
   * from looming and keeps towers from leaning out of the frame – the
   * long-lens look every fake-miniature photograph is shot with.
   *
   * The distances tuned at 60° follow the angle rather than staying put
   * (see framingDistanceScale in map/camera-fov.ts): the home view below,
   * the chase cam, and the stop flight all frame the same ground at any
   * setting. Only camera poses in shared URL hashes carry a plain height
   * and therefore open a little closer in than they were saved at.
   *
   * Switching the miniature look off puts the plain lens back on, eased
   * over a few frames with the camera walking along to hold the framing
   * (see map/CameraLens.ts) – so the switch shows the perspective change
   * the effect is built on, rather than jumping somewhere else.
   */
  camera: {
    /** Field of view with the miniature look on. */
    fovDeg: 25,
    /** Field of view with it off – Cesium's own default. */
    fovOffDeg: 60,
  },

  /**
   * The home view (also the "Reset camera" view): the camera looks at the
   * center of the Rostock bounding box (lib/rostock-bounding-box.ts),
   * moved by HOME_VIEW_OFFSET_METERS, from `height` meters up, with this
   * heading and pitch – where the camera itself stands follows from that
   * (see homePosition in map/CesiumMap.ts). A URL hash (#lat=…&lon=…)
   * still takes precedence when present. The height is the one that
   * framed the city at 60° – it is scaled to the configured field of view
   * when the camera flies home.
   */
  home: {
    /** The ground point the view is centered on. */
    longitude: homeLongitude,
    latitude: homeLatitude,
    height: 5800,
    heading: 0,
    pitch: -40,
  },

  /**
   * Camera leash: the view stays over Rostock instead of roaming the
   * globe. The area the camera may be in is the Rostock bounding box –
   * the city limits widened by 15 km, the one rectangle the data pipeline
   * and the AIS subscription use too (see lib/rostock-bounding-box.ts) –
   * and `maxHeightMeters` is the ceiling it may not zoom out past. Beyond
   * the city there is nothing this app can show, and every place the
   * camera visits pulls its own photorealistic tiles.
   */
  cameraLimits: {
    maxHeightMeters: 25_000,
  },

  /**
   * How far a connecting line may call from the stop shown to count as an
   * interchange, in meters. A transit stop is several stops in the data –
   * one per platform, at a junction with different lines and sometimes
   * different names – so the vehicle card matches on walking distance
   * rather than on the stop id (see src/lib/interchange.ts). Deliberately
   * short: a wider radius starts claiming changes no passenger would
   * recognize as one.
   */
  interchangeRadiusMeters: 100,

  /** Simulation defaults */
  simulation: {
    /** Time-lapse factor at startup (1 = real time). */
    initialSpeed: 1,
    /** Average travel speed between stops in m/s (~30 km/h). */
    cruiseSpeedMps: 8.3,
    /** Mode-specific travel speeds (m/s); missing = cruiseSpeedMps. */
    cruiseSpeedByMode: {
      tram: 8.3,
      train: 11.0, // S-Bahn ~40 km/h between city stations (incl. accel/brake)
      bus: 6.9, // ~25 km/h city traffic
      ferry: 3.0, // ~6 kn harbor crossing
    },
    /** Dwell time at a stop in seconds. */
    dwellSeconds: 25,
    /**
     * Turnaround time at the terminus in seconds: the vehicle stays
     * visible at its final stop this long after arrival instead of
     * vanishing the moment the trip ends.
     */
    terminalLingerSeconds: 180,
  },

  /**
   * Default vehicle dimensions per transit mode in meters (L × W × H).
   * Ferries get their real dimensions per line from network.json.
   */
  vehicles: {
    /** Modeled after a 6N2. */
    tram: { length: 32, width: 2.65, height: 3.6 },
    /** S-Bahn: Talent 2 (BR 442) three-car unit (usually set per line in network.json). */
    train: { length: 56.8, width: 2.92, height: 4.3 },
    /** Standard 12 m city bus. */
    bus: { length: 12, width: 2.55, height: 3.1 },
    /** Fallback in case a ferry comes without dimensions. */
    ferry: { length: 20, width: 7, height: 4 },
  },
} as const

export type AppConfig = typeof config
