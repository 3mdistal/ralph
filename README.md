# Ralph Loop

Autonomous coding task orchestrator for OpenCode.

Ralph watches GitHub issues labeled with `ralph:*` workflow labels and dispatches them to OpenCode agents. It handles the full lifecycle: planning, implementation, PR creation, and merge.

## Features

- **Queue-based task management** via GitHub issues (`ralph:*` labels)
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

Control plane API (MVP):

- `GET /v1/state` (requires `Authorization: Bearer <token>`)
- `WS /v1/events` with auth via `Authorization` header, `Sec-WebSocket-Protocol: ralph.bearer.<token>`, or `?access_token=`

Dashboard TUI (MVP):

1. Enable the control plane with a token in `~/.ralph/config.toml` or `~/.ralph/config.json` (see `docs/product/dashboard-mvp-control-plane-tui.md`).
2. Run the TUI client:

```bash
RALPH_DASHBOARD_TOKEN="your-token" ralphctl dashboard
```

Optional flags: `--url`, `--host`, `--port`, `--token`, `--replay-last`.

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- [OpenCode](https://opencode.ai) CLI
- [gh](https://cli.github.com) CLI

## Worktree isolation guardrail

Ralph always runs workers inside a per-task git worktree and blocks execution if it cannot prove isolation. If the repo root checkout is dirty or a task is missing a valid `worktree-path`, the worker fails closed and reports the issue. This protects the main checkout from accidental writes.

### Legacy worktree cleanup

Older Ralph versions created git worktrees directly under `devDir` (for example, `~/Developer/worktree-<n>`). Ralph now warns when it detects these legacy paths but does not auto-delete them. To review and clean safe legacy worktrees:

```bash
ralph worktrees legacy --repo <owner/repo> --dry-run --action cleanup
ralph worktrees legacy --repo <owner/repo> --action cleanup
```

Optional: migrate safe legacy worktrees into the managed worktrees directory:

```bash
ralph worktrees legacy --repo <owner/repo> --action migrate
```

## Installation

```bash
git clone https://github.com/3mdistal/ralph.git
cd ralph
bun install
```

## Configuration

Ralph loads config from `~/.ralph/config.toml`, then `~/.ralph/config.json`, then falls back to legacy `~/.config/opencode/ralph/ralph.json` (with a warning). Config is merged over built-in defaults via a shallow merge (arrays/objects are replaced, not deep-merged).

GitHub Issues + labels are the operator queue surface. `~/.ralph/state.sqlite` is Ralph's canonical local machine state.

Config is loaded once at startup, so restart the daemon after editing.

### Minimal example

`~/.ralph/config.toml` (GitHub queue backend):

```toml
devDir = "/absolute/path/to/your/dev-directory"
repos = [
  {
    name = "3mdistal/ralph",
    path = "/absolute/path/to/your/ralph",
    botBranch = "bot/integration",
    setup = ["bun install --frozen-lockfile"]
  }
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
      "requiredChecks": ["CI"],
      "setup": ["bun install --frozen-lockfile"]
    }
  ]
}
```

Note: Config values are read as plain TOML/JSON. `~` is not expanded, and comments/trailing commas are not supported.

### Sandbox profile

Sandbox runs are opt-in and enforce a write tripwire. When `profile = "sandbox"`, you must provide a `sandbox` block with dedicated GitHub credentials and repo boundaries. Ralph fails fast at startup if the sandbox block is missing or invalid. Any GitHub write that targets a repo outside the sandbox boundary aborts with a `SANDBOX TRIPWIRE:` error.

`~/.ralph/config.toml`:

```toml
profile = "sandbox"
sandbox = {
  allowedOwners = ["3mdistal"],
  repoNamePrefix = "ralph-sandbox-",
  githubAuth = { tokenEnvVar = "GITHUB_SANDBOX_TOKEN" }
}
```

Or with a dedicated GitHub App installation:

```toml
profile = "sandbox"
sandbox = {
  allowedOwners = ["3mdistal"],
  repoNamePrefix = "ralph-sandbox-",
  githubAuth = { githubApp = { appId = 123, installationId = 456, privateKeyPath = "/abs/path/key.pem" } }
}
```

Optional provisioning block (used by `sandbox:init` / `sandbox:seed`):

```toml
profile = "sandbox"
sandbox = {
  allowedOwners = ["3mdistal"],
  repoNamePrefix = "ralph-sandbox-",
  githubAuth = { tokenEnvVar = "GITHUB_SANDBOX_TOKEN" },
  provisioning = {
    templateRepo = "3mdistal/ralph-sandbox-template",
    templateRef = "main",
    repoVisibility = "private",
    settingsPreset = "minimal",
    seed = { preset = "baseline" }
  }
}
```

Canonical sandbox provisioning contract: `docs/product/sandbox-provisioning.md`.

### Sandbox repo lifecycle

Sandbox run repos should be explicitly tagged with the `ralph-sandbox` topic before any automated teardown/prune. This is a hard safety invariant: teardown/prune refuses to mutate repos without the marker topic.

Commands (dry-run by default):

```bash
ralph sandbox tag --apply
ralph sandbox teardown --repo <owner/repo> --apply
ralph sandbox prune --apply
```

Defaults (override via flags or `sandbox.retention`):

- keep last 10 repos
- keep failed repos (topic `run-failed`) for 14 days
- default action is archive (reversible); delete requires `--delete --yes`

Notes:

- `ralph sandbox prune` skips repos that are already archived when action is `archive`.
- `ralph sandbox tag --failed` adds the `run-failed` topic even if `ralph-sandbox` is already present.

You can add the failed marker when tagging:

```bash
ralph sandbox tag --failed --apply
```

### Supported settings

- `queueBackend` (string): `github` (default) or `none` (single daemon per queue required for GitHub)
- `devDir` (string): base directory used to derive repo paths when not explicitly configured
- `owner` (string): default GitHub owner for short repo names
- `profile` (string): `prod` (default) or `sandbox`
- `sandbox` (object, required when `profile = "sandbox"`)
  - `allowedOwners` (array): non-empty allowlist of repo owners for sandbox runs
  - `repoNamePrefix` (string): required repo name prefix (e.g. `ralph-sandbox-`)
  - `githubAuth` (object): dedicated sandbox auth
    - `githubApp` (object): GitHub App installation auth for sandbox runs
    - `tokenEnvVar` (string): env var name for a fine-grained PAT restricted to sandbox repos
  - `provisioning` (object, optional): sandbox repo provisioning
    - `templateRepo` (string): required template repo (`owner/name`)
    - `templateRef` (string): template ref/branch (default: `main`)
    - `repoVisibility` (string): `private` (default; other values invalid)
    - `settingsPreset` (string): `minimal` (default) or `parity`
    - `seed` (object, optional): `{ preset = "baseline" }` or `{ file = "/abs/path/seed.json" }`
  - `retention` (object, optional): sandbox repo retention defaults
    - `keepLast` (number): keep last N repos (default: 10)
    - `keepFailedDays` (number): keep failed repos for N days (default: 14)
- `allowedOwners` (array): guardrail allowlist of repo owners (default: `[owner]`)
- `githubApp` (object, optional): GitHub App installation auth for `gh` + REST (tokens cached in memory)
  - `appId` (number|string)
  - `installationId` (number|string)
  - `privateKeyPath` (string): path to a PEM file; key material is never logged
- `repos` (array): per-repo overrides (`name`, `path`, `botBranch`, optional `requiredChecks`, optional `setup`, optional `concurrencySlots`, optional `maxWorkers` (deprecated), optional `schedulerPriority`, optional `rollupBatchSize`, optional `autoUpdateBehindPrs`, optional `autoUpdateBehindLabel`, optional `autoUpdateBehindMinMinutes`)
- `maxWorkers` (number): global max concurrent tasks (validated as positive integer; defaults to 6)
- `batchSize` (number): PRs before rollup (defaults to 10)
- `repos[].concurrencySlots` (number): per-repo concurrency slots (defaults to 1; overrides `repos[].maxWorkers`)
- `repos[].rollupBatchSize` (number): per-repo override for rollup batch size (defaults to `batchSize`)
- `repos[].schedulerPriority` (number): per-repo scheduler priority weighting (default: 1 when enabled; clamped to 0.1..10). Effective weight = `schedulerPriority * issuePriorityWeight` (p0..p4 => 5..1). Scheduling switches to weighted selection when any repo sets this field; otherwise legacy round-robin remains.
- `ownershipTtlMs` (number): task ownership TTL in milliseconds (defaults to 60000)
- `repos[].autoUpdateBehindPrs` (boolean): proactively update PR branches when merge state is BEHIND (default: false)
- `repos[].autoUpdateBehindLabel` (string): optional label gate required for proactive update-branch
- `repos[].autoUpdateBehindMinMinutes` (number): minimum minutes between updates per PR (default: 30)
- `repos[].autoQueue` (object, optional): auto-queue configuration
  - `enabled` (boolean): enable auto-queue reconciliation (default: false)
  - `scope` (string): `labeled-only` or `all-open` (default: `labeled-only`)
  - `maxPerTick` (number): cap issues reconciled per sync tick (default: 200)
  - `dryRun` (boolean): compute decisions without mutating labels (default: false)
- `repos[].setup` (array): optional setup commands to run in the task worktree before any agent execution (operator-owned)
- `repos[].preflightCommand` (string|string[]): deterministic preflight commands run in the task worktree before Ralph opens PRs (normalized to string[]). Preflight is required by default; set this explicitly for each repo, or set `repos[].preflightCommand=[]` to explicitly disable.
- `repos[].productGapDeterministicContract` (`required`|`best-effort`): controls whether PRODUCT GAP signals caused only by missing canonical deterministic artifacts (for example `claims/canonical.jsonl` / `docs/product/deterministic-gates.md`) are hard-blocking. Default is `best-effort` (downgrade to warning/non-blocking); set `required` to preserve strict blocking.
- `repos[].verification` (object, optional): rollup PR verification guidance
  - `preflight` (array): legacy alias for `repos[].preflightCommand` (string[])
  - `e2e` (array): human E2E scenarios (`[{ title?: string, steps: string[] }]`)
  - `staging` (array): staging/preview checks (`[{ url: string, expected?: string }]`)
- Rollup batches persist across daemon restarts via `~/.ralph/state.sqlite`. Ralph stores the active batch, merged PR URLs, and rollup PR metadata to ensure exactly one rollup PR is created per batch.
- Rollup PRs include closing directives for issues referenced in merged PR bodies (`Fixes`/`Closes`/`Resolves #N`) and list included PRs/issues.
- Rollup PRs propagate a bounded "Manual checks" section from child PR bodies (if present). Supported formats in child PR bodies:
  - Preferred markers: `<!-- ralph:manual-checks:start -->` ... `<!-- ralph:manual-checks:end -->`
  - Fallback heading: `## Manual checks` (captured until the next heading of same-or-higher level)
- `pollInterval` (number): ms between queue checks when polling (defaults to 30000)
- `doneReconcileIntervalMs` (number): ms between GitHub done reconciliation checks (defaults to 300000)
- `watchdog` (object, optional): hung tool call watchdog (see below)
- `stall` (object, optional): idle session stall detector + recovery ladder (see below)
- `loopDetection` (object, optional): edit-churn loop detection (stop early + escalate; see below)
- `repos[].loopDetection` (object, optional): per-repo override for loop detection
- `throttle` (object, optional): usage-based soft throttle scheduler gate (see `docs/ops/opencode-usage-throttling.md`)
- `opencode` (object, optional): named OpenCode XDG profiles (multi-account; see below)
  - `managedConfigDir` (string, optional): absolute path for Ralph-managed OpenCode config (default: `$HOME/.ralph/opencode`)
- `control` (object, optional): control file defaults
  - `autoCreate` (boolean): create `control.json` on startup (default: true)
  - `suppressMissingWarnings` (boolean): suppress warnings when control file missing (default: true)
- `dashboard` (object, optional): control plane event persistence
  - `eventsRetentionDays` (number): days to keep `~/.ralph/events/YYYY-MM-DD.jsonl` logs (default: 14; UTC bucketing; cleanup on daemon startup)
  - `controlPlane` (object, optional): local control plane server
    - `enabled` (boolean): start the control plane server (default: false)
    - `host` (string): bind host (default: `127.0.0.1`)
    - `port` (number): bind port (default: `8787`)
    - `token` (string): Bearer token required for all endpoints (server will not start without it)
    - `allowRemote` (boolean): allow binding to non-loopback hosts (default: false)
    - `exposeRawOpencodeEvents` (boolean): stream `log.opencode.event` payloads (default: false)
    - `replayLastDefault` (number): default replay count for `/v1/events` (default: 50)
    - `replayLastMax` (number): max replay count for `/v1/events` (default: 250)

Note: `repos[].requiredChecks` is an explicit override. If omitted, Ralph derives required checks from GitHub branch protection on `bot/integration` (or `repos[].botBranch`), falling back to the repository default branch (usually `main`). If branch protection is missing or unreadable, Ralph does not gate merges. Ralph considers both check runs and legacy status contexts when matching available check names. Values must match the GitHub check context name. Set it to `[]` to disable merge gating for a repo.

Note: `repos[].setup` commands run in the task worktree before any OpenCode agent execution. Setup is cached per worktree by `(commands hash + lockfile signature)`; if commands or lockfiles change, setup runs again.


When `repos[].requiredChecks` is configured, Ralph enforces branch protection on `bot/integration` (or `repos[].botBranch`) and `main` to require those checks and PR merges with 0 approvals. The GitHub token must be able to manage branch protections. If required check contexts are missing (including when no check contexts exist yet), Ralph logs a warning, proceeds without protection for now, and retries after a short delay.
Setting `repos[].requiredChecks` to `[]` disables Ralph's merge gating but does not clear existing GitHub branch protection rules.

Ralph refuses to auto-merge PRs targeting `main` unless the issue has the `allow-main` label. This guardrail only affects Ralph automation; humans can still merge to `main` normally.

If Ralph logs that required checks are unavailable with `Available check contexts: (none)`, it usually means CI hasn't run on that branch yet. Push a commit or re-run your CI workflows to seed check runs/statuses, or update `repos[].requiredChecks` to match actual check names. Ralph will retry branch protection after the defer window.

### GitHub auth precedence

Ralph uses the GitHub App installation token when `githubApp` is configured. If no `githubApp` is configured, it falls back to `GH_TOKEN` or `GITHUB_TOKEN` from the environment. Env tokens are ignored when `githubApp` is configured to avoid using stale installation tokens that were minted earlier for `gh` CLI calls.

When `profile = "sandbox"`, Ralph uses only `sandbox.githubAuth` (GitHub App or `tokenEnvVar`) and never falls back to prod credentials. If sandbox config is missing or invalid, Ralph fails fast at startup.

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
| Control plane enabled | `RALPH_DASHBOARD_ENABLED` | `false` |
| Control plane host | `RALPH_DASHBOARD_HOST` | `127.0.0.1` |
| Control plane port | `RALPH_DASHBOARD_PORT` | `8787` |
| Control plane token | `RALPH_DASHBOARD_TOKEN` | (none) |
| Control plane replay default | `RALPH_DASHBOARD_REPLAY_DEFAULT` | `50` |
| Control plane replay max | `RALPH_DASHBOARD_REPLAY_MAX` | `250` |
| GitHub API max in-flight requests | `RALPH_GITHUB_MAX_INFLIGHT` | `16` |
| GitHub API max in-flight writes | `RALPH_GITHUB_MAX_INFLIGHT_WRITES` | `2` |
| GitHub issue sync max in-flight repos | `RALPH_GITHUB_ISSUES_SYNC_MAX_INFLIGHT` | `2` |
| GitHub issue sync max pages per tick (bootstrap) | `RALPH_GITHUB_ISSUES_SYNC_MAX_PAGES_PER_TICK` | `2` |
| GitHub issue sync max issues per tick (bootstrap) | `RALPH_GITHUB_ISSUES_SYNC_MAX_ISSUES_PER_TICK` | `200` |

Run logs are written under `$XDG_STATE_HOME/ralph/run-logs` (fallback: `~/.local/state/ralph/run-logs`).

Note: If `RALPH_SESSIONS_DIR` / `RALPH_WORKTREES_DIR` are relative paths, they resolve relative to the current working directory.

Older README versions mentioned `RALPH_VAULT`, `RALPH_DEV_DIR`, and `RALPH_BATCH_SIZE`; these are not supported by current releases. Use `~/.ralph/config.toml` or `~/.ralph/config.json` instead.

### Troubleshooting

- **Config changes not taking effect**: Ralph caches config after the first `loadConfig()`; restart the daemon.
- **Config file not picked up**: Ralph reads `~/.ralph/config.toml`, then `~/.ralph/config.json`, then falls back to legacy `~/.config/opencode/ralph/ralph.json`.
- **Config parse errors**: Ralph logs `[ralph] Failed to load TOML/JSON config from ...` and continues with defaults.
- **Invalid maxWorkers/concurrencySlots values**: Non-positive/non-integer values fall back to defaults and emit a warning.

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

Status output includes an onboarding checklist per managed repo (pass/warn/fail with remediation hints), blocked tasks with reasons/idle age, and recent alert summaries (when available).

Machine-readable output:

```bash
bun run status --json
```

JSON output includes an optional versioned `onboarding` object (`version`, `repos[]`, per-check status/reason/remediation), plus a `blocked` array with `blockedAt`, `blockedSource`, `blockedReason`, a short `blockedDetailsSnippet`, and per-task `alerts` summaries when present.

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

### GitHub API usage summary (telemetry)

Reads `github.request` events from `~/.ralph/events/YYYY-MM-DD.jsonl` and summarizes hottest endpoints and rate-limit/backoff behavior.

```bash
ralph github-usage --since 24h
ralph github-usage --date 2026-02-03
ralph github-usage --since 6h --json
```

### Runs (top + trace pointers)

List the most expensive runs (default window is last 7 days):

```bash
ralph runs top
ralph runs top --sort triage_score --include-missing
ralph runs top --since 14d --limit 50
ralph runs top --all --json
```

Show a specific run (includes session IDs, trace paths, and run logs when known):

```bash
ralph runs show <runId>
ralph runs show <runId> --json
```

### Sandbox provisioning

```bash
bun run sandbox:init
```

Skip seeding:

```bash
bun run sandbox:init --no-seed
```

Seed an existing sandbox repo (defaults to newest manifest if `--run-id` omitted):

```bash
bun run sandbox:seed --run-id <run-id>
```

Manifests are written to `~/.ralph/sandbox/manifests/<runId>.json`.

### Nudge an in-progress task

```bash
ralph nudge <taskRef> "Just implement it, stop asking questions"
```

- Best-effort queued delivery: Ralph queues the message and delivers it at the next safe checkpoint (between `continueSession(...)` runs).
- Success means the delivery attempt succeeded, not guaranteed agent compliance.
- Delivery is FIFO per session; multiple messages deliver sequentially at a checkpoint and stop on the first failed attempt.
- If a worker is paused at a checkpoint (or hard-throttled), delivery is deferred and the attempt is not burned.

### Release a stuck task slot (local-only)

```bash
ralph queue release --repo <owner/repo> --issue <n>
```

- Clears the local slot reservation and marks the task released in SQLite.
- Does not attempt GitHub label writes; labels converge later via reconciliation.


### Seed sandbox edge cases

```bash
ralph sandbox seed --repo <owner/repo>
```

Seeds a sandbox repo with deterministic edge-case issues/relationships (dependency graphs, sub-issues, label drift, and collision tasks). This command requires `profile = "sandbox"` with a configured sandbox allowlist/prefix.

Useful flags:

```bash
ralph sandbox seed --repo <owner/repo> --dry-run
ralph sandbox seed --repo <owner/repo> --manifest sandbox/seed-manifest.v1.json --out sandbox/seed-ids.v1.json
```


### Queue a task

Use GitHub labels on the issue:

```bash
gh issue edit <number> --add-label "ralph:status:queued"
```

Ralph will pick it up and dispatch an agent.

## Architecture

```
~/.ralph/
  config.toml     # preferred config (if present)
  config.json     # fallback config
  state.sqlite    # durable metadata for idempotency + recovery (repos/issues/tasks/prs + sync/idempotency)
  sessions/       # introspection logs per session (events.jsonl + summary.json)
```

## How it works

1. **Watch** - Ralph watches GitHub issues with `ralph:status:queued` (and restart-orphaned `starting`) tasks
2. **Dispatch** - Runs the planner prompt with `--agent ralph-plan`
3. **Route** - Parses agent's decision (policy: `docs/escalation-policy.md`): proceed or escalate
4. **Build** - If proceeding, tells agent to implement
5. **Monitor** - Watches for anomalies (stuck loops)
6. **Complete** - Extracts PR URL, triggers merge, runs survey
7. **Record** - Persists run metadata and gate artifacts to SQLite

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

Schema: `{ "version": 1, "mode": "running"|"draining"|"paused", "pause_requested"?: boolean, "pause_at_checkpoint"?: string, "drain_timeout_ms"?: number }` (unknown fields ignored)

- Enable drain: set `mode` to `draining`
- Disable drain: set `mode` to `running`
- Pause all scheduling: set `mode` to `paused`
- Pause at checkpoint: set `pause_requested=true` (pauses at the next checkpoint). If you set `pause_at_checkpoint`, Ralph will keep running until it reaches that named checkpoint, then pause.
- Active OpenCode profile: set `[opencode].defaultProfile` in `~/.ralph/config.toml` (affects new tasks only; tasks pin their profile on start)
- Reload: daemon polls ~1s; send `SIGUSR1` for immediate reload
- Observability: logs emit `Control mode: draining|running|paused`, and `ralph status` shows `Mode: ...`

### ralphctl (operator CLI)

`ralphctl` wraps the control file and restart flow:

- `ralphctl status [--json]`
- `ralphctl doctor [--json] [--repair] [--dry-run]`
- `ralphctl drain [--timeout 5m] [--pause-at-checkpoint <checkpoint>]`
- `ralphctl resume`
- `ralphctl restart [--grace 5m] [--start-cmd "<command>"]`
- `ralphctl upgrade [--grace 5m] [--start-cmd "<command>"] [--upgrade-cmd "<command>"]`

Daemon discovery for restart/upgrade uses a lease record at:

- `$XDG_STATE_HOME/ralph/daemon.json`
- Fallback: `~/.local/state/ralph/daemon.json`
- Last resort: `/tmp/ralph/<uid>/daemon.json`

The daemon writes this file on startup (PID, daemonId, and start command). Use `--start-cmd` to override when needed.

`ralphctl doctor` audits daemon record and control file consistency across canonical and legacy roots, reports stale/conflicting records, and recommends safe repairs.

- Default mode is read-only (no state changes).
- Use `--repair` to apply safe, explicit repairs only.
- Use `--dry-run` with `--repair` to preview applied actions without mutation.

Exit codes:

- `0`: healthy (`overall_status = "ok"`)
- `1`: findings present (`overall_status = "warn" | "error"`)
- `2`: usage error or unexpected internal failure

`ralphctl doctor --json` contract (schema v1, additive-only evolution):

- Top-level required fields: `schema_version`, `timestamp`, `overall_status`, `ok`
- Candidate arrays: `daemon_candidates[]`, `control_candidates[]`, `roots[]`
- Decision arrays: `findings[]`, `recommended_repairs[]`, `applied_repairs[]`
- Stable identifiers: each finding includes `code`; each repair includes `id` and `code`

## Managed OpenCode config (daemon runs)

Ralph always runs OpenCode with `OPENCODE_CONFIG_DIR` pointing at `$HOME/.ralph/opencode`. This directory is owned by Ralph and overwritten on startup to match the version shipped in this repo (agents + a minimal `opencode.json`). Repo-local OpenCode config is ignored for daemon runs. Ralph ignores any pre-set `OPENCODE_CONFIG_DIR` and uses `RALPH_OPENCODE_CONFIG_DIR` instead. Override precedence is `RALPH_OPENCODE_CONFIG_DIR` (env) > `opencode.managedConfigDir` (config) > default. Overrides must be absolute paths (no `~` expansion). For safety, Ralph refuses to manage non-managed directories unless they already contain the `.ralph-managed-opencode` marker file.

Isolation:

- Daemon runs isolate `XDG_CONFIG_HOME` by default so changes in user-global config do not leak into Ralph.
- Daemon runs keep `XDG_DATA_HOME` shared by default to preserve OpenAI OAuth tokens under `XDG_DATA_HOME/opencode/auth.json`.

Daemon runs do not rely on `~/.config/opencode` plugins. Ralph emits its own introspection artifacts at `~/.ralph/sessions/<sessionId>/events.jsonl` and `~/.ralph/sessions/<sessionId>/summary.json` for watchdog/anomaly detection.

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

Edit `~/.ralph/config.toml`:

```toml
[opencode]
defaultProfile = "personal"
```

You can also use automatic selection for new tasks (for example between "apple", "google", and "tempo"):

```toml
[opencode]
defaultProfile = "auto"
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

[throttle.perProfile.tempo.reset.weekly]
# Wed 7:12pm
dayOfWeek = 3
hour = 19
minute = 12
timeZone = "America/Indiana/Indianapolis"
```

### Checking profile status

```bash
ralph status --json | jq '{mode, activeProfile, throttle: .throttle.state, pendingEscalations: .escalations.pending}'
```

Shows active profile, throttle state, pending escalations, and per-task profile assignments.

### Checking gate state

```bash
ralph gates 3mdistal/ralph 232 --json | jq '.gates'
```

Shows the latest persisted deterministic gate state and any bounded artifacts for the issue.

### Notes

- Paths must be absolute (no `~` expansion).
- New tasks start under `[opencode].defaultProfile`.
- `defaultProfile` may be set to `"auto"` to auto-select a profile for new work.
- Tasks persist `opencode-profile` in frontmatter and always resume under the same profile.
- Throttle is computed per profile—a throttled profile won't affect tasks on other profiles.

## Watchdog (Hung Tool Calls)

In daemon mode, a single tool call can hang indefinitely. Ralph uses a watchdog to ensure runs never silently stall:

- **Soft timeout**: log-only heartbeat warning (no interruption)
- **Hard timeout**: kill the in-flight `opencode` run, re-queue the task once with a cleared `session-id`, then escalate if it repeats

### Configuration

Configure via `~/.ralph/config.toml` or `~/.ralph/config.json` under `watchdog` (legacy `~/.config/opencode/ralph/ralph.json` is still supported):

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

## Stall Detection (Idle Sessions)

In daemon mode, an OpenCode run can wedge without tripping per-tool watchdog thresholds (e.g. stuck between tool calls). Ralph also detects run-level stalls by watching session activity and applying a deterministic recovery ladder:

- **Nudge**: after `stall.nudgeAfterMs` of inactivity, re-queue the task to resume the same session with a nudge prompt
- **Restart** (once): if it stalls again, re-queue with a cleared `session-id` to start a fresh session
- **Escalate**: if it stalls again after the restart, escalate with trace pointers

### Configuration

```json
{
  "stall": {
    "enabled": true,
    "idleMs": 300000,
    "nudgeAfterMs": 300000,
    "restartAfterMs": 600000,
    "maxRestarts": 1
  }
}
```

## Loop Detection (Edit Churn)

Sometimes an agent can burn a full watchdog budget repeatedly editing files without running deterministic gates (typecheck/tests/build).
Loop detection lets Ralph stop early and escalate with a bounded, GitHub-visible handoff.

Notes:
- Disabled by default (`enabled: false`).
- Gate detection is deterministic and based on a command allowlist (`gateMatchers`).
- When thresholds trip, Ralph kills the in-flight run and escalates with top repeated files + a recommended next gate command.

### Configuration

```json
{
  "loopDetection": {
    "enabled": false,
    "gateMatchers": ["bun test", "bun run typecheck", "bun run build", "bun run knip"],
    "recommendedGateCommand": "bun test",
    "thresholds": {
      "minEdits": 20,
      "minElapsedMsWithoutGate": 480000,
      "minTopFileTouches": 8,
      "minTopFileShare": 0.6
    }
  }
}
```

## License

Private
