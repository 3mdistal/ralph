# Plan: 3mdistal/ralph#560 (RepoWorker Modularization Epic)

Assumption (based on prefetched dossier + GitHub state): sub-issues #561-#565 are already implemented and closed; remaining work is admin closeout with deterministic evidence.

Constraint reminder (from the epic): keep `RepoWorker` wrapper methods as monkeypatch seams; keep `src/worker.ts` a thin stable barrel.

## Evidence resolver (read-only)

- [x] Collect default branch head SHA (for reachability checks).
- [x] For each child issue (#561-#565), derive an evidence record:
      - closing PR number(s) (from timeline events; fallback: search merged PRs referencing the issue)
      - merge commit SHA (preferred) or a documented fallback SHA
      - reachable-from-default-branch: yes/no
- [x] Deterministic tie-breakers:
      - Prefer the PR that closed the issue (close event) over merely mentioning it.
      - If multiple PRs qualify, pick the one whose merge commit is reachable from default branch and has the latest merged_at.
- [x] Decision matrix:
      - If any child lacks a reachable-from-default SHA, do NOT close the epic; instead, record what evidence is missing and stop.
      - Outcome: all child merge SHAs are reachable from `origin/main`.

## Invariant verification (read-only)

- [x] Verify monkeypatch seams still exist (spot-check: `RepoWorker` method wrappers remain on the class and delegate internally).
- [x] Verify `src/worker.ts` remains a thin re-export barrel for `RepoWorker` from `src/worker/repo-worker.ts`.

## Epic closeout (writeback)

- [ ] Post/update ONE idempotent epic comment containing:
      - evidence table (child issue -> PR -> merge SHA -> reachable-from-default)
      - confirmation of the two invariants
      - marker: `<!-- ralph-epic-close:v1 id=560 -->`
- [ ] Apply status reconciliation: ensure exactly one `ralph:status:*` label remains (set `ralph:status:done`).
- [ ] Close #560.

Writeback note: blocked in this daemon run because GitHub mutating actions are disabled by run policy. Evidence and a ready-to-post closeout comment template are in `.ralph/issue-560-evidence.md`.

Note: do not use the parent-verification no-PR completion path (`<!-- ralph-verify:v1 -->` / `RALPH_VERIFY`) here; that exception is reserved for the parent verification lane per `docs/product/orchestration-contract.md`.

## Sanity checks (best-effort)

- [ ] Confirm no local worktree/branch for #560 is dirty (avoid `blocked:dirty-repo`).
      - Current worktree is intentionally dirty with local planning/evidence docs in this run.
- [x] If any PR is needed for auditability, target `bot/integration` (never `main`).
