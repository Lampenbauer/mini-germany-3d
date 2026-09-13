/**
 * Bridge decks read off the tiles.
 *
 * The route heights in network.json come from a bare-earth terrain model,
 * which knows no structures: under a bridge it holds the street or the
 * water, so the pipeline draws every bridge as a straight deck between
 * the terrain heights at its two ends (scripts/lib/route-heights.mjs).
 * That is a river bridge. A viaduct is not: Berlin's Stadtbahn is one
 * bridge range of six kilometres whose ends meet the ground, so its whole
 * deck came out at street level and the S-Bahn ran through the arches,
 * ten metres under the upper level of the Hauptbahnhof.
 *
 * So inside a bridge range the deck is measured on the Google tiles at
 * run time, point by point – the path's vertices and, where a straight
 * bridge way has none for a hundred metres, stations every
 * DECK_STATION_SPACING_M between them, so the hump of a bridge is
 * followed rather than cut by a chord – the way the ships read the water off them
 * (VesselLayer): only vertices on screen, a few per pass, nearest to the
 * camera first, again after every load cycle (host.surfaceGeneration),
 * and kept for the rest of the city visit – a stretch once measured
 * costs nothing more. The vehicles and the route polylines take the
 * measured deck wherever one exists and the pipeline's profile
 * everywhere else, interpolated between the two at the portals.
 *
 * The measurement is tileset.getHeight – a CPU ray against the loaded
 * tiles, ~1 ms measured on Berlin's real tiles (2026-09-08) – and not
 * scene.clampToHeight, which is an offscreen render pass with a
 * readPixels stall (the ships' cost). The ray only answers where a tile
 * is loaded and selected, which for a vertex on screen is soon, and it
 * reads the tile's geometry back from the GPU only once per tile (see
 * buffer-readback-cache.ts).
 *
 * A ray answers with whatever is on top – or, where the mesh has no
 * deck (Google's photogrammetry loses thin bridges; the Humboldthafen
 * bridge at the Hauptbahnhof is water in the mesh), with whatever is
 * underneath. Over a station hall the top is the roof (Berlin's
 * Stadtbahn halls stand 12–16 m over the rails), over a survey-day train
 * its own roof. So a sample is trusted only where it says something the
 * profile does not – standing clear above it, as a deck above the ground
 * does – and, among those, a deck rises with a gradient and a roof
 * steps, so every sample no deck could climb to from its neighbours is a
 * roof and interpolated across (see deckFromSamples). A sample that is
 * not clear above the profile is left to the profile: at a portal that
 * is where the deck meets the ground, over a hole it is the old
 * straight deck for the length of the hole. A sample only a little
 * above the profile – a low bridge, whose deck the profile nearly has
 * anyway – sets its own point and nothing else (see deckFromSamples).
 */

import { BoundingSphere, Cartesian3, Intersect, type Viewer } from 'cesium'
import { directionsAreMirrored } from '@/data/network'
import type { PreparedDirection, PreparedNetwork } from '@/data/network-types'
import { heightAtDistance, sampleAtDistance } from '@/lib/geo'
import type { TransitMode } from '@/lib/transit-mode'
import type { TunnelRange } from '@/lib/tunnels'
import { cameraFramingScale } from './CameraLens'

/** What the deck measurement needs from the map around it. */
export interface BridgeDecksHost {
  /**
   * Ellipsoidal height of the loaded tiles under a point
   * (Cesium3DTileset.getHeight); undefined where no selected tile answers.
   */
  sampleSurfaceHeight(lon: number, lat: number): number | undefined
  /**
   * Bumped whenever the loaded tiles changed – a load cycle finished, or
   * the tileset was swapped – so a deck read off a coarse tile is read
   * again off the fine one.
   */
  surfaceGeneration(): number
  /** A direction's measured deck changed – the routes redraw it. */
  deckChanged(lineId: string, direction: 0 | 1): void
  /** NHN→ellipsoid offset the profile heights are drawn at (RoutesLayer). */
  routeHeightOffset(): number
  requestRender(): void
}

/**
 * A pass every DECK_SAMPLE_INTERVAL_MS measures up to DECK_SAMPLE_BUDGET
 * vertices: ~1 ms a ray, so a pass costs some 6 ms – 3 % of a core while
 * there is something left to measure – and 30 vertices a second: a
 * viaduct in view is done in seconds, a chase cam at 30 m/s meets a new
 * vertex every second or two.
 */
const DECK_SAMPLE_INTERVAL_MS = 200
const DECK_SAMPLE_BUDGET = 6
/** Vertices are measured out to this distance at the reference lens. */
const DECK_SAMPLE_RANGE_AT_REFERENCE = 6000
/**
 * A direction's routes are rewritten at most this often while its deck
 * is still filling in: every rewrite re-batches Cesium's polyline
 * geometry, one-off work by design (RoutesLayer), not a per-pass one.
 */
const DECK_PUBLISH_INTERVAL_MS = 1000
/** A re-read within this of the last value is not a change. */
const DECK_CHANGE_M = 0.05

/**
 * Which samples are trusted (see deckFromSamples).
 *
 * A sample counts as a deck – one the envelope below is built on – only
 * DECK_ABOVE_PROFILE_M or more above the profile: a ray through a hole
 * in the mesh lands on the street (about the profile) or the water
 * (under it), a deck stands 3 m and more over the ground. Between
 * DECK_ABOVE_PROFILE_WEAK_M and that a sample is weak: a low bridge
 * whose deck the profile nearly has (Frankfurt's Friedensbrücke stands
 * 1.3 m over it), or a hole to a street. It sets its own point where no
 * deck sample encloses it, and never pulls a neighbour. Below that a
 * sample is left to the profile. A run of weak or low samples enclosed
 * by deck samples within HOLE_SPAN_M is a hole in a deck that goes on,
 * and is bridged.
 *
 * DECK_STATION_SPACING_M: a straight bridge way has few nodes (the
 * Friedensbrücke: one in 289 m), so points are measured at most this far
 * apart, the path's vertices plus stations between them.
 *
 * DECK_MAX_GRADIENT is the steepest a deck is taken to run, per mode: a
 * ramp steeper than it is softened to it, and a hall longer than twice
 * its roof height over it keeps a tent in its middle. Railways stay
 * under 4 % and their halls are the long low ones – the Hauptbahnhof's
 * is 320 m and only 8 m over the southern tracks, which 6 % let
 * through – so 3 % for them; trams climb 5 % onto a bridge, road ramps
 * reach 8 %. A hall's roof steps 12 m in a vertex spacing of 25 m, a
 * train baked into the survey 3.6 m. A trusted sample more than
 * ROOF_EPSILON_M above the envelope the gradient allows from its
 * neighbours is a roof. A sample DIP_MIN_M under both its neighbours is
 * a hole the profile rule missed and is dropped first – it would
 * otherwise pull the envelope, and the whole deck around it, down to
 * itself.
 */
const DECK_ABOVE_PROFILE_M = 2.5
const DECK_ABOVE_PROFILE_WEAK_M = 1
const HOLE_SPAN_M = 200
export const DECK_STATION_SPACING_M = 30
export const DECK_MAX_GRADIENT: Record<TransitMode, number> = {
  train: 0.03,
  subway: 0.03,
  tram: 0.05,
  bus: 0.08,
  ferry: 0.08,
}
const ROOF_EPSILON_M = 0.5
const DIP_MIN_M = 3

/**
 * One measured point. Shared between every direction whose path has a
 * vertex there – the four S-Bahn lines on the Stadtbahn run on the same
 * OSM ways and so on the same vertices, and one ray serves all eight
 * directions.
 */
interface DeckVertex {
  lon: number
  lat: number
  /** World position for the on-screen test (profile height, near enough). */
  position: Cartesian3
  /** Last measured ellipsoidal height, undefined until a tile answered. */
  height: number | undefined
  /**
   * Surface generation the vertex was last asked at, -1 = never – a ray
   * that found no tile counts too: the answer changes only with the
   * tiles, and asking again every two seconds kept a view over the water
   * (every vertex of a bridge the mesh has no deck for) at the full ray
   * budget for good (found 2026-09-13).
   */
  generation: number
  /** The directions this point is a vertex of – rebuilt when it changes. */
  owners: DeckDirection[]
}

/**
 * A point of a direction's height profile: a path vertex, or a station
 * inserted into a bridge range. Inside a range it carries the measured
 * point it stands on.
 */
interface DeckNode {
  cum: number
  lon: number
  lat: number
  /** Profile height, meters NHN (interpolated for a station). */
  nhn: number
  vertex?: DeckVertex
}

interface DeckDirection {
  lineId: string
  direction: 0 | 1
  dir: PreparedDirection
  /** The steepest deck this line's mode runs on (DECK_MAX_GRADIENT). */
  gradient: number
  /** Every node in path order – vertices and stations (see DeckNode). */
  nodes: DeckNode[]
  /** The stations alone, in path order – what the routes insert. */
  stations: DeckNode[]
  /** Deck height per node, undefined where the profile applies. */
  deck: (number | undefined)[]
  /** A measurement changed since the deck was last rebuilt. */
  dirty: boolean
  publishedAt: number
}

/** What became of a sample (see deckFromSamples). */
type Verdict = 'deck' | 'roof' | 'weak' | 'low'

const frustumSphere = new BoundingSphere()
const nearest: (DeckVertex | null)[] = new Array(DECK_SAMPLE_BUDGET).fill(null)
const nearestDistances = new Float64Array(DECK_SAMPLE_BUDGET)

/** Guess of the NHN→ellipsoid offset for the on-screen test positions. */
const POSITION_OFFSET_GUESS = 40

function directionKey(lineId: string, direction: 0 | 1): string {
  return `${lineId}:${direction}`
}

/**
 * Marks the samples that are not deck: holes first (a sample DIP_MIN_M
 * under the chord of its neighbours), then roofs – every sample above
 * the slope-limited lower envelope of the rest, i.e. one no deck at
 * DECK_MAX_GRADIENT could climb to from any trusted sample. The envelope
 * is the two-pass erosion with a cone: forward and backward, each
 * sample the minimum of itself and the previous bound plus the
 * gradient over the gap. Pure.
 */
export function pruneRoofs(
  cum: readonly number[],
  heights: readonly number[],
  gradient: number,
): boolean[] {
  const n = cum.length
  const pruned: boolean[] = new Array(n).fill(false)
  for (let k = 1; k < n - 1; k++) {
    if (Math.min(heights[k - 1], heights[k + 1]) - heights[k] > DIP_MIN_M) pruned[k] = true
  }
  const trusted: number[] = []
  for (let k = 0; k < n; k++) if (!pruned[k]) trusted.push(k)
  const envelope = new Float64Array(n).fill(Number.POSITIVE_INFINITY)
  let bound = Number.POSITIVE_INFINITY
  let at = 0
  for (const k of trusted) {
    bound = Math.min(heights[k], bound + gradient * (cum[k] - at))
    at = cum[k]
    envelope[k] = bound
  }
  bound = Number.POSITIVE_INFINITY
  for (let t = trusted.length - 1; t >= 0; t--) {
    const k = trusted[t]
    bound = Math.min(heights[k], bound + gradient * (at - cum[k]))
    at = cum[k]
    envelope[k] = Math.min(envelope[k], bound)
  }
  for (const k of trusted) if (heights[k] - envelope[k] > ROOF_EPSILON_M) pruned[k] = true
  return pruned
}

/**
 * The deck profile of a direction from its measured points, per point:
 * the measured height where it is trusted, roofs replaced by the
 * interpolation of the nearest trusted samples of the same bridge range
 * (extended flat at the range's ends), weak samples kept on their own
 * and low ones left undefined – the profile applies there – unless
 * trusted samples enclose them within HOLE_SPAN_M, and undefined outside
 * the ranges and at points no tile has answered for yet. `profile` is
 * the pipeline's height per point in the samples' (ellipsoidal) terms.
 * Pure – the class below feeds it and the tests too.
 */
export function deckFromSamples(
  cum: readonly number[],
  samples: readonly (number | undefined)[],
  profile: readonly number[],
  ranges: readonly TunnelRange[],
  gradient: number,
): (number | undefined)[] {
  const deck: (number | undefined)[] = new Array(cum.length).fill(undefined)
  for (const [start, end] of ranges) {
    const indexes: number[] = []
    for (let i = 0; i < cum.length; i++) {
      if (cum[i] > start && cum[i] < end && samples[i] !== undefined) indexes.push(i)
    }
    if (indexes.length === 0) continue
    const verdicts: Verdict[] = indexes.map((i) => {
      const above = (samples[i] as number) - profile[i]
      return above >= DECK_ABOVE_PROFILE_M ? 'deck' : above >= DECK_ABOVE_PROFILE_WEAK_M ? 'weak' : 'low'
    })
    const candidates = indexes.filter((_, k) => verdicts[k] === 'deck')
    const pruned = pruneRoofs(
      candidates.map((i) => cum[i]),
      candidates.map((i) => samples[i] as number),
      gradient,
    )
    candidates.forEach((i, k) => {
      if (pruned[k]) verdicts[indexes.indexOf(i)] = 'roof'
    })
    const trusted = indexes
      .filter((_, k) => verdicts[k] === 'deck')
      .map((i) => ({ c: cum[i], h: samples[i] as number }))
    indexes.forEach((i, k) => {
      const verdict = verdicts[k]
      if (verdict === 'deck') {
        deck[i] = samples[i]
        return
      }
      let before: { c: number; h: number } | undefined
      let after: { c: number; h: number } | undefined
      for (const t of trusted) {
        if (t.c < cum[i]) before = t
        else if (after === undefined) after = t
      }
      if (before && after && (verdict === 'roof' || after.c - before.c <= HOLE_SPAN_M)) {
        deck[i] = before.h + ((after.h - before.h) * (cum[i] - before.c)) / (after.c - before.c)
      } else if (verdict === 'roof') {
        deck[i] = (before ?? after)?.h
      } else if (verdict === 'weak') {
        deck[i] = samples[i]
      }
    })
  }
  return deck
}

export class BridgeDecks {
  private directions = new Map<string, DeckDirection>()
  /** Mirrored second directions, served from the first one's deck. */
  private mirrored = new Map<string, DeckDirection>()
  /** Every measured point, by coordinate (see DeckVertex). */
  private points = new Map<string, DeckVertex>()
  private lastPassAt = 0
  /** The offset the decks were last built against (see update). */
  private builtOffset = Number.NaN

  constructor(
    private readonly viewer: Viewer,
    private readonly host: BridgeDecksHost,
  ) {}

  /**
   * Registers every direction with bridge ranges and a height profile –
   * without a profile there is nothing to blend the deck into, and the
   * vehicles sample the tiles themselves then (VehicleLayer). A mirrored
   * second direction shares the first one's vertices, measured once.
   */
  add(network: PreparedNetwork): void {
    for (const line of network.lines) {
      const [forward, reverse] = line.directions
      this.register(line.id, forward, line.mode)
      if (directionsAreMirrored(forward, reverse)) {
        const entry = this.directions.get(directionKey(line.id, 0))
        if (entry) this.mirrored.set(directionKey(line.id, 1), entry)
      } else {
        this.register(line.id, reverse, line.mode)
      }
    }
  }

  private register(lineId: string, dir: PreparedDirection, mode: TransitMode): void {
    const heights = dir.heights
    if (!heights || dir.bridges.length === 0) return
    const entry: DeckDirection = {
      lineId,
      direction: dir.direction,
      dir,
      gradient: DECK_MAX_GRADIENT[mode],
      nodes: [],
      stations: [],
      deck: [],
      dirty: false,
      publishedAt: 0,
    }
    const nodes: DeckNode[] = dir.path.map(([lon, lat], i) => ({
      cum: dir.cum[i],
      lon,
      lat,
      nhn: heights[i],
    }))
    const measured = (node: DeckNode): void => {
      const key = `${node.lon},${node.lat}`
      let vertex = this.points.get(key)
      if (!vertex) {
        vertex = {
          lon: node.lon,
          lat: node.lat,
          position: Cartesian3.fromDegrees(node.lon, node.lat, node.nhn + POSITION_OFFSET_GUESS),
          height: undefined,
          generation: -1,
          owners: [],
        }
        this.points.set(key, vertex)
      }
      vertex.owners.push(entry)
      node.vertex = vertex
    }
    for (const [start, end] of dir.bridges) {
      // The range's own vertices are measured; between any two points of
      // the range – its ends included – stations fill gaps wider than the
      // spacing, evenly.
      const anchors = [start]
      for (let i = 0; i < nodes.length; i++) {
        if (dir.cum[i] <= start || dir.cum[i] >= end) continue
        measured(nodes[i])
        anchors.push(dir.cum[i])
      }
      anchors.push(end)
      for (let a = 0; a + 1 < anchors.length; a++) {
        const from = anchors[a]
        const to = anchors[a + 1]
        const extra = Math.ceil((to - from) / DECK_STATION_SPACING_M) - 1
        for (let j = 1; j <= extra; j++) {
          const d = from + ((to - from) * j) / (extra + 1)
          const at = sampleAtDistance(dir.path, dir.cum, d)
          const station: DeckNode = {
            cum: d,
            lon: at.lon,
            lat: at.lat,
            nhn: heightAtDistance(heights, dir.cum, d),
          }
          measured(station)
          entry.stations.push(station)
          nodes.push(station)
        }
      }
    }
    if (!nodes.some((n) => n.vertex)) return
    nodes.sort((a, b) => a.cum - b.cum)
    entry.stations.sort((a, b) => a.cum - b.cum)
    entry.nodes = nodes
    entry.deck = new Array(nodes.length).fill(undefined)
    this.directions.set(directionKey(lineId, dir.direction), entry)
  }

  /** Forgets every deck – the next city's network starts afresh. */
  clear(): void {
    this.directions.clear()
    this.mirrored.clear()
    this.points.clear()
  }

  /**
   * Deck height (ellipsoidal) under a point of a direction, or undefined
   * where no measured vertex bounds it – then the caller's profile
   * applies. Between a measured vertex and an unmeasured one the profile
   * height (`nhn + offset`) of the latter is the other end of the
   * interpolation, which is what ties the deck into the portals.
   */
  heightAt(lineId: string, direction: 0 | 1, distance: number, offset: number): number | undefined {
    const resolved = this.resolve(lineId, direction, distance)
    if (!resolved) return undefined
    const { entry, d } = resolved
    const { nodes, deck } = entry
    const last = nodes.length - 1
    if (d <= nodes[0].cum) return deck[0]
    if (d >= nodes[last].cum) return deck[last]
    let lo = 0
    let hi = last
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (nodes[mid].cum <= d) lo = mid
      else hi = mid
    }
    const deckLo = deck[lo]
    const deckHi = deck[hi]
    if (deckLo === undefined && deckHi === undefined) return undefined
    const hLo = deckLo ?? nodes[lo].nhn + offset
    const hHi = deckHi ?? nodes[hi].nhn + offset
    const span = nodes[hi].cum - nodes[lo].cum
    const t = span > 0 ? (d - nodes[lo].cum) / span : 0
    return hLo + (hHi - hLo) * t
  }

  /**
   * The stations strictly between two distances of a direction, in path
   * order – the routes draw their polylines through them so a line
   * follows the measured deck between two path vertices instead of
   * cutting the hump of a bridge with a chord.
   */
  stationsBetween(
    lineId: string,
    direction: 0 | 1,
    fromDistance: number,
    toDistance: number,
  ): { lon: number; lat: number; cum: number }[] {
    const key = directionKey(lineId, direction)
    const own = this.directions.get(key)
    if (own) {
      return own.stations.filter((s) => s.cum > fromDistance && s.cum < toDistance)
    }
    const mirrored = this.mirrored.get(key)
    if (!mirrored) return []
    const total = mirrored.dir.totalLength
    return mirrored.stations
      .filter((s) => total - s.cum > fromDistance && total - s.cum < toDistance)
      .map((s) => ({ lon: s.lon, lat: s.lat, cum: total - s.cum }))
      .reverse()
  }

  /** A direction's entry and the distance along it, mirrored if need be. */
  private resolve(
    lineId: string,
    direction: 0 | 1,
    distance: number,
  ): { entry: DeckDirection; d: number } | undefined {
    const key = directionKey(lineId, direction)
    const own = this.directions.get(key)
    if (own) return { entry: own, d: distance }
    const mirrored = this.mirrored.get(key)
    if (!mirrored) return undefined
    return { entry: mirrored, d: mirrored.dir.totalLength - distance }
  }

  /**
   * One pass: the nearest on-screen vertices whose tiles have not been
   * read at the current generation get a ray each, and the directions
   * whose deck changed are rebuilt and announced. Called per tick; does
   * its work every DECK_SAMPLE_INTERVAL_MS.
   */
  update(now = performance.now()): void {
    if (this.points.size === 0) return
    if (now - this.lastPassAt < DECK_SAMPLE_INTERVAL_MS) return
    this.lastPassAt = now
    // The trust rule reads samples against the profile, so a calibrated
    // offset (a few metres from the first guess) rebuilds every deck
    const offset = this.host.routeHeightOffset()
    if (offset !== this.builtOffset) {
      this.builtOffset = offset
      for (const entry of this.directions.values()) {
        if (entry.nodes.some((n) => n.vertex?.height !== undefined)) entry.dirty = true
      }
    }
    const generation = this.host.surfaceGeneration()
    const camera = this.viewer.camera
    const cameraPosition = camera.positionWC
    const range = DECK_SAMPLE_RANGE_AT_REFERENCE * cameraFramingScale(camera)
    const cullingVolume = camera.frustum.computeCullingVolume(
      cameraPosition,
      camera.directionWC,
      camera.upWC,
    )

    // Of every vertex a ray would improve, the nearest few: what the
    // user looks at, and where the tiles are finest right now. The
    // distance test is far cheaper than the ray, so scanning all of them
    // to spend the small budget well is worth it (the stops' rule).
    let count = 0
    for (const vertex of this.points.values()) {
      if (vertex.generation === generation) continue
      const distance = Cartesian3.distance(cameraPosition, vertex.position)
      if (distance > range) continue
      if (count === DECK_SAMPLE_BUDGET && distance >= nearestDistances[count - 1]) continue
      Cartesian3.clone(vertex.position, frustumSphere.center)
      frustumSphere.radius = 60
      if (cullingVolume.computeVisibility(frustumSphere) === Intersect.OUTSIDE) continue
      let slot = Math.min(count, DECK_SAMPLE_BUDGET - 1)
      while (slot > 0 && nearestDistances[slot - 1] > distance) {
        nearestDistances[slot] = nearestDistances[slot - 1]
        nearest[slot] = nearest[slot - 1]
        slot--
      }
      nearestDistances[slot] = distance
      nearest[slot] = vertex
      if (count < DECK_SAMPLE_BUDGET) count++
    }

    for (let i = 0; i < count; i++) {
      const vertex = nearest[i] as DeckVertex
      nearest[i] = null
      const height = this.host.sampleSurfaceHeight(vertex.lon, vertex.lat)
      vertex.generation = generation
      if (height === undefined) continue
      if (vertex.height === undefined || Math.abs(height - vertex.height) > DECK_CHANGE_M) {
        vertex.height = height
        for (const owner of vertex.owners) owner.dirty = true
      }
    }

    for (const entry of this.directions.values()) {
      if (!entry.dirty || now - entry.publishedAt < DECK_PUBLISH_INTERVAL_MS) continue
      entry.deck = deckFromSamples(
        entry.nodes.map((n) => n.cum),
        entry.nodes.map((n) => n.vertex?.height),
        entry.nodes.map((n) => n.nhn + offset),
        entry.dir.bridges,
        entry.gradient,
      )
      entry.dirty = false
      entry.publishedAt = now
      this.host.deckChanged(entry.lineId, entry.direction)
      this.host.requestRender()
    }
  }

  /**
   * Debug: one line's measured points – vertices and stations – with
   * what was measured and what the deck made of it, for
   * __mg3d.bridgeDecks(lineId) when a train still stands wrong somewhere.
   */
  details(lineId: string): {
    direction: 0 | 1
    vertices: {
      cum: number
      lon: number
      lat: number
      station: boolean
      profile: number
      measured: number | undefined
      deck: number | undefined
    }[]
  }[] {
    const out: ReturnType<BridgeDecks['details']> = []
    for (const entry of this.directions.values()) {
      if (entry.lineId !== lineId) continue
      const vertices: ReturnType<BridgeDecks['details']>[number]['vertices'] = []
      entry.nodes.forEach((node, index) => {
        if (!node.vertex) return
        const deck = entry.deck[index]
        vertices.push({
          cum: Math.round(node.cum),
          lon: node.lon,
          lat: node.lat,
          station: entry.stations.includes(node),
          profile: Math.round(node.nhn * 10) / 10,
          measured:
            node.vertex.height === undefined ? undefined : Math.round(node.vertex.height * 10) / 10,
          deck: deck === undefined ? undefined : Math.round(deck * 10) / 10,
        })
      })
      out.push({ direction: entry.direction, vertices })
    }
    return out
  }

  /**
   * Debug/test: how much of the city's bridge network has been measured
   * – points, each shared by every direction with a vertex there – and
   * of the directions' vertices how many were not taken as they came:
   * roofs interpolated across, low samples left to the profile.
   */
  get info(): {
    directions: number
    vertices: number
    measured: number
    roofs: number
    low: number
  } {
    let measured = 0
    for (const vertex of this.points.values()) if (vertex.height !== undefined) measured++
    let roofs = 0
    let low = 0
    for (const entry of this.directions.values()) {
      entry.nodes.forEach((node, index) => {
        if (node.vertex?.height === undefined) return
        const deck = entry.deck[index]
        if (deck === undefined) low++
        else if (Math.abs(deck - node.vertex.height) > DECK_CHANGE_M) roofs++
      })
    }
    return { directions: this.directions.size, vertices: this.points.size, measured, roofs, low }
  }
}
