# Ralph Orchestration Contract (vNext)

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

## Scope

This document defines the target GitHub surface for Ralph's operator UX and the core orchestration invariants:

- Operator interaction via GitHub Issues + comments.
- Bot-owned status labels (`ralph:status:*`) + operator command labels (`ralph:cmd:*`).
- GitHub-first queue semantics with SQLite for durable internal state.

This doc is intended to supersede label/queue semantics in older docs.

## Sources of truth

- GitHub Issues + comments: operator UX surface, queue membership, and human intervention.
- SQLite (`~/.ralph/state.sqlite`): durable internal state (sessions, worktrees, cursors, run records).

## Invariants

- Ralph never edits non-`ralph:*` labels.
- Ralph never intentionally sets multiple `ralph:status:*` labels; on any successful reconciliation pass it enforces exactly one status label.
- Operator intent is expressed only via `ralph:cmd:*` labels + normal GitHub comments.
- Dependency-blocked is internal-only metadata (not a GitHub-visible status).
- Ralph scheduling must not depend on GitHub label writes (degraded mode must continue safely).
- Ralph-generated PRs target `bot/integration`; humans review rollups to `main`.
- Task work executes in isolated git worktrees (not in the main checkout).

## Labels

### Status labels (bot-owned, mutually exclusive)

| Label | Meaning |
| --- | --- |
| `ralph:status:queued` | Runnable/claimable work is queued (unless blocked by internal dependency metadata). |
| `ralph:status:in-progress` | Ralph owns the task and is actively working or waiting on deterministic gates (e.g. CI). |
| `ralph:status:paused` | Ralph will not progress this task beyond safe checkpoints. |
| `ralph:status:escalated` | Needs human intervention; Ralph will not proceed until re-queued by an operator command. |
| `ralph:status:in-bot` | Midpoint: task PR merged to the bot branch (`bot/integration`). |
| `ralph:status:done` | Task changes reconciled onto the repo default branch (typically via rollup). |
| `ralph:status:stopped` | Operator cancelled; Ralph relinquished ownership and will not proceed without an explicit re-queue. |

Notes:

- Internal causes (deps blocked, CI failing, merge conflicts, rate limits, etc.) are tracked as internal metadata and surfaced via `bun run status` and/or dashboard, not as multiple GitHub state labels.

### Command labels (operator-owned, ephemeral)

| Label | Operator intent | Ralph behavior |
| --- | --- | --- |
| `ralph:cmd:queue` | Enqueue / re-enqueue | Ralph processes idempotently, comments success/refusal, then removes the command label. |
| `ralph:cmd:pause` | Pause at safe checkpoints | Ralph transitions status to `paused`, then removes the command label. |
| `ralph:cmd:stop` | Cancel / stop work | Ralph transitions status to `stopped`, cleans up best-effort, then removes the command label. |
| `ralph:cmd:satisfy` | Mark satisfied for dependency graph | Ralph records dependency satisfaction (internal) and removes the command label. This does not imply merge/close. |

Note: `ralph:cmd:satisfy` does not change the issue `ralph:status:*` label.

Command processing requirements:

- Ralph must be idempotent and avoid comment spam.
- If a command is refused, Ralph must comment why.

Command issuer policy:

- Any collaborator who can apply labels may issue `ralph:cmd:*` commands.

## Queue semantics

- Claimable state: `ralph:status:queued` (unless internal blocked metadata says dependencies are still open).
- Claiming moves the issue to `ralph:status:in-progress` and records ownership/heartbeat in SQLite.
- Human intervention:
  - Ralph escalates by setting `ralph:status:escalated` and writing a clear instruction comment.
  - Operator responds with normal comments, then applies `ralph:cmd:queue` to resume.

`ralph:cmd:queue` semantics (target):

- Clears any prior stop/pause/escalation state and returns the issue to `ralph:status:queued`.
- Clears best-effort internal retry/blocked metadata so Ralph can attempt a fresh recovery loop.

Note: status updates are best-effort and may be applied asynchronously.

## Degraded mode: GitHub label writes unavailable

GitHub label writes are best-effort. When throttled/blocked by GitHub rate limits or abuse detection:

- SQLite remains authoritative for ownership/heartbeat.
- Scheduling and slot release must continue safely.
- Ralph surfaces degraded mode via logs/status.
- Labels converge when GitHub writes resume.

## Bot branch strategy

- Ralph opens/merges task PRs to `bot/integration`.
- A rollup PR from `bot/integration` to `main` is the primary human review surface.
- The midpoint `ralph:status:in-bot` corresponds to "merged to bot branch".
- `ralph:status:done` corresponds to "reconciled onto the repo default branch".

## Issue closure policy (target)

- Ralph closes issues when `ralph:status:done` is reached.
- Rollup PRs may also close issues via `Fixes #N`, but the operator-visible definition is "done == reconciled to default branch".

## Done semantics (deterministic)

`ralph:status:done` is derived from one of two evidence paths:

- PR path (default):
  - Ralph uses GitHub issue timeline events to identify the closing PR.
  - Ralph then verifies the merge commit SHA (or equivalent head SHA) is reachable from the repo default branch head.
  - If verified, it sets `ralph:status:done` and closes the issue.
- Parent-verification no-PR path (narrow exception):
  - Allowed only for the parent verification lane when `work_remains=false` with `confidence=medium|high` and strong evidence.
  - Ralph posts/updates a single structured verification comment with marker `<!-- ralph-verify:v1 id=ISSUE_NUMBER -->` and `RALPH_VERIFY: {...}` payload.
  - If writeback succeeds, Ralph sets `ralph:status:done` and closes the issue even without a PR.

## Label bootstrap

Ralph ensures all required `ralph:status:*`, `ralph:cmd:*`, and `ralph:priority:*` labels exist in the repo, and enforces their label descriptions/colors to match the version shipped with Ralph.

Required set (vNext):

- Statuses: `ralph:status:queued`, `ralph:status:in-progress`, `ralph:status:paused`, `ralph:status:escalated`, `ralph:status:in-bot`, `ralph:status:done`, `ralph:status:stopped`
- Commands: `ralph:cmd:queue`, `ralph:cmd:pause`, `ralph:cmd:stop`, `ralph:cmd:satisfy`
- Priority: `ralph:priority:p0`, `ralph:priority:p1`, `ralph:priority:p2`, `ralph:priority:p3`, `ralph:priority:p4`

## Priority (operator input)

Priority is expressed via `ralph:priority:p0`..`ralph:priority:p4` labels.

- Default priority is `p2` when no priority label is present.
- Priority affects dequeue order among `ralph:status:queued` issues only.
- Priority labels do not change status and do not imply queueing.

## Stop semantics

When `ralph:cmd:stop` is applied:

- Ralph stops automation and relinquishes ownership.
- Any existing open PRs remain open.

## Legacy mapping (to be removed)

Older docs and issues may reference these labels:

- `ralph:queued` -> `ralph:status:queued`
- `ralph:in-progress` -> `ralph:status:in-progress`
- `ralph:in-bot` -> `ralph:status:in-bot`
- `ralph:done` -> `ralph:status:done`
- `ralph:escalated` -> `ralph:status:escalated`
- `ralph:blocked` -> `ralph:status:escalated`

Dependency-blocked state should not use a GitHub-visible `blocked` status going forward.

## Planned work

- Labels vNext: operator commands + single status label (`https://github.com/3mdistal/ralph/issues/494`).
- Namespaced label migration (`https://github.com/3mdistal/ralph/issues/305`).
- Claims ledger (docs-as-control-plane) (`https://github.com/3mdistal/ralph/issues/459`).
