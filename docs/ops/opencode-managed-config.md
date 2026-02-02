# Managed OpenCode Config (Ralph Daemon)

Status: canonical
Owner: @3mdistal
Last updated: 2026-02-01

Ralph daemon runs use a Ralph-managed OpenCode config directory instead of any user-global or repo-local OpenCode config. This keeps agent behavior deterministic across machines.

## Defaults

- Config dir: `$HOME/.ralph/opencode`
- Agents: `agent/build.md`, `agent/ralph-plan.md`, `agent/ralph-parent-verify.md`, `agent/product.md`, `agent/devex.md`
- Minimal `opencode.json` containing the required agent IDs

## Overrides

To override the managed config directory for daemon runs, set one of:

- `RALPH_OPENCODE_CONFIG_DIR` (environment variable)
- `opencode.managedConfigDir` in `~/.ralph/config.toml`

Ralph ignores any pre-set `OPENCODE_CONFIG_DIR` and uses `RALPH_OPENCODE_CONFIG_DIR` instead. Precedence is `RALPH_OPENCODE_CONFIG_DIR` (env) > `opencode.managedConfigDir` (config) > default. The override must be an absolute path (no `~` expansion).

Safety:

- Ralph refuses to manage a directory outside `$HOME` unless it already contains the `.ralph-managed-opencode` marker.
- If the override directory exists but does not look like a managed OpenCode config, Ralph requires the marker before it will overwrite it.
- Ralph refuses to write into symlinks, `$HOME`, or the Ralph home dir.

Ralph overwrites managed files on startup to keep them in sync with the version shipped in this repo.

## Isolation

Daemon runs isolate `XDG_CONFIG_HOME` by default so changes in user-global config do not leak into Ralph.

Ralph does not override `XDG_DATA_HOME` by default (to preserve OpenAI OAuth tokens under `XDG_DATA_HOME/opencode/auth.json`).

## Claims

Canonical claims live in `claims/canonical.jsonl`.
