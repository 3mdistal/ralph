---
# Plan: Deprecate and remove bwrb (GitHub + SQLite) (#323)

## Goal

- Stop using bwrb/Obsidian notes as part of Ralph's core state + control loop.
- Target model:
  - GitHub issues/labels/comments = operator interface + shared state
  - SQLite (local) = canonical machine state (runs/tasks/events/alerts) + pointers to artifacts
  - Optional JSONL trace files referenced from SQLite

## Policy (immediate)

- bwrb is legacy output-only (best-effort mirror). No new features should depend on bwrb.

## Done (acceptance)

- Operator control is exclusively via GitHub (`ralph:cmd:*`, `ralph:status:*`, `ralph:priority:*` labels + normal comments).
- Canonical machine state is exclusively in `~/.ralph/state.sqlite` (runs/tasks/events/alerts + artifact pointers).
- Notifications/alerts are operator-visible via GitHub with clear pointers back to SQLite/artifacts.
- bwrb is not required to run Ralph.
- No runtime behavior depends on bwrb (no vault required; no bwrb subprocess calls; no bwrb-backed control plane).
- Long-term end state: remove bwrb references from repo code/docs entirely (except historical notes in closed GitHub issues).

## Assumptions

- Child work is authoritative; do not redo closed child issues.
- Degraded GitHub label writes remain best-effort; orchestration continues safely from SQLite truth and reconciles later (`docs/product/orchestration-contract.md`).
- SQLite migration policy remains forward-only, transactional, fail-closed on newer schema (`docs/ops/state-sqlite.md`).

## Checklist

- [x] Verify child #324 complete (freeze + deprecation; output-only posture)
- [x] Verify child #325 complete (replace bwrb notify paths with SQLite + GitHub pointers)
- [x] Verify child #326 complete (priority/status controls via GitHub labels + SQLite)
- [ ] Complete child #327 (remove bwrb integration + delete remaining codepaths)
- [x] Preserve contract surfaces while removing runtime dependency (config + status output)
- [ ] Remove remaining bwrb references (code + canonical docs) after compatibility window
- [x] Run deterministic gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`

## Execution Plan (remaining work)

- [ ] Close out #327 in two phases (avoid big-bang breakage)
  - [x] Phase 1: remove *runtime dependency* on bwrb while preserving contracts
    - [x] Config compatibility shim: legacy `queueBackend="bwrb"` maps deterministically to `github` (if auth configured) else `none`; legacy `bwrbVault` is ignored (no startup failure)
    - [ ] Add a config-resolution matrix test (auth present/absent; explicit/implicit backend) and snapshot expected backend + warning diagnostics
    - [ ] Extract bwrb-shaped identifiers out of core types
      - [ ] Introduce a backend-agnostic task identity (repo + issue number) and stop requiring `_path`/`_name` in core flows
      - [ ] Move any bwrb path/name normalization behind a thin adapter module (functional-core stays bwrb-free)
    - [x] Replace any remaining operator-visible escalation/notification behavior that currently depends on bwrb artifacts/notes with GitHub + SQLite pointers
    - [x] Add contract tests for `status --json` / queue backend state to prevent output drift
    - [x] Add config migration tests (legacy config still boots; no vault required)
    - [ ] Add a regression guard that fails if runtime code shells out to `bwrb` (focused unit test around the runner, or a static scan in tests)
    - [ ] Add one degraded-mode integration test: GitHub label writes blocked -> SQLite remains authoritative -> reconciliation converges when unblocked
  - [ ] Phase 2: delete codepaths and docs
    - [x] Delete `src/bwrb/**` and remove bwrb subprocess calls
    - [x] Remove bwrb queue backend implementation and any vault layout checks
    - [x] Remove bwrb-only tests/fixtures and update snapshots
    - [ ] Update canonical docs and README to remove bwrb setup/control-plane references (at minimum: `README.md`, `docs/product/*`, `docs/ops/*`)
    - [ ] File a follow-up issue to remove the legacy config shim and remaining `bwrb` tokens after a bounded compatibility window

- [ ] Verification
  - [ ] Smoke: Ralph starts and reports queue backend health without requiring any vault directory
  - [x] Legacy config smoke: `queueBackend="bwrb"` does not crash; resolves to GitHub/none deterministically
  - [x] No bwrb subprocess calls remain (no `bwrb ...` invocations)
  - [ ] Scoped reference check:
    - [ ] No bwrb references in canonical/operator docs and README
    - [ ] Track remaining `bwrb` tokens in code as compatibility-only; remove in follow-up if required
  - [x] Run full preflight gate commands (`bun test`, `bun run typecheck`, `bun run build`, `bun run knip`)
