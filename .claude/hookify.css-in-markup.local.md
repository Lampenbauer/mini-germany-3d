---
name: css-in-markup
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: /src/(?!index\.css$).+\.css$
---
**Styling lives in the markup** (PROJECT-PLAN-DECISIONS.md, "Interface and
styling"): Tailwind classes on the element, never a per-component stylesheet.
The About and Credits dialogs each had one and both were folded back into their
components. `src/index.css` holds the theme tokens, the preflight corrections
and the rules that reach markup this app does not own; a repeated class string
belongs in a `const` in the same file.
