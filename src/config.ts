/**
 * Central configuration of Mini Rostock 3D.
 *
 * Note on the Cesium Ion token: Ion tokens are client-side, publishable
 * tokens (they end up in the browser bundle either way). Still, it is
 * advisable to restrict the token to your own domains in the Cesium Ion
 * dashboard. The default token can be overridden without a code change via
 * the VITE_CESIUM_ION_TOKEN environment variable (.env file).
 */

const DEFAULT_ION_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3NzA0MjlhMC1hNTM1LTQ3OGItOTI5Mi1jMTViNDdkNGEzM2QiLCJpZCI6NDY3MjAyLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODY1NDA0MTl9.9vV1AI5wn5d7e4KET4V-C9Ji2cYottPZnEym04yXt-8'

export const config = {
  cesiumIonToken:
    (import.meta.env?.VITE_CESIUM_ION_TOKEN as string | undefined) || DEFAULT_ION_TOKEN,

  /**
   * Filtered GTFS-Realtime endpoint (JSON, a few KB). Served by the Vite
   * middleware in the dev server, by api/realtime.php in production – both
   * fetch and filter the >10 MB Germany feed server-side (60 s cache).
   * Overridable via VITE_GTFS_RT_URL; an empty string disables realtime.
   */
  gtfsRealtimeUrl:
    (import.meta.env?.VITE_GTFS_RT_URL as string | undefined) ?? '/api/realtime',

  /**
   * Live precipitation for the rain overlay: the Open-Meteo forecast API
   * (CC-BY 4.0, free, no key). An empty string disables the rain layer.
   * The weather is queried for a single city-center point – Rostock is
   * small enough that one value covers the visible map.
   */
  weather: {
    url:
      (import.meta.env?.VITE_WEATHER_URL as string | undefined) ??
      'https://api.open-meteo.com/v1/forecast',
    longitude: 12.14,
    latitude: 54.09,
    /** Poll interval in ms (Open-Meteo updates its model every ~15 min). */
    pollIntervalMs: 600_000,
    /**
     * Rain is only drawn while the simulation time is within this many
     * seconds of the real clock – the live weather knows only "now", and
     * time-traveled views must not show today's rain.
     */
    maxSimTimeDriftSeconds: 600,
  },

  /**
   * Initial camera position (also the "Reset camera" home view). A URL hash
   * (#lat=…&lon=…) still takes precedence when present.
   */
  home: {
    longitude: 12.103892,
    latitude: 54.047534,
    height: 7881,
    heading: 0,
    pitch: -60,
  },

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
