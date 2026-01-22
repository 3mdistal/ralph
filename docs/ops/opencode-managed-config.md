# Managed OpenCode Config (Ralph Daemon)

Ralph daemon runs use a Ralph-managed OpenCode config directory instead of any user-global or repo-local OpenCode config. This keeps agent behavior deterministic across machines.

## Defaults

- Config dir: `$HOME/.ralph/opencode`
- Agents: `agent/build.md`, `agent/ralph-plan.md`, `agent/product.md`, `agent/devex.md`
- Minimal `opencode.json` containing `next-task` and the required agent IDs

## Overrides

To override the managed config directory for daemon runs, set one of:

- `RALPH_OPENCODE_CONFIG_DIR` (environment variable)
- `opencode.managedConfigDir` in `~/.ralph/config.toml`

Ralph ignores any pre-set `OPENCODE_CONFIG_DIR` and uses `RALPH_OPENCODE_CONFIG_DIR` instead. Precedence is `RALPH_OPENCODE_CONFIG_DIR` (env) > `opencode.managedConfigDir` (config) > default. The override must be an absolute path (no `~` expansion). Ralph refuses to manage directories without the `.ralph-managed-opencode` marker (to avoid accidental overwrite). Ralph overwrites managed files on startup to keep them in sync with the version shipped in this repo.
