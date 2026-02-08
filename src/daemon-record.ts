import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname } from "path";
import {
  resolveCanonicalControlRoot,
  resolveCanonicalDaemonLockPath,
  resolveCanonicalDaemonRegistryPath,
  resolveCanonicalRegistryLockPath,
  resolveLegacyDaemonRecordCandidates,
  resolveLegacyDaemonRecordPath,
} from "./control-root";

export type DaemonRecord = {
  version: 1;
  daemonId: string;
  pid: number;
  startedAt: string;
  heartbeatAt?: string;
  ralphVersion: string | null;
  command: string[];
  cwd: string;
  controlRoot?: string;
  controlFilePath: string;
};

const DAEMON_RECORD_VERSION = 1;
const WRITE_LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 60_000;
export const DAEMON_HEARTBEAT_INTERVAL_MS = 5_000;
export const DAEMON_HEARTBEAT_TTL_MS = 20_000;

type LockHandle = {
  path: string;
  fd: number;
};

function sleepSpin(deadlineMs: number): void {
  while (Date.now() < deadlineMs) {
    // busy wait for very short lock contention windows
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ensureParentDir(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function assertSafeRegularFile(path: string, dirMessage: string, fileMessage: string): void {
  const dir = dirname(path);
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`${dirMessage}: ${dir}`);
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(`${dirMessage} is a symlink: ${dir}`);
  }

  const fileStat = lstatSync(path);
  if (!fileStat.isFile()) {
    throw new Error(`${fileMessage}: ${path}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`${fileMessage} is a symlink: ${path}`);
  }
}

function parseLockOwner(path: string): { pid: number | null; acquiredAtMs: number | null } {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const pid = typeof parsed.pid === "number" && Number.isFinite(parsed.pid) ? parsed.pid : null;
    const acquiredAtMs = typeof parsed.acquiredAtMs === "number" && Number.isFinite(parsed.acquiredAtMs) ? parsed.acquiredAtMs : null;
    return { pid, acquiredAtMs };
  } catch {
    return { pid: null, acquiredAtMs: null };
  }
}

function tryReapStaleLock(path: string): boolean {
  if (!existsSync(path)) return true;
  const owner = parseLockOwner(path);
  const staleByPid = owner.pid !== null && !isPidAlive(owner.pid);
  const staleByAge = owner.acquiredAtMs !== null && Date.now() - owner.acquiredAtMs > LOCK_STALE_MS;
  if (!staleByPid && !staleByAge) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(path: string, opts?: { timeoutMs?: number }): LockHandle {
  ensureParentDir(path);
  const timeoutMs = opts?.timeoutMs ?? WRITE_LOCK_WAIT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAtMs: Date.now() })}\n`, { encoding: "utf8" });
      return { path, fd };
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
      const reaped = tryReapStaleLock(path);
      if (reaped) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring lock: ${path}`);
      sleepSpin(Math.min(deadline, Date.now() + 10));
    }
  }
}

function releaseLock(lock: LockHandle): void {
  try {
    closeSync(lock.fd);
  } catch {
    // ignore
  }
  try {
    unlinkSync(lock.path);
  } catch {
    // ignore
  }
}

function parseRecord(raw: string): DaemonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== DAEMON_RECORD_VERSION) return null;

  const daemonId = typeof obj.daemonId === "string" ? obj.daemonId : null;
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? obj.pid : null;
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : null;
  const heartbeatAt = typeof obj.heartbeatAt === "string" ? obj.heartbeatAt : undefined;
  const ralphVersion = typeof obj.ralphVersion === "string" ? obj.ralphVersion : null;
  const command = Array.isArray(obj.command) ? obj.command.filter((item) => typeof item === "string") : null;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const controlRoot = typeof obj.controlRoot === "string" ? obj.controlRoot : undefined;
  const controlFilePath = typeof obj.controlFilePath === "string" ? obj.controlFilePath : null;

  if (!daemonId || pid === null || !startedAt || !command || command.length === 0 || !cwd || !controlFilePath) return null;

  return {
    version: DAEMON_RECORD_VERSION,
    daemonId,
    pid,
    startedAt,
    heartbeatAt,
    ralphVersion,
    command,
    cwd,
    controlRoot,
    controlFilePath,
  };
}

function parseCanonicalRegistry(raw: string): DaemonRecord | null {
  const parsed = parseRecord(raw);
  if (!parsed) return null;
  if (!parsed.controlRoot || !parsed.heartbeatAt) return null;
  return parsed;
}

function writeAtomicJson(path: string, payload: unknown): void {
  ensureParentDir(path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempPath, path);
}

function readRecordFromPath(path: string, parser: (raw: string) => DaemonRecord | null): DaemonRecord | null {
  if (!existsSync(path)) return null;
  try {
    assertSafeRegularFile(path, "Daemon record directory is not a directory", "Daemon record is not a regular file");
    return parser(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveDaemonRecordPath(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  return resolveLegacyDaemonRecordPath(opts);
}

export function resolveCanonicalDaemonPath(opts?: { homeDir?: string }): string {
  return resolveCanonicalDaemonRegistryPath(opts);
}

export function isDaemonRecordFresh(record: DaemonRecord, nowMs: number = Date.now(), ttlMs: number = DAEMON_HEARTBEAT_TTL_MS): boolean {
  const raw = record.heartbeatAt ?? record.startedAt;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= ttlMs;
}

export function readDaemonRecord(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
}): DaemonRecord | null {
  const canonicalPath = resolveCanonicalDaemonRegistryPath({ homeDir: opts?.homeDir });
  if (existsSync(canonicalPath)) {
    try {
      assertSafeRegularFile(canonicalPath, "Daemon registry directory is not a directory", "Daemon registry is not a regular file");
      const canonical = parseCanonicalRegistry(readFileSync(canonicalPath, "utf8"));
      if (canonical) {
        opts?.log?.(`[ralph] Daemon discovery source=canonical path=${canonicalPath}`);
        return canonical;
      }
      opts?.log?.(`[ralph] Ignoring invalid canonical daemon registry at ${canonicalPath}`);
    } catch (e: any) {
      opts?.log?.(`[ralph] Failed to read canonical daemon registry ${canonicalPath}: ${e?.message ?? String(e)}`);
    }
  }

  const primaryPath = resolveLegacyDaemonRecordPath({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  if (existsSync(primaryPath)) {
    try {
      assertSafeRegularFile(primaryPath, "Daemon record directory is not a directory", "Daemon record is not a regular file");
      const raw = readFileSync(primaryPath, "utf8");
      const record = parseRecord(raw);
      if (record) {
        opts?.log?.(`[ralph] Daemon discovery source=legacy-xdg path=${primaryPath}`);
        return record;
      }
    } catch (e: any) {
      opts?.log?.(`[ralph] Failed to read daemon record ${primaryPath}: ${e?.message ?? String(e)}`);
    }
  }

  const fallbacks = resolveLegacyDaemonRecordCandidates({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome }).filter(
    (p) => p !== primaryPath
  );
  const parsed: DaemonRecord[] = [];

  for (const path of fallbacks) {
    if (!existsSync(path)) continue;
    try {
      assertSafeRegularFile(path, "Daemon record directory is not a directory", "Daemon record is not a regular file");
      const raw = readFileSync(path, "utf8");
      const record = parseRecord(raw);
      if (record) parsed.push(record);
    } catch (e: any) {
      opts?.log?.(`[ralph] Failed to read daemon record ${path}: ${e?.message ?? String(e)}`);
    }
  }

  if (parsed.length === 0) return null;

  const alive = parsed.filter((r) => isPidAlive(r.pid));
  const pool = alive.length > 0 ? alive : parsed;

  pool.sort((a, b) => {
    const aTs = Date.parse(a.heartbeatAt ?? a.startedAt);
    const bTs = Date.parse(b.heartbeatAt ?? b.startedAt);
    if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
    if (Number.isFinite(aTs)) return -1;
    if (Number.isFinite(bTs)) return 1;
    return 0;
  });

  const selected = pool[0] ?? null;
  if (selected) {
    const selectedPath = fallbacks.find((p) => {
      try {
        const raw = readFileSync(p, "utf8");
        const candidate = parseRecord(raw);
        return candidate?.daemonId === selected.daemonId && candidate?.pid === selected.pid;
      } catch {
        return false;
      }
    });
    if (selectedPath?.includes("/tmp/ralph/")) opts?.log?.(`[ralph] Daemon discovery source=legacy-tmp path=${selectedPath}`);
    else if (selectedPath?.includes("/.local/state/ralph/"))
      opts?.log?.(`[ralph] Daemon discovery source=legacy-home path=${selectedPath}`);
    else if (selectedPath) opts?.log?.(`[ralph] Daemon discovery source=legacy-xdg path=${selectedPath}`);
  }

  return selected;
}

function toCanonicalRecord(record: DaemonRecord): DaemonRecord {
  return {
    ...record,
    controlRoot: record.controlRoot ?? resolveCanonicalControlRoot(),
    heartbeatAt: record.heartbeatAt ?? new Date().toISOString(),
  };
}

export function writeDaemonRecord(record: DaemonRecord, opts?: { homeDir?: string; xdgStateHome?: string }): void {
  const canonicalPath = resolveCanonicalDaemonRegistryPath({ homeDir: opts?.homeDir });
  const writeLockPath = resolveCanonicalRegistryLockPath({ homeDir: opts?.homeDir });
  const lock = acquireLock(writeLockPath);
  try {
    writeAtomicJson(canonicalPath, toCanonicalRecord(record));
  } finally {
    releaseLock(lock);
  }

  const legacyPath = resolveLegacyDaemonRecordPath({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  writeAtomicJson(legacyPath, record);
}

export function writeDaemonHeartbeat(record: DaemonRecord, opts?: { homeDir?: string; xdgStateHome?: string }): void {
  writeDaemonRecord({ ...record, heartbeatAt: new Date().toISOString() }, opts);
}

export function removeDaemonRecord(opts?: { homeDir?: string; xdgStateHome?: string }): void {
  const canonicalPath = resolveCanonicalDaemonRegistryPath({ homeDir: opts?.homeDir });
  const writeLockPath = resolveCanonicalRegistryLockPath({ homeDir: opts?.homeDir });
  let lock: LockHandle | null = null;
  try {
    lock = acquireLock(writeLockPath);
    if (existsSync(canonicalPath)) {
      assertSafeRegularFile(canonicalPath, "Daemon registry directory is not a directory", "Daemon registry is not a regular file");
      rmSync(canonicalPath, { force: true });
    }
  } catch {
    try {
      rmSync(canonicalPath, { force: true });
    } catch {
      // ignore
    }
  } finally {
    if (lock) releaseLock(lock);
  }

  const legacyPath = resolveLegacyDaemonRecordPath({ homeDir: opts?.homeDir, xdgStateHome: opts?.xdgStateHome });
  if (!existsSync(legacyPath)) return;
  try {
    assertSafeRegularFile(legacyPath, "Daemon record directory is not a directory", "Daemon record is not a regular file");
    rmSync(legacyPath, { force: true });
  } catch {
    try {
      rmSync(legacyPath, { force: true });
    } catch {
      // ignore
    }
  }
}

export function acquireDaemonLock(opts?: { homeDir?: string }): { release: () => void; path: string } {
  const lockPath = resolveCanonicalDaemonLockPath({ homeDir: opts?.homeDir });
  const lock = acquireLock(lockPath, { timeoutMs: 1_000 });
  return {
    path: lockPath,
    release: () => releaseLock(lock),
  };
}

export function __readDaemonRecordFileForTests(path: string): DaemonRecord | null {
  return readRecordFromPath(path, parseRecord);
}
