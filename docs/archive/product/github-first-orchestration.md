# GitHub-first orchestration contract (legacy)

Status: archived
Owner: @3mdistal
Last updated: 2026-02-01

This document defines the legacy v0.1.0 GitHub-first contract for Ralph. GitHub Issues are the
source of truth for queue state and dependency relationships. SQLite is the durable
operational state store under `~/.ralph`.

Migration policy for `state.sqlite`: see `docs/ops/state-sqlite.md`.

## Source of truth boundaries

- GitHub Issues are authoritative for: queue state, dependency graph, and completion status.
- SQLite is authoritative for: session IDs, worktree paths, heartbeat/ownership, retry counters,
  and last-sync cursors. These do not round-trip to GitHub.
- bwrb notes (if present) are optional audit artifacts, not the queue source of truth.

## Ralph-managed labels

Ralph only manages namespaced labels under `ralph:*` and never edits unrelated labels.
The label descriptions and colors are enforced to match `src/github-labels.ts` (`RALPH_WORKFLOW_LABELS`); the "Meaning" column is the exact GitHub label `description` Ralph applies.

| Label | Meaning | Color |
| --- | --- | --- |
| `ralph:queued` | In queue; claimable when not blocked or escalated | `0366D6` |
| `ralph:in-progress` | Ralph is actively working | `FBCA04` |
| `ralph:in-bot` | Task PR merged to `bot/integration` | `0E8A16` |
| `ralph:blocked` | Blocked by dependencies | `D73A4A` |
| `ralph:stuck` | CI remediation in progress | `F9A825` |
| `ralph:done` | Task merged to default branch | `1A7F37` |
| `ralph:escalated` | Waiting on human input | `B60205` |

### Degraded mode: label writes unavailable

GitHub label writes are best-effort. When label mutations are throttled or blocked by GitHub (secondary rate limits, abuse detection, or temporary blocks), Ralph continues scheduling based on local SQLite ownership/heartbeat state and records a label-write backoff window.

Behavior:
- GitHub labels may temporarily drift from local truth (for example, `ralph:in-progress` may remain visible while the local slot is released).
- Scheduling and slot release must not depend on GitHub label writes.
- Ralph emits a degraded-mode signal in logs/status: `Queue backend: github (degraded)` with diagnostics like `label writes blocked until <iso>`.
- Labels converge via best-effort reconciliation once GitHub writes resume.

## Operator-owned priority labels

Operators can influence queue ordering by applying `p0`-`p4` labels on GitHub issues. Ralph infers task priority from
these labels but does not create or manage them.

Rules:
- Any label whose name starts with `p0`, `p1`, `p2`, `p3`, or `p4` (case-insensitive) is treated as a priority label.
- Mapping:
  - `p0*` -> `p0-critical`
  - `p1*` -> `p1-high`
  - `p2*` -> `p2-medium`
  - `p3*` -> `p3-low`
  - `p4*` -> `p4-backlog`
- If multiple priority labels are present, the highest priority (lowest number) wins.
- If no priority labels are present, Ralph defaults to `p2-medium`.

Note: scheduler "priority tasks" are reserved for resume work and are separate from label-based priority.

## Claim semantics + daemon model

- Ralph treats `ralph:queued` as the only claimable state once it is not blocked or escalated. Claiming means applying `ralph:in-progress` and removing `ralph:queued`.
- Claiming is best-effort and not transactional across multiple GitHub label updates.
- Deployment model: **single daemon per queue**. Running multiple daemons against the same GitHub queue is unsupported.
- Stale recovery: Ralph only re-queues `ralph:in-progress` issues when the stored `heartbeat-at` exists and is stale beyond `ownershipTtlMs`.
  Missing or invalid heartbeats do not trigger automatic recovery.
- Orphan PR reconciliation: if an issue is `ralph:queued` but already has an open PR authored by the configured Ralph GitHub App that closes the issue (e.g. `Fixes #123`) and is mergeable into `bot/integration`, Ralph merges it and applies `ralph:in-bot`.

## Auto-queue (optional)

Auto-queue is opt-in per repo and reconciles GitHub issues into the Ralph workflow based on dependency state.

Config (`repos[].autoQueue`):
- `enabled` (boolean): enable auto-queue reconciliation (default: false)
- `scope` (string): `labeled-only` or `all-open` (default: `labeled-only`)
- `maxPerTick` (number): cap issues reconciled per sync tick (default: 200)
- `dryRun` (boolean): compute decisions without mutating labels (default: false)

Behavior (when enabled):
- Evaluates open issues for dependency/sub-issue blockers using GitHub-native relationships (body parsing is fallback).
- Adds/removes `ralph:blocked` and `ralph:queued` labels based on blocked state.
- Skips issues already in `ralph:in-progress`, `ralph:escalated`, or `ralph:done` states.

## Dependency encoding

Dependencies can be encoded in issue bodies with deterministic section headers and task lists.
Body checklists are a fallback when GitHub-native relationships are unavailable.

```
## Blocked by
- [ ] #123 Description
- [x] owner/repo#456 Optional text

## Blocks
- [ ] #789
```

Rules:
- Ralph only parses list items that begin with an issue reference (`#123` or `owner/repo#123`).
- Checked items (`[x]`) are treated as resolved blockers.
- Ralph treats these sections as read-only in v0.1.0 (no auto-editing).

## Relationship precedence + blocked semantics

Ralph treats GitHub-native issue relationships as the primary source of truth while still honoring body-encoded blockers.
This section supersedes the v0.1.0 body-only dependency encoding; body parsing remains the fallback when relationships are unavailable.

Rules:
- Relationship sources: GitHub dependencies (`blocked_by` / `blocking`) and sub-issues (`parent` / `sub_issues`).
- GitHub-native relationships are authoritative when dependency coverage is complete; body-parsed blockers are ignored in that case.
- If GitHub dependency data is unavailable, Ralph falls back to `## Blocked by` body parsing.
- If GitHub dependency data is partial (relationships returned but coverage is incomplete, such as page-size truncation), Ralph treats the dependency status as unknown and does not change blocked state unless an explicit open GitHub blocker exists.
- Precedence uses a union across GitHub sources: **blocked wins**. If any GitHub relationship reports an unresolved blocker, the issue is blocked.
- Unknown coverage: if neither GitHub-native relationships nor body sections yield evidence, Ralph does not change blocked state.
- Sub-issues: a parent issue is blocked while any sub-issue is open; sub-issues are not blocked by their parent.

Blocked enforcement:
- Blocked issues get the `ralph:blocked` label and their agent-task status is set to `blocked`.
- When unblocked, Ralph removes `ralph:blocked` and re-queues only tasks that were blocked due to dependencies.

Parent verification lane:
- When dependency blockers clear, Ralph runs a lightweight parent verification lane before full implementation.
- The lane emits a deterministic marker and either proceeds to implementation or escalates with a "close or clarify" summary.
- See `docs/product/parent-verification-lane.md` for the detailed contract.

Blocked attribution (`blocked-source` in agent-task frontmatter):
- `deps` - blocked by issue dependencies or sub-issues
- `allowlist` - repo owner not in allowlist
- `dirty-repo` - repo root has uncommitted changes (only blocks when a task would run in the main checkout; isolated worktrees may proceed)
- `merge-target` - PR targets protected base (e.g. main without override)
- `ci-only` - CI-only PR for non-CI issue
- `merge-conflict` - PR has merge conflicts
- `auto-update` - failure while auto-updating PR branch
- `ci-failure` - required checks failed or non-actionable
- `runtime-error` - unexpected runtime failure while processing/resuming a task

Blocked metadata (agent-task frontmatter):
- `blocked-at` - ISO timestamp for when the task entered blocked (resets only when the blocked signature changes)
- `blocked-reason` - short human-readable summary (bounded)
- `blocked-details` - truncated diagnostics (redacted) used for status snippets and run notes
- `blocked-checked-at` - last time blocked state was evaluated

Requeue resolution (non-dependency blocked tasks):
- Operators requeue by re-adding `ralph:queued` on the issue.
- Ralph removes the `ralph:blocked` label when it claims the issue again.
- When Ralph claims the task again, it clears all `blocked-*` metadata and resumes work.
- If a `session-id` exists, Ralph resumes the prior OpenCode session; otherwise it starts a fresh session.
- Requeue does not override dependency blockers; if dependencies are still open, Ralph keeps the issue blocked.
- In that case Ralph leaves `ralph:queued` in place and rechecks when dependencies change.

## Done semantics (Pattern A)

- Issue remains open until the rollup PR merges to `main`.
- When a task PR merges to `bot/integration`, Ralph applies `ralph:in-bot` and clears `ralph:in-progress`.
- When the rollup PR merges to `main`, Ralph applies `ralph:done` and clears transitional labels (`ralph:in-bot`, `ralph:in-progress`, `ralph:blocked`, `ralph:escalated`, `ralph:queued`).
- Closing the issue remains a separate policy decision (not required for done).

### Verification-only completion (parent issues)

When a parent issue becomes runnable after all sub-issues close, Ralph runs a verification-only pass seeded with child issues + linked PRs/merges.

- If verification shows the parent is already satisfied, Ralph posts a single canonical comment: "Verification complete — no changes required" with evidence links, removes `ralph:queued` (if present) + `ralph:escalated`, and closes the issue.
- This path completes the task without a PR URL and does **not** imply `ralph:done` merge semantics.
- If verification finds remaining work (or is inconclusive), Ralph proceeds with the normal implement + PR flow.

Direct-to-main (override / Pattern B):
- If a task PR is merged directly to `main` (or the repo config sets `botBranch: main`), Ralph does **not** apply the
  `ralph:in-bot` midpoint label, but **does** clear `ralph:in-progress` as part of the merge step.
- Direct-to-main merges leave the issue open; closing behavior is handled by a separate policy (manual or future
  automation).
- `ralph:done` is applied once the merge to the default branch is reconciled, regardless of whether it was a rollup
  or direct-to-main merge.
- If a task PR merges to a non-default branch (for example, a release branch), Ralph clears `ralph:in-progress` but does
  not apply `ralph:in-bot`.
- Midpoint label updates are best-effort and do not block merges; failures are surfaced via non-blocking notifications
  so operators can resolve GitHub permission/config issues without interrupting the queue.

Default-branch unknown fallback:
- If Ralph cannot determine the repo default branch (e.g. GitHub API auth failure), it applies the midpoint
  `ralph:in-bot` label only when the configured bot branch name is clearly a bot branch (currently `bot/integration`
  or any `bot/*` branch). In all other cases it avoids applying `ralph:in-bot`.

## Duplicate PR handling

- When multiple open PRs are detected for the same issue, Ralph selects a canonical PR deterministically and continues.
- Ralph does not auto-close or comment on duplicates by default.
- Duplicates are surfaced via logs/run notes for operator awareness.

## Escalation protocol

- Ralph removes `ralph:in-progress` and `ralph:queued`, then adds `ralph:escalated`.
- Ralph posts a comment containing a stable hidden marker (e.g. `<!-- ralph-escalation:id=... -->`),
  the operator @mention, and resolution instructions.
- If the issue re-escalates and the marker comment is discoverable, Ralph updates the existing escalation comment
  with the latest reason/instructions instead of posting a duplicate.
- If the marker comment is not discoverable within the comment scan window, Ralph posts a fresh canonical escalation
  comment to ensure the latest required input is visible.
- Operator @mention defaults to the repo owner handle (e.g. `@owner`); if no owner can be parsed, omit the mention.
- Resolution signals (either is sufficient):
  - A new operator comment contains `RALPH RESOLVED:` (only honored when authored by the repo owner or an `OWNER`/`MEMBER`/`COLLABORATOR`).
  - The operator re-adds `ralph:queued`.
- When resolved, Ralph removes `ralph:escalated` (and keeps `ralph:queued` if it was added).
