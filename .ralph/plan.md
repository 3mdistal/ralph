# Plan: Fix queue/in-progress label flapping for open PR wait (#599)

## Goal

- Stop queued <-> in-progress label thrash for long-lived open PRs with no actionable work.
- Make open-PR waiting state explicit and durable so stale sweep and label reconciliation converge.

## Checklist

- [x] Add durable open-PR wait op-state (`waiting-on-pr`) and map it to stable status label behavior.
- [x] Gate stale in-progress sweep so intentional open-PR wait is not re-queued.
- [x] Remove passive ad-hoc in-progress writes for open-PR reuse paths; park as waiting-on-pr instead.
- [x] Add anti-flap transition guard in label reconciler (memory + durable timestamp payload).
- [x] Add/extend regression tests for no-flap, operator override, closed-PR recovery, and duplicate-write suppression.
- [x] Run verification (`bun run typecheck`, targeted tests, `bun test`, `bun run knip`).
- [ ] Create PR targeting `bot/integration`.
