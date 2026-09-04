#!/usr/bin/env node
/**
 * Fetches a city's real public transport routes from OpenStreetMap
 * (Overpass API) and generates src/cities/<slug>/network.json with exact
 * geometry:
 *   - the route relations of every mode the city asks for (city.json
 *     `network.modes`), each narrowed by the `network.overpass` filters
 *     (operator, ref, service, network – case-insensitive regexes); a
 *     mode without an overpass entry is served by fixed lines alone
 *   - lines addressed by relation id (`network.fixedLines`) – ferries
 *     mostly, which OSM tags too inconsistently to query
 *   - routes that leave the city cut at their last stop inside it
 *     (`network.clip`: 'city' for the city limits, 'box' for the padded
 *     bounding box, 'none' to keep them whole) – a regional train's leg
 *     to the next town lies outside the map and would end mid-track
 *   - tunnel/underground sections per direction (from the member ways'
 *     tunnel/location/layer tags) as meter ranges along the path
 *   - bridge sections per direction (bridge=* tags) as meter ranges –
 *     consumed by scripts/fetch-route-heights.mjs for the height profile
 *
 *   npm run data:update -- --city rostock     (no --city: every city)
 *
 * Environment variables:
 *   CITY          – the city, like --city
 *   OVERPASS_URL  – alternative Overpass endpoint (skips the mirror list)
 *   OVERPASS_FILE – local JSON file with a previously saved Overpass
 *                   response (no network access needed)
 *   NETWORK_OUT   – alternative output path (one city only)
 *
 * Data license: © OpenStreetMap contributors, ODbL 1.0 (https://osm.org/copyright)
 *
 * Note: In sandbox/CI environments without open internet access this script
 * fails – the committed dataset then stays active.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { containsLonLat } from '../src/lib/city.ts'
import { TRANSIT_MODES } from '../src/lib/transit-mode.ts'
import { cityInsidePredicate, forEachRequestedCity } from './lib/city.mjs'
import { overpassBbox, postOverpass } from './lib/overpass.mjs'
import { compactPath } from './lib/simplify.mjs'
import { isBridgeWay, isUndergroundWay, tunnelRangesFromSegments } from './lib/tunnels.mjs'

/**
 * OSM route=* values per transit mode, and back. S-Bahn networks are
 * tagged either way – Rostock's as route=train, others as
 * route=light_rail – so 'train' takes both.
 */
const OSM_ROUTES_BY_MODE = {
  tram: ['tram'],
  subway: ['subway'],
  train: ['train', 'light_rail'],
  bus: ['bus'],
  ferry: ['ferry'],
}
const MODE_BY_OSM_ROUTE = Object.fromEntries(
  Object.entries(OSM_ROUTES_BY_MODE).flatMap(([mode, routes]) => routes.map((r) => [r, mode])),
)

/** Display order of the modes in network.json. */
const MODE_ORDER = Object.fromEntries(TRANSIT_MODES.map((mode, index) => [mode, index]))

/** How a line is named when the city's definition does not say. */
const LINE_NAME = {
  tram: (ref) => `Line ${ref}`,
  subway: (ref) => `Subway ${ref}`,
  train: (ref) => `S-Bahn ${ref}`,
  bus: (ref) => `Bus ${ref}`,
  ferry: (ref) => `Ferry ${ref}`,
}

/**
 * Fallback colors in case OSM provides no colour tag, rotated per mode –
 * distinguishable neighbors rather than a claim about any real livery.
 */
const PALETTE_BY_MODE = {
  tram: ['#D71920', '#0072BC', '#F39200', '#8B6F47', '#009640', '#94368D', '#00A5B5'],
  subway: ['#1D4ED8', '#DC2626', '#CA8A04', '#0891B2', '#7C3AED', '#16A34A'],
  train: ['#008D4F', '#2563EB', '#B45309', '#7C3AED', '#0E7490'],
  bus: [
    '#1D4ED8', '#059669', '#B45309', '#7C3AED', '#BE185D',
    '#0E7490', '#4D7C0F', '#B91C1C', '#6D28D9', '#0F766E',
  ],
  ferry: ['#0E7490', '#155E75', '#0369A1'],
}

/** One tag filter of an Overpass relation query, or nothing. */
function tagFilter(key, regex) {
  return regex ? `["${key}"~"${regex.replace(/"/g, '\\"')}",i]` : ''
}

/**
 * The Overpass query for a city: one relation clause per queried mode,
 * the fixed lines by id, and the named railway station/halt nodes the
 * rail stops take their names from (rail stop_position nodes are mostly
 * unnamed, or carry track names like "Gleis 3").
 *
 * Important: "out body qt" (not "out skel qt") so that nodes/ways keep
 * their tags – otherwise the stop names are missing.
 */
export function buildQuery(city) {
  const bbox = overpassBbox(city.boundingBox)
  const clauses = []
  for (const mode of city.network.modes) {
    const query = city.network.overpass[mode]
    if (!query) continue
    for (const route of OSM_ROUTES_BY_MODE[mode]) {
      clauses.push(
        `  relation["type"="route"]["route"="${route}"]` +
          tagFilter('operator', query.operator) +
          tagFilter('ref', query.ref) +
          // light_rail relations rarely carry service=*; the ref filter
          // keeps the regional trains out on that side
          (route === 'light_rail' ? '' : tagFilter('service', query.service)) +
          tagFilter('network', query.network) +
          ';',
      )
    }
  }
  const fixedIds = city.network.fixedLines.map((line) => line.osmRelation)
  if (fixedIds.length > 0) clauses.push(`  relation(id:${fixedIds.join(',')});`)
  if (clauses.length === 0) {
    throw new Error(`${city.name}: nothing to fetch – no overpass queries and no fixed lines`)
  }
  return `
[out:json][timeout:240][bbox:${bbox}];
(
${clauses.join('\n')}
);
out body;
>;
out body qt;
node["railway"~"^(station|halt)$"]["name"](${bbox});
out body qt;
`
}

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
 * the requested side. Used where a route leaves the city: everything past
 * the last stop inside is dropped (see clipToBounds). The cut point itself
 * is interpolated onto the path, and the tunnel/bridge meter ranges are
 * clipped (and, for the 'after' side, shifted) so they stay valid for the
 * shortened path.
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

/**
 * Where a route leaves the area the city keeps – the city limits or the
 * padded box – it is cut down to its longest run of consecutive stops
 * inside that area: the path ends at the last of those stops, and starts
 * at the first where the route came in from outside. Tunnel and bridge
 * ranges are clipped along. Returns null when every stop is inside
 * (nothing to do) and `{ skip: true }` when none is – a relation that
 * only crosses the corner of the box is not a line of this city.
 *
 * `isInside(lon, lat)` says what counts as inside: the city's limits
 * polygon where it has one (see cityInsidePredicate), else a rectangle.
 * The GTFS import anchors a trip's departure at its first stop inside
 * the same area, so the two stay consistent: a regional train leaves the
 * map at the time it really leaves the last station shown.
 */
export function clipToBounds(path, cum, stopNodes, isInside, tunnels, bridges) {
  const inside = stopNodes.map(({ node }) => isInside(node.lon, node.lat))
  if (inside.every(Boolean)) return null
  if (!inside.some(Boolean)) return { skip: true }
  let bestStart = -1
  let bestLength = 0
  let runStart = -1
  for (let i = 0; i <= inside.length; i++) {
    if (i < inside.length && inside[i]) {
      if (runStart < 0) runStart = i
      continue
    }
    if (runStart >= 0) {
      const length = i - runStart
      if (length > bestLength) {
        bestLength = length
        bestStart = runStart
      }
      runStart = -1
    }
  }
  const first = stopNodes[bestStart].node
  const last = stopNodes[bestStart + bestLength - 1].node
  const startDist = projectOntoPath(path, cum, [first.lon, first.lat])
  const endDist = projectOntoPath(path, cum, [last.lon, last.lat])
  const total = cum[cum.length - 1]
  let clippedPath = path
  let clippedTunnels = tunnels
  let clippedBridges = bridges
  // The tail first: distances measured on the original path stay valid
  // for its prefix, so the head can be cut at the same numbers.
  if (endDist < total - 1) {
    clippedTunnels = clipPathAt(clippedPath, cum, endDist, 'before', clippedTunnels).ranges
    const cut = clipPathAt(clippedPath, cum, endDist, 'before', clippedBridges)
    clippedBridges = cut.ranges
    clippedPath = cut.path
  }
  if (startDist > 1) {
    const cumPrefix = cumulative(clippedPath)
    clippedTunnels = clipPathAt(clippedPath, cumPrefix, startDist, 'after', clippedTunnels).ranges
    const cut = clipPathAt(clippedPath, cumPrefix, startDist, 'after', clippedBridges)
    clippedBridges = cut.ranges
    clippedPath = cut.path
  }
  return {
    path: clippedPath,
    tunnels: clippedTunnels,
    bridges: clippedBridges,
    stopNodes: stopNodes.slice(bestStart, bestStart + bestLength),
    droppedStops: stopNodes.length - bestLength,
  }
}

async function fetchOverpassData(query) {
  if (process.env.OVERPASS_FILE) {
    console.log(`Reading local Overpass response ${process.env.OVERPASS_FILE}`)
    const { readFileSync } = await import('node:fs')
    return JSON.parse(readFileSync(process.env.OVERPASS_FILE, 'utf8'))
  }
  return postOverpass(query)
}

/**
 * Names of the stop_area relations containing the given OSM nodes – the
 * authoritative source for stop_position nodes that carry no name tag
 * themselves (e.g. "Thomas-Morus-Straße", whose nearest named stop in the
 * dataset is the WRONG neighbor). Returns an empty map in OVERPASS_FILE
 * replays (no network) and on lookup failure – the proximity fallback in
 * inheritUnnamedStopNames still runs afterwards.
 */
export async function fetchStopAreaNames(osmNodeIds) {
  const names = new Map()
  if (process.env.OVERPASS_FILE || osmNodeIds.length === 0) return names
  const query =
    '[out:json];node(id:' +
    osmNodeIds.join(',') +
    ');rel(bn)["public_transport"="stop_area"];out body;'
  let data
  try {
    data = await postOverpass(query)
  } catch (err) {
    console.warn(`  ⚠ stop_area lookup failed: ${err.message}`)
    return names
  }
  const wanted = new Set(osmNodeIds)
  for (const el of data.elements ?? []) {
    if (el.type !== 'relation' || !el.tags?.name) continue
    for (const member of el.members ?? []) {
      if (member.type === 'node' && wanted.has(member.ref)) {
        names.set(member.ref, el.tags.name)
      }
    }
  }
  return names
}

/** Builds and writes a city's network.json. */
export async function buildNetwork(city, outPath) {
  const data = await fetchOverpassData(buildQuery(city))
  const isInside =
    city.network.clip === 'city'
      ? cityInsidePredicate(city)
      : city.network.clip === 'box'
        ? (lon, lat) => containsLonLat(city.boundingBox, lon, lat)
        : null
  const fixedByRelation = new Map(city.network.fixedLines.map((line) => [line.osmRelation, line]))
  const wantedModes = new Set(city.network.modes)

  const nodeById = new Map()
  const wayById = new Map()
  const relations = []
  for (const el of data.elements) {
    if (el.type === 'node') nodeById.set(el.id, el)
    else if (el.type === 'way') wayById.set(el.id, el)
    else if (el.type === 'relation') relations.push(el)
  }
  // Named railway station/halt nodes (fetched alongside the relations):
  // rail stop_positions are mostly unnamed or carry track names
  // ("Gleis 3"), so train and subway stops take the name of the nearest
  // station.
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

  // Group relations by line: queried modes via their ref tag, the fixed
  // lines via their relation id (some of them carry no ref).
  const byLine = new Map() // key → { mode, ref, fixed?, rels }
  for (const rel of relations) {
    const fixed = fixedByRelation.get(rel.id)
    if (fixed) {
      const key = `${fixed.mode}:${fixed.id}`
      if (!byLine.has(key)) byLine.set(key, { mode: fixed.mode, ref: fixed.id, fixed, rels: [] })
      byLine.get(key).rels.push(rel)
      continue
    }
    const mode = MODE_BY_OSM_ROUTE[rel.tags?.route]
    const ref = rel.tags?.ref
    if (!mode || !wantedModes.has(mode) || !ref) continue
    const key = `${mode}:${ref}`
    if (!byLine.has(key)) byLine.set(key, { mode, ref, rels: [] })
    byLine.get(key).rels.push(rel)
  }

  const stops = {}
  const lines = []
  const colorIndex = {}

  const groups = [...byLine.values()].sort(
    (a, b) =>
      MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
      a.ref.localeCompare(b.ref, 'de', { numeric: true }),
  )
  for (const { mode, ref, fixed, rels } of groups) {
    const railNamed = mode === 'train' || mode === 'subway'
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
          if (railNamed) {
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
      console.warn(`⚠ ${LINE_NAME[mode](ref)}: no usable relation – skipped`)
      continue
    }

    // Pick two directions: the longest relation, and the one that runs
    // back – its from/to are the first one's swapped. A line with two
    // branches (Hamburg's S1 forks at Ohlsdorf) has several relations
    // leaving the same terminus; "a different destination" alone would
    // pair the trunk with its own other branch instead of with the way
    // back, and the return direction would then run the wrong way.
    const chosen = [candidates[0]]
    const firstFrom = candidates[0].rel.tags?.from
    const firstTo = candidates[0].rel.tags?.to
    const opposite =
      candidates.find(
        (c) =>
          c !== candidates[0] &&
          ((firstFrom && c.rel.tags?.to === firstFrom) || (firstTo && c.rel.tags?.from === firstTo)),
      ) ??
      candidates.find(
        (c) => c !== candidates[0] && c.rel.tags?.to !== firstTo && c.rel.tags?.from !== firstFrom,
      ) ??
      candidates.find((c) => c !== candidates[0] && c.rel.tags?.to !== firstTo)
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

      // Routes leaving the city are cut at their last stop inside it (see
      // clipToBounds) – ferries are exempt, their piers may lie on the
      // far bank just outside the limits.
      let clipped = false
      if (isInside && mode !== 'ferry' && stopNodes.length >= 2) {
        const cut = clipToBounds(path, cum, stopNodes, isInside, tunnels, bridges)
        if (cut?.skip) {
          console.warn(`  ⚠ Line ${ref} (${rel.id}): no stop inside the city – relation skipped`)
          continue
        }
        if (cut) {
          path = cut.path
          tunnels = cut.tunnels
          bridges = cut.bridges
          stopNodes = cut.stopNodes
          cum = cumulative(path)
          clipped = true
          console.log(
            `  ℹ Line ${ref} (${rel.id}): cut at the city limits, ${cut.droppedStops} stop(s) outside dropped`,
          )
        }
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
        // from/to or – if the relation carries none – from the fixed line.
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
        // A cut route no longer runs where the relation's from/to say –
        // the surviving terminal stops are the truth.
        from:
          clipped || railNamed
            ? stops[dirStops[0]].name
            : rel.tags?.from || stops[dirStops[0]].name,
        to:
          clipped || railNamed
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

    // Line IDs must be unique across the network (e.g. a bus numbered like
    // a tram line, or a ferry sharing a number with a night bus).
    let lineId =
      fixed?.id ?? (mode === 'bus' && byLine.has(`tram:${ref}`) ? `B${ref}` : ref)
    if (lines.some((l) => l.id === lineId)) {
      const prefixed = `${mode === 'bus' ? 'B' : mode === 'ferry' ? 'FÄ' : mode === 'subway' ? 'U' : 'T'}${lineId}`
      console.warn(`  ⚠ Line ID "${lineId}" assigned twice – using "${prefixed}"`)
      lineId = prefixed
    }
    const name = fixed?.name ?? LINE_NAME[mode](ref)
    const colour = chosen[0].rel.tags?.colour
    const palette = PALETTE_BY_MODE[mode]
    const fallbackColor =
      fixed?.color ?? palette[(colorIndex[mode] = (colorIndex[mode] ?? 0) + 1) % palette.length]
    // The consist the map draws the line with: the fixed line's, else
    // the city fleet's for the mode. Dimensions ride along only where the
    // line has its own (ferries) – the runtime takes the rest from the fleet.
    const vehicle = fixed?.vehicle
    const model = fixed?.model ?? city.fleet[mode]?.model
    lines.push({
      id: lineId,
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(colour || '') ? colour : fallbackColor,
      mode,
      ...(vehicle ? { vehicle } : {}),
      ...(model ? { model } : {}),
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
    throw new Error(`${city.name}: no lines extracted – network.json left unchanged`)
  }

  // Unnamed stop_positions: first ask OSM's stop_area relations (the
  // authoritative name), then fall back to the nearest named neighbor.
  const unnamed = Object.entries(stops).filter(([, stop]) => stop.name === 'Stop')
  if (unnamed.length > 0) {
    const areaNames = await fetchStopAreaNames(
      unnamed.map(([id]) => Number(id.replace('osm-', ''))).filter(Number.isFinite),
    )
    for (const [id, stop] of unnamed) {
      const name = areaNames.get(Number(id.replace('osm-', '')))
      if (name) {
        stop.name = name
        console.log(`  ℹ Unnamed stop ${id} named "${name}" via its stop_area`)
      }
    }
  }
  inheritUnnamedStopNames(stops)

  const network = {
    meta: {
      source: 'osm',
      attribution:
        'Route and stop data © OpenStreetMap contributors (ODbL 1.0), via Overpass API.',
    },
    stops,
    lines,
  }

  writeFileSync(outPath, JSON.stringify(network, null, 2) + '\n', 'utf8')
  console.log(`\n✅ Wrote ${outPath} (${lines.length} lines, ${Object.keys(stops).length} stops)`)
  console.log('Tip: npm test validates the new dataset.')
}

/**
 * Meters between two [lon, lat] pairs (flat-earth, fine at city scale).
 */
function stopDistanceMeters(a, b) {
  const latRad = (a[1] * Math.PI) / 180
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(latRad), (a[1] - b[1]) * 111320)
}

/**
 * Second stage after the stop_area lookup: stops still named 'Stop'
 * inherit the name of the nearest properly named stop within
 * NAME_INHERIT_RADIUS meters – at a junction the correct name stands
 * two meters away. The radius is deliberately tight: at ~70 m the nearest
 * neighbor is regularly the WRONG station (verified against stop_areas).
 * Only stops with no such neighbor keep the placeholder.
 */
export const NAME_INHERIT_RADIUS = 60
export function inheritUnnamedStopNames(stops) {
  const named = Object.values(stops).filter((s) => s.name && s.name !== 'Stop')
  for (const [id, stop] of Object.entries(stops)) {
    if (stop.name !== 'Stop') continue
    let best = null
    let bestDist = NAME_INHERIT_RADIUS
    for (const candidate of named) {
      const d = stopDistanceMeters(stop.coord, candidate.coord)
      if (d < bestDist) {
        best = candidate
        bestDist = d
      }
    }
    if (best) {
      stop.name = best.name
      console.log(
        `  ℹ Unnamed stop ${id} inherits "${best.name}" (${bestDist.toFixed(0)} m away)`,
      )
    } else {
      console.warn(`  ⚠ Unnamed stop ${id} keeps the placeholder – no named stop within ${NAME_INHERIT_RADIUS} m`)
    }
  }
}

// Only run as a CLI – tests import stitchWays without triggering a fetch.
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  forEachRequestedCity((city, paths) =>
    buildNetwork(city, process.env.NETWORK_OUT ? resolve(process.env.NETWORK_OUT) : paths.network),
  ).catch((err) => {
    console.error('❌ Error:', err.message)
    process.exit(1)
  })
}
