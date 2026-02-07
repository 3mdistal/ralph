# Plan: Refactor RepoWorker orchestration into start/resume lanes (#564)

## Goal

- Shrink `src/worker/repo-worker.ts` by moving the high-level start/resume flow orchestration into lane modules.
- Keep `RepoWorker.processTask` (start-like) and `RepoWorker.resumeTask` as stable entrypoints / monkeypatch seams.
- Preserve behavior (queue/label semantics, pause/throttle behavior, escalation logic, PR reuse/merge flow).

## Product Constraints (canonical)

- Preserve GitHub operator contract surfaces (labels, queue semantics) per `docs/product/orchestration-contract.md`.
- Keep deterministic gates green: `bun test`, `bun run typecheck`, `bun run knip`.

## Assumptions

- Repo reality: “startTask” in this epic corresponds to `RepoWorker.processTask` (tests and call sites use `processTask`).
- Lane modules follow existing patterns in `src/worker/lanes/pause.ts` and `src/worker/lanes/parent-verification.ts`: explicit `*LaneDeps` type + deps passed from `RepoWorker` (so tests can keep monkeypatching via `(worker as any)` and prototype overrides).

## Checklist

- [x] Add lane module for start flow: `src/worker/lanes/start.ts`.
- [x] Add lane module for resume flow: `src/worker/lanes/resume.ts`.
- [x] Refactor `src/worker/repo-worker.ts` so `processTask` delegates to the start lane.
- [x] Refactor `src/worker/repo-worker.ts` so `resumeTask` delegates to the resume lane.
- [x] Preserve monkeypatch seams by routing all side effects through injected deps (RepoWorker methods/ports), not direct imports that bypass seams.
- [ ] Add parity tests for lane delegation (start + resume) and a seam-override regression test.
- [ ] Enforce lane boundary: lanes perform I/O only via injected deps (no direct side-effect imports).
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run knip`.

## Steps

- [x] Map the current `processTask` flow into major groups (preflight/allowlist/issue-open check; opencode profile + throttles; parent verification; label/protection bootstrap; worktree setup; planner + dossier; routing + devex consult + escalation; build; PR extraction + retries/anomaly loop; required-checks/merge lanes; finalize).
- [ ] Define lane boundary rule up-front:
  - [ ] `src/worker/lanes/start.ts` and `src/worker/lanes/resume.ts` may only call `deps` + local pure helpers; all side effects go through injected functions (preserves `(worker as any)` monkeypatch seams).
  - [ ] Prefer grouping deps into sub-ports (`session`, `taskState`, `github`, `merge`, `notify`, `telemetry`) to avoid a single mega-interface.
- [x] Implement `src/worker/lanes/start.ts`:
  - [x] Define `StartLaneDeps` containing all values/functions currently accessed via `this` inside `processTask`.
  - [x] Export `runStartLane(deps, task, opts)` (or equivalent) that contains the orchestrator logic.
  - [x] Keep internal helpers inside the lane file for readability (no behavior change).
- [ ] Extract shared "PR extraction / anomaly loop / PR recovery" logic into a helper used by both start and resume lanes (avoid duplicating the riskiest control-flow).
- [x] Update `RepoWorker.processTask` to be a thin wrapper that constructs deps from `this` (bound methods + required fields) and returns `runStartLane(...)`.
- [x] Implement `src/worker/lanes/resume.ts`:
  - [x] Define `ResumeLaneDeps` for everything currently accessed via `this` inside `resumeTask`.
  - [x] Export `runResumeLane(deps, task, opts)`.
- [x] Update `RepoWorker.resumeTask` to be a thin wrapper that constructs deps and returns `runResumeLane(...)`.
- [x] Ensure stage strings, checkpoint writes, and logging remain stable (avoid changing event names / run-log stage labels unless unavoidable).
- [ ] Add targeted tests before relying on repo gates:
  - [ ] Start lane delegation: a representative `processTask` test asserts key transitions still occur and that a monkeypatched method is invoked via deps (seam regression guard).
  - [ ] Resume lane parity: add a mocked orchestration test that covers a "resume happy path" and one key recovery path (e.g. missing session-id -> failed, or merge-conflict preflight sentinel).
  - [ ] Lane boundary guard: add a small test or lint check ensuring the new lane modules do not import known side-effect modules directly (deps-only I/O).
- [x] Run and fix gates:
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run knip`
