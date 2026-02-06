# Label Scheme Migration: Legacy -> vNext

Ralph vNext uses namespaced labels:

- `ralph:status:*` (Ralph-managed)
- `ralph:priority:*` (operator-owned)
- `ralph:intent:*` (operator-owned)
- `ralph:artifact:*` (operator-owned)
- `ralph:priority:*` (operator-owned)

Legacy workflow labels (unqualified `ralph:<state>`) are not supported after cutover. If any OPEN issue/PR in a repo has a legacy label, Ralph treats the repo as **unschedulable** and will not claim work.

Canonical spec: `docs/product/orchestration-contract.md`.

Priority note:

- Canonical priority labels are `ralph:priority:p0`..`ralph:priority:p4`.
- Legacy non-namespaced `p0`..`p4` labels are deprecated and treated as read-only fallback only when no `ralph:priority:*` labels exist.

## Legacy Label Set (Migration Errors)

- `ralph:queued`
- `ralph:in-progress`
- `ralph:blocked`
- `ralph:escalated`
- `ralph:stuck`
- `ralph:in-bot`
- `ralph:done`

## Mapping

Relabel by removing the legacy label and adding the vNext label:

- `ralph:queued` -> `ralph:status:queued`
- `ralph:in-progress` -> `ralph:status:in-progress`
- `ralph:blocked` -> `ralph:status:escalated`
- `ralph:escalated` -> `ralph:status:escalated`
- `ralph:stuck` -> `ralph:status:in-progress`
- `ralph:in-bot` -> `ralph:status:in-bot`
- `ralph:done` -> `ralph:status:done`

## Priority labels

Priority is now expressed via `ralph:priority:p0`..`ralph:priority:p4`.

- Ralph only mutates `ralph:*` labels; it does not add/remove legacy `p0-critical`/`p2-medium` labels.
- If you still have legacy priority labels, add the corresponding `ralph:priority:*` label to migrate.

## Checklist

1. Ensure the vNext labels exist.
   - Easiest: run the daemon once with GitHub auth configured; Ralph will bootstrap `ralph:status:*` + starter `ralph:intent:*`/`ralph:artifact:*`.
2. Find any OPEN issues/PRs with legacy labels.
3. Apply the mapping above (remove legacy, add vNext).
4. Re-run `bun run status` and confirm the legacy-label diagnostic is gone.

## Script Snippet (gh + jq)

This snippet relabels OPEN issues and PRs in-place.

Requirements:

- `gh auth status` succeeds for the target repo.
- `jq` installed.

```bash
set -euo pipefail

REPO="OWNER/REPO"

declare -a LEGACY=(
  "ralph:queued"
  "ralph:in-progress"
  "ralph:blocked"
  "ralph:escalated"
  "ralph:stuck"
  "ralph:in-bot"
  "ralph:done"
)

map_label() {
  case "$1" in
    "ralph:queued") echo "ralph:status:queued" ;;
    "ralph:in-progress") echo "ralph:status:in-progress" ;;
  "ralph:blocked") echo "ralph:status:escalated" ;;
  "ralph:escalated") echo "ralph:status:escalated" ;;
    "ralph:stuck") echo "ralph:status:in-progress" ;;
    "ralph:in-bot") echo "ralph:status:in-bot" ;;
    "ralph:done") echo "ralph:status:done" ;;
    *) return 1 ;;
  esac
}

for legacy in "${LEGACY[@]}"; do
  next="$(map_label "$legacy")"

  # Issues
  gh issue list --repo "$REPO" --state open --label "$legacy" --json number --limit 1000 |
    jq -r '.[].number' |
    while read -r n; do
      gh issue edit "$n" --repo "$REPO" --remove-label "$legacy" --add-label "$next"
    done

  # PRs
  gh pr list --repo "$REPO" --state open --label "$legacy" --json number --limit 1000 |
    jq -r '.[].number' |
    while read -r n; do
      gh pr edit "$n" --repo "$REPO" --remove-label "$legacy" --add-label "$next"
    done
done
```

Notes:

- The mapping is intentionally manual/big-bang: there is no auto-translation in Ralph.
- `ralph:status:queued` is claimable when dependency metadata is clear (see `docs/product/orchestration-contract.md`).
