# state.sqlite policy

`~/.ralph/state.sqlite` is Ralph's internal durable store for operational metadata (sessions, worktrees, cursors).

It also stores deterministic gate state for each run (`ralph_run_gate_results`) and bounded, redacted artifacts (`ralph_run_gate_artifacts`).

## Migration policy

- Forward-only, additive migrations on startup.
- Bump `SCHEMA_VERSION` in `src/state.ts` for each change.
- Apply migrations inside a single transaction.
- No downgrades. If `meta.schema_version` is newer than the running binary, fail closed.
- Safe reset: deleting `state.sqlite` recreates a fresh database on next startup.
