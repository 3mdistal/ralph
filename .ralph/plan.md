# Plan: Epic #25 Control Commands + Checkpoints

## Goal

- Finish the dashboard/control-plane MVP “control” surface for #25 by ensuring the remaining child (#37) is GitHub-first (no new bwrb writes): priority via `ralph:priority:*`, and status/actions via `ralph:cmd:*`.
- Keep `/v1` additive-only: add endpoints/fields, avoid breaking existing clients.
- Preserve the existing (already-merged) behavior from #35 (checkpoints/pause) and #36 (message-at-checkpoint) without re-implementing.

## Assumptions

- Child issues #35 and #36 are already satisfied by merged PRs; do not redo that work.
- bwrb is legacy output-only (per #37 comment); do not add new `bwrb edit` dependencies.
- Operator intent for GitHub tasks is expressed via labels per `docs/product/orchestration-contract.md`:
  - priority: `ralph:priority:p0..p4`
  - actions: `ralph:cmd:queue|pause|stop|satisfy`

## Checklist

- [x] Verify current control-plane endpoints cover pause/resume, message enqueue, and `task/priority`
- [x] Define GitHub-first task editing contract (priority + cmd actions; no direct status setting)
- [x] Add control-plane endpoints for GitHub issue priority + cmd actions (additive)
- [x] Implement GitHub mutation logic in a small module (keep `src/index.ts` as composition)
- [x] Define cmd conflict semantics (ensure at most one `ralph:cmd:*` label is set)
- [x] Add typed control-plane error contract with deterministic HTTP mapping
- [x] Wire handlers in `src/index.ts` using label ops + cached label bootstrap
- [x] Emit structured dashboard events for operator actions (at least `log.ralph`)
- [x] Add/extend unit tests for request validation + handler dispatch
- [x] Run verification gates (`bun test`, `bun run typecheck`, `bun run build`)

## Steps

- [x] Verify existing #25 child work is present (no redo)
  - [x] Confirm `/v1/commands/pause`, `/v1/commands/resume`, `/v1/commands/message/enqueue` exist and are token-authenticated.
  - [x] Confirm checkpoint + pause events exist (`worker.checkpoint.reached`, `worker.pause.*`) and message delivery events exist (`message.*`).
  - [x] Confirm `/v1/commands/task/priority` exists and supports GitHub tasks.

- [x] Define GitHub-first task editing contract (for #37)
  - [x] Priority editing: ensure exactly one `ralph:priority:*` label is set.
  - [x] Status/actions: expose `queue|pause|stop|satisfy` via `ralph:cmd:*` labels (do not directly set `ralph:status:*`).
  - [x] Keep bwrb-only behavior as legacy (no new endpoints that require bwrb).

- [x] Add control-plane endpoints (additive)
  - [x] `POST /v1/commands/issue/priority` body `{ repo, issueNumber, priority }`.
  - [x] `POST /v1/commands/issue/cmd` body `{ repo, issueNumber, cmd }` where `cmd in {queue,pause,stop,satisfy}`.
  - [x] Keep existing `POST /v1/commands/task/priority` unchanged for compatibility.
  - [x] Input validation: 400 for missing/invalid fields; 501 when commands are disabled.

- [x] Implement GitHub-first issue command module
  - [x] Add a small module (e.g. `src/dashboard/issue-commands.ts`) with:
    - [x] Pure helpers: validate inputs, map `cmd -> ralph:cmd:*` label, plan label ops (priority + cmd)
    - [x] Explicit cmd conflict semantics: when applying a cmd, remove other `ralph:cmd:*` labels so at most one cmd label is present.
    - [x] Thin executor that calls `executeIssueLabelOps` (no direct GitHub calls spread across `src/index.ts`).

- [x] Add typed control-plane error contract
  - [x] Introduce an error type (e.g. `ControlPlaneHttpError`) with `{ status, code, message }`.
  - [x] Update `src/dashboard/control-plane-server.ts` to catch this error type and return deterministic `{ error: { code, message } }` JSON with the chosen HTTP status.
  - [x] Map GitHub label op failures deterministically (`policy|auth|transient|unknown`) to stable `error.code` values.

- [x] Wire command handlers in `src/index.ts`
  - [x] Keep `src/index.ts` as composition: parse body -> call issue-command module -> publish dashboard events.
  - [x] Use a cached label ensurer (`createRalphWorkflowLabelsEnsurer`) rather than calling `ensureRalphWorkflowLabelsOnce` per request.
  - [x] Publish `log.ralph` events describing the accepted action (repo/issue/label); treat responses as “accepted” (command processing is async).

- [x] Tests
  - [x] Extend `src/__tests__/control-plane-server.test.ts` with cases for:
    - [x] `/v1/commands/issue/priority` calls handler and validates body
    - [x] `/v1/commands/issue/cmd` calls handler and rejects invalid cmd values
  - [x] Add focused unit tests for pure helpers:
    - [x] cmd->label mapping is exhaustive and stable
    - [x] cmd conflict planning removes other `ralph:cmd:*` labels
    - [x] error mapping produces stable HTTP + `error.code`

- [x] Verification
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run build`

## Verification notes

- `bun run typecheck`: pass.
- `bun run build`: pass.
- `bun test`: partial pass for changed scope; repository has unrelated pre-existing failures in broader suite (fixture and environment-dependent tests under `dist/__tests__` and some integration/required-checks tests).
