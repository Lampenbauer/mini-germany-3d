

declare global {
  /** A camera pose as the URL carries it (see src/lib/camera-hash.ts). */
  interface CameraViewLike {
    longitude: number
    latitude: number
    height: number
    heading: number
    pitch: number
  }
  /** A camera path as src/lib/camera-path.ts describes it. */
  interface CameraPathLike {
    keyframes: CameraViewLike[]
    durationS: number
    ease: 'linear' | 'smooth'
  }
  /** One frame as the linear-view probe sees it (see linear-view.spec.ts). */
  interface LinearProbeFrame {
    drawnByMap: number
    drawnByDiagram: number
    diagramShown: boolean
  }

  interface Window {
    /** Test hook of render-loop.spec.ts: freezes requestAnimationFrame. */
    __stopRaf?: boolean
    __mg3d?: {
      ready: boolean
      /** Whether the welcome screen is up – no city session runs behind it. */
      welcomeOpen: () => boolean
      vehicleCount: () => number
      visibleVehicleCount: () => number
      vehicles: () => {
        id: string
        lineId: string
        nextStopName: string
        lat: number
        lon: number
        inTunnel: boolean
      }[]
      setTime: (hhmm: string) => void
      setDate: (dateKey: string) => void
      dateKey: () => string
      setSpeed: (speed: number) => void
      setPaused: (paused: boolean) => void
      setRealtimeDelays: (delays: Record<string, number>) => void
      /** Slug of the city on the map, and the picker's way to another one. */
      city: () => string
      setCity: (slug: string) => void
      /** Whether the lines are drawn pulled straight instead of on the map. */
      linear: () => boolean
      setLinear: (linear: boolean) => void
      setRain: (precipitationMm: number) => void
      setCloudCover: (cloudCoverPercent: number) => void
      /** Forces the visibility (metres; null = the sky's own again) – the airfield lights by day. */
      setVisibility: (metres: number | null) => void
      rainDropsVisible: () => number
      selectVehicle: (id: string | null) => void
      selectedVehicleId: () => string | null
      selectStop: (id: string | null) => void
      selectedStopId: () => string | null
      vehicleScreenPosition: (id: string) => { x: number; y: number } | null
      stopScreenPosition: (id: string) => { x: number; y: number } | null
      dataSource: string
      /** Which ground the map ended up on ('offline' with ?offline=1, 'flat' on the flat map). */
      tilesetStatus: () => 'loading' | 'google-3d-tiles' | 'flat' | 'offline' | 'failed'
      /** The ground the map draws from (src/lib/basemap.ts), and the layers popover's switch. */
      basemap: () => '3d' | 'flat'
      setBasemap: (kind: '3d' | 'flat') => void
      /** The flat map's Mapbox styles as they stand – none offline (src/map/FlatBasemap.ts). */
      flatMap: () => { shown: boolean; day: boolean; night: boolean; nightAlpha: number }
      /** GTFS-RT feed state and matched trips (null = disabled). */
      realtimeStatus: () => { state: string; matchedCount: number } | null
      lineIds: () => string[]
      secondsOfDay: () => number
      speed: () => number
      loopTicks: () => number
      lastLoopError: () => string | null
      vehicleBoxDriftMeters: () => number
      vehicleOpacity: (id: string) => number | null
      renderRate: () => number
      anyVehicleInView: () => boolean
      streetLamps: () => { drawn: number; alpha: number }
      /** Airfield lighting: lights built into the scene, their current opacity, and the apron pools built. */
      airfieldLights: () => { drawn: number; alpha: number; floods: number }
      /** The sun shadow map: switched on, and whether its texture is currently allocated. */
      shadowMap: () => { enabled: boolean; allocated: boolean; size: number }
      /** The device tier and the numbers the map draws with (see src/lib/render-profile.ts). */
      renderProfile: () => { tier: 'desktop' | 'mobile'; shadowMapSize: number }
      /** The camera path (src/lib/camera-path.ts): what is set, whether it is flown, how far along. */
      cameraPath: () => { path: CameraPathLike | null; playing: boolean; progress: number }
      setCameraPath: (path: CameraPathLike | null) => void
      playCameraPath: () => void
      stopCameraPath: () => void
      /** The miniature effect: on, how much the pose carries, passes compiled. */
      tiltShiftState: () => { enabled: boolean; strength: number; ready: boolean }
      /** The buoys: registered, built (model loaded), drawn, clamped, lit, and the lanterns' opacity (see src/map/BuoysLayer.ts). */
      buoys: () => {
        buoys: number
        built: number
        shown: number
        clamped: number
        lit: number
        lightAlpha: number
        heightSpanM: number
        heightsOverFallbackM: number[]
      }
      /** The lighthouses and pier lights: registered, clamped, shown towards the camera, and the night level (see src/map/LighthousesLayer.ts). */
      lighthouses: () => { lights: number; clamped: number; shown: number; alpha: number }
      /** The photo mode as set – the shape of src/lib/photo-settings.ts, the knobs the specs read. */
      photoSettings: () => {
        fovDeg: number
        grid: boolean
        exposureEv: number
        whiteBalanceK: number
        contrast: number
        saturation: number
        vignette: number
        tiltShift: {
          enabled: boolean
          maxBlurRadius: number
          bandHalfHeight: number
          bandFeather: number
          focusY: number
          highlightGain: number
          sharpen: number
        }
      }
      /** The volumetric clouds: cover, threshold, whether drawn, drift. */
      cloudState: () => {
        enabled: boolean
        coverPercent: number
        coverApplied: number
        threshold: number
        drawn: boolean
        supported: boolean
        driftMeters: { east: number; north: number }
      }
      /** AIS backdrop vessels currently drawn. */
      aisVesselCount: () => number
      /** Aircraft currently drawn (0 = layer off or no data yet). */
      aircraftCount: () => number
      /** The navigation lights on at the last tick, per fleet. */
      navLights: () => { aircraft: number; ships: number; ferries: number }
      /** Aircraft selection by ICAO address, as a click on a body does it. */
      selectAircraft: (hex: string | null) => void
      selectedAircraftHex: () => string | null
      /** Whether the aircraft are replayed from the recording, which hours are held, and how many it places at the simulated moment. */
      aircraftReplay: () => {
        active: boolean
        hours: { key: string; status: 'loading' | 'loaded' | 'absent' | 'failed'; lines: number }[]
        fleet: number
      }
      /** Puts air traffic on the map as if polled (see src/lib/aircraft-extract.ts for the record); null takes it away. */
      setAircraft: (
        list:
          | {
              hex: string
              callsign: string
              registration: string
              typeCode: string
              description: string
              category: string
              lat: number
              lon: number
              altGeomM: number | null
              altBaroM: number | null
              onGround: boolean
              gsKn: number | null
              trackDeg: number | null
              headingDeg: number | null
              verticalRateMps: number | null
              rollDeg: number | null
              squawk: string
              source: 'adsb' | 'mlat' | 'other'
              positionAt: number
              track: [number, number, number, number | null, number | null, number | null, number | null, (number | null)?][]
            }[]
          | null,
      ) => void
      /** The wakes: ribbon segments drawn for the AIS fleet and the ferries; null without the profile's knob. */
      wake: () => { ships: number; ferries: number; supported: boolean } | null
      /** The picks under the ships and the ferries, judged (see src/map/water-clamp.ts): the rules, the verdicts counted, every hull with an answer. */
      waterClamp: () => {
        knownWaterM: number | null
        ships: {
          rules: { aboveM: number; belowM: number; riseM: number; confirmPicks: number; cellM: number }
          counts: { accepted: number; confirmed: number; held: number }
          ships: {
            mmsi: number
            name: string
            lon: number
            lat: number
            pickedM: number
            acceptedM: number | null
            provisional: boolean
            fine: boolean
            heldM: number | null
            heldPicks: number
            referenceM: number | null
          }[]
        }
        ferries: {
          counts: { accepted: number; confirmed: number; held: number }
          ferries: {
            id: string
            pickedM: number
            acceptedM: number | null
            heldM: number | null
            heldPicks: number
            profileM: number
          }[]
        }
      }
      /** The ships' exhaust: plumes drawn, support, the plume's clock, the wind; null without the profile's knob. */
      funnelSmoke: () => {
        drawn: number
        supported: boolean
        plumeTime: number
        wind: { east: number; north: number }
      } | null
      /** A fleet put on the map as if polled (see src/lib/ais-extract.ts for the record); null takes it away. */
      setAisVessels: (
        vessels:
          | {
              mmsi: number
              name: string
              lat: number
              lon: number
              sogKn: number | null
              cogDeg: number | null
              headingDeg: number | null
              lastCourseDeg: number | null
              navStatus: number | null
              typeCode: number
              lengthM: number | null
              widthM: number | null
              draughtM: number | null
              positionAt: number
              track: [number, number, number, number | null, number | null, number | null][]
            }[]
          | null,
      ) => void
      renderPacing: () => {
        animating: boolean
        rainActive: boolean
        vehicleInView: boolean
        /** An aircraft whose drawn pose is still changing is on screen. */
        aircraftInView: boolean
        interacting: boolean
        tilesLoading: boolean
        intervalMs: number
        tickIntervalMs: number
        motionPxPerSecond: number
        /** The whole picture paced as if close up – the time-lapse, a camera path. */
        paceWholeView: boolean
      }
      tunnelTransition: () => {
        id: string
        tunnelTime: number
        surfaceTime: number
      } | null
    }
    /** Per-frame samples a spec collects from inside the page (linear-view.spec.ts). */
    __linearProbe?: LinearProbeFrame[]
    __cesiumViewer?: {
      /** One frame, drawn synchronously – see frameDetail in app.spec.ts. */
      render: () => void
      canvas: HTMLCanvasElement
      camera: {
        positionCartographic: { longitude: number; latitude: number; height: number }
        /** Where the camera looks, in radians clockwise from north. */
        heading: number
        /** How far it looks down, in radians (0 = horizon, -π/2 = straight down). */
        pitch: number
        /** The ground rectangle currently in view, in radians. */
        computeViewRectangle: () =>
          | { west: number; south: number; east: number; north: number }
          | undefined
      }
      clock: { currentTime: unknown }
      scene: {
        /**
         * Ground-clamped geometry: the entity visualizers keep an (often
         * empty) collection of their own in here, so what counts is the
         * primitives inside those, not the top-level length.
         */
        groundPrimitives: { length: number; get: (index: number) => object }
        /**
         * The scene's own primitives – the models among them carry the
         * id they were made with (`vessel:<mmsi>`, see VesselLayer;
         * `aircraft:<hex>`, see AircraftLayer) and say whether they are
         * ready to draw.
         */
        primitives: { length: number; get: (index: number) => { id?: unknown; ready?: boolean } }
        /** The globe under the flat map (see CesiumMap.applyFlatGlobe). */
        globe: { show: boolean; depthTestAgainstTerrain: boolean }
      }
      entities: {
        values: {
          id: string
          /** Whether the entity is drawn at all. */
          show: boolean
          polyline?: {
            clampToGround?: { getValue: (time: unknown) => boolean | undefined }
            material?: {
              color?: {
                getValue: (time: unknown) => { alpha: number } | undefined
              }
            }
          }
        }[]
      }
    }
  }
}

export {}
