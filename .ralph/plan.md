# Plan: ralphctl profile-agnostic daemon discovery (#607)

## Goal

- `ralphctl status|drain|resume` discovers the live daemon independent of the caller's ambient profile/XDG.
- PID liveness is validated before reporting a running daemon or signaling it.
- Stale daemon registry records are auto-healed (or flagged) with actionable, deterministic output.

## Context / Dependency

- Blocked by `3mdistal/ralph#604` (canonical control root + daemon registry).

## Assumptions

- Canonical control root is independent of OpenCode profile selection (see claims: `daemon.control-root.canonical`, `profiles.selection-not-identity`).
- `ralphctl status --json` output is treated as contract surface; changes must be additive and stable.
- `ralphctl status` remains read-only by default (no implicit repairs); repair happens only in writeful subcommands.
- Multiple live daemons should fail closed (do not pick one implicitly).

## Checklist

- [ ] Land canonical control root resolution (consume #604 output)
- [x] Implement daemon discovery (functional core + imperative shell)
- [x] Enforce PID-liveness-gated reporting and control operations
- [x] Implement safe stale-record auto-heal + deterministic messaging
- [x] Add PID reuse safety checks before signaling
- [ ] Add targeted tests for cross-profile/env variance + CLI contract
- [x] Run verification gates (`bun test`, `bun run typecheck`, `bun run build`, `bun run knip`)

## Steps

- [ ] Land canonical control root resolution (consume #604 output)
  - [x] Define canonical control root path resolver (likely under `~/.ralph/`), used by both daemon and `ralphctl`.
  - [ ] Ensure daemon registry (`daemon.json`) and control file (`control.json`) live under the canonical root.
  - [ ] Update any help text that hard-codes legacy XDG paths (e.g. `src/cli.ts`, `src/index.ts`).

- [x] Implement daemon discovery (functional core + imperative shell)
  - [x] Add a pure core classifier (e.g. `src/daemon-discovery/core.ts`) that takes:
    - [x] candidate records (path + parse status + record)
    - [x] liveness/identity probe results
    - [x] a policy object (canonical-first, migration allowed, heal allowed)
    - [x] and returns `{ result, healPlan }`.
  - [x] Add an imperative shell (e.g. `src/daemon-discovery/fs.ts`) responsible for:
    - [x] enumerating candidate paths (canonical + legacy)
    - [x] reading/parsing records
    - [x] probing PID liveness and (best-effort) process identity
    - [x] executing the `healPlan` (rename/migrate) idempotently.
  - [x] Public API (e.g. `src/daemon-discovery/index.ts`) returns a discriminated result:
    - [x] `live` (one live PID, with record + source path)
    - [x] `missing` (no records)
    - [x] `stale` (records exist but none live; include paths + why)
    - [x] `conflict` (multiple live PIDs; include details)
  - [x] Discovery order: canonical registry first, then legacy candidates (current XDG_STATE_HOME-derived path(s), `~/.local/state`, `/tmp/ralph/<uid>`).
  - [x] Validate PID liveness with `process.kill(pid, 0)` equivalent before returning `live`.
  - [x] If a live legacy record is found and canonical is missing, migrate by writing canonical copy (best-effort) while continuing to honor the record's `controlFilePath`.
  - [x] Healing policy:
    - [x] `status`: report-only (no fs writes)
    - [x] `drain|resume|restart|upgrade`: allow safe heal/migration (rename stale, migrate live legacy)

- [x] Enforce PID-liveness-gated reporting and control operations
  - [x] Update `src/commands/status.ts` to use daemon discovery; only populate `snapshot.daemon` when discovery is `live`.
  - [x] Add additive `daemonDiscovery` diagnostics to status JSON (or equivalent) so stale/conflict states are machine-visible without parsing text.
  - [x] Update `src/ralphctl.ts`:
    - [x] `status`: if stale/conflict, print a clear one-liner and avoid implying the daemon is running.
    - [x] `drain`/`resume`: only SIGUSR1 the PID when discovery is `live`; otherwise print actionable output.
    - [x] `restart`/`upgrade`: refuse to stop/signal unless `live` or `--force` is provided; still allow restart using last-known command when only stale records exist.
  - [ ] Pin exit-code behavior with tests:
    - [ ] keep `status` exit=0 in all cases
    - [ ] `drain|resume` exit=0 when request is written; exit=1 only for conflicts or safety refusals (unless `--force`)

- [x] Implement safe stale-record auto-heal + deterministic messaging
  - [x] For dead-PID records in canonical location: remove or rename to a bounded `.stale-*` file (safe default: rename).
  - [x] For legacy dead-PID records: rename to `.stale-*` (avoid destructive deletes outside canonical root).
  - [x] Ensure auto-heal is idempotent and does not spam output; prefer a single summary line.

- [x] Add PID reuse safety checks before signaling
  - [x] Add a best-effort process identity probe (platform-dependent):
    - [x] Linux: read `/proc/<pid>/cmdline`
    - [x] fallback: spawn `ps -p <pid> -o command=`
  - [x] Require the probed command line to match an expected signature derived from the record (e.g. contains `ralph`/`src/index.ts` or the recorded `command` tokens) before sending signals.
  - [x] If identity cannot be verified, refuse to signal unless `--force`.

- [ ] Add targeted tests for cross-profile/env variance + CLI contract
  - [x] Add `src/__tests__/daemon-discovery.test.ts` covering:
    - [x] multiple live records fail closed as conflict
    - [x] dead PID record is treated as stale/missing and is auto-healed
    - [x] live legacy record is found when ambient XDG differs and is migrated to canonical
    - [x] multiple live records returns conflict (fail closed)
  - [x] Add/adjust a status test to assert `snapshot.daemon` is null when only dead-PID records exist.
  - [ ] Add `src/__tests__/ralphctl-discovery-contract.test.ts` to pin:
    - [ ] `ralphctl status --json` additive keys + `daemon=null` for stale
    - [ ] deterministic one-line human output for `stale/conflict`
    - [ ] exit code behavior for conflicts/safety refusals

- [x] Run verification gates
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run build`
  - [x] `bun run knip`
