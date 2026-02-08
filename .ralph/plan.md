---
# Plan: Deprecate and remove bwrb (GitHub + SQLite) (#323)

## Product intent

- Stop using bwrb/Obsidian notes as part of Ralph's core state + control loop.
- Target model:
  - GitHub issues/labels/comments = operator interface + shared state
  - SQLite (local) = canonical machine state (runs/tasks/events/alerts) + pointers to artifacts
  - Optional JSONL trace files referenced from SQLite

Policy (immediate): bwrb is legacy output-only (best-effort mirror). No new features should depend on bwrb.

## Current status (as of 2026-02-08)

- Child issues #324, #325, #326 are closed.
- Child issue #327 implementation is now complete in this worktree:
  - Removed repo artifacts `.bwrb/schema.json`, `.bwrbignore`, and `.gitignore` bwrb rules.
  - Removed legacy `bwrbVault` fixture keys from affected tests.
  - Added a tracked-file regression guard script and wired it into `npm test`.

## Done criteria (epic)

- Operator control is exclusively via GitHub (`ralph:cmd:*`, `ralph:status:*`, `ralph:priority:*` labels + normal comments).
- Canonical machine state is exclusively in `~/.ralph/state.sqlite` (runs/tasks/events/alerts + artifact pointers).
- bwrb is not required to run Ralph.
- No in-repo references to bwrb remain (code/tests/docs), except historical notes in closed GitHub issues.

## Checklist (execute in order)

- [x] Verify child #324 complete (freeze + deprecation; output-only posture)
- [x] Verify child #325 complete (replace bwrb notify paths with SQLite + GitHub pointers)
- [x] Verify child #326 complete (priority/status controls via GitHub labels + SQLite)

- [x] Complete child #327: remove remaining bwrb artifacts + strings

- [x] Baseline tracked-file search (deterministic)
  - `git grep -nI -E 'bwrb|bwrbVault' -- . ':(exclude).ralph/plan.md'` (capture current hits)

- [x] Remove bwrb repo artifacts
  - Delete `.bwrb/` (including `.bwrb/schema.json`) and `.bwrbignore`
  - Update `.gitignore` to remove `.bwrb/*` rules/comments and any exception allowing `.bwrb/schema.json`

- [x] Remove `bwrbVault` from test fixtures (mechanical across all matches)
  - Known touchpoints (not exhaustive):
    - `src/__tests__/queue-backend.test.ts`
    - `src/__tests__/sandbox-config.test.ts`
    - `src/__tests__/github-client-auth.test.ts`
    - `src/__tests__/gh-runner-env.test.ts`
    - `src/__tests__/allowlist-guardrail.test.ts`
    - `src/__tests__/github-app-auth.test.ts`
    - `src/__tests__/integration-harness.test.ts`
    - `src/__tests__/merge-pull-request-api.test.ts`
    - (and any remaining `src/__tests__/*.test.ts` matches)

- [x] Add a regression guard that fails if tracked code/docs/tests reintroduce bwrb tokens
  - Implement as a small script driven by `git ls-files` + token scan and wire into preflight (preferred over unit tests that depend on `.git` internals)
  - Exclusions should be explicit and minimal (e.g. allow `.ralph/plan.md`)

- [x] Final tracked-file search (deterministic)
  - `git grep -nI -E 'bwrb|bwrbVault' -- . ':(exclude).ralph/plan.md'` returns no matches

- [ ] Run deterministic gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`
  - `bun run typecheck` passed.
  - `bun run build` passed.
  - `bun test` currently fails in existing pre-existing suites (`dist/__tests__/opencode-fixtures.test.js`, `dist/__tests__/required-checks.test.js`).
  - `bun run knip` currently fails with broad pre-existing unused-file/export reports.
