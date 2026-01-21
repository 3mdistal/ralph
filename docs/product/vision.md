# Ralph Loop - Product Vision

## What is Ralph?

Ralph Loop is an autonomous orchestration layer that manages a queue of coding tasks across repos, dispatches work to OpenCode agents, and surfaces only the decisions that require human judgment.

## Core Principle

**Minimize human interrupt surface.** Only escalate for:
- Documentation gaps (product agent says "this isn't documented")
- Blocked issues
- DX issue recommendations (batched)
- Rollup PR review

Everything else should proceed autonomously.

## Escalation Markers

Escalation marker parsing must be deterministic and machine-parseable.

Canonical spec: `docs/escalation-policy.md`.

Keep this doc focused on product intent; update routing/escalation policy in one place.

## Related Product Docs

- `docs/product/dashboard-mvp-control-plane-tui.md`
- `docs/product/graceful-drain-rolling-restart.md`
- `docs/product/usage-throttling.md`

## The Problem We're Solving

The manual workflow is effective but repetitive:
1. Spin up OpenCode session
2. Run `/next-task <issue>` - plan agent consults @product, asks questions
3. Agent builds (worktree, commits, tests)
4. Agent presents PR - human says "looks good, merge and clean up"
5. Run `/survey` - @devex recommends issues

When reviewing ~40 PRs/day and almost never rejecting them, the human becomes a bottleneck. The questions from the plan agent are usually right - intervention only happens when @product flags a documentation gap.

## Architecture Decisions

### Task note naming

Task note filenames are derived from note names. Ralph sanitizes names before creating bwrb notes:
- Replace path separators (`/` and `\`) with ` - `
- Replace other forbidden filename characters (`:*?"<>|`) with `-`
- Collapse whitespace, trim ends, and cap length to 180 characters
- If sanitization yields an empty name, use `Untitled`
- If a note already exists, append a short UUID suffix

### 1. Queue Lives in GitHub (migration: bwrb optional)

GitHub Issues are the source of truth for tasks during the GitHub-first migration:
- GitHub Issues + labels drive the queue
- `~/.ralph/state.sqlite` stores operational state for idempotency/recovery

bwrb remains supported as a legacy backend during the migration:
- Enable via `queueBackend = "bwrb"` in `~/.ralph/config.toml` or `~/.ralph/config.json`
- GitHub remains authoritative when both are configured (no dual-write in v0.1.0)
- GitHub queue sync/claim semantics are tracked in #61/#63; use bwrb backend for active queue processing until then
- When GitHub queue support is unavailable, Ralph falls back to bwrb if a valid vault is configured
- When GitHub is unavailable and no bwrb vault exists, Ralph runs in idle/no-queue mode and surfaces diagnostics
- Escalations and agent-run records remain bwrb-only until GitHub queue support ships

### 2. Bot Branch Strategy

Ralph/agents should merge to `bot/integration`, not `main` directly. Every ~10 PRs, create a rollup PR from `bot/integration` to `main` for batch human review.

If the bot branch is missing on the remote, create it from the repository default branch head before applying branch protections or running tasks.

Humans/maintainers may still merge directly to `main` when needed; the bot-branch strategy is a Ralph policy, not a repo-wide prohibition.

Rollup automation policy:
- Default batch size is 10 (configurable globally or per repo).
- If there are no queued or in-flight tasks for 5 minutes, check for unrolled changes on `bot/integration`.
- Create a rollup PR from `bot/integration` to `main` when there are unrolled changes, unless one is already open.

Benefits:
- Reduces interrupt frequency
- Batches related changes for easier review
- Provides a checkpoint for E2E testing

Operational details (merge recovery, worktree cleanup): see `docs/escalation-policy.md`.

### 3. Escalation-First Design

The system should bias toward proceeding, not asking. Escalate only when:
- Product documentation is genuinely missing
- Requirements are ambiguous and can't be resolved from context
- External blockers prevent progress

Most tasks should be treated as "implementation-ish" and proceed autonomously unless explicitly labeled `product`, `ux`, or `breaking-change` (labels increase escalation sensitivity; absence should not).

Implementation-ish tasks (including `dx`, `refactor`, `bug`) should almost never escalate on low-level details like error message wording.

### 4. Session Persistence

Tasks should survive daemon restarts. Store session IDs with tasks so work can resume where it left off.

### 5. Introspection and Anomaly Detection

Log tool calls and detect when agents get stuck (tool-result-as-text loops). Auto-recover from loops by nudging the agent.

**Watchdog policy:** In daemon mode, the system must never silently stall on a hung tool call.
- Soft timeout: log-only heartbeat (no interruption)
- Hard timeout: kill the in-flight run, re-queue once with a cleared `session-id`, then escalate if it repeats

**Diagnostics policy:** When OpenCode crashes and prints a log file path, Ralph may attach a redacted tail of that log to the error note to preserve debugging context before logs rotate. Redact obvious tokens (GitHub tokens, Bearer tokens, etc.), redact the local home directory in paths and attached excerpts (replace with `~`), and keep the attachment bounded (e.g. ~200 lines / 20k chars). These logs are local diagnostics artifacts and should not be posted externally (issues/PRs) without manual review.

**Stability policy:** To support safe parallelism, Ralph should avoid shared mutable tool caches between concurrent OpenCode runs (e.g. isolate `XDG_CACHE_HOME` per repo/task).

## Success Metrics

- **Escalation rate**: Should be <10% of tasks
- **PR acceptance rate**: Should be >95% (agents making good decisions)
- **Time to completion**: Tasks should complete without human intervention
- **Recovery rate**: Should resume successfully after restarts

## Future Enhancements

### Async Agent Communication

Agents leave notes for each other via bwrb:
- @devex: "The build system is fragile, be careful with X"
- @product: "Deprioritize feature Y, user research suggests Z"

This builds institutional knowledge that persists across sessions.

### AI Agents as E2E Testers

On rollup PRs, run AI agents through user flows:
- "You are a new user. Try to complete these flows..."
- Report friction, errors, UX degradation

Catches things deterministic tests miss.

### Small Model Routing

Use small/fast models for routing decisions, with shadow evaluation against large models to build confidence. Swap in small models once accuracy is proven.

### Full Transcript Logging

Every agent session dumps full chat history for:
- Audit agent review
- Post-hoc analysis of failures
- Training data for improvements

## Non-Goals

- **Real-time collaboration**: Ralph is async, queue-based
- **User-facing UI**: No end-user UI; operator tooling (local dashboard/control plane and TUI) is in-scope, with interaction still centered on bwrb notes and PRs
- **Multi-tenant**: Single-user orchestration for now
