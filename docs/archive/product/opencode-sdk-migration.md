# Ralph: OpenCode SDK Migration

Status: archived
Owner: @3mdistal
Last updated: 2026-02-01

Ralph currently drives OpenCode primarily by spawning the `opencode` CLI and parsing JSON-formatted output.
This works, but it forces Ralph to treat OpenCode as a black box at exactly the point where Ralph increasingly needs reliable introspection, cancellation, and replay-safe recovery.

This doc describes the product direction: migrate Ralph to use the OpenCode HTTP server API via the official JS/TS SDK, while preserving Ralph’s core invariants (determinism and per-worktree isolation).

Implementation status: target spec / migration plan (no promises on exact timeline).

## Goals (Outcomes)

- Make OpenCode control deterministic and observable: replace “parse CLI streams” with typed API calls for sessions, messages, diffs, and events.
- Improve safety and correctness on long-running work: prefer `session.abort` over process-group killing; make watchdog behavior more graceful.
- Reduce orchestration flakiness: fewer “shape changed” JSON parsing failures; fewer brittle heuristics around stdout/stderr.
- Improve restart recovery: treat session state as durable and queryable (messages/status/diff) so Ralph can resume with confidence after daemon restarts.
- Preserve Ralph’s isolation contract: work stays isolated to git worktrees and profile-scoped XDG roots; no cross-repo or cross-task leakage.

## Non-goals

- Sharing a single OpenCode server across multiple worktrees (too risky given global “current project/path” semantics).
- Changing Ralph’s queue/source-of-truth model (GitHub-first contract remains).
- Replacing Ralph’s managed OpenCode config contract (daemon runs remain repo-agnostic and deterministic).

## Why migrate now

Ralph is already doing “orchestration-grade” work that benefits from a first-class control plane:

- watchdog timeouts and recovery loops
- session resume across daemon restarts
- attaching bounded diagnostics (recent events, diffs, log tails)
- consistent PR discovery and lifecycle tracking

Doing those via CLI parsing is inherently brittle. The SDK exposes the same server APIs OpenCode uses internally (TUI/web/IDE), with stable types and explicit semantics.

## What we gain

- **Typed APIs instead of heuristics:** `session.get`, `session.messages`, `session.diff`, `session.status`, `event.subscribe` become the primary truth sources.
- **First-class cancellation:** use `session.abort` as the normal path; keep process termination as an emergency fallback.
- **Better diagnostics:** stream server events (SSE) and persist a bounded per-task event ring for watchdog comments/escalations.
- **Idempotent sends:** message endpoints accept optional `messageID`; Ralph can adopt stable message IDs per “stage send” to avoid duplicate prompts after restarts.
- **Cleaner separation of concerns:** an explicit “OpenCode backend” boundary makes the worker logic simpler and reduces coupling to OpenCode CLI output shape.

## Isolation and performance stance

Ralph’s isolation contract is non-negotiable: tasks run in isolated git worktrees and should not share mutable state unintentionally.

OpenCode server instances have a notion of “current project/path” at the instance level, which makes multi-worktree sharing unsafe.
Therefore:

- Default: **one OpenCode server per active worktree** (or per “repo slot” where a slot maps 1:1 to a single checked-out worktree at a time).
- Allowed grouping: multiple sessions may share a server only if they share the same worktree path.
- Expected perf wins still exist: warm server + warm indexes per worktree, fewer cold starts than repeated `opencode run` invocations.

## Migration approach (Phased)

### Phase 0: Define a stable internal boundary

Introduce an internal “OpenCode backend” interface used by `RepoWorker` for:

- ensuring/attaching to a server (`baseUrl`)
- creating/resuming sessions
- sending stage messages
- subscribing to events
- aborting on watchdog
- fetching messages/status/diff for recovery and diagnostics

Keep the current CLI-based implementation as the baseline backend.

### Phase 1: Add SDK client-only backend (feature-flagged)

Add `@opencode-ai/sdk` and implement a backend that:

- spawns `opencode serve` under Ralph-controlled environment (managed `OPENCODE_CONFIG_DIR`, per-worktree `XDG_CACHE_HOME`, per-profile XDG roots)
- connects via `createOpencodeClient({ baseUrl })`
- uses server APIs for message send + event stream

The SDK backend should have a hard fallback path:

- if the server cannot start or becomes unhealthy, fall back to the CLI backend for that task

### Phase 2: Move introspection + watchdog to server APIs

- Replace “recent events” derived from CLI JSON parsing with a bounded SSE event buffer.
- Replace process-kill watchdog handling with `session.abort` as the primary action.
- Replace PR URL extraction heuristics with structured event/message inspection.

### Phase 3: Make restarts replay-safe

- Store stable identifiers in Ralph’s durable state (SQLite): session ID, worktree path, effective profile, and the last “stage message ID” used.
- On restart, reattach to the worktree’s server (or restart it) and re-hydrate state by querying:
  - `session.get` / `session.status`
  - `session.messages` (to confirm whether the current stage already sent)
  - `session.diff` (for gate artifacts and diagnostics)

### Phase 4: Flip default, deprecate CLI parsing

- Run the SDK backend by default for daemon operation.
- Keep the CLI backend as a guarded escape hatch for a defined deprecation window.
- Remove CLI-stream parsing code once confidence is high and compatibility risks are reduced.

## Rollout and safety checks

- Gate behind a config/env flag and roll out by intent/stage (e.g., plan-only -> implement -> resume).
- Track regressions explicitly:
  - rate of watchdog timeouts
  - restart recovery success rate
  - “duplicate prompt after restart” incidents
  - mean time to PR opened
  - rate of “unknown OpenCode output” / parsing failures (should drop to near-zero)

## Open questions

- Version compatibility: how strictly do we pin the OpenCode CLI/server version vs SDK version for daemon runs?
- Server lifecycle: do we prefer server-per-worktree always, or server-per-repo-slot with strict 1-worktree-at-a-time enforcement?
- Event durability: what minimal event subset should Ralph persist for deterministic writebacks (vs best-effort diagnostics only)?
