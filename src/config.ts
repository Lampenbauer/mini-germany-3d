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

  /**
   * Gefilterter GTFS-Realtime-Endpunkt (JSON, wenige KB). Im Dev-Server von
   * der Vite-Middleware bedient, in Produktion von api/realtime.php – beide
   * laden und filtern den >10-MB-Deutschland-Feed serverseitig (60-s-Cache).
   * Mit VITE_GTFS_RT_URL überschreibbar; leerer String deaktiviert Realtime.
   */
  gtfsRealtimeUrl:
    (import.meta.env?.VITE_GTFS_RT_URL as string | undefined) ?? '/api/realtime',

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
    /** Modus-spezifische Reisegeschwindigkeiten (m/s); fehlend = cruiseSpeedMps. */
    cruiseSpeedByMode: {
      tram: 8.3,
      bus: 6.9, // ~25 km/h Stadtverkehr
      ferry: 3.0, // ~6 kn Hafenquerung
    },
    /** Haltezeit an einer Haltestelle in Sekunden. */
    dwellSeconds: 25,
  },

  /**
   * Standard-Fahrzeugmaße pro Verkehrsmittel in Metern (L × B × H).
   * Fähren erhalten ihre echten Maße pro Linie aus network.json.
   */
  vehicles: {
    /** Angelehnt an eine 6N2. */
    tram: { length: 32, width: 2.65, height: 3.6 },
    /** 12-m-Standard-Stadtbus. */
    bus: { length: 12, width: 2.55, height: 3.1 },
    /** Fallback, falls eine Fähre keine Maße mitbringt. */
    ferry: { length: 20, width: 7, height: 4 },
  },
} as const

export type AppConfig = typeof config
