# Plan: Deterministic gates PR readiness + review packaging (#235)

## Goal

- Make PR submission readiness deterministic and orchestrator-owned.
- Make Product + DevEx review requests deterministic (fixed template; diff artifact + `git diff --stat`; machine marker required).
- Persist structured gate state so Ralph can enforce: PRs are not opened unless required gates are satisfied.

## Product decisions (authoritative)

- Do not paste full diffs into prompts; store full diff as an artifact and pass only `git diff --stat` + artifact path.
- Review outputs must end with exactly one `RALPH_REVIEW: {"status":"pass"|"fail","reason":"..."}` marker on the final line.
- Ralph-generated PRs target `bot/integration` by default.

## Assumptions

- Gate persistence + preflight config + review marker parsing are already implemented (blocked-by deps #232/#233/#234 are closed).
- Existing merge-time review gating in `src/worker/merge/merge-runner.ts` remains as a safety net, but PR creation must be gated earlier.
- In degraded mode (missing runId / artifact write failure), fail closed for PR creation to preserve determinism.

## DevEx must-fix notes (addressed by this plan)

- Lock down a single shared contract for: review marker parsing, readiness decision statuses, degraded-mode mappings, and retry/escalation budgets.
- Avoid readiness-vs-merge drift by extracting shared diff-prep + review protocol helpers (functional-core/imperative-shell split).
- Add explicit artifact size/retention bounds for diff artifacts.

## Checklist

- [ ] Lock down gate/result/marker contracts + retry budgets (shared, typed)
- [x] Fix diff artifact generation to work with head SHAs and be `--no-color`
- [x] Expand review prompt into a fixed, consistent template (intent/risk/tests/reuse placeholders + artifact reference)
- [x] Add a deterministic PR-readiness gate before PR creation (preflight + Product + DevEx)
- [ ] Make RepoWorker create PRs (not the coding agent) once gates pass; remove reliance on “agent must open PR” loops
- [x] Persist gate results/artifacts for all readiness outcomes (pass/fail/skip)
- [x] Add tests for diff artifact prep + readiness gating behavior
- [x] Run verification (`bun test` and `bun run typecheck`)

## Steps

- [ ] Contracts + shared helpers (do first)
  - [ ] Add typed readiness decision model (new module, e.g. `src/worker/pr-readiness-contract.ts`):
    - [ ] `PrReadinessStatus = ready | not_ready | degraded` (or equivalent)
    - [ ] `PrReadinessDecision` includes: `status`, `blockingGate?`, `reason` (bounded), and `evidenceVersion`.
  - [ ] Centralize review protocol helpers (new module, e.g. `src/gates/review-protocol.ts`):
    - [ ] Prompt template builder (versioned, `review_prompt_v1`).
    - [ ] Marker parser (already in `src/gates/review.ts` today) is re-exported or relocated so both readiness + merge paths share it.
  - [ ] Centralize retry budget knobs (env or config; deterministic defaults):
    - [ ] max readiness remediation attempts
    - [ ] max PR-create attempts
    - [ ] backoff/throttle policy for PR-create lease conflicts
  - [ ] Document degraded-mode mapping as explicit gate results/artifacts (not implicit logs).

- [x] Fix diff artifact generation (functional core)
  - [x] Update `src/gates/review.ts` `prepareReviewDiffArtifacts(...)`:
    - [x] Support `headRef` as a raw SHA or `HEAD` without attempting `git fetch origin <sha>`.
    - [x] Fetch only the base branch ref (e.g. `git fetch origin <base>`), then diff `origin/<base>...<head>`.
    - [x] Use `git diff --no-color` for patch and `git diff --no-color --stat` for the stat.
    - [x] Record base/head/range used in the artifact note for traceability.
    - [ ] Add size bounds for diff artifacts (max bytes/lines) and record truncation metadata.
  - [x] Add unit tests covering SHA head + base branch inputs.

- [x] Fixed, deterministic review packaging
  - [x] Update `src/gates/review.ts` `buildReviewPrompt(...)` to a stable template including:
    - [x] Repo / Issue / (optional) PR
    - [x] Intent (placeholder), Risk (placeholder), Testing notes (placeholder), Consistency/Reuse (placeholder)
    - [x] Diff artifact path (explicitly: “read this file; do not request pasted chunks”)
    - [x] `git diff --stat` output
    - [x] Marker instruction (final line must be `RALPH_REVIEW: ...`)
  - [x] Add unit tests asserting the prompt includes artifact path + stat and does not embed the full diff.

- [x] PR readiness gate (imperative shell)
  - [ ] Introduce a PR-readiness helper (new module, e.g. `src/worker/pr-readiness.ts`) that:
    - [x] Verifies the worktree is clean and on a named branch.
    - [x] Runs `runPreflightGate(...)` and refuses to proceed on `fail` (records gate result + artifacts).
    - [x] Prepares diff artifacts against the PR base (default `bot/integration`) with `head=HEAD`.
    - [x] Runs Product then DevEx review agents via `runReviewGate(...)` using the fixed prompt template.
    - [x] Returns a structured decision: `ready|not_ready` plus a short reason for rework.

- [ ] Orchestrator-owned PR creation
  - [ ] Update `src/worker/repo-worker.ts` `tryEnsurePrFromWorktree(...)` to:
    - [x] Call PR-readiness first; do not run `git push` / `gh pr create` unless readiness returns `ready`.
    - [ ] Keep idempotency lease behavior for PR creation.
    - [x] When readiness fails, route into the internal rework loop (resume/spawn) rather than escalating immediately.
  - [ ] Reduce/remove the “continue N times to get the agent to open a PR” loops:
    - [ ] Prefer: orchestrator retries readiness + PR creation, and only nudges the agent when it needs a clean commit/branch.
    - [ ] Escalate only after bounded readiness remediation attempts with clear diagnostics persisted to gate artifacts.

- [ ] Merge-time safety net alignment
  - [ ] Ensure `src/worker/merge/merge-runner.ts` review diff prep uses the updated SHA-safe diff artifact logic.
  - [ ] (Optional) Skip rerunning review gates at merge time only when evidence freshness matches:
    - [ ] same head SHA, same base ref, same prompt version.

- [ ] Tests + verification
  - [ ] Add integration tests that:
    - [ ] Refuse PR creation when preflight fails.
    - [ ] Refuse PR creation when Product/DevEx review fails (missing marker treated as fail).
    - [ ] Create PR only after all readiness gates pass.
    - [ ] Assert idempotency: repeated calls do not duplicate PRs, diff artifacts, or review runs.
    - [ ] Assert degraded mode (missing runId / diff artifact failure) fails closed with persisted diagnostics.
  - [x] Run `bun test`.
  - [x] Run `bun run typecheck`.
