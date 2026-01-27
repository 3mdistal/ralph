# state.sqlite policy

`~/.ralph/state.sqlite` is Ralph's internal durable store for operational metadata (sessions, worktrees, cursors).

## Migration policy

- Forward-only, additive migrations on startup.
- Bump `SCHEMA_VERSION` in `src/state.ts` for each change.
- Apply migrations inside a single transaction.
- No downgrades. If `meta.schema_version` is newer than the running binary, fail closed.
- Safe reset: deleting `state.sqlite` recreates a fresh database on next startup.

## Daemon reliability

- Ralph enables SQLite WAL mode with normal sync (`PRAGMA journal_mode=WAL`, `PRAGMA synchronous=NORMAL`).
- Foreign keys are enforced (`PRAGMA foreign_keys=ON`).
- A busy timeout is set to avoid transient lock failures during concurrent reads/writes (`PRAGMA busy_timeout=5000`).
