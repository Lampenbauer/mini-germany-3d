/**
 * Shared Overpass access for the data pipeline: the public mirror list and
 * a POST helper that walks it until one instance answers. The bounding
 * box a query is limited to comes from the city (src/lib/city.ts,
 * overpassBbox) – this module knows no city.
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0 (https://osm.org/copyright)
 */

export { overpassBbox } from '../../src/lib/city.ts'

/** Public Overpass instances; tried in order. */
export const OVERPASS_MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ]

// Overpass instances expect identifiable clients; requests without a
// User-Agent are sometimes rejected (e.g. with HTTP 403/406).
export const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/json',
  'User-Agent':
    'mini-germany-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-germany-3d)',
}

/** Pause before the second walk of the mirror list, in milliseconds. */
export const RETRY_DELAY_MS = Number(process.env.OVERPASS_RETRY_MS ?? 60_000)
/** How many times the mirror list is walked before a query is given up. */
export const ROUNDS = 2

/**
 * Whether a failed attempt is worth repeating after a pause. Load shows
 * as 429 (too many requests), 504 (the query timed out at the gateway)
 * or a 5xx of the instance, and as a network error or an empty answer –
 * all of them pass a minute later. A 400 is the query itself, and no
 * waiting fixes a query.
 */
export function isTransientOverpassFailure(status) {
  return status === undefined || status === 429 || status >= 500
}

/**
 * The oldest data a mirror may answer with. Every Overpass answer says
 * how far its database has caught up with OSM (`osm3s.timestamp_osm_base`),
 * and a healthy instance is minutes behind. On 11 October 2026
 * overpass.kumi.systems answered with data from before 28 September:
 * the night's network refresh took Cologne's 192 and Hanover's retagged
 * Stadtbahn from overpass-api.de on one run and the old state from kumi
 * on the next, and a green night would have committed the old one. Two
 * days lets a mirror lag a little; a fortnight undoes edits.
 */
export const MAX_DATA_AGE_MS = 2 * 24 * 3600 * 1000

/**
 * How old an answer's data is, in milliseconds, or null where the answer
 * does not say (a saved response, a test's) – which is let through, as
 * nothing can be judged.
 */
export function overpassDataAgeMs(data, nowMs = Date.now()) {
  const stamp = Date.parse(data?.osm3s?.timestamp_osm_base ?? '')
  return Number.isFinite(stamp) ? nowMs - stamp : null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Runs a query against the mirrors in order and returns the first usable
 * answer. When every mirror failed, waits RETRY_DELAY_MS and walks the
 * list once more (ROUNDS in all): the public instances answer 429 and 504
 * under load, and a city skipped for that keeps last week's data for
 * another week – a minute's patience is cheaper than that.
 *
 * `validate` decides what "usable" means. A mirror can answer HTTP 200
 * with an empty result set – overloaded, half-synced, or the query timed
 * out server-side – and for a query whose answer is known to be non-empty
 * that is a failure, not data. Without the check the caller silently
 * treats the outage as "the city has no street lamps".
 *
 * An answer whose data is older than MAX_DATA_AGE_MS is refused the same
 * way: a stale mirror is an outage too, not the state of the map.
 *
 * `fetchImpl`, `sleepImpl` and `nowImpl` are for the tests.
 */
export async function postOverpass(
  query,
  { validate, fetchImpl = fetch, sleepImpl = sleep, nowImpl = Date.now } = {},
) {
  const errors = []
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1) {
      console.log(`  ⏳ every mirror failed – waiting ${Math.round(RETRY_DELAY_MS / 1000)} s before trying them again`)
      await sleepImpl(RETRY_DELAY_MS)
    }
    let retryable = false
    for (const url of OVERPASS_MIRRORS) {
      console.log(`Querying Overpass at ${url} …`)
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: REQUEST_HEADERS,
        })
        if (!response.ok) {
          const body = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
          errors.push(`${url} → HTTP ${response.status}: ${body.slice(0, 200)}`)
          console.warn(`  ⚠ HTTP ${response.status} – trying next mirror`)
          if (isTransientOverpassFailure(response.status)) retryable = true
          continue
        }
        const data = await response.json()
        const ageMs = overpassDataAgeMs(data, nowImpl())
        if (ageMs !== null && ageMs > MAX_DATA_AGE_MS) {
          const stamp = data.osm3s.timestamp_osm_base
          const days = (ageMs / 86_400_000).toFixed(1)
          errors.push(`${url} → stale data (${stamp}, ${days} days old)`)
          console.warn(`  ⚠ stale data (${stamp}, ${days} days old) – trying next mirror`)
          retryable = true
          continue
        }
        if (validate && !validate(data)) {
          const count = data?.elements?.length ?? 0
          errors.push(`${url} → answered with an implausible result (${count} elements)`)
          console.warn(`  ⚠ implausible result (${count} elements) – trying next mirror`)
          retryable = true
          continue
        }
        return data
      } catch (err) {
        errors.push(`${url} → ${err.message}`)
        console.warn(`  ⚠ ${err.message} – trying next mirror`)
        retryable = true
      }
    }
    // Every mirror rejected the query itself (4xx other than 429): a
    // second round would only repeat the answer.
    if (!retryable) break
  }
  throw new Error(
    'All Overpass endpoints failed:\n  ' +
      errors.join('\n  ') +
      '\nTip: set a custom endpoint via OVERPASS_URL or use a saved ' +
      'response via OVERPASS_FILE.',
  )
}
