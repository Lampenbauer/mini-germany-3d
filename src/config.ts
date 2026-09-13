/**
 * Central configuration of Mini Germany 3D – everything that is the same
 * for every city. What differs per city (its rectangle, home view,
 * weather point, fleet, terrain source, and which real vessels this map
 * already runs itself) lives in the city's definition, see
 * src/lib/city.ts and src/cities/.
 */

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
   * fetch and filter the >10 MB Germany feed server-side (60 s cache) down
   * to the trip ids of the city asked for (`?city=<slug>`, see
   * cityApiUrl in lib/city-api.ts). Overridable via VITE_GTFS_RT_URL; an
   * empty string disables realtime.
   */
  gtfsRealtimeUrl:
    (import.meta.env?.VITE_GTFS_RT_URL as string | undefined) ?? '/api/realtime',

  /**
   * Precipitation, cloud cover, temperature and wind for the rain and
   * overcast overlays, the clouds' drift and the weather button: the
   * Open-Meteo forecast API (CC-BY 4.0, free, no key), the last days on
   * its quarter-hour grid in one request, so the sky follows the
   * simulated clock (see lib/weather.ts). An empty string disables the
   * live weather. The weather is queried for a single point per city
   * (city.weather) – the camera cannot leave the city's box, and a city
   * is small enough that one value covers the visible map.
   */
  weather: {
    url:
      (import.meta.env?.VITE_WEATHER_URL as string | undefined) ??
      'https://api.open-meteo.com/v1/forecast',
    /** Poll interval in ms (Open-Meteo updates its model every ~15 min). */
    pollIntervalMs: 600_000,
    /**
     * Whether the volumetric clouds (see map/CloudLayer.ts) are drawn when
     * the app opens and the URL has no say. Off: they cost a ray march per
     * pixel they cover and, seen from above, veil the city. The switch in
     * the weather popover turns them on, and the URL hash carries only the
     * deviation from this default (clouds=1 or clouds=0, see
     * lib/camera-hash.ts), so links keep working when this flips.
     */
    clouds3dDefault: false,
  },

  /**
   * Live webcams (Windy's Webcams API, see src/lib/webcams.ts): the
   * endpoint is a proxy that carries the key – the dev middleware in
   * vite.config.ts, api/webcams.php in production. Polled every ten
   * minutes: the cameras refresh at that rate, and so do the picture
   * URLs on the free tier.
   */
  webcams: {
    url: (import.meta.env?.VITE_WEBCAMS_URL as string | undefined) ?? '/api/webcams',
    pollIntervalMs: 600_000,
  },

  /**
   * AIS vessel positions (aisstream.io, via the filtered /api/ais
   * endpoint – Vite middleware in dev, api/ais.php in production, both
   * answering for the city asked for with `?city=<slug>`). Real harbor
   * traffic as backdrop; the AIS twins of the boats this map already
   * runs from a timetable are excluded per city
   * (city.ais.simulatedByMmsi). An empty URL disables the layer, and
   * so does offline mode – neither has live traffic to reach. ?ais=0 is
   * softer: it opens with the fleet switched off, and the panel's "AIS
   * ships" switch turns it back on (see handleToggleAisVessels in App.tsx).
   * The same endpoint serves the recording of the last three days
   * (`&hour=…`, see lib/ais-archive.ts), replayed when the clock is set
   * into the past.
   */
  ais: {
    url: (import.meta.env?.VITE_AIS_URL as string | undefined) ?? '/api/ais',
    /**
     * Poll interval in ms. Costs the server a state-file read, not a
     * listen window, so it is cheap – and it has to be well under the
     * window's 8 s flush for that flush to reach anyone at all.
     */
    pollIntervalMs: 10_000,
  },

  /**
   * Live air traffic (adsb.fi's open data API, via the /api/aircraft
   * endpoint – Vite middleware in dev, api/aircraft.php in production,
   * both answering for the city asked for with `?city=<slug>`, and both
   * folding the feed into a per-city state with a short track per
   * aircraft, see lib/aircraft-extract.ts). Every aircraft over the
   * city's box, at every altitude – the airliner on approach and the one
   * crossing at cruise alike. An empty URL disables the layer, and so
   * does offline mode. ?aircraft=0 is softer: it opens with the traffic
   * switched off, and the panel's "Aircraft" switch turns it back on
   * (see handleToggleAircraft in App.tsx). There is no recording: a
   * clock set into the past shows an empty sky.
   */
  aircraft: {
    url: (import.meta.env?.VITE_AIRCRAFT_URL as string | undefined) ?? '/api/aircraft',
    /**
     * Poll interval in ms. The endpoint caches upstream for four
     * seconds, so a poll every five keeps the browser one answer behind
     * the feed at the cost of a small JSON – and it has to stay well
     * under the playback delay (AIRCRAFT_PLAYBACK_DELAY_MS) for the
     * playback to run between two known fixes.
     */
    pollIntervalMs: 5_000,
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
   * (see framingDistanceScale in map/camera-fov.ts): the home view of
   * each city, the chase cam, and the stop flight all frame the same
   * ground at any setting. Only camera poses in shared URL hashes carry a
   * plain height and therefore open a little closer in than they were
   * saved at.
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
    /**
     * Whether the miniature look is on when the app opens and the URL has
     * no say. The panel switch changes it, and the URL hash carries only
     * the deviation from this default (tiltshift=1 or tiltshift=0, see
     * lib/camera-hash.ts), so links keep working when this flips.
     */
    miniatureDefault: false,
  },

  /**
   * Camera leash: the view stays over the city instead of roaming the
   * globe. The area the camera may be in is the city's bounding box –
   * the city limits widened by its padding, the one rectangle the data
   * pipeline and the AIS subscription use too (see lib/city.ts) – and
   * `maxHeightMeters` is the ceiling it may not zoom out past. Beyond
   * the city there is nothing this app can show, and every place the
   * camera visits pulls its own photorealistic tiles. The leash is lifted
   * for the flight from one city to the next.
   */
  cameraLimits: {
    maxHeightMeters: 30_000,
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
      subway: 10.0, // ~36 km/h between stations (incl. accel/brake)
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
   * Fallback vehicle dimensions per transit mode in meters (L × W × H),
   * for a line whose city fleet (city.fleet) and data say nothing.
   */
  vehicles: {
    tram: { length: 32, width: 2.65, height: 3.6 },
    subway: { length: 40, width: 2.6, height: 3.5 },
    train: { length: 56.8, width: 2.92, height: 4.3 },
    bus: { length: 12, width: 2.55, height: 3.1 },
    ferry: { length: 20, width: 7, height: 4 },
  },
} as const

export type AppConfig = typeof config
