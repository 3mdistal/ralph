# Plan: #606 Startup safety (singleton daemon lock)

Assumptions
- Runtime is Bun/Node on Linux in daemon mode; implement best-effort identity checks on Linux via `/proc`.
- Canonical control root is HOME-based XDG default `~/.local/state/ralph` (profile-agnostic), per issue guidance.

## Checklist

- [x] Introduce a single control-plane paths module (no duplicated path logic):
  - [x] `resolveCanonicalControlRoot()` -> HOME-based `~/.local/state/ralph` (fallback `/tmp/ralph/<uid>` only when HOME unavailable).
  - [x] Typed accessors: `control.json`, `daemon.json`, `daemon.lock.d` under canonical root.
- [x] Update control-plane artifacts to be profile-agnostic (writers use canonical root):
  - [x] `control.json` read/write uses canonical root.
  - [x] `daemon.json` write uses canonical root.
  - [x] `ralphctl`/status/drain/control-file helpers discover daemon via canonical root.
  - [x] Transitional discovery window: readers also probe legacy locations (prior `XDG_STATE_HOME/ralph/*` + `/tmp/ralph/<uid>/*`) to find pre-upgrade daemons.
  - [x] Update user-facing help text/README notes that still advertise per-profile `XDG_STATE_HOME` fallbacks for control-plane files.

- [x] Implement singleton daemon startup lock under canonical root:
  - [x] Lock location: `~/.local/state/ralph/daemon.lock.d/` with `owner.json`.
  - [x] Acquisition: atomic `mkdir` (exclusive); on `EEXIST`, load `owner.json` and run health check.
  - [x] Health check (PID-only insufficient):
    - [x] `kill(pid, 0)` liveness check.
    - [x] Best-effort identity check: on Linux, record and compare `/proc/<pid>/stat` start-time identity (ticks). Do not rely on wall-clock-only `startedAt`.
    - [x] Parser hardening: handle `/proc/<pid>/stat` names with spaces/parentheses.
    - [x] Optional sanity-check: `/proc/<pid>/cmdline` contains `ralph` (never used to auto-delete; at most upgrades to "unknown/healthy").
  - [x] Stale recovery: auto-remove lock only when health check definitively fails (PID dead or start identity mismatch).
  - [x] Ambiguous identity: if PID alive but identity cannot be verified, treat as healthy/unknown; refuse to start and do not delete lock.
  - [x] Handle startup race: if lock dir exists but `owner.json` is missing/partial, retry with small bounded backoff before classifying as ambiguous.
  - [x] UX: stable non-zero exit for “already running” (use `2`), single-paragraph message including `pid`, `startedAt`, lock path, and suggesting `ralphctl status` / `ralphctl drain`.
  - [x] Release: remove lock on graceful shutdown, and also via `finally` on any startup failure after acquisition.

- [x] Wire lock into daemon startup early (before writing control records / starting workers); ensure failure exits quickly and cleanly.

- [x] Tests (Bun):
  - [x] Second daemon blocked when first is healthy (lock held + identity verified).
  - [x] Stale lock removed and startup proceeds when PID dead.
  - [x] Stale lock removed and startup proceeds when PID alive but start identity mismatch.
  - [x] Ambiguous liveness refuses start and preserves existing lock.
  - [x] Race: lock dir exists but `owner.json` not yet written -> bounded retry then proceed/refuse deterministically.
  - [x] Regression tests for canonical control root behavior (profile flips do not affect control-plane paths).

- [x] Run local preflight: `bun test`.
