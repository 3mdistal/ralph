# Ralph Dashboard MVP: Control Plane + TUI

Status: archived
Owner: @3mdistal
Last updated: 2026-02-01

**Status:** draft (copied from legacy note)
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

## Operator posture

This control plane (operator dashboard) is **operator tooling**, not a user-facing UI.

- Intended user: the maintainer/operator running Ralph (single-user posture).
- API-first: frontends are interchangeable (TUI first; other UIs later).
- Local-first: token-authenticated and bound to `127.0.0.1` by default; remote access is via SSH port-forwarding or your own proxy.
- Threat model: single-user, local-machine; not hardened for hostile networks.

## Goals

- **State visibility:** see every worker, what it’s doing, and how long.
- **Timestamped logs:** daemon + per-worker logs + raw OpenCode session stream.
- **Grouped streams:** logs grouped by **workerId** (not just repo) and optionally by `sessionId`.
- **Stepwise pause:** pause at safe checkpoints; resume on demand.
- **Steering:** send a message into a session (queued or interrupt).
- **Task controls:** reprioritize via GitHub labels + status transitions.
- **Security:** token auth from day 1; bind localhost by default.
- **Remote-ready:** no built-in TLS; BYO tunnel/proxy.

## Non-goals (MVP)

- No first-party TLS / ACME / user management.
- No perfect semantic understanding of agent intent.
- No full-featured kanban editor for arbitrary task schemas (we can grow toward that later).
- No rich task editing in the MVP beyond labels/status transitions.

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
- `r` reprioritize selected task (label-based priority)
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

- `taskId`: use stable issue references (`owner/repo#number`).
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
- WebSocket auth supports `Authorization` header, `Sec-WebSocket-Protocol: ralph.bearer.<token>`, or `?access_token=` query param.
- For WebSocket auth, if multiple tokens are provided, the connection is accepted if **any** presented token matches.
- If `Sec-WebSocket-Protocol` is used for auth, the server echoes the same protocol on successful connection.
- Token is configured in `~/.ralph/config.toml` or `~/.ralph/config.json` under `dashboard.controlPlane.token`, or via `RALPH_DASHBOARD_TOKEN`.
- Control plane server only starts when explicitly enabled and a token is present.
- Default bind: `127.0.0.1` (non-loopback binds require `dashboard.controlPlane.allowRemote = true`).

### Configuration (MVP)

- `dashboard.controlPlane.enabled` (bool): start the control plane server.
- `dashboard.controlPlane.host` (string): bind host (default `127.0.0.1`).
- `dashboard.controlPlane.port` (number): bind port (default `8787`).
- `dashboard.controlPlane.token` (string): Bearer token required for all endpoints.
- `dashboard.controlPlane.allowRemote` (bool): allow non-loopback binds.
- `dashboard.controlPlane.exposeRawOpencodeEvents` (bool): stream `log.opencode.event` payloads (default false).
- `dashboard.controlPlane.replayLastDefault` / `replayLastMax` (numbers): default + max replay counts for `/v1/events`.

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
  - `{ taskId, priority }` (writes via GitHub label mutations)

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
  "runId": "run_abc123",
  "workerId": "3mdistal/ralph#123",
  "repo": "3mdistal/ralph",
  "taskId": "orchestration/tasks/...",
  "sessionId": "ses_abc123",
  "data": { "checkpoint": "pr_ready" }
}
```

`runId` is a **per-task-attempt** identifier (stable for one agent-run / one work session). It is emitted on every dashboard log/state event and is **not** a daemon-global id.

Dashboard events are distinct from OpenCode session `events.jsonl` streams; the control-plane envelope uses ISO timestamps and Ralph event types, while session events use their own schema (numeric timestamps, tool/run events). Do not assume they are interchangeable.

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

Notes:
- Control plane output is redacted for obvious tokens/paths (applies to `/v1/state` and `/v1/events`).
- `log.opencode.event` is **not streamed by default**; enable explicitly with `dashboard.controlPlane.exposeRawOpencodeEvents`.

### /v1/events replay (MVP contract)

- Query param: `replayLast` (integer)
  - Default: `dashboard.controlPlane.replayLastDefault` (default 50).
  - Clamped to `0..dashboard.controlPlane.replayLastMax` (default 250).
  - Non-numeric values fall back to the default.
- Query param: `access_token` (string, optional) for WebSocket auth.

### /v1/state schema (MVP contract)

`/v1/state` returns a JSON object with the following required top-level keys:

```json
{
  "mode": "running|paused|draining|soft-throttled|hard-throttled",
  "queue": { "backend": "...", "health": "...", "fallback": false, "diagnostics": null },
  "controlProfile": null,
  "activeProfile": null,
  "throttle": {},
  "usage": { "profiles": [] },
  "escalations": { "pending": 0 },
  "inProgress": [],
  "starting": [],
  "queued": [],
  "throttled": [],
  "blocked": [],
  "drain": { "requestedAt": null, "timeoutMs": null, "pauseRequested": false, "pauseAtCheckpoint": null }
}
```

Contract notes:
- `/v1/state` is additive-only within the `/v1` surface: new fields may be added, but existing fields will not be removed or change type in v1.
- Arrays contain task objects for each state (see `src/status-snapshot.ts` for the internal shapes; treat them as *extensible*).

## Checkpoints (Stepwise Pause)

A **checkpoint** is a safe boundary where Ralph can pause without corrupting state.

### MVP checkpoint list

- `planned` — planner prompt completed
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
- Operator control (MVP): set `pause_requested=true` in the control file to pause; clear it to resume.

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

Deterministic rules (MVP defaults):
- Rolling window: 60s of signals; score matches in that window.
- Tie-breaking precedence: `testing` > `github` > `git` > `editing` > `reading` > `searching` > `planning` > `docs` > `waiting` > `unknown`.
- Waiting detection: if a worker is busy but no signals for 10s, set `waiting`; if idle, also `waiting`.
- Emit `worker.activity.updated` on label change, or every 15s while busy (rate-limited).
- Regex fallback matches common commands:
  - tests: `pytest`, `go test`, `npm test`, `bun test`, `cargo test`
  - github: `gh ...`
  - git: `git ...`
  - reading: `read`, `cat`, `sed -n`, `less`
  - editing: `edit`, `write`, `apply patch`, `sed -i`
  - searching: `rg`, `ripgrep`, `grep`, `glob`, `find`

Examples:
- frequent `bun test`/`pytest`/`go test` => `testing`
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

## Issue map

This list is for navigation and may drift; treat the epics as canonical.

Epics:
- https://github.com/3mdistal/ralph/issues/22 — Dashboard MVP (Control plane + TUI)
- https://github.com/3mdistal/ralph/issues/23 — Dashboard docs + scope
- https://github.com/3mdistal/ralph/issues/24 — Control plane backend
- https://github.com/3mdistal/ralph/issues/25 — Control commands + checkpoints
- https://github.com/3mdistal/ralph/issues/26 — Terminal UI client
- https://github.com/3mdistal/ralph/issues/27 — OpenCode server integration
- https://github.com/3mdistal/ralph/issues/28 — Observability upgrades

Implementation issues:
- https://github.com/3mdistal/ralph/issues/30 — Event bus + typed event schema
- https://github.com/3mdistal/ralph/issues/31 — Worker IDs + per-repo concurrency slots
- https://github.com/3mdistal/ralph/issues/32 — Emit timestamped log and state events
- https://github.com/3mdistal/ralph/issues/33 — Persist events (JSONL) + retention cleanup
- https://github.com/3mdistal/ralph/issues/34 — Control plane server (state + events + auth)
- https://github.com/3mdistal/ralph/issues/35 — Checkpoints + stepwise pause/resume
- https://github.com/3mdistal/ralph/issues/36 — Message queue + deliver at checkpoint
- https://github.com/3mdistal/ralph/issues/37 — task edit endpoints (priority/status)
- https://github.com/3mdistal/ralph/issues/38 — TUI client MVP (workers list + logs tabs)
- https://github.com/3mdistal/ralph/issues/39 — TUI controls (pause/resume + enqueue message)
- https://github.com/3mdistal/ralph/issues/40 — TUI task controls (reprioritize via labels)
- https://github.com/3mdistal/ralph/issues/41 — Activity classifier (heuristics)
- https://github.com/3mdistal/ralph/issues/42 — OpenCode server client (SSE + prompt_async)
- https://github.com/3mdistal/ralph/issues/43 — Interrupt messaging (abort + prompt_async)
- https://github.com/3mdistal/ralph/issues/44 — Tiny summaries (minute-level, cost-capped)

## Proposed issue breakdown (after this idea)

1. Event bus + event persistence + retention
2. Control plane server (auth + `/v1/state` + `/v1/events`)
3. Worker identity + multi-worker-per-repo foundation
4. Activity classifier (heuristic)
5. TUI client MVP (connect, render workers, render logs)
6. Commands: pause/resume + message enqueue
7. Commands: priority label edit
8. OpenCode server integration (prompt_async + abort)
9. Optional: summaries + stall pause policy
