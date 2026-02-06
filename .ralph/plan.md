# Plan: Harden state.sqlite schema upgrades (#593)

## Goal

- Make `~/.ralph/state.sqlite` schema upgrades deterministic and resilient: migrate older schemas forward safely, and refuse newer schemas with an actionable operator message (no startup crash requiring source edits).

## Assumptions

- Preserve canonical policy: forward-only, additive migrations; no downgrades; fail closed when DB schema is newer than the running binary.
- Optimize for daemon availability and low operator interrupt surface; prefer bounded, actionable failure messages.

## Checklist

- [x] Audit current state DB initialization and migrations (`src/state.ts`) and identify all non-idempotent migration steps.
- [x] Introduce a migration boundary (functional core + imperative shell):
  - Core: compute migration plan and compatibility decisions from a schema snapshot.
  - IO: lock acquisition, pragmas, transaction control, statement execution, and deterministic errors.
- [x] Add explicit migration metadata (current schema version + supported min/max) and centralize version compatibility checks.
- [x] Implement a single-writer migration lock:
  - Acquire a write lock up front (`BEGIN IMMEDIATE`-style) with a bounded `busy_timeout`.
  - Ensure concurrent startups either wait or deterministically refuse (no double-run/corruption).
- [x] Make migrations transactional and idempotent:
  - Replace "blind" `ALTER TABLE ... ADD COLUMN` with column-exists checks (or safe, targeted handling).
  - Ensure re-running migrations after an interrupted attempt succeeds.
- [x] Add migration preflight checks before applying migrations:
  - Run `PRAGMA integrity_check` (bounded) when a migration is required.
  - Add an opt-in backup snapshot of `state.sqlite` before migrating using a SQLite-safe mechanism (no raw file copy under WAL).
- [x] Improve startup behavior for schema mismatch:
  - If DB schema is newer than binary: fail closed with an actionable message (upgrade binary; safe reset guidance).
  - Ensure the error is surfaced deterministically (no generic stack trace crash).
- [x] Add upgrade-path tests:
  - N-1 -> N migration coverage.
  - Interrupted/partial migration recovery.
  - Concurrency/locking behavior (bounded) to prevent double migration.
- [x] Update ops runbook docs for safe rollout (drain -> migrate/preflight -> restart -> resume) and rollback caveats.
- [x] Run CI-equivalent verification locally: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.
