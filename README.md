# Ralph Loop

Autonomous coding task orchestrator for OpenCode.

Ralph watches for GitHub issues labeled with `ralph:*` workflow labels (with optional bwrb fallback) and dispatches them to OpenCode agents. It handles the full lifecycle: planning, implementation, PR creation, and merge.

## Features

- **Queue-based task management** via GitHub issues (`ralph:*` labels) with optional bwrb fallback
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
- [bwrb](https://github.com/3mdistal/bwrb) CLI >= 0.1.3 (`npm install -g bwrb`) (needed for `.bwrbignore` negation)
- [gh](https://cli.github.com) CLI

## Worktree isolation guardrail

Ralph always runs workers inside a per-task git worktree and blocks execution if it cannot prove isolation. If the repo root checkout is dirty or a task is missing a valid `worktree-path`, the worker fails closed and reports the issue. This protects the main checkout from accidental writes.

If you previously installed bwrb via `pnpm link -g`, unlink it first so Ralph uses the published CLI on your PATH (Bun just shells out to the `bwrb` binary).

## Installation

```bash
git clone https://github.com/3mdistal/ralph.git
cd ralph
bun install
```

## Configuration

Ralph loads config from `~/.ralph/config.toml`, then `~/.ralph/config.json`, then falls back to legacy `~/.config/opencode/ralph/ralph.json` (with a warning). Config is merged over built-in defaults via a shallow merge (arrays/objects are replaced, not deep-merged).

When using the GitHub queue backend, `bwrbVault` is optional. When `queueBackend = "bwrb"`, `bwrbVault` resolves to the nearest directory containing `.bwrb/schema.json` starting from the current working directory (fallback: `process.cwd()`). This is a convenience for local development; for daemon use, set `bwrbVault` explicitly so Ralph always reads/writes the same queue. This repo ships with a vault schema at `.bwrb/schema.json`, so you can use your `ralph` checkout as the vault (and keep orchestration notes out of unrelated repos).

Note: `orchestration/` is gitignored in this repo, but bwrb still needs to traverse it for queue operations. `.bwrbignore` re-includes `orchestration/**` for bwrb even when `.gitignore` excludes it; if your queue appears empty, check `bwrb --version` and upgrade to >= 0.1.3.

Config is loaded once at startup, so restart the daemon after editing.

### Minimal example

`~/.ralph/config.toml` (GitHub queue backend):

```toml
devDir = "/absolute/path/to/your/dev-directory"
repos = [
  { name = "3mdistal/ralph", path = "/absolute/path/to/your/ralph", botBranch = "bot/integration" }
]
```

Or JSON (`~/.ralph/config.json`):

```json
{
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

- `queueBackend` (string): `github` (default), `bwrb`, or `none` (single daemon per queue required for GitHub)
- `bwrbVault` (string): bwrb vault path for the task queue (required when `queueBackend = "bwrb"`)
- `devDir` (string): base directory used to derive repo paths when not explicitly configured
- `owner` (string): default GitHub owner for short repo names
- `allowedOwners` (array): guardrail allowlist of repo owners (default: `[owner]`)
- `githubApp` (object, optional): GitHub App installation auth for `gh` + REST (tokens cached in memory)
  - `appId` (number|string)
  - `installationId` (number|string)
  - `privateKeyPath` (string): path to a PEM file; key material is never logged
- `repos` (array): per-repo overrides (`name`, `path`, `botBranch`, optional `requiredChecks`, optional `maxWorkers`, optional `rollupBatchSize`, optional `autoUpdateBehindPrs`, optional `autoUpdateBehindLabel`, optional `autoUpdateBehindMinMinutes`)
- `maxWorkers` (number): global max concurrent tasks (validated as positive integer; defaults to 6)
- `batchSize` (number): PRs before rollup (defaults to 10)
- `repos[].rollupBatchSize` (number): per-repo override for rollup batch size (defaults to `batchSize`)
- `ownershipTtlMs` (number): task ownership TTL in milliseconds (defaults to 60000)
- `repos[].autoUpdateBehindPrs` (boolean): proactively update PR branches when merge state is BEHIND (default: false)
- `repos[].autoUpdateBehindLabel` (string): optional label gate required for proactive update-branch
- `repos[].autoUpdateBehindMinMinutes` (number): minimum minutes between updates per PR (default: 30)
- Rollup batches persist across daemon restarts via `~/.ralph/state.sqlite`. Ralph stores the active batch, merged PR URLs, and rollup PR metadata to ensure exactly one rollup PR is created per batch.
- Rollup PRs include closing directives for issues referenced in merged PR bodies (`Fixes`/`Closes`/`Resolves #N`) and list included PRs/issues.
- `pollInterval` (number): ms between queue checks when polling (defaults to 30000)
- `watchdog` (object, optional): hung tool call watchdog (see below)
- `throttle` (object, optional): usage-based soft throttle scheduler gate (see `docs/ops/opencode-usage-throttling.md`)
- `opencode` (object, optional): named OpenCode XDG profiles (multi-account; see below)
  - `managedConfigDir` (string, optional): absolute path for Ralph-managed OpenCode config (default: `$HOME/.ralph/opencode`)
- `control` (object, optional): control file defaults
  - `autoCreate` (boolean): create `control.json` on startup (default: true)
  - `suppressMissingWarnings` (boolean): suppress warnings when control file missing (default: true)

Note: `repos[].requiredChecks` is an explicit override. If omitted, Ralph derives required checks from GitHub branch protection on `bot/integration` (or `repos[].botBranch`), falling back to the repository default branch (usually `main`). If branch protection is missing or unreadable, Ralph does not gate merges. Ralph considers both check runs and legacy status contexts when matching available check names. Values must match the GitHub check context name. Set it to `[]` to disable merge gating for a repo.


When `repos[].requiredChecks` is configured, Ralph enforces branch protection on `bot/integration` (or `repos[].botBranch`) and `main` to require those checks and PR merges with 0 approvals. The GitHub token must be able to manage branch protections, and the required check contexts must exist.
Setting `repos[].requiredChecks` to `[]` disables Ralph's merge gating but does not clear existing GitHub branch protection rules.

Ralph refuses to auto-merge PRs targeting `main` unless the issue has the `allow-main` label. This guardrail only affects Ralph automation; humans can still merge to `main` normally.

If Ralph logs that required checks are unavailable with `Available check contexts: (none)`, it usually means CI hasn't run on that branch yet. Push a commit or re-run your CI workflows to seed check runs/statuses, or update `repos[].requiredChecks` to match actual check names.

### Environment variables

Only these env vars are currently supported (unless noted otherwise):

| Setting | Env Var | Default |
|---------|---------|---------|
| Sessions dir | `RALPH_SESSIONS_DIR` | `~/.ralph/sessions` |
| Worktrees dir | `RALPH_WORKTREES_DIR` | `~/.ralph/worktrees` |
| Managed OpenCode config dir | `RALPH_OPENCODE_CONFIG_DIR` | `$HOME/.ralph/opencode` |
| Run log max bytes | `RALPH_RUN_LOG_MAX_BYTES` | `10485760` (10MB) |
| Run log backups | `RALPH_RUN_LOG_MAX_BACKUPS` | `3` |
| CI remediation attempts | `RALPH_CI_REMEDIATION_MAX_ATTEMPTS` | `2` |

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

Uses the GitHub App installation token when configured and filters results to the configured `allowedOwners`.

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
  state.sqlite    # durable metadata for idempotency + recovery (repos/issues/tasks/prs + sync/idempotency)
  sessions/       # introspection logs per session
```

## How it works

1. **Watch** - Ralph watches `orchestration/tasks/**` for queued (and restart-orphaned starting) tasks
2. **Dispatch** - Runs the planner prompt with `--agent ralph-plan`
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

Ralph supports an operator-controlled "draining" mode that stops scheduling/dequeuing new tasks while allowing in-flight work to continue, plus a paused mode that halts scheduling entirely.

Control file:

- `$XDG_STATE_HOME/ralph/control.json`
- Fallback: `~/.local/state/ralph/control.json`
- Last resort: `/tmp/ralph/<uid>/control.json`

Ralph auto-creates the control file on startup with `{ "mode": "running" }` unless disabled via config.

Example:

```json
{ "version": 1, "mode": "draining" }
```

Schema: `{ "version": 1, "mode": "running"|"draining"|"paused", "pause_requested"?: boolean, "pause_at_checkpoint"?: string, "drain_timeout_ms"?: number, "opencode_profile"?: string }` (unknown fields ignored)

- Enable drain: set `mode` to `draining`
- Disable drain: set `mode` to `running`
- Pause all scheduling: set `mode` to `paused`
- Pause at checkpoint: set `pause_requested=true` and optionally `pause_at_checkpoint`
- Active OpenCode profile: set `opencode_profile` (affects new tasks only; tasks pin their profile on start)
- Reload: daemon polls ~1s; send `SIGUSR1` for immediate reload
- Observability: logs emit `Control mode: draining|running|paused`, and `ralph status` shows `Mode: ...`

## Managed OpenCode config (daemon runs)

Ralph always runs OpenCode with `OPENCODE_CONFIG_DIR` pointing at `$HOME/.ralph/opencode`. This directory is owned by Ralph and overwritten on startup to match the version shipped in this repo (agents + a minimal `opencode.json`). Repo-local OpenCode config is ignored for daemon runs. Ralph ignores any pre-set `OPENCODE_CONFIG_DIR` and uses `RALPH_OPENCODE_CONFIG_DIR` instead. Override precedence is `RALPH_OPENCODE_CONFIG_DIR` (env) > `opencode.managedConfigDir` (config) > default. Overrides must be absolute paths (no `~` expansion). For safety, Ralph refuses to manage non-managed directories unless they already contain the `.ralph-managed-opencode` marker file. This does not change OpenCode profile storage; profiles still control XDG roots for auth/storage/usage logs.

## OpenCode profiles (multi-account)

Ralph can run OpenCode under named XDG roots so each account keeps separate `auth.json`, storage, and usage logs. This lets you cycle between Codex accounts—Ralph spends from account A while you work interactively on account B.

### Setting up a new profile

1. **Create profile directories:**

```bash
mkdir -p ~/.opencode-profiles/work/{data,config,state,cache}
mkdir -p ~/.opencode-profiles/personal/{data,config,state,cache}
```

2. **Authenticate each profile with OpenCode:**

```bash
# Authenticate the "work" profile
XDG_DATA_HOME=~/.opencode-profiles/work/data \
XDG_CONFIG_HOME=~/.opencode-profiles/work/config \
XDG_STATE_HOME=~/.opencode-profiles/work/state \
XDG_CACHE_HOME=~/.opencode-profiles/work/cache \
opencode auth login

# Authenticate the "personal" profile
XDG_DATA_HOME=~/.opencode-profiles/personal/data \
XDG_CONFIG_HOME=~/.opencode-profiles/personal/config \
XDG_STATE_HOME=~/.opencode-profiles/personal/state \
XDG_CACHE_HOME=~/.opencode-profiles/personal/cache \
opencode auth login
```

3. **Configure profiles in Ralph** (`~/.ralph/config.toml`):

```toml
[opencode]
defaultProfile = "work"

[opencode.profiles.work]
xdgDataHome = "/Users/you/.opencode-profiles/work/data"
xdgConfigHome = "/Users/you/.opencode-profiles/work/config"
xdgStateHome = "/Users/you/.opencode-profiles/work/state"
xdgCacheHome = "/Users/you/.opencode-profiles/work/cache"

[opencode.profiles.personal]
xdgDataHome = "/Users/you/.opencode-profiles/personal/data"
xdgConfigHome = "/Users/you/.opencode-profiles/personal/config"
xdgStateHome = "/Users/you/.opencode-profiles/personal/state"
xdgCacheHome = "/Users/you/.opencode-profiles/personal/cache"
```

### Switching the active profile

Edit the control file (`~/.local/state/ralph/control.json`):

```json
{ "mode": "running", "opencode_profile": "personal" }
```

Or send `SIGUSR1` to the daemon for immediate reload after editing.

You can also use automatic selection for new tasks:

```json
{ "mode": "running", "opencode_profile": "auto" }
```

New tasks will start under the active profile. In-flight tasks continue under their pinned profile.

### Per-profile throttle overrides

You can set different throttle budgets per profile.

If you configure a weekly reset schedule, the weekly throttle is computed as **tokens since the last reset boundary** (instead of a rolling 7-day window), and hard throttle resumes at the **next** reset time.

```toml
[throttle]
enabled = true
softPct = 0.65
hardPct = 0.75

[throttle.windows.rolling5h]
budgetTokens = 16987015

[throttle.windows.weekly]
budgetTokens = 55769305

# Weekly reset schedule (optional)
[throttle.reset.weekly]
# 0=Sun ... 6=Sat
# (example below is Thu 7:09pm)
dayOfWeek = 4
hour = 19
minute = 9
# Use an explicit IANA timezone so it matches Codex reliably
# (example: Indianapolis)
timeZone = "America/Indiana/Indianapolis"

# Override for "personal" profile (smaller budget)
[throttle.perProfile.personal]
softPct = 0.5
hardPct = 0.6

[throttle.perProfile.personal.windows.rolling5h]
budgetTokens = 8000000

[throttle.perProfile.personal.windows.weekly]
budgetTokens = 25000000

# Per-profile weekly reset overrides (optional)
# Example: match different Codex account reset times
[throttle.perProfile.apple.reset.weekly]
# Mon 7:05pm
dayOfWeek = 1
hour = 19
minute = 5
timeZone = "America/Indiana/Indianapolis"

[throttle.perProfile.google.reset.weekly]
# Thu 7:09pm
dayOfWeek = 4
hour = 19
minute = 9
timeZone = "America/Indiana/Indianapolis"
```

### Checking profile status

```bash
ralph status --json | jq '{mode, activeProfile, throttle: .throttle.state, pendingEscalations: .escalations.pending}'
```

Shows active profile, throttle state, pending escalations, and per-task profile assignments.

### Notes

- Paths must be absolute (no `~` expansion).
- New tasks start under the active `opencode_profile` from the control file (or `defaultProfile` when unset).
- Tasks persist `opencode-profile` in frontmatter and always resume under the same profile.
- Throttle is computed per profile—a throttled profile won't affect tasks on other profiles.

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
