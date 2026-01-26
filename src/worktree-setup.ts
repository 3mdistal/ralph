import { createHash, randomUUID } from "crypto";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

import { sanitizeEscalationReason } from "./github/escalation-writeback";

export type SetupPlan = {
  action: "skip" | "run";
  commandsHash: string;
  preLockfileSignature: string;
  markerPath: string;
  lockPath: string;
  skipReason?: string;
};

export type SetupState = {
  version: number;
  commandsHash: string;
  lockfileSignature: string;
  completedAt: string;
};

export type SetupFailure = {
  command: string;
  commandIndex: number;
  totalCommands: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
  reason: string;
};

export type SetupResult = {
  ok: boolean;
  skipped: boolean;
  commandsHash: string;
  lockfileSignature: string;
  skipReason?: string;
  failure?: SetupFailure;
};

type DependencySignature = {
  signature: string;
  source: "lockfile" | "manifest" | "none";
  files: string[];
};

type SetupPaths = {
  markerPath: string;
  lockPath: string;
  ralphDir: string;
};

const SETUP_STATE_VERSION = 1;
const SETUP_STATE_FILENAME = "setup-state.json";
const SETUP_LOCK_DIRNAME = "setup.lock.d";

const DEFAULT_COMMAND_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LOCK_STALE_MS = 60 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
const OUTPUT_TAIL_MAX_CHARS = 8000;

const LOCKFILES = [
  "bun.lockb",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "npm-shrinkwrap.json",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "go.sum",
  "composer.lock",
];

const MANIFESTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSetupPaths(worktreePath: string): SetupPaths {
  const ralphDir = join(worktreePath, ".ralph");
  return {
    ralphDir,
    markerPath: join(ralphDir, SETUP_STATE_FILENAME),
    lockPath: join(ralphDir, SETUP_LOCK_DIRNAME),
  };
}

function normalizeCommands(commands: string[]): string[] {
  return commands.map((command) => command.trim()).filter(Boolean);
}

export function computeCommandsHash(commands: string[]): string {
  const normalized = normalizeCommands(commands);
  const joined = normalized.join("\n");
  const hash = createHash("sha256");
  hash.update(joined);
  return hash.digest("hex");
}

async function hashFiles(rootPath: string, files: string[]): Promise<string> {
  const hash = createHash("sha256");
  const sorted = [...files].sort();
  for (const file of sorted) {
    const fullPath = join(rootPath, file);
    const data = await readFile(fullPath);
    hash.update(file);
    hash.update("\0");
    hash.update(data);
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function computeDependencySignature(rootPath: string): Promise<DependencySignature> {
  const lockfiles = LOCKFILES.filter((file) => existsSync(join(rootPath, file)));
  if (lockfiles.length > 0) {
    return {
      signature: await hashFiles(rootPath, lockfiles),
      source: "lockfile",
      files: lockfiles,
    };
  }

  const manifests = MANIFESTS.filter((file) => existsSync(join(rootPath, file)));
  if (manifests.length > 0) {
    return {
      signature: await hashFiles(rootPath, manifests),
      source: "manifest",
      files: manifests,
    };
  }

  return { signature: "none", source: "none", files: [] };
}

export async function readSetupState(markerPath: string): Promise<SetupState | null> {
  try {
    const raw = await readFile(markerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<SetupState>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== SETUP_STATE_VERSION) return null;
    if (typeof parsed.commandsHash !== "string") return null;
    if (typeof parsed.lockfileSignature !== "string") return null;
    if (typeof parsed.completedAt !== "string") return null;
    return {
      version: parsed.version,
      commandsHash: parsed.commandsHash,
      lockfileSignature: parsed.lockfileSignature,
      completedAt: parsed.completedAt,
    };
  } catch {
    return null;
  }
}

export async function writeSetupState(markerPath: string, state: SetupState): Promise<void> {
  await mkdir(dirname(markerPath), { recursive: true });
  const tempPath = `${markerPath}.tmp-${randomUUID()}`;
  await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
  await rm(markerPath, { force: true });
  await rename(tempPath, markerPath);
}

export async function computeSetupPlan(params: {
  worktreePath: string;
  commands: string[];
}): Promise<SetupPlan> {
  const normalized = normalizeCommands(params.commands);
  const { markerPath, lockPath } = getSetupPaths(params.worktreePath);
  const commandsHash = computeCommandsHash(normalized);

  if (normalized.length === 0) {
    return {
      action: "skip",
      commandsHash,
      preLockfileSignature: "none",
      markerPath,
      lockPath,
      skipReason: "no setup commands configured",
    };
  }

  const signature = await computeDependencySignature(params.worktreePath);
  const existing = await readSetupState(markerPath);
  if (existing && existing.commandsHash === commandsHash && existing.lockfileSignature === signature.signature) {
    return {
      action: "skip",
      commandsHash,
      preLockfileSignature: signature.signature,
      markerPath,
      lockPath,
      skipReason: "setup state matches current commands and signature",
    };
  }

  return {
    action: "run",
    commandsHash,
    preLockfileSignature: signature.signature,
    markerPath,
    lockPath,
  };
}

type LockHandle = {
  lockPath: string;
  heartbeatPath: string;
  ownerPath: string;
  release: () => Promise<void>;
  touchHeartbeat: () => Promise<void>;
};

async function readHeartbeat(heartbeatPath: string): Promise<number | null> {
  try {
    const raw = await readFile(heartbeatPath, "utf8");
    const value = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function acquireSetupLockOnce(lockPath: string, staleMs: number): Promise<LockHandle | null> {
  try {
    await mkdir(lockPath, { recursive: false });
  } catch (err: any) {
    if (err?.code !== "EEXIST") throw err;

    const heartbeatPath = join(lockPath, "heartbeat");
    const ownerPath = join(lockPath, "owner.json");
    const heartbeat = await readHeartbeat(heartbeatPath);

    let isStale = false;
    if (heartbeat) {
      isStale = Date.now() - heartbeat > staleMs;
    } else {
      try {
        const stats = await stat(lockPath);
        isStale = Date.now() - stats.mtimeMs > staleMs;
      } catch {
        isStale = false;
      }
    }

    if (!isStale) return null;

    await rm(lockPath, { recursive: true, force: true });
    try {
      await mkdir(lockPath, { recursive: false });
    } catch (retryErr: any) {
      if (retryErr?.code === "EEXIST") return null;
      throw retryErr;
    }

    const release = async () => {
      await rm(lockPath, { recursive: true, force: true });
    };

    const touchHeartbeat = async () => {
      await writeFile(heartbeatPath, String(Date.now()), "utf8");
    };

    await writeFile(
      ownerPath,
      JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
      "utf8"
    );
    await touchHeartbeat();
    return { lockPath, heartbeatPath, ownerPath, release, touchHeartbeat };
  }

  const heartbeatPath = join(lockPath, "heartbeat");
  const ownerPath = join(lockPath, "owner.json");

  const release = async () => {
    await rm(lockPath, { recursive: true, force: true });
  };

  const touchHeartbeat = async () => {
    await writeFile(heartbeatPath, String(Date.now()), "utf8");
  };

  await writeFile(
    ownerPath,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
  await touchHeartbeat();
  return { lockPath, heartbeatPath, ownerPath, release, touchHeartbeat };
}

async function acquireSetupLock(lockPath: string, waitTimeoutMs: number, staleMs: number): Promise<LockHandle | null> {
  const start = Date.now();
  while (Date.now() - start < waitTimeoutMs) {
    const handle = await acquireSetupLockOnce(lockPath, staleMs);
    if (handle) return handle;
    await sleep(2000);
  }
  return null;
}

function getShellCommand(): { shell: string; args: string[] } {
  const candidates = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"];
  const bashPath = candidates.find((candidate) => existsSync(candidate));
  if (bashPath) return { shell: bashPath, args: ["-c"] };
  const shPath = existsSync("/bin/sh") ? "/bin/sh" : "sh";
  return { shell: shPath, args: ["-c"] };
}

function buildSetupEnv(): Record<string, string> {
  const keep = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP"];
  const env: Record<string, string> = {
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    npm_config_yes: "true",
  };
  for (const key of keep) {
    const value = process.env[key];
    if (typeof value === "string") env[key] = value;
  }
  if (!env.PATH) env.PATH = process.env.PATH ?? "";
  return env;
}

async function runSetupCommand(params: {
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
  const env = buildSetupEnv();
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

async function appendSetupLog(path: string | undefined, lines: string[]): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${lines.join("\n")}\n`, "utf8");
  } catch {
    // ignore
  }
}

export async function ensureWorktreeSetup(params: {
  worktreePath: string;
  commands: string[];
  runLogPath?: string;
  totalTimeoutMs?: number;
  perCommandTimeoutMs?: number;
  lockWaitTimeoutMs?: number;
  lockStaleMs?: number;
}): Promise<SetupResult> {
  const normalized = normalizeCommands(params.commands);
  const { markerPath, lockPath, ralphDir } = getSetupPaths(params.worktreePath);
  const commandsHash = computeCommandsHash(normalized);

  if (normalized.length === 0) {
    return {
      ok: true,
      skipped: true,
      commandsHash,
      lockfileSignature: "none",
      skipReason: "no setup commands configured",
    };
  }

  await mkdir(ralphDir, { recursive: true });
  const plan = await computeSetupPlan({ worktreePath: params.worktreePath, commands: normalized });
  if (plan.action === "skip") {
    await appendSetupLog(params.runLogPath, [`[setup] Skip: ${plan.skipReason ?? "no reason"}`]);
    return {
      ok: true,
      skipped: true,
      commandsHash: plan.commandsHash,
      lockfileSignature: plan.preLockfileSignature,
      skipReason: plan.skipReason,
    };
  }

  const totalTimeoutMs = params.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
  const perCommandTimeoutMs = params.perCommandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const lockWaitTimeoutMs = params.lockWaitTimeoutMs ?? DEFAULT_LOCK_WAIT_TIMEOUT_MS;
  const lockStaleMs = params.lockStaleMs ?? DEFAULT_LOCK_STALE_MS;

  const lock = await acquireSetupLock(lockPath, lockWaitTimeoutMs, lockStaleMs);
  if (!lock) {
    return {
      ok: false,
      skipped: false,
      commandsHash: plan.commandsHash,
      lockfileSignature: plan.preLockfileSignature,
      failure: {
        command: "",
        commandIndex: 0,
        totalCommands: normalized.length,
        exitCode: null,
        signal: null,
        timedOut: false,
        durationMs: 0,
        outputTail: "",
        reason: "setup lock held too long; could not acquire",
      },
    };
  }

  const overallStart = Date.now();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await appendSetupLog(params.runLogPath, [
      `[setup] Running ${normalized.length} command(s)`,
      `[setup] Commands hash: ${plan.commandsHash}`,
    ]);

    await lock.touchHeartbeat();
    heartbeatTimer = setInterval(() => {
      void lock.touchHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);

    for (let i = 0; i < normalized.length; i += 1) {
      const command = normalized[i];
      const elapsed = Date.now() - overallStart;
      if (elapsed > totalTimeoutMs) {
        return {
          ok: false,
          skipped: false,
          commandsHash: plan.commandsHash,
          lockfileSignature: plan.preLockfileSignature,
          failure: {
            command,
            commandIndex: i + 1,
            totalCommands: normalized.length,
            exitCode: null,
            signal: null,
            timedOut: true,
            durationMs: elapsed,
            outputTail: "",
            reason: "setup exceeded total timeout",
          },
        };
      }

      await appendSetupLog(params.runLogPath, [`[setup] Command ${i + 1}/${normalized.length}: ${command}`]);
      await lock.touchHeartbeat();

      const remaining = Math.max(5000, totalTimeoutMs - elapsed);
      const timeout = Math.min(perCommandTimeoutMs, remaining);
      const result = await runSetupCommand({ command, cwd: params.worktreePath, timeoutMs: timeout });

      if (result.timedOut || result.exitCode !== 0) {
        await appendSetupLog(params.runLogPath, [
          `[setup] Command failed (exit=${result.exitCode ?? "null"} signal=${result.signal ?? "none"} timedOut=${
            result.timedOut
          })`,
          result.outputTail ? `[setup] Output tail:\n${result.outputTail}` : "",
        ].filter(Boolean));
        return {
          ok: false,
          skipped: false,
          commandsHash: plan.commandsHash,
          lockfileSignature: plan.preLockfileSignature,
          failure: {
            command,
            commandIndex: i + 1,
            totalCommands: normalized.length,
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            outputTail: result.outputTail,
            reason: result.timedOut ? "setup command timed out" : "setup command failed",
          },
        };
      }
    }

    const postSignature = await computeDependencySignature(params.worktreePath);
    await writeSetupState(markerPath, {
      version: SETUP_STATE_VERSION,
      commandsHash: plan.commandsHash,
      lockfileSignature: postSignature.signature,
      completedAt: new Date().toISOString(),
    });

    await appendSetupLog(params.runLogPath, [
      `[setup] Completed successfully (signature=${postSignature.signature})`,
    ]);

    return {
      ok: true,
      skipped: false,
      commandsHash: plan.commandsHash,
      lockfileSignature: postSignature.signature,
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await lock.release();
  }
}
