---
name: tailwind-whole-classes
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: /src/.+\.tsx?$
  - field: content
    operator: regex_match
    pattern: \$\{[^}]+\}(?:p[xytrbl]?|m[xytrbl]?|w|h|gap|bg|text|border|rounded|top|right|bottom|left|inset)-|\b(?:bg|text|border|ring|fill|stroke|p[xytrbl]?|m[xytrbl]?|w|h|gap)-\$\{
---
**Tailwind v4 reads the source as text** (PROJECT-PLAN-DECISIONS.md): a class
name assembled at runtime (`` `${VARIANT}px-8` ``, `` `bg-${colour}` ``) is a
class no rule is ever generated for, and it fails silently – the element simply
has no padding. Write every candidate out in full, including the long stacked
variants (`sm:[@media(max-height:560px)]:py-5`).
