---
name: commit
description: Commits the working tree the way this repository does – the sweep, the checks, the house register – and pushes when asked, pulling first because the nightly data refresh commits to main. Use when the user asks to commit or push ("Committe", "Commit und push", "Pushe main", "Prüfe … und dann committe"), never on your own initiative.
argument-hint: "[push]"
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git branch *) Bash(git add *) Bash(git commit *)
---

# Commit

## The state at invocation

- Branch: !`git branch --show-current`
- Changes: !`git status --short -uall`
- Size: !`git diff HEAD --shortstat`
- The register to match – the last commits a person wrote, not the nightly bot's:

!`git log -3 --perl-regexp --author='^((?!github-actions).*)$' --format='=== %s%n%n%b'`

## Steps

1. **Review, when asked.** If the request asks for the changes to be checked as
   well ("Prüfe … und dann committe", "ob sie den Regeln entsprechen"), run the
   `decisions-reviewer` agent first, fix what it finds, and say what it found.

2. **Sweep.** Follow "A change is not finished when the code works" in
   PROJECT-PLAN-DECISIONS.md for every name, flag, constant, URL key and number
   the diff touches: the README's tables and tree, both i18n tables (the `de`
   table is the usual miss), the site pages' prose, comments elsewhere that
   quote an old value, the tests, and PROJECT-PLAN-DECISIONS.md itself when the
   change settles or alters something it records. Say what the sweep changed,
   or that it found nothing to change.

3. **Check.** `npm run typecheck` and `npm test`. The six parity scripts
   (`node scripts/test-*.mjs`, the list in ci.yml) when `server/api/` or a
   TypeScript twin changed. The e2e specs the change touches
   (`npx playwright test e2e/<spec>`), not the whole suite unless asked. On a
   failure, stop and report: the nightly run deploys `main` on the unit tests
   alone, so a red push goes out with the next data commit.

4. **Commit.** One commit per logical change; when the tree holds several,
   split them and say how. Stage paths by name, never `git add -A`. Files under
   `src/cities/*/` from a local pipeline run go in a commit of their own, with
   the service day in its message, never in a file. The message is English
   whatever language the conversation is in, written like the register above:
   - the subject an imperative sentence saying what the change does for the map
     or the project, not which file changed, without a full stop;
   - the body prose paragraphs that explain why – what was seen and where,
     what caused it, what was measured, what was tried and dropped, what pins
     it now – with real names and numbers, no bullet lists;
   - closed by the Co-Authored-By trailer for the model in use.

5. **Push only when asked** (`push` in the arguments, or the request says so).
   `git pull --rebase origin main` first: the nightly data refresh commits to
   `main` most nights. Then `git push origin main`. On a rebase conflict, stop
   and report it rather than resolving data files by hand.

Report the commit hashes and subjects, and whether the push went through.
