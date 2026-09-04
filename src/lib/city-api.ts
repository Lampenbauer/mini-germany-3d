/**
 * The per-city endpoints: /api/realtime and /api/ais answer for the city
 * named in `?city=<slug>` (the Vite middleware in dev, the PHP twins in
 * production). A configured base URL may already carry a query string
 * (VITE_GTFS_RT_URL overrides), so the parameter is appended rather than
 * assumed to be the first.
 */
export function cityApiUrl(baseUrl: string, citySlug: string): string {
  if (baseUrl === '') return ''
  const separator = baseUrl.includes('?') ? '&' : '?'
  return `${baseUrl}${separator}city=${encodeURIComponent(citySlug)}`
}
