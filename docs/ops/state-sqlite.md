# state.sqlite policy

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-11

`~/.ralph/state.sqlite` is Ralph's internal durable store for operational metadata (sessions, worktrees, cursors, run records).

It also stores deterministic gate state for each run (`ralph_run_gate_results`) and bounded, redacted artifacts (`ralph_run_gate_artifacts`).

## Migration policy

- Forward-only, additive migrations on startup.
- Bump `SCHEMA_VERSION` in `src/state.ts` for each change.
- Apply migrations inside a single transaction.
- Use version-stepped migration checkpoints with recorded checksum metadata.
- No downgrades. Writable operations are blocked when `meta.schema_version` is newer than the binary's writable window.

## Compatibility capability window

Ralph defines an explicit durable-state compatibility window shared by daemon startup, `ralphctl`, and status snapshots:

- `minReadableSchema`
- `maxReadableSchema`
- `maxWritableSchema`

Capability flags are published alongside verdicts:

- `canReadState`
- `canWriteState`
- `requiresMigration`

Verdicts are typed and stable:

- `readable_writable`
- `readable_readonly_forward_newer`
- `unreadable_forward_incompatible`
- `unreadable_invariant_failure`

Forward-newer durable state is allowed in read-only mode when:

- `schemaVersion > maxWritableSchema`
- and `schemaVersion <= maxReadableSchema`

If `schemaVersion > maxReadableSchema`, Ralph fails closed.

Operational contract:

- `status`: allowed when `canReadState=true`.
- `restart`: allowed only via deterministic safe path; no unsafe durable-state writes when `canWriteState=false`.
- Mutation/write paths: require `canWriteState=true`; otherwise block with explicit diagnostics and migration guidance.

## Startup compatibility behavior

- If `meta.schema_version` is older than the binary schema, Ralph migrates forward on startup.
- If `meta.schema_version` is newer than the writable window, daemon startup refuses writable initialization with an actionable message:
  - upgrade Ralph to a compatible/newer binary, or
  - restore a compatible `state.sqlite` backup.

## Degraded control-plane behavior

- Daemon startup behavior remains fail-closed for forward-incompatible schemas (no downgrades).
- `ralphctl` lifecycle operations (`status`, `drain`, `restart`, `stop`) are designed to remain usable even when durable state is unavailable, forward-incompatible, or readable-only.
- In degraded mode, `ralphctl status` returns minimal control-plane visibility (daemon/control/queue shape) and surfaces explicit durable-state diagnostics.
- Recovery guidance order remains: upgrade to a compatible/newer Ralph binary first; then restore from a compatible backup when needed.

## Startup schema invariants

- Startup verifies required schema shape for critical tables in addition to `meta.schema_version`.
- Current invariants include `ralph_run_gate_results.reason` and required gate indexes used by latest-run lookups.
- Additive drift is repaired automatically under migration lock/transaction boundaries (idempotent `ALTER TABLE ... ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`).
- Non-additive or incompatible drift fails closed with explicit diagnostics (table/index name, incompatibility, and operator recovery guidance).

## Preflight and backup behavior

- Before running migrations, Ralph runs `PRAGMA integrity_check`.
- Backup snapshot before schema/invariant mutation (SQLite-safe, `VACUUM INTO`) is automatic.
- Backup integrity is validated before migration proceeds (`PRAGMA integrity_check` on the backup).
- Optional output dir override: `RALPH_STATE_DB_BACKUP_DIR=/path/to/backups`
- Migration lock timeout override (milliseconds):
  - `RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS=3000`
- Readonly durable-state probe timeout override (milliseconds):
  - `RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS=250`

## Zero-loss upgrade playbook (command-by-command)

Assumptions:

- Ralph state path is `~/.ralph/state.sqlite`.
- Control-plane commands are run from the target host/profile.

1. Capture pre-upgrade control-plane state.
   - `ralphctl status --json > /tmp/ralph-status.before.json`
2. Request a graceful drain intent before touching binaries.
   - `ralphctl drain --timeout 10m`
3. Wait for queue quiescence (or operator timeout policy), while preserving lifecycle visibility.
   - `ralphctl status --json`
4. Stop/restart into the new binary.
   - `ralphctl restart --grace 10m`
   - or `ralphctl upgrade --grace 10m --upgrade-cmd "<your package upgrade command>"`
5. Verify post-upgrade durable-state capability and migration verdict.
   - `ralphctl status --json > /tmp/ralph-status.after.json`
   - Expect `durableState.ok=true` and `durableState.canWriteState=true` for normal operation.
6. Resume normal scheduling after verification.
   - `ralphctl resume`

Zero-loss invariants:

- Drain intent is persisted in control state even if no live daemon PID is found.
- Mixed-version readable-only windows remain observable in `status` output.
- Migration lock prevents concurrent schema transitions.
- Recovery path order is deterministic: upgrade-first, then restore-from-backup if still incompatible.

Schema drift recovery:

1. If startup reports a schema invariant failure, stop all Ralph processes touching the DB.
2. Restart with the latest binary once to allow additive repair.
3. If failure persists, inspect for incompatible objects (for example, a view where a table is expected).
4. Restore from a compatible backup and restart with a compatible/newer binary.

Rollback caveat:

- After schema migration, older Ralph binaries may refuse startup (no downgrades). To recover to an older binary, restore a compatible DB backup.

## Mixed-version validation matrix

CI coverage includes representative mixed-version lifecycle scenarios:

- old daemon state -> newer ctl (`status` auto-migrates prior schema and remains writable)
- newer daemon state -> older ctl (`status` remains readable-only when schema is forward-newer but within readable window)
- interrupted migration resume (`status` reports lock-timeout degraded capability during contention, then resumes/migrates once lock clears)
- pending drain + migration (`drain` intent remains visible while `status` migrates old schema)

Relevant tests:

- `src/__tests__/ralphctl-status-cli.test.ts`
- `src/__tests__/state-sqlite.test.ts`
- `src/__tests__/status-command-degraded.test.ts`
- `src/__tests__/status-cli-degraded.test.ts`

## Claims

Canonical claims live in `claims/canonical.jsonl`.
