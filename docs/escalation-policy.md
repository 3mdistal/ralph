# Escalation & Routing Policy

This document is the **single source of truth** for Ralph’s escalation and routing policy.

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

Goal: **minimize human interrupt surface**. Most tasks should proceed autonomously; escalate only when human intervention is required.

## Routing decision format

Agents must output a routing decision as machine-parseable JSON.

Allowed values:
- `decision`: `"proceed"` or `"escalate"`
- `confidence`: `"high"`, `"medium"`, or `"low"`
- `escalation_reason`: `null` or a short string

Example:

```json
{
  "decision": "proceed",
  "confidence": "low",
  "escalation_reason": null
}
```

## Product gap markers (deterministic)

Only explicit, line-start markers are authoritative.

Recognized markers (case-insensitive):
- `PRODUCT GAP: ...`
- `NO PRODUCT GAP: ...` (blocks/overrides `PRODUCT GAP:`)

The marker may be prefixed by optional whitespace and/or a single list marker (`- ` or `* `).

Canonical detection rule (normative):
- Only match markers at the start of a line (after optional whitespace and an optional single list prefix `- ` or `* `).
- Do not treat mid-line or quoted mentions as markers.

One acceptable regex implementation:
- `^\s*(?:[-*]\s+)?(NO\s+)?PRODUCT\s+GAP:\s+` (case-insensitive)

Not markers:
- Mid-line mentions (example: `Here is the marker: PRODUCT GAP: ...`)
- Quoted mentions copied from earlier text
- `PRODUCT GAP` without a trailing `:`

Authoring guidance:
- Emit **at most one** marker per response.

Precedence rule:
- If a response contains any `NO PRODUCT GAP:` marker, treat it as **not** asserting a product gap even if `PRODUCT GAP:` appears elsewhere.

**Routing precedence:** if a product gap marker is present (and not negated by `NO PRODUCT GAP:`), it should be treated as an escalation signal even if the routing decision JSON says `"decision": "proceed"`.

## When to escalate

Escalate when the task cannot proceed without a human.

Default stance:

- Prefer deterministic remediation lanes and bounded retries.
- Escalate only when Ralph believes it will not resolve the issue without human help.

Common cases:

### 1) Product documentation gap

If product guidance is genuinely missing, the product agent must emit a line-start `PRODUCT GAP:` marker.

### 2) Blocked work

If progress is blocked by an external dependency (missing access, broken upstream, missing credentials, etc.), escalate with a clear blocker reason.

### 3) Contract-surface questions

If an open question affects a user-facing **contract surface**, Ralph uses a hybrid policy:

- Proceed when a change can be made additive and low-complexity (preserve compatibility).
- Escalate when it would require a breaking change or would add unreasonable compatibility complexity.

Contract surface indicators include:
- CLI flags/args
- Exit codes
- stdout/stderr output formats
- Machine-readable outputs (including JSON)
- Config schema/format
- Schema changes
- Public error strings

### 4) Any other needs-human intervention

If Ralph has exhausted deterministic remediation lanes (CI-debug, merge-conflict recovery, rate-limit backoff, retry budget, etc.) and still cannot make forward progress, escalate with:

- what failed
- what was tried (bounded)
- the exact next human action

## Escalation resolution protocol

- Ralph escalates by setting `ralph:status:escalated` and posting a clear instruction comment.
- Operator responds with normal GitHub comments.
- Operator re-queues by applying `ralph:cmd:queue`.

Canonical label/command contract: `docs/product/orchestration-contract.md`.

Notes:
- “Contract surface” is about **compatibility promises** (especially anything scripts or downstream tooling might rely on).
- Public error strings are contract surface only when they are explicitly stable (documented) and/or used by downstream tooling for machine parsing.
- Purely internal refactors, implementation details, and incidental wording changes are usually not contract-surface concerns.

## Low confidence handling

Low confidence alone must **not** trigger escalation for routine tasks.

Default behavior:
- If there is no product gap marker and no contract-surface question, the routing decision should usually be `decision=proceed` even when `confidence=low`.

Escalation sensitivity inputs:

- Only `ralph:*` labels plus deterministic markers and contract-surface detection affect escalation behavior.
- Non-`ralph:*` labels are ignored for escalation sensitivity.

## Updating policy

If policy changes, update **only this file** and link to it elsewhere (avoid duplicating rules in multiple docs).
