#!/usr/bin/env node
/**
 * Generates src/cities/rostock/network.json with an approximated model of the
 * Rostock tram network (RSAG, lines 1, 2, 3, 5, 6).
 *
 * IMPORTANT: The geometry is an approximation (hand-modeled along the real
 * corridors), NOT an official map. For exact track geometry from
 * OpenStreetMap:  npm run data:update  (requires internet access to the
 * Overpass API and overwrites this file).
 *
 * The stop names and line routes follow the real RSAG network:
 *   Line 1: Mecklenburger Allee – Hafenallee
 *   Line 2: Reutershagen – Kurt-Schumacher-Ring
 *   Line 3: Neuer Friedhof – Kurt-Schumacher-Ring
 *   Line 5: Mecklenburger Allee – Südblick
 *   Line 6: Neuer Friedhof – Campus Südstadt
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(__dirname, '../src/cities/rostock/network.json')

// ---------------------------------------------------------------------------
// Stops (id → name + [lon, lat]); coordinates approximated.
// ---------------------------------------------------------------------------
const STOPS = {
  'mecklenburger-allee': { name: 'Mecklenburger Allee', coord: [12.068, 54.1105] },
  marienehe: { name: 'Marienehe', coord: [12.0805, 54.1035] },
  reutershagen: { name: 'Reutershagen', coord: [12.094, 54.0925] },
  'hamburger-strasse': { name: 'Hamburger Straße', coord: [12.108, 54.0908] },
  volkstheater: { name: 'Volkstheater', coord: [12.1152, 54.0895] },
  'doberaner-platz': { name: 'Doberaner Platz', coord: [12.1222, 54.0888] },
  'kroepeliner-tor': { name: 'Kröpeliner Tor', coord: [12.1286, 54.0892] },
  'lange-strasse': { name: 'Lange Straße', coord: [12.134, 54.0896] },
  'neuer-markt': { name: 'Neuer Markt', coord: [12.1406, 54.0881] },
  steintor: { name: 'Steintor', coord: [12.1394, 54.0841] },
  'am-voegenteich': { name: 'Am Vögenteich', coord: [12.1362, 54.0821] },
  hauptbahnhof: { name: 'Hauptbahnhof', coord: [12.131, 54.0783] },
  stadthalle: { name: 'Stadthalle', coord: [12.1281, 54.0806] },
  goetheplatz: { name: 'Goetheplatz', coord: [12.1233, 54.0841] },
  petridamm: { name: 'Petridamm', coord: [12.1503, 54.0921] },
  'dierkower-kreuz': { name: 'Dierkower Kreuz', coord: [12.158, 54.0972] },
  'dierkower-allee': { name: 'Dierkower Allee', coord: [12.1618, 54.1013] },
  hafenallee: { name: 'Hafenallee', coord: [12.1568, 54.1078] },
  'hannes-meyer-platz': { name: 'Hannes-Meyer-Platz', coord: [12.1673, 54.0988] },
  'kurt-schumacher-ring': { name: 'Kurt-Schumacher-Ring', coord: [12.1745, 54.1005] },
  'erich-schlesinger-strasse': { name: 'Erich-Schlesinger-Straße', coord: [12.1268, 54.0733] },
  'suedstadt-center': { name: 'Südstadt-Center', coord: [12.1219, 54.0699] },
  suedblick: { name: 'Südblick', coord: [12.118, 54.0641] },
  'robert-koch-strasse': { name: 'Robert-Koch-Straße', coord: [12.1148, 54.0693] },
  'klinikum-suedstadt': { name: 'Klinikum Südstadt', coord: [12.1092, 54.0704] },
  'campus-suedstadt': { name: 'Campus Südstadt', coord: [12.103, 54.0722] },
  schillingallee: { name: 'Schillingallee', coord: [12.115, 54.081] },
  'neuer-friedhof': { name: 'Neuer Friedhof', coord: [12.1085, 54.0762] },
}

// ---------------------------------------------------------------------------
// Corridors: shared route segments (each in one direction).
// Points [lon, lat]; stop coordinates lie exactly on the paths.
// ---------------------------------------------------------------------------
const C = {
  // Northwest: Mecklenburger Allee → Doberaner Platz
  nw: [
    [12.068, 54.1105],
    [12.07, 54.1095],
    [12.073, 54.1082],
    [12.077, 54.106],
    [12.0805, 54.1035], // Marienehe
    [12.083, 54.101],
    [12.086, 54.0985],
    [12.09, 54.095],
    [12.094, 54.0925], // Reutershagen
    [12.0985, 54.092],
    [12.103, 54.0915],
    [12.108, 54.0908], // Hamburger Straße
    [12.112, 54.09],
    [12.1152, 54.0895], // Volkstheater
    [12.1175, 54.0893],
    [12.12, 54.0891],
    [12.1222, 54.0888], // Doberaner Platz
  ],
  // City center north: Doberaner Platz → Neuer Markt (via Lange Straße)
  cityNorth: [
    [12.1222, 54.0888],
    [12.124, 54.0889],
    [12.1265, 54.0891],
    [12.1286, 54.0892], // Kröpeliner Tor
    [12.1315, 54.0895],
    [12.134, 54.0896], // Lange Straße
    [12.136, 54.0894],
    [12.139, 54.0888],
    [12.1406, 54.0881], // Neuer Markt
  ],
  // City center east: Neuer Markt → Steintor
  steinstrasse: [
    [12.1406, 54.0881],
    [12.1402, 54.0868],
    [12.1398, 54.0852],
    [12.1394, 54.0841], // Steintor
  ],
  // Steintor → Hauptbahnhof
  steintorHbf: [
    [12.1394, 54.0841],
    [12.138, 54.083],
    [12.1362, 54.0821], // Am Vögenteich
    [12.134, 54.0805],
    [12.1322, 54.0793],
    [12.131, 54.0783], // Hauptbahnhof
  ],
  // Hauptbahnhof → Stadthalle → Goetheplatz
  hbfGoethe: [
    [12.131, 54.0783],
    [12.1295, 54.0795],
    [12.1281, 54.0806], // Stadthalle
    [12.1268, 54.082],
    [12.125, 54.0832],
    [12.1233, 54.0841], // Goetheplatz
  ],
  // Goetheplatz → Doberaner Platz
  goetheDobi: [
    [12.1233, 54.0841],
    [12.1228, 54.0855],
    [12.1224, 54.087],
    [12.1222, 54.0888], // Doberaner Platz
  ],
  // Neuer Markt → Dierkower Kreuz (across the Warnow / Petribrücke)
  ne: [
    [12.1406, 54.0881],
    [12.1425, 54.0887],
    [12.1442, 54.0895],
    [12.147, 54.0907],
    [12.149, 54.0915],
    [12.1503, 54.0921], // Petridamm
    [12.153, 54.094],
    [12.1555, 54.0957],
    [12.158, 54.0972], // Dierkower Kreuz
  ],
  // Dierkower Kreuz → Hafenallee (Toitenwinkel)
  toitenwinkel: [
    [12.158, 54.0972],
    [12.16, 54.099],
    [12.1618, 54.1013], // Dierkower Allee
    [12.1615, 54.104],
    [12.1595, 54.1062],
    [12.1568, 54.1078], // Hafenallee
  ],
  // Dierkower Kreuz → Kurt-Schumacher-Ring (Dierkow)
  dierkow: [
    [12.158, 54.0972],
    [12.162, 54.0978],
    [12.165, 54.0983],
    [12.1673, 54.0988], // Hannes-Meyer-Platz
    [12.1705, 54.0994],
    [12.173, 54.0999],
    [12.1745, 54.1005], // Kurt-Schumacher-Ring
  ],
  // Hauptbahnhof → Südstadt-Center
  hbfSued: [
    [12.131, 54.0783],
    [12.13, 54.0768],
    [12.1285, 54.075],
    [12.1268, 54.0733], // Erich-Schlesinger-Straße
    [12.1245, 54.0715],
    [12.1219, 54.0699], // Südstadt-Center
  ],
  // Südstadt-Center → Südblick
  suedblick: [
    [12.1219, 54.0699],
    [12.12, 54.0672],
    [12.118, 54.0641], // Südblick
  ],
  // Südstadt-Center → Campus Südstadt
  campus: [
    [12.1219, 54.0699],
    [12.1148, 54.0693], // Robert-Koch-Straße
    [12.1092, 54.0704], // Klinikum Südstadt
    [12.106, 54.0712],
    [12.103, 54.0722], // Campus Südstadt
  ],
  // Goetheplatz → Neuer Friedhof (via Schillingallee)
  sw: [
    [12.1233, 54.0841],
    [12.121, 54.083],
    [12.118, 54.082],
    [12.115, 54.081], // Schillingallee
    [12.112, 54.079],
    [12.11, 54.0775],
    [12.1085, 54.0762], // Neuer Friedhof
  ],
}

/** Chain corridors; remove duplicate joint points; `-name` = reversed. */
function chain(...parts) {
  const path = []
  for (const part of parts) {
    const reversed = part.startsWith('-')
    const key = reversed ? part.slice(1) : part
    const seg = reversed ? [...C[key]].reverse() : C[key]
    for (const p of seg) {
      const last = path[path.length - 1]
      if (last && last[0] === p[0] && last[1] === p[1]) continue
      path.push(p)
    }
  }
  return path
}

// Partial corridor for line 2 (only starts at Reutershagen)
C.nwFromReutershagen = C.nw.slice(C.nw.findIndex((p) => p[0] === 12.094))

// ---------------------------------------------------------------------------
// Lines (one direction; the opposite direction is mirrored at runtime)
// ---------------------------------------------------------------------------
const LINES = [
  {
    id: '1',
    name: 'Line 1',
    color: '#D71920',
    directions: [
      {
        from: 'Mecklenburger Allee',
        to: 'Hafenallee',
        path: chain('nw', 'cityNorth', 'ne', 'toitenwinkel'),
        stops: [
          'mecklenburger-allee',
          'marienehe',
          'reutershagen',
          'hamburger-strasse',
          'volkstheater',
          'doberaner-platz',
          'kroepeliner-tor',
          'lange-strasse',
          'neuer-markt',
          'petridamm',
          'dierkower-kreuz',
          'dierkower-allee',
          'hafenallee',
        ],
      },
    ],
  },
  {
    id: '2',
    name: 'Line 2',
    color: '#0072BC',
    directions: [
      {
        from: 'Reutershagen',
        to: 'Kurt-Schumacher-Ring',
        path: chain('nwFromReutershagen', '-goetheDobi', '-hbfGoethe', '-steintorHbf', '-steinstrasse', 'ne', 'dierkow'),
        stops: [
          'reutershagen',
          'hamburger-strasse',
          'volkstheater',
          'doberaner-platz',
          'goetheplatz',
          'stadthalle',
          'hauptbahnhof',
          'am-voegenteich',
          'steintor',
          'neuer-markt',
          'petridamm',
          'dierkower-kreuz',
          'hannes-meyer-platz',
          'kurt-schumacher-ring',
        ],
      },
    ],
  },
  {
    id: '3',
    name: 'Line 3',
    color: '#F39200',
    directions: [
      {
        from: 'Neuer Friedhof',
        to: 'Kurt-Schumacher-Ring',
        path: chain('-sw', 'goetheDobi', 'cityNorth', 'ne', 'dierkow'),
        stops: [
          'neuer-friedhof',
          'schillingallee',
          'goetheplatz',
          'doberaner-platz',
          'kroepeliner-tor',
          'lange-strasse',
          'neuer-markt',
          'petridamm',
          'dierkower-kreuz',
          'hannes-meyer-platz',
          'kurt-schumacher-ring',
        ],
      },
    ],
  },
  {
    id: '5',
    name: 'Line 5',
    color: '#009640',
    directions: [
      {
        from: 'Mecklenburger Allee',
        to: 'Südblick',
        path: chain('nw', '-goetheDobi', '-hbfGoethe', 'hbfSued', 'suedblick'),
        stops: [
          'mecklenburger-allee',
          'marienehe',
          'reutershagen',
          'hamburger-strasse',
          'volkstheater',
          'doberaner-platz',
          'goetheplatz',
          'stadthalle',
          'hauptbahnhof',
          'erich-schlesinger-strasse',
          'suedstadt-center',
          'suedblick',
        ],
      },
    ],
  },
  {
    id: '6',
    name: 'Line 6',
    color: '#94368D',
    directions: [
      {
        from: 'Neuer Friedhof',
        to: 'Campus Südstadt',
        path: chain('-sw', '-hbfGoethe', 'hbfSued', 'campus'),
        stops: [
          'neuer-friedhof',
          'schillingallee',
          'goetheplatz',
          'stadthalle',
          'hauptbahnhof',
          'erich-schlesinger-strasse',
          'suedstadt-center',
          'robert-koch-strasse',
          'klinikum-suedstadt',
          'campus-suedstadt',
        ],
      },
    ],
  },
]

const network = {
  meta: {
    source: 'approximated',
    attribution:
      'Demo dataset: line geometry approximated (hand-modeled). ' +
      'Real track geometry: npm run data:update (OpenStreetMap/Overpass, © OpenStreetMap contributors, ODbL).',
  },
  stops: STOPS,
  lines: LINES,
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(network, null, 2) + '\n', 'utf8')
console.log(`✅ Wrote ${OUT} (${LINES.length} lines, ${Object.keys(STOPS).length} stops)`)
