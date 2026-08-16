#!/usr/bin/env node
/**
 * Lädt die echten Rostocker ÖPNV-Routen aus OpenStreetMap (Overpass API)
 * und erzeugt daraus src/data/network.json mit exakter Geometrie:
 *   - alle Straßenbahn-Linien (route=tram)
 *   - alle RSAG-Buslinien (route=bus, operator RSAG)
 *   - die Fähren Kabutzenhof–Gehlsdorf (56291) und
 *     Warnemünde–Hohe Düne (56296)
 *
 *   npm run data:update
 *
 * Umgebungsvariablen:
 *   OVERPASS_URL  – alternativer Overpass-Endpunkt (überspringt die Mirror-Liste)
 *   OVERPASS_FILE – lokale JSON-Datei mit einer bereits gespeicherten
 *                   Overpass-Antwort (kein Netzwerkzugriff nötig)
 *   NETWORK_OUT   – alternativer Ausgabepfad (Standard: src/data/network.json)
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
const OUT = process.env.NETWORK_OUT
  ? resolve(process.env.NETWORK_OUT)
  : resolve(__dirname, '../src/data/network.json')

// Öffentliche Overpass-Instanzen; werden der Reihe nach probiert.
const OVERPASS_MIRRORS = process.env.OVERPASS_URL
  ? [process.env.OVERPASS_URL]
  : [
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://overpass.osm.ch/api/interpreter',
    ]

// Overpass-Instanzen erwarten identifizierbare Clients; Requests ohne
// User-Agent werden teils abgelehnt (z.B. mit HTTP 403/406).
const REQUEST_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  Accept: 'application/json',
  'User-Agent':
    'mini-rostock-3d-data-pipeline/0.1 (+https://github.com/Lampenbauer/mini-rostock-3d)',
}

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

// Buslinien ohne colour-Tag bekommen reihum eine unterscheidbare Farbe.
const BUS_PALETTE = [
  '#1D4ED8', '#059669', '#B45309', '#7C3AED', '#BE185D',
  '#0E7490', '#4D7C0F', '#B91C1C', '#6D28D9', '#0F766E',
]

/**
 * Die beiden gewünschten Fähren, adressiert über ihre OSM-Relations-IDs.
 * Maße lt. Betreiberangaben; die Höhe ist eine visuelle Näherung über
 * Wasserlinie (Antriebe/Aufbauten).
 */
const FERRIES = {
  56291: {
    id: 'F1',
    name: 'Fähre Kabutzenhof – Gehlsdorf',
    color: '#0E7490',
    vehicle: { length: 19.9, width: 6.6, height: 3.5 },
  },
  56296: {
    id: 'F2',
    name: 'Fähre Warnemünde – Hohe Düne',
    color: '#155E75',
    vehicle: { length: 39, width: 11, height: 6 },
  },
}

// Wichtig: "out body qt" (nicht "out skel qt"), damit Knoten/Wege ihre Tags
// behalten – sonst fehlen die Haltestellennamen.
// Busse: nur RSAG (Regionalbusse anderer Betreiber wie rebus bleiben außen vor).
const QUERY = `
[out:json][timeout:240][bbox:${BBOX}];
(
  relation["route"="tram"];
  relation["route"="bus"]["operator"~"Rostocker Straßenbahn|RSAG",i];
  relation(id:${Object.keys(FERRIES).join(',')});
);
out body;
>;
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

async function fetchOverpassData() {
  if (process.env.OVERPASS_FILE) {
    console.log(`Lese lokale Overpass-Antwort ${process.env.OVERPASS_FILE}`)
    const { readFileSync } = await import('node:fs')
    return JSON.parse(readFileSync(process.env.OVERPASS_FILE, 'utf8'))
  }

  const errors = []
  for (const url of OVERPASS_MIRRORS) {
    console.log(`Overpass-Abfrage an ${url} …`)
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(QUERY),
        headers: REQUEST_HEADERS,
      })
      if (!response.ok) {
        const body = (await response.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
        errors.push(`${url} → HTTP ${response.status}: ${body.slice(0, 200)}`)
        console.warn(`  ⚠ HTTP ${response.status} – versuche nächsten Mirror`)
        continue
      }
      return await response.json()
    } catch (err) {
      errors.push(`${url} → ${err.message}`)
      console.warn(`  ⚠ ${err.message} – versuche nächsten Mirror`)
    }
  }
  throw new Error(
    'Alle Overpass-Endpunkte fehlgeschlagen:\n  ' +
      errors.join('\n  ') +
      '\nTipp: eigenen Endpunkt via OVERPASS_URL setzen oder eine gespeicherte ' +
      'Antwort via OVERPASS_FILE verwenden.',
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
  console.log(
    `${relations.length} Routen-Relationen, ${wayById.size} Wege, ${nodeById.size} Knoten geladen`,
  )

  // Relationen nach Linie gruppieren: Trams/Busse über ihren ref-Tag,
  // die Fähren über ihre feste Relations-ID (sie tragen teils keinen ref).
  const byLine = new Map() // key → { mode, ref, fixed?, rels }
  for (const rel of relations) {
    const ferry = FERRIES[rel.id]
    if (ferry) {
      const key = `ferry:${ferry.id}`
      if (!byLine.has(key)) byLine.set(key, { mode: 'ferry', ref: ferry.id, fixed: ferry, rels: [] })
      byLine.get(key).rels.push(rel)
      continue
    }
    const mode = rel.tags?.route === 'bus' ? 'bus' : rel.tags?.route === 'tram' ? 'tram' : null
    const ref = rel.tags?.ref
    if (!mode || !ref) continue
    const key = `${mode}:${ref}`
    if (!byLine.has(key)) byLine.set(key, { mode, ref, rels: [] })
    byLine.get(key).rels.push(rel)
  }

  const stops = {}
  const lines = []
  const MODE_ORDER = { tram: 0, bus: 1, ferry: 2 }
  let busColorIndex = 0

  const groups = [...byLine.values()].sort(
    (a, b) =>
      MODE_ORDER[a.mode] - MODE_ORDER[b.mode] ||
      a.ref.localeCompare(b.ref, 'de', { numeric: true }),
  )
  for (const { mode, ref, fixed, rels } of groups) {
    // Name eines Relations-Members (Knoten oder Weg) ermitteln
    const memberName = (m) => {
      if (!m) return undefined
      const el =
        m.type === 'node' ? nodeById.get(m.ref) : m.type === 'way' ? wayById.get(m.ref) : null
      return el?.tags?.name
    }

    // Pro Linie die (bis zu) zwei längsten Richtungs-Varianten nehmen
    const candidates = rels
      .map((rel) => {
        const wayMembers = rel.members.filter((m) => m.type === 'way' && !/platform/.test(m.role || ''))
        const path = stitchWays(wayMembers, wayById, nodeById, `Linie ${ref} (${rel.id})`)
        const stopNodes = []
        rel.members.forEach((m, i) => {
          if (m.type !== 'node' || !/stop/.test(m.role || '')) return
          const node = nodeById.get(m.ref)
          if (!node) return
          // Unbenannte stop_positions erben den Namen der benachbarten
          // Platform (PTv2-Relationen listen stop + platform paarweise).
          let name = node.tags?.name
          if (!name && /platform/.test(rel.members[i + 1]?.role || '')) {
            name = memberName(rel.members[i + 1])
          }
          if (!name && /platform/.test(rel.members[i - 1]?.role || '')) {
            name = memberName(rel.members[i - 1])
          }
          stopNodes.push({ node, name })
        })
        return { rel, path, stopNodes }
      })
      // Fähr-Relationen führen ihre Anleger oft nicht als stop-Rollen –
      // dafür gibt es unten einen Fallback über die Pfad-Enden.
      .filter((c) => c.path.length >= 2 && (c.stopNodes.length >= 2 || mode === 'ferry'))
      .sort((a, b) => b.path.length - a.path.length)

    if (candidates.length === 0) {
      console.warn(`⚠ ${mode === 'bus' ? 'Bus' : mode === 'ferry' ? 'Fähre' : 'Linie'} ${ref}: keine verwertbare Relation – übersprungen`)
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
      for (const { node, name } of stopNodes) {
        const id = `osm-${node.id}`
        const coord = [node.lon, node.lat]
        const dist = projectOntoPath(path, cum, coord)
        if (dist <= lastDist) {
          dropped++
          continue // Halt liegt nicht monoton auf der Strecke (z.B. Schleife)
        }
        lastDist = dist
        // Bereits bekannte Namen (z.B. aus der Gegenrichtungs-Relation)
        // nicht mit dem Platzhalter überschreiben
        const resolvedName =
          name || node.tags?.name || (stops[id]?.name !== 'Haltestelle' && stops[id]?.name) || 'Haltestelle'
        stops[id] = { name: resolvedName, coord }
        dirStops.push(id)
      }
      if (dropped > 0) {
        console.warn(`  ⚠ Linie ${ref}: ${dropped} nicht-monotone Halte entfernt`)
      }
      if (mode === 'ferry' && dirStops.length < 2) {
        // Anleger aus den Pfad-Enden ableiten; Namen aus from/to der Relation.
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
          mkStop('a', path[0], rel.tags?.from || 'Anleger'),
          mkStop('b', path[path.length - 1], rel.tags?.to || 'Anleger'),
        )
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

    // Bus-Refs könnten theoretisch mit Tram-Refs kollidieren – dann Präfix.
    const lineId =
      fixed?.id ?? (mode === 'bus' && byLine.has(`tram:${ref}`) ? `B${ref}` : ref)
    const name =
      fixed?.name ?? (mode === 'bus' ? `Bus ${ref}` : `Linie ${ref}`)
    const colour = chosen[0].rel.tags?.colour
    const fallbackColor =
      fixed?.color ??
      (mode === 'bus'
        ? BUS_PALETTE[busColorIndex++ % BUS_PALETTE.length]
        : FALLBACK_COLORS[ref] || '#64748b')
    lines.push({
      id: lineId,
      name,
      color: /^#[0-9a-fA-F]{6}$/.test(colour || '') ? colour : fallbackColor,
      mode,
      ...(fixed?.vehicle ? { vehicle: fixed.vehicle } : {}),
      directions,
    })
    console.log(
      `✓ ${name}: ${directions.length} Richtung(en), ` +
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
