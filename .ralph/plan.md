# Plan: Fix queue/in-progress label flapping on long-lived open PRs (#599)

## Goal

- Stop `ralph:status:queued` <-> `ralph:status:in-progress` oscillation for issues that already have a long-lived open PR and no new operator input.
- Preserve contract invariant: exactly one `ralph:status:*` label converges, and `queued` remains claimable while “open PR waiting” is not claimable.
- Reduce GitHub label writes/timeline noise; avoid burning API quota.

## Product Constraints (canonical)

- Status labels are fixed to the `ralph:status:*` set; internal “why” states should be internal metadata (`docs/product/orchestration-contract.md`).
- `ralph:status:in-progress` includes “waiting on deterministic gates (e.g. CI)”; “open PR waiting” should therefore be stable `in-progress` on GitHub.
- GitHub label writes are best-effort; convergence matters more than chattiness.

## Assumptions

- Introduce explicit durable status `waiting-on-pr` in task op-state (`tasks.status`) for “open PR exists, waiting”.
- Map `waiting-on-pr` to GitHub label `ralph:status:in-progress` (no new GitHub-visible status labels).
- Use SQLite PR snapshots (`prs` table) as the primary “does an open PR exist for this issue?” signal, with a freshness window to avoid indefinite parking on stale data.

## Checklist

- [x] Unblock gate persistence drift (`ralph_run_gate_results.reason`)
- [x] Add durable op-state for open-PR wait (`waiting-on-pr`)
- [x] Park queued tasks on open PR (don’t keep them claimable)
- [x] Gate stale in-progress sweep by open-PR wait state
- [x] Make label reconciler respect open-PR wait mapping
- [x] Remove passive open-PR in-progress writes for passive path
- [x] Add anti-flap guardrail (single choke point debounce)
- [x] Tests: no-flap regression + operator override + closed-PR recovery + no-duplicate writes
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`

## Steps

- [x] Keep startup gate-schema repair covered and aligned with schema updates (`src/__tests__/state-sqlite.test.ts`).
- [x] Add `waiting-on-pr` to queue status model and map it to `ralph:status:in-progress` label convergence.
- [x] Park queued tasks with existing open PRs in `RepoWorker.processTask` before planner/build, clearing active ownership/session fields.
- [x] Gate stale in-progress sweep: skip recovery when op-state is `waiting-on-pr` and open PR snapshot is fresh; allow recovery when snapshot is stale/closed.
- [x] Add transition debounce guard (in-memory + durable SQLite record) for opposite queued/in-progress transitions; log suppressed transitions.
- [x] Wire label reconciler to respect `waiting-on-pr` and transition debounce state.
- [x] Add tests for no-flap regression, operator re-queue behavior, closed-PR recovery, waiting-on-pr label idempotence, and transition debounce core logic.
- [x] Run gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.
