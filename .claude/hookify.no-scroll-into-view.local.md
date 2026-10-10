---
name: no-scroll-into-view
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: /src/components/
  - field: content
    operator: regex_match
    pattern: \.scrollIntoView\s*\(
---
**Nothing inside a card may call `scrollIntoView`** (PROJECT-PLAN-DECISIONS.md,
"A phone gets one sheet"): it scrolls every scrollable ancestor, and the
vehicle card's stop list once took the card's body along with it. Scroll the
list's own viewport instead, as `TripStops` in VehicleCard.tsx does.
