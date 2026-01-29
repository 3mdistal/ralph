import { spawn as nodeSpawn, type ChildProcess } from "child_process";

type SpawnFn = typeof nodeSpawn;

const spawnFn: SpawnFn = nodeSpawn;

type Scheduler = {
  now: () => number;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

const defaultScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import type { Writable } from "stream";

import { getRalphSessionLockPath, getSessionDir, getSessionEventsPath } from "./paths";
import {
  buildIntrospectionSummary,
  createIntrospectionState,
  recordStepStart,
  reduceIntrospectionEvent,
  type ToolEventInfo,
} from "./introspection/reducer";
import { isSafeSessionId } from "./session-id";
import { ensureManagedOpencodeConfigInstalled } from "./opencode-managed-config";
import { registerOpencodeRun, unregisterOpencodeRun, updateOpencodeRun } from "./opencode-process-registry";
import { DEFAULT_WATCHDOG_THRESHOLDS_MS, type WatchdogThresholdMs, type WatchdogThresholdsMs } from "./watchdog";

export interface ServerHandle {
  url: string;
  port: number;
  process: ChildProcess;
}

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

export interface StallTimeoutInfo {
  kind: "stall-timeout";
  idleMs: number;
  lastActivityMsAgo: number;
  context?: string;
  recentEvents?: string[];
}

export interface SessionResult {
  sessionId: string;
  output: string;
  success: boolean;
  exitCode?: number;
  watchdogTimeout?: WatchdogTimeoutInfo;
  stallTimeout?: StallTimeoutInfo;
  /** Best-effort PR URL discovered from structured JSON events. */
  prUrl?: string;
  errorCode?: "context_length_exceeded";
}


/**
 * Spawn an OpenCode server for a specific repo directory.
 * Not required for `opencode run`, but useful for interactive/attached modes.
 */
async function spawnServer(repoPath: string): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const port = 4000 + Math.floor(Math.random() * 1000);
    const { env } = buildOpencodeSpawnEnvironment({ repo: repoPath, cacheKey: "server" });

    const proc = spawnFn("opencode", ["serve", "--port", String(port)], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      env,
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

function killServer(handle: ServerHandle): void {
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

const CONTEXT_LENGTH_PATTERNS = [
  /"code"\s*:\s*"context_length_exceeded"/i,
  /context_length_exceeded/i,
  /input exceeds the context window/i,
];

function detectContextLengthExceeded(input: string): boolean {
  if (!input) return false;
  return CONTEXT_LENGTH_PATTERNS.some((pattern) => pattern.test(input));
}

function detectOpencodeErrorCode(params: {
  stderr: string;
  stdout: string;
  textOutput: string;
  recentEvents: string[];
}): "context_length_exceeded" | undefined {
  const tail = (value: string, max: number) => (value.length > max ? value.slice(-max) : value);
  const recent = params.recentEvents.slice(-50).join("\n");
  const samples = [params.stderr, params.textOutput, params.stdout, recent]
    .filter(Boolean)
    .map((value) => tail(value, 4000));

  if (samples.some((value) => detectContextLengthExceeded(value))) {
    return "context_length_exceeded";
  }

  return undefined;
}

function resolveOpencodeBin(): string {
  const override = process.env.OPENCODE_BIN?.trim();
  if (override) return override;

  const candidates = [
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
    join(homedir(), ".local", "bin", "opencode"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return "opencode";
}

function getIsolatedXdgCacheHome(opts?: {
  repo?: string;
  cacheKey?: string;
  xdgCacheHome?: string;
  homeDir?: string;
}): string {
  const repo = normalizeCacheSegment(opts?.repo ?? "unknown-repo");
  const key = normalizeCacheSegment(opts?.cacheKey ?? "default");
  const homeDir = opts?.homeDir ?? homedir();

  const rawCacheHome = opts?.xdgCacheHome?.trim();
  const cacheHome = rawCacheHome ? rawCacheHome : join(homeDir, ".cache");

  return join(cacheHome, "ralph-opencode", repo, key);
}

type OpencodeSpawnOptions = {
  repo?: string;
  cacheKey?: string;
  opencodeXdg?: {
    dataHome?: string;
    configHome?: string;
    stateHome?: string;
    cacheHome?: string;
  };
};

function buildOpencodeSpawnEnvironment(opts?: OpencodeSpawnOptions): { env: Record<string, string | undefined>; xdgCacheHome: string } {
  const opencodeXdg = opts?.opencodeXdg;
  const xdgCacheHome = getIsolatedXdgCacheHome({
    repo: opts?.repo,
    cacheKey: opts?.cacheKey,
    xdgCacheHome: opencodeXdg?.cacheHome,
  });
  mkdirSync(xdgCacheHome, { recursive: true });

  const opencodeConfigDir = ensureManagedOpencodeConfigInstalled();

  return {
    xdgCacheHome,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: opencodeConfigDir,
      ...(opencodeXdg?.dataHome ? { XDG_DATA_HOME: opencodeXdg.dataHome } : {}),
      ...(opencodeXdg?.configHome ? { XDG_CONFIG_HOME: opencodeXdg.configHome } : {}),
      ...(opencodeXdg?.stateHome ? { XDG_STATE_HOME: opencodeXdg.stateHome } : {}),
      XDG_CACHE_HOME: xdgCacheHome,
    },
  };
}

export function __buildOpencodeEnvForTests(opts?: OpencodeSpawnOptions): Record<string, string | undefined> {
  return buildOpencodeSpawnEnvironment(opts).env;
}

function extractOpencodeLogPath(text: string): string | null {
  // Example: "check log file at /Users/.../.local/share/opencode/log/2026-01-10T003721.log"
  const match = text.match(/check log file at\s+([^\s]+\.log)/i);
  return match?.[1] ?? null;
}

function redactHomePath(path: string): string {
  const home = homedir();
  if (!home) return path;
  return path.split(home).join("~");
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

  // Avoid leaking local usernames in diagnostics.
  const home = homedir();
  if (home) out = out.split(home).join("~");

  return out;
}

const TOOL_RESULT_FINGERPRINT_MIN_CHARS = 40;
const TOOL_RESULT_FINGERPRINT_MAX_CHARS = 200;

function hashFingerprint(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function fingerprintValue(value: string): string | null {
  const sanitized = sanitizeOpencodeLog(value);
  const trimmed = sanitized.trim();
  if (trimmed.length < TOOL_RESULT_FINGERPRINT_MIN_CHARS) return null;
  const truncated = trimmed.slice(0, TOOL_RESULT_FINGERPRINT_MAX_CHARS);
  return `${hashFingerprint(truncated)}:${truncated.length}`;
}

const TOOL_OUTPUT_BUDGET = {
  maxLines: 200,
  maxChars: 20000,
} as const;

export function applyToolOutputBudget(text: string): { text: string; truncated: boolean } {
  const original = text ?? "";
  const lines = original.split("\n");
  const originalLines = lines.length;
  const originalChars = original.length;

  const withinLineBudget = originalLines <= TOOL_OUTPUT_BUDGET.maxLines;
  const withinCharBudget = originalChars <= TOOL_OUTPUT_BUDGET.maxChars;
  if (withinLineBudget && withinCharBudget) return { text: original, truncated: false };

  const headLines = lines.slice(0, TOOL_OUTPUT_BUDGET.maxLines);
  let truncated = headLines.join("\n");
  if (truncated.length > TOOL_OUTPUT_BUDGET.maxChars) {
    truncated = truncated.slice(0, TOOL_OUTPUT_BUDGET.maxChars);
  }

  const marker =
    `\n\n[output truncated: original_lines=${originalLines} max_lines=${TOOL_OUTPUT_BUDGET.maxLines} ` +
    `original_chars=${originalChars} max_chars=${TOOL_OUTPUT_BUDGET.maxChars}]\n`;

  return { text: truncated.trimEnd() + marker, truncated: true };
}

export async function enforceToolOutputBudgetInStorage(
  sessionId: string,
  opts?: { xdgDataHome?: string; homeDir?: string }
): Promise<void> {
  const homeDir = opts?.homeDir ?? homedir();

  const rawFromOpts = opts?.xdgDataHome?.trim();
  const rawFromEnv = process.env.XDG_DATA_HOME?.trim();
  const xdgDataHome = rawFromOpts ? rawFromOpts : rawFromEnv ? rawFromEnv : join(homeDir, ".local", "share");

  const storageDir = join(xdgDataHome, "opencode", "storage");
  const messagesDir = join(storageDir, "message", sessionId);
  if (!existsSync(messagesDir)) return;

  let truncatedParts = 0;

  try {
    const messageFiles = (await readdir(messagesDir)).filter((f) => f.endsWith(".json"));

    for (const file of messageFiles) {
      try {
        const msgRaw = await readFile(join(messagesDir, file), "utf8");
        const msg = JSON.parse(msgRaw);
        const messageId = msg?.id;
        if (!messageId || typeof messageId !== "string") continue;

        const partsDir = join(storageDir, "part", messageId);
        if (!existsSync(partsDir)) continue;

        const partFiles = (await readdir(partsDir)).filter((f) => f.endsWith(".json"));
        for (const partFile of partFiles) {
          const partPath = join(partsDir, partFile);
          try {
            const partRaw = await readFile(partPath, "utf8");
            const part = JSON.parse(partRaw);

            const type = typeof part?.type === "string" ? part.type.toLowerCase() : "";
            const isToolPart = type.includes("tool") && type !== "text";
            if (!isToolPart) continue;

            let changed = false;

            const TOOL_STRING_KEYS = new Set(["output", "stdout", "stderr", "result", "content", "text"]);

            const visit = (node: any, key?: string): any => {
              if (typeof node === "string") {
                if (key && TOOL_STRING_KEYS.has(key)) {
                  const capped = applyToolOutputBudget(node);
                  if (capped.truncated) changed = true;
                  return capped.text;
                }
                return node;
              }

              if (Array.isArray(node)) {
                for (let i = 0; i < node.length; i++) node[i] = visit(node[i]);
                return node;
              }

              if (node && typeof node === "object") {
                for (const [k, v] of Object.entries(node)) {
                  (node as any)[k] = visit(v, k);
                }
                return node;
              }

              return node;
            };

            visit(part);

            if (changed) {
              truncatedParts++;
              await writeFile(partPath, JSON.stringify(part), "utf8");
            }
          } catch {
            // ignore malformed part files
          }
        }
      } catch {
        // ignore malformed message files
      }
    }
  } catch {
    // ignore storage IO errors
  }

  if (truncatedParts > 0) {
    console.log(`[ralph:session] Applied tool output budget to session ${sessionId} (${truncatedParts} part(s) truncated)`);
  }
}

export function getRalphXdgCacheHome(repo: string, cacheKey: string, xdgCacheHome?: string): string {
  return getIsolatedXdgCacheHome({ repo, cacheKey, xdgCacheHome });
}

async function appendOpencodeLogTail(output: string): Promise<string> {
  const logPath = extractOpencodeLogPath(output);
  if (!logPath) return output;

  const displayPath = redactHomePath(logPath);

  try {
    const raw = await readFile(logPath, "utf8");
    const lines = raw.split("\n");
    const tailLines = lines.slice(Math.max(0, lines.length - 200));
    const tail = sanitizeOpencodeLog(tailLines.join("\n")).slice(0, 20000);

    return [
      output.trimEnd(),
      "",
      "---",
      `OpenCode log tail (${displayPath})`,
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
      `OpenCode log tail unavailable (${displayPath})`,
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
async function runSession(
  repoPath: string,
  message: string,
  options?: RunSessionInternalOptions
): Promise<SessionResult> {
  const scheduler = options?.__testOverrides?.scheduler ?? defaultScheduler;
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

  const PR_URL_RE = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/;

  const extractPrUrlFromEvent = (event: any): string | null => {
    const candidates = [
      event?.prUrl,
      event?.pr_url,
      event?.pullRequestUrl,
      event?.pull_request_url,
      event?.pullRequest?.url,
      event?.pull_request?.url,
      event?.part?.prUrl,
      event?.part?.pr_url,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const match = candidate.match(PR_URL_RE);
      if (match) return match[0];
    }

    return null;
  };

  const pickThreshold = (toolName: string, thresholds: WatchdogThresholdsMs): WatchdogThresholdMs => {
    const t = normalizeToolName(toolName);

    // Prefer exact matches first.
    if (t === "read") return thresholds.read;
    if (t === "glob") return thresholds.glob;
    if (t === "grep") return thresholds.grep;
    if (t === "task") return thresholds.task;
    if (t === "bash" || t === "shell") return thresholds.bash;

    // Fall back to word-boundary substring matches.
    if (/\bread\b/.test(t)) return thresholds.read;
    if (/\bglob\b/.test(t)) return thresholds.glob;
    if (/\bgrep\b/.test(t)) return thresholds.grep;
    if (/\btask\b/.test(t)) return thresholds.task;
    if (/\bbash\b|\bshell\b/.test(t)) return thresholds.bash;

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
      return sanitizeOpencodeLog(truncate(str, 500));
    } catch {
      return undefined;
    }
  };

  const extractToolIdentity = (event: any): { toolName?: string; callId?: string } => {
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

    return { toolName, callId };
  };

  const extractToolInfo = (event: any): ToolEventInfo | null => {
    const type = String(event?.type ?? event?.event ?? "").toLowerCase();
    const { toolName, callId } = extractToolIdentity(event);

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

  const extractToolResultText = (event: any): string | null => {
    const candidate =
      event?.tool?.result ??
      event?.tool?.output ??
      event?.part?.toolResult?.output ??
      event?.part?.toolResult?.content ??
      event?.part?.tool?.result ??
      event?.part?.tool?.output ??
      event?.part?.tool_result?.output ??
      event?.part?.tool_result?.content ??
      undefined;

    if (candidate == null) return null;
    if (typeof candidate === "string") return candidate;
    try {
      return JSON.stringify(candidate);
    } catch {
      return null;
    }
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

  const opencodeXdg = options?.opencodeXdg;
  const { env: baseEnv, xdgCacheHome } = buildOpencodeSpawnEnvironment({
    repo: options?.repo,
    cacheKey: options?.cacheKey,
    opencodeXdg,
  });

  // Ensure any `gh` usage inside OpenCode runs is scoped to Ralph auth + config.
  // This avoids falling back to a developer's local `gh` auth in daemon runs.
  const ghConfigDir = join(xdgCacheHome, "gh");
  try {
    mkdirSync(ghConfigDir, { recursive: true });
  } catch {
    // ignore
  }


  const env: Record<string, string | undefined> = {
    ...baseEnv,
    GH_CONFIG_DIR: ghConfigDir,
  };
  const spawn = options?.__testOverrides?.spawn ?? spawnFn;
  const processKill = options?.__testOverrides?.processKill ?? process.kill;
  const useProcessGroup = process.platform !== "win32";

  const proc = spawn("opencode", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...(useProcessGroup ? { detached: true } : {}),
  });

  const runLogPath = options?.runLogPath?.trim();

  const runMeta = registerOpencodeRun(proc, {
    useProcessGroup,
    repo: options?.introspection?.repo,
    issue: options?.introspection?.issue,
    taskName: options?.introspection?.taskName,
    command,
  });

  const parsePositiveInt = (value: string | undefined): number | null => {
    const v = (value ?? "").trim();
    if (!v) return null;
    const num = Number.parseInt(v, 10);
    return Number.isFinite(num) && num > 0 ? num : null;
  };

  const maxRunLogBytes =
    parsePositiveInt(process.env.RALPH_RUN_LOG_MAX_BYTES) ??
    10 * 1024 * 1024; // 10MB

  const maxRunLogBackups =
    parsePositiveInt(process.env.RALPH_RUN_LOG_MAX_BACKUPS) ??
    3;

  let runLogStream: Writable | null = null;
  let runLogBytes = 0;
  let runLogRotating = false;
  let rotateScheduled = false;

  const openRunLogStream = (): void => {
    if (!runLogPath) return;

    try {
      mkdirSync(dirname(runLogPath), { recursive: true });
    } catch {
      return;
    }

    try {
      runLogBytes = existsSync(runLogPath) ? statSync(runLogPath).size : 0;
    } catch {
      runLogBytes = 0;
    }

    try {
      runLogStream = createWriteStream(runLogPath, { flags: "a" });
    } catch {
      runLogStream = null;
    }
  };

  const rotateRunLog = (): void => {
    if (!runLogPath) return;
    if (!runLogStream) return;
    if (runLogRotating) return;

    runLogRotating = true;

    try {
      proc.stdout?.pause();
      proc.stderr?.pause();
    } catch {
      // ignore
    }

    const stream: any = runLogStream;
    runLogStream = null;

    const finish = () => {
      try {
        if (maxRunLogBackups <= 0) {
          rmSync(runLogPath, { force: true });
        } else {
          const oldest = `${runLogPath}.${maxRunLogBackups}`;
          try {
            rmSync(oldest, { force: true });
          } catch {
            // ignore
          }

          for (let i = maxRunLogBackups - 1; i >= 1; i--) {
            const from = `${runLogPath}.${i}`;
            const to = `${runLogPath}.${i + 1}`;
            if (!existsSync(from)) continue;
            try {
              renameSync(from, to);
            } catch {
              // ignore
            }
          }

          if (existsSync(runLogPath)) {
            try {
              renameSync(runLogPath, `${runLogPath}.1`);
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }

      runLogBytes = 0;
      openRunLogStream();
      runLogRotating = false;

      try {
        proc.stdout?.resume();
        proc.stderr?.resume();
      } catch {
        // ignore
      }
    };

    try {
      if (typeof stream?.end === "function") {
        stream.end(() => finish());
      } else {
        finish();
      }
    } catch {
      finish();
    }
  };

  const scheduleRotateRunLog = (): void => {
    if (rotateScheduled) return;
    rotateScheduled = true;
    scheduler.setTimeout(() => {
      rotateScheduled = false;
      rotateRunLog();
    }, 0);
  };

  const writeRunLog = (data: Buffer): void => {
    if (!runLogPath) return;
    if (!runLogStream) return;

    try {
      runLogStream.write(data);
      runLogBytes += data.length;
      if (runLogBytes >= maxRunLogBytes) {
        scheduleRotateRunLog();
      }
    } catch {
      // ignore
    }
  };

  const closeRunLogStream = async (): Promise<void> => {
    const stream: any = runLogStream;
    if (!stream || typeof stream.end !== "function") return;

    runLogStream = null;

    try {
      await new Promise<void>((resolve) => {
        try {
          stream.end(() => resolve());
        } catch {
          resolve();
        }
      });
    } catch {
      // ignore
    }
  };

  if (runLogPath) {
    openRunLogStream();
  }

  const sessionsDirOverride = options?.__testOverrides?.sessionsDir?.trim();
  const getSessionDirForRun = (id: string): string => {
    if (sessionsDirOverride) return join(sessionsDirOverride, id);
    return getSessionDir(id);
  };
  const getSessionEventsPathForRun = (id: string): string => {
    if (sessionsDirOverride) return join(sessionsDirOverride, id, "events.jsonl");
    return getSessionEventsPath(id);
  };
  const getSessionLockPathForRun = (id: string): string => {
    if (sessionsDirOverride) return join(sessionsDirOverride, id, "active.lock");
    return getRalphSessionLockPath(id);
  };

  // If continuing an existing session, mark it as active for `ralph nudge`.
  const continueSessionId = options?.continueSession;
  const safeContinueSessionId = continueSessionId && isSafeSessionId(continueSessionId) ? continueSessionId : null;
  if (continueSessionId && !safeContinueSessionId) {
    console.warn(`[ralph] Refusing to write session lock for unsafe session id: ${continueSessionId}`);
  }
  const lockPath = safeContinueSessionId ? getSessionLockPathForRun(safeContinueSessionId) : null;
  const cleanupLock = () => {
    if (!lockPath) return;
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // ignore
    }
  };

  const cleanupRun = () => {
    if (!runMeta) return;
    unregisterOpencodeRun(runMeta.pgid);
  };

  const canListen = typeof (proc as any)?.on === "function";

  if (lockPath && continueSessionId) {
    try {
      mkdirSync(getSessionDirForRun(continueSessionId), { recursive: true });
      writeFileSync(
        lockPath,
        JSON.stringify({ ts: scheduler.now(), pid: proc.pid ?? null, sessionId: continueSessionId }) + "\n"
      );
      if (canListen) {
        proc.on("close", cleanupLock);
        proc.on("error", cleanupLock);
      }
    } catch {
      // If we can't write the lock file, proceed anyway.
    }
  }

  if (canListen) {
    proc.on("close", cleanupRun);
    proc.on("error", cleanupRun);
  }

  const requestKill = () => {
    if (options?.__testOverrides?.spawn && !options?.__testOverrides?.processKill) {
      if (typeof (proc as any)?.kill === "function") {
        try {
          (proc as any).kill("SIGTERM");
        } catch {
          // ignore
        }
        scheduler.setTimeout(() => {
          try {
            (proc as any).kill("SIGKILL");
          } catch {
            // ignore
          }
        }, 5000);
      }
      return;
    }

    const target = runMeta && runMeta.useProcessGroup ? -runMeta.pgid : proc.pid;
    if (!target) return;

    try {
      processKill(target, "SIGTERM");
    } catch {
      // ignore
    }

    // Some processes ignore SIGTERM. Follow up with SIGKILL.
    scheduler.setTimeout(() => {
      try {
        processKill(target, "SIGKILL");
      } catch {
        // ignore
      }
    }, 5000);
  };

  const watchdogEnabled = options?.watchdog?.enabled ?? true;
  const thresholds = mergeThresholds(options?.watchdog?.thresholdsMs);
  const softLogIntervalMs = options?.watchdog?.softLogIntervalMs ?? 30_000;
  const recentEventLimit = options?.watchdog?.recentEventLimit ?? 50;
  const context = options?.watchdog?.context;

  const stallEnabled = options?.stall?.enabled ?? false;
  const stallIdleMs = options?.stall?.idleMs ?? 5 * 60_000;
  const stallContext = options?.stall?.context ?? context;

  let stdout = "";
  let stderr = "";

  let sessionId = "";
  let textOutput = "";
  let prUrlFromEvents: string | null = null;

  const introspection = options?.introspection;
  const introspectionState = createIntrospectionState();

  let eventStream: Writable | null = null;
  let bufferedEventLines: string[] = [];

  const writeEventLine = (line: string): void => {
    if (eventStream) {
      try {
        eventStream.write(line + "\n");
      } catch {
        // ignore
      }
      return;
    }

    bufferedEventLines.push(line);
    if (bufferedEventLines.length > 500) bufferedEventLines = bufferedEventLines.slice(-500);
  };

  const writeEvent = (event: any): void => {
    try {
      writeEventLine(JSON.stringify(event));
    } catch {
      // ignore
    }
  };

  const ensureEventStream = (id: string): void => {
    if (eventStream) return;
    if (!isSafeSessionId(id)) {
      console.warn(`[ralph] Refusing to write session events for unsafe session id: ${id}`);
      return;
    }

    try {
      mkdirSync(getSessionDirForRun(id), { recursive: true });
      eventStream = createWriteStream(getSessionEventsPathForRun(id), { flags: "a" });
      for (const line of bufferedEventLines) {
        try {
          eventStream.write(line + "\n");
        } catch {
          // ignore
        }
      }
      bufferedEventLines = [];
    } catch {
      // ignore
    }
  };

  const closeEventStream = async (): Promise<void> => {
    const stream: any = eventStream;
    if (!stream || typeof stream.end !== "function") return;

    try {
      await new Promise<void>((resolve) => {
        try {
          stream.end(() => resolve());
        } catch {
          resolve();
        }
      });
    } catch {
      // ignore
    }
  };

  const writeIntrospectionSummary = async (endTime: number): Promise<void> => {
    if (!sessionId) return;
    if (!isSafeSessionId(sessionId)) {
      console.warn(`[ralph] Refusing to write summary for unsafe session id: ${sessionId}`);
      return;
    }

    try {
      const summary = buildIntrospectionSummary(introspectionState, { sessionId, endTime });
      const dir = getSessionDirForRun(sessionId);
      mkdirSync(dir, { recursive: true });
      await writeFile(join(dir, "summary.json"), JSON.stringify(summary) + "\n");
    } catch {
      // ignore
    }
  };

  // Seed deterministic context before tool events begin.
  if (introspection?.step != null || introspection?.repo || introspection?.issue || introspection?.taskName) {
    if (typeof introspection?.step === "number") {
      writeEvent({
        type: "step-start",
        ts: scheduler.now(),
        step: introspection.step,
        title: introspection.stepTitle,
        repo: introspection.repo,
        issue: introspection.issue,
        taskName: introspection.taskName,
      });
      recordStepStart(introspectionState);
    }

    writeEvent({
      type: "run-start",
      ts: scheduler.now(),
      command: command ?? undefined,
      agent: options?.agent ?? undefined,
      repo: introspection?.repo,
      issue: introspection?.issue,
      taskName: introspection?.taskName,
      step: introspection?.step,
      stepTitle: introspection?.stepTitle,
    });
  }

  let buffer = "";
  let recentEvents: string[] = [];

  let lastActivityTs = scheduler.now();

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
  let stallTimeout: StallTimeoutInfo | undefined;

  proc.stdout?.on("data", (data: Buffer) => {
    lastActivityTs = scheduler.now();
    writeRunLog(data);

    const chunk = data.toString();
    stdout += chunk;
    buffer += chunk;

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      recentEvents.push(sanitizeOpencodeLog(truncate(trimmed, 800)));
      if (recentEvents.length > recentEventLimit) recentEvents = recentEvents.slice(-recentEventLimit);

      try {
        const event = JSON.parse(trimmed);
        if (typeof options?.onEvent === "function") {
          try {
            options.onEvent(event);
          } catch {
            // ignore
          }
        }
        const eventSessionId = event.sessionID ?? event.sessionId;
        if (eventSessionId && !sessionId) {
          sessionId = String(eventSessionId);
          if (runMeta) updateOpencodeRun(runMeta.pgid, { sessionId });
          ensureEventStream(sessionId);
        } else if (eventSessionId && !eventStream) {
          ensureEventStream(String(eventSessionId));
        }

        if (!prUrlFromEvents) {
          const extracted = extractPrUrlFromEvent(event);
          if (extracted) prUrlFromEvents = extracted;
        }

        const tool = extractToolInfo(event);
        const toolResultText = extractToolResultText(event);
        const { toolName: toolResultName, callId: toolResultCallId } = extractToolIdentity(event);
        const textEventValue = event.type === "text" && typeof event.part?.text === "string" ? event.part.text : null;
        if (textEventValue) {
          textOutput += textEventValue;
        }

        const toolResultFingerprint = toolResultText ? fingerprintValue(toolResultText) : null;
        const textFingerprint = textEventValue ? fingerprintValue(textEventValue) : null;

        const reducerInput = { now: scheduler.now() } as Parameters<typeof reduceIntrospectionEvent>[1];
        let shouldReduce = false;

        if (event.type === "anomaly") {
          reducerInput.opencodeAnomaly = {
            ts: typeof event.ts === "number" ? event.ts : reducerInput.now,
          };
          shouldReduce = true;
        }

        if (tool) {
          reducerInput.tool = tool;
          shouldReduce = true;
        }

        if (toolResultFingerprint && toolResultCallId && toolResultName) {
          const callId = String(toolResultCallId);
          const toolName = String(toolResultName);
          if (callId !== "unknown" && toolName !== "unknown") {
            reducerInput.toolResult = {
              fingerprint: toolResultFingerprint,
              ts: reducerInput.now,
              callId,
              toolName,
            };
            shouldReduce = true;
          }
        }

        if (textFingerprint) {
          reducerInput.text = { fingerprint: textFingerprint, ts: reducerInput.now };
          shouldReduce = true;
        }

        if (shouldReduce) {
          const { events } = reduceIntrospectionEvent(introspectionState, reducerInput);
          for (const event of events) {
            writeEvent(event);
          }
        }

        if (tool) {
          const now = reducerInput.now;

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
    lastActivityTs = scheduler.now();
    writeRunLog(data);
    stderr += data.toString();
  });

  let stallInterval: ReturnType<typeof setInterval> | undefined;
  if (stallEnabled && stallIdleMs > 0) {
    stallInterval = scheduler.setInterval(() => {
      if (stallTimeout) return;
      const now = scheduler.now();
      const idleFor = now - lastActivityTs;
      if (idleFor < stallIdleMs) return;

      stallTimeout = {
        kind: "stall-timeout",
        idleMs: stallIdleMs,
        lastActivityMsAgo: idleFor,
        context: stallContext ?? undefined,
        recentEvents,
      };

      const ctx = stallContext ? ` ${stallContext}` : "";
      console.warn(
        `[ralph:stall] Hard timeout${ctx}: no stdout/stderr activity for ${Math.round(idleFor / 1000)}s; killing opencode process`
      );

      requestKill();
    }, 1000);
  }

  let watchdogInterval: ReturnType<typeof setInterval> | undefined;
  if (watchdogEnabled) {
    watchdogInterval = scheduler.setInterval(() => {
      if (watchdogTimeout || !inFlight) return;

      const now = scheduler.now();
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

        requestKill();
      }
    }, 1000);
  }

  const fallbackTimeoutMs = options?.timeoutMs ?? thresholds.bash.hardMs + 60_000;

  const exitCode = await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    timeout = scheduler.setTimeout(() => {
      requestKill();
      resolve(124);
    }, fallbackTimeoutMs);

    proc.on("error", (err) => {
      if (timeout) scheduler.clearTimeout(timeout);
      if (watchdogInterval) scheduler.clearInterval(watchdogInterval);
      if (stallInterval) scheduler.clearInterval(stallInterval);
      reject(err);
    });

    proc.on("close", (code) => {
      if (timeout) scheduler.clearTimeout(timeout);
      if (watchdogInterval) scheduler.clearInterval(watchdogInterval);
      if (stallInterval) scheduler.clearInterval(stallInterval);
      resolve(code ?? 0);
    });
  });

  await closeRunLogStream();

  if (stallTimeout) {
    const header = [
      `Run stalled: no stdout/stderr activity for ${Math.round(stallTimeout.lastActivityMsAgo / 1000)}s (idleMs=${Math.round(
        stallTimeout.idleMs / 1000
      )}s)`,
      stallTimeout.context ? `Context: ${stallTimeout.context}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const recent = stallTimeout.recentEvents?.length
      ? ["Recent OpenCode events (bounded):", ...stallTimeout.recentEvents.map((l) => `- ${l}`)].join("\n")
      : "";

    const combined = [header, recent].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined);

    if (sessionId) {
      ensureEventStream(sessionId);
      writeEvent({ type: "run-end", ts: scheduler.now(), success: false, exitCode, stallTimeout: true });
      try {
        await closeEventStream();
      } catch {
        // ignore
      }
    }

    if (sessionId) {
      await enforceToolOutputBudgetInStorage(sessionId, { xdgDataHome: opencodeXdg?.dataHome });
    }

    return { sessionId, output: enriched, success: false, exitCode, stallTimeout, prUrl: prUrlFromEvents ?? undefined };
  }

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

    // Avoid attaching full stdout/stderr on watchdog timeouts to reduce the chance of leaking
    // sensitive context. Prefer the bounded event lines + the OpenCode log tail.
    const combined = [header, recent].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined);

    if (sessionId) {
      ensureEventStream(sessionId);
      writeEvent({ type: "run-end", ts: scheduler.now(), success: false, exitCode, watchdogTimeout: true });
      try {
        await closeEventStream();
      } catch {
        // ignore
      }
    }

    await writeIntrospectionSummary(scheduler.now());

    if (sessionId) {
      await enforceToolOutputBudgetInStorage(sessionId, { xdgDataHome: opencodeXdg?.dataHome });
    }

    return { sessionId, output: enriched, success: false, exitCode, watchdogTimeout, prUrl: prUrlFromEvents ?? undefined };
  }

  if (exitCode !== 0) {
    // Avoid dumping full stdout on failures: in JSON mode it can be extremely verbose.
    // Prefer stderr + bounded recent events (and preserve sessionId for debugging).
    const truncateTail = (value: string, max: number) =>
      value.length > max ? `… (truncated, showing last ${max} chars)\n${value.slice(-max)}` : value;

    const combinedRaw = [stderr, stdout].filter(Boolean).join("\n");
    const logPath = extractOpencodeLogPath(combinedRaw);

    const header = `Failed with exit code ${exitCode}${sessionId ? ` (session ${sessionId})` : ""}`;
    const logHint = logPath ? `OpenCode log: \`${redactHomePath(logPath)}\`` : "";

    const err = stderr.trim() ? sanitizeOpencodeLog(truncateTail(stderr.trim(), 8000)) : "";
    const text = textOutput.trim() ? sanitizeOpencodeLog(truncateTail(textOutput.trim(), 8000)) : "";
    const errorCode = detectOpencodeErrorCode({ stderr, stdout, textOutput, recentEvents });

    const recent = recentEvents.length
      ? ["Recent OpenCode events (bounded):", ...recentEvents.map((l) => `- ${l}`)].join("\n")
      : "";

    const stdoutSnippet =
      !err && !text && recentEvents.length === 0 && stdout.trim()
        ? sanitizeOpencodeLog(truncateTail(stdout.trim(), 4000))
        : "";

    const combined = [header, logHint, err, text, stdoutSnippet, recent].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined);

    if (sessionId) {
      ensureEventStream(sessionId);
      writeEvent({ type: "run-end", ts: scheduler.now(), success: false, exitCode });
      try {
        await closeEventStream();
      } catch {
        // ignore
      }
    }

    await writeIntrospectionSummary(scheduler.now());

    if (sessionId) {
      await enforceToolOutputBudgetInStorage(sessionId, { xdgDataHome: opencodeXdg?.dataHome });
    }

    return { sessionId, output: enriched, success: false, exitCode, prUrl: prUrlFromEvents ?? undefined, errorCode };
  }

  const raw = stdout.toString();

  if (sessionId) {
    ensureEventStream(sessionId);
    writeEvent({ type: "run-end", ts: scheduler.now(), success: true, exitCode });
    try {
      await closeEventStream();
    } catch {
      // ignore
    }
  }

  await writeIntrospectionSummary(scheduler.now());

  if (sessionId) {
    await enforceToolOutputBudgetInStorage(sessionId, { xdgDataHome: opencodeXdg?.dataHome });
  }

  return { sessionId, output: textOutput || raw, success: true, exitCode, prUrl: prUrlFromEvents ?? undefined };
}

export type RunSessionOptionsBase = {
  repo?: string;
  cacheKey?: string;
  opencodeXdg?: {
    dataHome?: string;
    configHome?: string;
    stateHome?: string;
    cacheHome?: string;
  };
  runLogPath?: string;
  timeoutMs?: number;
  introspection?: {
    repo?: string;
    issue?: string;
    taskName?: string;
    step?: number;
    stepTitle?: string;
  };
  watchdog?: {
    enabled?: boolean;
    thresholdsMs?: Partial<WatchdogThresholdsMs>;
    softLogIntervalMs?: number;
    recentEventLimit?: number;
    context?: string;
  };
  stall?: {
    enabled?: boolean;
    /** Kill the run if there is no stdout/stderr activity for this long. */
    idleMs?: number;
    context?: string;
  };
  onEvent?: (event: any) => void;
};

export type RunSessionTestOverrides = {
  spawn?: SpawnFn;
  scheduler?: Scheduler;
  sessionsDir?: string;
  processKill?: typeof process.kill;
};

type RunSessionInternalOptions = RunSessionOptionsBase & {
  command?: string;
  continueSession?: string;
  agent?: string;
  __testOverrides?: RunSessionTestOverrides;
};

/**
 * Run a configured command in a new session.
 * `command` should be the command name WITHOUT a leading slash (e.g. `plan`).
 */
export async function runCommand(
  repoPath: string,
  command: string,
  args: string[] = [],
  options?: RunSessionOptionsBase,
  testOverrides?: RunSessionTestOverrides
): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");

  const merged: RunSessionInternalOptions = { command: normalized, ...(options ?? {}) };
  if (testOverrides) merged.__testOverrides = testOverrides;

  return runSession(repoPath, message, merged);
}

/**
 * Continue an existing session with a normal message.
 */
export async function continueSession(
  repoPath: string,
  sessionId: string,
  message: string,
  options?: RunSessionOptionsBase & { agent?: string }
): Promise<SessionResult> {
  const { agent, ...rest } = options ?? {};
  return runSession(repoPath, message, { continueSession: sessionId, agent, ...rest });
}

/**
 * Run an agent with a normal message.
 */
export async function runAgent(
  repoPath: string,
  agent: string,
  message: string,
  options?: RunSessionOptionsBase,
  testOverrides?: RunSessionTestOverrides
): Promise<SessionResult> {
  const merged: RunSessionInternalOptions = { agent, ...(options ?? {}) };
  if (testOverrides) merged.__testOverrides = testOverrides;
  return runSession(repoPath, message, merged);
}

/**
 * Continue an existing session by running a configured command.
 */
export async function continueCommand(
  repoPath: string,
  sessionId: string,
  command: string,
  args: string[] = [],
  options?: RunSessionOptionsBase
): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");
  return runSession(repoPath, message, { command: normalized, continueSession: sessionId, ...options });
}

/**
 * Stream JSON events for a run.
 */
async function* streamSession(
  repoPath: string,
  message: string,
  options?: RunSessionInternalOptions
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

  const { env: baseEnv, xdgCacheHome } = buildOpencodeSpawnEnvironment({
    repo: options?.repo,
    cacheKey: options?.cacheKey,
    opencodeXdg: options?.opencodeXdg,
  });

  const ghConfigDir = join(xdgCacheHome, "gh");
  try {
    mkdirSync(ghConfigDir, { recursive: true });
  } catch {
    // ignore
  }


  const env: Record<string, string | undefined> = {
    ...baseEnv,
    GH_CONFIG_DIR: ghConfigDir,
  };

  const spawn = options?.__testOverrides?.spawn ?? spawnFn;
  const useProcessGroup = process.platform !== "win32";

  const proc = spawn("opencode", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
    env,
    ...(useProcessGroup ? { detached: true } : {}),
  });

  const runMeta = registerOpencodeRun(proc, {
    useProcessGroup,
    command,
  });

  const cleanupRun = () => {
    if (!runMeta) return;
    unregisterOpencodeRun(runMeta.pgid);
  };

  if (typeof (proc as any)?.on === "function") {
    proc.on("close", cleanupRun);
    proc.on("error", cleanupRun);
  }

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

export async function* __streamSessionForTests(
  repoPath: string,
  message: string,
  options?: {
    command?: string;
    agent?: string;
    continueSession?: string;
    repo?: string;
    cacheKey?: string;
    __testOverrides?: {
      scheduler?: Scheduler;
      sessionsDir?: string;
      spawn?: SpawnFn;
      processKill?: typeof process.kill;
    };
  }
): AsyncGenerator<any, void, unknown> {
  yield* streamSession(repoPath, message, options);
}
