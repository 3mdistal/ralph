import { spawn, type ChildProcess } from "child_process";
import { mkdirSync } from "fs";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface ServerHandle {
  url: string;
  port: number;
  process: ChildProcess;
}

export interface WatchdogThresholdMs {
  softMs: number;
  hardMs: number;
}

export interface WatchdogThresholdsMs {
  read: WatchdogThresholdMs;
  glob: WatchdogThresholdMs;
  grep: WatchdogThresholdMs;
  task: WatchdogThresholdMs;
  bash: WatchdogThresholdMs;
}

export const DEFAULT_WATCHDOG_THRESHOLDS_MS: WatchdogThresholdsMs = {
  read: { softMs: 30_000, hardMs: 120_000 },
  glob: { softMs: 30_000, hardMs: 120_000 },
  grep: { softMs: 30_000, hardMs: 120_000 },
  task: { softMs: 180_000, hardMs: 600_000 },
  bash: { softMs: 300_000, hardMs: 1_800_000 },
};

export interface WatchdogTimeoutInfo {
  kind: "watchdog-timeout";
  toolName: string;
  callId: string;
  elapsedMs: number;
  softMs: number;
  hardMs: number;
  lastProgressMsAgo: number;
  argsPreview?: string;
  context?: string;
  recentEvents?: string[];
}

export interface SessionResult {
  sessionId: string;
  output: string;
  success: boolean;
  exitCode?: number;
  watchdogTimeout?: WatchdogTimeoutInfo;
}


/**
 * Spawn an OpenCode server for a specific repo directory.
 * Not required for `opencode run`, but useful for interactive/attached modes.
 */
export async function spawnServer(repoPath: string): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const port = 4000 + Math.floor(Math.random() * 1000);

    const proc = spawn("opencode", ["serve", "--port", String(port)], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let started = false;

    proc.stdout?.on("data", (data: Buffer) => {
      const str = data.toString();
      if (!started && (str.includes("listening") || str.includes("ready") || str.includes(`:${port}`))) {
        started = true;
        resolve({
          url: `http://127.0.0.1:${port}`,
          port,
          process: proc,
        });
      }
    });

    proc.on("error", (err) => reject(new Error(`Failed to spawn OpenCode server: ${err.message}`)));
    proc.on("exit", (code) => {
      if (!started) reject(new Error(`OpenCode server exited with code ${code} before starting`));
    });

    setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("OpenCode server failed to start within 30 seconds"));
      }
    }, 30000);
  });
}

export function killServer(handle: ServerHandle): void {
  if (handle.process && !handle.process.killed) handle.process.kill();
}

function normalizeCommand(command?: string): string | undefined {
  if (!command) return undefined;
  return command.startsWith("/") ? command.slice(1) : command;
}

function normalizeCacheSegment(value: string): string {
  return value
    .trim()
    .replace(/[\/]/g, "__")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
}

function getIsolatedXdgCacheHome(opts?: { repo?: string; cacheKey?: string }): string {
  const repo = normalizeCacheSegment(opts?.repo ?? "unknown-repo");
  const key = normalizeCacheSegment(opts?.cacheKey ?? "default");
  return join(homedir(), ".cache", "ralph-opencode", repo, key);
}

function extractOpencodeLogPath(text: string): string | null {
  // Example: "check log file at /Users/.../.local/share/opencode/log/2026-01-10T003721.log"
  const match = text.match(/check log file at\s+([^\s]+\.log)/i);
  return match?.[1] ?? null;
}

function sanitizeOpencodeLog(text: string): string {
  // Strip ANSI escape codes.
  let out = text.replace(/\x1b\[[0-9;]*m/g, "");

  // Best-effort redaction. This is intentionally conservative and may miss some secrets,
  // but it helps reduce accidental leakage in error notes.
  const patterns: Array<{ re: RegExp; replacement: string }> = [
    { re: /ghp_[A-Za-z0-9]{20,}/g, replacement: "ghp_[REDACTED]" },
    { re: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: "github_pat_[REDACTED]" },
    { re: /sk-[A-Za-z0-9]{20,}/g, replacement: "sk-[REDACTED]" },
    { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: "xox-[REDACTED]" },
    { re: /(Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
    { re: /(Authorization:\s*Bearer\s+)[A-Za-z0-9._-]+/gi, replacement: "$1[REDACTED]" },
  ];

  for (const { re, replacement } of patterns) {
    out = out.replace(re, replacement);
  }

  return out;
}

export function getRalphXdgCacheHome(repo: string, cacheKey: string): string {
  return getIsolatedXdgCacheHome({ repo, cacheKey });
}

async function appendOpencodeLogTail(output: string): Promise<string> {
  const logPath = extractOpencodeLogPath(output);
  if (!logPath) return output;

  try {
    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n");
    const tailLines = lines.slice(Math.max(0, lines.length - 200));
    const tail = sanitizeOpencodeLog(tailLines.join("\n")).slice(0, 20000);

    return [
      output.trimEnd(),
      "",
      "---",
      `OpenCode log tail (${logPath})`,
      "```",
      tail.trimEnd(),
      "```",
      "",
    ].join("\n");
  } catch (e: any) {
    const message = sanitizeOpencodeLog(e?.message ?? String(e));
    return [
      output.trimEnd(),
      "",
      "---",
      `OpenCode log tail unavailable (${logPath})`,
      "```",
      message.trimEnd(),
      "```",
      "",
    ].join("\n");
  }
}

function argsFromMessage(message: string): string[] {
  // For `opencode run --command <cmd>`, positional message args are treated as the command args.
  // If message starts with `/cmd`, strip it.
  const parts = message.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  if (parts[0].startsWith("/")) return parts.slice(1);
  return parts;
}

/**
 * Run an OpenCode session with optional configured command.
 */
export async function runSession(
  repoPath: string,
  message: string,
  options?: {
    command?: string;
    continueSession?: string;
    agent?: string;
    /** Used for per-run cache isolation */
    repo?: string;
    /** Used for per-run cache isolation */
    cacheKey?: string;
    /** Fallback hard timeout for the entire OpenCode process */
    timeoutMs?: number;
    watchdog?: {
      enabled?: boolean;
      thresholdsMs?: Partial<WatchdogThresholdsMs>;
      /** Throttle for soft-timeout logs (default: 30s) */
      softLogIntervalMs?: number;
      /** Max number of recent JSON lines to attach (default: 50) */
      recentEventLimit?: number;
      /** Included in soft/hard timeout logs */
      context?: string;
    };
  }
): Promise<SessionResult> {
  const truncate = (value: string, max: number) => (value.length > max ? value.slice(0, max) + "…" : value);

  const mergeThresholds = (overrides?: Partial<WatchdogThresholdsMs>): WatchdogThresholdsMs => {
    if (!overrides) return DEFAULT_WATCHDOG_THRESHOLDS_MS;
    const base = DEFAULT_WATCHDOG_THRESHOLDS_MS;

    const merge = (k: keyof WatchdogThresholdsMs): WatchdogThresholdMs => {
      const override = overrides[k];
      if (!override) return base[k];
      return {
        softMs: typeof override.softMs === "number" ? override.softMs : base[k].softMs,
        hardMs: typeof override.hardMs === "number" ? override.hardMs : base[k].hardMs,
      };
    };

    return {
      read: merge("read"),
      glob: merge("glob"),
      grep: merge("grep"),
      task: merge("task"),
      bash: merge("bash"),
    };
  };

  const normalizeToolName = (name: string): string => name.trim().toLowerCase();

  const pickThreshold = (toolName: string, thresholds: WatchdogThresholdsMs): WatchdogThresholdMs => {
    const t = normalizeToolName(toolName);
    if (t === "read" || t.includes("read")) return thresholds.read;
    if (t === "glob" || t.includes("glob")) return thresholds.glob;
    if (t === "grep" || t.includes("grep")) return thresholds.grep;
    if (t === "task" || t.includes("task")) return thresholds.task;
    if (t === "bash" || t.includes("bash") || t.includes("shell")) return thresholds.bash;
    return thresholds.bash;
  };

  const argsPreviewFromEvent = (event: any): string | undefined => {
    const candidate =
      event?.tool?.input ??
      event?.tool?.args ??
      event?.tool?.arguments ??
      event?.part?.tool?.input ??
      event?.part?.tool?.args ??
      event?.part?.toolCall?.input ??
      event?.part?.toolCall?.args ??
      event?.part?.tool_call?.input ??
      event?.part?.tool_call?.args ??
      undefined;

    if (candidate === undefined) return undefined;

    try {
      const str = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
      return truncate(str, 500);
    } catch {
      return undefined;
    }
  };

  const extractToolInfo = (event: any): { phase: "start" | "end" | "progress"; toolName: string; callId: string; argsPreview?: string } | null => {
    const type = String(event?.type ?? event?.event ?? "").toLowerCase();

    const toolName =
      event?.tool?.name ??
      event?.toolName ??
      event?.name ??
      event?.part?.tool?.name ??
      event?.part?.toolCall?.name ??
      event?.part?.tool_call?.name ??
      undefined;

    const callId =
      event?.tool?.callId ??
      event?.tool?.id ??
      event?.callId ??
      event?.toolCallId ??
      event?.id ??
      event?.part?.tool?.callId ??
      event?.part?.toolCall?.callId ??
      event?.part?.tool_call?.callId ??
      undefined;

    const hasToolHints = Boolean(toolName || callId || type.includes("tool"));
    if (!hasToolHints) return null;

    const phase: "start" | "end" | "progress" =
      /tool[_-]?start|tool[_-]?call/.test(type)
        ? "start"
        : /tool[_-]?end|tool[_-]?result/.test(type) || event?.tool?.result != null || event?.part?.toolResult != null
          ? "end"
          : "progress";

    return {
      phase,
      toolName: String(toolName ?? "unknown"),
      callId: String(callId ?? "unknown"),
      argsPreview: argsPreviewFromEvent(event),
    };
  };

  const args: string[] = ["run"];

  const command = normalizeCommand(options?.command);
  if (command) {
    args.push("--command", command, ...argsFromMessage(message));
  } else {
    args.push(message);
  }

  if (options?.continueSession) args.push("-s", options.continueSession);
  if (options?.agent) args.push("--agent", options.agent);

  args.push("--format", "json");

  // IMPORTANT: OpenCode installs plugins/deps under its cache dir (XDG_CACHE_HOME/opencode).
  // If multiple OpenCode runs share the same cache concurrently, we can get transient ENOENTs
  // due to node_modules being mutated mid-import. To keep Ralph stable under concurrency,
  // isolate XDG_CACHE_HOME per repo/task key.
  const xdgCacheHome = getIsolatedXdgCacheHome({ repo: options?.repo, cacheKey: options?.cacheKey });
  mkdirSync(xdgCacheHome, { recursive: true });

  const env = { ...process.env, XDG_CACHE_HOME: xdgCacheHome };

  const proc = spawn("opencode", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  const watchdogEnabled = options?.watchdog?.enabled ?? true;
  const thresholds = mergeThresholds(options?.watchdog?.thresholdsMs);
  const softLogIntervalMs = options?.watchdog?.softLogIntervalMs ?? 30_000;
  const recentEventLimit = options?.watchdog?.recentEventLimit ?? 50;
  const context = options?.watchdog?.context;

  let stdout = "";
  let stderr = "";

  let sessionId = "";
  let textOutput = "";

  let buffer = "";
  let recentEvents: string[] = [];

  let lastSoftLogTs = 0;

  let inFlight:
    | {
        toolName: string;
        callId: string;
        startTs: number;
        lastProgressTs: number;
        argsPreview?: string;
      }
    | null = null;

  let watchdogTimeout: WatchdogTimeoutInfo | undefined;

  proc.stdout?.on("data", (data: Buffer) => {
    const chunk = data.toString();
    stdout += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      recentEvents.push(truncate(trimmed, 800));
      if (recentEvents.length > recentEventLimit) recentEvents = recentEvents.slice(-recentEventLimit);

      try {
        const event = JSON.parse(trimmed);
        const eventSessionId = event.sessionID ?? event.sessionId;
        if (eventSessionId && !sessionId) sessionId = eventSessionId;

        if (event.type === "text" && event.part?.text) {
          textOutput += event.part.text;
        }

        const tool = extractToolInfo(event);
        if (tool) {
          const now = Date.now();

          if (tool.phase === "start") {
            inFlight = {
              toolName: tool.toolName,
              callId: tool.callId,
              startTs: now,
              lastProgressTs: now,
              argsPreview: tool.argsPreview,
            };
          } else if (tool.phase === "end") {
            if (inFlight && (inFlight.callId === tool.callId || inFlight.callId === "unknown" || tool.callId === "unknown")) {
              inFlight = null;
            }
          } else if (inFlight && (inFlight.callId === tool.callId || tool.callId === "unknown")) {
            inFlight.lastProgressTs = now;
          }
        }
      } catch {
        // ignore
      }
    }
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  let watchdogInterval: ReturnType<typeof setInterval> | undefined;
  if (watchdogEnabled) {
    watchdogInterval = setInterval(() => {
      if (watchdogTimeout || !inFlight) return;

      const now = Date.now();
      const elapsedMs = now - inFlight.startTs;
      const threshold = pickThreshold(inFlight.toolName, thresholds);

      if (elapsedMs >= threshold.softMs && now - lastSoftLogTs >= softLogIntervalMs) {
        lastSoftLogTs = now;
        const ctx = context ? ` ${context}` : "";
        console.warn(
          `[ralph:watchdog] Soft timeout${ctx}: ${inFlight.toolName} ${inFlight.callId} ` +
            `elapsed=${Math.round(elapsedMs / 1000)}s soft=${Math.round(threshold.softMs / 1000)}s hard=${Math.round(threshold.hardMs / 1000)}s`
        );
      }

      if (elapsedMs >= threshold.hardMs) {
        watchdogTimeout = {
          kind: "watchdog-timeout",
          toolName: inFlight.toolName,
          callId: inFlight.callId,
          elapsedMs,
          softMs: threshold.softMs,
          hardMs: threshold.hardMs,
          lastProgressMsAgo: now - inFlight.lastProgressTs,
          argsPreview: inFlight.argsPreview,
          context,
          recentEvents,
        };

        const ctx = context ? ` ${context}` : "";
        console.warn(
          `[ralph:watchdog] Hard timeout${ctx}: ${inFlight.toolName} ${inFlight.callId} after ${Math.round(elapsedMs / 1000)}s; killing opencode process`
        );

        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
    }, 1000);
  }

  const fallbackTimeoutMs = options?.timeoutMs ?? thresholds.bash.hardMs + 60_000;

  const exitCode = await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    timeout = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // ignore
      }
      resolve(124);
    }, fallbackTimeoutMs);

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (watchdogInterval) clearInterval(watchdogInterval);
      reject(err);
    });

    proc.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (watchdogInterval) clearInterval(watchdogInterval);
      resolve(code ?? 0);
    });
  });

  if (watchdogTimeout) {
    const header = [
      `Tool call timed out: ${watchdogTimeout.toolName} ${watchdogTimeout.callId} after ${Math.round(watchdogTimeout.elapsedMs / 1000)}s`,
      watchdogTimeout.context ? `Context: ${watchdogTimeout.context}` : null,
      watchdogTimeout.argsPreview ? `Args preview: ${watchdogTimeout.argsPreview}` : null,
      `Soft threshold: ${Math.round(watchdogTimeout.softMs / 1000)}s`,
      `Hard threshold: ${Math.round(watchdogTimeout.hardMs / 1000)}s`,
      `Last progress: ${Math.round(watchdogTimeout.lastProgressMsAgo / 1000)}s ago`,
    ]
      .filter(Boolean)
      .join("\n");

    const recent = watchdogTimeout.recentEvents?.length
      ? ["Recent OpenCode events (bounded):", ...watchdogTimeout.recentEvents.map((l) => `- ${l}`)].join("\n")
      : "";

    const combined = [header, recent, stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined);
    return { sessionId, output: enriched, success: false, exitCode, watchdogTimeout };
  }

  if (exitCode !== 0) {
    const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined || `Failed with exit code ${exitCode}`);
    return { sessionId: "", output: enriched, success: false, exitCode };
  }

  const raw = stdout.toString();
  return { sessionId, output: textOutput || raw, success: true, exitCode };
}

/**
 * Run a configured command in a new session.
 * `command` should be the command name WITHOUT a leading slash (e.g. `next-task`).
 */
export async function runCommand(
  repoPath: string,
  command: string,
  args: string[] = [],
  options?: {
    repo?: string;
    cacheKey?: string;
    timeoutMs?: number;
    watchdog?: {
      enabled?: boolean;
      thresholdsMs?: Partial<WatchdogThresholdsMs>;
      softLogIntervalMs?: number;
      recentEventLimit?: number;
      context?: string;
    };
  }
): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");
  return runSession(repoPath, message, { command: normalized, ...options });
}

/**
 * Continue an existing session with a normal message.
 */
export async function continueSession(
  repoPath: string,
  sessionId: string,
  message: string,
  options?: {
    repo?: string;
    cacheKey?: string;
    timeoutMs?: number;
    watchdog?: {
      enabled?: boolean;
      thresholdsMs?: Partial<WatchdogThresholdsMs>;
      softLogIntervalMs?: number;
      recentEventLimit?: number;
      context?: string;
    };
  }
): Promise<SessionResult> {
  return runSession(repoPath, message, { continueSession: sessionId, ...options });
}

/**
 * Continue an existing session by running a configured command.
 */
export async function continueCommand(
  repoPath: string,
  sessionId: string,
  command: string,
  args: string[] = [],
  options?: {
    repo?: string;
    cacheKey?: string;
    timeoutMs?: number;
    watchdog?: {
      enabled?: boolean;
      thresholdsMs?: Partial<WatchdogThresholdsMs>;
      softLogIntervalMs?: number;
      recentEventLimit?: number;
      context?: string;
    };
  }
): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");
  return runSession(repoPath, message, { command: normalized, continueSession: sessionId, ...options });
}

/**
 * Stream JSON events for a run.
 */
export async function* streamSession(
  repoPath: string,
  message: string,
  options?: {
    command?: string;
    agent?: string;
    continueSession?: string;
    repo?: string;
    cacheKey?: string;
  }
): AsyncGenerator<any, void, unknown> {
  const args: string[] = ["run"];

  const command = normalizeCommand(options?.command);
  if (command) {
    args.push("--command", command, ...argsFromMessage(message));
  } else {
    args.push(message);
  }

  if (options?.continueSession) args.push("-s", options.continueSession);
  if (options?.agent) args.push("--agent", options.agent);

  args.push("--format", "json");

  const xdgCacheHome = getIsolatedXdgCacheHome({ repo: options?.repo, cacheKey: options?.cacheKey });
  mkdirSync(xdgCacheHome, { recursive: true });

  const proc = spawn("opencode", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, XDG_CACHE_HOME: xdgCacheHome },
  });

  let buffer = "";

  for await (const chunk of proc.stdout as any) {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // ignore
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer.trim());
    } catch {
      // ignore
    }
  }
}
