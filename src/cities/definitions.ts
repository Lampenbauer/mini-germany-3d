/**
 * The cities this build knows, by hand: one city.json import per folder
 * under src/cities/. Adding a city means adding its folder, running the
 * data pipeline for it (`npm run data:update -- --city <slug>` and
 * friends) and listing it here.
 *
 * Alias-free and free of Vite-only syntax on purpose: vite.config.ts,
 * the pipeline scripts and the PHP parity tests import this file under
 * plain Node, and the JSON imports carry the `with { type: 'json' }`
 * attribute Node's ESM loader insists on. The app-side loaders that need
 * import.meta.glob live in ./index.ts.
 */

import { cityFromJson, type City } from '../lib/city.ts'
import rostock from './rostock/city.json' with { type: 'json' }
import kiel from './kiel/city.json' with { type: 'json' }
import berlin from './berlin/city.json' with { type: 'json' }

/** Every city, in the order the city picker lists them. */
export const CITIES: readonly City[] = [cityFromJson(rostock), cityFromJson(kiel), cityFromJson(berlin)]

/** The city the app opens on when neither the URL nor a saved choice says otherwise. */
export const DEFAULT_CITY_SLUG = 'rostock'

export function cityBySlug(slug: string): City | undefined {
  return CITIES.find((city) => city.slug === slug)
}

export function isCitySlug(value: unknown): value is string {
  return typeof value === 'string' && CITIES.some((city) => city.slug === value)
}
