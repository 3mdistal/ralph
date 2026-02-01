# Parent verification lane

When dependency or sub-issue blockers clear, queued parent issues can be runnable but already satisfied. The parent verification lane is a lightweight pre-implementation check that confirms whether any work remains before entering the full plan/build pipeline.

## Trigger (deterministic)

Run parent verification when a task transitions from `blocked` (source `deps`) to unblocked and is still queued/runnable. The transition is detected in the blocked-state sync loop. Label reads are best-effort; if labels are unavailable, rely on the local queued state.

## Ordering

If an issue has a mergeable open PR that already closes the issue, reconcile that first. Only run parent verification when no mergeable PR resolves the issue.

## Output contract

The verifier must emit a last-line marker:

`RALPH_PARENT_VERIFY: {"version":1,"work_remains":true|false,"reason":"..."}`

## Outcomes

- `work_remains=true`: record outcome and proceed to the normal implementation pipeline.
- `work_remains=false`: record outcome and escalate with a "close or clarify" summary.

## Failure handling

- Bounded attempts with backoff.
- After max attempts, record `skipped` and proceed to implementation (verification is an optimization, not a blocker).
- Degraded mode (label writes/reads unavailable) must not block the lane.
