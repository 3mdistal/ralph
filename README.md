# Ralph Loop

Autonomous coding task orchestrator for OpenCode.

Ralph watches for `agent-task` notes in a bwrb vault and dispatches them to OpenCode agents. It handles the full lifecycle: planning, implementation, PR creation, and merge.

## Features

- **Queue-based task management** via bwrb notes
- **Parallel processing** across repos, sequential within each repo
- **Smart escalation** when agents need human guidance (policy: `docs/escalation-policy.md`)
- **Anomaly detection** catches agents stuck in loops
- **Introspection logging** for debugging agent behavior

## Escalation policy

Canonical routing/escalation rules live in `docs/escalation-policy.md`.

## Operator dashboard (planned)

Ralph’s control plane (operator dashboard) is **operator tooling** (not a user-facing UI): a local, token-authenticated API that publishes structured events, with a TUI as the first client.

- Local-only by default (binds `127.0.0.1`) and requires `Authorization: Bearer <token>` on all endpoints; no built-in TLS.
- Single-user, local-machine threat model; not hardened for hostile networks.
- Remote access is via SSH port-forwarding or your own proxy.
- Canonical spec: `docs/product/dashboard-mvp-control-plane-tui.md`
- Issue map: https://github.com/3mdistal/ralph/issues/22 (MVP epic) and https://github.com/3mdistal/ralph/issues/23 (docs/scope)

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- [OpenCode](https://opencode.ai) CLI
- [bwrb](https://github.com/3mdistal/bwrb) CLI (`npm install -g bwrb`)
- [gh](https://cli.github.com) CLI

If you previously installed bwrb via `pnpm link -g`, unlink it first so Ralph uses the published CLI on your PATH (Bun just shells out to the `bwrb` binary).

## Installation

```bash
git clone https://github.com/3mdistal/ralph.git
cd ralph
bun install
```

## Configuration

Ralph loads config from `~/.ralph/config.toml`, then `~/.ralph/config.json`, then falls back to legacy `~/.config/opencode/ralph/ralph.json` (with a warning). Config is merged over built-in defaults via a shallow merge (arrays/objects are replaced, not deep-merged).

By default, `bwrbVault` resolves to the nearest directory containing `.bwrb/schema.json` starting from the current working directory (fallback: `process.cwd()`). This is a convenience for local development; for daemon use, set `bwrbVault` explicitly so Ralph always reads/writes the same queue. This repo ships with a vault schema at `.bwrb/schema.json`, so you can use your `ralph` checkout as the vault (and keep orchestration notes out of unrelated repos).

Config is loaded once at startup, so restart the daemon after editing.

### Minimal example

`~/.ralph/config.toml`:

```toml
bwrbVault = "/absolute/path/to/your/ralph"
devDir = "/absolute/path/to/your/dev-directory"
repos = [
  { name = "3mdistal/ralph", path = "/absolute/path/to/your/ralph", botBranch = "bot/integration" }
]
```

Or JSON (`~/.ralph/config.json`):

```json
{
  "bwrbVault": "/absolute/path/to/your/ralph",
  "devDir": "/absolute/path/to/your/dev-directory",
  "repos": [
    {
      "name": "3mdistal/ralph",
      "path": "/absolute/path/to/your/ralph",
      "botBranch": "bot/integration",
      "requiredChecks": ["CI"]
    }
  ]
}
```

Note: Config values are read as plain TOML/JSON. `~` is not expanded, and comments/trailing commas are not supported.

### Supported settings

- `bwrbVault` (string): bwrb vault path for the task queue
- `devDir` (string): base directory used to derive repo paths when not explicitly configured
- `owner` (string): default GitHub owner for short repo names
- `allowedOwners` (array): guardrail allowlist of repo owners (default: `[owner]`)
- `githubApp` (object, optional): GitHub App installation auth for `gh` + REST
  - `appId` (number|string)
  - `installationId` (number|string)
  - `privateKeyPath` (string): path to a PEM file; key material is never logged
- `repos` (array): per-repo overrides (`name`, `path`, `botBranch`, optional `requiredChecks`, optional `maxWorkers`)
- `maxWorkers` (number): global max concurrent tasks (validated as positive integer; defaults to 6)
- `batchSize` (number): PRs before rollup (defaults to 10)
- `pollInterval` (number): ms between queue checks when polling (defaults to 30000)
- `watchdog` (object, optional): hung tool call watchdog (see below)
- `throttle` (object, optional): usage-based soft throttle scheduler gate (see `docs/ops/opencode-usage-throttling.md`)
- `opencode` (object, optional): named OpenCode XDG profiles (multi-account; see below)

Note: `repos[].requiredChecks` defaults to `["ci"]` when omitted. Values must match the GitHub check context name. Set it to `[]` to disable merge gating for a repo.

### Environment variables

Only these env vars are currently supported:

| Setting | Env Var | Default |
|---------|---------|---------|
| Sessions dir | `RALPH_SESSIONS_DIR` | `~/.ralph/sessions` |
| Worktrees dir | `RALPH_WORKTREES_DIR` | `~/.ralph/worktrees` |
| Run log max bytes | `RALPH_RUN_LOG_MAX_BYTES` | `10485760` (10MB) |
| Run log backups | `RALPH_RUN_LOG_MAX_BACKUPS` | `3` |

Run logs are written under `$XDG_STATE_HOME/ralph/run-logs` (fallback: `~/.local/state/ralph/run-logs`).

Note: If `RALPH_SESSIONS_DIR` / `RALPH_WORKTREES_DIR` are relative paths, they resolve relative to the current working directory.

Older README versions mentioned `RALPH_VAULT`, `RALPH_DEV_DIR`, and `RALPH_BATCH_SIZE`; these are not supported by current releases. Use `~/.ralph/config.toml` or `~/.ralph/config.json` instead.

### Troubleshooting

- **Config changes not taking effect**: Ralph caches config after the first `loadConfig()`; restart the daemon.
- **Config file not picked up**: Ralph reads `~/.ralph/config.toml`, then `~/.ralph/config.json`, then falls back to legacy `~/.config/opencode/ralph/ralph.json`.
- **Config parse errors**: Ralph logs `[ralph] Failed to load TOML/JSON config from ...` and continues with defaults.
- **Invalid maxWorkers values**: Non-positive/non-integer values fall back to defaults and emit a warning.

## Usage

### Start the daemon

```bash
bun start
```

Or for development with auto-reload:

```bash
bun dev
```

### Check daemon status

```bash
bun run status
```

Machine-readable output:

```bash
bun run status --json
```

Live updates (prints when status changes):

```bash
bun run watch
```

### List accessible repos

```bash
ralph repos
```

Machine-readable output:

```bash
ralph repos --json
```

### Nudge an in-progress task

```bash
ralph nudge <taskRef> "Just implement it, stop asking questions"
```

- Best-effort queued delivery: Ralph queues the message and delivers it at the next safe checkpoint (between `continueSession(...)` runs).
- Success means the delivery attempt succeeded, not guaranteed agent compliance.


### Queue a task

Create an `agent-task` note in your bwrb vault:

```bash
bwrb new agent-task --json '{
  "name": "repo 123 - Fix the bug",
  "issue": "owner/repo#123",
  "repo": "owner/repo",
  "status": "queued",
  "priority": "p2-medium",
  "scope": "builder",
  "creation-date": "2026-01-09"
}'
```

Ralph will pick it up and dispatch an agent.

## Architecture

```
orchestration/
  tasks/          # agent-task notes (queue)
  runs/           # agent-run notes (completed work)
  escalations/    # agent-escalation notes (needs human)

~/.ralph/
  config.toml     # preferred config (if present)
  config.json     # fallback config
  state.sqlite    # durable metadata for idempotency + recovery
  sessions/       # introspection logs per session
```

## How it works

1. **Watch** - Ralph watches `orchestration/tasks/**` for queued (and restart-orphaned starting) tasks
2. **Dispatch** - Runs `/next-task <issue>` to plan the work
3. **Route** - Parses agent's decision (policy: `docs/escalation-policy.md`): proceed or escalate
4. **Build** - If proceeding, tells agent to implement
5. **Monitor** - Watches for anomalies (stuck loops)
6. **Complete** - Extracts PR URL, triggers merge, runs survey
7. **Record** - Creates `agent-run` note with session summary

## Session Persistence

Ralph persists OpenCode session IDs to survive daemon restarts. This prevents losing agent progress when Ralph crashes or is manually stopped.

### How it works

When a task starts, Ralph saves the OpenCode session ID to the task's frontmatter:

```yaml
---
status: in-progress
session-id: ses_abc123
---
```

On daemon startup, Ralph checks for orphaned starting/in-progress tasks:

1. **Tasks with session-id** - Resumed using `continueSession()`. The agent picks up where it left off.
2. **Tasks without session-id** - Reset to `starting` status (restart-safe pre-session state), then retried from scratch.

### Graceful handling

- If session resume fails (expired session, OpenCode error), Ralph clears `session-id` and re-queues the task for a fresh run
- Session IDs are cleared when tasks complete; preserved on escalation so the same session can be resumed after HITL resolution
- Only one task per repo can be in-progress at a time; duplicates are reset to queued

### Benefits

- **Crash recovery** - No lost progress on unexpected restarts
- **Easier debugging** - Stop daemon, inspect state, resume
- **Token efficiency** - Avoid re-running completed work

## Drain mode (pause new work)

Ralph supports an operator-controlled "draining" mode that stops scheduling/dequeuing new tasks while allowing in-flight work to continue.

Control file:

- `$XDG_STATE_HOME/ralph/control.json`
- Fallback: `~/.local/state/ralph/control.json`

Example:

```json
{ "mode": "draining" }
```

Schema: `{ "mode": "running"|"draining", "pause_requested"?: boolean, "opencode_profile"?: string }` (unknown fields ignored)

- Enable drain: set `mode` to `draining`
- Disable drain: set `mode` to `running`
- Active OpenCode profile: set `opencode_profile` (affects new tasks only; tasks pin their profile on start)
- Reload: daemon polls ~1s; send `SIGUSR1` for immediate reload
- Observability: logs emit `Control mode: draining|running`, and `ralph status` shows `Mode: ...`

## OpenCode profiles (multi-account)

Ralph can run OpenCode under named XDG roots so each account keeps separate `auth.json`, storage, and usage logs.

Example `~/.ralph/config.toml`:

```toml
[opencode]
defaultProfile = "apple"

[opencode.profiles.apple]
xdgDataHome = "/absolute/path/to/opencode-apple/data"
xdgConfigHome = "/absolute/path/to/opencode-apple/config"
xdgStateHome = "/absolute/path/to/opencode-apple/state"
xdgCacheHome = "/absolute/path/to/opencode-apple/cache"
```

Notes:

- Paths must be absolute (no `~` expansion).
- New tasks start under the active `opencode_profile` from the control file (or `defaultProfile` when unset).
- Tasks persist `opencode-profile` in frontmatter and always resume under the same profile.

## Watchdog (Hung Tool Calls)

In daemon mode, a single tool call can hang indefinitely. Ralph uses a watchdog to ensure runs never silently stall:

- **Soft timeout**: log-only heartbeat warning (no interruption)
- **Hard timeout**: kill the in-flight `opencode` run, re-queue the task once with a cleared `session-id`, then escalate if it repeats

### Configuration

Configure via `~/.config/opencode/ralph/ralph.json` under `watchdog`:

```json
{
  "watchdog": {
    "enabled": true,
    "softLogIntervalMs": 30000,
    "recentEventLimit": 50,
    "thresholdsMs": {
      "read": { "softMs": 30000, "hardMs": 120000 },
      "glob": { "softMs": 30000, "hardMs": 120000 },
      "grep": { "softMs": 30000, "hardMs": 120000 },
      "task": { "softMs": 180000, "hardMs": 600000 },
      "bash": { "softMs": 300000, "hardMs": 1800000 }
    }
  }
}
```

## License

Private
