# Ralph Loop - Product Vision

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

## What is Ralph?

Ralph Loop is an autonomous orchestration layer that manages a queue of coding tasks across repos, dispatches work to OpenCode agents, and surfaces only the decisions that require human judgment.

## Core Principle

**Minimize human interrupt surface.** Ralph should proceed autonomously, and escalate only when human intervention is required.

Everything else should proceed autonomously.

## Escalation Markers

Escalation marker parsing must be deterministic and machine-parseable.

Canonical spec: `docs/escalation-policy.md`.

Keep this doc focused on product intent; update routing/escalation policy in one place.

## Related Product Docs

- `docs/product/initiatives.md`

## The Problem We're Solving

The manual workflow is effective but repetitive:
1. Spin up OpenCode session
2. Run planner prompt with `--agent ralph-plan` - plan agent consults @product, asks questions
3. Agent builds (worktree, commits, tests)
4. Agent presents PR - human says "looks good, merge and clean up"
5. Run `/survey` - emits structured DX feedback and files GitHub issues (job record + actionable work items)

When reviewing ~40 PRs/day and almost never rejecting them, the human becomes a bottleneck. The questions from the plan agent are usually right - intervention only happens when @product flags a documentation gap.

## Architecture Decisions

### 1. GitHub-first orchestration

GitHub Issues + comments are the operator UX and source of truth for queue membership.
SQLite under `~/.ralph` stores durable internal state (sessions, worktrees, cursors, run records).

Canonical contract: `docs/product/orchestration-contract.md`.

### 2. Bot Branch Strategy

Ralph/agents should merge to `bot/integration`, not `main` directly. Every ~10 PRs, create a rollup PR from `bot/integration` to `main` for batch human review.

If the bot branch is missing on the remote, create it from the repository default branch head before applying branch protections or running tasks.

Humans/maintainers may still merge directly to `main` when needed; the bot-branch strategy is a Ralph policy, not a repo-wide prohibition.

Rollup automation policy:
- Default batch size is 10 (configurable globally or per repo).
- If there are no queued or in-flight tasks for 5 minutes, check for unrolled changes on `bot/integration`.
- Create a rollup PR from `bot/integration` to `main` when there are unrolled changes, unless one is already open.

Merge gating defaults:
- Policy decision: when Ralph derives required checks from branch protection and protection is missing or unreadable, it should fail open (treat required checks as empty) to avoid blocking automation.
- Policy decision: branch protection enforcement (and bot branch creation for enforcement) only runs when `repos[].requiredChecks` is explicitly configured; otherwise leave existing branch protection unchanged.

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

### 6. Managed OpenCode Config Contract

For daemon runs, Ralph owns the OpenCode agent configuration to keep behavior deterministic across repos and machines.

- Ralph sets `OPENCODE_CONFIG_DIR` to a Ralph-managed directory (default: `$HOME/.ralph/opencode`).
- Repo-local OpenCode config and pre-set `OPENCODE_CONFIG_DIR` are ignored for daemon runs.
- The managed directory is overwritten on daemon startup to match the version shipped with Ralph.
- Overrides are allowed only via explicit Ralph configuration (`opencode.managedConfigDir`) or `RALPH_OPENCODE_CONFIG_DIR`.
- Operators should not edit the managed directory directly; changes must come from Ralph template updates.
- Running multiple daemons on the same machine is unsupported; the managed config is a shared resource and the latest daemon startup wins.

## Success Metrics

- **Escalation rate**: Should be <10% of tasks
- **PR acceptance rate**: Should be >95% (agents making good decisions)
- **Merge rate**: % of queued tasks merged without human intervention should trend upward
- **Recovery rate**: Should resume successfully after restarts

## Future Enhancements

### Async Agent Communication

Agents should leave durable, discoverable notes for each other (e.g. GitHub comments or future claim artifacts) to build institutional knowledge that persists across sessions.

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
- **User-facing UI**: No end-user UI; operator tooling (local dashboard/control plane and TUI) is in-scope
- **Multi-tenant**: Single-user orchestration for now
