# Plan: Dashboard Control Plane Task Edit Endpoints (#37)

## Goal

- Add control-plane support for operator task edits: priority and status, for GitHub-first orchestration.
- Keep bwrb legacy/output-only: do not introduce new behavior that depends on bwrb being writable.
- Ensure behavior is testable, token-authenticated, and emits structured dashboard events.

## Product Assumptions (from issue comments + canonical docs)

- Canonical task model is GitHub issues/labels + SQLite (durable internal state). bwrb is legacy output-only.
- Priority is operator input via `ralph:priority:p0..p4` and must not change `ralph:status:*`.
- “Status edits” are operator intent via `ralph:cmd:*` labels; status labels (`ralph:status:*`) are bot-owned and must not be set directly.

## Checklist

- [x] Confirm current control-plane command surface for task edits
- [x] Implement `POST /v1/commands/task/status` endpoint with auth + validation
- [x] Wire server handler in daemon (`src/index.ts`) to apply GitHub `ralph:cmd:*` labels
- [x] Add typed command errors so validation returns 4xx (not 500)
- [x] Define deterministic cmd-label replacement semantics (avoid multiple cmd labels)
- [x] Emit operator-visible structured events (`log.ralph` + existing `github.request` telemetry)
- [x] Add/extend unit tests for the new endpoint and handler wiring
- [x] Run verification gates (at least `bun test`; add `bun run typecheck` if types change)

## Steps

- [x] Confirm current control-plane command surface
  - [x] Inspect `src/dashboard/control-plane-server.ts` routes and `ControlPlaneCommandHandlers`.
  - [x] Confirm `POST /v1/commands/task/priority` already supports GitHub issue refs (`github:owner/repo#123`).

- [x] Implement `POST /v1/commands/task/status`
  - [x] Add `setTaskStatus` to `ControlPlaneCommandHandlers`.
  - [x] Add route `POST /v1/commands/task/status` with JSON body `{ taskId, status }`.
  - [x] Validate: non-empty `taskId`, non-empty `status`; otherwise `400` with `bad_request`.

- [x] Add typed command errors (so operator mistakes are 4xx)
  - [x] Introduce a small error type (e.g. `ControlPlaneCommandError`) with `{ status, code, message }`.
  - [x] In `startControlPlaneServer(...)`, treat this error type as a pass-through to `jsonError(status, code, message)`.
  - [x] Use this for: invalid status, invalid taskId format, non-GitHub task ids, missing GitHub auth.

- [x] Wire handler in `src/index.ts`
  - [x] Extract a pure helper module (functional core) for deterministic parsing/mapping:
    - [x] `parseGitHubTaskId("github:owner/repo#123") -> { repo, issueNumber } | ControlPlaneCommandError`
    - [x] `mapTaskStatusInputToCmdLabel(status) -> ralph:cmd:* | ControlPlaneCommandError` (case/whitespace tolerant + aliases)
  - [x] Only support GitHub taskIds; for non-GitHub ids return `400 unsupported_task_id` (no new bwrb write path).
  - [x] Define cmd-label replacement semantics to avoid ambiguity:
    - [x] When applying a cmd label, also remove other `ralph:cmd:*` labels (`queue|pause|stop|satisfy`) so only one is present.
  - [x] Apply the command label via existing GitHub label write helpers:
    - [x] Ensure `ralph:*` workflow labels exist (`ensureRalphWorkflowLabelsOnce`).
    - [x] Apply `planIssueLabelOps({ add: [targetCmd], remove: otherCmds })`; do not edit `ralph:status:*` directly.
  - [x] Publish a `log.ralph` dashboard event describing what was requested (repo + issue + cmd label).

- [x] Tests
  - [x] Extend `src/__tests__/control-plane-server.test.ts` to cover:
    - [x] happy-path request hits `setTaskStatus` handler
    - [x] missing/empty `status` returns `400`
    - [x] handler-thrown `ControlPlaneCommandError` returns the expected `4xx` (not `500`)
  - [x] Add focused unit tests for the pure helper module:
    - [x] status alias + normalization mapping
    - [x] rejects unknown status deterministically
    - [x] parses `github:` task ids; rejects malformed/unsupported ids

- [x] Verification
  - [x] `bun test`
  - [x] `bun run typecheck` (if required by changes)
