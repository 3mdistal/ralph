# Plan: #598 queued/blocked label parity drift

Assumptions (daemon-safe defaults):
- Treat issue acceptance criteria as authoritative for this task.
- Keep GitHub as the operator queue surface, but ensure a task that is locally `blocked` is never labeled `ralph:status:queued`.

## Checklist

- [x] Read current label reconciliation + queue/state projection flows to identify why local `blocked` could retain GitHub `ralph:status:queued`.
- [x] Make blocked label projection explicit (named constant), and change blocked projection to non-queued status label.
- [x] Change `blocked` -> GitHub label mapping to remove `ralph:status:queued` by projecting to `ralph:status:in-progress`.
- [x] Add parity audit + operator-visible diagnostics for `ghQueued && localBlocked` drift, including periodic reconcile logging of before/after counts.
- [x] Extend regression coverage for blocked mapping and parity audit classification.
- [x] Update orchestration contract doc with the blocked projection rule used for queue parity.
- [x] Run targeted regression tests for queue core, blocked sync, status command/snapshot, and parity helper.
