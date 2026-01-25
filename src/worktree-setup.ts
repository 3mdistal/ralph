import { createHash } from "crypto";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { lstat, mkdir, open, readFile, rename, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { sanitizeEscalationReason } from "./github/escalation-writeback";
import { applyToolOutputBudget } from "./session";

const SETUP_STATE_VERSION = 1;
const SETUP_STATE_FILENAME = "setup-state.json";
const SETUP_LOCK_FILENAME = "setup.lock";
const SETUP_LOCK_ATTEMPTS = 20;
const SETUP_LOCK_WAIT_MS = 50;
const SETUP_LOCK_STALE_MS = 30 * 60_000;
const OUTPUT_TAIL_MAX_CHARS = 20_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 15 * 60_000;

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
];

type SetupState = {
  version: number;
  commandsHash: string;
  lockfileSignature: string;
  completedAt: string;
  lockfiles?: string[];
  durationsMs?: number[];
  runner?: "bash" | "sh";
};

type SetupDecision = {
  action: "run" | "skip";
  reason: string;
};

export type WorktreeSetupResult =
  | { status: "skipped"; reason: string; state?: SetupState }
  | { status: "success"; state: SetupState }
  | { status: "failed"; reason: string; command: string; exitCode: number; output: string };

type ShellChoice = { runner: "bash" | "sh"; command: string; args: string[] };

type WorktreeSetupOptions = {
  worktreePath: string;
  commands: string[];
  runLogPath?: string;
  timeoutMs?: number;
};

function hashSha256(input: string | Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(input);
  return hash.digest("hex");
}

export function hashSetupCommands(commands: string[]): string {
  return hashSha256(JSON.stringify(commands));
}

function normalizeCommands(commands: string[]): string[] {
  return commands.map((cmd) => String(cmd ?? "").trim()).filter(Boolean);
}

function resolveShell(): ShellChoice {
  if (existsSync("/bin/bash")) {
    return { runner: "bash", command: "/bin/bash", args: ["-lc"] };
  }
  return { runner: "sh", command: "sh", args: ["-c"] };
}

async function ensureSetupDir(worktreePath: string): Promise<string> {
  const dir = join(worktreePath, ".ralph");
  if (existsSync(dir)) {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink()) {
      throw new Error(`[ralph] Refusing to write setup state into symlink: ${dir}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`[ralph] Setup state path is not a directory: ${dir}`);
    }
    return dir;
  }

  await mkdir(dir, { recursive: true });
  return dir;
}

function getSetupStatePath(worktreePath: string): string {
  return join(worktreePath, ".ralph", SETUP_STATE_FILENAME);
}

function getSetupLockPath(worktreePath: string): string {
  return join(worktreePath, ".ralph", SETUP_LOCK_FILENAME);
}

async function readSetupState(worktreePath: string): Promise<SetupState | null> {
  const path = getSetupStatePath(worktreePath);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== SETUP_STATE_VERSION) return null;
    if (typeof parsed.commandsHash !== "string" || !parsed.commandsHash.trim()) return null;
    if (typeof parsed.lockfileSignature !== "string") return null;
    if (typeof parsed.completedAt !== "string" || !parsed.completedAt.trim()) return null;
    return parsed as SetupState;
  } catch {
    return null;
  }
}

async function writeSetupStateAtomic(worktreePath: string, state: SetupState): Promise<void> {
  const path = getSetupStatePath(worktreePath);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await rename(tempPath, path);
}

function listLockfiles(worktreePath: string): string[] {
  const found: string[] = [];
  for (const file of LOCKFILES) {
    if (existsSync(join(worktreePath, file))) found.push(file);
  }
  return found;
}

export async function computeLockfileSignature(
  worktreePath: string
): Promise<{ signature: string; lockfiles: string[] }> {
  const lockfiles = listLockfiles(worktreePath);
  if (lockfiles.length === 0) {
    return { signature: "none", lockfiles: [] };
  }

  const manifest: Array<{ path: string; sha256: string }> = [];
  for (const file of lockfiles) {
    const absolute = join(worktreePath, file);
    const contents = await readFile(absolute);
    manifest.push({ path: file, sha256: hashSha256(contents) });
  }
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  const signature = hashSha256(JSON.stringify(manifest));
  return { signature, lockfiles };
}

function decideSetup(params: {
  commandsHash: string;
  lockfileSignature: string;
  prior: SetupState | null;
}): SetupDecision {
  if (!params.prior) return { action: "run", reason: "no prior setup marker" };
  if (params.prior.commandsHash !== params.commandsHash) {
    return { action: "run", reason: "setup commands changed" };
  }
  if (params.prior.lockfileSignature !== params.lockfileSignature) {
    return { action: "run", reason: "lockfiles changed" };
  }
  return { action: "skip", reason: "setup already ran for current commands + lockfiles" };
}

function appendTail(current: string, chunk: Uint8Array | string, maxChars: number): string {
  const next = current + chunk.toString();
  if (next.length <= maxChars) return next;
  return next.slice(-maxChars);
}

function formatOutput(stdout: string, stderr: string): { text: string; truncated: boolean } {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
  if (!combined) return { text: "", truncated: false };
  const sanitized = sanitizeEscalationReason(combined);
  return applyToolOutputBudget(sanitized);
}

async function appendRunLog(path: string | undefined, lines: string[]): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function readLockInfo(rawPath: string): { pid?: number; createdAt?: number } | null {
  try {
    const raw = readFileSync(rawPath, "utf8");
    const parsed = JSON.parse(raw) as { pid?: number; createdAt?: number };
    return parsed ?? null;
  } catch {
    return null;
  }
}

function isLockStale(info: { pid?: number; createdAt?: number } | null): boolean {
  if (!info?.pid || !info?.createdAt) return true;
  if (Date.now() - info.createdAt > SETUP_LOCK_STALE_MS) return true;
  try {
    process.kill(info.pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function withSetupLock<T>(worktreePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = getSetupLockPath(worktreePath);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let lastError: unknown = null;

  for (let attempt = 0; attempt < SETUP_LOCK_ATTEMPTS; attempt++) {
    try {
      handle = await open(lockPath, "wx");
      const payload = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
      await handle.writeFile(payload, "utf8");
      break;
    } catch (err: any) {
      lastError = err;
      if (err?.code !== "EEXIST") break;
      const info = readLockInfo(lockPath);
      if (isLockStale(info)) {
        try {
          await unlink(lockPath);
        } catch {
          // ignore
        }
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, SETUP_LOCK_WAIT_MS));
    }
  }

  if (handle == null) {
    const detail = lastError instanceof Error ? lastError.message : String(lastError ?? "unknown");
    throw new Error(
      `[ralph] Failed to acquire setup lock ${lockPath}: ${detail}. ` +
        `If this is stale, delete the lock file and retry.`
    );
  }

  try {
    return await fn();
  } finally {
    try {
      await handle.close();
    } catch {
      // ignore
    }
    try {
      await unlink(lockPath);
    } catch {
      // ignore
    }
  }
}

async function runCommand(params: {
  worktreePath: string;
  command: string;
  timeoutMs: number;
}): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  runner: "bash" | "sh";
}> {
  const shell = resolveShell();
  const env = {
    ...process.env,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
  };

  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(shell.command, [...shell.args, params.command], {
    cwd: params.worktreePath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout?.on("data", (chunk: Uint8Array) => {
    stdout = appendTail(stdout, chunk, OUTPUT_TAIL_MAX_CHARS);
  });
  child.stderr?.on("data", (chunk: Uint8Array) => {
    stderr = appendTail(stderr, chunk, OUTPUT_TAIL_MAX_CHARS);
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }, params.timeoutMs);

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code: number | null) => resolve(code ?? 124));
    child.on("error", () => resolve(1));
  });

  clearTimeout(timeout);

  return {
    exitCode: timedOut ? 124 : exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - started,
    timedOut,
    runner: shell.runner,
  };
}

export async function runWorktreeSetup(options: WorktreeSetupOptions): Promise<WorktreeSetupResult> {
  const commands = normalizeCommands(options.commands);
  if (commands.length === 0) {
    return { status: "skipped", reason: "no setup commands configured" };
  }

  await ensureSetupDir(options.worktreePath);

  return await withSetupLock(options.worktreePath, async () => {
    const commandsHash = hashSetupCommands(commands);
    const currentSignature = await computeLockfileSignature(options.worktreePath);
    const prior = await readSetupState(options.worktreePath);
    const decision = decideSetup({
      commandsHash,
      lockfileSignature: currentSignature.signature,
      prior,
    });

    if (decision.action === "skip") {
      await appendRunLog(options.runLogPath, [
        "setup: skip",
        `reason: ${decision.reason}`,
        `commandsHash: ${commandsHash}`,
        `lockfileSignature: ${currentSignature.signature}`,
      ]);
      return { status: "skipped", reason: decision.reason, state: prior ?? undefined };
    }

    const durationsMs: number[] = [];
    let runner: "bash" | "sh" = "sh";

    await appendRunLog(options.runLogPath, [
      "setup: start",
      `commands: ${commands.length}`,
      `commandsHash: ${commandsHash}`,
      `lockfileSignature: ${currentSignature.signature}`,
    ]);

    for (const command of commands) {
      const result = await runCommand({
        worktreePath: options.worktreePath,
        command,
        timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      });
      runner = result.runner;
      durationsMs.push(result.durationMs);

      const formatted = formatOutput(result.stdout, result.stderr);
      const outputSnippet = formatted.text.trim();

      await appendRunLog(options.runLogPath, [
        "",
        `command: ${command}`,
        `exitCode: ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`,
        ...(outputSnippet ? ["output:", outputSnippet] : ["output: (empty)"]),
      ]);

      if (result.exitCode !== 0) {
        const reasonLines = [
          `Setup command failed: ${command}`,
          `Exit code: ${result.exitCode}${result.timedOut ? " (timeout)" : ""}`,
        ];
        if (outputSnippet) reasonLines.push("Output (tail):", outputSnippet);
        const reason = reasonLines.join("\n");
        return {
          status: "failed",
          reason,
          command,
          exitCode: result.exitCode,
          output: outputSnippet,
        };
      }
    }

    const postSignature = await computeLockfileSignature(options.worktreePath);
    const state: SetupState = {
      version: SETUP_STATE_VERSION,
      commandsHash,
      lockfileSignature: postSignature.signature,
      completedAt: new Date().toISOString(),
      lockfiles: postSignature.lockfiles,
      durationsMs,
      runner,
    };

    await writeSetupStateAtomic(options.worktreePath, state);
    await appendRunLog(options.runLogPath, [
      "",
      "setup: complete",
      `lockfileSignature: ${postSignature.signature}`,
    ]);

    return { status: "success", state };
  });
}
