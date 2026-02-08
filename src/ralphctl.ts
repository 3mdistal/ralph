#!/usr/bin/env bun

import { spawn, spawnSync } from "child_process";
import { readFileSync } from "fs";
import { resolveDaemonRecordPathCandidates, type DaemonRecord } from "./daemon-record";
import { discoverDaemon } from "./daemon-discovery";
import { updateControlFile } from "./control-file";
import { getStatusSnapshot } from "./commands/status";
import type { StatusSnapshot } from "./status-snapshot";
import { startDashboardTui } from "./dashboard/client/ui-blessed";

const DEFAULT_GRACE_MS = 5 * 60_000;
const DRAIN_POLL_INTERVAL_MS = 1000;
const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_STOP_TIMEOUT_MS = 10_000;

type CommandArgs = string[];

function printGlobalHelp(): void {
  console.log(
    [
      "ralphctl",
      "",
      "Usage:",
      "  ralphctl status [--json]",
      "  ralphctl dashboard [--url <url>] [--host <host>] [--port <port>] [--token <token>] [--replay-last <n>]",
      "  ralphctl drain [--timeout 5m] [--pause-at-checkpoint <checkpoint>]",
      "  ralphctl resume",
      "  ralphctl restart [--grace 5m] [--force] [--start-cmd \"<command>\"]",
      "  ralphctl upgrade [--grace 5m] [--force] [--start-cmd \"<command>\"] [--upgrade-cmd \"<command>\"]",
      "",
      "Options:",
      "  -h, --help       Show help",
      "  --json           Emit machine-readable JSON output",
      "  --timeout <dur>  Drain timeout (e.g. 30s, 5m)",
      "  --grace <dur>    Restart grace period (e.g. 30s, 5m)",
      "  --pause-at-checkpoint <name>  Pause workers at checkpoint while draining",
      "  --start-cmd <cmd>             Override daemon start command",
      "  --upgrade-cmd <cmd>           Command to run before restart",
      "  --force          Proceed with kill even when safety checks fail",
    ].join("\n")
  );
}

function printCommandHelp(command: string): void {
  switch (command) {
    case "status":
      console.log(["Usage:", "  ralphctl status [--json]"].join("\n"));
      return;
    case "dashboard":
      console.log(
        [
          "Usage:",
          "  ralphctl dashboard [--url <url>] [--host <host>] [--port <port>] [--token <token>] [--replay-last <n>]",
          "",
          "Options:",
          "  --url <url>        Full base URL for control plane (overrides host/port)",
          "  --host <host>      Control plane host (default: 127.0.0.1)",
          "  --port <port>      Control plane port (default: 8787)",
          "  --token <token>    Bearer token (fallback: RALPH_DASHBOARD_TOKEN)",
          "  --replay-last <n>  Replay count for /v1/events (default: 50)",
        ].join("\n")
      );
      return;
    case "drain":
      console.log([
        "Usage:",
        "  ralphctl drain [--timeout 5m] [--pause-at-checkpoint <checkpoint>]",
      ].join("\n"));
      return;
    case "resume":
      console.log(["Usage:", "  ralphctl resume"].join("\n"));
      return;
    case "restart":
      console.log([
        "Usage:",
        "  ralphctl restart [--grace 5m] [--force] [--start-cmd \"<command>\"]",
      ].join("\n"));
      return;
    case "upgrade":
      console.log([
        "Usage:",
        "  ralphctl upgrade [--grace 5m] [--force] [--start-cmd \"<command>\"] [--upgrade-cmd \"<command>\"]",
      ].join("\n"));
      return;
    default:
      printGlobalHelp();
  }
}

function getFlagValue(args: CommandArgs, flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) return null;
  return value.trim();
}

function hasFlag(args: CommandArgs, flag: string): boolean {
  return args.includes(flag);
}

function parseDuration(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 60 * 60_000;
    default:
      return null;
  }
}

function parseInteger(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const floored = Math.floor(parsed);
  return floored >= 0 ? floored : fallback;
}

function resolveDashboardOptions(args: CommandArgs): { baseUrl: string; token: string; replayLast: number } {
  const url = getFlagValue(args, "--url");
  const host = getFlagValue(args, "--host") ?? "127.0.0.1";
  const port = parseInteger(getFlagValue(args, "--port"), 8787);
  const replayLast = parseInteger(getFlagValue(args, "--replay-last"), 50);
  const token = getFlagValue(args, "--token") ?? process.env.RALPH_DASHBOARD_TOKEN ?? "";

  if (!token) {
    throw new Error("Missing token; pass --token or set RALPH_DASHBOARD_TOKEN");
  }

  if (url) return { baseUrl: url, token, replayLast };
  return { baseUrl: `http://${host}:${port}`, token, replayLast };
}

function splitCommandLine(value: string | null): string[] | null {
  if (!value) return null;
  const input = value.trim();
  if (!input) return null;
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        current += input[i + 1];
        i += 1;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.length > 0 ? parts : null;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessCommandLine(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.replace(/\0+/g, " ").trim();
    if (text) return text;
  } catch {
    // ignore
  }

  try {
    const out = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    const text = (out.stdout ?? "").trim();
    if (text) return text;
  } catch {
    // ignore
  }

  return null;
}

function verifyProcessIdentity(record: DaemonRecord): { ok: boolean; reason: string } {
  const commandLine = readProcessCommandLine(record.pid);
  if (!commandLine) {
    return { ok: false, reason: "unable to verify process command line" };
  }

  const haystack = commandLine.toLowerCase();
  const tokens = record.command
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.split("/").pop() ?? token)
    .map((token) => token.toLowerCase())
    .slice(0, 3);

  if (tokens.length === 0) return { ok: true, reason: "" };
  const matched = tokens.some((token) => haystack.includes(token));
  if (matched) return { ok: true, reason: "" };

  return {
    ok: false,
    reason: `pid command mismatch (expected one of: ${tokens.join(", ")}; actual: ${commandLine})`,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDrained(timeoutMs: number): Promise<StatusSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: StatusSnapshot = await getStatusSnapshot();
  while (Date.now() < deadline) {
    if (lastSnapshot.starting.length === 0 && lastSnapshot.inProgress.length === 0) return lastSnapshot;
    await sleep(DRAIN_POLL_INTERVAL_MS);
    lastSnapshot = await getStatusSnapshot();
  }
  return lastSnapshot;
}

async function waitForDaemonRecordChange(oldRecord: DaemonRecord | null, timeoutMs: number): Promise<DaemonRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const nextDiscovery = discoverDaemon({ healStale: false });
    const next = nextDiscovery.state === "live" ? nextDiscovery.live?.record ?? null : null;
    if (!next) {
      await sleep(500);
      continue;
    }
    if (!oldRecord) return next;
    if (next.daemonId !== oldRecord.daemonId || next.pid !== oldRecord.pid) return next;
    await sleep(500);
  }
  throw new Error("Timed out waiting for new daemon record");
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await sleep(250);
  }
  return !isPidAlive(pid);
}

function spawnDetached(command: string[], cwd: string): void {
  const [exec, ...args] = command;
  const child = spawn(exec, args, { cwd, stdio: "ignore", detached: true });
  child.unref();
}

async function runUpgradeCommand(command: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const [exec, ...args] = command;
    const child = spawn(exec, args, { stdio: "inherit" });
    child.on("exit", (code: number | null) => {
      if (code === 0) resolve();
      else reject(new Error(`Upgrade command failed (exit ${code ?? "unknown"})`));
    });
    child.on("error", reject);
  });
}

async function stopDaemon(record: DaemonRecord, force: boolean): Promise<void> {
  if (!isPidAlive(record.pid)) {
    console.log("Daemon process not running; skipping stop.");
    return;
  }

  if (!force && !record.daemonId) {
    throw new Error("Refusing to stop daemon without daemonId; use --force to override.");
  }

  if (!force) {
    const identity = verifyProcessIdentity(record);
    if (!identity.ok) {
      throw new Error(`Refusing to signal pid=${record.pid}: ${identity.reason}; use --force to override.`);
    }
  }

  try {
    process.kill(record.pid, "SIGTERM");
  } catch (e: any) {
    throw new Error(`Failed to send SIGTERM: ${e?.message ?? String(e)}`);
  }

  const exited = await waitForProcessExit(record.pid, DAEMON_STOP_TIMEOUT_MS);
  if (exited) return;

  console.warn("Daemon did not exit after SIGTERM; sending SIGKILL.");
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (e: any) {
    throw new Error(`Failed to send SIGKILL: ${e?.message ?? String(e)}`);
  }
  await waitForProcessExit(record.pid, DAEMON_STOP_TIMEOUT_MS);
}

function buildTaskKey(task: { repo: string; issue: string; name: string }): string {
  return `${task.repo}#${task.issue}:${task.name}`;
}

function verifyResumption(before: StatusSnapshot, after: StatusSnapshot): void {
  const expected = new Map<string, string>();
  for (const task of before.inProgress) {
    if (task.sessionId) expected.set(buildTaskKey(task), task.sessionId);
  }
  if (expected.size === 0) return;

  const afterMap = new Map<string, string | null>();
  for (const task of after.inProgress) {
    afterMap.set(buildTaskKey(task), task.sessionId);
  }

  for (const [key, sessionId] of expected) {
    if (!afterMap.has(key)) {
      console.warn(`Task no longer in progress after restart: ${key}`);
      continue;
    }
    const nextSessionId = afterMap.get(key);
    if (nextSessionId && nextSessionId !== sessionId) {
      throw new Error(`Task resumed with different session: ${key} (${sessionId} -> ${nextSessionId})`);
    }
  }
}

async function restartFlow(opts: {
  graceMs: number;
  force: boolean;
  startCmd: string[] | null;
  upgradeCmd: string[] | null;
}): Promise<void> {
  const beforeSnapshot = await getStatusSnapshot();

  updateControlFile({
    patch: {
      mode: "draining",
      drainTimeoutMs: opts.graceMs,
    },
  });

  const drainedSnapshot = await waitForDrained(opts.graceMs);
  if (drainedSnapshot.starting.length > 0 || drainedSnapshot.inProgress.length > 0) {
    console.warn("Drain timeout reached; proceeding with restart.");
  }

  const daemonDiscovery = discoverDaemon({ healStale: true });
  if (daemonDiscovery.healedPaths.length > 0) {
    console.log(`Healed stale daemon record(s): ${daemonDiscovery.healedPaths.join(", ")}`);
  }

  if (daemonDiscovery.state === "conflict") {
    throw new Error("Multiple live daemon records detected; stop extra daemons or use --force.");
  }

  const daemonRecord = daemonDiscovery.state === "live"
    ? daemonDiscovery.live?.record ?? null
    : daemonDiscovery.latestRecord;
  if (!daemonRecord) {
    const candidates = resolveDaemonRecordPathCandidates();
    throw new Error(`Daemon record not found (checked: ${candidates.join(", ")})`);
  }

  if (daemonDiscovery.state === "live") {
    await stopDaemon(daemonRecord, opts.force);
  } else {
    console.log("No live daemon PID found; continuing restart from stale record metadata.");
  }

  if (opts.upgradeCmd) {
    console.log("Running upgrade command...");
    await runUpgradeCommand(opts.upgradeCmd);
  }

  const command = opts.startCmd ?? daemonRecord.command;
  if (!command || command.length === 0) {
    throw new Error("Missing start command; pass --start-cmd to restart.");
  }

  console.log("Starting daemon...");
  spawnDetached(command, daemonRecord.cwd || process.cwd());

  const newRecord = await waitForDaemonRecordChange(daemonDiscovery.state === "live" ? daemonRecord : null, DAEMON_START_TIMEOUT_MS);
  const afterSnapshot = await getStatusSnapshot();
  if (afterSnapshot.mode === "draining") {
    console.warn("Daemon still in draining mode after restart.");
  }
  verifyResumption(beforeSnapshot, afterSnapshot);
  console.log(`Daemon restarted (pid=${newRecord.pid}, id=${newRecord.daemonId}).`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const hasHelp = hasFlag(args, "--help") || hasFlag(args, "-h");

  if (!cmd || cmd.startsWith("-")) {
    if (hasHelp) {
      printGlobalHelp();
      process.exit(0);
    }
    printGlobalHelp();
    process.exit(2);
  }

  if (cmd === "help") {
    const target = args[1];
    if (!target || target.startsWith("-")) printGlobalHelp();
    else printCommandHelp(target);
    process.exit(0);
  }

  if (hasHelp) {
    printCommandHelp(cmd);
    process.exit(0);
  }

  if (cmd === "status") {
    const json = hasFlag(args, "--json");
    const snapshot = await getStatusSnapshot();
    if (json) {
      console.log(JSON.stringify(snapshot, null, 2));
      process.exit(0);
    }
    console.log(`Mode: ${snapshot.mode}`);
    console.log(`Queue backend: ${snapshot.queue.backend}`);
    if (snapshot.daemon) {
      console.log(
        `Daemon: id=${snapshot.daemon.daemonId ?? "unknown"} pid=${snapshot.daemon.pid ?? "unknown"}`
      );
    } else if (snapshot.daemonDiscovery?.state === "stale") {
      console.log("Daemon: stale record(s) detected (no live PID)");
    } else if (snapshot.daemonDiscovery?.state === "conflict") {
      console.log("Daemon: conflicting live records detected");
    } else {
      console.log("Daemon: not running");
    }
    console.log(`In-progress tasks: ${snapshot.inProgress.length}`);
    console.log(`Queued tasks: ${snapshot.queued.length}`);
    process.exit(0);
  }

  if (cmd === "dashboard") {
    const { baseUrl, token, replayLast } = resolveDashboardOptions(args);
    await startDashboardTui({ baseUrl, token, replayLast });
    return;
  }

  if (cmd === "drain") {
    const timeoutMs = parseDuration(getFlagValue(args, "--timeout"));
    const pauseAtCheckpoint = getFlagValue(args, "--pause-at-checkpoint");
    const discovery = discoverDaemon({ healStale: true });
    if (discovery.state === "conflict") {
      console.error("Multiple live daemon records detected; refusing to send control signal.");
      process.exit(1);
    }

    const patch = {
      mode: "draining" as const,
      drainTimeoutMs: timeoutMs ?? undefined,
      pauseRequested: pauseAtCheckpoint ? true : undefined,
      pauseAtCheckpoint: pauseAtCheckpoint ?? undefined,
    };
    const liveRecord = discovery.state === "live" ? discovery.live?.record ?? null : null;
    const { path } = updateControlFile({ patch, path: liveRecord?.controlFilePath?.trim() || undefined });
    if (liveRecord?.pid && isPidAlive(liveRecord.pid)) {
      const identity = verifyProcessIdentity(liveRecord);
      try {
        if (identity.ok) process.kill(liveRecord.pid, "SIGUSR1");
      } catch {
        // ignore
      }
      if (!identity.ok) {
        console.warn(`Drain signal skipped: ${identity.reason}`);
      }
    } else if (discovery.state === "stale") {
      console.warn("No live daemon PID found; wrote control intent for next daemon startup.");
    }
    if (discovery.healedPaths.length > 0) {
      console.log(`Healed stale daemon record(s): ${discovery.healedPaths.join(", ")}`);
    }
    console.log(`Drain requested (control file: ${path}).`);
    process.exit(0);
  }

  if (cmd === "resume") {
    const discovery = discoverDaemon({ healStale: true });
    if (discovery.state === "conflict") {
      console.error("Multiple live daemon records detected; refusing to send control signal.");
      process.exit(1);
    }

    const patch = {
      mode: "running" as const,
      pauseRequested: null,
      pauseAtCheckpoint: null,
      drainTimeoutMs: null,
    };
    const liveRecord = discovery.state === "live" ? discovery.live?.record ?? null : null;
    const { path } = updateControlFile({ patch, path: liveRecord?.controlFilePath?.trim() || undefined });
    if (liveRecord?.pid && isPidAlive(liveRecord.pid)) {
      const identity = verifyProcessIdentity(liveRecord);
      try {
        if (identity.ok) process.kill(liveRecord.pid, "SIGUSR1");
      } catch {
        // ignore
      }
      if (!identity.ok) {
        console.warn(`Resume signal skipped: ${identity.reason}`);
      }
    } else if (discovery.state === "stale") {
      console.warn("No live daemon PID found; wrote control intent for next daemon startup.");
    }
    if (discovery.healedPaths.length > 0) {
      console.log(`Healed stale daemon record(s): ${discovery.healedPaths.join(", ")}`);
    }
    console.log(`Resume requested (control file: ${path}).`);
    process.exit(0);
  }

  if (cmd === "restart" || cmd === "upgrade") {
    const graceMs = parseDuration(getFlagValue(args, "--grace")) ?? DEFAULT_GRACE_MS;
    const force = hasFlag(args, "--force");
    const startCmd = splitCommandLine(getFlagValue(args, "--start-cmd"));
    const upgradeCmd = cmd === "upgrade" ? splitCommandLine(getFlagValue(args, "--upgrade-cmd")) : null;
    if (cmd === "upgrade" && !upgradeCmd) {
      console.warn("No upgrade command provided; performing restart only.");
    }
    await restartFlow({ graceMs, force, startCmd, upgradeCmd });
    process.exit(0);
  }

  console.error(`Unknown command: ${cmd}`);
  printGlobalHelp();
  process.exit(2);
}

run().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
