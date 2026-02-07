# Plan: Escalation Autopilot (Auto-Resolve Allowlisted Types With Loop Limits) (#210)

## Goal

- Automatically resolve routine/low-risk escalations without human intervention.
- When the escalation consultant decision is eligible, fill `## Resolution` with `proposed_resolution_text` and mark the escalation note `status=resolved` so Ralph resumes the same OpenCode session.
- Add durable loop protection to prevent infinite resolve/resume/escalate cycles.

## Product Constraints (canonical)

- Never auto-resolve product gaps (`docs/escalation-policy.md`).
- Never auto-resolve contract-surface questions (`docs/escalation-policy.md`).
- Keep work bounded and deterministic; loop limits must survive daemon restarts (`docs/product/vision.md`).

## Assumptions

- Autopilot gates on the escalation consultant packet (not routing JSON).
- Default loop budget is 2 auto-resolve attempts per `(task, escalation signature)`.
- Loop budget state is stored durably on the task note as a small JSON map keyed by signature (to survive multiple distinct signatures across a task).
- Initial allowlist targets only conservative subtypes:
  - `blocked` only when a dependency reference can be parsed deterministically (e.g. "blocked by <owner>/<repo>#<n>")
  - `watchdog` for watchdog/anomaly-loop remediation
  - `low-confidence` (if/when emitted) remains eligible

## Checklist

- [x] Add a small, testable “escalation autopilot” functional core (parse consultant decision from note, eligibility rules, signature, resolution patch planner).
- [x] Add durable loop budget ledger on the task note (JSON map keyed by signature + timestamps).
- [x] Introduce/emit an explicit escalation type for watchdog/anomaly loops (`watchdog`).
- [x] Wire autopilot into the escalation consultant scheduler:
  - [x] If consultant packet missing and model-send allowed: append packet.
  - [x] If packet present: attempt auto-resolve for eligible allowlisted escalations.
  - [x] If auto-resolve suppressed: record a short suppression note (for audit) and exit.
- [x] Ensure autopilot apply is idempotent per escalation note + signature (avoid double increments / double resolves).
- [x] Ensure auto-resolve does not run for product-gap or contract-surface cases.
- [x] Tests: eligibility matrix + loop ledger semantics + resolution patching + idempotence + minimal integration (tick -> resolved -> resume reads text).
- [x] Run repo gates: `bun test`, `bun run typecheck`, `bun run build`, `bun run knip`.

## Implementation Steps

- [x] Add `src/escalation-autopilot/core.ts` (pure):
  - [x] parse consultant decision JSON from the escalation note markdown (rendered packet format)
  - [x] compute an escalation signature (type + normalized reason + decision)
  - [x] evaluate eligibility (allowlist + guardrails)
  - [x] plan loop-ledger updates and suppression decisions
  - [x] plan a safe `## Resolution` patch (do not overwrite human text)
- [x] Extend `src/escalation-notes.ts` with a tested `patchResolutionSection()` helper (keep parse/write rules co-located with `extractResolutionSection`).
- [x] Implement autopilot IO in `src/escalation-consultant/scheduler.ts`:
  - [x] Read pending escalation note; if missing packet and model-send allowed, append packet.
  - [x] If decision eligible and loop budget allows: patch note first, then set escalation note status to `resolved` (write order avoids resume race).
  - [x] Update task loop ledger (single atomic update step if possible), then log applied.
  - [x] If suppressed: write an audit hint (e.g. `<!-- ralph-autopilot:suppressed ... -->`) and log.
- [x] Add strict blocked-subtype detection helper (dependency ref parser) used by eligibility.
- [x] Update `src/github/escalation-constants.ts` to include `watchdog` escalation type and update all watchdog/anomaly escalation emitters to use it (not `other`).
- [x] Add idempotency for autopilot apply keyed by `(escalation note path, signature)` (SQLite idempotency or bwrb metadata field).
- [x] Add structured logs for applied/suppressed; keep GitHub writes out of scope.
