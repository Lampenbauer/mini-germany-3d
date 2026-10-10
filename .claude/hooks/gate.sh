#!/bin/bash
# Stop: CI's quick checks before Claude hands a turn back. The typecheck when
# TypeScript changed (`npm run typecheck`, about 4 s), and the PHP twins'
# parity scripts when a twin or what its TypeScript original imports changed
# (the six scripts/test-*.mjs, 1.5 s together) – the twins drift silently
# otherwise, until the push run fails. Silent on a clean tree and on a diff
# that already passed (a stamp per diff in $TMPDIR). A failure is handed to
# Claude (exit 2) once; while it is fixing it, stop_hook_active is set and the
# gate stands aside, as the hooks reference asks, so it can never loop.
command -v jq >/dev/null || exit 0
input=$(cat)
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ] && exit 0
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
changed=$(git status --porcelain -uall | awk '{print $NF}')
[ -z "$changed" ] && exit 0
stamp="${TMPDIR:-/tmp}/mg3d-gate-$({ git diff HEAD; git ls-files -z -o --exclude-standard | xargs -0 cat 2>/dev/null; } | shasum | cut -c1-16)"
[ -e "$stamp" ] && exit 0
if grep -qE '(\.(ts|tsx|mts)|tsconfig[^/]*\.json)$' <<<"$changed"; then
  out=$(npm run -s typecheck 2>&1) || {
    printf 'npm run typecheck failed:\n%s\n' "$out" | head -40 >&2
    exit 2
  }
fi
# What the parity scripts import, directly or through the modules they test
if grep -qE '^(server/api/|scripts/test-|src/cities/definitions\.ts|src/lib/(ais-|aircraft-|archive-|rt-extract|track-curve|city\.ts))' <<<"$changed"; then
  for s in php-parser ais-parity ais-state ais-archive-parity aircraft-parity aircraft-archive-parity; do
    out=$(node "scripts/test-$s.mjs" 2>&1) || {
      printf 'scripts/test-%s.mjs failed – a PHP twin and its TypeScript original disagree:\n%s\n' "$s" "$out" | tail -40 >&2
      exit 2
    }
  done
fi
touch "$stamp"
exit 0
