
# Plan: Refactor RepoWorker orchestration into lane modules (#564)

## Goal

- Reduce size/risk of `src/worker/repo-worker.ts` by moving high-level start/resume orchestration into lane modules.
- Preserve monkeypatch seams: keep `RepoWorker.startTask` and `RepoWorker.resumeTask` as the stable entrypoints.
- Keep behavior identical (ordering/side effects) while making future lane work safer.

## Assumptions

- Internal refactor only; no contract-surface changes.
- Scheduler/tests currently call `RepoWorker.processTask` for “start”; keep it as a backwards-compatible alias.
- Do not change attempt-kind strings passed into `withRunContext(...)` (e.g. keep using the existing `"process"`/`"resume"` kinds) to avoid metrics/state drift.

## Checklist

- [x] Add lane modules `src/worker/lanes/start.ts` and `src/worker/lanes/resume.ts`
- [x] Add `RepoWorker.startTask` entrypoint delegating to the start lane module
- [x] Keep `RepoWorker.processTask` as a thin alias to `startTask` for scheduler/test compatibility
- [x] Refactor `RepoWorker.resumeTask` to delegate to the resume lane module
- [x] Preserve existing orchestration behavior by delegating to extracted orchestration methods
- [x] Ensure `bun test`, `bun run typecheck`, `bun run knip` pass

## Steps

- [x] Add lane module shims for start and resume orchestration entrypoints.
- [x] Introduce `RepoWorker.startTask(...)` and route it through the start lane module.
- [x] Convert existing `processTask(...)` to a thin compatibility alias calling `startTask(...)`.
- [x] Route `RepoWorker.resumeTask(...)` through the resume lane module.
- [x] Keep existing implementation logic in `startTaskOrchestration(...)` and `resumeTaskOrchestration(...)` to preserve behavior while extracting entrypoint orchestration.
- [x] Run verification gates:
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run knip`
