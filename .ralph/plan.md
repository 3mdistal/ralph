# Plan: Refactor RepoWorker pause control + checkpoint glue (#562)

## Goal

- Consolidate pause-control reads and checkpoint patch/persist glue into `src/worker/pause-control.ts`.
- Keep RepoWorker as an imperative shell with thin delegations; preserve seams `pauseIfHardThrottled` / `pauseIfGitHubRateLimited`.
- Preserve checkpoint/task-field semantics and any operator-visible contract surfaces.

## Assumptions

- This is an internal refactor; behavior/semantics must remain unchanged.
- PRs should target `bot/integration`.

## Checklist

- [x] Confirm current state (avoid redoing work)
- [x] Lock invariants (no behavior change)
- [x] Pause-control consolidation
- [x] Checkpoint glue consolidation
- [x] Tighten RepoWorker seams + call sites
- [x] Tests + verification gates
- [ ] Publish PR artifact

## Steps

- [x] Confirm current state (avoid redoing work)
  - [ ] Inspect whether `src/worker/pause-control.ts` already exists and owns: control snapshot reading + pause wait + checkpoint persistence glue.
  - [ ] Inspect whether `src/worker/repo-worker.ts` delegates pause-control reads + checkpoint recording to that module.
  - [ ] Compare against `bot/integration` (not just local cleanliness): confirm `git diff bot/integration...HEAD` is empty or contains only intended refactor.
  - [ ] If everything is already on the base branch and tests pass, treat this task as “already satisfied” and move to the PR/closure path (no new refactor).

- [x] Lock invariants (no behavior change)
  - [ ] Write down the invariants to preserve (and keep them stable through the refactor):
    - [ ] Task-field contract: `checkpoint`, `checkpoint-seq`, `pause-requested`, `paused-at-checkpoint` names + meanings.
    - [ ] Checkpoint sequencing: each `recordCheckpoint` advances `checkpoint-seq` monotonically (+1 per applied checkpoint runtime).
    - [ ] Persistence ordering: successful `updateTaskStatus` -> `applyTaskPatch` mirrors the same patch; failures never mutate in-memory task fields.
    - [ ] Emission guarantee: checkpoint reached event emits even if persistence fails (including `updateTaskStatus=false` or throw).
    - [ ] Pause-wait semantics: `waitForPauseCleared` returns when pause clears, and respects abort (returns early on abort).
  - [ ] Add seam-level characterization tests so cross-lane consumers stay stable:
    - [ ] Minimal tests for RepoWorker wrapper return contracts (e.g. `pauseIfHardThrottled` / `pauseIfGitHubRateLimited` still return `AgentRun | null`).
    - [ ] Ensure merge/CI remediation callers still compile against the same seam surface.

- [x] Pause-control consolidation (`src/worker/pause-control.ts`)
  - [ ] Provide `createPauseControl(...)` that reads the control state snapshot and normalizes `pauseRequested` + `pauseAtCheckpoint`.
  - [ ] Provide `waitForPauseCleared(...)` with bounded backoff and abort support.
  - [ ] Ensure dependency injection keeps this module testable (sleep/jitter/log overrides).
  - [ ] Keep internal boundaries explicit to avoid a long-lived god module:
    - [ ] Snapshot adapter (control-state -> normalized pause snapshot)
    - [ ] Waiter (backoff/jitter/abort loop)

- [x] Checkpoint glue consolidation (`src/worker/pause-control.ts`)
  - [ ] Provide `recordCheckpoint(...)` that:
    - [ ] Builds checkpoint state from task fields.
    - [ ] Persists checkpoint patches via `updateTaskStatus(...)` and mirrors them into memory via `applyTaskPatch(...)`.
    - [ ] Calls the checkpoint runtime (`applyCheckpointReached`) with pause source + emitter.
  - [ ] Keep task-field names and semantics unchanged (`checkpoint`, `checkpoint-seq`, `pause-requested`, `paused-at-checkpoint`).
  - [ ] Keep internal boundaries explicit:
    - [ ] State mapping (task fields -> `CheckpointState`)
    - [ ] Persistence adapter (build patch + persist + mirror)
    - [ ] Runtime bridge (apply + pauseSource + emitter)

- [x] Tighten RepoWorker seams + call sites (`src/worker/repo-worker.ts`)
  - [ ] Keep `pauseIfHardThrottled` / `pauseIfGitHubRateLimited` as RepoWorker wrapper/seam methods.
  - [ ] Replace any remaining direct control/checkpoint glue in RepoWorker with delegations (where it improves clarity without changing behavior).
  - [ ] Ensure any cross-lane consumers (e.g. merge/CI remediation) still receive the same seam surface.

- [x] Tests + verification gates
  - [ ] Ensure unit tests cover:
    - [ ] pause snapshot validation (checkpoint validation)
    - [ ] pause-clear waiting/backoff
    - [ ] pause-clear abort matrix (already-aborted, aborted during backoff, clears naturally)
    - [ ] checkpoint patch persistence preserves task status
    - [ ] checkpoint event emission even when persistence fails
    - [ ] checkpoint persistence failure modes: `updateTaskStatus=false` and `updateTaskStatus` throws
  - [ ] Run gates: `bun test`, `bun run typecheck`, `bun run knip`.

- [ ] Publish PR artifact
  - [ ] If there are code changes: create branch + commit(s).
  - [ ] Push branch and open PR targeting `bot/integration`.
  - [ ] PR body includes: rationale, risk notes (contract-surface preserved), test commands run, and `Fixes #562`.
