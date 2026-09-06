/**
 * Live weather on the map: the falling rain field and the overcast grade
 * on the photo tiles.
 *
 * Split out of CesiumMap because it owns a closed piece of state (two
 * eased grades, a drop pool, two frame listeners) that nothing else in the
 * map touches. Its only seams outward are the viewer, a render request,
 * and the two shader uniforms below.
 */

import {
  type Billboard,
  BillboardCollection,
  Cartesian3,
  Cartographic,
  Color,
  Credit,
  type CustomShader,
  Matrix4,
  Transforms,
  type Viewer,
} from 'cesium'

/**
 * The uniforms this overlay drives. They are declared and consumed by the
 * tile shader in CesiumMap (TIME_OF_DAY_SHADER) – that shader text and
 * these names are one contract, keep them in sync.
 */
export const RAIN_UNIFORM = 'u_rainFactor'
export const CLOUD_UNIFORM = 'u_cloudFactor'

// --- Rain field ----------------------------------------------------------
// A hand-rolled drop field instead of Cesium's ParticleSystem: the particle
// system is driven by the viewer clock, which this app pins to the
// simulated time (setSceneTime) – its frame delta is 0 between the
// throttled updates, so it never emits. The drop field runs on the wall
// clock and is immune to sim pauses, time-lapse, and time jumps.
/** Horizontal radius of the rain volume around the camera in meters. */
const RAIN_RADIUS = 450
/** Half-height of the rain volume (drops wrap within ±this) in meters. */
const RAIN_VOLUME_HALF_HEIGHT = 350
/**
 * Fall speed in m/s. Deliberately far above real terminal velocity (~9 m/s):
 * at typical viewing distances of hundreds of meters, physically correct
 * drops would crawl – this reads as rain streaks at 30 fps.
 */
const RAIN_FALL_MPS = 260
/** Visible drop count: base + per-mm scale, capped (GPU/CPU budget). */
const RAIN_DROPS_BASE = 800
const RAIN_DROPS_PER_MM = 1000
/** Default cap on the pool; ?drops= lowers it (see the constructor). */
const RAIN_MAX_DROPS = 4000
/**
 * Overcast grade strength: even drizzle overcasts clearly, heavy rain
 * saturates at 1. Faded in/out over a few seconds (updateRain).
 */
const RAIN_TINT_BASE = 0.55
const RAIN_TINT_PER_MM = 0.15
const RAIN_TINT_FADE_SECONDS = 2.5

/**
 * Overcast grade from cloud cover alone (no rain). Below the threshold the
 * sky still reads as open – a few clouds must not tint the whole city –
 * and a fully closed sky stays just under the lightest rain
 * (RAIN_TINT_BASE), which is about half the grade of real rain.
 */
const CLOUD_TINT_THRESHOLD_PERCENT = 40
const CLOUD_TINT_MAX = 0.5
/**
 * Slower than the rain fade: cloud cover arrives from a 10-minute poll and
 * changes on that scale, so it must not visibly snap when a poll lands.
 */
const CLOUD_TINT_FADE_SECONDS = 6

/** Near-white so the streaks read against the bright daylight tiles too. */
const RAIN_COLOR = Color.fromCssColorString('#e4edf7')
const RAIN_MAX_ALPHA = 0.9
/** Streak size in pixels (screen space – the drops keep their size). */
const RAIN_STREAK_WIDTH = 2.5
const RAIN_STREAK_HEIGHT = 24

const rainFrameScratch = new Matrix4()
const rainLocalScratch = new Cartesian3()
const rainWorldScratch = new Cartesian3()

interface RainDrop {
  billboard: Billboard
  /** In the pool the current intensity uses (billboard.show may still hide it above the ceiling). */
  active: boolean
  east: number
  north: number
  /** Initial height in the wrap window (meters). */
  phase: number
  /** Per-drop fall-speed multiplier (visual variety). */
  speed: number
}

/** Cloud cover in percent → overcast grade 0..1 (see the constants above). */
export function cloudOvercastGrade(cloudCoverPercent: number): number {
  const cover = Math.min(100, Math.max(0, cloudCoverPercent))
  const above = (cover - CLOUD_TINT_THRESHOLD_PERCENT) / (100 - CLOUD_TINT_THRESHOLD_PERCENT)
  return Math.max(0, above) * CLOUD_TINT_MAX
}

/** Precipitation in mm → overcast grade 0..1; 0 mm is not overcast at all. */
export function rainOvercastGrade(precipitationMm: number): number {
  const mm = Math.max(0, precipitationMm)
  return mm > 0 ? Math.min(1, RAIN_TINT_BASE + mm * RAIN_TINT_PER_MM) : 0
}

/**
 * How overcast the sky reads, 0 (clear) to 1 (heavy rain) – the same
 * value the tiles grade by: rain always implies an overcast sky, so
 * whichever of the two is stronger wins (see TIME_OF_DAY_SHADER).
 */
export function overcastGrade(precipitationMm: number, cloudCoverPercent: number): number {
  return Math.max(rainOvercastGrade(precipitationMm), cloudOvercastGrade(cloudCoverPercent))
}

export class WeatherOverlay {
  /** Rain drop field (null while dry or without a 2D canvas). */
  private rainBillboards: BillboardCollection | null = null
  private rainDrops: RainDrop[] = []
  /** Currently applied precipitation in mm (0 = dry). */
  private rainIntensity = 0
  /** Accumulated fall distance in meters (wall-clock driven). */
  private rainFallDistance = 0
  private lastRainUpdateMs = 0
  private removeRainListener: (() => void) | null = null
  /** Current rain-driven overcast grade 0..1 (eased toward the rain target). */
  private rainTint = 0
  /** Current cloud-driven overcast grade 0..1 and the value it eases toward. */
  private cloudTint = 0
  private cloudTintTarget = 0
  private lastCloudUpdateMs = 0
  /** Frame listener of the cloud fade – only alive while it is fading. */
  private removeCloudListener: (() => void) | null = null
  /** Tile shader carrying the grade uniforms (null until the tiles load). */
  private tileShader: CustomShader | null = null

  constructor(
    private readonly viewer: Viewer,
    private readonly requestRender: () => void,
    /**
     * Upper bound on the drop pool (?drops=). Visible rain is a field of
     * blended billboards and the app treats it as an animation, so it
     * pins the render loop at full rate – on a software renderer that is
     * seconds per frame, which is what makes the E2E rain test crawl. A
     * handful of drops exercises the same code paths.
     */
    private readonly maxDrops: number = RAIN_MAX_DROPS,
    /**
     * Ellipsoidal height the rain falls from – the cloud base (see
     * CloudLayer) – or null for rain everywhere. Drops above it are
     * hidden, and a camera above it sees no rain at all: the drops are
     * around the camera, and above the clouds there are none.
     */
    private readonly rainCeiling: () => number | null = () => null,
  ) {}

  /**
   * Hands over the tile shader once the tileset exists. Grades that
   * arrived before that (the first weather poll can beat the tiles) are
   * pushed into it right away.
   */
  attachTileShader(shader: CustomShader | null): void {
    this.tileShader = shader
    if (!shader) return
    shader.setUniform(RAIN_UNIFORM, this.rainTint)
    shader.setUniform(CLOUD_UNIFORM, this.cloudTint)
  }

  /** Open-Meteo attribution (CC-BY 4.0) – call once when weather is enabled. */
  addCredit(): void {
    this.viewer.creditDisplay.addStaticCredit(
      new Credit('Weather data by <a href="https://open-meteo.com/">Open-Meteo.com</a>', false),
    )
  }

  /**
   * True while drops can be on screen – the app renders at animation
   * rate then. Not with the camera above the clouds: the whole drop
   * volume sits above the ceiling there and nothing of it is drawn.
   */
  get rainVisible(): boolean {
    if (this.rainIntensity <= 0) return false
    const ceiling = this.rainCeiling()
    if (ceiling === null) return true
    const cameraHeight = this.cameraHeight()
    return cameraHeight === null || cameraHeight - RAIN_VOLUME_HALF_HEIGHT < ceiling
  }

  /** Ellipsoidal height of the camera, or null when it has none to give. */
  private cameraHeight(): number | null {
    const position = this.viewer.camera.positionWC
    if (!position) return null
    return Cartographic.fromCartesian(position)?.height ?? null
  }

  /** Drops currently shown – the E2E tests read the rain through this. */
  get visibleDropCount(): number {
    let shown = 0
    for (const drop of this.rainDrops) if (drop.billboard.show) shown++
    return shown
  }

  /**
   * Rain overlay driven by live precipitation (mm). 0 removes the rain,
   * anything above scales the visible drop count. The drop volume follows
   * the camera (see updateRain); while rain is visible the app must render
   * continuously (the App's render loop treats it as animation).
   */
  setRain(precipitationMm: number): void {
    const intensity = Math.max(0, precipitationMm)
    if (intensity === this.rainIntensity) return
    this.rainIntensity = intensity
    if (intensity <= 0) {
      // Drops stop immediately; the overcast grade fades out in updateRain,
      // which then tears the collection and its frame listener down.
      if (this.rainBillboards) {
        for (const drop of this.rainDrops) {
          drop.active = false
          drop.billboard.show = false
        }
        this.requestRender()
      }
      return
    }
    if (!this.rainBillboards && !this.createRainDrops()) return
    const visible = Math.min(
      this.maxDrops,
      Math.round(RAIN_DROPS_BASE + intensity * RAIN_DROPS_PER_MM),
    )
    // updateRain, run before the frame is drawn, hides the active drops
    // that sit above the ceiling again
    this.rainDrops.forEach((drop, index) => {
      drop.active = index < visible
      drop.billboard.show = drop.active
    })
    this.requestRender()
  }

  /**
   * Applies the live cloud cover (percent) as an overcast grade on the
   * photo tiles – the dry, grey day the sunny photogrammetry cannot show.
   * Rain brings its own, stronger grade (see the shader), so this is only
   * about a closed sky without precipitation. Called from the app's UI
   * tick; unchanged values cost nothing.
   */
  setCloudCover(cloudCoverPercent: number): void {
    const target = cloudOvercastGrade(cloudCoverPercent)
    if (target === this.cloudTintTarget) return
    this.cloudTintTarget = target
    if (this.cloudTint === target || this.removeCloudListener) return
    // Fade on the frames the app already renders; updateCloudGrade keeps
    // requesting them until the target is reached and then unhooks itself.
    this.lastCloudUpdateMs = performance.now()
    const listener = () => this.updateCloudGrade()
    this.viewer.scene.preUpdate.addEventListener(listener)
    this.removeCloudListener = () =>
      this.viewer.scene.preUpdate.removeEventListener(listener)
    this.requestRender()
  }

  destroy(): void {
    this.removeCloudListener?.()
    this.removeCloudListener = null
    this.removeRainListener?.()
    this.removeRainListener = null
  }

  /**
   * Eases the cloud grade toward its target, paced by the wall clock. Ends
   * by removing its own frame listener, so a settled sky costs nothing –
   * an idle map must not render periodically.
   */
  private updateCloudGrade(): void {
    const now = performance.now()
    // Capped: a background tab must not fast-forward the fade
    const dt = Math.min(0.1, Math.max(0, (now - this.lastCloudUpdateMs) / 1000))
    this.lastCloudUpdateMs = now

    const step = dt / CLOUD_TINT_FADE_SECONDS
    this.cloudTint =
      this.cloudTint < this.cloudTintTarget
        ? Math.min(this.cloudTintTarget, this.cloudTint + step)
        : Math.max(this.cloudTintTarget, this.cloudTint - step)
    this.tileShader?.setUniform(CLOUD_UNIFORM, this.cloudTint)
    this.requestRender()

    if (this.cloudTint === this.cloudTintTarget) {
      this.removeCloudListener?.()
      this.removeCloudListener = null
    }
  }

  /** Soft vertical streak sprite for the raindrops (undefined in jsdom). */
  private rainSprite(): HTMLCanvasElement | undefined {
    if (typeof document === 'undefined') return undefined
    const canvas = document.createElement('canvas')
    canvas.width = 4
    canvas.height = 32
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height)
    gradient.addColorStop(0, 'rgba(255, 255, 255, 0)')
    gradient.addColorStop(0.35, 'rgba(255, 255, 255, 0.9)')
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(1, 0, 2, canvas.height)
    return canvas
  }

  /** Builds the (initially hidden) drop pool and hooks the per-frame update. */
  private createRainDrops(): boolean {
    const sprite = this.rainSprite()
    if (!sprite) return false
    const collection = new BillboardCollection()
    // World-up at the city – constant enough across the visible area. The
    // aligned axis keeps streaks vertical in world space, so they foreshorten
    // correctly when looking down.
    const up = Cartesian3.normalize(this.viewer.camera.positionWC, new Cartesian3())
    const drops: RainDrop[] = []
    for (let i = 0; i < this.maxDrops; i++) {
      // Uniform in a disc; far drops fade so the volume edge stays invisible
      const angle = Math.random() * 2 * Math.PI
      const radius = RAIN_RADIUS * Math.sqrt(Math.random())
      const fade = 1 - (0.6 * radius) / RAIN_RADIUS
      drops.push({
        billboard: collection.add({
          image: sprite,
          position: this.viewer.camera.positionWC,
          color: RAIN_COLOR.withAlpha(RAIN_MAX_ALPHA * fade),
          width: RAIN_STREAK_WIDTH,
          height: RAIN_STREAK_HEIGHT,
          alignedAxis: up,
          show: false,
        }),
        active: false,
        east: radius * Math.cos(angle),
        north: radius * Math.sin(angle),
        phase: Math.random() * 2 * RAIN_VOLUME_HALF_HEIGHT,
        speed: 0.85 + Math.random() * 0.3,
      })
    }
    this.viewer.scene.primitives.add(collection)
    this.rainBillboards = collection
    this.rainDrops = drops
    this.rainFallDistance = 0
    this.lastRainUpdateMs = performance.now()
    const listener = () => this.updateRain()
    this.viewer.scene.preUpdate.addEventListener(listener)
    this.removeRainListener = () =>
      this.viewer.scene.preUpdate.removeEventListener(listener)
    return true
  }

  /**
   * Advances the drop field once per rendered frame (scene.preUpdate),
   * paced by the wall clock. Drops keep a fixed horizontal offset in the
   * camera's east-north-up frame and wrap vertically within the volume –
   * the rain follows the camera without any respawn bookkeeping.
   */
  private updateRain(): void {
    if (!this.rainBillboards) return
    const now = performance.now()
    // Capped: a background tab must not fast-forward the fall distance
    const dt = Math.min(0.1, Math.max(0, (now - this.lastRainUpdateMs) / 1000))
    this.lastRainUpdateMs = now
    this.rainFallDistance += RAIN_FALL_MPS * dt

    // Overcast grade: ease toward the rain target; requestRender keeps the
    // frames coming during the transition even after the drops are gone.
    const tintTarget =
      this.rainIntensity > 0
        ? rainOvercastGrade(this.rainIntensity)
        : 0
    if (this.rainTint !== tintTarget) {
      const step = dt / RAIN_TINT_FADE_SECONDS
      this.rainTint =
        this.rainTint < tintTarget
          ? Math.min(tintTarget, this.rainTint + step)
          : Math.max(tintTarget, this.rainTint - step)
      this.tileShader?.setUniform(RAIN_UNIFORM, this.rainTint)
      this.requestRender()
    }

    // Rain over and the grade faded out → tear the drop field down
    if (this.rainIntensity <= 0 && this.rainTint <= 0.005) {
      this.rainTint = 0
      this.tileShader?.setUniform(RAIN_UNIFORM, 0)
      this.removeRainListener?.()
      this.removeRainListener = null
      this.viewer.scene.primitives.remove(this.rainBillboards)
      this.rainBillboards = null
      this.rainDrops = []
      this.requestRender()
      return
    }

    Transforms.eastNorthUpToFixedFrame(
      this.viewer.camera.positionWC,
      undefined,
      rainFrameScratch,
    )
    const window = 2 * RAIN_VOLUME_HALF_HEIGHT
    // Rain falls from the clouds: a drop above their base is not drawn
    const ceiling = this.rainCeiling()
    const cameraHeight = ceiling === null ? null : this.cameraHeight()
    for (const drop of this.rainDrops) {
      if (!drop.active) continue
      const fallen = drop.phase - this.rainFallDistance * drop.speed
      const up = ((fallen % window) + window) % window - RAIN_VOLUME_HALF_HEIGHT
      const shown = ceiling === null || cameraHeight === null || cameraHeight + up <= ceiling
      if (drop.billboard.show !== shown) drop.billboard.show = shown
      if (!shown) continue
      rainLocalScratch.x = drop.east
      rainLocalScratch.y = drop.north
      rainLocalScratch.z = up
      drop.billboard.position = Matrix4.multiplyByPoint(
        rainFrameScratch,
        rainLocalScratch,
        rainWorldScratch,
      )
    }
  }
}
