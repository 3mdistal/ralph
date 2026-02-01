<!-- Suggested path: docs/product/intent-artifact-orchestration.md -->

# Intent + Artifact Orchestration (vNext)

Status: archived
Owner: @3mdistal
Last updated: 2026-02-01

Status: target spec (product design). This document describes a v1 model for:

- namespaced GitHub labels (`ralph:*`) that separate workflow state from operator intent
- repo-local profiles that let Ralph “schlorp any repo” with minimal setup
- multiple orchestration pipelines (implement, research, write, spec, review-fix)

This doc complements (and will eventually supersede parts of) `docs/product/github-first-orchestration.md`.

## Goals

- Onboard a new repo quickly: point Ralph at a repo and it starts working reliably.
- Separate:
  - what Ralph is doing (status)
  - what the operator wants (intent)
  - what the output should be (artifact)
- Support non-code work (research/writing) as first-class flows.
- Support PR review autopilot (respond + fix on the same PR).
- Reduce costs by preferring shorter sessions when possible.
- Allow “stop on a dime” semantics (soft pause now; hard interrupt later).

Non-goals (v1):

- Renaming Ralph.
- Fully automatic intent detection. (Repo defaults + explicit labels drive behavior.)

## Label Taxonomy

All labels are in the global `ralph:` namespace. There are no unqualified `ralph:<state>` labels.

### Status labels (Ralph-managed)

Status describes the orchestration lifecycle. Ralph owns these labels (create/update/remove) and should not touch unrelated labels.

- `ralph:status:queued`
- `ralph:status:in-progress`
- `ralph:status:blocked`
- `ralph:status:paused`
- `ralph:status:throttled`
- `ralph:status:in-bot`
- `ralph:status:done`

Notes:

- `ralph:status:queued` is the only claimable state.
- `ralph:status:paused` is an operator-controlled stop switch.
- `ralph:status:done` is optional as a GitHub label; it can also be represented by “no ralph:status:* labels”. v1 keeps it as a label for clarity.

### Intent labels (operator-owned)

Intent describes *which orchestration harness/pipeline* to run.

v1 intents:

- `ralph:intent:implement`
- `ralph:intent:review-fix`
- `ralph:intent:research`
- `ralph:intent:write`
- `ralph:intent:brainstorm`
- `ralph:intent:spec`
- `ralph:intent:triage`

Ralph should treat intent labels as read-only inputs.

### Artifact labels (operator-owned)

Artifact describes *what output is expected* (and drives stopping points + approval gates).

v1 artifact labels are intentionally minimal; repos may add more.

- `ralph:artifact:comment`
- `ralph:artifact:pr`
- `ralph:artifact:merged-pr`
- `ralph:artifact:markdown`
- `ralph:artifact:pr-review-replies`
- `ralph:artifact:subissues`

Ralph should treat artifact labels as read-only inputs.

## Pipeline Selection

Ralph chooses a pipeline from (intent, artifact, repo profile) with deterministic precedence.

### Precedence (highest to lowest)

1. Explicit labels on the issue/PR:
   - `ralph:intent:*`
   - `ralph:artifact:*`
2. Optional issue/PR body fields (frontmatter or issue form fields) used as arguments (e.g. PR URL), not as the primary selector.
3. Repo profile defaults in `.ralph/config.toml`.
4. Global defaults in `~/.ralph/config.toml`.
5. Fallback: `intent=implement`, `artifact=pr`.

### When labels are missing

If an item is only labeled `ralph:status:queued`:

- Use repo defaults (`.ralph/config.toml`) if present.
- Otherwise default to implementation (`ralph:intent:implement` + `ralph:artifact:pr`).

## Repo Profiles

Repo-specific defaults and agent preferences live in-repo at `.ralph/config.toml`.
Global config in `~/.ralph/config.toml` provides defaults; repo config overrides keys.

### Minimal schema sketch (v1)

```toml
# .ralph/config.toml

[defaults]
# What to do when an issue is only `ralph:status:queued`.
intent = "implement"          # implement|research|write|brainstorm|spec|triage|review-fix
artifact = "pr"              # pr|merged-pr|comment|markdown|subissues|pr-review-replies

[agents]
# Preferred OpenCode agent per intent.
implement = "general"
review_fix = "general"
research = "web-research"
write = "writing"
brainstorm = "product"
spec = "product"
triage = "general"

[policy]
# Whether PR creation is allowed by default for non-code repos.
allow_pr_by_default = false

[review_fix]
# Whether PR review-fix autopilot is enabled for this repo.
enabled = true
```

## Onboarding: “Point at any repo”

For a newly added repo, `bun run status` should show a clear onboarding checklist with pass/fail indicators and actionable remediation.

Checklist (v1):

- Labels present: required `ralph:status:*` labels exist (and optional `ralph:intent:*`/`ralph:artifact:*` starter set).
- Permissions:
  - can create/update labels
  - can read branch protection / required checks
  - can merge PRs to bot branch (and optionally delete branches)
- Local checkout: repo `local_path` exists and is clean; worktrees can be created.
- CI requirements: configured required checks / bot branch policy is coherent.
- OpenCode setup: `opencode` is available; profile config is resolved; logs and state directories are writable.
- Rate limit: GitHub API quota is healthy; degraded mode is surfaced when not.

This checklist should be shown before the first queued task fails (fail-fast, explain early).

## Workflows (Examples)

### Implementation (default)

Input:

- Issue labeled: `ralph:status:queued`
- Repo defaults: `intent=implement`, `artifact=pr` (or explicit labels)

Expected behavior:

- Ralph claims the task: `ralph:status:in-progress`.
- Runs the deterministic implementation pipeline (see `docs/product/deterministic-gates.md`).
- Produces a PR to `bot/integration` (see `docs/product/vision.md`).
- If artifact is `ralph:artifact:merged-pr`, Ralph merges when gates pass.

### Research

Input:

- Issue labeled: `ralph:status:queued`, `ralph:intent:research`, `ralph:artifact:comment`

Expected behavior:

- Ralph posts a structured comment (sources, synthesis, recommendations).
- Ralph moves the issue to a waiting state if additional approval is needed (typically `ralph:status:blocked` with a clear “next action”).

### Brainstorm

Input:

- Issue labeled: `ralph:status:queued`, `ralph:intent:brainstorm`, `ralph:artifact:comment`

Expected behavior:

- Ralph posts options + a recommended direction.
- No code changes.
- Issue ends blocked for human decision.

### Spec (two-phase)

Input:

- Issue labeled: `ralph:status:queued`, `ralph:intent:spec`, `ralph:artifact:subissues`

Phase 1 behavior:

- Ralph drafts a proposed epic + sub-issues.
- Ralph creates the epic and sub-issues.
- Ralph does not queue implementation automatically.
- Ralph sets `ralph:status:blocked` with clear instructions.

Approval mechanism:

- Operator approval is represented by unblocking: transition from `ralph:status:blocked` back to `ralph:status:queued`.
- The operator may also add/adjust intent/artifact labels before re-queueing.

### PR review-fix (autopilot)

Canonical trigger:

- Apply `ralph:intent:review-fix` to the PR.

Behavior:

- Ralph reads review comments.
- If a sentence ends with `?`, Ralph replies directly.
- Ralph applies clear fixes and pushes commits to the same PR branch.
- If something is ambiguous, Ralph asks clarifying questions (in PR comments) and/or blocks waiting for an answer.

## Session Strategy (Cost Control)

Ralph should prefer a hybrid model:

- Implementation tasks are mostly single-session to preserve working memory (planner + implementation + follow-ups), with safe checkpoints.
- Non-code tasks (research/write/spec/brainstorm) are naturally short and should run in shorter sessions.
- Review-fix is separate from implementation and should run as a dedicated session per PR event burst.

This complements usage-based throttling (`docs/product/usage-throttling.md`) and enables “inspect expensive runs” flows.

## Stop / Pause Semantics

v1: label-based pause

- `ralph:status:paused` means: do not claim new work; do not continue in-flight work beyond safe checkpoints.
- Removing `ralph:status:paused` allows scheduling to resume.

vNext: hard interrupt

- A true “stop on a dime” requires OpenCode server APIs to abort in-flight model sends.
- When available, implement a hard interrupt command, but keep pause-at-checkpoints as the default safety mechanism.

## Guardrails

- Ralph never edits non-`ralph:*` labels.
- Intent/artifact labels are operator-owned signals; Ralph treats them as read-only.
- For `brainstorm` and `spec`, no code changes are allowed unless the operator explicitly re-queues with an implementation artifact.
- For non-code repos, whether PRs are allowed by default is repo-decided (`.ralph/config.toml`).
- When required data is missing (permissions, labels, local checkout), Ralph should fail fast with an onboarding checklist, not fail mid-run.

## Migration

v1 migration is a big-bang manual cutover:

- Operators relabel the backlog from old `ralph:*` labels to the new namespaced scheme.
- Ralph only understands the new labels.

## Related Docs

- `docs/product/github-first-orchestration.md`
- `docs/product/deterministic-gates.md`
- `docs/product/usage-throttling.md`
- `docs/escalation-policy.md`
