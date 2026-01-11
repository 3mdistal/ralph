# Escalation & Routing Policy

This document is the **single source of truth** for Ralph’s escalation and routing policy.

Goal: **minimize human interrupt surface**. Most tasks should proceed autonomously; escalate only when human judgment is required.

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

Escalate only for:

### 1) Product documentation gap

If product guidance is genuinely missing, the product agent must emit a line-start `PRODUCT GAP:` marker.

### 2) Blocked work

If progress is blocked by an external dependency (missing access, broken upstream, missing credentials, etc.), escalate with a clear blocker reason.

### 3) Contract-surface questions (immediate escalate)

If an open question affects a user-facing **contract surface**, route to escalation immediately.

Contract surface indicators include:
- CLI flags/args
- Exit codes
- stdout/stderr output formats
- Machine-readable outputs (including JSON)
- Config schema/format
- Schema changes
- Public error strings

Notes:
- “Contract surface” is about **compatibility promises** (especially anything scripts or downstream tooling might rely on).
- Public error strings are contract surface only when they are explicitly stable (documented) and/or used by downstream tooling for machine parsing.
- Purely internal refactors, implementation details, and incidental wording changes are usually not contract-surface concerns.

## Low confidence handling

Low confidence alone must **not** trigger escalation for implementation-ish tasks.

Default behavior:
- If the task is implementation-ish and there is no product gap marker and no contract-surface question, the routing decision should usually be `decision=proceed` even when `confidence=low`.

Labels that increase escalation sensitivity:
- `product`, `ux`, `breaking-change` (absence of these labels should bias toward “implementation-ish”).

## Determining task type

Default rule (deterministic):
- If the GitHub Issue has any of the labels `product`, `ux`, or `breaking-change`, treat it as **not** implementation-ish.
- Otherwise, treat it as **implementation-ish**.

Fallback rule:
- If issue labels are unavailable, default to **implementation-ish** unless the task source explicitly marks it otherwise.

## Devex-before-escalate (implementation-ish tasks)

For implementation-ish tasks (not labeled `product`, `ux`, or `breaking-change`):

Consult @devex **before** escalating when:
- The routing result is low confidence (`confidence=low`), or
- The model wants to escalate but cannot do so with high confidence (i.e. an `escalate` request with `confidence=low|medium`).

Exceptions (escalate immediately; do not devex-first):
- Product gap markers (`PRODUCT GAP:`)
- Contract-surface questions

Rationale: devex consult is a remediation attempt to keep work flowing while still capturing maintainability/quality concerns.

## Updating policy

If policy changes, update **only this file** and link to it elsewhere (avoid duplicating rules in multiple docs).
