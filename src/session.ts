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

export interface SessionResult {
  sessionId: string;
  output: string;
  success: boolean;
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
    timeoutMs?: number;
  }
): Promise<SessionResult> {
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

  let stdout = "";
  let stderr = "";

  proc.stdout?.on("data", (data: Buffer) => {
    stdout += data.toString();
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    if (options?.timeoutMs) {
      timeout = setTimeout(() => {
        proc.kill();
        resolve(124);
      }, options.timeoutMs);
    }

    proc.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      reject(err);
    });

    proc.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve(code ?? 0);
    });
  });

  if (exitCode !== 0) {
    const combined = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
    const enriched = await appendOpencodeLogTail(combined || `Failed with exit code ${exitCode}`);
    return { sessionId: "", output: enriched, success: false };
  }

  const raw = stdout.toString();

  const lines = raw.trim().split("\n").filter(Boolean);
  let sessionId = "";
  let textOutput = "";

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      const eventSessionId = event.sessionID ?? event.sessionId;
      if (eventSessionId && !sessionId) sessionId = eventSessionId;
      if (event.type === "text" && event.part?.text) textOutput += event.part.text;
    } catch {
      // ignore
    }
  }

  return { sessionId, output: textOutput || raw, success: true };
}

/**
 * Run a configured command in a new session.
 * `command` should be the command name WITHOUT a leading slash (e.g. `next-task`).
 */
export async function runCommand(
  repoPath: string,
  command: string,
  args: string[] = [],
  options?: { repo?: string; cacheKey?: string; timeoutMs?: number }
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
  options?: { agent?: string; repo?: string; cacheKey?: string; timeoutMs?: number }
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
  options?: { repo?: string; cacheKey?: string; timeoutMs?: number }
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
