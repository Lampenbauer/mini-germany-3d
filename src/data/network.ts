import { config } from '@/config'
import { cumulativeDistances, projectOntoPath } from '@/lib/geo'
import type { LonLat } from '@/lib/geo'
import { mirrorTunnelRanges, normalizeTunnelRanges } from '@/lib/tunnels'
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
    throw new Error(`Line ${lineId}: direction path needs at least 2 points`)
  }
  const cum = cumulativeDistances(path)
  const totalLength = cum[cum.length - 1]

  // Project stops SEQUENTIALLY: each one only past its predecessor.
  // For lines that travel the same stretch of road multiple times (bus
  // loops), the global projection is ambiguous and can jump backwards.
  const stops: PreparedDirection['stops'] = []
  let prevDist = 0
  for (const stopId of dir.stops) {
    const stop = json.stops[stopId]
    if (!stop) throw new Error(`Line ${lineId}: unknown stop "${stopId}"`)
    const dist = projectOntoPath(path, cum, stop.coord as LonLat, prevDist)
    // Stop makes no progress along the remaining route (data error, e.g. a
    // stop listed twice) → skip it instead of building travel times with
    // 0 m segments.
    if (stops.length > 0 && dist <= prevDist + 1) continue
    stops.push({ id: stopId, name: stop.name, coord: stop.coord as LonLat, dist })
    prevDist = dist
  }
  if (stops.length < 2) {
    throw new Error(
      `Line ${lineId} direction ${direction}: fewer than 2 projectable stops`,
    )
  }

  return {
    lineId,
    direction,
    from: dir.from,
    to: dir.to,
    path,
    cum,
    totalLength,
    stops,
    tunnels: normalizeTunnelRanges(dir.tunnels, totalLength),
  }
}

/**
 * Creates the opposite direction by mirroring a direction. `totalLength`
 * (of the already prepared forward direction – the reversed path has the
 * identical length) mirrors the tunnel ranges onto the reversed path.
 */
function mirrorDirection(dir: DirectionJson, totalLength: number): DirectionJson {
  return {
    from: dir.to,
    to: dir.from,
    path: [...dir.path].reverse() as LonLat[],
    stops: [...dir.stops].reverse(),
    tunnels: mirrorTunnelRanges(normalizeTunnelRanges(dir.tunnels, totalLength), totalLength),
  }
}

export function prepareNetwork(json: NetworkJson): PreparedNetwork {
  const lines: PreparedLine[] = json.lines.map((line) => {
    const dir0Json = line.directions[0]
    const dir0 = prepareDirection(json, line.id, 0, dir0Json)
    const dir1Json = line.directions[1] ?? mirrorDirection(dir0Json, dir0.totalLength)
    const directions: [PreparedDirection, PreparedDirection] = [
      dir0,
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

  // Duplicate line ids would silently corrupt lineById (trips of one line
  // would run on the path of another) – better to fail loudly.
  const seen = new Set<string>()
  for (const line of lines) {
    if (seen.has(line.id)) {
      throw new Error(`Duplicate line id "${line.id}" in network.json`)
    }
    seen.add(line.id)
  }

  return {
    meta: json.meta,
    lines,
    lineById: new Map(lines.map((l) => [l.id, l])),
  }
}

/** The bundled Rostock tram network. */
export function loadBundledNetwork(): PreparedNetwork {
  return prepareNetwork(rawNetwork as unknown as NetworkJson)
}
