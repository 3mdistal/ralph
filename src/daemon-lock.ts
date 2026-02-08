import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { resolveDaemonLockDirPath, resolveDaemonLockOwnerPath } from "./control-plane-paths";

const LOCK_OWNER_VERSION = 1;
const ALREADY_RUNNING_EXIT_CODE = 2;
const OWNER_READ_RETRIES = 4;
const OWNER_READ_RETRY_DELAY_MS = 30;

type LockOwner = {
  version: 1;
  daemonId: string;
  pid: number;
  startedAt: string;
  startIdentity: string | null;
};

type ProbeResult<T> =
  | { status: "ok"; value: T }
  | { status: "unavailable" };

type HealthState =
  | { state: "healthy"; owner: LockOwner }
  | { state: "stale"; owner: LockOwner }
  | { state: "unknown"; owner: LockOwner | null };

export type DaemonStartupLock = {
  lockDirPath: string;
  ownerPath: string;
  release: () => void;
};

export type AcquireDaemonStartupLockResult =
  | { ok: true; lock: DaemonStartupLock }
  | {
      ok: false;
      exitCode: number;
      lockDirPath: string;
      ownerPath: string;
      owner: LockOwner | null;
      message: string;
    };

export async function acquireDaemonStartupLock(opts: {
  daemonId: string;
  startedAt: string;
  homeDir?: string;
  pid?: number;
  processKill?: typeof process.kill;
  readStartIdentity?: (pid: number) => ProbeResult<string>;
  readCmdline?: (pid: number) => ProbeResult<string>;
  retryDelayMs?: number;
}): Promise<AcquireDaemonStartupLockResult> {
  const lockDirPath = resolveDaemonLockDirPath({ homeDir: opts.homeDir });
  const ownerPath = resolveDaemonLockOwnerPath({ homeDir: opts.homeDir });
  const pid = opts.pid ?? process.pid;
  const processKill = opts.processKill ?? process.kill;
  const readStartIdentity = opts.readStartIdentity ?? readLinuxProcStartIdentity;
  const readCmdline = opts.readCmdline ?? readLinuxProcCmdline;
  const retryDelayMs = opts.retryDelayMs ?? OWNER_READ_RETRY_DELAY_MS;

  const selfIdentityProbe = readStartIdentity(pid);
  const selfStartIdentity = selfIdentityProbe.status === "ok" ? selfIdentityProbe.value : null;

  const owner: LockOwner = {
    version: LOCK_OWNER_VERSION,
    daemonId: opts.daemonId,
    pid,
    startedAt: opts.startedAt,
    startIdentity: selfStartIdentity,
  };

  const release = (): void => {
    rmSync(lockDirPath, { recursive: true, force: true });
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(dirname(lockDirPath), { recursive: true, mode: 0o700 });
      mkdirSync(lockDirPath, { recursive: false, mode: 0o700 });
      writeOwner(ownerPath, owner);
      return {
        ok: true,
        lock: {
          lockDirPath,
          ownerPath,
          release,
        },
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
    }

    const currentOwner = await readOwnerWithRetry(ownerPath, retryDelayMs);
    const health = evaluateHealth(currentOwner, { processKill, readStartIdentity, readCmdline });

    if (health.state === "stale") {
      rmSync(lockDirPath, { recursive: true, force: true });
      continue;
    }

    const refusalOwner = health.owner;
    const pidText = refusalOwner?.pid ?? "unknown";
    const startedAtText = refusalOwner?.startedAt ?? "unknown";
    const message =
      `Another Ralph daemon is already running for this control root (pid=${pidText}, startedAt=${startedAtText}, lockRecord=${ownerPath}). ` +
      "Use `ralphctl status` to inspect it or `ralphctl drain` before restarting; refusing to start a second daemon.";

    return {
      ok: false,
      exitCode: ALREADY_RUNNING_EXIT_CODE,
      lockDirPath,
      ownerPath,
      owner: refusalOwner,
      message,
    };
  }

  const fallbackOwner = await readOwnerWithRetry(ownerPath, retryDelayMs);
  return {
    ok: false,
    exitCode: ALREADY_RUNNING_EXIT_CODE,
    lockDirPath,
    ownerPath,
    owner: fallbackOwner,
    message:
      `Another Ralph daemon is already running for this control root (pid=${fallbackOwner?.pid ?? "unknown"}, startedAt=${fallbackOwner?.startedAt ?? "unknown"}, lockRecord=${ownerPath}). ` +
      "Use `ralphctl status` to inspect it or `ralphctl drain` before restarting; refusing to start a second daemon.",
  };
}

function isPidAlive(pid: number, processKill: typeof process.kill): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    processKill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function evaluateHealth(
  owner: LockOwner | null,
  deps: {
    processKill: typeof process.kill;
    readStartIdentity: (pid: number) => ProbeResult<string>;
    readCmdline: (pid: number) => ProbeResult<string>;
  }
): HealthState {
  if (!owner) return { state: "unknown", owner: null };
  if (!isPidAlive(owner.pid, deps.processKill)) return { state: "stale", owner };

  const startIdentity = deps.readStartIdentity(owner.pid);
  if (startIdentity.status !== "ok") {
    return { state: "unknown", owner };
  }

  if (!owner.startIdentity) {
    return { state: "unknown", owner };
  }

  if (owner.startIdentity !== startIdentity.value) {
    return { state: "stale", owner };
  }

  const cmdline = deps.readCmdline(owner.pid);
  if (cmdline.status === "ok") {
    const normalized = cmdline.value.toLowerCase();
    if (!normalized.includes("ralph") && !normalized.includes("daemon")) {
      return { state: "unknown", owner };
    }
  }

  return { state: "healthy", owner };
}

function writeOwner(path: string, owner: LockOwner): void {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}

async function readOwnerWithRetry(path: string, retryDelayMs: number): Promise<LockOwner | null> {
  for (let attempt = 0; attempt < OWNER_READ_RETRIES; attempt += 1) {
    const owner = tryReadOwner(path);
    if (owner) return owner;
    if (!existsSync(path) && attempt < OWNER_READ_RETRIES - 1) {
      await sleep(retryDelayMs);
      continue;
    }
    if (attempt < OWNER_READ_RETRIES - 1) {
      await sleep(retryDelayMs);
    }
  }
  return tryReadOwner(path);
}

function tryReadOwner(path: string): LockOwner | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== LOCK_OWNER_VERSION) return null;
    if (typeof obj.daemonId !== "string" || !obj.daemonId.trim()) return null;
    if (typeof obj.pid !== "number" || !Number.isFinite(obj.pid) || obj.pid <= 0) return null;
    if (typeof obj.startedAt !== "string" || !obj.startedAt.trim()) return null;

    return {
      version: LOCK_OWNER_VERSION,
      daemonId: obj.daemonId,
      pid: obj.pid,
      startedAt: obj.startedAt,
      startIdentity: typeof obj.startIdentity === "string" && obj.startIdentity.trim() ? obj.startIdentity : null,
    };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLinuxProcStartIdentity(pid: number): ProbeResult<string> {
  if (process.platform !== "linux") return { status: "unavailable" };
  try {
    const statRaw = readFileSync(join("/proc", String(pid), "stat"), "utf8").trim();
    const closeParen = statRaw.lastIndexOf(")");
    if (closeParen <= 0 || closeParen + 2 >= statRaw.length) return { status: "unavailable" };
    const fields = statRaw.slice(closeParen + 2).trim().split(/\s+/);
    const procStartTime = fields[19];
    if (!procStartTime) return { status: "unavailable" };
    return { status: "ok", value: procStartTime };
  } catch {
    return { status: "unavailable" };
  }
}

function readLinuxProcCmdline(pid: number): ProbeResult<string> {
  if (process.platform !== "linux") return { status: "unavailable" };
  try {
    const raw = readFileSync(join("/proc", String(pid), "cmdline"), "utf8");
    if (!raw) return { status: "unavailable" };
    const cmdline = raw.replace(/\u0000/g, " ").trim();
    if (!cmdline) return { status: "unavailable" };
    return { status: "ok", value: cmdline };
  } catch {
    return { status: "unavailable" };
  }
}
