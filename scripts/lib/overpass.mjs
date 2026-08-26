/**
 * Shared Overpass access for the data pipeline: the public mirror list and
 * a POST helper that walks it until one instance answers.
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0 (https://osm.org/copyright)
 */

/** Public Overpass instances; tried in order. */
export const OVERPASS_MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ]

// Overpass instances expect identifiable clients; requests without a
// User-Agent are sometimes rejected (e.g. with HTTP 403/406).
export const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/json',
  'User-Agent':
    'mini-rostock-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-rostock-3d)',
}

/** Bounding box for Rostock (south, west, north, east). */
export const BBOX = '53.95,11.95,54.22,12.35'

/**
 * Runs a query against the mirrors in order and returns the first usable
 * answer.
 *
 * `validate` decides what "usable" means. A mirror can answer HTTP 200
 * with an empty result set – overloaded, half-synced, or the query timed
 * out server-side – and for a query whose answer is known to be non-empty
 * that is a failure, not data. Without the check the caller silently
 * treats the outage as "the city has no street lamps".
 */
export async function postOverpass(query, { validate } = {}) {
  const errors = []
  for (const url of OVERPASS_MIRRORS) {
    console.log(`Querying Overpass at ${url} …`)
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: REQUEST_HEADERS,
      })
      if (!response.ok) {
        const body = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        errors.push(`${url} → HTTP ${response.status}: ${body.slice(0, 200)}`)
        console.warn(`  ⚠ HTTP ${response.status} – trying next mirror`)
        continue
      }
      const data = await response.json()
      if (validate && !validate(data)) {
        const count = data?.elements?.length ?? 0
        errors.push(`${url} → answered with an implausible result (${count} elements)`)
        console.warn(`  ⚠ implausible result (${count} elements) – trying next mirror`)
        continue
      }
      return data
    } catch (err) {
      errors.push(`${url} → ${err.message}`)
      console.warn(`  ⚠ ${err.message} – trying next mirror`)
    }
  }
  throw new Error(
    'All Overpass endpoints failed:\n  ' +
      errors.join('\n  ') +
      '\nTip: set a custom endpoint via OVERPASS_URL or use a saved ' +
      'response via OVERPASS_FILE.',
  )
}
