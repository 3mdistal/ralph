# Agent Notes

This repo is designed to be worked on by autonomous coding agents.

## Canonical policy docs

- Escalation & routing policy (single source of truth): `docs/escalation-policy.md`
- Product vision and operating principles: `docs/product/vision.md`
- Orchestration contract (labels, commands, queue semantics): `docs/product/orchestration-contract.md`
- Deterministic orchestration gates (tests, review, CI triage): `docs/product/deterministic-gates.md`
- CI checks reference (derived from workflow + scripts): `docs/ops/ci-checks.md`
- SQLite durability policy: `docs/ops/state-sqlite.md`
- Managed OpenCode config contract: `docs/ops/opencode-managed-config.md`
- GitHub API backoff/caching policy: `docs/ops/github-rate-limiting.md`

## PR / branch strategy

- Prefer targeting `bot/integration` for agent PRs.
- Keep policy text centralized: link to canonical docs instead of duplicating rules across files.
