import { config } from '@/config'
import { cumulativeDistances, projectOntoPath } from '@/lib/geo'
import type { LonLat } from '@/lib/geo'
import type {
  DirectionJson,
  NetworkJson,
  PreparedDirection,
  PreparedLine,
  PreparedNetwork,
} from './network-types'
import rawNetwork from './network.json'

function prepareDirection(
  json: NetworkJson,
  lineId: string,
  direction: 0 | 1,
  dir: DirectionJson,
): PreparedDirection {
  const path = dir.path as LonLat[]
  if (path.length < 2) {
    throw new Error(`Linie ${lineId}: Richtungs-Pfad braucht mindestens 2 Punkte`)
  }
  const cum = cumulativeDistances(path)
  const totalLength = cum[cum.length - 1]

  // Haltestellen SEQUENZIELL projizieren: Jede erst hinter ihrer Vorgängerin.
  // Bei Linien, die denselben Straßenzug mehrfach befahren (Bus-Schleifen),
  // ist die globale Projektion mehrdeutig und kann rückwärts springen.
  const stops: PreparedDirection['stops'] = []
  let prevDist = 0
  for (const stopId of dir.stops) {
    const stop = json.stops[stopId]
    if (!stop) throw new Error(`Linie ${lineId}: unbekannte Haltestelle "${stopId}"`)
    const dist = projectOntoPath(path, cum, stop.coord as LonLat, prevDist)
    // Halt kommt auf der Reststrecke nicht voran (Datenfehler, z.B. doppelt
    // gelisteter Halt) → auslassen statt Fahrzeiten mit 0-m-Segmenten zu bauen.
    if (stops.length > 0 && dist <= prevDist + 1) continue
    stops.push({ id: stopId, name: stop.name, coord: stop.coord as LonLat, dist })
    prevDist = dist
  }
  if (stops.length < 2) {
    throw new Error(
      `Linie ${lineId} Richtung ${direction}: weniger als 2 projizierbare Haltestellen`,
    )
  }

  return { lineId, direction, from: dir.from, to: dir.to, path, cum, totalLength, stops }
}

/** Erzeugt die Gegenrichtung durch Spiegelung einer Richtung. */
function mirrorDirection(dir: DirectionJson): DirectionJson {
  return {
    from: dir.to,
    to: dir.from,
    path: [...dir.path].reverse() as LonLat[],
    stops: [...dir.stops].reverse(),
  }
}

export function prepareNetwork(json: NetworkJson): PreparedNetwork {
  const lines: PreparedLine[] = json.lines.map((line) => {
    const dir0Json = line.directions[0]
    const dir1Json = line.directions[1] ?? mirrorDirection(dir0Json)
    const directions: [PreparedDirection, PreparedDirection] = [
      prepareDirection(json, line.id, 0, dir0Json),
      prepareDirection(json, line.id, 1, dir1Json),
    ]
    const mode = line.mode ?? 'tram'
    return {
      id: line.id,
      name: line.name,
      color: line.color,
      mode,
      vehicle: line.vehicle ?? config.vehicles[mode],
      directions,
    }
  })

  // Doppelte Linien-IDs würden lineById still korrumpieren (Fahrten der einen
  // Linie liefen auf dem Pfad der anderen) – lieber laut scheitern.
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.id)) {
      throw new Error(`Doppelte Linien-ID "${line.id}" in network.json`)
    }
    seen.add(line.id)
  }

  return {
    meta: json.meta,
    lines,
    lineById: new Map(lines.map((l) => [l.id, l])),
  }
}

/** Das gebündelte Rostocker Straßenbahnnetz. */
export function loadBundledNetwork(): PreparedNetwork {
  return prepareNetwork(rawNetwork as unknown as NetworkJson)
}
