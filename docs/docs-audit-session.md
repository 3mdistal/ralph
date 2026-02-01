# Ralph Docs Audit Session Notes

Date: 2026-02-01
Branch: chore/ralph-docs-audit

This document captures decisions and discoveries made during an interactive audit of the Ralph documentation set.

## Goals

- Reduce contradictions across docs.
- Clarify what is canonical vs derivative.
- Align docs with current repo reality.
- Preserve/redirect references from open issues.

## Working Agreements

- Prefer a small set of canonical docs; everything else links to canon.
- If reality differs from docs: either update docs to match reality, or mark as planned and link an issue.
- When moving/removing docs, avoid breaking existing links: leave stubs or update referenced issues.

## Current State (Initial)

- Interview + repo scan in progress.

## Canon Candidates (Seeded From AGENTS.md)

- `docs/escalation-policy.md`
- `docs/product/vision.md`
- `docs/product/deterministic-gates.md`
- `docs/ops/ci-checks.md`

## Decisions

- Treat `main` as the branch that defines "current reality" for docs.
- Canonical doc set (target, 5-8):
  - `docs/product/vision.md`
  - `docs/product/orchestration-contract.md` (new; unify labels+commands+queue contract)
  - `docs/escalation-policy.md`
  - `docs/product/deterministic-gates.md`
  - `docs/ops/state-sqlite.md`
  - `docs/ops/opencode-managed-config.md`
  - `docs/ops/ci-checks.md`
  - `docs/product/usage-throttling.md` (kept canonical for now)
- Label model target: vNext namespaced status + cmd labels.
  - Mutually-exclusive statuses:
    - `ralph:status:queued`
    - `ralph:status:in-progress`
    - `ralph:status:paused`
    - `ralph:status:escalated`
    - `ralph:status:in-bot` (merged to bot branch)
    - `ralph:status:done` (merged to default branch)
    - `ralph:status:stopped` (operator cancelled)
- Operator command labels (ephemeral): `ralph:cmd:queue`, `ralph:cmd:pause`, `ralph:cmd:stop`, `ralph:cmd:satisfy`.
- `ralph:cmd:queue` target semantics: clears stop/pause/escalation state and re-queues ("clear everything").
- Throttling target: global daemon state only (no per-issue `ralph:status:throttled`).
- Issue closure target: Ralph closes issues when `ralph:status:done` is reached (definition TBD, but "reconciled to default branch").
- Dependency-blocked is internal-only metadata (not a visible GitHub status label).
- Escalation semantics: broaden; `escalated` means "needs human intervention" (not only product gaps).
- bwrb-backed queue is dead (target: remove from docs and converge code later).
- Draft/initiative docs should be moved under `docs/archive/` (leave stubs at old paths when helpful).
- Sandbox provisioning stays in-scope and should be updated to the vNext label/command surface.

## Open Questions

- What commitments in docs must be treated as promises vs aspirational (target: make `must/should` hard promises again)?
- How do we deprecate legacy concepts (e.g. bwrb) without leaving contradictions?

## Discoveries Log

### Interview 1 (2026-02-01)

- Ralph intent (today): "set it and forget it" bot that consumes queued GitHub issues and lands PRs into `bot/integration`, escalating only on true product decisions.
- Ralph reality (today): needs significant human help; hits rate limits; can stall silently; fully autonomous merges are ~10%.
- Users: primarily solo operator (you) today.
- Docs semantics: `must/should` are intended as hard promises, but drifted.
- North star reference: `https://github.com/3mdistal/ralph/issues/460` ("where Ralph is headed soon").
- Suspected drift themes:
  - Legacy ideas linger too long (example: bwrb deprecation intention vs continued presence).
  - GitHub as source of truth vs Ralph overriding label intent.
  - Observability gap: hard to tell why failures happen; daily "patching holes" makes progress hard to see.

### Repo Scan (docs) (2026-02-01)

- Docs present (non-exhaustive): `docs/escalation-policy.md`, `docs/ops/ci-checks.md`, `docs/ops/opencode-usage-throttling.md`, `docs/ops/opencode-managed-config.md`, `docs/ops/state-sqlite.md`, plus multiple docs under `docs/product/`.
- bwrb appears prominently in `docs/product/vision.md` and multiple other product docs (dashboard MVP, drain/restart, deterministic gates note about `.bwrb/schema.json`, etc.). This is a likely contradiction with the intended bwrb deprecation.

### Repo Scan (initiative docs) (2026-02-01)

- Draft initiative docs (currently in `docs/product/` or `docs/ops/`):
  - `docs/product/dashboard-mvp-control-plane-tui.md` (draft; still references bwrb for task controls)
  - `docs/product/graceful-drain-rolling-restart.md` (draft; HITL protocol described in bwrb note terms)
  - `docs/product/usage-throttling.md` (draft policy; strong requirements)
  - `docs/ops/opencode-usage-throttling.md` (draft ops notes; implementation/calibration)

### Contradictions / Drift Candidates (first pass)

- Labels model drift:
  - `docs/product/github-first-orchestration.md` documents v0.1 labels (`ralph:queued`, `ralph:blocked`, etc.).
  - `docs/product/intent-artifact-orchestration.md` documents vNext namespaced labels (`ralph:status:*`, `ralph:intent:*`, `ralph:artifact:*`) and uses `blocked` as a status.
  - Issue #494 proposes vNext operator command labels `ralph:cmd:*` + mutually-exclusive `ralph:status:*`, and explicitly discusses removing/avoiding `blocked` as a visible GitHub status.
  - Operator decision: dependency-blocked should be internal-only metadata (not a visible GitHub status label).
- Escalation semantics drift:
  - `docs/escalation-policy.md` currently scopes escalation to: product doc gaps, blocked work, and contract-surface questions.
  - Operator intent: "escalated" means "needs human intervention" broadly; we should progressively reduce escalations by adding lanes (CI-debug, merge-conflict, etc.).
- bwrb-backed queue is dead (operator intent), but:
  - `docs/product/vision.md` still includes bwrb queue/notes semantics.
  - `docs/product/dashboard-mvp-control-plane-tui.md` still assumes bwrb-backed task IDs and priority edits.
  - Code still contains bwrb queue backend; docs will describe target state instead and link gaps.
- Sandbox provisioning uses `ralph:queued` in seed examples (`docs/product/sandbox-provisioning.md`), which likely conflicts with vNext `ralph:status:*` naming.

### Edits Applied (so far) (2026-02-01)

- Added canonical orchestration surface doc: `docs/product/orchestration-contract.md`.
- Updated canonical docs to align with vNext labels/commands and remove bwrb-first framing:
  - `docs/product/vision.md`
  - `docs/escalation-policy.md`
  - `docs/product/deterministic-gates.md`
  - `docs/product/sandbox-provisioning.md`
  - `docs/product/usage-throttling.md`
  - `docs/ops/state-sqlite.md`
  - `docs/ops/opencode-managed-config.md`
  - `docs/ops/ci-checks.md`
- Archived legacy/initiative docs (kept stubs at original paths):
  - `docs/product/github-first-orchestration.md` -> `docs/archive/product/github-first-orchestration.md`
  - `docs/product/intent-artifact-orchestration.md` -> `docs/archive/product/intent-artifact-orchestration.md`
  - `docs/product/dashboard-mvp-control-plane-tui.md` -> `docs/archive/product/dashboard-mvp-control-plane-tui.md`
  - `docs/product/graceful-drain-rolling-restart.md` -> `docs/archive/product/graceful-drain-rolling-restart.md`
  - `docs/product/opencode-sdk-migration.md` -> `docs/archive/product/opencode-sdk-migration.md`
- Marked smaller docs as explicitly non-canonical:
  - `docs/product/worktree-management.md`
  - `docs/product/parent-verification-lane.md`
- Updated `AGENTS.md` canonical doc list.

### Claims Ledger Progress (2026-02-01)

- Added initial claims ledger scaffolding:
  - `claims/README.md`
  - `claims/domains.json`
  - `claims/canonical.jsonl`
- Added a candidate-claim inbox:
  - `claims/candidates.jsonl`
- Intention: non-canonical docs may still contribute individual claims; the claim becomes canonical by inclusion in `claims/canonical.jsonl`.

### Interview 2 (2026-02-01)

- Desired storage model: GitHub + SQLite (operator desires to deprecate bwrb).
- bwrb status: unknown in real operation; needs investigation.
- Deprecation preference: hard cutover (remove bwrb from docs rather than long deprecation window).
- GitHub source-of-truth surface: labels + comments.
- Label ownership: Ralph should only manage `ralph:*` labels.
- Primary success metric: merge rate (% of queued tasks merged without help).
- Link preservation: ok to leave minimal stub docs at old paths that redirect.
- Claims direction (Issue #460): docs become atomic claims; Ralph self-heals repo to match claims.

### Interview 3 (2026-02-01)

- Docs posture: prefer docs to describe the target system (GitHub + SQLite), with explicit "planned" gaps rather than documenting bwrb reality.
- Canon size goal: tiny (5-8) canonical docs.
- Labels: hard guarantee is "never touch non-`ralph:*` labels".
- Bot-branch policy stays canon: merge to `bot/integration`, then roll up to `main`.
- Additional suspected contradiction:
  - Current docs emphasize "escalate only for product gaps"; operator expectation is broader: escalate for any failure requiring human intervention (with lanes to reduce escalations over time).

### Issue #494 (Labels vNext: cmds + status + o11y)

- https://github.com/3mdistal/ralph/issues/494
- Problem: "label wars" when labels are both operator controls and bot-derived state.
- Direction:
  - Operator-owned command labels (ephemeral): `ralph:cmd:queue`, `ralph:cmd:pause`, `ralph:cmd:stop`, `ralph:cmd:satisfy`.
  - Bot-owned mutually-exclusive status label: exactly one `ralph:status:*`.
  - Stronger o11y so "in-progress forever" becomes rare and self-correcting.
- Implication for docs: we likely need to treat existing `ralph:queued` requeue semantics as legacy and document command-label UX as the target operator interface.

### Interview 4 (2026-02-01)

- Operator interaction target: command labels + normal comments.
- Escalation resolution target: operator replies normally, then applies `ralph:cmd:queue` (no magic `RALPH RESOLVED:` phrase).
- bwrb-backed queue: considered dead; docs should move away from it.
- Canonical docs should follow a strict, claim-friendly template.
- Status set: to be unified (operator delegates selection).
- Midpoint naming: flexible (`in-bot` vs `satisfied`).

### Parent Verification Lane (clarification)

- Defined in `docs/product/parent-verification-lane.md` and implemented in code (`src/parent-verification/*`, invoked from `src/worker.ts`).
- Purpose: when dependency blockers clear for a parent issue, do a lightweight "is work already satisfied?" check before doing the full plan/build pipeline.
- Output marker: `RALPH_PARENT_VERIFY: {"version":1,"work_remains":true|false,...}`.

### Interview 5 (2026-02-01)

- Dependency-blocked should be internal-only metadata (not a GitHub-visible status label).

### Interview 6 (2026-02-01)

- Doc review order: start with `docs/product/vision.md`.
- Labels:
  - `ralph:*` label ownership has no exceptions.
  - `ralph:status:*` single-status is intent-strict: never intentionally set multiple; tolerate temporary drift on partial write failures but must converge.
- `ralph:cmd:queue`: clears statuses + internal retry/blocked metadata.
- Issue closure target: always close issues when `ralph:status:done` is reached.

### Interview 7 (2026-02-01)

- Escalation sensitivity inputs: only `ralph:*` labels (no non-ralph labels like `product`/`ux`).
- Cache isolation: keep as candidate claim for now; revisit when parallelism becomes real.
- Vision doc navigation: move initiatives to an index doc to keep `docs/product/vision.md` clean.

### Interview 8 (2026-02-01)

- Escalation policy target:
  - Escalate only when Ralph believes it will not resolve without human help.
  - Default: attempt at least one bounded self-heal/retry before escalating (except explicit `PRODUCT GAP:` markers).
  - Product gap markers: keep deterministic regex + precedence rules.
  - Contract surface: hybrid policy (proceed when additive/low-complexity; escalate when breaking or high complexity).
  - Remove devex-before-escalate; devex belongs in deterministic gates.
  - Remove non-`ralph:*` label sensitivity rules; only `ralph:*` drives escalation sensitivity.

### Interview 9 (2026-02-01)

- Escalation-policy claims promoted:
  - Resolution via `ralph:cmd:queue`.
  - Low confidence alone does not trigger escalation.
- Dropped vague `escalation.markers-deterministic` claim in favor of explicit `product-gap.*` claims.

### Interview 10 (2026-02-01)

- Orchestration contract decisions:
  - `ralph:cmd:*` commands may be issued by any collaborator who can apply labels.
  - `ralph:cmd:queue` may be processed asynchronously; status convergence is best-effort.
  - `ralph:cmd:stop` stops automation but leaves open PRs open.
  - `ralph:cmd:satisfy` is dependency-graph only; does not imply merge/close.
  - `ralph:status:done` is derived from merged PR evidence reconciled to default branch; on done Ralph closes the issue.
  - Degraded mode: keep progressing using SQLite truth and reconcile labels later.

### Interview 11 (2026-02-01)

- Done evidence chain: use GitHub issue timeline events to identify the closing PR, then verify the relevant commit SHA is on the repo default branch.
- Label bootstrap: Ralph ensures required `ralph:status:*` and `ralph:cmd:*` labels exist and enforces their descriptions/colors.

### Interview 12 (2026-02-01)

- Required label set becomes an explicit canonical claim (enumerated status + command labels).

### Interview 13 (2026-02-01)

- Deterministic gates decisions:
  - Promote core gates claims (preflight, review marker contract, CI triage lanes, persisted gate state).
  - Make `ralph gates <repo> <issueNumber> [--json]` a canonical planned CLI surface.
- Avoid duplicate opencode determinism claims; keep `opencode.managed-config` as the single canonical claim.

### Interview 14 (2026-02-01)

- Plan-stage product review is required for every task to catch claims drift.
  - New marker: `RALPH_PLAN_REVIEW: {"status":"pass"|"fail","reason":"..."}` (exactly one on final line; missing == fail).
- Gate record required fields locked (preflight, product/devex review, CI, derived ready_for_pr).
- Retry budgets are per-lane configurable; policy does not assume default numbers.

### Interview 15 (2026-02-01)

- Sandbox provisioning claims promoted (v1):
  - Private repo per run from a template.
  - Deterministic repo naming rule.
  - Private-only visibility (non-private hard error).
  - Manifest written to `~/.ralph/sandbox/manifests/<runId>.json`.
  - Seed determinism + idempotency by `key`.
  - `minimal` preset ensures required `ralph:*` labels and creates bot branch.
  - `parity` preset is best-effort; failures become warnings and do not block provisioning.

### SQLite Policy (2026-02-01)

- Promoted additional SQLite migration claims:
  - Migrations are transactional (no partial state).
  - Schema changes bump `SCHEMA_VERSION`.
  - No downgrades; newer schema fails closed.
  - Safe reset by deleting `~/.ralph/state.sqlite`.

### Clarification (2026-02-01)

- `PRODUCT GAP:` remains a deterministic escalation marker (cross-cutting, not a "stage").
- Plan-stage product review is an agent gate; when it fails due to missing guidance it should emit both `RALPH_PLAN_REVIEW` (fail) and a single `PRODUCT GAP:` marker.

### Repo Scan (code reality) (2026-02-01)

- bwrb is still heavily present in implementation (`src/queue.ts`, `src/queue-backend.ts`, `src/bwrb/*`, `src/notify.ts`, `src/escalation-notes.ts`, and multiple tests).
- `src/queue-backend.ts` indicates `queueBackend` supports `"github" | "bwrb" | "none"` and explicitly falls back to bwrb in some cases (including a message that GitHub queue backend is not yet implemented; references `#61/#63`).
- `src/github-queue/io.ts` logs that `createAgentTask` is not supported for GitHub-backed queues.
- SQLite state exists and is used (`~/.ralph/state.sqlite`; see `src/state.ts`).

### Issue #460 (Claims Ledger v1)

- https://github.com/3mdistal/ralph/issues/460
- Scope: define `claims/canonical.jsonl` v1 format + JSON Schema + canonicalization rules for deterministic diffs.
- Key theme: machine-validated, reviewable "claims" as the stable representation.
