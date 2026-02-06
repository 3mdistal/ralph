# state.sqlite policy

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

`~/.ralph/state.sqlite` is Ralph's internal durable store for operational metadata (sessions, worktrees, cursors, run records).

It also stores deterministic gate state for each run (`ralph_run_gate_results`) and bounded, redacted artifacts (`ralph_run_gate_artifacts`).

## Migration policy

- Forward-only, additive migrations on startup.
- Bump `SCHEMA_VERSION` in `src/state.ts` for each change.
- Apply migrations inside a single transaction.
- No downgrades. If `meta.schema_version` is newer than the running binary, fail closed.
- Safe reset: deleting `state.sqlite` recreates a fresh database on next startup.

## Startup compatibility behavior

- If `meta.schema_version` is older than the binary schema, Ralph migrates forward on startup.
- If `meta.schema_version` is newer than the binary schema, Ralph refuses startup with an actionable message:
  - upgrade Ralph to a compatible/newer binary, or
  - perform safe reset by deleting `~/.ralph/state.sqlite` (local durable state loss).

## Preflight and backup knobs

- Before running migrations, Ralph runs `PRAGMA integrity_check`.
- Optional backup snapshot before migration (SQLite-safe, `VACUUM INTO`):
  - `RALPH_STATE_DB_BACKUP_BEFORE_MIGRATE=1`
  - optional output dir override: `RALPH_STATE_DB_BACKUP_DIR=/path/to/backups`
- Migration lock timeout override (milliseconds):
  - `RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS=3000`

## Rollout runbook

1. Drain/stop daemon(s) touching the target `state.sqlite`.
2. Upgrade Ralph binary.
3. Restart Ralph and allow startup preflight + migration to complete.
4. Resume normal processing.

Rollback caveat:

- After schema migration, older Ralph binaries may refuse startup (no downgrades). To recover to an older binary, restore a compatible DB backup or perform safe reset.

## Claims

Canonical claims live in `claims/canonical.jsonl`.
