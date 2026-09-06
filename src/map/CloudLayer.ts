/**
 * Volumetric clouds over the city, and their shadows on it.
 *
 * A slab of cloud hangs over the whole city box at cumulus height. It is
 * drawn as one box primitive whose fragment shader marches a ray through
 * the slab and sums up what it passes – the way Cesium's own volume-cloud
 * Sandcastle does it, and unlike Cesium's CloudCollection, which paints
 * flat sprites that cast nothing. The density along the ray comes from
 * two tiled noise fields (see lib/cloud-field.ts): the coverage field
 * decides where a cloud is, cut at a threshold that the live cloud cover
 * sets, and the detail field erodes it into puffs. Each step is lit by a
 * short second march towards the sun, so the sunward side of a cloud is
 * bright and its underside grey, and graded by the time of day the way
 * the photo tiles are.
 *
 * The shadow does not come from Cesium's shadow map – that one is sized
 * and switched for a few dozen vehicles within a couple of kilometers,
 * and a cloud layer across the city would wreck both. Instead the tile
 * shader (TIME_OF_DAY_SHADER in CesiumMap) reads the same coverage field
 * at the point where the sun's ray from a street crosses the layer, and
 * dims the street by what the column there lets through. The layer
 * pushes the field, the threshold, the drift and the frame it all lives
 * in into that shader through attachTileShader; the two agree because
 * they read one texture with one formula.
 *
 * The clouds drift with the wind the weather reports, on the simulated
 * clock: a time-lapse sky races, a paused one stands still, as the sun
 * does. Nothing renders for the drift on its own – a frame is asked for
 * once the drift since the last drawn frame adds up to a visible step on
 * screen (see screen-motion.ts), the same rule the moving fleets follow.
 *
 * Cost: the ray march runs per pixel the slab covers. From below the base
 * (the close-up views) the slab is above the frame and costs nothing;
 * from the home view it covers the whole frame, but the ray crosses the
 * thin slab in a few steps. Empty stretches are skipped with coarse steps
 * and only the steps inside a cloud pay for the light march. WebGL 2
 * only (3D textures) – on a WebGL 1 context the layer stays dark.
 */

import {
  BlendingState,
  BoundingSphere,
  BoxGeometry,
  Cartesian2,
  Cartesian3,
  CullFace,
  type CustomShader,
  DepthFunction,
  GeometryPipeline,
  Matrix4,
  PixelDatatype,
  PixelFormat,
  PrimitiveType,
  TextureMagnificationFilter,
  TextureMinificationFilter,
  TextureUniform,
  Transforms,
  VertexFormat,
  type Viewer,
} from 'cesium'
import type { City } from '@/lib/city'
import {
  buildCoverageField,
  buildDetailField,
  cloudDrift,
  COVERAGE_SOFTNESS,
  coverageThreshold,
  CoverageQuantiles,
  type CloudField,
} from '@/lib/cloud-field'
import {
  renderer,
  type DrawCommand,
  type FrameState,
  type Texture,
  type Texture3D,
} from './cesium-renderer'
import { cssPixelsPerMeterAtUnitDistance, motionThresholdCssPx } from './screen-motion'

export interface CloudLayerHost {
  requestRender(): void
  /** Ellipsoidal height of the ground under the city – the slab floats above it. */
  readonly groundHeight: number
  /** Unit sun direction in the earth-fixed frame, null before the first scene time. */
  readonly sunDirection: Cartesian3 | null
  /** How overcast the tiles are graded, 0 … 1 – a closed sky throws no shadow. */
  readonly overcast: number
  /** Whether the sky can be in the frame at all (see CesiumMap). */
  horizonMayBeInView(): boolean
  /** Device pixels per CSS pixel the map draws at (motion threshold). */
  readonly pixelRatio: number
}

/**
 * Where the layer hangs: cumulus base and thickness above the ground, in
 * meters. A fair-weather base over northern Germany sits at 1–2 km; this
 * keeps the close-up views (a few hundred meters up) well under it, so
 * the clouds are something to look up at and the streets get the shadow.
 */
export const CLOUD_BASE_M = 1100
export const CLOUD_THICKNESS_M = 900

/** How far the slab reaches past the city box on every side, in meters. */
const SLAB_MARGIN_M = 25_000

/**
 * The coverage field: 256 texels tiled every 32 km (125 m a texel – the
 * detail field carries the edges), five lattice cells across the tile, so
 * the cumulus cells come out a few kilometers across.
 */
const COVERAGE_TEXELS = 256
const COVERAGE_TILE_M = 32_000
const COVERAGE_CELLS = 5
/**
 * The detail field: a 64 × 64 × 32 box tiled every 4 km horizontally and
 * spanning the slab's thickness vertically, four lattice cells across and
 * two up.
 */
const DETAIL_TEXELS = 64
const DETAIL_DEPTH = 32
const DETAIL_TILE_M = 3000
const DETAIL_CELLS = 5
const DETAIL_CELLS_Z = 2

/**
 * Seen from far above, a closed sky is a white blanket and the city under
 * it is gone – true to life, and useless on a map. So once the camera
 * rises this far above the cloud tops the clouds thin to a veil: full
 * density up to VEIL_START_M above the tops, VEIL_DENSITY of it from
 * VEIL_FULL_M up. The shadow on the ground stays at full strength – that
 * is what says "clouds" from up there.
 */
const VEIL_START_M = 800
const VEIL_FULL_M = 3500
const VEIL_DENSITY = 0.5

/**
 * The march: step length in meters and the most steps a ray takes. A
 * vertical ray crosses the slab in fifteen fine steps; a slanted one runs
 * out of steps a few kilometers in, where the haze has taken over
 * anyway. Empty stretches advance by COARSE_STEP_FACTOR fine steps.
 */
const STEP_M = 60
const MAX_STEPS = 48
const COARSE_STEP_FACTOR = 3
/**
 * Extinction per meter at full density. Over the slab's thickness that
 * is an optical depth of a few – the middle of a cumulus is opaque, its
 * edges are not.
 */
const EXTINCTION_PER_M = 0.0045
/** Distance at which the clouds have faded most of the way into the haze. */
const HAZE_DISTANCE_M = 22_000

/**
 * The cloud cover eases at the pace of the tile grade (see WeatherOverlay):
 * a poll landing must not switch a sky on.
 */
const COVER_FADE_SECONDS = 6

/**
 * How much of the sunlight the ground loses under a cloud at most. What
 * is left is the sky's light, which a cloud does not take away – a
 * shadow on a sunny day is not black.
 */
const SHADOW_SKY_SHARE = 0.4

/** The uniforms the tile shader reads (declared in CesiumMap – one contract). */
export const CLOUD_SHADOW_UNIFORMS = {
  coverage: 'u_cloudCoverage',
  toLocal: 'u_cloudToLocal',
  drift: 'u_cloudDrift',
  threshold: 'u_cloudThreshold',
  strength: 'u_cloudShadow',
} as const

/** Constants the tile shader needs verbatim (see TIME_OF_DAY_SHADER). */
export const CLOUD_SHADOW_GLSL = `
const float CLOUD_TILE_M = ${COVERAGE_TILE_M.toFixed(1)};
const float CLOUD_SOFTNESS = ${COVERAGE_SOFTNESS};
const float CLOUD_THICKNESS_M = ${CLOUD_THICKNESS_M.toFixed(1)};
const float CLOUD_EXTINCTION = ${EXTINCTION_PER_M};
const float CLOUD_SKY_SHARE = ${SHADOW_SKY_SHARE};
`

/**
 * Density of the coverage field cut at the threshold: 0 outside a cloud,
 * rising to the field's own value inside, so a thick cloud stays thicker
 * than a thin one even under a closed sky. Shared verbatim by the ray
 * march and the tile shader's shadow – one formula, two readers.
 */
const COLUMN_DENSITY_GLSL = `
float cloudColumn(float coverage, float threshold, float softness)
{
    float cloud = smoothstep(threshold - softness, threshold + softness, coverage);
    return cloud * (0.35 + 0.65 * coverage);
}
`

/**
 * Sunlight on the ground under the slab: the column's transmittance
 * mixed with the share the sky keeps. Used by the tile shader; exported
 * so the contract is written once.
 */
export const CLOUD_SHADOW_FUNCTION_GLSL = `
${COLUMN_DENSITY_GLSL}
float cloudShadowFactor(float column)
{
    // The height profile of a cloud integrates to about half the slab
    float transmittance = exp(-column * CLOUD_EXTINCTION * CLOUD_THICKNESS_M * 0.5);
    return CLOUD_SKY_SHARE + (1.0 - CLOUD_SKY_SHARE) * transmittance;
}
`

const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;

out vec3 v_positionMC;

void main()
{
    vec4 p = czm_translateRelativeToEye(position3DHigh, position3DLow);
    // Model coordinates: the unit box the slab is scaled from
    v_positionMC = position3DHigh + position3DLow;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`

const FRAGMENT_SHADER = `
uniform sampler2D u_coverage;
uniform sampler3D u_detail;
// Slab size in meters – the unit box scaled by it is the slab
uniform vec3 u_slabSize;
uniform float u_threshold;
uniform vec2 u_drift;
// Sun direction in the slab's east-north-up frame
uniform vec3 u_sunLocal;
uniform vec3 u_sunColor;
uniform vec3 u_ambientColor;
uniform vec3 u_hazeColor;
// 1 near the clouds, less far above them (see VEIL_DENSITY)
uniform float u_densityScale;

in vec3 v_positionMC;

const float COVERAGE_TILE_M = ${COVERAGE_TILE_M.toFixed(1)};
const float DETAIL_TILE_M = ${DETAIL_TILE_M.toFixed(1)};
const float SOFTNESS = ${COVERAGE_SOFTNESS};
const float STEP_M = ${STEP_M.toFixed(1)};
const float COARSE_STEP_M = ${(STEP_M * COARSE_STEP_FACTOR).toFixed(1)};
const int MAX_STEPS = ${MAX_STEPS};
const float EXTINCTION = ${EXTINCTION_PER_M};
const float HAZE_DISTANCE_M = ${HAZE_DISTANCE_M.toFixed(1)};

${COLUMN_DENSITY_GLSL}

uint wangHash(uint seed)
{
    seed = (seed ^ 61u) ^ (seed >> 16u);
    seed *= 9u;
    seed = seed ^ (seed >> 4u);
    seed *= 0x27d4eb2du;
    seed = seed ^ (seed >> 15u);
    return seed;
}

// The coverage column at a point of the slab, in meters east/north
float columnAt(vec2 xy)
{
    float coverage = texture(u_coverage, (xy + u_drift) / COVERAGE_TILE_M).r;
    return cloudColumn(coverage, u_threshold, SOFTNESS);
}

// Density 0 … 1 at a point in slab meters (z from -half to +half)
float densityAt(vec3 p)
{
    float column = columnAt(p.xy);
    if (column <= 0.0) return 0.0;
    float h = p.z / u_slabSize.z + 0.5;
    // Flat bottom, rounded top; a thicker column reaches higher
    float top = mix(0.45, 1.0, column);
    float profile = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.45 * top, top, h));
    float base = column * profile;
    if (base <= 0.0) return 0.0;
    // Erode the edges with the detail field at two scales – the coarse
    // one shapes the puffs, the fine one frays them – hardest at the top,
    // where a cumulus breaks up into cauliflower, gentlest at the base
    vec2 detailXY = (p.xy + 0.6 * u_drift) / DETAIL_TILE_M;
    float coarse = texture(u_detail, vec3(detailXY, h)).r;
    float fine = texture(u_detail, vec3(detailXY * 3.7 + 0.31, h * 2.0)).r;
    float detail = 0.65 * coarse + 0.35 * fine;
    float erosion = mix(0.5, 0.85, h);
    float floorLevel = (1.0 - detail) * erosion;
    return clamp((base - floorLevel) / max(1.0 - floorLevel, 1e-3), 0.0, 1.0) * u_densityScale;
}

void main()
{
    vec3 originMC = czm_encodedCameraPositionMCHigh + czm_encodedCameraPositionMCLow;
    // Into meters: the model matrix scales the unit box to the slab
    vec3 origin = originMC * u_slabSize;
    vec3 dir = normalize((v_positionMC - originMC) * u_slabSize);
    vec3 safeDir = sign(dir) * max(abs(dir), vec3(1e-5));
    vec3 halfSize = 0.5 * u_slabSize;

    // Where the ray enters and leaves the slab
    vec3 inv = 1.0 / safeDir;
    vec3 tA = (-halfSize - origin) * inv;
    vec3 tB = (halfSize - origin) * inv;
    vec3 tMin = min(tA, tB);
    vec3 tMax = max(tA, tB);
    float tEnter = max(0.0, max(tMin.x, max(tMin.y, tMin.z)));
    float tExit = min(tMax.x, min(tMax.y, tMax.z));
    if (tExit <= tEnter) discard;

    // A per-pixel start offset hides the step banding; fixed per pixel
    // rather than per frame, so a still picture does not shimmer
    uint seed = uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u;
    float jitter = float(wangHash(seed)) / 4294967296.0;
    float t = tEnter + jitter * STEP_M;

    vec3 color = vec3(0.0);
    float alpha = 0.0;
    for (int i = 0; i < MAX_STEPS; ++i)
    {
        if (t >= tExit || alpha >= 0.98) break;
        vec3 p = origin + dir * t;
        float density = densityAt(p);
        if (density <= 0.002)
        {
            t += COARSE_STEP_M;
            continue;
        }

        // Light march: three samples towards the sun, spread over a few
        // hundred meters, say how deep inside the cloud this step sits –
        // the sunward face stays bright, the underside and the folds grey
        float shade = densityAt(p + u_sunLocal * 120.0)
            + densityAt(p + u_sunLocal * 320.0)
            + 0.7 * densityAt(p + u_sunLocal * 700.0);
        float sunlight = exp(-shade * EXTINCTION * 190.0);
        // Beer-Powder: a thin edge scatters little back towards the eye,
        // which is what makes a puff's rim darker than its body
        float powder = 1.0 - 0.55 * exp(-density * 5.0);
        float h = p.z / u_slabSize.z + 0.5;
        vec3 lit = u_ambientColor * mix(0.55, 1.0, h) + u_sunColor * sunlight * powder;

        // Aerial perspective: far clouds sink into the haze like the city does
        float haze = 1.0 - exp(-t / HAZE_DISTANCE_M);
        vec3 sampleColor = mix(lit, u_hazeColor, haze);

        float a = 1.0 - exp(-density * EXTINCTION * STEP_M);
        color += (1.0 - alpha) * a * sampleColor;
        alpha += (1.0 - alpha) * a;
        t += STEP_M;
    }
    if (alpha <= 0.003) discard;
    out_FragColor = vec4(color / alpha, alpha);
}
`

/** Sun and sky colours the clouds are lit with, by the sun's height. */
interface CloudLight {
  sun: Cartesian3
  ambient: Cartesian3
  haze: Cartesian3
}

function lerpColor(a: [number, number, number], b: [number, number, number], t: number) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as [
    number,
    number,
    number,
  ]
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * The light on the clouds for a sun height (sine of its elevation, as the
 * tile shader reads it) and an overcast grade. The anchors follow the
 * tile grade: full day above +8°, golden hour down to sunset, dusk while
 * the sun sinks to -5°, night below. A closed sky flattens the light –
 * less sun on the tops, and what there is comes greyer.
 */
export function cloudLight(sunUp: number, overcast: number): CloudLight {
  const day = smoothstep(0.0, 0.14, sunUp)
  const dusk = smoothstep(-0.09, 0.0, sunUp)
  const night = smoothstep(-0.17, -0.07, sunUp)
  const sunColor = lerpColor(
    lerpColor([0.4, 0.2, 0.15], [0.75, 0.5, 0.3], dusk),
    [0.62, 0.6, 0.56],
    day,
  )
  const sunStrength = night * (0.25 + 0.75 * dusk) * (1 - 0.6 * overcast)
  const ambient = lerpColor(
    lerpColor([0.05, 0.065, 0.11], [0.28, 0.26, 0.34], night),
    [0.5, 0.57, 0.68],
    day,
  )
  const ambientStrength = 1 - 0.3 * overcast
  const haze = lerpColor(
    lerpColor([0.04, 0.05, 0.09], [0.45, 0.4, 0.45], night),
    [0.76, 0.82, 0.92],
    day,
  )
  const hazeStrength = 1 - 0.25 * overcast
  return {
    sun: new Cartesian3(
      sunColor[0] * sunStrength,
      sunColor[1] * sunStrength,
      sunColor[2] * sunStrength,
    ),
    ambient: new Cartesian3(
      ambient[0] * ambientStrength,
      ambient[1] * ambientStrength,
      ambient[2] * ambientStrength,
    ),
    haze: new Cartesian3(haze[0] * hazeStrength, haze[1] * hazeStrength, haze[2] * hazeStrength),
  }
}

/**
 * How much of a shadow the clouds throw, 0 … 1: none until the sun is a
 * few degrees up (a grazing sun's shadow is the horizon's), and less
 * under a closed sky, where the light is diffuse and the tile grade has
 * already dimmed the city.
 */
export function cloudShadowStrength(sunUp: number, overcast: number): number {
  return smoothstep(0.03, 0.2, sunUp) * (1 - 0.6 * overcast)
}

/**
 * Density the clouds are drawn at for a camera `aboveTopsMeters` over the
 * cloud tops: 1 up close, thinning to VEIL_DENSITY far above (see the
 * constants for why). Negative heights – below the tops – are up close.
 */
export function cloudVeil(aboveTopsMeters: number): number {
  return 1 - (1 - VEIL_DENSITY) * smoothstep(VEIL_START_M, VEIL_FULL_M, aboveTopsMeters)
}

/** The two noise fields and the histogram the threshold is read from. */
interface CloudFields {
  coverage: CloudField
  quantiles: CoverageQuantiles
  detail: CloudField
  /** The coverage field as the tile shader takes it. */
  coverageUniform: TextureUniform
}

/** Everything that needs a GL context – built on the first frame drawn. */
interface CloudResources {
  coverageTexture: Texture
  detailTexture: Texture3D
  command: DrawCommand
}

const scratchCenter = new Cartesian3()
const scratchScale = new Cartesian3()
const scratchSun = new Cartesian3()

export class CloudLayer {
  /** Cloud cover in percent, as applied and as asked for. */
  private coverApplied = 0
  private coverTarget = 0
  private lastCoverUpdateMs = 0
  private fields: CloudFields | null = null
  private resources: CloudResources | null = null
  private unsupported = false
  private destroyed = false
  private underground = false
  /** The switch in the weather popover: off draws nothing and shadows nothing. */
  private enabled: boolean
  private tileShader: CustomShader | null = null

  /** The wind, as drift in meters per second east and north. */
  private driftEastMps = 0
  private driftNorthMps = 0
  /** Accumulated drift in meters (unwrapped; the shader gets it wrapped). */
  private driftEast = 0
  private driftNorth = 0
  private lastSimMs: number | null = null
  /** Drift at the frame last drawn – the reference for screen motion. */
  private renderedDriftEast = 0
  private renderedDriftNorth = 0

  /** The city the slab spans and the ground it was placed on. */
  private city: City
  private placedGroundHeight = Number.NaN
  private readonly modelMatrix = new Matrix4()
  /** World → slab meters, z up from the base (the tile shader's frame). */
  private readonly toLocal = new Matrix4()
  private readonly slabSize = new Cartesian3()
  private readonly boundingSphere = new BoundingSphere()

  // Uniform values, updated in place – the uniform map reads them
  private readonly uDrift = new Cartesian2()
  private readonly uSunLocal = new Cartesian3(0, 0, 1)
  private light: CloudLight = cloudLight(1, 0)
  private threshold = 1 + COVERAGE_SOFTNESS
  private densityScale = 1

  constructor(
    private readonly viewer: Viewer,
    private readonly host: CloudLayerHost,
    city: City,
    /** The switch's position from the start (see config.weather.clouds3dDefault). */
    enabled: boolean,
  ) {
    this.city = city
    this.enabled = enabled
    this.viewer.scene.primitives.add(this)
  }

  /** The tile shader the shadow rides in (see CesiumMap.createTileset). */
  attachTileShader(shader: CustomShader | null): void {
    this.tileShader = shader
    if (shader && this.fields) shader.setUniform(CLOUD_SHADOW_UNIFORMS.coverage, this.fields.coverageUniform)
    this.pushShadowUniforms()
  }

  /** Another city: the slab moves over it on the next frame. */
  setCity(city: City): void {
    this.city = city
    this.placedGroundHeight = Number.NaN
    this.host.requestRender()
  }

  setUnderground(underground: boolean): void {
    if (underground === this.underground) return
    this.underground = underground
    this.pushShadowUniforms()
    this.host.requestRender()
  }

  /**
   * The viewer's switch. Off, the clouds and their shadow are gone at
   * once (no fade – it is a switch, not the weather changing) while the
   * cover keeps being tracked, so switching back on shows the sky as it
   * is. The tile grade for a closed sky is not touched: that is the
   * weather, this is only how it is drawn.
   */
  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return
    this.enabled = enabled
    // The fields were put off while the switch was off (see setCloudCover)
    if (enabled && this.coverTarget > 0 && !this.fields) this.buildFields()
    this.lastCoverUpdateMs = performance.now()
    this.pushShadowUniforms()
    this.host.requestRender()
  }

  /**
   * The live cloud cover in percent. The first cover above zero builds
   * the noise fields (a few tens of milliseconds, once); the cover then
   * eases in over COVER_FADE_SECONDS on the frames it requests.
   */
  setCloudCover(cloudCoverPercent: number): void {
    const target = Math.min(100, Math.max(0, cloudCoverPercent))
    if (target === this.coverTarget) return
    this.coverTarget = target
    // Switched off, the cover is only remembered: no fields, no fade, no
    // frames – the switch pays for all of that when it is turned on
    if (!this.enabled) return
    if (target > 0 && !this.fields) this.buildFields()
    this.lastCoverUpdateMs = performance.now()
    this.host.requestRender()
  }

  /** The wind the clouds ride: speed in m/s, direction it blows from in degrees. */
  setWind(windSpeedMps: number, windFromDeg: number): void {
    const drift = cloudDrift(windSpeedMps, windFromDeg)
    this.driftEastMps = drift.eastMps
    this.driftNorthMps = drift.northMps
  }

  /**
   * Per UI tick: carries the drift forward by the simulated time, and
   * asks for a frame once the clouds have moved a visible step on screen
   * since the frame last drawn.
   */
  advance(simEpochMs: number): void {
    if (this.lastSimMs !== null) {
      const dt = (simEpochMs - this.lastSimMs) / 1000
      // A jump back (time input) re-seeds; a jump forward moves the sky
      // as a time-lapse would, up to a day's worth
      if (Number.isFinite(dt) && dt > 0 && dt <= 86_400) {
        this.driftEast += this.driftEastMps * dt
        this.driftNorth += this.driftNorthMps * dt
      }
    }
    this.lastSimMs = simEpochMs
    if (!this.visible()) return
    const movedMeters = Math.hypot(
      this.driftEast - this.renderedDriftEast,
      this.driftNorth - this.renderedDriftNorth,
    )
    if (movedMeters <= 0) return
    const pxPerMeter = cssPixelsPerMeterAtUnitDistance(this.viewer) / Math.max(1, this.distanceToSlab())
    if (movedMeters * pxPerMeter >= motionThresholdCssPx(this.host.pixelRatio)) {
      this.host.requestRender()
    }
  }

  /** The map drew a frame: the drift from here on is what has not been shown. */
  markRendered(): void {
    this.renderedDriftEast = this.driftEast
    this.renderedDriftNorth = this.driftNorth
  }

  /** Debug and tests. */
  get state(): {
    enabled: boolean
    coverPercent: number
    coverApplied: number
    threshold: number
    drawn: boolean
    supported: boolean
    driftMeters: { east: number; north: number }
  } {
    return {
      enabled: this.enabled,
      coverPercent: this.coverTarget,
      coverApplied: this.coverApplied,
      threshold: this.threshold,
      drawn: this.resources !== null && this.visible(),
      supported: !this.unsupported,
      driftMeters: { east: this.driftEast, north: this.driftNorth },
    }
  }

  /** Whether there is anything to draw at all right now. */
  private visible(): boolean {
    if (this.destroyed || this.unsupported || !this.enabled || this.underground || !this.fields) {
      return false
    }
    if (this.coverApplied <= 0 && this.coverTarget <= 0) return false
    // Below the base the clouds are only in a frame that reaches the sky
    return this.cameraHeightAboveGround() >= CLOUD_BASE_M || this.host.horizonMayBeInView()
  }

  private cameraHeightAboveGround(): number {
    return this.viewer.camera.positionCartographic.height - this.host.groundHeight
  }

  /** Vertical distance from the camera to the nearest cloud, in meters. */
  private distanceToSlab(): number {
    const h = this.cameraHeightAboveGround()
    if (h < CLOUD_BASE_M) return CLOUD_BASE_M - h
    const top = CLOUD_BASE_M + CLOUD_THICKNESS_M
    return h > top ? h - top : 0
  }

  private buildFields(): void {
    const coverage = buildCoverageField(COVERAGE_TEXELS, COVERAGE_CELLS)
    const detail = buildDetailField(
      DETAIL_TEXELS,
      DETAIL_TEXELS,
      DETAIL_DEPTH,
      DETAIL_CELLS,
      DETAIL_CELLS_Z,
    )
    const coverageUniform = new TextureUniform({
      typedArray: coverage.data,
      width: coverage.width,
      height: coverage.height,
      pixelFormat: PixelFormat.LUMINANCE,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      repeat: true,
      minificationFilter: TextureMinificationFilter.LINEAR,
      magnificationFilter: TextureMagnificationFilter.LINEAR,
    })
    this.fields = { coverage, quantiles: new CoverageQuantiles(coverage), detail, coverageUniform }
    this.tileShader?.setUniform(CLOUD_SHADOW_UNIFORMS.coverage, coverageUniform)
  }

  /** Eases the applied cover towards its target on the wall clock. */
  private updateCover(): void {
    if (this.coverApplied === this.coverTarget) return
    const now = performance.now()
    // Capped: a background tab must not fast-forward the fade
    const dt = Math.min(0.1, Math.max(0, (now - this.lastCoverUpdateMs) / 1000))
    this.lastCoverUpdateMs = now
    const step = (100 * dt) / COVER_FADE_SECONDS
    this.coverApplied =
      this.coverApplied < this.coverTarget
        ? Math.min(this.coverTarget, this.coverApplied + step)
        : Math.max(this.coverTarget, this.coverApplied - step)
    if (this.coverApplied !== this.coverTarget) this.host.requestRender()
  }

  /** Places the slab over the city, once and again when the ground moves. */
  private placeSlab(): void {
    const ground = this.host.groundHeight
    if (ground === this.placedGroundHeight) return
    this.placedGroundHeight = ground
    const box = this.city.boundingBox
    const midLat = ((box.south + box.north) / 2) * (Math.PI / 180)
    const width = (box.east - box.west) * 111_320 * Math.cos(midLat) + 2 * SLAB_MARGIN_M
    const height = (box.north - box.south) * 110_574 + 2 * SLAB_MARGIN_M
    Cartesian3.fromElements(width, height, CLOUD_THICKNESS_M, this.slabSize)

    const lon = (box.west + box.east) / 2
    const lat = (box.south + box.north) / 2
    // The frame the tile shader works in: east-north-up at the base
    const base = Transforms.eastNorthUpToFixedFrame(
      Cartesian3.fromDegrees(lon, lat, ground + CLOUD_BASE_M, undefined, scratchCenter),
    )
    Matrix4.inverseTransformation(base, this.toLocal)
    // The box: the same frame at the slab's middle, scaled to its size
    const center = Cartesian3.fromDegrees(
      lon,
      lat,
      ground + CLOUD_BASE_M + CLOUD_THICKNESS_M / 2,
      undefined,
      scratchCenter,
    )
    const frame = Transforms.eastNorthUpToFixedFrame(center, undefined, this.modelMatrix)
    Matrix4.multiplyByScale(frame, Cartesian3.clone(this.slabSize, scratchScale), this.modelMatrix)
    Cartesian3.clone(center, this.boundingSphere.center)
    this.boundingSphere.radius = 0.5 * Cartesian3.magnitude(this.slabSize)
    this.tileShader?.setUniform(CLOUD_SHADOW_UNIFORMS.toLocal, this.toLocal)
  }

  /** Sun direction in the slab's frame and the colours that go with it. */
  private updateLighting(): void {
    const sun = this.host.sunDirection
    if (!sun) return
    Matrix4.multiplyByPointAsVector(this.toLocal, sun, scratchSun)
    Cartesian3.normalize(scratchSun, this.uSunLocal)
    // The frame's z is up: the sine of the sun's elevation over the city
    this.light = cloudLight(this.uSunLocal.z, this.host.overcast)
  }

  /** What the tile shader needs to shadow the streets, at this moment. */
  private pushShadowUniforms(): void {
    const shader = this.tileShader
    if (!shader) return
    const sunUp = this.uSunLocal.z
    const strength =
      this.visibleForShadow() ? cloudShadowStrength(sunUp, this.host.overcast) : 0
    shader.setUniform(CLOUD_SHADOW_UNIFORMS.strength, strength)
    shader.setUniform(CLOUD_SHADOW_UNIFORMS.threshold, this.threshold)
    shader.setUniform(CLOUD_SHADOW_UNIFORMS.drift, this.uDrift)
    shader.setUniform(CLOUD_SHADOW_UNIFORMS.toLocal, this.toLocal)
  }

  /** The shadow does not depend on the slab being in the frame – only on there being clouds. */
  private visibleForShadow(): boolean {
    return (
      !this.destroyed &&
      !this.unsupported &&
      this.enabled &&
      !this.underground &&
      this.fields !== null &&
      this.coverApplied > 0
    )
  }

  /** Everything that needs the GL context, built on the first frame. */
  private ensureResources(frameState: FrameState): CloudResources | null {
    if (this.resources) return this.resources
    const fields = this.fields
    if (!fields) return null
    const context = frameState.context
    if (!context.webgl2) {
      this.unsupported = true
      return null
    }
    const repeat = new renderer.Sampler({
      wrapS: renderer.TextureWrap.REPEAT,
      wrapT: renderer.TextureWrap.REPEAT,
      wrapR: renderer.TextureWrap.REPEAT,
      minificationFilter: TextureMinificationFilter.LINEAR,
      magnificationFilter: TextureMagnificationFilter.LINEAR,
    })
    const coverageTexture = new renderer.Texture({
      context,
      width: fields.coverage.width,
      height: fields.coverage.height,
      pixelFormat: PixelFormat.LUMINANCE,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: repeat,
      source: { arrayBufferView: fields.coverage.data },
    })
    const detailTexture = new renderer.Texture3D({
      context,
      width: fields.detail.width,
      height: fields.detail.height,
      depth: fields.detail.depth,
      pixelFormat: PixelFormat.RED,
      pixelDatatype: PixelDatatype.UNSIGNED_BYTE,
      flipY: false,
      sampler: repeat,
      source: {
        arrayBufferView: fields.detail.data,
        width: fields.detail.width,
        height: fields.detail.height,
        depth: fields.detail.depth,
      },
    })

    // The unit box, positions split into high and low floats for the
    // relative-to-eye vertex transform
    const geometry = GeometryPipeline.encodeAttribute(
      BoxGeometry.createGeometry(
        new BoxGeometry({
          minimum: new Cartesian3(-0.5, -0.5, -0.5),
          maximum: new Cartesian3(0.5, 0.5, 0.5),
          vertexFormat: VertexFormat.POSITION_ONLY,
        }),
      )!,
      'position',
      'position3DHigh',
      'position3DLow',
    )
    const attributeLocations = GeometryPipeline.createAttributeLocations(geometry)
    const vertexArray = renderer.VertexArray.fromGeometry({ context, geometry, attributeLocations })
    const shaderProgram = renderer.ShaderProgram.fromCache({
      context,
      attributeLocations,
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: FRAGMENT_SHADER,
    })
    // Back faces only: the camera may be inside the slab, and the ray
    // march starts from the camera anyway. No depth write – the clouds
    // are a volume, not a surface; the depth test keeps the city in
    // front of the slab's far side where it belongs.
    const renderState = renderer.RenderState.fromCache({
      depthMask: false,
      depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL },
      cull: { enabled: true, face: CullFace.FRONT },
      blending: BlendingState.ALPHA_BLEND,
    })
    const command = new renderer.DrawCommand({
      owner: this,
      boundingVolume: this.boundingSphere,
      modelMatrix: this.modelMatrix,
      primitiveType: PrimitiveType.TRIANGLES,
      vertexArray,
      shaderProgram,
      renderState,
      pass: renderer.Pass.TRANSLUCENT,
      uniformMap: {
        u_coverage: () => coverageTexture,
        u_detail: () => detailTexture,
        u_slabSize: () => this.slabSize,
        u_threshold: () => this.threshold,
        u_drift: () => this.uDrift,
        u_sunLocal: () => this.uSunLocal,
        u_sunColor: () => this.light.sun,
        u_ambientColor: () => this.light.ambient,
        u_hazeColor: () => this.light.haze,
        u_densityScale: () => this.densityScale,
      },
    })
    this.resources = { coverageTexture, detailTexture, command }
    return this.resources
  }

  /** Cesium's primitive contract: once per frame, before the commands run. */
  update(frameState: FrameState): void {
    if (this.destroyed || !frameState.passes.render) return
    // Switched off there is nothing to draw, nothing to shadow (the
    // switch pushed that off) and nothing to keep current: a frame drawn
    // now is someone else's, and this costs it a function call
    if (!this.enabled) return
    this.updateCover()
    const fields = this.fields
    if (!fields) return
    this.threshold = coverageThreshold(this.coverApplied, fields.quantiles)
    // Wrapped for the shader: the fields repeat every tile
    this.uDrift.x = this.driftEast % COVERAGE_TILE_M
    this.uDrift.y = this.driftNorth % COVERAGE_TILE_M
    this.placeSlab()
    this.updateLighting()
    this.pushShadowUniforms()
    this.densityScale = cloudVeil(this.cameraHeightAboveGround() - CLOUD_BASE_M - CLOUD_THICKNESS_M)
    if (!this.visible()) return
    const resources = this.ensureResources(frameState)
    if (!resources) return
    frameState.commandList.push(resources.command)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    const resources = this.resources
    this.resources = null
    if (!resources) return
    resources.command.vertexArray.destroy()
    resources.command.shaderProgram.destroy()
    resources.coverageTexture.destroy()
    resources.detailTexture.destroy()
  }
}
