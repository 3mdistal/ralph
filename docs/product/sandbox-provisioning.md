# Sandbox Provisioning (v1)

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

This document defines the v1 contract for sandbox provisioning. It is the canonical reference for the config surface, CLI commands, seed spec, and manifest schema.

## Goals
- Create a fresh private repo per sandbox run from a template.
- Apply required repo settings so Ralph automation behaves deterministically.
- Seed baseline issues/PRs/comments in a replayable, idempotent way.
- Write a local manifest for follow-on commands and auditability.

## Config surface (operator-owned)
Location: `~/.ralph/config.toml` or `~/.ralph/config.json`.

`sandbox.provisioning`:
- `templateRepo` (string, required): `owner/name` of the template repo.
- `templateRef` (string, default: `main`): branch/ref to align as default in the new repo.
- `repoVisibility` (string, default: `private`): v1 supports `private` only; other values hard-error.
- `settingsPreset` (string, default: `minimal`): `minimal` or `parity`.
- `seed` (object, optional): `{ preset = "baseline" }` OR `{ file = "/abs/path/seed.json" }`.

Repo naming rule:
- The new sandbox repo name MUST be `${sandbox.repoNamePrefix}${runIdShort}`.

## Commands

### `sandbox:init`
Usage: `ralph sandbox:init [--no-seed]`

Behavior:
- Creates the sandbox repo from the template.
- Applies the selected settings preset.
- Writes the manifest to `~/.ralph/sandbox/manifests/<runId>.json`.
- Runs seeding unless `--no-seed` is provided.

### `sandbox:seed`
Usage: `ralph sandbox:seed [--run-id <id>]`

Behavior:
- Loads the manifest for `runId`, or the newest manifest when omitted.
- Resolves seed spec from the manifest or `sandbox.provisioning.seed`.
- Applies seeding idempotently and updates the manifest.

Newest manifest selection:
- Prefer the manifest with the most recent `createdAt` (valid v1 schema).
- If no valid `createdAt` is found, fall back to file mtime.

## Settings presets

### `minimal` (must be reliable)
- Create repo from template (private).
- Ensure Ralph workflow labels exist:
  - all `ralph:status:*` labels defined in `docs/product/orchestration-contract.md`
  - all `ralph:cmd:*` labels defined in `docs/product/orchestration-contract.md`
- Ensure the default branch exists.
- Create bot branch (e.g. `bot/integration`) from default branch if missing.

### `parity` (best-effort)
- Copy branch protection from the template repo to the new repo for:
  - the default branch, and
  - the bot branch (if different).
- Copy repository rulesets from the template repo to the new repo.
- Any permission or API failures become warnings (non-fatal) and must not block provisioning.

## Seed spec (v1)

Seed specs are JSON with `schemaVersion = 1`.

```json
{
  "schemaVersion": 1,
  "issues": [
    {
      "key": "baseline-issue",
      "title": "Sandbox baseline issue",
      "body": "Optional body",
      "labels": ["ralph:status:queued"],
      "comments": [{"body": "Comment body"}]
    }
  ],
  "pullRequests": [
    {
      "key": "baseline-pr",
      "title": "Sandbox baseline PR",
      "body": "Optional body",
      "base": "main",
      "head": "seed/baseline-pr",
      "file": {"path": "seed/baseline.txt", "content": "seed"},
      "comments": [{"body": "Comment body"}]
    }
  ]
}
```

Defaults and normalization:
- `key` defaults to `issue-N` / `pr-N` (1-based). Keys are normalized by trimming and replacing whitespace with `-`.
- PR `base` defaults to the manifest `defaultBranch`.
- PR `head` defaults to `seed/<key>` (normalized, safe branch name).
- When `head` does not exist, it is created from `base`.
- PR `file` defaults to `{ path: "seed/<key>.txt", content: "seed" }`.

Determinism and idempotency:
- Seed is deterministic: the same spec yields the same ordered set of created artifacts.
- Reruns skip any entries already recorded in the manifest by `key`.

## Manifest schema (v1)

Location: `~/.ralph/sandbox/manifests/<runId>.json`

Required fields:
- `schemaVersion`: `1`
- `runId`
- `createdAt` (ISO timestamp)
- `templateRepo`, `templateRef`
- `repo.fullName`, `repo.url`, `repo.visibility`
- `settingsPreset`
- `defaultBranch`, `botBranch`
- `steps`: timestamps for `provisionedAt`, `settingsAppliedAt`, `seedAppliedAt`

Seed records:
- `seed.issues[]` entries include `key`, `number`, `url`.
- `seed.pullRequests[]` entries include `key`, `number`, `url`.

Warnings:
- `warnings` is an optional `string[]` of human-readable messages.
- `warningsDetailed` is an optional array of `{ step, message, code? }` for operators.
- Consumers must not machine-parse warning message text.

Partial-manifest semantics:
- The manifest is written as soon as provisioning succeeds.
- `steps` indicates which phases completed; `seed` may be absent if seeding did not run.
- Fields in `seed` are appended as artifacts are created (idempotent by `key`).
