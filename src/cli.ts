#!/usr/bin/env bun

import { getRalphVersion } from "./version";

function printGlobalHelp(): void {
  console.log(
    [
      "Ralph Loop (ralph)",
      "",
      "Usage:",
      "  ralph                              Run daemon (default)",
      "  ralph resume                       Resume orphaned in-progress tasks, then exit",
      "  ralph status [--json]              Show daemon/task status",
      "  ralph runs top|show ...             List expensive runs + trace pointers",
      "  ralph gates <repo> <issue> [--json] Show deterministic gate state",
      "  ralph usage [--json] [--profile]   Show OpenAI usage meters (by profile)",
      "  ralph github-usage [--since 24h]   Summarize GitHub API request telemetry",
      "  ralph repos [--json]               List accessible repos (GitHub App installation)",
      "  ralph watch                        Stream status updates (Ctrl+C to stop)",
      "  ralph nudge <taskRef> \"<message>\"    Queue an operator message for an in-flight task",
      "  ralph sandbox <tag|teardown|prune> Sandbox repo lifecycle helpers",
      "  ralph sandbox:init [--no-seed]      Provision a sandbox repo from template",
      "  ralph sandbox:run [--no-seed]       Provision+seed a sandbox repo and run the daemon",
      "  ralph sandbox:seed [--run-id <id>]  Seed a sandbox repo from manifest",
      "  ralph sandbox:collect --run-id <id> Export a run trace bundle",
      "  ralph worktrees legacy ...         Manage legacy worktrees",
      "  ralph rollup <repo>                (stub) Rollup helpers",
      "  ralph sandbox seed                 Seed sandbox edge-case issues",
      "",
      "Options:",
      "  -h, --help                         Show help (also: ralph help [command])",
      "  --version                          Print version and exit",
      "",
      "Notes:",
      "  Control file: set version=1 and mode=running|draining|paused in ~/.ralph/control/control.json (fallback reads: $XDG_STATE_HOME/ralph/control.json, ~/.local/state/ralph/control.json, /tmp/ralph/<uid>/control.json).",
      "  Pause at next checkpoint: set pause_requested=true in the same control file (clear to resume).",
      "  OpenCode profile: set [opencode].defaultProfile in ~/.ralph/config.toml (affects new tasks).",
      "  Reload control file immediately with SIGUSR1 (otherwise polled ~1s).",
    ].join("\n")
  );
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "resume":
      console.log(
        [
          "Usage:",
          "  ralph resume",
          "",
          "Resumes any orphaned in-progress tasks (after a daemon restart) and exits.",
        ].join("\n")
      );
      return;

    case "status":
      console.log(
        [
          "Usage:",
          "  ralph status [--json]",
          "",
          "Shows daemon mode plus starting, queued, in-progress, and throttled tasks, plus pending escalations.",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "runs":
      console.log(
        [
          "Usage:",
          "  ralph runs top [--since 7d] [--until <iso|ms|now>] [--limit N] [--sort tokens_total|triage_score] [--include-missing] [--all] [--json]",
          "  ralph runs show <runId> [--json]",
          "",
          "Lists top runs by tokens or triage score and links to trace artifacts.",
        ].join("\n")
      );
      return;

    case "gates":
      console.log(
        [
          "Usage:",
          "  ralph gates <repo> <issueNumber> [--json]",
          "",
          "Shows the latest deterministic gate state for an issue.",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "usage":
      console.log(
        [
          "Usage:",
          "  ralph usage [--json] [--profile <name|auto>]",
          "",
          "Prints OpenAI usage meters (5h + weekly) that drive throttling and auto profile selection.",
          "",
          "Options:",
          "  --json                 Emit machine-readable JSON output.",
          "  --profile <name|auto>  Override the control/default profile for this command.",
        ].join("\n")
      );
      return;

    case "github-usage":
      console.log(
        [
          "Usage:",
          "  ralph github-usage [--since 24h] [--until <iso|ms>] [--date YYYY-MM-DD] [--limit N] [--json] [--events-dir <path>]",
          "",
          "Summarizes GitHubClient per-request telemetry from ~/.ralph/events/*.jsonl.",
          "",
          "Options:",
          "  --since <duration|iso|ms>   Lookback window (default: 24h) or absolute timestamp.",
          "  --until <iso|ms>            Range end (default: now).",
          "  --date YYYY-MM-DD           Analyze a single UTC day (overrides --since/--until).",
          "  --limit N                   Number of top endpoints to show (default: 20).",
          "  --json                      Emit machine-readable JSON output.",
          "  --events-dir <path>         Override events dir (default: ~/.ralph/events).",
        ].join("\n")
      );
      return;

    case "repos":
      console.log(
        [
          "Usage:",
          "  ralph repos [--json]",
          "",
          "Lists repositories accessible to the configured GitHub App installation.",
          "Output is filtered to allowed owners (guardrail).",
          "",
          "Options:",
          "  --json    Emit machine-readable JSON output.",
        ].join("\n")
      );
      return;

    case "watch":
      console.log(
        [
          "Usage:",
          "  ralph watch",
          "",
          "Prints a line whenever an in-progress task's status changes.",
        ].join("\n")
      );
      return;

    case "nudge":
      console.log(
        [
          "Usage:",
          "  ralph nudge <taskRef> \"<message>\"",
          "",
          "Queues an operator message and delivers it at the next safe checkpoint (between continueSession runs).",
          "taskRef can be a task path, name, or a substring (must match exactly one in-progress task).",
        ].join("\n")
      );
      return;

    case "sandbox:init":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:init [--no-seed]",
          "",
          "Creates a new sandbox repo from the configured template and writes a manifest.",
          "Runs seeding unless --no-seed is provided.",
        ].join("\n")
      );
      return;

    case "sandbox:run":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:run [--no-seed] [--no-daemon] [--detach] [--tail <n>] [--json]",
          "",
          "Provision a fresh sandbox repo, optionally seed it, and then run the daemon against it.",
          "",
          "Options:",
          "  --no-seed     Skip seeding",
          "  --no-daemon   Provision/seed only (print next command)",
          "  --detach      Spawn daemon and return immediately",
          "  --tail <n>    When daemon exits, print up to N trace bundle paths (default: 20)",
          "  --json        Emit machine-readable output",
        ].join("\n")
      );
      return;

    case "sandbox:seed":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:seed [--run-id <id>]",
          "",
          "Seeds a sandbox repo based on the manifest (defaults to newest manifest if omitted).",
        ].join("\n")
      );
      return;

    case "sandbox:collect":
      console.log(
        [
          "Usage:",
          "  ralph sandbox:collect --run-id <id> [--out <path>] [--json]",
          "",
          "Exports a run-scoped trace bundle (timeline + GitHub request ids + artifacts).",
        ].join("\n")
      );
      return;

    case "rollup":
      console.log(
        [
          "Usage:",
          "  ralph rollup <repo>",
          "",
          "Rollup helpers. (Currently prints guidance; rollup is typically done via gh.)",
        ].join("\n")
      );
      return;

    case "sandbox":
      console.log(
        [
          "Usage:",
          "  ralph sandbox <tag|teardown|prune> [options]",
          "",
          "Sandbox repo lifecycle helpers.",
        ].join("\n")
      );
      return;

    case "worktrees":
      console.log(
        [
          "Usage:",
          "  ralph worktrees legacy --repo <owner/repo> --action <cleanup|migrate> [--dry-run]",
          "",
          "Manages legacy worktrees created under devDir (e.g. ~/Developer/worktree-<n>).",
        ].join("\n")
      );
      return;

    case "sandbox":
      console.log(
        [
          "Usage:",
          "  ralph sandbox seed --repo <owner/repo> [options]",
          "",
          "Seeds a sandbox repo with deterministic edge-case issues and relationships.",
        ].join("\n")
      );
      return;

    default:
      printGlobalHelp();
      return;
  }
}

const args = process.argv.slice(2);
const cmd = args[0];

const hasHelpFlag = args.includes("-h") || args.includes("--help");
const hasVersionFlag = args.includes("--version") || args.includes("-v");

// Fast-exit flags: handle before importing the orchestrator implementation.
if (hasVersionFlag) {
  console.log(getRalphVersion() ?? "unknown");
  process.exit(0);
}

if (cmd === "help") {
  const target = args[1];
  if (!target || target.startsWith("-")) printGlobalHelp();
  else printCommandHelp(target);
  process.exit(0);
}

if (!cmd || cmd.startsWith("-")) {
  if (hasHelpFlag) {
    printGlobalHelp();
    process.exit(0);
  }
}

if (
  (cmd === "resume" ||
    cmd === "status" ||
    cmd === "runs" ||
    cmd === "gates" ||
    cmd === "usage" ||
    cmd === "github-usage" ||
    cmd === "repos" ||
    cmd === "watch" ||
    cmd === "nudge" ||
    cmd === "sandbox:run" ||
    cmd === "sandbox:collect" ||
    cmd === "sandbox" ||
    cmd === "worktrees" ||
    cmd === "rollup") &&
  hasHelpFlag
) {
  printCommandHelp(cmd);
  process.exit(0);
}

await import("./index");
