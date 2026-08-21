#!/usr/bin/env node
/**
 * Fetches the real Rostock public transport routes from OpenStreetMap
 * (Overpass API) and generates src/data/network.json with exact geometry:
 *   - all tram lines (route=tram)
 *   - all RSAG bus lines (route=bus, operator RSAG)
 *   - the S-Bahn lines S1–S3 (route=train, service=commuter, DB Regio),
 *     truncated at Rostock Hbf: S2/S3 continue to Güstrow far outside the
 *     city map, so only the shared Warnemünde–Hbf corridor is kept
 *   - the ferries Kabutzenhof–Gehlsdorf (56291) and
 *     Warnemünde–Hohe Düne (56296)
 *   - tunnel/underground sections per direction (from the member ways'
 *     tunnel/location/layer tags) as meter ranges along the path
 *   - bridge sections per direction (bridge=* tags) as meter ranges –
 *     consumed by scripts/fetch-route-heights.mjs for the height profile
 *
 *   npm run data:update
 *
 * Environment variables:
 *   OVERPASS_URL  – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE – local JSON file with a previously saved Overpass
 *                   response (no network access needed)
 *   NETWORK_OUT   – alternative output path (default: src/data/network.json)
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0 (https://osm.org/copyright)
 *
 * Note: In sandbox/CI environments without open internet access this script
 * fails – the bundled approximated dataset then stays active
 * (scripts/build-approx-network.mjs).
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compactPath } from './lib/simplify.mjs'
import { isBridgeWay, isUndergroundWay, tunnelRangesFromSegments } from './lib/tunnels.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = process.env.NETWORK_OUT
  ? resolve(process.env.NETWORK_OUT)
  : resolve(__dirname, '../src/data/network.json')

// Public Overpass instances; tried in order.
const OVERPASS_MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ]

/**
 * Terminal at which S-Bahn routes are truncated: everything beyond
 * Rostock Hbf (toward Güstrow/Laage) lies outside the city map. The stop
 * closest to this point marks the cut.
 */
const TRAIN_TERMINAL_NAME = /Rostock Hbf|Rostock Hauptbahnhof/

/**
 * S-Bahn vehicle: Bombardier Talent 2 (BR 442) three-car unit as run by
 * DB Regio on the Rostock S-Bahn (visual approximation like the ferries).
 */
const TRAIN_VEHICLE = { length: 56.8, width: 2.92, height: 4.3 }

// Overpass instances expect identifiable clients; requests without a
// User-Agent are sometimes rejected (e.g. with HTTP 403/406).
const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/json',
  'User-Agent':
    'mini-rostock-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-rostock-3d)',
}

// Bounding box for Rostock (south, west, north, east)
const BBOX = '53.95,11.95,54.22,12.35'

// Fallback colors in case OSM provides no colour tags (RSAG-like palette)
const FALLBACK_COLORS = {
  1: '#D71920',
  2: '#0072BC',
  3: '#F39200',
  4: '#8B6F47',
  5: '#009640',
  6: '#94368D',
  7: '#00A5B5',
}

// Bus lines without a colour tag get a distinguishable color in rotation.
const BUS_PALETTE = [
  '#1D4ED8', '#059669', '#B45309', '#7C3AED', '#BE185D',
  '#0E7490', '#4D7C0F', '#B91C1C', '#6D28D9', '#0F766E',
]

/**
 * The two desired ferries, addressed via their OSM relation IDs.
 * Dimensions per operator specifications; the height is a visual
 * approximation above the waterline (drives/superstructures).
 */
const FERRIES = {
  // Careful with the IDs: 'F1'–'F4' are already RSAG BUS lines!
  56291: {
    id: 'FG',
    name: 'Ferry Kabutzenhof – Gehlsdorf',
    from: 'Kabutzenhof',
    to: 'Gehlsdorf',
    color: '#0E7490',
    vehicle: { length: 19.9, width: 6.6, height: 3.5 },
  },
  56296: {
    id: 'FW',
    name: 'Ferry Warnemünde – Hohe Düne',
    from: 'Warnemünde',
    to: 'Hohe Düne',
    color: '#155E75',
    vehicle: { length: 39, width: 11, height: 6 },
  },
}

// Important: "out body qt" (not "out skel qt") so that nodes/ways keep their
// tags – otherwise the stop names are missing.
// Buses: RSAG only (regional buses of other operators such as rebus are excluded).
// Trains: only the S-Bahn (service=commuter, refs S1–S3) – regional/long-
// distance trains through the same corridor are out of scope.
const QUERY = `
[out:json][timeout:240][bbox:${BBOX}];
(
  relation["route"="tram"];
  relation["route"="bus"]["operator"~"Rostocker Straßenbahn|RSAG",i];
  relation["route"="train"]["service"="commuter"]["ref"~"^S[0-9]+$"];
  relation(id:${Object.keys(FERRIES).join(',')});
);
out body;
>;
out body qt;
// Station/halt nodes for naming the S-Bahn stops: rail stop_position
// nodes are mostly unnamed (or carry track names like "Gleis 3"), the
// real station name lives on the railway=station/halt node nearby.
node["railway"~"^(station|halt)$"]["name"](${BBOX});
out body qt;
`

function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const R = 6371008.8
  const toRad = (d) => (d * Math.PI) / 180
  const dφ = toRad(lat2 - lat1)
  const dλ = toRad(lon2 - lon1)
  const h =
    Math.sin(dφ / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dλ / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * Stitches the ways of a relation into one continuous polyline.
 * OSM PTv2 relations list their ways in order; each way's orientation is
 * determined by how it connects to the current end of the route.
 *
 * Besides the path it returns per-segment underground and bridge flags:
 * segUnderground[i] / segBridge[i] tell whether the segment between path[i]
 * and path[i + 1] comes from a tunnel/underground or bridge way
 * (length = path.length - 1).
 */
export function stitchWays(ways, wayById, nodeById, label) {
  const coords = []
  const segUnderground = []
  const segBridge = []
  let gaps = 0

  const wayCoords = (wayId) => {
    const way = wayById.get(wayId)
    if (!way?.nodes) return null
    const pts = way.nodes
      .map((id) => nodeById.get(id))
      .filter(Boolean)
      .map((n) => [n.lon, n.lat])
    return pts.length >= 2 ? pts : null
  }

  for (let memberIndex = 0; memberIndex < ways.length; memberIndex++) {
    const member = ways[memberIndex]
    const pts = wayCoords(member.ref)
    if (!pts) continue
    const underground = isUndergroundWay(wayById.get(member.ref))
    const bridge = isBridgeWay(wayById.get(member.ref))

    if (coords.length === 0) {
      // The first way's stored orientation is arbitrary (rail relations in
      // particular often list the terminal stub pointing INTO the buffer
      // stop) – orient it so its end faces the next way, otherwise every
      // following way looks like a >150 m gap and gets skipped.
      let oriented = pts
      for (let j = memberIndex + 1; j < ways.length; j++) {
        const nextPts = wayCoords(ways[j].ref)
        if (!nextPts) continue
        const gapFrom = (p) =>
          Math.min(
            haversineMeters(p, nextPts[0]),
            haversineMeters(p, nextPts[nextPts.length - 1]),
          )
        if (gapFrom(pts[0]) < gapFrom(pts[pts.length - 1])) oriented = [...pts].reverse()
        break
      }
      coords.push(...oriented)
      for (let i = 1; i < oriented.length; i++) {
        segUnderground.push(underground)
        segBridge.push(bridge)
      }
      continue
    }

    const end = coords[coords.length - 1]
    const dStart = haversineMeters(end, pts[0])
    const dEnd = haversineMeters(end, pts[pts.length - 1])
    const oriented = dStart <= dEnd ? pts : [...pts].reverse()
    const gap = Math.min(dStart, dEnd)

    if (gap > 150) {
      // Gap in the relation (e.g. depot track) – skip the way
      gaps++
      continue
    }

    // Skip the first point if it matches the current end of the route
    const startIdx = gap < 1 ? 1 : 0
    const appended = oriented.slice(startIdx)
    coords.push(...appended)
    // One new segment per appended point (with startIdx 0 the first one is
    // the short bridging segment onto this way – it inherits the way's flag).
    for (let i = 0; i < appended.length; i++) {
      segUnderground.push(underground)
      segBridge.push(bridge)
    }
  }

  if (gaps > 0) {
    console.warn(`  ⚠ ${label}: skipped ${gaps} way(s) with a gap > 150 m`)
  }
  return { path: coords, segUnderground, segBridge }
}

function cumulative(path) {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(path[i - 1], path[i]))
  }
  return cum
}

/**
 * Cuts a stitched direction at `cutDist` (meters along the path) and keeps
 * the requested side. Used for the S-Bahn: S2/S3 continue far beyond the
 * city map toward Güstrow, so everything past Rostock Hbf is dropped. The
 * cut point itself is interpolated onto the path, and the tunnel/bridge
 * meter ranges are clipped (and, for the 'after' side, shifted) so they
 * stay valid for the shortened path.
 */
export function clipPathAt(path, cum, cutDist, keep, ranges = []) {
  const total = cum[cum.length - 1]
  const clamped = Math.max(0, Math.min(total, cutDist))
  const interpolate = (dist) => {
    let i = 1
    while (i < cum.length - 1 && cum[i] < dist) i++
    const span = cum[i] - cum[i - 1]
    const t = span > 0 ? (dist - cum[i - 1]) / span : 0
    return [
      path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t,
      path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t,
    ]
  }
  let clippedPath
  let clipRange
  if (keep === 'before') {
    clippedPath = path.filter((_, i) => cum[i] < clamped)
    clippedPath.push(interpolate(clamped))
    clipRange = ([s, e]) => (s >= clamped ? null : [s, Math.min(e, clamped)])
  } else {
    clippedPath = [interpolate(clamped), ...path.filter((_, i) => cum[i] > clamped)]
    clipRange = ([s, e]) => (e <= clamped ? null : [Math.max(0, s - clamped), e - clamped])
  }
  const clippedRanges = ranges
    .map(clipRange)
    .filter((r) => r !== null && r[1] - r[0] >= 1)
    .map(([s, e]) => [Math.round(s * 10) / 10, Math.round(e * 10) / 10])
  return { path: clippedPath, ranges: clippedRanges }
}

function projectOntoPath(path, cum, p) {
  let best = Infinity
  let bestAlong = 0
  const cosLat = Math.cos((p[1] * Math.PI) / 180)
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]
    const b = path[i + 1]
    const bx = (b[0] - a[0]) * cosLat
    const by = b[1] - a[1]
    const px = (p[0] - a[0]) * cosLat
    const py = p[1] - a[1]
    const lenSq = bx * bx + by * by
    const t = lenSq > 0 ? Math.min(1, Math.max(0, (px * bx + py * by) / lenSq)) : 0
    const dx = px - t * bx
    const dy = py - t * by
    const dSq = dx * dx + dy * dy
    if (dSq < best) {
      best = dSq
      bestAlong = cum[i] + (cum[i + 1] - cum[i]) * t
    }
  }
  return bestAlong
}

async function fetchOverpassData() {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    const { readFileSync } = await import('node:fs')
    return JSON.parse(readFileSync(process.env.OVERPASS_FILE, 'utf8'))
  }

  const errors = []
  for (const url of OVERPASS_MIRRORS) {
    console.log(`Querying Overpass at ${url} …`)
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(QUERY),
        headers: REQUEST_HEADERS,
      })
      if (!response.ok) {
        const body = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        errors.push(`${url} → HTTP ${response.status}: ${body.slice(0, 200)}`)
        console.warn(`  ⚠ HTTP ${response.status} – trying next mirror`)
        continue
      }
      return await response.json()
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

async function main() {
  const data = await fetchOverpassData()

  const nodeById = new Map()
  const wayById = new Map()
  const relations = []
  for (const el of data.elements) {
    if (el.type === 'node') nodeById.set(el.id, el)
    else if (el.type === 'way') wayById.set(el.id, el)
    else if (el.type === 'relation') relations.push(el)
  }
  // Named railway station/halt nodes (fetched alongside the relations):
  // the S-Bahn stop_positions are mostly unnamed or carry track names
  // ("Gleis 3"), so train stops take the name of the nearest station.
  const stationNodes = [...nodeById.values()].filter(
    (n) => /^(station|halt)$/.test(n.tags?.railway ?? '') && n.tags?.name,
  )
  const nearestStationName = (node) => {
    let best = null
    let bestDist = 400
    for (const station of stationNodes) {
      const d = haversineMeters([node.lon, node.lat], [station.lon, station.lat])
      if (d < bestDist) {
        bestDist = d
        best = station.tags.name
      }
    }
    return best
  }
  console.log(
    `Loaded ${relations.length} route relations, ${wayById.size} ways, ` +
      `${nodeById.size} nodes (${stationNodes.length} named rail stations)`,
  )

  // Group relations by line: trams/buses via their ref tag, the ferries via
  // their fixed relation ID (some of them carry no ref).
  const byLine = new Map() // key → { mode, ref, fixed?, rels }
  for (const rel of relations) {
    const ferry = FERRIES[rel.id]
    if (ferry) {
      const key = `ferry:${ferry.id}`
      if (!byLine.has(key)) byLine.set(key, { mode: 'ferry', ref: ferry.id, fixed: ferry, rels: [] })
      byLine.get(key).rels.push(rel)
      continue
    }
    const mode =
      rel.tags?.route === 'bus'
        ? 'bus'
        : rel.tags?.route === 'tram'
          ? 'tram'
          : rel.tags?.route === 'train'
            ? 'train'
            : null
    const ref = rel.tags?.ref
    if (!mode || !ref) continue
    const key = `${mode}:${ref}`
    if (!byLine.has(key)) byLine.set(key, { mode, ref, rels: [] })
    byLine.get(key).rels.push(rel)
  }

  const stops = {}
  const lines = []
  const MODE_ORDER = { tram: 0, train: 1, bus: 2, ferry: 3 }
  let busColorIndex = 0

  const groups = [...byLine.values()].sort(
    (a, b) =>
      MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
      a.ref.localeCompare(b.ref, 'de', { numeric: true }),
  )
  for (const { mode, ref, fixed, rels } of groups) {
    // Determine the name of a relation member (node or way)
    const memberName = (m) => {
      if (!m) return undefined
      const el =
        m.type === 'node' ? nodeById.get(m.ref) : m.type === 'way' ? wayById.get(m.ref) : null
      return el?.tags?.name
    }

    // Per line, take the (up to) two longest direction variants
    const candidates = rels
      .map((rel) => {
        const wayMembers = rel.members.filter((m) => m.type === 'way' && !/platform/.test(m.role || ''))
        const { path, segUnderground, segBridge } = stitchWays(
          wayMembers,
          wayById,
          nodeById,
          `Line ${ref} (${rel.id})`,
        )
        const stopNodes = []
        rel.members.forEach((m, i) => {
          if (m.type !== 'node' || !/stop/.test(m.role || '')) return
          const node = nodeById.get(m.ref)
          if (!node) return
          // Unnamed stop_positions inherit the name of the adjacent
          // platform (PTv2 relations list stop + platform in pairs).
          let name = node.tags?.name
          if (!name && /platform/.test(rel.members[i + 1]?.role || '')) {
            name = memberName(rel.members[i + 1])
          }
          if (!name && /platform/.test(rel.members[i - 1]?.role || '')) {
            name = memberName(rel.members[i - 1])
          }
          // Rail: node/platform names are track labels ("Gleis 3") or
          // missing entirely – the nearest station/halt node is the truth.
          if (mode === 'train') {
            name = nearestStationName(node) ?? name
          }
          stopNodes.push({ node, name })
        })
        return { rel, path, segUnderground, segBridge, stopNodes }
      })
      // Ferry relations often do not list their piers with stop roles –
      // there is a fallback below using the path endpoints.
      .filter((c) => c.path.length >= 2 && (c.stopNodes.length >= 2 || mode === 'ferry'))
      .sort((a, b) => b.path.length - a.path.length)

    if (candidates.length === 0) {
      console.warn(`⚠ ${mode === 'bus' ? 'Bus' : mode === 'ferry' ? 'Ferry' : 'Line'} ${ref}: no usable relation – skipped`)
      continue
    }

    // Pick two directions with different endpoints
    const chosen = [candidates[0]]
    const firstTo = candidates[0].rel.tags?.to
    const opposite = candidates.find((c) => c !== candidates[0] && c.rel.tags?.to !== firstTo)
    if (opposite) chosen.push(opposite)

    const directions = []
    for (const { rel, path: rawPath, segUnderground, segBridge, stopNodes: rawStopNodes } of chosen) {
      let path = rawPath
      let stopNodes = rawStopNodes
      let cum = cumulative(path)
      let tunnels = tunnelRangesFromSegments(segUnderground, cum)
      // Bridges use smaller merge/min thresholds than tunnels: they only
      // steer the terrain-height interpolation (data:heights), where even a
      // short deck over a stream matters, and no visibility state flickers.
      let bridges = tunnelRangesFromSegments(segBridge, cum, {
        mergeGapMeters: 10,
        minLengthMeters: 10,
      })

      // S-Bahn: cut the route at Rostock Hbf and keep the Warnemünde side.
      // S2/S3 continue to Güstrow – far outside the city map, and their
      // in-box remainder would end mid-track in open country.
      if (mode === 'train') {
        const stopDist = (predicate) => {
          const hit = stopNodes.find(({ node, name }) =>
            predicate(name || node.tags?.name || ''),
          )
          return hit
            ? projectOntoPath(path, cum, [hit.node.lon, hit.node.lat])
            : null
        }
        const hbfDist = stopDist((n) => TRAIN_TERMINAL_NAME.test(n))
        const seasideDist = stopDist((n) => /Warnemünde/.test(n))
        if (hbfDist === null || seasideDist === null) {
          console.warn(
            `  ⚠ Line ${ref} (${rel.id}): Rostock Hbf or Warnemünde stop not found – relation skipped`,
          )
          continue
        }
        const keep = seasideDist < hbfDist ? 'before' : 'after'
        const clipped = clipPathAt(path, cum, hbfDist, keep, tunnels)
        tunnels = clipped.ranges
        bridges = clipPathAt(path, cum, hbfDist, keep, bridges).ranges
        path = clipped.path
        cum = cumulative(path)
        // Keep only stops on the surviving corridor (50 m tolerance keeps
        // the Hbf platform node right at the cut).
        const rawCum = cumulative(rawPath)
        stopNodes = stopNodes.filter(({ node }) => {
          const d = projectOntoPath(rawPath, rawCum, [node.lon, node.lat])
          return keep === 'before' ? d <= hbfDist + 50 : d >= hbfDist - 50
        })
      }

      const dirStops = []
      let lastDist = -1
      let dropped = 0
      for (const { node, name } of stopNodes) {
        const id = `osm-${node.id}`
        const coord = [Number(node.lon.toFixed(6)), Number(node.lat.toFixed(6))]
        const dist = projectOntoPath(path, cum, coord)
        if (dist <= lastDist) {
          dropped++
          continue // stop is not monotonic along the route (e.g. a loop)
        }
        lastDist = dist
        // Do not overwrite already known names (e.g. from the
        // opposite-direction relation) with the placeholder
        const resolvedName =
          name || node.tags?.name || (stops[id]?.name !== 'Stop' && stops[id]?.name) || 'Stop'
        stops[id] = { name: resolvedName, coord }
        dirStops.push(id)
      }
      if (dropped > 0) {
        console.warn(`  ⚠ Line ${ref}: removed ${dropped} non-monotonic stops`)
      }
      if (mode === 'ferry' && dirStops.length < 2) {
        // Derive the piers from the path endpoints; names from the relation's
        // from/to or – if the relation carries none (e.g. 56291) – from FERRIES.
        const mkStop = (suffix, coord, name) => {
          const id = `ferry-${rel.id}-${suffix}`
          stops[id] = {
            name,
            coord: [Number(coord[0].toFixed(6)), Number(coord[1].toFixed(6))],
          }
          return id
        }
        dirStops.length = 0
        dirStops.push(
          mkStop('a', path[0], rel.tags?.from || fixed?.from || 'Pier'),
          mkStop('b', path[path.length - 1], rel.tags?.to || fixed?.to || 'Pier'),
        )
      }
      if (dirStops.length < 2) continue

      directions.push({
        // Trains: relation from/to name the full run (…→ Güstrow), but the
        // route is truncated – the surviving terminal stops are the truth.
        from:
          mode === 'train'
            ? stops[dirStops[0]].name
            : rel.tags?.from || stops[dirStops[0]].name,
        to:
          mode === 'train'
            ? stops[dirStops[dirStops.length - 1]].name
            : rel.tags?.to || stops[dirStops[dirStops.length - 1]].name,
        // Simplify (0.3 m tolerance) AFTER projecting the stops: visually
        // lossless, but noticeably fewer points in the bundle. The tunnel
        // meter ranges stay valid – simplification changes the path length
        // by far less than a portal is long.
        path: compactPath(path),
        stops: dirStops,
        ...(tunnels.length > 0 ? { tunnels } : {}),
        ...(bridges.length > 0 ? { bridges } : {}),
      })
    }

    if (directions.length === 0) {
      console.warn(`⚠ Line ${ref}: no valid direction – skipped`)
      continue
    }

    // Line IDs must be unique across the network (e.g. the RSAG assigns bus
    // numbers F1–F4, which would collide with naive ferry IDs).
    let lineId =
      fixed?.id ?? (mode === 'bus' && byLine.has(`tram:${ref}`) ? `B${ref}` : ref)
    if (lines.some((l) => l.id === lineId)) {
      const prefixed = `${mode === 'bus' ? 'B' : mode === 'ferry' ? 'FÄ' : 'T'}${lineId}`
      console.warn(`  ⚠ Line ID "${lineId}" assigned twice – using "${prefixed}"`)
      lineId = prefixed
    }
    const name =
      fixed?.name ??
      (mode === 'bus' ? `Bus ${ref}` : mode === 'train' ? `S-Bahn ${ref}` : `Line ${ref}`)
    const colour = chosen[0].rel.tags?.colour
    const fallbackColor =
      fixed?.color ??
      (mode === 'bus'
        ? BUS_PALETTE[busColorIndex++ % BUS_PALETTE.length]
        : mode === 'train'
          ? '#008D4F' // S-Bahn green, if OSM ever drops the colour tags
          : FALLBACK_COLORS[ref] || '#64748b')
    const vehicle = fixed?.vehicle ?? (mode === 'train' ? TRAIN_VEHICLE : undefined)
    lines.push({
      id: lineId,
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(colour || '') ? colour : fallbackColor,
      mode,
      ...(vehicle ? { vehicle } : {}),
      directions,
    })
    const dirSummary = (d) => {
      const km = (cumulative(d.path).at(-1) / 1000).toFixed(1)
      const rangeMeters = (ranges) => (ranges ?? []).reduce((sum, [s, e]) => sum + (e - s), 0)
      const tunnelMeters = rangeMeters(d.tunnels)
      const bridgeMeters = rangeMeters(d.bridges)
      const extras = [
        tunnelMeters > 0 ? `${(tunnelMeters / 1000).toFixed(1)} km tunnel` : '',
        bridgeMeters > 0 ? `${(bridgeMeters / 1000).toFixed(1)} km bridge` : '',
      ].filter(Boolean)
      return `${d.stops.length} stops/${km} km${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`
    }
    console.log(
      `✓ ${name}: ${directions.length} direction(s), ` +
        `${directions.map(dirSummary).join(' + ')}`,
    )
  }

  if (lines.length === 0) {
    throw new Error('No lines extracted – network.json left unchanged')
  }

  const network = {
    meta: {
      source: 'osm',
      generated: new Date().toISOString().slice(0, 10),
      attribution:
        'Route and stop data © OpenStreetMap contributors (ODbL 1.0), via Overpass API.',
    },
    stops,
    lines,
  }

  writeFileSync(OUT, JSON.stringify(network, null, 2) + '\n', 'utf8')
  console.log(`\n✅ Wrote ${OUT} (${lines.length} lines, ${Object.keys(stops).length} stops)`)
  console.log('Tip: npm test validates the new dataset.')
}

// Only run as a CLI – tests import stitchWays without triggering a fetch.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
