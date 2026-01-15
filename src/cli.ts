#!/usr/bin/env bun

import { readFileSync } from "fs";

function getVersion(): string {
  try {
    const pkgPath = new URL("../package.json", import.meta.url);
    const raw = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.version === "string") return parsed.version;
  } catch {
    // ignore
  }
  return "unknown";
}

function printGlobalHelp(): void {
  console.log(
    [
      "Ralph Loop (ralph)",
      "",
      "Usage:",
      "  ralph                              Run daemon (default)",
      "  ralph resume                       Resume orphaned in-progress tasks, then exit",
      "  ralph status [--json]              Show daemon/task status",
      "  ralph repos [--json]               List accessible repos (GitHub App installation)",
      "  ralph watch                        Stream status updates (Ctrl+C to stop)",
      "  ralph nudge <taskRef> \"<message>\"    Queue an operator message for an in-flight task",
      "  ralph rollup <repo>                (stub) Rollup helpers",
      "",
      "Options:",
      "  -h, --help                         Show help (also: ralph help [command])",
      "  --version                          Print version and exit",
      "",
      "Notes:",
      "  Drain mode: set mode=draining|running in $XDG_STATE_HOME/ralph/control.json (fallback ~/.local/state/ralph/control.json).",
      "  OpenCode profile: set opencode_profile=\"<name>\" in the same control file (affects new tasks).",
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
  console.log(getVersion());
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

if ((cmd === "resume" || cmd === "status" || cmd === "repos" || cmd === "watch" || cmd === "nudge" || cmd === "rollup") && hasHelpFlag) {
  printCommandHelp(cmd);
  process.exit(0);
}

await import("./index");
