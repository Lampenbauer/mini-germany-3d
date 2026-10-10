---
name: measure
description: Boots the map in a real browser on the real GPU and measures what a frame costs – GPU time from timer queries, CPU time in viewer.render(), draw calls, commands, tile memory – or checks that the tile shader compiles online. Use for any question of what something costs the CPU or the GPU ("Wie teuer wäre das für CPU/GPU?"), before and after a rendering change, to compare the working tree with an older commit, after editing TIME_OF_DAY_SHADER, and whenever the app has to be launched and looked at in a real browser.
argument-hint: "[frame|shader] [--city berlin] [--hash 'lat=…'] [--variants 'msaa=1;msaa=2'] [--compare <rev>]"
allowed-tools: Bash(node ${CLAUDE_SKILL_DIR}/measure.mjs *)
---

# Measure

`node ${CLAUDE_SKILL_DIR}/measure.mjs --help` lists every option. The script
starts its own dev server (port 5188; a `--compare` copy gets 5189), opens a
headed Chromium window, prints its progress on stderr and the table on stdout,
and leaves no server and no temp copy behind. It is the method of "How to
actually measure a frame" in PROJECT-PLAN-DECISIONS.md as a script – read that
section and "Rendering and performance" before drawing conclusions.

## Typical runs

- What a view costs: `node ${CLAUDE_SKILL_DIR}/measure.mjs --city berlin --time 08:30`
- A close view: add `--hash 'lat=…&lon=…&height=…&heading=…&pitch=…'` – the
  pose from the app's address bar; layer switches (`routes=0`) go there too.
- A runtime knob, interleaved on one page: `--variants 'msaa=1;msaa=2'`
  (also `shadows`, `shadowSize`, `resolutionScale`, `tiltShift`, `atmosphere`,
  `fxaa`; comma within a variant, semicolon between).
- A code change: `--compare HEAD` measures the working tree against the last
  commit, `--compare <sha>` against any – a `git archive` copy with its own dev
  server, four rounds by default, the order reversed each round.
- The phone's tier: `--query tier=mobile`; a tile budget: `--query sse=8`.
- A tile-tree or leak question: at the size it happens, `--size 2560x1440`
  (a 5K buffer at DPR 2) – thresholds measured at a small window are wrong.
- After editing `TIME_OF_DAY_SHADER`: `node ${CLAUDE_SKILL_DIR}/measure.mjs shader`
  – exits 1 on a loop error, a render exception or a shader error in the
  console. Offline runs and the e2e suite never compile that shader.

## Reading the numbers

- **GPU ms** is the timer query around one `viewer.render()`; **CPU ms** the
  JavaScript of that call; **draws** every draw the frame executed, shadow
  cascades and passes included; **commands** what the frame collected
  (`frameState.commandList`). Medians with quartiles, and the median of each
  round: when two subjects are close, the rounds say whether the difference is
  larger than the noise – sixty frames of one build have varied between runs
  by more than a change.
- **Memory ratchet ON** means Cesium is overriding the LOD; SSE changes are
  moot until the memory budget is the problem being solved.
- **A failed request** printed under a build means it loaded less than the
  other – it measured a different map. Find out why before comparing.
- The defaults are the tables' baseline: 1600×1000 CSS at DPR 2 (a 3200×2000
  buffer), headed, the clock paused at 12:00:00, the live layers off (`--live`
  keeps ships, aircraft, weather, delays and webcams).
- `--offline` measures the wireframe globe and `--headless` SwiftShader: neither
  is the real map's cost.
- The dev build inflates React (jsxDEV). For the React side's CPU, build
  (`npm run build`), serve (`npx vite preview --port 5190`) and pass
  `--url http://localhost:5190`.
- The macOS GPU gauge is not a cost signal – it reads frequency, not cost.

## What it does not do

- Firefox: the Firefox numbers in PROJECT-PLAN-DECISIONS.md came from
  Playwright driving the stock Firefox with a Gecko profile; this script is
  Chromium only (`--channel chrome` takes the installed Chrome instead).
- Heap and leaks: CDP's `HeapProfiler.collectGarbage` and
  `Runtime.queryObjects`, as "The tile-tree leak" describes.
- Looking around: a screenshot, a `window.__mg3d` reading or a click on the
  canvas is the Playwright MCP's job (`browser_evaluate`, `browser_mouse_click_xy`);
  numbers that go into a decision come from here.

What was measured – the scene, the numbers, the conclusion – goes where the
decision is written: PROJECT-PLAN-DECISIONS.md and the commit message, never
only the conversation.
