# Plan: Fix queued/blocked GitHub label parity drift (#598)

## Goal

- Enforce deterministic convergence: no issue is labeled `ralph:status:queued` on GitHub while local state classifies it as `blocked`.
- Preserve the single-status invariant: on a successful reconciliation pass, exactly one `ralph:status:*` label is present.
- Add a regression test (and minimal diagnostics) so parity drift is visible and prevented in CI.

## Product Guidance (authoritative for this task)

- Per issue comment from @3mdistal: run a bounded fresh retry targeting a concrete fix; if no PR is produced, stop retrying and mark blocked with reason `no-pr-after-retry`; reconcile labels to match local state before exit; post a final summary comment with counts before/after parity check.

## Key Assumption (chosen to avoid sticky states)

- Map local `blocked` (dependency-blocked / non-runnable) to GitHub `ralph:status:in-progress`.
  - Rationale: `in-progress` explicitly includes “waiting on deterministic gates”; dependency-blocked is “waiting”, and this avoids `paused`/`escalated` semantics that can require explicit operator action.
  - This satisfies “no `ralph:status:queued` while locally blocked” without introducing a new GitHub-visible `blocked` status.

## Checklist

- [x] Identify current drift path and update label convergence mapping for `blocked`.
- [x] Update/extend label reconciler to enforce the new mapping (and remain idempotent under backoff).
- [x] Add regression tests covering `blocked` label delta and reconcile behavior.
- [x] Add minimal operator-visible diagnostics (log or status output) for queued-label/local-blocked drift.
- [x] Update docs only if the chosen mapping needs clarification (no doc change required).
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.

## Steps

- [x] Change `statusToRalphLabelDelta("blocked", ...)` in `src/github-queue/core.ts` to converge to `ralph:status:in-progress` (remove `queued`/`paused`/`escalated`/etc; add `in-progress` if absent).
- [x] Ensure the async reconciler tick in `src/github/label-reconciler.ts` uses this mapping so drift self-heals after restart.
- [x] Update unit tests in `src/__tests__/github-queue-core.test.ts` that currently assert “blocked preserves queued label”.
- [x] Add a focused test to validate the invariant: when local is `blocked`, the desired label set is not `ralph:status:queued` (and is `ralph:status:in-progress`).
- [x] Add a small diagnostic counter/log line (e.g. in label reconciler) reporting how many locally-blocked tasks were observed with `ralph:status:queued` before reconciliation.
- [x] (Optional) fast reconcile trigger after `markTaskBlocked(...)` / `markTaskUnblocked(...)` was not needed after this fix.
