# Ralph Dashboard MVP: Control Plane + TUI

**Status:** draft (copied from bwrb idea)
**Owner:** @3mdistal
**Last updated:** 2026-01-10
**Related:** `docs/product/vision.md`, `docs/product/graceful-drain-rolling-restart.md`

## Summary

Build an **observability + control plane** that the Ralph daemon exposes over a local API.

- **First frontend:** a **terminal UI (TUI)** dashboard client.
- **Future frontends:** Tauri/native app, web UI, etc. (same API).
- **Visibility:** timestamped logs grouped by worker + session.
- **Control:** stepwise pause/resume, message enqueue, and interrupt+message (via OpenCode server APIs).

The key design choice is **API-first**: the daemon publishes structured events; UIs subscribe and render.

## Goals

- **State visibility:** see every worker, what it’s doing, and how long.
- **Timestamped logs:** daemon + per-worker logs + raw OpenCode session stream.
- **Grouped streams:** logs grouped by **workerId** (not just repo) and optionally by `sessionId`.
- **Stepwise pause:** pause at safe checkpoints; resume on demand.
- **Steering:** send a message into a session (queued or interrupt).
- **Task controls:** reprioritize by editing bwrb note fields (priority), plus basic status transitions.
- **Security:** token auth from day 1; bind localhost by default.
- **Remote-ready:** no built-in TLS; BYO tunnel/proxy.

## Non-goals (MVP)

- No first-party TLS / ACME / user management.
- No perfect semantic understanding of agent intent.
- No full-featured kanban editor for arbitrary bwrb schema (we can grow toward that later).

## Design Principles

- **Event-sourced:** append-only event stream + snapshot endpoint.
- **Composable frontends:** TUI now; Tauri later.
- **Stable IDs:** don’t key UI state on repo name alone.
- **Safe control boundaries:** pausing and steering must not corrupt sessions.
- **Pragmatic observability:** heuristic activity classification first; small-LLM summaries later.

## MVP UX

### TUI layout

- **Left pane (Workers):**
  - one row per `workerId`
  - shows `repo`, `task`, `checkpoint`, `activity`, elapsed time, last event timestamp, anomaly indicators
- **Right pane (Details):** tabs
  - **Ralph:** low-noise orchestration events
  - **Session:** full OpenCode stream (raw events + text)
  - **Task:** task frontmatter summary + controls (priority/status)
- **Footer:** keybinds + connection/auth status

### Keybinds (draft)

- `j/k` select worker
- `Tab` switch tabs
- `p` pause/resume (stepwise)
- `m` enqueue message (deliver at next checkpoint)
- `i` interrupt + message (abort then send; requires OpenCode server)
- `r` reprioritize selected task (bwrb priority)
- `/` filter workers/tasks

## Core Architecture

### Components

1. **Ralph daemon (existing)**
2. **Control plane server (new, embedded in daemon)**
   - serves snapshot state
   - publishes live event stream
   - accepts control commands
3. **TUI client (new)**
   - subscribes to event stream
   - renders views
   - sends commands

### Data model: IDs

- `taskId`: use bwrb `_path` (titles aren’t globally unique).
- `sessionId`: OpenCode session identifier.
- `workerId`: stable identity for one concurrent worker instance.

Important: Ralph today implicitly treats “worker == repo”. For the dashboard (and future concurrency), **workerId must not be repo**.

Recommended MVP `workerId`:

- `workerId = <repo>#<taskId>` (or a generated UUID), plus metadata:
  - `repoSlot`: integer (0..N-1) for per-repo concurrency
  - `worktreePath`: path for that worker’s checkout context

## Control Plane API

### Auth

- Require `Authorization: Bearer <token>` for all endpoints.
- Token is stored in `~/.config/opencode/ralph/ralph.json` (new field, e.g. `dashboardToken`).
- Default bind: `127.0.0.1`.

### Remote access strategy (BYO)

- MVP posture: **local-only server**.
- Remote usage is via:
  - `ssh -L 8787:127.0.0.1:8787 user@server` (recommended), or
  - a reverse proxy you configure (Caddy/Nginx/Tailscale serve).

No TLS in Ralph.

### Endpoints (MVP)

- `GET /v1/state`
  - returns current snapshot: daemon + workers + tasks + config
- `WS /v1/events`
  - streams append-only events
- `POST /v1/commands/pause`
  - `{ workerId }`
- `POST /v1/commands/resume`
  - `{ workerId }`
- `POST /v1/commands/message/enqueue`
  - `{ workerId | sessionId, text }`
- `POST /v1/commands/message/interrupt`
  - `{ workerId | sessionId, text }` (requires OpenCode server APIs)
- `POST /v1/commands/task/priority`
  - `{ taskId, priority }` (writes via `bwrb edit --path`)

Optional (nice-to-have in MVP):
- `POST /v1/commands/task/status` `{ taskId, status }`

## Event Stream

### Event envelope

All events are JSON objects with:

```json
{
  "ts": "2026-01-10T12:34:56.789Z",
  "type": "worker.checkpoint.reached",
  "level": "info",
  "workerId": "3mdistal/bwrb#orchestration/tasks/...",
  "repo": "3mdistal/bwrb",
  "taskId": "orchestration/tasks/...",
  "sessionId": "ses_abc123",
  "data": { "checkpoint": "pr_ready" }
}
```

### Event types (MVP)

- **Daemon lifecycle**
  - `daemon.started`, `daemon.stopped`
- **Worker lifecycle**
  - `worker.created`, `worker.became_busy`, `worker.became_idle`
- **Task lifecycle**
  - `task.assigned`, `task.status_changed`, `task.completed`, `task.escalated`, `task.blocked`
- **Checkpoints & pause**
  - `worker.checkpoint.reached`
  - `worker.pause.requested`, `worker.pause.reached`, `worker.pause.cleared`
- **Observability**
  - `worker.activity.updated` (heuristic)
  - `worker.summary.updated` (small-LLM, post-MVP)
  - `worker.anomaly.updated`
- **Logs**
  - `log.ralph` (daemon/orchestrator)
  - `log.worker` (per-worker)
  - `log.opencode.event` (raw JSON)
  - `log.opencode.text` (aggregated text convenience)
- **Errors**
  - `error` (structured; includes stack/message)

## Checkpoints (Stepwise Pause)

A **checkpoint** is a safe boundary where Ralph can pause without corrupting state.

### MVP checkpoint list

- `planned` — `/next-task` completed
- `routed` — routing decision parsed
- `implementation_step_complete` — a `continueSession` call returned
- `pr_ready` — PR URL detected
- `merge_step_complete` — merge instruction returned
- `survey_complete` — `/survey` returned
- `recorded` — agent-run note recorded

### Pause semantics

- `pauseRequested=true` means “stop at the next checkpoint”.
- When a worker reaches a checkpoint:
  - if pause requested: it emits `worker.pause.reached` and does not proceed until resumed.

This is the baseline “stepwise pause” and is safe even without OpenCode server APIs.

## Breaking up the long “implementation” period

In practice, the long part is inside a single OpenCode run or across repeated “Continue.” runs, and it may include:
- coding
- testing
- fixing failing tests
- product/devex review loops

Instead of a single `implementing` step, the UI should show:

1) **Checkpoint** (coarse, safe control boundary)
2) **Activity** (fine-grained, live cues)

### Activity classification (MVP: heuristics)

We compute an `activity` label continuously using whichever source is available:

1. OpenCode server event stream (preferred when available)
2. Ralph introspection artifacts (if present)
3. Regex over streamed text output (fallback)

Initial labels:
- `planning`, `searching`, `reading`, `editing`, `testing`, `git`, `github`, `docs`, `waiting`, `unknown`

Examples:
- frequent `bun test`/`pytest`/`go test` => `testing`
- many edits under `__tests__` or `tests/` => `testing` or `fixing_tests`
- `gh pr create` / `gh issue view` => `github`

This gives the “agent is close to done” cues you mentioned (testing + gh activity often precede completion).

### “Stall” pause (optional)

- If `checkpoint` hasn’t changed for `N` minutes, set `pauseRequested=true`.
- The worker then pauses at the next checkpoint.

This provides a safety valve without requiring mid-run interruption.

## Steering: queued vs interrupt messages

### Enqueued message (MVP)

- Store message in Ralph associated with `workerId` (or `sessionId`).
- Deliver it at the next checkpoint using `continueSession(sessionId, text)`.
- Works with current CLI-based session continuation.

### Interrupt message (post-MVP, but planned now)

Requires OpenCode server APIs:
- `POST /session/:id/abort` to stop current run
- then `POST /session/:id/prompt_async` to inject message

Expose in control plane as:
- `POST /v1/commands/message/interrupt`

Important note: interrupt is “harder” and should be an explicit action.

## OpenCode integration plan

### Phase 1 (MVP)

- Keep current execution model (CLI-based OpenCode runs).
- Stream what we can via existing `streamSession()` in Ralph.
- Emit events for all coarse orchestration transitions.

### Phase 2

- Run or attach to `opencode serve`.
- Use server APIs for:
  - async prompting (`prompt_async`)
  - abort (`abort`)
  - event streaming (SSE)

## Logs + retention

### Persistence

- Append every emitted control-plane event to JSONL files:
  - `~/.ralph/events/YYYY-MM-DD.jsonl`

### Retention policy

- Default: delete logs older than **14 days** (configurable).
- Run cleanup on daemon startup (and optionally daily).

### Redaction

- Never log obvious secrets/tokens.
- Redact patterns at ingest time (best-effort) before writing to disk.

## Optional: tiny LLM summaries (post-MVP)

Goal: every minute, produce a 1–2 line “what’s the agent doing?” summary per active worker.

- Input: last 60s of events/tool calls/text.
- Output: `worker.summary.updated` event:
  - `text`
  - `confidence`
  - `top_activities` (optional)

Constraints:
- strict context window
- strict tokens
- target budget: **< $0.10/hour**

Implementation preference:
- use OpenCode (keeps dependencies/costs consolidated)
- dedicate a summarizer session or small model

## Proposed issue breakdown (after this idea)

1. Event bus + event persistence + retention
2. Control plane server (auth + `/v1/state` + `/v1/events`)
3. Worker identity + multi-worker-per-repo foundation
4. Activity classifier (heuristic)
5. TUI client MVP (connect, render workers, render logs)
6. Commands: pause/resume + message enqueue
7. Commands: bwrb priority edit
8. OpenCode server integration (prompt_async + abort)
9. Optional: summaries + stall pause policy
