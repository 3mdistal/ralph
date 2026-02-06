# Plan: Issue #595 - Deterministic PR URL Completion Gate

Assumptions:
- "Issue-linked run" means a run with a parseable issue number (e.g. `owner/repo#123`).
- Success without a PR URL is allowed only when `completionKind="verified"` (parent verification / no-work lanes).

## Checklist

- [x] Read issue context and canonical docs (`docs/product/deterministic-gates.md`, `docs/product/orchestration-contract.md`, `docs/escalation-policy.md`).
- [x] Confirm current behavior: `src/worker/run-context.ts` can record `outcome=success` with no PR URL evidence.
- [x] Update product spec + claims ledger for PR evidence completion gate.
- [x] Add a persisted PR-evidence gate (`pr_evidence`) to `~/.ralph/state.sqlite` gate records, including a safe/transactional migration.
- [x] Implement a pure completion policy core (table-driven tests) that decides whether `outcome=success` is allowed without PR evidence.
- [x] Add a deterministic completion guard in `src/worker/run-context.ts` using the policy core; when failing closed, record `pr_evidence=fail` plus bounded diagnostic artifacts.
- [x] Record PR evidence deterministically (explicit `runId` propagation; avoid implicit `activeRunId` coupling); ensure `pr_evidence=pass` is sticky and is never downgraded to `fail`.
- [x] Persist missing-PR diagnostics as bounded gate artifacts (worktree/branch when available, push step, `gh pr create` step).
- [x] Update CLI/query surfaces (e.g. `ralph gates ...`) and any gate-name enums to include `pr_evidence`.
- [x] Add/adjust unit tests for the new gate behavior, precedence rules (pass sticky), and SQLite migration.
- [x] Run `bun test` and ensure green.
