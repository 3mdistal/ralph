# Plan: Issue #604 - Canonical daemon registry + control root

Assumptions (non-interactive defaults):
- Canonical control root is `$HOME/.ralph/control` (profile-agnostic; does not depend on `XDG_STATE_HOME`).
- Canonical registry file is `$HOME/.ralph/control/daemon-registry.json`.
- Canonical registry is authoritative only when it is readable, schema-valid, and “fresh” by deterministic liveness rules; otherwise `ralphctl` falls back to legacy discovery.
- Legacy discovery remains supported during a defined migration window (documented + logged): `$XDG_STATE_HOME/ralph/daemon.json`, then `~/.local/state/ralph/daemon.json`, then `/tmp/ralph/<uid>/daemon.json`.

Deterministic validity/liveness rules (to implement + document):
- Registry schema versioned (`version: 1`); unknown versions are treated as invalid (fallback, not fatal).
- A registry record is considered “live” only if:
  - PID liveness probe succeeds, and
  - `heartbeatAt` is present and newer than `now - HEARTBEAT_TTL_MS`.
- Safety bias: if heartbeat is stale or missing, `ralphctl restart/upgrade` refuses to signal/kill unless `--force`.

Locking contract:
- Singleton daemon lock (held for daemon lifetime): `$HOME/.ralph/control/daemon.lock` (prevents two daemons writing competing control-plane state).
- Short-lived registry write lock (held only while writing/rotating files): `$HOME/.ralph/control/registry.lock`.
- Never hold locks while performing liveness probes, sleeps, or waiting loops.

## Plan checklist

- [x] Centralize path resolution in a pure module (`src/control-root.ts`)
- [x] Implement registry functional core vs IO shell
- [x] Implement atomic JSON write helper (temp + rename; best-effort fsync) and symlink-safe checks
- [x] Implement singleton daemon lock (stale-lock reclamation) and short-lived registry write lock
- [x] Update daemon startup/shutdown to:
  - acquire singleton lock
  - publish canonical registry (daemonId, pid, startedAt, ralphVersion, controlRoot, heartbeatAt)
  - run heartbeat timer updating `heartbeatAt` under registry write lock
  - remove/mark registry entry on shutdown
- [x] Update control file location to canonical root (`$HOME/.ralph/control/control.json`) with legacy import fallback
- [x] Update `ralphctl` discovery to be canonical-first-when-valid, legacy fallback when invalid/stale
- [x] Add/adjust tests:
  - canonical selection vs fallback when canonical invalid/corrupt
  - stale heartbeat handling + `--force` safety behavior
  - singleton lock prevents second daemon
  - profile-agnostic discovery (ambient `XDG_STATE_HOME` changes do not affect)
  - legacy window compatibility (no canonical file)
- [x] Update docs (README + relevant product docs) to document:
  - canonical root + files
  - liveness rules (PID + heartbeat TTL)
  - deterministic discovery precedence + migration window
- [x] Add lightweight observability: log discovery source (`canonical|legacy-xdg|legacy-home|legacy-tmp`) and invalid/stale reasons
- [x] Run `bun test` and `bun run typecheck`
