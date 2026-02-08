# Plan: Merge-Conflict Recovery Permission Denial + Misclassification (#626)

## Goal

- Merge-conflict recovery never writes to `/tmp` (or other external-directory paths) and instead uses repo/worktree-local paths.
- If OpenCode sandbox denies a path permission (e.g. `external_directory (/tmp/*)`), classify the failure explicitly and surface it in merge-conflict lane comments and escalation details.
- Prevent permission-denial from being misreported as a generic timeout waiting for updated PR state.
- Add regression tests for the permission-denied path in the merge-conflict recovery lane.

## Assumptions

- Default: treat `blocked:permission` as an internal cause code (not a stable public contract); keep reason strings short/bounded and sanitize paths.
- Since OpenCode can still emit explicit `/tmp/...` redirections, we will harden the merge-conflict prompt and also set `TMPDIR/TEMP/TMP` to a worktree-local directory for OpenCode runs.
- Canonical permission-denied formatter defaults:
  - `reason`: `OpenCode sandbox permission denied: external_directory access blocked.`
  - `details`: sanitized, bounded tail of raw output (same redaction/length policy used by escalation helpers).

## Checklist

- [x] Gather context (issue + canonical docs)
- [x] Locate merge-conflict recovery lane code paths
- [x] Avoid external temp paths for merge-conflict recovery (prompt + env)
- [x] Add permission-denial classification (`blocked:permission`) in OpenCode failure classifier
- [x] Add a functional-core outcome boundary + canonical reason formatter
- [x] Short-circuit merge-conflict recovery on permission denial via policy (no PR-state wait/timeout)
- [x] Surface permission denial reason via canonical formatter (comment + escalation)
- [x] Add regression tests for permission-denied merge-conflict recovery
- [x] Run verification gates (`bun test`, plus `bun run typecheck` if types changed)

## Steps

- [x] Gather context (issue + canonical docs)
- [x] Locate merge-conflict recovery lane code paths
  - [x] `src/worker/merge/conflict-recovery.ts`
  - [x] `src/worker/repo-worker.ts` (prompt construction)
  - [x] `src/merge-conflict-recovery.ts` (comment/details helpers)
  - [x] `src/opencode-error-classifier.ts` + blocked source plumbing

- [x] Avoid external temp paths for merge-conflict recovery (prompt + env)
  - [x] Update merge-conflict prompt in `src/worker/repo-worker.ts` to explicitly forbid `/tmp` and instruct using a worktree-local temp dir (e.g. `.ralph/tmp`).
  - [x] Set `TMPDIR`, `TEMP`, and `TMP` for OpenCode runs to a worktree-local path (e.g. `<repoPath>/.ralph/tmp`) in `src/session.ts` (create dir best-effort).

- [x] Add permission-denial classification (`blocked:permission`) in OpenCode failure classifier
  - [x] Add a new blocked source `permission` to `src/blocked-sources.ts`.
  - [x] Extend `classifyOpencodeFailure(...)` in `src/opencode-error-classifier.ts` to detect OpenCode sandbox denial output (case-insensitive):
    - [x] `permission requested: external_directory`
    - [x] `auto-rejecting`
    - [x] optionally `/tmp/` in the same sample for confidence.
  - [x] Add unit tests in `src/__tests__/opencode-error-classifier.test.ts`.

- [x] Add a functional-core outcome boundary + canonical reason formatter
  - [x] Introduce a small typed boundary for recovery attempt outcomes (e.g. `RecoveryAttemptResult`) that carries:
    - [x] `cause` (e.g. `permission-denied`, `opencode-config-invalid`, `unknown`, `timeout`)
    - [x] `blockedSource?` (internal, e.g. `permission`)
    - [x] `userReason` (bounded, sanitized; safe for comments/escalations)
    - [x] `details?` (bounded, sanitized; safe for escalation details)
  - [x] Add a pure policy helper `shouldWaitForMergeConflictSignals(cause)` and unit test it.
  - [x] Centralize reason rendering in one formatter used by both merge-conflict lane comments and escalation payloads.
  - [x] Use the exact permission-denied reason default: `OpenCode sandbox permission denied: external_directory access blocked.`
  - [x] Ensure raw OpenCode output is never interpolated directly; sanitize/map first.

- [x] Short-circuit merge-conflict recovery on permission denial via policy (no PR-state wait/timeout)
  - [x] In `src/worker/merge/conflict-recovery.ts`, after the OpenCode session returns, build a `RecoveryAttemptResult` from `sessionResult`.
  - [x] Use `shouldWaitForMergeConflictSignals(result.cause)` to decide whether to call `waitForMergeConflictRecoverySignals(...)`.
  - [x] For permission denial causes, return early with `blocked:permission` and the canonical reason (no PR-state waiting).

- [x] Surface permission denial reason via canonical formatter (comment + escalation)
  - [x] Ensure merge-conflict status comment uses the canonical formatter and includes a stable reason token/category for permission denial.
  - [x] Ensure merge-conflict escalation uses the same canonical formatter and includes bounded sanitized details.
  - [x] Ensure the permission denial path cannot be overwritten by the generic PR-state timeout reason.

- [x] Add regression tests for permission-denied merge-conflict recovery
  - [x] Add a focused test that stubs a merge-conflict recovery run where the OpenCode output includes `external_directory (/tmp/*)` denial and asserts:
    - [x] the returned failure is classified as `blocked:permission`
    - [x] the lane uses the canonical formatter (stable reason token/category) rather than raw sandbox log text
    - [x] `shouldWaitForMergeConflictSignals("permission-denied")` is false (unit test; avoid brittle call-order assertions)
  - [x] Add a small “prompt policy” test ensuring merge-conflict prompt contains the “no `/tmp`” clause and a worktree-local temp dir directive.
  - [x] Add a redaction/bounding test ensuring denial output that includes `/tmp/...` is sanitized and length-bounded before being used in escalation details.

- [x] Run verification gates
  - [x] `bun test` (targeted suites)
  - [x] `bun run typecheck`
