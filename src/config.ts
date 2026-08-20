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
  'CESIUM_ION_TOKEN_REMOVED'

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
   * Initial camera position (also the "Reset camera" home view). A URL hash
   * (#lat=…&lon=…) still takes precedence when present.
   */
  home: {
    longitude: 12.130749,
    latitude: 54.080002,
    height: 1719,
    heading: 10,
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
      bus: 6.9, // ~25 km/h city traffic
      ferry: 3.0, // ~6 kn harbor crossing
    },
    /** Dwell time at a stop in seconds. */
    dwellSeconds: 25,
  },

  /**
   * Default vehicle dimensions per transit mode in meters (L × W × H).
   * Ferries get their real dimensions per line from network.json.
   */
  vehicles: {
    /** Modeled after a 6N2. */
    tram: { length: 32, width: 2.65, height: 3.6 },
    /** Standard 12 m city bus. */
    bus: { length: 12, width: 2.55, height: 3.1 },
    /** Fallback in case a ferry comes without dimensions. */
    ferry: { length: 20, width: 7, height: 4 },
  },
} as const

export type AppConfig = typeof config
