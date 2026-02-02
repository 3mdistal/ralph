# Worktree Management

Status: non-canonical (reference)
Owner: @3mdistal
Last updated: 2026-02-01

Ralph isolates task work in per-repo worktrees.

Canonical claims live in `claims/canonical.jsonl`.

## Managed worktree root

Default:

- `~/.ralph/worktrees`

Override:

- `RALPH_WORKTREES_DIR` (absolute path, or relative to current working directory).

## Layout

Ralph isolates task work in per-repo worktrees under:

```
~/.ralph/worktrees/<repoKey>/slot-<slot>/<issueNumber>/<taskKey>
```

## Legacy worktrees

Older runs may have created worktrees under a shared developer directory (for example, `~/Developer/worktree-issue-<n>`).

Current policy (warn-only):

- Ralph detects legacy worktrees and logs a bounded warning.
- Ralph does not auto-delete or auto-migrate legacy worktrees.
- Cleanup is manual and should be done only after verifying a worktree is safe to remove.

Manual cleanup example:

```
git -C <repo-path> worktree list
git -C <repo-path> worktree remove <legacy-path>
```
