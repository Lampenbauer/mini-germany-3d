/**
 * The surface generation: a counter every layer that reads heights off
 * the tiles keys its picks and rays to – the ships, the ferries, the
 * aircraft on the ground, the buoys, the lighthouses, the bridge decks,
 * the stops, the webcams. A record read at the current generation is
 * left alone, answered or not; a new generation says the tiles changed
 * and the answer may have too.
 *
 * It followed the tileset's allTilesLoaded event before, which
 * Cesium raises on every load-progress transition – a single request
 * that starts and ends, a cancelled one – and the layers' own offscreen
 * picks are what starts such requests: at a resting camera over Hamburg
 * the event fired six times a second, every ship, ferry, buoy and
 * lighthouse on screen was picked again each time (217 readPixels a
 * second in the home view, a full scene update per pick), and the bridge
 * decks and stops re-measured their rays with it. Now a generation needs
 * a tile that actually loaded since the last one, and MIN_INTERVAL_MS
 * between: while the camera roams and tiles stream in the layers re-read
 * the surface every two seconds, at rest they never do. Pure, so the
 * rule is tested in ms (tests/surface-generation.test.ts); CesiumMap
 * feeds it the tileset's tileLoad events and asks once per tick.
 */
export class SurfaceGeneration {
  /** Generations come at most this often (see above). */
  static readonly MIN_INTERVAL_MS = 2000

  private generation = 0
  private advancedAt = -Infinity
  private tilesLoadedSince = 0

  /** The current generation – what the layers compare their records against. */
  get current(): number {
    return this.generation
  }

  /** A tile of the shown tileset got its content. */
  noteTileLoaded(): void {
    this.tilesLoadedSince++
  }

  /**
   * Once per tick: advances when a tile has loaded since the last
   * generation and MIN_INTERVAL_MS have passed since it. Returns whether
   * it did.
   */
  advance(now: number): boolean {
    if (this.tilesLoadedSince === 0) return false
    if (now - this.advancedAt < SurfaceGeneration.MIN_INTERVAL_MS) return false
    this.bump(now)
    return true
  }

  /** The surface changed for certain (a tileset swapped in): a new generation at once. */
  bump(now: number): void {
    this.generation++
    this.advancedAt = now
    this.tilesLoadedSince = 0
  }
}
