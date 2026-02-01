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
| `ralph:status:queued` | Runnable/claimable work is queued. |
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
| `ralph:cmd:satisfy` | Mark satisfied for dependency graph | Ralph records satisfaction (internal + GitHub-visible status if applicable), then removes the command label. |

Command processing requirements:

- Ralph must be idempotent and avoid comment spam.
- If a command is refused, Ralph must comment why.

## Queue semantics

- Claimable state: `ralph:status:queued`.
- Claiming moves the issue to `ralph:status:in-progress` and records ownership/heartbeat in SQLite.
- Human intervention:
  - Ralph escalates by setting `ralph:status:escalated` and writing a clear instruction comment.
  - Operator responds with normal comments, then applies `ralph:cmd:queue` to resume.

`ralph:cmd:queue` semantics (target):

- Clears any prior stop/pause/escalation state and returns the issue to `ralph:status:queued`.
- Clears best-effort internal retry/blocked metadata so Ralph can attempt a fresh recovery loop.

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

## Legacy mapping (to be removed)

Older docs and issues may reference these labels:

- `ralph:queued` -> `ralph:status:queued`
- `ralph:in-progress` -> `ralph:status:in-progress`
- `ralph:in-bot` -> `ralph:status:in-bot`
- `ralph:done` -> `ralph:status:done`
- `ralph:escalated` -> `ralph:status:escalated`

Dependency-blocked state should not use a GitHub-visible `blocked` status going forward.

## Planned work

- Labels vNext: operator commands + single status label (`https://github.com/3mdistal/ralph/issues/494`).
- Namespaced label migration (`https://github.com/3mdistal/ralph/issues/305`).
- Claims ledger (docs-as-control-plane) (`https://github.com/3mdistal/ralph/issues/459`).
