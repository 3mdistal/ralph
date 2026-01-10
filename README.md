# Ralph Loop

Autonomous coding task orchestrator for OpenCode.

Ralph watches for `agent-task` notes in a bwrb vault and dispatches them to OpenCode agents. It handles the full lifecycle: planning, implementation, PR creation, and merge.

## Features

- **Queue-based task management** via bwrb notes
- **Parallel processing** across repos, sequential within each repo
- **Smart escalation** when agents need human guidance
- **Anomaly detection** catches agents stuck in loops
- **Introspection logging** for debugging agent behavior

## Requirements

- [Bun](https://bun.sh) >= 1.0.0
- [OpenCode](https://opencode.ai) CLI
- [bwrb](https://github.com/3mdistal/bwrb) CLI
- [gh](https://cli.github.com) CLI

## Installation

```bash
git clone https://github.com/3mdistal/ralph.git
cd ralph
bun install
```

## Configuration

Ralph reads configuration from environment or defaults:

| Setting | Env Var | Default |
|---------|---------|---------|
| bwrb vault | `RALPH_VAULT` | `~/Developer/teenylilthoughts` |
| Dev directory | `RALPH_DEV_DIR` | `~/Developer` |
| Batch size | `RALPH_BATCH_SIZE` | `10` |

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
  sessions/       # introspection logs per session
```

## How it works

1. **Watch** - Ralph watches `orchestration/tasks/` for queued tasks
2. **Dispatch** - Runs `/next-task <issue>` to plan the work
3. **Route** - Parses agent's decision: proceed or escalate
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

On daemon startup, Ralph checks for orphaned in-progress tasks:

1. **Tasks with session-id** - Resumed using `continueSession()`. The agent picks up where it left off.
2. **Tasks without session-id** - Reset to `queued` status. They'll be reprocessed from scratch.

### Graceful handling

- If session resume fails (expired session, OpenCode error), the task is escalated
- Session IDs are cleared when tasks complete or escalate
- Only one task per repo can be in-progress at a time; duplicates are reset to queued

### Benefits

- **Crash recovery** - No lost progress on unexpected restarts
- **Easier debugging** - Stop daemon, inspect state, resume
- **Token efficiency** - Avoid re-running completed work

## Drain mode (pause new work)

Ralph supports an operator-controlled "draining" mode that stops scheduling/dequeuing new tasks while allowing in-flight work to continue.

- Enable: create `~/.config/opencode/ralph/drain`
- Disable: delete `~/.config/opencode/ralph/drain`
- Observability: logs emit `Drain enabled` / `Drain disabled`, and `ralph status` shows `Mode: running|draining`

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
