/**
 * Zentrale Konfiguration von Mini Rostock 3D.
 *
 * Hinweis zum Cesium-Ion-Token: Ion-Tokens sind clientseitige, veröffentlichbare
 * Tokens (sie landen in jedem Fall im Browser-Bundle). Trotzdem empfiehlt es
 * sich, den Token im Cesium-Ion-Dashboard auf die eigenen Domains
 * einzuschränken. Über die Umgebungsvariable VITE_CESIUM_ION_TOKEN kann der
 * Standard-Token ohne Codeänderung überschrieben werden (.env-Datei).
 */

const DEFAULT_ION_TOKEN =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3NzA0MjlhMC1hNTM1LTQ3OGItOTI5Mi1jMTViNDdkNGEzM2QiLCJpZCI6NDY3MjAyLCJpc3MiOiJodHRwczovL2FwaS5jZXNpdW0uY29tIiwiYXVkIjoidW5kZWZpbmVkX2RlZmF1bHQiLCJpYXQiOjE3ODY1NDA0MTl9.9vV1AI5wn5d7e4KET4V-C9Ji2cYottPZnEym04yXt-8'

export const config = {
  cesiumIonToken:
    (import.meta.env?.VITE_CESIUM_ION_TOKEN as string | undefined) || DEFAULT_ION_TOKEN,

  gtfsRealtimeUrl: (import.meta.env?.VITE_GTFS_RT_URL as string | undefined) || '',

  /** Startposition der Kamera: Blick von Süden über das gesamte Netz. */
  home: {
    longitude: 12.124,
    latitude: 54.042,
    height: 3600,
    heading: 3,
    pitch: -38,
  },

  /** Simulations-Standardwerte */
  simulation: {
    /** Zeitraffer-Faktor beim Start (1 = Echtzeit). */
    initialSpeed: 1,
    /** Durchschnittliche Fahrgeschwindigkeit zwischen Haltestellen in m/s (~30 km/h). */
    cruiseSpeedMps: 8.3,
    /** Haltezeit an einer Haltestelle in Sekunden. */
    dwellSeconds: 25,
  },

  /** Abmessungen der Straßenbahn-Quader in Metern (L × B × H, angelehnt an eine 6N2). */
  tram: {
    length: 32,
    width: 2.65,
    height: 3.6,
  },
} as const

export type AppConfig = typeof config
