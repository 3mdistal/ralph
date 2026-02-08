# Plan: Fix Daemon Liveness False-Positive In Status (#632)

## Goal

- Fail closed: never report `mode=running` when daemon liveness cannot be confirmed.
- Surface an explicit mismatch signal + remediation hint in both JSON and human output.
- Lock the regression with tests covering `mode=running` + `daemon=null` + no process.

## Assumptions

- “Daemon liveness” is established via `daemon.json` + PID probe (`process.kill(pid, 0)`).
- If PID probes error (e.g. EPERM), treat liveness as unconfirmed and fail closed.
- This is a contract surface: `ralphctl status --json` and `ralph status --json` are machine-readable.

## Checklist

- [x] Centralize daemon liveness logic (single core + single PID probe adapter)
- [x] Make status JSON contract additive: keep `desiredMode`, add `daemonLiveness`, set `mode` to effective fail-closed value
- [x] Eliminate status snapshot assembly drift (`getStatusSnapshot` vs `runStatusCommand`)
- [x] Print explicit liveness mismatch + remediation hint via a shared formatter
- [x] Add regression + decision-table tests (missing record, dead PID, unknown/EPERM)
- [x] Run verification gates (`bun test`, `bun run typecheck`)

## Steps

- [x] Centralize daemon liveness logic
  - [x] Add `src/daemon-liveness.ts` with a functional-core + imperative-shell split:
    - [x] Core: `deriveDaemonLiveness({ desiredMode, hasRecord, pidProbe }) -> { state, mismatch, hint, effectiveMode }`
    - [x] Shell: `probePid(pid) -> alive|dead|unknown` (map EPERM and unexpected errors to `unknown`)
  - [x] Add a shared human formatter (e.g. `formatDaemonLivenessLine(...)`) so `ralph status` and `ralphctl status` never drift.

- [x] Additive status JSON contract + fail-closed `mode`
  - [x] Extend `src/status-snapshot.ts`:
    - [x] Add `desiredMode` (current pre-liveness mode string)
    - [x] Add `daemonLiveness` (state/mismatch/hint/pid/daemonId as appropriate)
    - [x] Optionally tighten types: define a `StatusMode` union and a `DaemonLivenessState` union.
  - [x] In `src/commands/status.ts` compute desired vs effective mode:
    - [x] `desiredMode`: existing gate/throttle logic
    - [x] `daemonLiveness`: from `readDaemonRecord()` + `probePid`
    - [x] `mode`: set to `effectiveMode` from liveness core; ensure it is never `running` when liveness is missing/dead/unknown.
  - [x] Compatibility note (in-code, not docs): consumers should treat unknown `mode` strings as not-running; prefer `daemonLiveness.mismatch` for health.

- [x] Eliminate status snapshot assembly drift
  - [x] Refactor `src/commands/status.ts` so there is one base snapshot builder shared by:
    - [x] `getStatusSnapshot()` (used by `ralphctl` and dashboard)
    - [x] `runStatusCommand()` (CLI)
  - [x] Keep optional enrichments (usage rows, token totals) as a post-step applied to the base snapshot rather than duplicating core fields.

- [x] Human output includes mismatch + remediation hint
  - [x] In `src/commands/status.ts` non-JSON path, print exactly one liveness line when `daemonLiveness.state !== "alive"` or `daemonLiveness.mismatch`.
  - [x] In `src/ralphctl.ts` status (non-JSON), print the same line using the shared formatter.

- [x] Regression tests
  - [x] Add pure decision-table tests for `deriveDaemonLiveness` (fast, deterministic):
    - [x] desired running + missing record => effective non-running + mismatch + hint
    - [x] desired running + dead pid => effective non-running + mismatch + hint
    - [x] desired running + unknown pid probe (EPERM) => effective non-running + mismatch + hint
    - [x] desired paused/draining + missing/dead => no “running” claim; mismatch behavior is explicit and stable
  - [x] Add command-level regression tests `src/__tests__/status-daemon-liveness.test.ts`:
    - [x] Fixture: control defaults to running and no live daemon can be confirmed => JSON `mode !== "running"`, `desiredMode === "running"`, `daemonLiveness.state` is non-`alive`.
    - [x] Fixture: `daemon.json` with non-existent PID => JSON `mode !== "running"`, `daemonLiveness.state === "dead"`.
    - [x] Assert `daemonLiveness.hint` is bounded and does not include absolute paths.

- [x] Verification gates
  - [x] `bun test`
  - [x] `bun run typecheck`
