# GitHub Rate Limiting & Backoff Policy

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

Ralph must avoid burning through GitHub API rate limits. It is acceptable for Ralph to be slower if it substantially reduces rate-limit incidents.

## Policy

- Respect backoff signals from GitHub:
  - If a response indicates rate limiting or abuse detection (e.g. 429, 403 secondary rate limit), Ralph must back off.
  - If `Retry-After` is present, honor it.
  - Otherwise use exponential backoff with jitter.
- Prefer caching and coalescing:
  - Cache repeat GETs within a short TTL where safe.
  - Coalesce label writes and avoid redundant mutations.
  - Prefer single "reconcile" passes over chatty per-step writes.
- Degraded mode is acceptable:
  - If label writes are blocked, continue progressing using SQLite truth and reconcile later.

Canonical orchestration contract: `docs/product/orchestration-contract.md`.
