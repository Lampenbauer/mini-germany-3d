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

  const stops = dir.stops.map((stopId) => {
    const stop = json.stops[stopId]
    if (!stop) throw new Error(`Linie ${lineId}: unbekannte Haltestelle "${stopId}"`)
    return {
      id: stopId,
      name: stop.name,
      coord: stop.coord as LonLat,
      dist: projectOntoPath(path, cum, stop.coord as LonLat),
    }
  })

  // Haltestellen müssen in Fahrtreihenfolge auf der Strecke liegen.
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].dist <= stops[i - 1].dist) {
      throw new Error(
        `Linie ${lineId} Richtung ${direction}: Haltestellen nicht monoton entlang der Strecke ` +
          `("${stops[i - 1].id}" bei ${stops[i - 1].dist.toFixed(0)} m, ` +
          `"${stops[i].id}" bei ${stops[i].dist.toFixed(0)} m)`,
      )
    }
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
