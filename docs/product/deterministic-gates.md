# Ralph Loop - Deterministic Gates (Tests, Review, CI)

Ralph's primary goal is to reduce micromanagement by making the "last mile" of agent work machine-checkable and repeatable.

This doc defines the deterministic gates the orchestrator enforces so individual workers can stay focused on implementation, while Ralph retains oversight across the whole repo.

## Goals

- Reduce human interrupt surface by preventing avoidable PR churn.
- Make review requests consistent (same format, same artifacts).
- Keep local work fast: prefer small, deterministic preflight locally; push heavier suites to CI.
- Turn CI failures into small, actionable follow-up tasks.

## Core Idea

Workers implement and commit.

The orchestrator (not the worker) is responsible for:
- running required checks before a PR can be opened
- requesting Product/DevEx review in a consistent format
- enforcing that CI is green before merge
- triaging failures and resuming/spawning follow-up work

## Required Gate Fields

Persist these on the run record (e.g. `agent-run`) so Ralph can be strict and deterministic:

- `preflight.status`: `pending|pass|fail|skipped`
- `preflight.command`: string (exact commands run)
- `product_review.status`: `pending|pass|fail|skipped`
- `devex_review.status`: `pending|pass|fail|skipped`
- `ci.status`: `pending|pass|fail|skipped`
- `ci.url`: string (run URL, when available)
- `ready_for_pr`: boolean (derived; true only when required gates are satisfied)

Rule of thumb: gates should be derived from observable artifacts (command output, CI checks, explicit review agent output), not "agent says it ran tests".

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

## Gate 3: CI (Full Suite + Required Checks)

Default: required.

The orchestrator should run/await the required CI checks after the PR is opened.

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
