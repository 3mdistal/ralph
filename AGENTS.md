# Agent Guidance (Ralph)

This repo is designed for autonomous, non-interactive daemon runs.

## Escalation policy

Canonical policy lives in `docs/escalation-policy.md`.

In short:

- Use deterministic, line-start markers: `PRODUCT GAP:` and `NO PRODUCT GAP:`.
- Escalate immediately for contract-surface uncertainty (CLI flags/args, exit codes, output formats, public error strings, config/schema, machine-readable outputs).
- Do not escalate on low confidence alone for implementation-ish tasks; default is proceed.
- For implementation-ish tasks, consult `@devex` before escalating when routing is low confidence (unless product-gap marker or contract-surface reasons apply).
