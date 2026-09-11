

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
      rainDropsVisible: () => number
      selectVehicle: (id: string | null) => void
      selectedVehicleId: () => string | null
      selectStop: (id: string | null) => void
      selectedStopId: () => string | null
      vehicleScreenPosition: (id: string) => { x: number; y: number } | null
      stopScreenPosition: (id: string) => { x: number; y: number } | null
      dataSource: string
      /** Which basemap the map ended up on ('offline' with ?offline=1). */
      tilesetStatus: () => 'loading' | 'google-3d-tiles' | 'offline' | 'failed'
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
      /** The wakes: ribbon segments drawn for the AIS fleet and the ferries; null without the profile's knob. */
      wake: () => { ships: number; ferries: number; supported: boolean } | null
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
