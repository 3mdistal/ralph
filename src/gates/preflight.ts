import { spawn } from "child_process";
import { existsSync } from "fs";

import { sanitizeEscalationReason } from "../github/escalation-writeback";
import { recordRalphRunGateArtifact, upsertRalphRunGateResult } from "../state";

export type PreflightGateStatus = "pass" | "fail" | "skipped";

export type PreflightGateResult = {
  status: PreflightGateStatus;
  commands: string[];
  skipReason?: string;
  failure?: {
    command: string;
    commandIndex: number;
    totalCommands: number;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    durationMs: number;
    outputTail: string;
  };
};

const DEFAULT_PER_COMMAND_TIMEOUT_MS = 2 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 3 * 60_000;
const OUTPUT_TAIL_MAX_CHARS = 40_000;

function getShellCommand(): { shell: string; args: string[] } {
  const bashPath = existsSync("/bin/bash") ? "/bin/bash" : null;
  if (bashPath) return { shell: bashPath, args: ["-c"] };
  const shPath = existsSync("/bin/sh") ? "/bin/sh" : "sh";
  return { shell: shPath, args: ["-c"] };
}

function buildPreflightEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP"];
  const env: Record<string, string> = {
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  if (!env.PATH) env.PATH = process.env.PATH ?? "";
  return env;
}

function normalizeCommands(commands: string[]): string[] {
  return commands.map((command) => command.trim()).filter(Boolean);
}

async function runCommand(params: {
  command: string;
  cwd: string;
  timeoutMs: number;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}> {
  const start = Date.now();
  const { shell, args } = getShellCommand();
  const env = buildPreflightEnv();

  const proc = spawn(shell, [...args, params.command], {
    cwd: params.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });

  let stdoutTail = "";
  let stderrTail = "";
  const appendTail = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString("utf8");
    if (next.length <= OUTPUT_TAIL_MAX_CHARS) return next;
    return next.slice(-OUTPUT_TAIL_MAX_CHARS);
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    stdoutTail = appendTail(stdoutTail, chunk);
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = appendTail(stderrTail, chunk);
  });

  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const killProcess = () => {
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, "SIGKILL");
      } else {
        proc.kill("SIGKILL");
      }
    } catch {
      // ignore
    }
  };

  timeoutId = setTimeout(() => {
    timedOut = true;
    killProcess();
  }, params.timeoutMs);

  const exitResult = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ exitCode: code, signal }));
  });

  if (timeoutId) clearTimeout(timeoutId);

  const outputTail = [
    stdoutTail.trim() ? `stdout:\n${stdoutTail.trim()}` : "",
    stderrTail.trim() ? `stderr:\n${stderrTail.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    exitCode: exitResult.exitCode,
    signal: exitResult.signal,
    timedOut,
    durationMs: Date.now() - start,
    outputTail: sanitizeEscalationReason(outputTail).trim(),
  };
}

function recordCommandArtifact(params: {
  runId: string;
  command: string;
  commandIndex: number;
  totalCommands: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}): void {
  const header = [
    `Command (${params.commandIndex}/${params.totalCommands}): ${params.command}`,
    `Exit code: ${params.exitCode ?? "null"}`,
    params.signal ? `Signal: ${params.signal}` : "",
    params.timedOut ? "Timed out: true" : "",
    `Duration: ${params.durationMs}ms`,
  ]
    .filter(Boolean)
    .join("\n");

  const content = [header, params.outputTail ? `\n\n${params.outputTail}` : ""].join("").trim();
  recordRalphRunGateArtifact({ runId: params.runId, gate: "preflight", kind: "command_output", content });
}

export async function runPreflightGate(params: {
  runId: string;
  worktreePath: string;
  commands: string[];
  skipReason?: string;
  totalTimeoutMs?: number;
  perCommandTimeoutMs?: number;
}): Promise<PreflightGateResult> {
  const normalized = normalizeCommands(params.commands);
  const totalTimeoutMs = params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const perCommandTimeoutMs = params.perCommandTimeoutMs ?? DEFAULT_PER_COMMAND_TIMEOUT_MS;

  if (normalized.length === 0) {
    const skipReason = params.skipReason?.trim() || "no preflight configured";
    upsertRalphRunGateResult({ runId: params.runId, gate: "preflight", status: "skipped", skipReason });
    return { status: "skipped", commands: [], skipReason };
  }

  const joined = normalized.join("\n");
  upsertRalphRunGateResult({ runId: params.runId, gate: "preflight", status: "pending", command: joined });

  const overallStart = Date.now();
  for (let i = 0; i < normalized.length; i += 1) {
    const command = normalized[i];
    const elapsed = Date.now() - overallStart;
    if (elapsed > totalTimeoutMs) {
      const outputTail = `Preflight timed out after ${elapsed}ms (budget ${totalTimeoutMs}ms).`;
      const failure = {
        command,
        commandIndex: i + 1,
        totalCommands: normalized.length,
        exitCode: null,
        signal: null,
        timedOut: true,
        durationMs: elapsed,
        outputTail,
      };

      recordCommandArtifact({ runId: params.runId, ...failure });
      recordRalphRunGateArtifact({
        runId: params.runId,
        gate: "preflight",
        kind: "failure_excerpt",
        content: `Preflight timed out before completing all commands.\n\n${outputTail}`,
      });
      upsertRalphRunGateResult({ runId: params.runId, gate: "preflight", status: "fail", command: joined });
      return { status: "fail", commands: normalized, failure };
    }

    const result = await runCommand({
      command,
      cwd: params.worktreePath,
      timeoutMs: perCommandTimeoutMs,
    });

    recordCommandArtifact({
      runId: params.runId,
      command,
      commandIndex: i + 1,
      totalCommands: normalized.length,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      outputTail: result.outputTail,
    });

    const ok = !result.timedOut && result.exitCode === 0;
    if (!ok) {
      const failure = {
        command,
        commandIndex: i + 1,
        totalCommands: normalized.length,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        outputTail: result.outputTail,
      };

      const summaryParts = [
        `Preflight failed on command (${failure.commandIndex}/${failure.totalCommands}).`,
        `Command: ${failure.command}`,
        `Exit code: ${failure.exitCode ?? "null"}`,
        failure.signal ? `Signal: ${failure.signal}` : "",
        failure.timedOut ? "Timed out: true" : "",
      ]
        .filter(Boolean)
        .join("\n");

      recordRalphRunGateArtifact({
        runId: params.runId,
        gate: "preflight",
        kind: "failure_excerpt",
        content: [summaryParts, failure.outputTail ? `\n\n${failure.outputTail}` : ""].join(""),
      });

      upsertRalphRunGateResult({ runId: params.runId, gate: "preflight", status: "fail", command: joined });
      return { status: "fail", commands: normalized, failure };
    }
  }

  upsertRalphRunGateResult({ runId: params.runId, gate: "preflight", status: "pass", command: joined });
  return { status: "pass", commands: normalized };
}
