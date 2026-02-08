# Plan: Merge-conflict repeated-signature grace retry (Issue #627)

- [x] Read issue context + relevant product/policy docs.
- [x] Locate current merge-conflict recovery code + unit tests.

## Implementation

- [x] Extend persisted merge-conflict attempt model to include a failure class (additive): `merge-content | permission | tooling | runtime | unknown`.
- [x] Centralize failure classification in a single helper (called from all failure branches).
- [x] Populate `failureClass` and a short bounded `failureReason` when a merge-conflict attempt fails.
- [x] Make merge-conflict comment-state JSON safe for HTML-comment transport (escape `<`/`>` and bound any new strings) so state parsing cannot be corrupted.
- [x] Update `computeMergeConflictDecision` with explicit precedence:
      - `maxAttempts` remains a hard cap (always stop when exhausted)
      - repeated-signature loop prevention applies immediately for `merge-content|unknown`
      - repeated signature after `permission|tooling|runtime` gets exactly one signature-scoped grace retry
      - repeated signature after grace is exhausted stops
- [x] Add a small machine-readable decision code (e.g. `repeat_merge_content`, `repeat_grace_exhausted`, `attempts_exhausted`) and derive human text from it.
- [x] Update stop/escalation reason text to explicitly distinguish loop prevention vs grace exhausted.

## Tests

- [x] Update/add unit tests in `src/__tests__/merge-conflict-recovery.test.ts`:
      - repeated signature after `runtime/tooling/permission` allows one grace retry
      - repeated signature after grace exhausted stops
      - repeated signature after `merge-content` stops immediately
      - legacy attempts with no class preserve current stop behavior
- [x] Add round-trip parse/serialize tests for merge-conflict comment-state with new fields + tricky characters.

## Verification (local)

- [x] `bun test`
- [x] `bun run typecheck`
- [x] `bun run build`
- [x] `bun run knip`
