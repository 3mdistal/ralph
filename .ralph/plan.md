# Plan: Canonical Daemon Registry + Control Root (#604)

Assumptions:
- Canonical control artifacts must be profile-agnostic (must not depend on ambient `XDG_*` / OpenCode profile selection).
- Maintain backwards compatibility by continuing to *read* legacy locations and (for a transition period) *write* legacy daemon discovery records.
- Prefer safety over cleverness for stale lock recovery: never steal a lock from a live PID by default.

## Checklist

- [x] Inventory current discovery/control paths and map *all* call sites (`src/index.ts`, `src/ralphctl.ts`, `src/drain.ts`, `src/control-file.ts`, `src/commands/status.ts`).
- [x] Introduce a single canonical resolver API and route all call sites through it:
      - `src/control-root.ts` (pure): canonical root + legacy candidate generation
      - `src/daemon-record.ts`: schema parse/validate + lock-protected IO + singleton lock
      - `src/drain.ts`: resolve effective `control.json` path (daemon-advertised first, then canonical, then legacy)
- [x] Define canonical control root (default: `~/.ralph/control`) and canonical file names:
      - daemon registry: `daemon-registry.json`
      - control file: `control.json`
      - locks: `daemon.lock` (singleton, held for lifetime) and `daemon-registry.lock` (short-lived write lock)
- [x] Implement daemon registry schema v1 with strict parsing + validation:
      - required: daemonId, pid, startedAt, heartbeatAt, controlRoot, ralphVersion
      - optional/additive: command, cwd, controlFilePath
- [x] Implement lock semantics with ownership tokens (nonce) to avoid unsafe cleanup:
      - lock file payload includes daemonId, pid, startedAt, acquiredAt, token
      - only the owning process (matching token) may release/cleanup in normal shutdown
      - stale lock recovery requires pid-not-alive (never steal from a live pid by default)
- [x] Implement crash-safe, lock-protected registry writes as a read-modify-write transaction under lock (write temp + rename).
- [x] Fix monitor/read consistency: ensure `DrainMonitor.reloadNow` and `readControlStateSnapshot` use the same effective control-path resolver (no direct `resolveControlFilePath(...)` bypass).
- [x] Update daemon startup/shutdown (`src/index.ts`) to:
      - create canonical control root (0700)
      - acquire singleton lock (`daemon.lock`) or fail-fast with actionable error
      - write initial registry record + start heartbeat ticker
      - dual-write legacy daemon record during transition (so older tooling can still discover)
      - release only when token matches; best-effort cleanup on shutdown
- [x] Update `ralphctl` to read canonical registry first (then legacy fallbacks), and emit deterministic diagnostics listing candidate paths + why they were rejected (missing/invalid/stale/pid-dead).
- [x] Update docs/help text to state canonical path + fallback behavior (`README.md`, `src/cli.ts`, `src/index.ts`, and any referenced docs that mention `$XDG_STATE_HOME/ralph/*`).
- [x] Tests:
      - Core/selection: candidate ordering and canonical-precedence coverage in daemon-record tests
      - IO/fs: canonical control path behavior + fallback behavior in drain/control-file tests
      - Avoid wall-clock sleeps: inject clock/tickers where possible
- [x] Run `bun test` and fix regressions.
