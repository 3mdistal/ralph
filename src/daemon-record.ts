import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";
import {
  resolveCanonicalControlFilePath,
  resolveCanonicalControlRoot,
  resolveCanonicalDaemonRegistryPath,
  resolveLegacyDaemonRegistryPathCandidates,
} from "./control-root";

export type DaemonRecord = {
  version: 1;
  daemonId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  controlRoot: string;
  ralphVersion: string | null;
  command: string[];
  cwd: string;
  controlFilePath: string;
};

type DaemonLockPayload = {
  daemonId: string;
  pid: number;
  startedAt: string;
  acquiredAt: string;
  token: string;
};

export type DaemonSingletonLock = {
  path: string;
  token: string;
  release: () => void;
};

const DAEMON_RECORD_VERSION = 1;
const REGISTRY_LOCK_FILE = "daemon-registry.lock";
const DAEMON_LOCK_FILE = "daemon.lock";

export function isPidAlive(pid: number): boolean {
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

function assertSafeRecordFile(path: string): void {
  const dir = dirname(path);
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Daemon record directory is not a directory: ${dir}`);
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(`Daemon record directory is a symlink: ${dir}`);
  }

  const fileStat = lstatSync(path);
  if (!fileStat.isFile()) {
    throw new Error(`Daemon record is not a regular file: ${path}`);
  }
  if (fileStat.isSymbolicLink()) {
    throw new Error(`Daemon record is a symlink: ${path}`);
  }
}

function parseRecord(
  raw: string,
  defaults: { controlRoot: string; controlFilePath: string; cwd: string }
): DaemonRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== DAEMON_RECORD_VERSION) return null;

  const daemonId = typeof obj.daemonId === "string" ? obj.daemonId.trim() : "";
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? obj.pid : null;
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : "";
  const heartbeatAtRaw = typeof obj.heartbeatAt === "string" ? obj.heartbeatAt : "";
  const heartbeatAt = heartbeatAtRaw || startedAt;
  const controlRootRaw = typeof obj.controlRoot === "string" ? obj.controlRoot.trim() : "";
  const controlRoot = controlRootRaw || defaults.controlRoot;
  const ralphVersion = typeof obj.ralphVersion === "string" ? obj.ralphVersion : null;
  const command = Array.isArray(obj.command) ? obj.command.filter((item) => typeof item === "string") : [];
  const cwdRaw = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const cwd = cwdRaw || defaults.cwd;
  const controlFilePathRaw = typeof obj.controlFilePath === "string" ? obj.controlFilePath.trim() : "";
  const controlFilePath = controlFilePathRaw || defaults.controlFilePath;

  if (!daemonId || pid === null || !startedAt || !heartbeatAt || !controlRoot || !controlFilePath) return null;

  return {
    version: DAEMON_RECORD_VERSION,
    daemonId,
    pid,
    startedAt,
    heartbeatAt,
    controlRoot,
    ralphVersion,
    command,
    cwd,
    controlFilePath,
  };
}


export function readDaemonRecordAtPath(path: string, opts?: { homeDir?: string; xdgStateHome?: string; log?: (message: string) => void }): DaemonRecord | null {
  if (!existsSync(path)) return null;
  try {
    assertSafeRecordFile(path);
    const raw = readFileSync(path, "utf8");
    return (
      parseRecord(raw, {
        controlRoot: dirname(path),
        controlFilePath: resolveCanonicalControlFilePath({ homeDir: opts?.homeDir }),
        cwd: process.cwd(),
      }) ?? null
    );
  } catch (e: any) {
    opts?.log?.(`[ralph] Failed to read daemon record ${path}: ${e?.message ?? String(e)}`);
    return null;
  }
}

function chooseBestRecord(records: DaemonRecord[]): DaemonRecord | null {
  if (records.length === 0) return null;
  const alive = records.filter((record) => isPidAlive(record.pid));
  const pool = alive.length > 0 ? alive : records;

  pool.sort((a, b) => {
    const aHeartbeat = Date.parse(a.heartbeatAt);
    const bHeartbeat = Date.parse(b.heartbeatAt);
    if (Number.isFinite(aHeartbeat) && Number.isFinite(bHeartbeat) && aHeartbeat !== bHeartbeat) {
      return bHeartbeat - aHeartbeat;
    }

    const aStarted = Date.parse(a.startedAt);
    const bStarted = Date.parse(b.startedAt);
    if (Number.isFinite(aStarted) && Number.isFinite(bStarted) && aStarted !== bStarted) {
      return bStarted - aStarted;
    }

    return 0;
  });

  return pool[0] ?? null;
}

function buildRegistryLockPath(recordPath: string): string {
  return join(dirname(recordPath), REGISTRY_LOCK_FILE);
}

function buildDaemonLockPath(opts?: { homeDir?: string }): string {
  return join(resolveCanonicalControlRoot({ homeDir: opts?.homeDir }), DAEMON_LOCK_FILE);
}

function writeRecordFile(path: string, record: DaemonRecord): void {
  ensureParentDir(path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(record, null, 2) + "\n";
  writeFileSync(tempPath, payload, { mode: 0o600 });
  renameSync(tempPath, path);
}

function parseDaemonLockPayload(raw: string): DaemonLockPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const daemonId = typeof obj.daemonId === "string" ? obj.daemonId.trim() : "";
  const token = typeof obj.token === "string" ? obj.token.trim() : "";
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? obj.pid : NaN;
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : "";
  const acquiredAt = typeof obj.acquiredAt === "string" ? obj.acquiredAt : "";
  if (!daemonId || !token || !startedAt || !acquiredAt || !Number.isFinite(pid) || pid <= 0) return null;
  return { daemonId, token, pid, startedAt, acquiredAt };
}

function acquireWriteLock(lockPath: string): void {
  ensureParentDir(lockPath);
  const payload = JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() });
  try {
    writeFileSync(lockPath, payload + "\n", { mode: 0o600, flag: "wx" });
    return;
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
  }

  try {
    const existingRaw = readFileSync(lockPath, "utf8");
    const existing = JSON.parse(existingRaw) as { pid?: number };
    if (typeof existing?.pid === "number" && Number.isFinite(existing.pid) && isPidAlive(existing.pid)) {
      throw new Error(`Registry lock is held by pid ${existing.pid}`);
    }
  } catch (error: any) {
    if (error?.message?.startsWith("Registry lock is held by pid ")) throw error;
  }

  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }

  writeFileSync(lockPath, payload + "\n", { mode: 0o600, flag: "wx" });
}

function releaseWriteLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // ignore
  }
}

function withRegistryWriteLock(recordPath: string, fn: () => void): void {
  const lockPath = buildRegistryLockPath(recordPath);
  acquireWriteLock(lockPath);
  try {
    fn();
  } finally {
    releaseWriteLock(lockPath);
  }
}

function normalizeRecord(record: DaemonRecord): DaemonRecord {
  const controlRoot = record.controlRoot?.trim() || resolveCanonicalControlRoot();
  const controlFilePath = record.controlFilePath?.trim() || resolveCanonicalControlFilePath();
  const nowIso = new Date().toISOString();
  return {
    version: DAEMON_RECORD_VERSION,
    daemonId: record.daemonId,
    pid: record.pid,
    startedAt: record.startedAt,
    heartbeatAt: record.heartbeatAt || nowIso,
    controlRoot,
    ralphVersion: record.ralphVersion ?? null,
    command: Array.isArray(record.command) ? record.command.filter((item) => typeof item === "string") : [],
    cwd: record.cwd,
    controlFilePath,
  };
}

export function resolveDaemonRecordPath(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  return resolveCanonicalDaemonRegistryPath({ homeDir: opts?.homeDir });
}

export function resolveDaemonRecordPathCandidates(opts?: { homeDir?: string; xdgStateHome?: string }): string[] {
  const primary = resolveDaemonRecordPath(opts);
  const legacy = resolveLegacyDaemonRegistryPathCandidates(opts);
  return Array.from(new Set([primary, ...legacy]));
}

export function readDaemonRecord(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
}): DaemonRecord | null {
  const candidates = resolveDaemonRecordPathCandidates(opts);
  const primaryPath = candidates[0];
  const parsed: DaemonRecord[] = [];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      assertSafeRecordFile(path);
      const raw = readFileSync(path, "utf8");
      const record = parseRecord(raw, {
        controlRoot: dirname(path),
        controlFilePath: resolveCanonicalControlFilePath({ homeDir: opts?.homeDir }),
        cwd: process.cwd(),
      });
      if (record) parsed.push(record);
      else opts?.log?.(`[ralph] Failed to parse daemon record ${path}: invalid schema`);
    } catch (e: any) {
      opts?.log?.(`[ralph] Failed to read daemon record ${path}: ${e?.message ?? String(e)}`);
    }
    if (path === primaryPath && parsed.length > 0) return parsed[0] ?? null;
  }

  return chooseBestRecord(parsed);
}

export function writeDaemonRecord(
  record: DaemonRecord,
  opts?: { homeDir?: string; xdgStateHome?: string; writeLegacy?: boolean }
): void {
  const normalized = normalizeRecord(record);
  const canonicalPath = resolveDaemonRecordPath(opts);

  withRegistryWriteLock(canonicalPath, () => {
    writeRecordFile(canonicalPath, normalized);
  });

  const shouldWriteLegacy = opts?.writeLegacy ?? true;
  if (!shouldWriteLegacy) return;
  const legacyPath = resolveLegacyDaemonRegistryPathCandidates(opts)[0];
  if (!legacyPath || legacyPath === canonicalPath) return;
  withRegistryWriteLock(legacyPath, () => {
    writeRecordFile(legacyPath, normalized);
  });
}

export function touchDaemonRecordHeartbeat(opts?: { homeDir?: string; xdgStateHome?: string }): void {
  const canonicalPath = resolveDaemonRecordPath(opts);
  const nowIso = new Date().toISOString();
  withRegistryWriteLock(canonicalPath, () => {
    if (!existsSync(canonicalPath)) return;
    assertSafeRecordFile(canonicalPath);
    const raw = readFileSync(canonicalPath, "utf8");
    const current = parseRecord(raw, {
      controlRoot: resolveCanonicalControlRoot({ homeDir: opts?.homeDir }),
      controlFilePath: resolveCanonicalControlFilePath({ homeDir: opts?.homeDir }),
      cwd: process.cwd(),
    });
    if (!current) return;
    writeRecordFile(canonicalPath, {
      ...current,
      heartbeatAt: nowIso,
    });
  });
}

export function removeDaemonRecord(opts?: { homeDir?: string; xdgStateHome?: string; removeLegacy?: boolean }): void {
  const canonicalPath = resolveDaemonRecordPath(opts);
  const removeAt = [canonicalPath];
  if (opts?.removeLegacy ?? true) {
    removeAt.push(...resolveLegacyDaemonRegistryPathCandidates(opts));
  }

  for (const path of Array.from(new Set(removeAt))) {
    if (!existsSync(path)) continue;
    try {
      assertSafeRecordFile(path);
      rmSync(path, { force: true });
    } catch {
      try {
        rmSync(path, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export function acquireDaemonSingletonLock(input: {
  daemonId: string;
  startedAt: string;
  homeDir?: string;
}): DaemonSingletonLock {
  const path = buildDaemonLockPath({ homeDir: input.homeDir });
  ensureParentDir(path);

  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload: DaemonLockPayload = {
    daemonId: input.daemonId,
    pid: process.pid,
    startedAt: input.startedAt,
    acquiredAt: new Date().toISOString(),
    token,
  };

  const attemptWrite = (): void => {
    writeFileSync(path, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  };

  try {
    attemptWrite();
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;

    let existingPid: number | null = null;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = parseDaemonLockPayload(raw);
      existingPid = parsed?.pid ?? null;
    } catch {
      existingPid = null;
    }

    if (existingPid && isPidAlive(existingPid)) {
      throw new Error(`Another daemon already owns ${path} (pid=${existingPid}).`);
    }

    try {
      unlinkSync(path);
    } catch {
      // ignore
    }
    attemptWrite();
  }

  return {
    path,
    token,
    release: () => {
      try {
        const raw = readFileSync(path, "utf8");
        const current = parseDaemonLockPayload(raw);
        if (!current || current.token !== token) return;
      } catch {
        return;
      }
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    },
  };
}
