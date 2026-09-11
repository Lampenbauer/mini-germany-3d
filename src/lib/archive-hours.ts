/**
 * What every recording shares – the harbour's (ais-archive.ts) today:
 * the hour files and their names, the rule that sends the clock to the
 * recording, the store the writers put their lines in, the chunk
 * reader, and the client that keeps the hours around the simulated
 * moment loaded from the endpoint. A recording brings its own line
 * shapes, its own writer and its own replay; the client takes them as
 * options and knows nothing of ships.
 */

/**
 * How long a recording is kept: three days, the two the calendar offers
 * behind today plus today itself. Mirror of MG3D_AIS_ARCHIVE_KEEP_HOURS.
 */
export const ARCHIVE_KEEP_HOURS = 72
export const ARCHIVE_HOUR_MS = 3_600_000
/**
 * A simulated moment this far behind the real clock is replayed from the
 * recording; anything nearer, and the future, is live. Every recording
 * switches at the same edge, so two of them never come from different
 * days. The margin covers the tail poll below: the last minute may not
 * be on disk yet.
 */
export const REPLAY_EDGE_MS = 60_000
/** How often the hour still being written is asked for its new lines. */
export const ARCHIVE_TAIL_POLL_MS = 20_000
/**
 * A writer stamps a fix as it hears it, so a window that runs across the
 * hour boundary still adds seconds to the hour just closed. An hour
 * counts as closed – complete, cacheable – this long after its end.
 * Mirror of MG3D_AIS_ARCHIVE_SETTLE_SECONDS.
 */
export const ARCHIVE_SETTLE_MS = 60_000
/** A failed fetch is tried again after this long. */
const ARCHIVE_RETRY_MS = 30_000
/**
 * How far ahead of the simulated moment the hours are fetched, at
 * least – ten simulated minutes, or ten real seconds of the clock's own
 * pace when the time-lapse runs faster than that (×120 covers two hours
 * in a minute; a file fetched a second before it is needed is late). The
 * pace is read off consecutive calls and capped at the fastest time-lapse
 * the app offers (?speed=600), so a clock scrubbed hours ahead in one
 * move reads as a fast clock, not as an absurd one.
 */
const ARCHIVE_PREFETCH_MS = 10 * 60_000
const ARCHIVE_PREFETCH_LEAD_MS = 10_000
const ARCHIVE_MAX_PACE = 600

const HOUR_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}$/

/** The hour file a moment belongs to, as its name: UTC "YYYY-MM-DDTHH". */
export function archiveHourKey(ms: number): string {
  return new Date(Math.floor(ms / ARCHIVE_HOUR_MS) * ARCHIVE_HOUR_MS).toISOString().slice(0, 13)
}

/** The start of a named hour in unix ms, null for anything that is not an hour name. */
export function archiveHourStart(key: string): number | null {
  if (!HOUR_KEY_PATTERN.test(key)) return null
  const ms = Date.parse(`${key}:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

export function isArchiveHourKey(key: string): boolean {
  return archiveHourStart(key) !== null
}

/** The name of a city's hour file under an archive directory. */
export function archiveFileName(slug: string, hourKey: string): string {
  return `${slug}/${hourKey}.ndjson`
}

/**
 * Whether a named hour may still be written to – the file is refetched
 * for its tail while it is, and cached once it is not.
 */
export function archiveHourIsOpen(key: string, nowMs: number): boolean {
  const start = archiveHourStart(key)
  return start !== null && start + ARCHIVE_HOUR_MS + ARCHIVE_SETTLE_MS > nowMs
}

/**
 * Whether the simulated moment is replayed from a recording rather than
 * shown live – see REPLAY_EDGE_MS.
 */
export function replayWanted(simMs: number, nowMs: number): boolean {
  return simMs < nowMs - REPLAY_EDGE_MS
}

/** The oldest hour a writer keeps when it opens a new one at `nowMs`. */
export function archiveOldestKept(nowMs: number): string {
  return archiveHourKey(nowMs - ARCHIVE_KEEP_HOURS * ARCHIVE_HOUR_MS)
}

/** Where a writer keeps its files; the file system in dev, a stub in the tests. */
export interface ArchiveStore {
  /** Whether the hour file exists – a missing one gets the snapshot first. */
  has(slug: string, hourKey: string): boolean
  append(slug: string, hourKey: string, text: string): void
  /** Deletes the city's hour files named before `oldestKept`. */
  prune(slug: string, oldestKept: string): void
}

/**
 * The whole lines in a chunk of an hour file, and how many of its bytes
 * they took: a chunk fetched from a file still being written can end
 * mid-line, and that tail waits for the next fetch (which starts where
 * this one stopped). A line that does not parse, or is not a line of
 * the recording (`isLine`), is skipped – one corrupt line must not cost
 * the hour.
 */
export function parseArchiveChunk<L>(
  bytes: Uint8Array,
  isLine: (line: unknown) => line is L,
): { lines: L[]; consumed: number } {
  let end = bytes.length - 1
  while (end >= 0 && bytes[end] !== 0x0a) end--
  const consumed = end + 1
  const lines: L[] = []
  if (consumed === 0) return { lines, consumed }
  for (const text of new TextDecoder().decode(bytes.subarray(0, consumed)).split('\n')) {
    if (text === '') continue
    try {
      const line = JSON.parse(text) as unknown
      if (isLine(line)) lines.push(line)
    } catch {
      // skipped, see above
    }
  }
  return { lines, consumed }
}

/**
 * The index of the last fix at or before `atMs` in a list sorted by
 * time, −1 when there is none. A fix keeps its time stamp at index 1.
 */
export function lastFixAtOrBefore(fixes: readonly (readonly [unknown, number, ...unknown[]])[], atMs: number): number {
  let low = 0
  let high = fixes.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (fixes[mid][1] <= atMs) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

// ---------------------------------------------------------------------------
// The client – keeps the hours around the simulated moment loaded
// ---------------------------------------------------------------------------

type HourStatus = 'loading' | 'loaded' | 'absent' | 'failed'

interface HourEntry<L> {
  key: string
  status: HourStatus
  /** Whether any answer has come for this hour – a tail refresh is
   *  'loading' again, but the hour is still there to replay. */
  answered: boolean
  lines: L[]
  /** Bytes of the file read so far – where the next tail fetch starts. */
  consumed: number
  /** When the last fetch started, for the tail poll and the retry. */
  fetchedAt: number
  /** Bumped when the entry is dropped, so a late answer finds nobody. */
  generation: number
}

export interface ArchiveHourStatus {
  key: string
  status: HourStatus
  lines: number
}

/** The recording in memory, as the client feeds it: cleared and rebuilt hour by hour, or appended to. */
export interface ArchiveReplay<L> {
  clear(): void
  add(lines: readonly L[]): void
}

export interface HourArchiveClientOptions<L> {
  /** Which parsed JSON values are lines of this recording. */
  isLine: (line: unknown) => line is L
  /** Where the lines go – the recording's own replay. */
  replay: ArchiveReplay<L>
  /**
   * How far behind the simulated moment the layer samples the recording
   * – the hour that far back is wanted along with the moment's own.
   */
  playbackDelayMs: number
  fetch?: typeof fetch
}

/**
 * Fetches the hour files around the simulated moment from an archive
 * endpoint (`<url>&hour=…`, `&from=<byte>` for a tail) and keeps a
 * replay fed with them. Pull-driven: `follow` is called every simulation
 * tick with the moment, and does nothing until an hour boundary is
 * crossed or the hour still being written is due for its tail. Hours out
 * of reach are dropped; closed hours come back from the browser cache,
 * the endpoint marks them so.
 */
export class HourArchiveClient<L> {
  private readonly url: string
  private readonly hours = new Map<string, HourEntry<L>>()
  private readonly replay: ArchiveReplay<L>
  private readonly isLine: (line: unknown) => line is L
  private readonly playbackDelayMs: number
  private readonly fetchImpl: typeof fetch
  private lastFollow: { simMs: number; nowMs: number } | null = null
  private stopped = false

  // No parameter properties here: the parity script runs the recording's
  // modules through Node's type stripping, which erases types only.
  constructor(url: string, options: HourArchiveClientOptions<L>) {
    this.url = url
    this.replay = options.replay
    this.isLine = options.isLine
    this.playbackDelayMs = options.playbackDelayMs
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
  }

  /** Keeps the hours the moment needs on hand – see the class comment. */
  follow(simMs: number, nowMs = Date.now()): void {
    if (this.stopped) return
    // The clock's pace, from the last two calls: what the prefetch lead
    // is measured in. A clock standing still or scrubbed back counts as
    // real pace.
    let pace = 1
    if (this.lastFollow && nowMs > this.lastFollow.nowMs) {
      pace = (simMs - this.lastFollow.simMs) / (nowMs - this.lastFollow.nowMs)
      pace = Math.min(ARCHIVE_MAX_PACE, Math.max(1, pace))
    }
    this.lastFollow = { simMs, nowMs }
    const lead = Math.max(ARCHIVE_PREFETCH_MS, pace * ARCHIVE_PREFETCH_LEAD_MS)
    // Every hour from the one the sampling reaches back into to the one
    // the lead reaches ahead – two in the usual case, three around a
    // boundary or under a fast time-lapse
    const wanted = new Set<string>()
    const firstHour = Math.floor((simMs - this.playbackDelayMs) / ARCHIVE_HOUR_MS)
    const lastHour = Math.floor((simMs + lead) / ARCHIVE_HOUR_MS)
    for (let hour = firstHour; hour <= lastHour; hour++) {
      wanted.add(archiveHourKey(hour * ARCHIVE_HOUR_MS))
    }

    let dropped = false
    for (const [key, entry] of this.hours) {
      if (wanted.has(key)) continue
      entry.generation++
      this.hours.delete(key)
      dropped = true
    }
    if (dropped) this.rebuild()

    for (const key of wanted) {
      const entry = this.hours.get(key)
      if (!entry) {
        const fresh: HourEntry<L> = {
          key,
          status: 'loading',
          answered: false,
          lines: [],
          consumed: 0,
          fetchedAt: nowMs,
          generation: 0,
        }
        this.hours.set(key, fresh)
        void this.load(fresh, nowMs)
        continue
      }
      if (entry.status === 'loading') continue
      const open = archiveHourIsOpen(key, nowMs)
      const due =
        entry.status === 'failed'
          ? nowMs - entry.fetchedAt >= ARCHIVE_RETRY_MS
          : open && nowMs - entry.fetchedAt >= ARCHIVE_TAIL_POLL_MS
      if (due) void this.load(entry, nowMs)
    }
  }

  /**
   * Whether the hour of the moment has been answered for – loaded, absent
   * or failed – so that the replay says something. Until then the caller
   * keeps whatever it was showing: a harbour blinking empty for the length
   * of a fetch would be worse than the live picture standing a moment
   * longer, at the edge the two are the same picture anyway.
   */
  ready(simMs: number): boolean {
    return this.hours.get(archiveHourKey(simMs))?.answered === true
  }

  /** Which hours are held and how – for the debug API and the tests. */
  status(): ArchiveHourStatus[] {
    return [...this.hours.values()]
      .sort((a, b) => (a.key < b.key ? -1 : 1))
      .map((entry) => ({ key: entry.key, status: entry.status, lines: entry.lines.length }))
  }

  stop(): void {
    this.stopped = true
    for (const entry of this.hours.values()) entry.generation++
    this.hours.clear()
    this.replay.clear()
  }

  private async load(entry: HourEntry<L>, nowMs: number): Promise<void> {
    const generation = entry.generation
    // From where the last fetch stopped – also after a failed tail, whose
    // lines are still held; only a fresh or an absent hour starts at 0.
    const from = entry.consumed
    entry.status = 'loading'
    entry.fetchedAt = nowMs
    let status: HourStatus = 'failed'
    let bytes: Uint8Array | null = null
    try {
      // A tail is never cached; a whole hour may be, the endpoint decides.
      const response = await this.fetchImpl(
        from > 0 ? `${this.url}&hour=${entry.key}&from=${from}` : `${this.url}&hour=${entry.key}`,
        { cache: from > 0 ? 'no-store' : 'default' },
      )
      if (response.status === 404) {
        status = 'absent'
      } else if (response.status === 416) {
        // Nothing beyond what is held – the file has not grown
        status = 'loaded'
      } else if (response.ok) {
        bytes = new Uint8Array(await response.arrayBuffer())
        status = 'loaded'
      }
    } catch {
      // failed – retried after ARCHIVE_RETRY_MS
    }
    if (this.stopped || entry.generation !== generation) return
    entry.status = status
    entry.answered = true
    if (status === 'absent') {
      entry.lines = []
      entry.consumed = 0
      this.rebuild()
      return
    }
    if (bytes === null) return
    const { lines, consumed } = parseArchiveChunk(bytes, this.isLine)
    if (from === 0) {
      entry.lines = lines
      entry.consumed = consumed
      this.rebuild()
    } else {
      entry.lines.push(...lines)
      entry.consumed = from + consumed
      this.replay.add(lines)
    }
  }

  /** The replay from scratch, hours in order – after a drop or a whole hour landing. */
  private rebuild(): void {
    this.replay.clear()
    for (const entry of [...this.hours.values()].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (entry.status === 'loaded') this.replay.add(entry.lines)
    }
  }
}
