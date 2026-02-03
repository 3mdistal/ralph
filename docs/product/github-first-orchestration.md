# GitHub-first orchestration contract

Status: non-canonical (derived reference)

This doc exists as a drift guard for the shipped GitHub label taxonomy.

Canonical orchestration surface (target): `docs/product/orchestration-contract.md`.
Canonical claims: `claims/canonical.jsonl`.

## Ralph-managed status labels

| Label | Meaning | Color |
| --- | --- | --- |
| `ralph:status:queued` | In queue; claimable | `0366D6` |
| `ralph:status:in-progress` | Ralph is actively working | `FBCA04` |
| `ralph:status:blocked` | Waiting on dependencies or human input | `D73A4A` |
| `ralph:status:paused` | Operator pause; do not claim or resume | `6A737D` |
| `ralph:status:throttled` | Throttled; will resume later | `F9A825` |
| `ralph:status:in-bot` | Task PR merged to bot/integration | `0E8A16` |
| `ralph:status:done` | Task merged to default branch | `1A7F37` |
