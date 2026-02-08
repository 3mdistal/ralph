# Plan: #605 `ralphctl doctor`

Goal: add a stable `ralphctl doctor` audit surface for stale discovery/control records, with an explicit, safe, non-destructive repair mode and machine-readable JSON output.

Assumptions (based on existing implementation on `feat/605-ralphctl-doctor` + product plan review):
- CLI v1: `ralphctl doctor [--json] [--repair|--apply] [--dry-run]`
- Exit codes: `0` iff overall_status==`ok`; `1` if any warn/error findings remain; `2` for usage errors and unexpected internal failures.
- JSON schema is versioned and additive-only for v1: `schema_version: 1`.
- Repair mode is opt-in and non-destructive only (no deletes): quarantine via rename-with-suffix; promote live legacy record without overwriting an existing canonical record.

## Checklist

- [x] Inspect existing branch `feat/605-ralphctl-doctor` and confirm scope is already implemented (doctor core + repairs + unit tests) so we only add missing CLI contract coverage + any contract-alignment fixes.
- [x] Lock down v1 contract in code/tests:
  - [x] `--json` prints exactly one JSON object to stdout (no extra text)
  - [x] exit-code matrix is deterministic (0/1/2)
  - [x] `schema_version: 1` and required top-level fields are always present

- [x] Test isolation hardening (to avoid flake/leakage in CI and parallel Bun runs):
  - [ ] Use `acquireGlobalTestLock` from `src/__tests__/helpers/test-lock.ts` around CLI spawn tests (HOME/XDG/env are process-global).
  - [x] Spawn `ralphctl` with an isolated env that sets at least:
    - [x] `HOME` (temp dir)
    - [x] `XDG_STATE_HOME` (temp dir) to avoid legacy-path bleed
    - [x] `RALPH_STATE_DB_PATH`, `RALPH_SESSIONS_DIR`, `RALPH_WORKTREES_DIR` (temp dirs) defensively (even if doctor doesn’t use them)
  - [x] Restore/cleanup in `finally` and `afterEach` to prevent cross-test contamination.

- [x] Add explicit CLI-level contract tests (spawn `bun src/ralphctl.ts doctor ...`):
  - [x] `src/__tests__/ralphctl-doctor-cli.test.ts`
  - [x] Implement a small CLI harness helper in the test file:
    - [x] `runRalphctl(args, env)` uses `spawnSync(process.execPath, ["src/ralphctl.ts", ...args])` for portability
    - [x] `assertDoctorJsonV1(payload)` validates required fields/types only (additive schema tolerant)
  - [x] Fixture: clean/ok state -> exit 0
  - [x] Fixture: stale daemon record + missing canonical control -> exit 1, findings include stale
  - [x] Unknown arg/flag -> exit 2 (and no JSON output)
  - [x] Unexpected internal failure -> exit 2 (deterministic): add a test-only fault hook in the doctor CLI path (env-gated) and assert stdout is not partial/invalid JSON.

- [x] Add repair safety + idempotence CLI tests (filesystem fixtures):
  - [x] No `--repair`: no mutation; `applied_repairs` empty
  - [x] `--repair --dry-run`: no mutation; repairs recorded as `skipped`
  - [x] `--repair` applies only safe actions; quarantine renames the record file with a backup suffix
  - [x] Repeat `--repair` is idempotent (no additional mutations / no extra `*.stale-*` files)
  - [x] Live-daemon guard: never quarantine a record whose PID is live (use a real long-lived child process PID for determinism)
  - [x] Prove "no mutation" by snapshotting directory entries + file contents (hash or exact string) before/after for audit-only and dry-run cases.

- [x] Align implementation to the contract where needed:
  - [x] Ensure unexpected errors in doctor invocation return exit 2 (not 1)
  - [x] Ensure promote-to-canonical repair is no-overwrite + idempotent:
    - [x] If canonical record exists and matches the live legacy record, treat as already satisfied and `skip`
    - [x] If canonical exists but differs, `skip` with an explicit needs-human reason (no overwrite)

- [x] Documentation touch-up:
  - [x] `README.md`: add/confirm `ralphctl doctor` usage + contract notes (exit codes, `--json` schema_version v1, repair safety)

- [ ] Preflight locally:
  - [ ] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run build`
  - [x] `bun run knip`
