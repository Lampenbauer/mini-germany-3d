#!/usr/bin/env node
/**
 * Lädt die echten Rostocker Straßenbahn-Routen aus OpenStreetMap (Overpass API)
 * und erzeugt daraus src/data/network.json mit exakter Gleisgeometrie.
 *
 *   npm run data:update
 *
 * Umgebungsvariablen:
 *   OVERPASS_URL  – alternativer Overpass-Endpunkt
 *                   (Standard: https://overpass-api.de/api/interpreter)
 *
 * Datenlizenz: © OpenStreetMap-Mitwirkende, ODbL 1.0 (https://osm.org/copyright)
 *
 * Hinweis: In Sandbox-/CI-Umgebungen ohne freien Internetzugang schlägt dieses
 * Skript fehl – dann bleibt der mitgelieferte approximierte Datensatz aktiv
 * (scripts/build-approx-network.mjs).
 */

import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../src/data/network.json')
const OVERPASS_URL = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter'

// Bounding-Box Rostock (Süd, West, Nord, Ost)
const BBOX = '53.95,11.95,54.22,12.35'

// Fallback-Farben, falls OSM keine colour-Tags liefert (RSAG-ähnliche Palette)
const FALLBACK_COLORS = {
  1: '#D71920',
  2: '#0072BC',
  3: '#F39200',
  4: '#8B6F47',
  5: '#009640',
  6: '#94368D',
  7: '#00A5B5',
}

const QUERY = `
[out:json][timeout:180][bbox:${BBOX}];
(
  relation["route"="tram"];
);
out body;
>;
out skel qt;
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
 * Verkettet die Wege einer Relation zu einer durchgehenden Polylinie.
 * OSM-PTv2-Relationen führen die Wege geordnet; die Orientierung jedes Wegs
 * wird über den Anschluss an das jeweilige Streckenende bestimmt.
 */
function stitchWays(ways, wayById, nodeById, label) {
  const coords = []
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

  for (const member of ways) {
    const pts = wayCoords(member.ref)
    if (!pts) continue

    if (coords.length === 0) {
      coords.push(...pts)
      continue
    }

    const end = coords[coords.length - 1]
    const dStart = haversineMeters(end, pts[0])
    const dEnd = haversineMeters(end, pts[pts.length - 1])
    const oriented = dStart <= dEnd ? pts : [...pts].reverse()
    const gap = Math.min(dStart, dEnd)

    if (gap > 150) {
      // Lücke in der Relation (z.B. Betriebsstrecke) – Weg auslassen
      gaps++
      continue
    }

    // Ersten Punkt überspringen, wenn er dem Streckenende entspricht
    const startIdx = gap < 1 ? 1 : 0
    coords.push(...oriented.slice(startIdx))
  }

  if (gaps > 0) {
    console.warn(`  ⚠ ${label}: ${gaps} Weg(e) mit Lücke > 150 m übersprungen`)
  }
  return coords
}

function cumulative(path) {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + haversineMeters(path[i - 1], path[i]))
  }
  return cum
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

async function main() {
  console.log(`Overpass-Abfrage an ${OVERPASS_URL} …`)
  const response = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(QUERY),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  })
  if (!response.ok) {
    throw new Error(`Overpass antwortete mit HTTP ${response.status}`)
  }
  const data = await response.json()

  const nodeById = new Map()
  const wayById = new Map()
  const relations = []
  for (const el of data.elements) {
    if (el.type === 'node') nodeById.set(el.id, el)
    else if (el.type === 'way') wayById.set(el.id, el)
    else if (el.type === 'relation') relations.push(el)
  }
  console.log(
    `${relations.length} Tram-Relationen, ${wayById.size} Wege, ${nodeById.size} Knoten geladen`,
  )

  // Relationen nach Linien-Ref gruppieren
  const byRef = new Map()
  for (const rel of relations) {
    const ref = rel.tags?.ref
    if (!ref) continue
    if (!byRef.has(ref)) byRef.set(ref, [])
    byRef.get(ref).push(rel)
  }

  const stops = {}
  const lines = []

  for (const [ref, rels] of [...byRef.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de', { numeric: true }))) {
    // Pro Linie die (bis zu) zwei längsten Richtungs-Varianten nehmen
    const candidates = rels
      .map((rel) => {
        const wayMembers = rel.members.filter((m) => m.type === 'way' && !/platform/.test(m.role || ''))
        const path = stitchWays(wayMembers, wayById, nodeById, `Linie ${ref} (${rel.id})`)
        const stopNodes = rel.members
          .filter((m) => m.type === 'node' && /stop/.test(m.role || ''))
          .map((m) => nodeById.get(m.ref))
          .filter(Boolean)
        return { rel, path, stopNodes }
      })
      .filter((c) => c.path.length >= 2 && c.stopNodes.length >= 2)
      .sort((a, b) => b.path.length - a.path.length)

    if (candidates.length === 0) {
      console.warn(`⚠ Linie ${ref}: keine verwertbare Relation – übersprungen`)
      continue
    }

    // Zwei Richtungen mit unterschiedlichen Endpunkten wählen
    const chosen = [candidates[0]]
    const firstTo = candidates[0].rel.tags?.to
    const opposite = candidates.find((c) => c !== candidates[0] && c.rel.tags?.to !== firstTo)
    if (opposite) chosen.push(opposite)

    const directions = []
    for (const { rel, path, stopNodes } of chosen) {
      const cum = cumulative(path)

      const dirStops = []
      let lastDist = -1
      let dropped = 0
      for (const node of stopNodes) {
        const id = `osm-${node.id}`
        const coord = [node.lon, node.lat]
        const dist = projectOntoPath(path, cum, coord)
        if (dist <= lastDist) {
          dropped++
          continue // Halt liegt nicht monoton auf der Strecke (z.B. Schleife)
        }
        lastDist = dist
        stops[id] = { name: node.tags?.name || 'Haltestelle', coord }
        dirStops.push(id)
      }
      if (dropped > 0) {
        console.warn(`  ⚠ Linie ${ref}: ${dropped} nicht-monotone Halte entfernt`)
      }
      if (dirStops.length < 2) continue

      directions.push({
        from: rel.tags?.from || stops[dirStops[0]].name,
        to: rel.tags?.to || stops[dirStops[dirStops.length - 1]].name,
        path: path.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]),
        stops: dirStops,
      })
    }

    if (directions.length === 0) {
      console.warn(`⚠ Linie ${ref}: keine gültige Richtung – übersprungen`)
      continue
    }

    const colour = chosen[0].rel.tags?.colour
    lines.push({
      id: ref,
      name: `Linie ${ref}`,
      color: /^#[0-9a-fA-F]{6}$/.test(colour || '') ? colour : FALLBACK_COLORS[ref] || '#64748b',
      directions,
    })
    console.log(
      `✓ Linie ${ref}: ${directions.length} Richtung(en), ` +
        `${directions.map((d) => `${d.stops.length} Halte/${(cumulative(d.path).at(-1) / 1000).toFixed(1)} km`).join(' + ')}`,
    )
  }

  if (lines.length === 0) {
    throw new Error('Keine Linien extrahiert – network.json bleibt unverändert')
  }

  const network = {
    meta: {
      source: 'osm',
      generated: new Date().toISOString().slice(0, 10),
      attribution:
        'Routen- und Haltestellendaten © OpenStreetMap-Mitwirkende (ODbL 1.0), via Overpass API.',
    },
    stops,
    lines,
  }

  writeFileSync(OUT, JSON.stringify(network, null, 2) + '\n', 'utf8')
  console.log(`\n✅ ${OUT} geschrieben (${lines.length} Linien, ${Object.keys(stops).length} Haltestellen)`)
  console.log('Tipp: npm test validiert den neuen Datensatz.')
}

main().catch((err) => {
  console.error('❌ Fehler:', err.message)
  process.exit(1)
})
