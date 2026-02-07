# Plan: Remove legacy queue integration (#327)

## Goal

- Remove the legacy vault-backed integration so only GitHub + SQLite are required to run Ralph.
- Ensure the repo contains no references to the removed integration in code or docs.

## Product Guidance (canonical)

- GitHub issues/labels/comments are the operator UX + queue truth; SQLite is durable machine state (`docs/product/orchestration-contract.md`).
- Degraded mode applies to GitHub label *writes* (rate limits/abuse), not to missing GitHub auth.

## Assumptions

- GitHub queue backend is the default and the only supported backend.
- Legacy config keys may still exist in user config files; Ralph should ignore unknown keys best-effort and surface actionable errors only for required GitHub auth/config.

## Checklist

- [x] Inventory current references (code + docs) and define deletion set; track remaining count until zero.
- [x] Add/adjust focused tests that lock GitHub-only behavior before deleting modules (queue mode decisions, notify paths, daemon startup branches).
- [x] Refactor boundaries: split queue-mode policy (pure) from driver construction (I/O) and isolate optional artifact sinks.
- [x] Remove legacy queue backend driver and any filesystem/vault watching.
- [x] Remove legacy config keys/types/defaults and any vault layout checks; keep config parsing permissive for unknown keys.
- [x] Remove legacy notification + run-note artifact creation; keep GitHub writeback + SQLite alerts + desktop notifications.
- [x] Remove legacy escalation note tracking + auto-resume scheduler; ensure re-queue flows rely on GitHub command labels + SQLite op-state.
- [x] Update/replace tests that asserted legacy fallback/diagnostics.
- [x] Update docs/help text to remove mentions; keep operator guidance GitHub+SQLite-first.
- [x] Verify no legacy integration references remain.
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.

## Execution Steps

- [ ] Baseline: list all current legacy-integration references and capture the file list as the working deletion checklist.
- [ ] Queue-mode boundary refactor:
  - [ ] Extract a pure queue-mode decision helper (config + auth state + label-write health -> {backend, health, diagnostics}).
  - [ ] Keep driver construction in the I/O layer; remove legacy fallback branches only after tests cover GitHub auth-missing behavior.
- [ ] Artifact sink boundary refactor:
  - [ ] Introduce a narrow interface for optional “write run artifacts” behavior with a noop implementation.
  - [ ] Rewire `src/worker/repo-worker.ts` to depend on the interface, not on any legacy artifacts module.
- [ ] Notifications:
  - [ ] Refactor `src/notify.ts` to remove local note creation; keep GitHub escalation writeback + SQLite alerts + desktop notifications.
  - [ ] Remove task/escalation note resolution logic tied to local storage.
- [ ] Escalation/resume:
  - [ ] Remove `src/escalation-notes.ts` and `src/escalation-resume-scheduler.ts` usage from `src/index.ts`.
  - [ ] Ensure escalation guidance is captured on the GitHub escalation comment (consultant packet already attaches there).
  - [ ] Ensure re-queue via `ralph:cmd:queue` leads to a fresh attempt using SQLite op-state (session id/worktree pointers) without any vault dependency.
- [ ] Queue backend deletion:
  - [ ] Remove legacy queue driver module(s) and any exports/symbols referencing it.
  - [ ] Simplify `src/queue-backend.ts` to support only GitHub and disabled/no-queue.
- [ ] Config surface cleanup:
  - [ ] Remove legacy config keys and helpers from `src/config.ts` (types, defaults, validation).
  - [ ] Update status/diagnostics strings to remove legacy mention while keeping actionable guidance.
- [ ] Docs + CLI help text cleanup: remove references across `README.md`, docs, and inline CLI help.
- [ ] Tests:
  - [ ] Update/remove unit tests that cover legacy backend fallback and vault layouts.
  - [ ] Add/adjust tests for GitHub-only queue mode, escalation writeback path, and daemon startup paths (github vs none).
- [ ] Final verification: repository search must return zero legacy-integration matches.
