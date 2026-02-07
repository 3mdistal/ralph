# Plan: Make relationship coverage explicit (complete/partial/unavailable) (#271)

Issue: `https://github.com/3mdistal/ralph/issues/271`

## Goal

- Replace boolean relationship coverage flags that conflate partial vs unavailable with an explicit enum state.
- Remove brittle inference of partial coverage from the presence of GitHub signals.
- Keep dependency/blocking decisions conservative and deterministic.

## Product Guidance (from @product)

- Coverage should be explicit per relationship kind as `complete|partial|unavailable` and documented in the type.
- Downstream logic must use coverage state directly (no inference from “signals exist”).
- Be conservative: `partial`/`unavailable` must not accidentally imply “certainly unblocked”.
- Tests should cover all 3 states, including “partial even when first page is empty”.

## Assumptions

- This enum is not persisted; it remains an in-memory snapshot field.
- `partial` means: GitHub relationship fetch succeeded but may not represent the full set (pagination or missing pageInfo).
- `unavailable` means: GitHub relationship fetch could not be obtained (unsupported endpoint/capability or fetch failure).
- Body-parsed dependency blockers remain a fallback only when GitHub deps coverage is `unavailable` (not when `partial`).

## Checklist

- [x] Define `RelationshipCoverage` enum/union and update `IssueRelationshipSnapshot.coverage` to use explicit state.
- [x] Update `GitHubRelationshipProvider` to set `githubDeps`/`githubSubIssues` coverage to `complete|partial|unavailable`.
- [x] Update relationship signal resolution to:
  - [x] stop inferring `partial` from signal presence
  - [x] drive body-fallback + unknown-signal injection from explicit coverage
- [x] Update parent-verification + child-dossier eligibility to use explicit coverage state.
- [x] Update/extend tests to cover explicit states (complete/partial/unavailable), including “partial with empty first page”.
- [x] Ensure sub-issue coverage states are tested end-to-end (provider -> resolver -> eligibility) to avoid drift.
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.

## Implementation Steps

- [x] Update `src/github/issue-relationships.ts`:
  - add `export type RelationshipCoverage = "complete" | "partial" | "unavailable"`.
  - change `coverage` to `{ githubDeps: RelationshipCoverage; githubSubIssues: RelationshipCoverage; bodyDeps: boolean }`.
  - document semantics inline (what each state means and how callers should interpret it).

- [x] Update `src/github/issue-relationships.ts` (`GitHubRelationshipProvider.getSnapshot()`):
  - initialize `coverage.githubDeps`/`coverage.githubSubIssues` as `"unavailable"`.
  - when a fetch returns a result, set state via a shared helper (used for deps + sub-issues):
    - `"complete"` iff `hasNextPage === false`
    - otherwise `"partial"` (covers `hasNextPage===true` and missing/unknown pageInfo)
  - keep `coverage.bodyDeps` behavior unchanged.

- [x] Update `src/github/relationship-signals.ts`:
  - [x] derive `shouldIgnoreBodyDeps` from `coverage.githubDeps !== "unavailable"` (complete or partial).
  - [x] inject `unknown` for deps when `coverage.githubDeps !== "complete"` and body deps coverage is absent.
  - [x] inject `unknown` for sub-issues when `coverage.githubSubIssues !== "complete"`.
  - [x] keep diagnostics (`ignoredBodyBlockers.reason`) aligned with `complete` vs `partial`.
  - [x] prefer an exhaustive `switch`/branch on `RelationshipCoverage` to avoid future drift.

- [x] Update downstream consumers:
  - [x] `src/parent-verification/core.ts` — treat non-`complete` sub-issue coverage as ineligible.
  - [x] `src/child-dossier/core.ts` — treat non-`complete` sub-issue coverage as ineligible.

- [x] Tests:
  - [x] `src/__tests__/issue-relationships.test.ts` — update assertions to new coverage fields.
  - [x] `src/__tests__/issue-relationships.test.ts` — provider test matrix for BOTH deps + sub-issues:
    - `complete` (no next page)
    - `partial` (next page true, including an empty first-page response)
    - `unavailable` (REST+GraphQL not supported / 404)
  - [x] `src/__tests__/relationship-signals.test.ts` — update fixtures and add coverage-state tests:
    - deps: `githubDeps="partial"` with only body blockers present => body ignored + unknown injected.
    - sub-issues: `githubSubIssues="partial"` and `"unavailable"` => unknown injected.
  - [x] `src/__tests__/blocked-sync.test.ts` — add one assertion that `githubSubIssues !== "complete"` keeps outcomes conservative (no accidental unblock/verification triggers) even when no open blockers are present.
  - [x] Update snapshot coverage literals in `src/__tests__/blocked-sync.test.ts`.
  - [x] Update snapshot coverage literals in `src/__tests__/parent-verification-core.test.ts`.
  - [x] Update snapshot coverage literals in `src/__tests__/child-dossier-core.test.ts`.
  - [x] Update snapshot coverage literals in `src/__tests__/github-queue-list-tasks-by-status.test.ts`.
  - [ ] Optional: add a small shared snapshot builder in tests to reduce repetitive `coverage` literals.

- [x] Run gates locally:
  - [x] `bun test`
  - [x] `bun run typecheck`
  - [x] `bun run build`
  - [x] `bun run knip`
