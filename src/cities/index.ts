/**
 * Loading a city's data into the app. The definitions are eager (a few
 * hundred bytes each – the panel lists them before anything is loaded),
 * the generated data of a city is a lazy chunk of its own: nothing but
 * the city on the map is ever downloaded, and Vite hashes each chunk so
 * a nightly data refresh only invalidates that one city.
 */

import { prepareNetwork } from '@/data/network'
import type { NetworkJson, PreparedNetwork } from '@/data/network-types'
import type { AirfieldLightData } from '@/data/airfield-lights'
import type { BuoyData } from '@/data/buoys'
import type { StreetLampData } from '@/data/street-lamps'
import type { City } from '@/lib/city'
import type { ScheduleJson } from '@/lib/timetable'
import { CITIES, DEFAULT_CITY_SLUG, cityBySlug, isCitySlug } from './definitions'

export { CITIES, DEFAULT_CITY_SLUG, cityBySlug, isCitySlug }

/** Everything the app needs to put a city on the map. */
export interface CityData {
  city: City
  network: PreparedNetwork
  /** Real GTFS departures; null lets the synthetic headway run instead. */
  schedule: ScheduleJson | null
  /** OSM street lamps for the night lighting; null until the pipeline has run data:lamps for the city. */
  lamps: StreetLampData | null
  /** OSM airfield lighting for the night; null until the pipeline has run data:airfield-lights for the city. */
  airfieldLights: AirfieldLightData | null
  /** OSM buoys on the water; null until the pipeline has run data:buoys for the city. */
  buoys: BuoyData | null
}

const networks = import.meta.glob<NetworkJson>('./*/network.json', { import: 'default' })
const schedules = import.meta.glob<ScheduleJson>('./*/schedule.json', { import: 'default' })
const lamps = import.meta.glob<StreetLampData>('./*/street-lamps.json', { import: 'default' })
const airfieldLights = import.meta.glob<AirfieldLightData>('./*/airfield-lights.json', { import: 'default' })
const buoys = import.meta.glob<BuoyData>('./*/buoys.json', { import: 'default' })

export async function loadCityData(slug: string): Promise<CityData> {
  const city = cityBySlug(slug)
  if (!city) throw new Error(`Unknown city "${slug}"`)
  const [networkJson, schedule, lampData, airfieldLightData, buoyData] = await Promise.all([
    networks[`./${slug}/network.json`]?.(),
    schedules[`./${slug}/schedule.json`]?.(),
    lamps[`./${slug}/street-lamps.json`]?.(),
    airfieldLights[`./${slug}/airfield-lights.json`]?.(),
    buoys[`./${slug}/buoys.json`]?.(),
  ])
  if (!networkJson) throw new Error(`City "${slug}" has no network.json – run the data pipeline`)
  return {
    city,
    network: prepareNetwork(networkJson, city),
    schedule: schedule ?? null,
    lamps: lampData ?? null,
    airfieldLights: airfieldLightData ?? null,
    buoys: buoyData ?? null,
  }
}
