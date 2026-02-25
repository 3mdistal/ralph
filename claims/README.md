# Claims Ledger

This repo is moving toward a "claims ledger" model:

- Docs express intent.
- A separate canonical claims file expresses atomic, machine-checkable claims.

The v1 format is JSONL: one JSON object per line.

This is aligned to the v1 proposal in `https://github.com/3mdistal/ralph/issues/460`.

Canonical file: `claims/canonical.jsonl`.

Candidate claims (not yet canonical): `claims/candidates.jsonl`.

Schema: `claims/schema.v1.json`.

## V1 claim shape

Required keys (all required in v1):

- `schemaVersion` (integer): must be `1`.
- `domain` (string): claim namespace. Must exist in `claims/domains.json`.
- `id` (string): unique across the file.
- `surface` (string): v1 scope selector surface.
- `path` (string): v1 scope selector path.
- `claim` (string): human-readable statement.
- `status` (string): `implemented` or `planned`.
- `source` (string): pointer to the canonical doc/code source.

Validation schema: `claims/schema.v1.json`.

Minimal example set: `claims/examples.v1.jsonl`.

## V1 scope selector contract

v1 scope selectors are exactly:

- `surface`
- `path`

`config_key` and `cli_command` are out of scope for v1 and should only be introduced after deterministic inventories exist.

## Canonicalization rules (v1)

`claims/canonical.jsonl` is canonical only when all of the following are true:

- Each non-empty line is a valid JSON object matching `claims/schema.v1.json`.
- Output uses minified JSON (single-line objects).
- Keys are ordered as: `schemaVersion`, `domain`, `id`, `surface`, `path`, `claim`, `status`, `source`.
- Lines are sorted by `domain` ascending, then `id` ascending.
- `id` values are globally unique across the file.
- File uses `\n` line endings and ends with a trailing newline.

## Domains: defaults and repo-specific extension

`claims/domains.json` defines the current domain allowlist for this repo.

- Treat entries in `domains` as global defaults for Ralph claims.
- Repos may extend this file with additional domain IDs that remain deterministic and reviewable.
- Any claim `domain` in `claims/canonical.jsonl` must exist in `claims/domains.json`.

## Contributor workflow

- Canonicalize/write: `bun run claims:fmt`
- Validate/check-only: `bun run claims:check`

## Keeping statuses in sync

- When a claim moves from `planned` -> `implemented`, update `claims/canonical.jsonl` in the same PR as the shipped code change.
- A lightweight guardrail test asserts key shipped claim statuses stay accurate: `src/__tests__/claims-status.test.ts`.
