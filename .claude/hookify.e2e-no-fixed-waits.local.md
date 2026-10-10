---
name: e2e-no-fixed-waits
enabled: true
event: file
action: warn
conditions:
  - field: file_path
    operator: regex_match
    pattern: /e2e/.+\.ts$
  - field: content
    operator: regex_match
    pattern: waitForTimeout\(\s*([3-9]\d{3}|\d{5,}|[3-9]_\d{3}|\d{2,}_\d{3})\b
---
**A fixed wait over a couple of seconds is CI time** (PROJECT-PLAN-DECISIONS.md,
"Playwright specs are written and run as cheaply as they can be"): the suite
runs on one worker under SwiftShader, and every second waited is a second of the
run. Put the map into the state through `window.__mg3d` (setTime,
setAisVessels, setAircraft), poll with `expect.poll` and growing intervals, and
prove a negative by a simulated second going by (`secondsOfDay`, `loopTicks`) –
never by sleeping.
