# Escalation Policy

This document is the single source of truth for when an agent should **proceed** vs **escalate** during a Ralph run.

## Goals

- Keep routing deterministic (no accidental escalations from fuzzy language).
- Minimize human interrupt surface.
- Escalate only when the task cannot be safely completed autonomously.

## Canonical Location

- Canonical doc: `docs/escalation-policy.md`
- This file is the authoritative policy. Other docs should link here rather than duplicating rules.

## Deterministic Markers

Only explicit **line-start** markers count as authoritative.

### What counts

A marker is detected only if the line begins with:

- Optional whitespace
- Optional list marker: `- ` or `* `
- Then exactly one of (case-insensitive):
  - `PRODUCT GAP:`
  - `NO PRODUCT GAP:`

### What does *not* count

- Mid-line mentions (e.g. `Here is the marker: PRODUCT GAP: ...`)
- Quoted/block-quoted mentions (e.g. `> PRODUCT GAP: ...`)
- `PRODUCT GAP` without the trailing `:`

### Interaction rules

- `NO PRODUCT GAP:` **blocks** `PRODUCT GAP:` for routing.
  - If a response includes any valid `NO PRODUCT GAP:` marker, the run must not treat any `PRODUCT GAP:` markers as authoritative for escalation.

## Contract-Surface Escalation

Escalate if an open question affects a **user-facing contract surface**.

Contract surface indicators include:

- CLI flags/args
- Exit codes
- `stdout`/`stderr` output formats
- Public error strings (user-visible wording)
- Config schema/format
- Schema changes
- Machine-readable outputs (e.g. JSON)

Non-contract surface examples (should not by themselves trigger escalation):

- Internal naming, refactors, file layout choices
- Non-user-facing log messages
- Code style preferences when the repo already has a clear convention

## Low Confidence Handling

- **Low confidence alone must not trigger escalation.**
- Default behavior is to proceed for “implementation-ish” tasks (e.g. `dx`, `refactor`, `bug`) unless a product gap marker or contract-surface risk applies.

## Devex-Before-Escalate

For implementation-ish tasks (not explicitly labeled `product`, `ux`, or `breaking-change`):

- If routing is low confidence or there’s a non-high-confidence desire to escalate, consult `@devex` **before** escalating.
- Exceptions (escalate immediately):
  - Valid `PRODUCT GAP:` marker without a valid `NO PRODUCT GAP:` marker
  - Contract-surface reasons
