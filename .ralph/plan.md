# Plan: Fix Escalation Misclassification After PR-Create Retries (#600)

## Goal

- When PR creation retries fail (or repeatedly emit hard failure signals), escalate with the dominant underlying failure reason.
- Use `Agent completed but did not create a PR after N continue attempts` only as a fallback when there is no stronger signal.
- Keep escalation surfaces aligned: GitHub escalation comment reason, notify alert reason, and returned run metadata use the same reason string.

## Assumptions

- RepoWorker already has a deterministic hard-failure classifier: `src/opencode-error-classifier.ts` (`classifyOpencodeFailure`).
- This change is internal and should not introduce new contract surfaces; keep reason strings short/bounded and avoid local paths.
- Do not change escalation marker/idempotency semantics unnecessarily (escalationType affects marker id).

## Checklist

- [x] Confirm current behavior + repro path
- [x] Factor shared functional-core helpers (reason derivation + evidence aggregation)
- [x] Keep escalation writeback/notify/run metadata aligned on the same reason
- [x] Add regression test (continueSession retries with hard failure output)
- [x] Add focused unit tests for reason derivation helper
- [ ] Unify build/resume PR-create retry loops to eliminate drift
- [x] Add resume-path integration coverage for classification-vs-fallback behavior
- [x] (Optional) Propagate machine-stable `blockedSource` in internal metadata for this escalation
- [x] Run verification gates (`bun test`, plus `bun run typecheck` if touched types)

## Steps

- [x] Confirm current behavior + repro path
  - [x] Inspect the two PR-create retry loops in `src/worker/repo-worker.ts` (build path and resume path).
  - [x] Verify current escalation uses the no-PR-after-retries reason even when `buildResult.output` contains hard-failure signals.

- [x] Factor shared functional-core helpers (reason derivation + evidence aggregation)
  - [x] Add a small IO-free helper module (e.g. `src/worker/pr-create-escalation-reason.ts`) that:
    - [x] accepts accumulated evidence strings + attempt count
    - [x] returns `{ reason, details?, classification? }`
    - [x] uses `classifyOpencodeFailure(...)` deterministically
    - [x] keeps the classified `reason` exactly `classification.reason` (no suffixes)
  - [x] Keep output bounded (cap details length) and avoid embedding local paths in returned strings.

- [ ] Unify build/resume PR-create retry loops to eliminate drift
  - [ ] Extract a single helper for the missing-PR retry/recovery flow used by both build and resume, with a typed return to avoid silent behavior drift.
  - [ ] Keep stage-specific differences limited to labels/log strings (e.g. "build" vs "resume" run log paths) and pass them in explicitly.
  - [ ] Ensure both flows share:
    - [ ] evidence aggregation
    - [ ] lease behavior
    - [ ] retry counter semantics
    - [ ] final escalation envelope (`reason`, `details`, `planOutput`, `sessionId`)

- [x] Add dominant failure classification to PR-create retry escalation (build + resume paths)
  - [x] During PR-create retries, capture/aggregate continue outputs (even when `success=true`).
  - [x] Apply `classifyOpencodeFailure(...)` to accumulated evidence (initial build output + all continue outputs).
  - [x] Compute a single `reason`:
    - [x] If classification exists: use `classification.reason` as the headline reason.
    - [x] Else: use the existing fallback `Agent completed but did not create a PR after N continue attempts`.
  - [x] Keep classified `reason` stable: do not append attempt counts/excerpts to it.
  - [x] Optionally include attempt count + short excerpt in `details` (bounded/sanitized); avoid local file paths.
  - [x] Apply the same logic in both duplicated sites (around ~5445 and ~6715).

- [x] Keep escalation writeback/notify/run metadata aligned on the same reason
  - [x] Ensure the computed `reason` is passed consistently to:
    - [x] `writeEscalationWriteback(task, { reason, ... })`
    - [x] `notify.notifyEscalation({ reason, ... })`
    - [x] `recordEscalatedRunNote({ reason, ... })`
    - [x] the returned `{ escalationReason: reason }`.

- [x] Add regression test (continueSession retries with hard failure output)
  - [x] Extend `src/__tests__/integration-harness.test.ts` with a case where `continueSession` returns no PR URL for 5 attempts and outputs:
    - [x] `Invalid schema for function '...': ...` + `code: invalid_function_parameters`.
  - [x] Assert the run escalates with reason containing the classifier headline (e.g. `OpenCode config invalid: tool schema rejected ...`).
  - [x] Assert `writeEscalationWriteback` and `notifyEscalation` receive the same `reason` (no fallback string).

- [x] Add focused unit tests for reason derivation helper
  - [x] Add `src/__tests__/pr-create-escalation-reason.test.ts` covering:
    - [x] classification wins over no-PR fallback
    - [x] fallback used only when classifier returns null
    - [x] accumulated evidence (classification present only in a later continue output still wins)

- [x] Add resume-path integration coverage for classification-vs-fallback behavior
  - [x] Add/extend an integration-harness test that exercises the resume path (pre-set `session-id`) with 5 continue attempts returning the invalid tool schema output.
  - [x] Assert both the returned `AgentRun.escalationReason` and the escalation writeback/notify `reason` match the classifier headline (not the no-PR fallback).

- [x] (Optional) Propagate machine-stable `blockedSource` in internal metadata for this escalation
  - [x] If a classifier hit occurs, attach `classification.blockedSource` to the internal run note / missing-pr evidence record so operators can group failures without parsing strings.
  - [x] Do not change the human-facing `reason` string format.

- [x] Run verification gates
  - [x] `bun test`
  - [x] `bun run typecheck`
