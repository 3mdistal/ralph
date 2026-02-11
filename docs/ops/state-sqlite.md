# state.sqlite policy

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-07

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

## Degraded control-plane behavior

- Daemon startup behavior remains fail-closed for forward-incompatible schemas (no downgrades).
- `ralphctl` lifecycle operations (`status`, `drain`, `restart`, `stop`) are designed to remain usable even when durable state is unavailable or forward-incompatible.
- In degraded mode, `ralphctl status` returns minimal control-plane visibility (daemon/control/queue shape) and surfaces explicit durable-state diagnostics.
- Recovery guidance order remains: upgrade to a compatible/newer Ralph binary first; use safe reset (`~/.ralph/state.sqlite`) only as a last resort when local durable state loss is acceptable.

## Startup schema invariants

- Startup verifies required schema shape for critical tables in addition to `meta.schema_version`.
- Current invariants include `ralph_run_gate_results.reason` and required gate indexes used by latest-run lookups.
- Additive drift is repaired automatically under migration lock/transaction boundaries (idempotent `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`).
- Non-additive or incompatible drift fails closed with explicit diagnostics (table/index name, incompatibility, and operator recovery guidance).

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

Schema drift recovery:

1. If startup reports a schema invariant failure, stop all Ralph processes touching the DB.
2. Restart with the latest binary once to allow additive repair.
3. If failure persists, inspect for incompatible objects (for example, a view where a table is expected).
4. Restore from backup or perform safe reset (`~/.ralph/state.sqlite`) when local durable state can be recreated.

Rollback caveat:

- After schema migration, older Ralph binaries may refuse startup (no downgrades). To recover to an older binary, restore a compatible DB backup or perform safe reset.

## Claims

Canonical claims live in `claims/canonical.jsonl`.
