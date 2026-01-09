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

### Check queue status

```bash
bun run status
```

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

## License

Private
