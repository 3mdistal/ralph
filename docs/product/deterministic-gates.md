# Ralph Loop - Deterministic Gates (Tests, Review, CI)

Ralph's primary goal is to reduce micromanagement by making the "last mile" of agent work machine-checkable and repeatable.

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

This doc defines the deterministic gates the orchestrator enforces so individual workers can stay focused on implementation, while Ralph retains oversight across the whole repo.

Implementation status: target spec (some pieces exist today; see "Current State")

## Goals

- Reduce human interrupt surface by preventing avoidable PR churn.
- Make review requests consistent (same format, same artifacts).
- Keep local work fast: prefer small, deterministic preflight locally; push heavier suites to CI.
- Turn CI failures into small, actionable follow-up tasks.

## Core Idea

Coding agents implement and commit.

The orchestrator (not the worker) is responsible for:
- running required checks before a PR can be opened
- requesting Product/DevEx review in a consistent format
- enforcing that CI is green before merge
- triaging failures and resuming/spawning follow-up work

Where this applies:
- Ralph-generated PRs should target `bot/integration` by default.
- These gates are required before merging to `bot/integration`.
- A rollup PR from `bot/integration` to `main` remains the primary human review surface and a natural E2E checkpoint.

## Glossary

- Agent: an OpenCode session doing implementation work for a task.
- Orchestrator: Ralph Loop.
- Repo worker: the Ralph process responsible for a repo (in code: `RepoWorker`).

## Current State

This doc is primarily a target contract for making progress deterministic.

Already implemented today:
- CI merge gating via `repos[].requiredChecks` and branch protection (see `README.md`).

Not fully implemented today (this doc defines the intended behavior):
- a durable, first-class gate record persisted across restarts (beyond ad-hoc run notes)
- deterministic review-agent output format for Product/DevEx gate completion
- CI failure triage that decides resume vs spawn vs quarantine

## OpenCode Config Determinism

Ralph daemon runs must be deterministic and repo-agnostic. For all daemon runs, Ralph sets `OPENCODE_CONFIG_DIR` to a Ralph-managed config directory (default: `$HOME/.ralph/opencode`) and ignores any repo-local OpenCode configuration. The managed directory is overwritten to match the version shipped with Ralph. Overrides are allowed only via an explicit Ralph configuration value or environment variable to avoid ambient drift.

## Required Gate Fields

Persist gate metadata on an authoritative run record so Ralph can be strict and deterministic.

Note: gate persistence should be stored in `~/.ralph/state.sqlite`. Treat this list as the intended schema, not a statement of current implementation.

- `preflight.status`: `pending|pass|fail|skipped`
- `preflight.command`: string (exact commands run)
- `preflight.skip_reason`: string (required when `skipped`)
- `plan_review.status`: `pending|pass|fail|skipped`
- `product_review.status`: `pending|pass|fail|skipped`
- `devex_review.status`: `pending|pass|fail|skipped`
- `ci.status`: `pending|pass|fail|skipped`
- `ci.url`: string (run URL, when available)
- `ready_for_pr`: boolean (derived; true only when required gates are satisfied)

Rule of thumb: gates should be derived from observable artifacts (command output, CI checks, explicit review agent output), not "agent says it ran tests".

## Gate State Query Surface

Ralph exposes a minimal query surface for the latest persisted gate state:

- `ralph gates <repo> <issueNumber> [--json]`

This reads from `~/.ralph/state.sqlite` and returns the bounded/redacted artifacts stored with the gate records.

## Gate 1: Local Preflight (Fast, Deterministic)

Default: required.

Purpose: catch obvious breakage without paying the cost of full CI triage.

Characteristics:
- should run in <2 minutes in a clean checkout
- should have bounded output (avoid megabytes of logs)
- should be stable (not flaky)

Recommended default preflight (repo-specific):
- formatting/lint (or at least "check formatting")
- typecheck/build/compile
- *targeted* unit tests when changing core logic

Determinism requirement:
- The preflight command must come from a repo-level configuration surface (not ad-hoc per agent). The run record stores the exact command string that was executed.

## Gate 2: Review Requests (Product + DevEx)

Default: required for PRs produced by Ralph.

Workers are bad at reliably packaging context. The orchestrator should request review deterministically using a consistent template.

Minimum payload:
- intent (what user-facing behavior changes)
- risk (what could break)
- exact diff since base branch (e.g. `git diff <base>...HEAD`)
- any new tests added + why they matter
- consistency/reuse notes (what existing patterns/modules this should match, or why new code is justified)

This gate is complete when the review agents return explicit `pass|fail` and (if `fail`) an actionable reason.

Deterministic review output contract:
- The final line of the review agent response must include exactly one machine-parseable marker:

  `RALPH_REVIEW: {"status":"pass"|"fail","reason":"..."}`

Ralph treats any response without this marker as `fail` and routes via `docs/escalation-policy.md`.

## Plan-stage product review (required)

Product plan review runs for every task to catch drift from the claims ledger before implementation.

This is not an extra human checkpoint: it is an agent gate that happens before implementation work starts.

Interaction with `PRODUCT GAP:`

- `PRODUCT GAP:` / `NO PRODUCT GAP:` markers are still the canonical, deterministic escalation signals (see `docs/escalation-policy.md`).
- When product plan review fails specifically due to missing product guidance, the product plan-review agent should:
  - emit `RALPH_PLAN_REVIEW` with `status=fail`, and
  - include a single `PRODUCT GAP:` marker.

Deterministic plan-review output contract:

- The final line of the product plan-review agent response must include exactly one machine-parseable marker:

  `RALPH_PLAN_REVIEW: {"status":"pass"|"fail","reason":"..."}`

Ralph treats any response without this marker as `fail`.

## Gate 3: CI (Full Suite + Required Checks)

Default: required.

Ralph should run/await the required CI checks after the PR is opened.

This should align with the existing merge gate:
- Required checks are configured via `repos[].requiredChecks` (see `README.md`).
- Ralph enforces branch protection on `bot/integration` (or `repos[].botBranch`) and `main` to require these checks.

Status mapping:
- `ci.status=pass` maps to GitHub check state `success`.
- `ci.status=fail` maps to GitHub check state `failure`.
- `ci.status=pending` maps to GitHub check state `pending`.

If CI is green: proceed.

If CI fails: do not "just retry" by default; triage first.

## CI Failure Triage Loop

When CI fails, Ralph creates a triage step that:

- extracts the smallest relevant failure excerpts (test name, error, stack trace)
- classifies likely root cause (regression vs flake vs infra)
- decides the next action:
  - resume the same worker (best when failure clearly relates to their diff)
  - start a new focused worker (best when it needs deep debugging or different expertise)
  - quarantine/label flaky tests (best when evidence suggests non-determinism)

Guidelines:
- avoid pasting full CI logs into LLM context; summarize and attach a short excerpt
- store the CI URL and any extracted snippets as artifacts on the run record

Escalation policy:
- CI failures should default to an internal rework loop (resume/spawn) and only escalate to a human when they meet an escalation condition in `docs/escalation-policy.md` (e.g. product doc gap, hard external blocker).

## CI-debug lane (required checks red)

When an issue already has an open PR and required checks are failing or timed out, Ralph must treat CI-debug as a first-class recovery path.

Behavior:
- Detect: if required checks are failing or timed out, do not stop in a "needs-human" state until bounded remediation attempts complete.
- Comment: post a single canonical GitHub **issue** comment listing failing required check names + links, base/head refs, and the action statement: “Ralph is spawning a dedicated CI-debug run to make required checks green.” Edit this comment as CI state changes (no duplicates).
- Run: spawn a dedicated CI-debug run immediately with a fresh worktree and fresh OpenCode session (no planning phase). Seed the prompt with failing check names/URLs/refs and a brief failure summary.
- Retries: allow bounded retries (2–3). If the same failure signature repeats across attempts, stop early and escalate.

Retries are per-lane configurable; do not assume a default count.
- GitHub status: keep `ralph:status:in-progress` while remediation attempts continue. Set `ralph:status:escalated` only after bounded CI-debug attempts fail.
- Escalation: post a final comment summarizing what failed, what was tried (links to attempts), and the exact next human action.

## Merge-conflict recovery lane (mergeStateStatus=DIRTY)

When an issue already has an open PR with merge conflicts, Ralph must treat merge-conflict recovery as a first-class lane (like CI-debug).

Behavior:
- Detect: if the PR is `mergeStateStatus=DIRTY`, do not stop in a "needs-human" state until bounded recovery attempts complete.
- Comment: post a single canonical GitHub **issue** comment with PR/base/head refs, conflict file count/sample, and the action statement. Edit the same comment as state changes (no duplicates).
- Run: spawn a dedicated merge-conflict recovery run with a fresh worktree and fresh OpenCode session (no planning phase). Merge base into head (no rebase / no force-push), resolve conflicts, run tests/typecheck/build/knip, then push updates.
- Wait: after pushing, wait for `mergeStateStatus != DIRTY` and for required checks to appear for the new head SHA before resuming merge-gate logic.
- Retries: bounded attempts (2–3). If the same conflict signature repeats across attempts, stop early and escalate.

Retries are per-lane configurable; do not assume a default count.
- GitHub status: keep `ralph:status:in-progress` while recovery attempts continue. Set `ralph:status:escalated` only after bounded attempts fail.
- Escalation: post a final comment summarizing the conflict files and the exact next human action needed.

## Test Philosophy (Agentic Coding)

Tests are most valuable when they defend product behavior, not implementation details.

Principles:
- Tests should map to documented user experience wherever possible.
- Prefer a small number of high-signal tests over broad low-signal coverage.
- Treat flakiness as a product issue: a flaky suite destroys autonomy.
- When code can be shared without compromising UX consistency, prefer reuse/refactoring over duplication.

## Papercut Lane (From /survey to PR)

DevEx surveys often find small, safe fixes (lint, docs gaps, consistency cleanups). These should not always become new issues.

Suggested policy:
- If a suggestion is low-risk and mechanically verifiable (preflight + CI), Ralph may open a PR directly.
- If it changes behavior or introduces product decisions, file an issue or escalate.

## Relationship To Escalation Policy

Escalation markers and routing remain centralized in `docs/escalation-policy.md`.
This doc defines *gates* (what must be true to proceed), not *who gets paged*.
