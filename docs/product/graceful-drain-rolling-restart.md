# Ralph: Graceful drain + rolling restart (checkpoint-based)

**Status:** draft (copied from bwrb idea)
**Owner:** @3mdistal
**Last updated:** 2026-01-10
**Related:** `docs/product/vision.md`, `docs/product/dashboard-mvp-control-plane-tui.md`

## Summary

Make Ralph restarts/upgrades low-disruption and platform-agnostic by introducing a **drain mode**, **checkpoint-based pausing**, and a **deterministic handoff/resume protocol**.

This is designed to work on **macOS today** and **NixOS/Linux later** using POSIX + XDG conventions.

## Why now

We frequently pull + restart Ralph to pick up changes on `main`, but we want work to **keep going** (or pause at safe points) with **minimal shutdown time** and **no duplicated work**.

## Reality check: how this aligns with planned work

Your open issues already line up with this direction:

- `#35` “Dashboard: Checkpoints + stepwise pause/resume” is the key enabler for pausing at safe boundaries.
- `#36` “Dashboard: Message queue + deliver at checkpoint” is the steering mechanism that makes pauses/resumes useful.
- `#39` “Dashboard: TUI controls (pause/resume + enqueue message)” is the operator UX for all of this.
- `#10` “Resume same OpenCode session after escalation resolution” makes HITL escalations behave like a resumable pause, not a full reset.
- `#27/#42/#43` (OpenCode server + interrupt messaging) are what make “rolling restart with *near-zero disruption*” possible (attach/stream/abort/prompt_async).

Conclusion:
- “Pause at next acceptable stopping point” is the main blocker for *clean* pauses.
- OpenCode server integration is the main blocker for *zero-disruption* handoff while a run is actively streaming.

## HITL escalation resolution protocol

Escalations are HITL checkpoints and should behave like paused/resumable runs.

**Contract (MVP)**
- The created `agent-escalation` note must include frontmatter fields:
  - `task-path`: the exact bwrb `_path` of the `agent-task` note to resume
  - `session-id`: the OpenCode `ses_*` identifier to continue
- The escalation note body must include a section headed exactly `## Resolution`.
  - Operators write the human guidance under this heading.
  - Ralph treats that text as the next user turn when resuming.

**Resolution semantics**
- Operator marks the escalation note `status: resolved`.
- Ralph attempts to resume the existing OpenCode session by calling `continueSession(session-id, <resolution text>)`.
- Ralph records durable resume state on the escalation note via frontmatter:
  - `resume-status`: `deferred` | `attempting` | `succeeded` | `failed`
  - `resume-attempted-at`: timestamp when an attempt starts
  - `resume-error`: empty on success; error message on failure
- If resuming fails (expired session / OpenCode error), Ralph clears the task’s `session-id` and re-queues the task for a fresh run.

## Terms and concepts

### Daemon modes

- `running`: normal scheduling
- `draining`: stop scheduling new queued tasks; let in-flight work reach the next acceptable checkpoint
  - While `draining`, Ralph may resume already-owned work (e.g. orphaned `in-progress` tasks on startup, or resolved HITL escalations) as long as it does not dequeue/start new queued tasks.
  - If hard-throttled, `draining` should also stop model sends (e.g. `continueSession(...)`).
- `paused`: scheduler paused; no new work; workers may also be paused at checkpoint

### Worker modes

- `active`: executing work
- `pause_requested`: will pause at next checkpoint
- `paused_at_checkpoint`: stopped at a checkpoint awaiting resume

### Checkpoints

A **checkpoint** is a safe control boundary where Ralph can stop progressing a task without corrupting state.

Use the same list described in the existing idea note `reflections/ideas/Ralph Dashboard MVP: Control Plane + TUI.md` (e.g. `planned`, `routed`, `implementation_step_complete`, `pr_ready`, `survey_complete`, `recorded`).

## What we want operationally

### Minimal downtime upgrade (operator intent)

- “Stop taking new work now.”
- “Let current work finish, or pause it safely.”
- “Swap Ralph binary/code.”
- “Continue from exactly where it left off.”

### Platform expectations

- Must work on macOS and Linux/NixOS.
- Prefer XDG paths where possible (target state). Current implementation:
  - Config: `~/.ralph/config.toml` > `~/.ralph/config.json` > legacy `~/.config/opencode/ralph/ralph.json`
  - State/logs: `~/.ralph/...` (overridable via `RALPH_SESSIONS_DIR` / `RALPH_WORKTREES_DIR`)
  - Caches: TBD
- Avoid macOS-only supervisors (launchd) in the core protocol. Supervisors can exist, but they shouldn’t be required.

## Control surface: CLI-first, API later

We want a stable operator interface that works without the dashboard, but can be backed by the control plane once it exists.

### CLI commands (spec)

- `ralphctl status --json`
  - prints daemon mode, version, worker list, and active tasks
- `ralphctl drain [--timeout 5m] [--pause-at-checkpoint <checkpoint>]`
  - puts daemon into `draining`
  - optionally sets `pause_requested` for active workers
- `ralphctl resume`
  - clears `draining/paused` and lets scheduling continue
- `ralphctl restart [--grace 5m]`
  - requests drain, waits for drained/timeout, terminates daemon, starts daemon
- `ralphctl upgrade [--git-pull] [--grace 5m]`
  - same as restart, but runs the upgrade step (implementation depends on how Ralph is installed)

### How the CLI talks to the daemon

Two phases:

- Phase 0 (no control plane required):
  - CLI writes a control file, e.g. `$XDG_STATE_HOME/ralph/control.json`.
    - Fallback when `XDG_STATE_HOME`/`HOME` are unavailable: `/tmp/ralph/control.json`.
  - Daemon watches/polls it.
  - Optional: CLI sends `SIGUSR1` to prompt immediate reload.

- Phase 1 (dashboard/control plane):
  - Same semantics exposed as authenticated endpoints, e.g. `POST /v1/commands/daemon/drain`.
  - This composes with #34/#37 and the Dashboard MVP.

## State and ownership model (avoids duplicate work)

To safely run “old daemon + new daemon” overlap (rolling restart), introduce explicit ownership + heartbeats.

### Daemon identity

- `daemonId`: stable random ID for the daemon instance (e.g. `d_...`)
- `startTs`, `pid`, `version` (git SHA or build version)

### Task ownership fields (stored on `agent-task` frontmatter)

- `daemon-id`: current owner
- `heartbeat-at`: last observed heartbeat timestamp
- `checkpoint`: last checkpoint reached
- `pause-requested`: boolean

### Session/run fields (recommended)

- `session-id`: already exists
- `run-log-path`: path to an append-only log capturing OpenCode run output in a restart-survivable way
- `opencode-pid`: best-effort detection of already-running CLI process

### Ownership rule

A daemon may only act on a task if:
- it owns it (`daemon-id` matches), OR
- the previous owner’s `heartbeat-at` is stale beyond TTL (e.g. 30s / 60s).

This is the core protection against duplicate resumes and double-processing.

## Flow: rolling restart (checkpoint-based)

### 1) Drain

1. Operator runs `ralphctl drain --timeout 5m`.
2. Daemon immediately stops dequeuing new tasks.
3. Optionally sets `pause-requested=true` on active tasks/workers.
4. Daemon continues progressing tasks until they hit a checkpoint, then pauses them.
5. Daemon signals `drained=true` when:
   - no tasks are currently `active`, OR
   - all active tasks are paused at a checkpoint, OR
   - timeout reached.

### 2) Handoff

6. Start the new daemon (new code).
7. New daemon reads tasks and applies the ownership rule:
   - if old daemon heartbeat is fresh: do not take ownership
   - if stale (or old daemon is drained/exited): take ownership

### 3) Resume

8. New daemon resumes paused tasks from their checkpoint.

Notes:
- In CLI-only mode, resuming requires `continueSession(sessionId, "Continue.")` which injects a message.
- With OpenCode server integration, the new daemon should *attach* and continue without injecting a “restart” message.

### 4) Stop old daemon

9. Old daemon exits once drained (or after grace timeout).

## Key implementation notes (practical, restart-friendly)

- The most important improvement for minimal downtime is **restart-survivable OpenCode run output**.
  - If `opencode run` output only exists in the daemon’s stdout pipe, a daemon restart loses the stream.
  - Capturing OpenCode output to a per-run file makes it possible for a new daemon to recover state without poking the session.

- OpenCode server integration (#27) is what unlocks:
  - attach/stream across restarts
  - abort + prompt_async “interrupt messaging” (#43)
  - true "pause now" rather than “pause at checkpoint”

- Prevent the `in-progress` without `session-id` window:
  - Ideally: don’t set `status: in-progress` until a `session-id` is recorded.
  - Or: use a temporary `starting` status that is restart-safe.

## Acceptance criteria

- Operator can request drain; daemon stops starting new tasks within ~1s.
- Restart/upgrade results in **every** in-progress task either:
  - resumed with the same `session-id`, or
  - explicitly marked failed/escalated with a recorded reason.
- No task receives duplicate resume prompts from overlapping daemons under normal conditions.
- Works on macOS and Linux/NixOS using only POSIX + XDG conventions.

## Related

- `reflections/ideas/Ralph Dashboard MVP: Control Plane + TUI.md`
- https://github.com/3mdistal/ralph/issues/35
- https://github.com/3mdistal/ralph/issues/36
- https://github.com/3mdistal/ralph/issues/39
- https://github.com/3mdistal/ralph/issues/10
- https://github.com/3mdistal/ralph/issues/27
- https://github.com/3mdistal/ralph/issues/43
- https://github.com/3mdistal/ralph/issues/31
