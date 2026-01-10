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

When a model identifies a documentation gap, it must output an explicit, machine-parseable marker.

- **Product gap (positive):** a line starting with `PRODUCT GAP:` (case-insensitive), optionally bullet-prefixed (`- ` or `* `).
- **Product gap (negative):** a line starting with `NO PRODUCT GAP:` (case-insensitive), optionally bullet-prefixed.
- **Not a marker:** `PRODUCT GAP` without a trailing `:` or mentions mid-line (e.g. `Here is the marker: PRODUCT GAP: ...`).

This keeps escalation detection deterministic and prevents accidental escalations from quoted text or fuzzy phrasing (e.g. “not documented”).

## The Problem We're Solving

The manual workflow is effective but repetitive:
1. Spin up OpenCode session
2. Run `/next-task <issue>` - plan agent consults @product, asks questions
3. Agent builds (worktree, commits, tests)
4. Agent presents PR - human says "looks good, merge and clean up"
5. Run `/survey` - @devex recommends issues

When reviewing ~40 PRs/day and almost never rejecting them, the human becomes a bottleneck. The questions from the plan agent are usually right - intervention only happens when @product flags a documentation gap.

## Architecture Decisions

### 1. Queue Lives in bwrb

Use bwrb notes for task management:
- `agent-task` - Work items in the queue
- `agent-run` - Completed work records with decisions
- `agent-escalation` - Items needing human attention

This provides full auditability and integrates with existing Obsidian workflows.

### 2. Bot Branch Strategy

Agents merge to `bot/integration`, not main directly. Every ~10 PRs, create a rollup PR to main for batch human review.

Benefits:
- Reduces interrupt frequency
- Batches related changes for easier review
- Provides a checkpoint for E2E testing

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

**Diagnostics policy:** When OpenCode crashes and prints a log file path, Ralph may attach a redacted tail of that log to the error note to preserve debugging context before logs rotate. Redact obvious tokens (GitHub tokens, Bearer tokens, etc.) and keep the attachment bounded (e.g. ~200 lines / 20k chars). These logs are local diagnostics artifacts and should not be posted externally (issues/PRs) without manual review.

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
- **User-facing UI**: Interaction is through bwrb notes and PRs
- **Multi-tenant**: Single-user orchestration for now
