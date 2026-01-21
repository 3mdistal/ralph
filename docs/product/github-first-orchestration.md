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

## Done semantics (Pattern A)

- Issue remains open until the rollup PR merges to `main`.
- When a task PR merges to `bot/integration`, Ralph applies `ralph:in-bot` and clears `ralph:in-progress`.
- When the rollup PR merges to `main`, Ralph closes the issue and removes `ralph:in-bot`.

## Escalation protocol

- Ralph adds `ralph:escalated` and posts a comment containing a stable hidden marker
  (e.g. `<!-- ralph-escalation:id=... -->`) and resolution instructions.
- Resolution is detected when a new operator comment contains `RALPH RESOLVED:`.
