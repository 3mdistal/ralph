# GitHub-first orchestration contract

Status: non-canonical (derived reference)

This doc exists as a drift guard for the shipped GitHub label taxonomy.

Canonical orchestration surface (target): `docs/product/orchestration-contract.md`.
Canonical claims: `claims/canonical.jsonl`.

## Ralph-managed status labels

| Label | Meaning | Color |
| --- | --- | --- |
| `ralph:status:queued` | In queue; claimable when unblocked | `0366D6` |
| `ralph:status:in-progress` | Ralph is actively working | `FBCA04` |
| `ralph:status:paused` | Operator pause; do not claim or resume | `6A737D` |
| `ralph:status:escalated` | Needs human intervention; see escalation note | `D73A4A` |
| `ralph:status:in-bot` | Task PR merged to bot/integration | `0E8A16` |
| `ralph:status:done` | Task merged to default branch | `1A7F37` |
| `ralph:status:stopped` | Operator stop; do not claim or resume | `6A737D` |
