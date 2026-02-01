# Claims Ledger

This repo is moving toward a "claims ledger" model:

- Docs express intent.
- A separate canonical claims file expresses atomic, machine-checkable claims.

The v1 format is JSONL: one JSON object per line.

This is aligned to the v1 proposal in `https://github.com/3mdistal/ralph/issues/460`.

Canonical file: `claims/canonical.jsonl`.

Candidate claims (not yet canonical): `claims/candidates.jsonl`.

Schema: `claims/schema.v1.json`.

## V1 claim shape (draft)

Required keys:

- `domain` (string): claim namespace.
- `id` (string): unique within the file.
- `surface` (string): what the claim applies to (GitHub, filesystem, SQLite, etc.).
- `path` (string): a scope selector within the surface.
- `claim` (string): human-readable statement.
- `status` (string): `implemented` or `planned`.
- `source` (string): pointer to the canonical doc where this claim is described.

Optional keys:

- `schemaVersion` (number): currently `1`.

Notes:

- This is intentionally minimal; we will align it to Issue #460 as the implementation lands.
