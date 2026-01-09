import { $ } from "bun";
import { spawn, type ChildProcess } from "child_process";

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

  try {
    const result = await $`opencode ${args}`.cwd(repoPath).quiet();
    const raw = result.stdout.toString();

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
  } catch (e: any) {
    return {
      sessionId: "",
      output: e?.stderr?.toString?.() || e?.message || "Unknown error",
      success: false,
    };
  }
}

/**
 * Run a configured command in a new session.
 * `command` should be the command name WITHOUT a leading slash (e.g. `next-task`).
 */
export async function runCommand(repoPath: string, command: string, args: string[] = []): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");
  return runSession(repoPath, message, { command: normalized });
}

/**
 * Continue an existing session with a normal message.
 */
export async function continueSession(repoPath: string, sessionId: string, message: string): Promise<SessionResult> {
  return runSession(repoPath, message, { continueSession: sessionId });
}

/**
 * Continue an existing session by running a configured command.
 */
export async function continueCommand(
  repoPath: string,
  sessionId: string,
  command: string,
  args: string[] = []
): Promise<SessionResult> {
  const normalized = normalizeCommand(command)!;
  const message = ["/" + normalized, ...args].join(" ");
  return runSession(repoPath, message, { command: normalized, continueSession: sessionId });
}

/**
 * Stream JSON events for a run.
 */
export async function* streamSession(
  repoPath: string,
  message: string,
  options?: { command?: string; agent?: string; continueSession?: string }
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

  const proc = spawn("opencode", args, {
    cwd: repoPath,
    stdio: ["ignore", "pipe", "pipe"],
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
