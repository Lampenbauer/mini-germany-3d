#!/bin/bash
# PreToolUse(Bash): refuses the two commands PROJECT-PLAN-DECISIONS.md records
# as incidents. Prettier, which this repository deliberately does not use
# ("There is no formatter, and no linter either"): its defaults rewrite every
# line of every file they touch, and four component files once had to be
# restored from HEAD. And `tsc --noEmit`, which skips tsconfig.app.json and
# with it tests/ ("Typecheck with npm run typecheck"): a tuple error in a test
# passed locally that way and failed CI. Exit 2 blocks the call and hands the
# message to Claude. A command that merely mentions either (grep, git log)
# passes.
command -v jq >/dev/null || exit 0
cmd=$(jq -r '.tool_input.command // ""')
if grep -qE '(^|[;&|(]|npx[[:space:]]+(-y[[:space:]]+)?|npm[[:space:]]+exec[[:space:]]+)[[:space:]]*prettier(@[^[:space:]]*)?([[:space:]]|$)' <<<"$cmd"; then
  echo "Blocked: this repository has no formatter on purpose – Prettier's defaults (double quotes, semicolons, 80 columns) rewrite every line of every file they touch. Match the surrounding code by hand: single quotes, no semicolons, trailing commas." >&2
  exit 2
fi
if grep -qE '(^|[;&|(]|npx[[:space:]]+)[[:space:]]*tsc([[:space:]][^;&|]*)?--noEmit' <<<"$cmd"; then
  echo "Blocked: typecheck with 'npm run typecheck' (tsc -b). The root tsconfig is solution-style, and the --noEmit shortcut skips tsconfig.app.json, which is what includes tests/." >&2
  exit 2
fi
exit 0
