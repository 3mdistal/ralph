# GitHub-first orchestration contract

This document defines the v0.1.0 GitHub-first contract for Ralph. GitHub Issues are the
source of truth for queue state and dependency relationships. SQLite is the durable
operational state store under `~/.ralph`.

## Source of truth boundaries

- GitHub Issues are authoritative for: queue state, dependency graph, and completion status.
- SQLite is authoritative for: session IDs, worktree paths, heartbeat/ownership, retry counters,
  and last-sync cursors. These do not round-trip to GitHub.
- bwrb notes (if present) are optional audit artifacts, not the queue source of truth.

## Ralph-managed labels

Ralph only manages namespaced labels under `ralph:*` and never edits unrelated labels.

| Label | Meaning | Color |
| --- | --- | --- |
| `ralph:queued` | Ready to be claimed by Ralph | `0366D6` |
| `ralph:in-progress` | Ralph is actively working | `FBCA04` |
| `ralph:in-bot` | Task PR merged to `bot/integration` | `0E8A16` |
| `ralph:blocked` | Blocked by dependencies | `D73A4A` |
| `ralph:escalated` | Waiting on human input | `B60205` |

## Dependency encoding

Dependencies are encoded in issue bodies with deterministic section headers and task lists.

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
- GitHub-native relationships are authoritative, but body-parsed blockers are still honored.
- If GitHub-native relationships are unavailable, Ralph falls back to `## Blocked by` body parsing.
- Precedence uses a union: **blocked wins**. If any authoritative source reports an unresolved blocker, the issue is blocked.
- Unknown coverage: if neither GitHub-native relationships nor body sections yield evidence, Ralph does not change blocked state.
- Sub-issues: a parent issue is blocked while any sub-issue is open; sub-issues are not blocked by their parent.

Blocked enforcement:
- Blocked issues get the `ralph:blocked` label and their agent-task status is set to `blocked`.
- When unblocked, Ralph removes `ralph:blocked` and re-queues only tasks that were blocked due to dependencies.

Blocked attribution (`blocked-source` in agent-task frontmatter):
- `deps` - blocked by issue dependencies or sub-issues
- `allowlist` - repo owner not in allowlist
- `dirty-repo` - repo root has uncommitted changes
- `merge-target` - PR targets protected base (e.g. main without override)
- `ci-only` - CI-only PR for non-CI issue
- `merge-conflict` - PR has merge conflicts
- `auto-update` - failure while auto-updating PR branch
- `ci-failure` - required checks failed or non-actionable
- `runtime-error` - unexpected runtime failure while processing/resuming a task

## Done semantics (Pattern A)

- Issue remains open until the rollup PR merges to `main`.
- When a task PR merges to `bot/integration`, Ralph applies `ralph:in-bot` and clears `ralph:in-progress`.
- When the rollup PR merges to `main`, Ralph closes the issue and removes `ralph:in-bot`.

## Escalation protocol

- Ralph removes `ralph:in-progress` and `ralph:queued`, then adds `ralph:escalated`.
- Ralph posts a comment containing a stable hidden marker (e.g. `<!-- ralph-escalation:id=... -->`),
  the operator @mention, and resolution instructions.
- Operator @mention defaults to the repo owner handle (e.g. `@owner`); if no owner can be parsed, omit the mention.
- Resolution signals (either is sufficient):
  - A new operator comment contains `RALPH RESOLVED:`.
  - The operator re-adds `ralph:queued`.
- When resolved, Ralph removes `ralph:escalated` (and keeps `ralph:queued` if it was added).
