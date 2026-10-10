---
name: cesium-hex
enabled: true
event: file
action: warn
conditions:
  - field: content
    operator: regex_match
    pattern: fromCssColorString\(\s*['"`]oklch\(
---
**Cesium reads no `oklch()`** (PROJECT-PLAN-DECISIONS.md, "Interface and
styling"): `Color.fromCssColorString` parses hex, `rgb()` and `hsl()` and fails
silently on anything newer, so every colour that reaches Cesium – hull colours,
the ship name plate, the globe base – stays hex. A 2D canvas or an SVG reads
`oklch()` fine (the stop names, the line diagram); Cesium does not.
