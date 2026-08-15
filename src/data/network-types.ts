import type { LonLat } from '@/lib/geo'

/** Rohformat von src/data/network.json (wird von den Daten-Skripten erzeugt). */
export interface NetworkJson {
  meta: NetworkMeta
  stops: Record<string, StopJson>
  lines: LineJson[]
}

export interface NetworkMeta {
  /** "approximated" = mitgelieferte Demo-Geometrie, "osm" = via Overpass erzeugt. */
  source: 'approximated' | 'osm'
  generated: string
  attribution: string
}

export interface StopJson {
  name: string
  coord: LonLat
}

export interface LineJson {
  id: string
  name: string
  color: string
  /**
   * Eine oder zwei Richtungen. Bei nur einer Richtung wird die Gegenrichtung
   * automatisch durch Spiegelung des Pfads erzeugt.
   */
  directions: DirectionJson[]
}

export interface DirectionJson {
  from: string
  to: string
  path: LonLat[]
  /** Haltestellen-IDs in Fahrtreihenfolge. */
  stops: string[]
}

/** Aufbereitetes Netz mit vorberechneten Distanzen. */
export interface PreparedNetwork {
  meta: NetworkMeta
  lines: PreparedLine[]
  lineById: Map<string, PreparedLine>
}

export interface PreparedLine {
  id: string
  name: string
  color: string
  directions: [PreparedDirection, PreparedDirection]
}

export interface PreparedStop {
  id: string
  name: string
  coord: LonLat
  /** Distanz der Haltestelle entlang des Richtungs-Pfads in Metern. */
  dist: number
}

export interface PreparedDirection {
  lineId: string
  direction: 0 | 1
  from: string
  to: string
  path: LonLat[]
  cum: number[]
  totalLength: number
  stops: PreparedStop[]
}
