# Plan: Merge-conflict recovery permission-denied classification + /tmp avoidance (#626)

## Goal

- Ensure merge-conflict recovery never relies on external-directory paths like `/tmp`.
- When OpenCode sandbox denies permissions (e.g. `external_directory (/tmp/*)`), fail fast and surface an explicit classification (`blocked:permission`) in merge-conflict comments/escalations.
- Prevent permission-denied failures from being misreported as generic “timed out waiting for updated PR state”.

## Product constraints (canonical)

- Minimize human interrupt surface; prefer accurate, actionable escalations over retries on non-actionable failures (`docs/product/vision.md`).
- Merge-conflict recovery is a first-class remediation lane: single canonical issue comment (edit in place), bounded retries, then escalate (`docs/product/deterministic-gates.md`).
- Diagnostics posted to GitHub must be bounded and redacted; avoid leaking local absolute paths (`docs/product/vision.md`).

## Assumptions

- OpenCode sandbox permission denials appear in session output with a recognizable marker like `permission requested: <capability> (<target>); auto-rejecting`.
- Permission denial is non-retryable without changing commands/policy; treat it as an immediate escalation (no attempt churn).

## Checklist

- [x] Add a pure OpenCode output classifier (typed `permission-denied` + parsed capability/target).
- [x] Plumb a worktree-local temp dir into spawned OpenCode env (`TMPDIR`/`TMP`/`TEMP`), with an explicit override in session options.
- [x] Merge-conflict lane: detect permission-denied immediately after `runAgent` and escalate without retry/polling.
- [x] Merge-conflict lane: if PR-state polling times out but the session output indicates permission-denied, report `blocked:permission` (not timeout).
- [x] Merge-conflict recovery agent prompt explicitly forbids `/tmp` and suggests worktree-local temp/artifact paths.
- [x] Add/extend diagnostics redaction so merge-conflict comments/escalations cannot leak local absolute paths (incl. `/tmp/...`).
- [x] Regression tests:
  - [x] Classifier unit tests (multiple phrasings + false-positive guard)
  - [x] Merge-conflict recovery: permission-denied escalates with `blocked:permission`, skips PR-state polling, and never emits timeout reason
  - [x] Session env: temp vars set and override precedence
  - [x] Merge-conflict prompt contains no-`/tmp` instruction
  - [x] Redaction: `/tmp/...` scrubbed in GitHub writeback payloads
- [x] Run gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.

---

# Plan: #598 queued/blocked label parity drift

Assumptions (daemon-safe defaults):
- Treat issue acceptance criteria as authoritative for this task.
- Keep GitHub as the operator queue surface, but ensure a task that is locally `blocked` is never labeled `ralph:status:queued`.

## Checklist

- [x] Read current label reconciliation + queue/state projection flows to identify why local `blocked` could retain GitHub `ralph:status:queued`.
- [x] Make blocked label projection explicit (named constant), and change blocked projection to non-queued status label.
- [x] Change `blocked` -> GitHub label mapping to remove `ralph:status:queued` by projecting to `ralph:status:in-progress`.
- [x] Add parity audit + operator-visible diagnostics for `ghQueued && localBlocked` drift, including periodic reconcile logging of before/after counts.
- [x] Extend regression coverage for blocked mapping and parity audit classification.
- [x] Update orchestration contract doc with the blocked projection rule used for queue parity.
- [x] Run targeted regression tests for queue core, blocked sync, status command/snapshot, and parity helper.
