# Plan: Add `ralphctl doctor` for stale discovery/control record repair (#605)

## Goal

- Provide an operator command (`ralphctl doctor`) that audits daemon discovery + control-plane artifacts across known roots.
- Default is non-destructive: report findings + recommended actions.
- Optional explicit repair mode applies safe, idempotent fixes.
- Support machine-readable JSON output for CI/ops automation.

## Key Inputs

- Issue: `https://github.com/3mdistal/ralph/issues/605`
- Dependency chain:
  - `#605` blocked by `#607` (profile-agnostic discovery + PID liveness)
  - `#607` blocked by `#604` (canonical control root + authoritative registry)

## Assumptions (explicit defaults)

- Dry-run by default; repair only with `--apply`.
- Doctor never kills or starts daemons.
- Doctor does not change operational intent (does not change `control.json` mode). It may create missing discovery/registry records when explicitly applying repairs.
- If multiple live daemons are detected, doctor fails closed (collision) and only recommends manual intervention.
- PID liveness is tri-state:
  - `alive`: `process.kill(pid, 0)` succeeds
  - `dead`: throws `ESRCH`
  - `unknown`: throws `EPERM` or non-standard errors
  - Doctor must not quarantine/overwrite records based on `unknown` liveness.
- Exit codes are automation-friendly and deterministic:
  - `0`: `result=healthy` OR `result=repaired`
  - `2`: `result=needs_repair` (dry-run)
  - `3`: `result=collision` OR any apply-mode partial failures
  - `1`: `result=error` (fatal audit error)

## Output Contract (JSON v1)

- `ralphctl doctor --json` prints JSON only to stdout.
- Shape (versioned):
  - `version: 1`
  - `result: "healthy"|"needs_repair"|"repaired"|"collision"|"error"`
  - `canonicalRoot: string | null`
  - `searchedRoots: string[]`
  - `records: Array<{ kind: "registry"|"daemon.json"|"control.json"; path: string; status: "live"|"stale"|"unreadable"|"missing"|"invalid"; details?: {...} }>`
  - `findings: Array<{ code: string; severity: "info"|"warning"|"error"; message: string; recordPath?: string }>`
  - `actions: Array<{ kind: "write"|"copy"|"move"|"quarantine"; from?: string; to?: string; ok: boolean; error?: string; preconditions?: {...} }>`
  - `warnings: string[]`

## Checklist

- [x] Reconcile dependency surfaces from `#604` + `#607` (canonical root + registry, profile-agnostic discovery)
- [x] Implement functional-core analysis + action planning (IO-free, unit-testable)
- [x] Implement imperative-shell IO (root scan, safe reads, TOCTOU-safe apply)
- [x] Keep boundaries tight (ralphctl routes only; doctor in dedicated modules)
- [x] Wire into `src/ralphctl.ts` (`doctor` command + help/flags)
- [x] Add high-signal tests for stale/mismatch/collision cases
- [x] Update docs (`README.md`) with usage + exit codes + JSON note
- [x] Run verification gates (`bun test`, `bun run typecheck`, `bun run build`, `bun run knip`)

## Steps

- [x] Added dedicated doctor modules:
  - [x] `src/commands/doctor/collect.ts`
  - [x] `src/commands/doctor/core.ts`
  - [x] `src/commands/doctor/execute.ts`
  - [x] `src/commands/doctor/render.ts`
  - [x] `src/commands/doctor/index.ts`
- [x] Implemented root scanning across canonical + legacy + profile `xdgStateHome` roots.
- [x] Implemented tri-state PID liveness (`alive|dead|unknown`) and collision detection.
- [x] Implemented non-destructive default planning plus explicit `--apply` execution.
- [x] Implemented TOCTOU precondition checks for apply actions (mtime/size drift checks).
- [x] Added `ralphctl doctor` command integration (`--json`, `--apply`, `--verbose`, `--root`).
- [x] Added JSON v1 report with `findings`, `actions`, `warnings`, and deterministic result states.
- [x] Added tests:
  - [x] `src/__tests__/doctor-core.test.ts`
  - [x] `src/__tests__/doctor-execute.test.ts`
- [x] Updated docs in `README.md` with command usage and exit codes.
- [x] Verification gates completed:
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run build`
  - [x] `bun run knip`

Implementation note: until `#604` lands a separate canonical registry artifact, doctor treats canonical `daemon.json` as the authoritative registry surface for audit/repair.
