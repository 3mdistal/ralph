import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import {
  resolveDaemonRecordPath as resolveCanonicalDaemonRecordPath,
  resolveDaemonRecordPathCandidates,
} from "./control-plane-paths";

export type DaemonRecord = {
  version: 1;
  daemonId: string;
  pid: number;
  startedAt: string;
  ralphVersion: string | null;
  command: string[];
  cwd: string;
  controlFilePath: string;
};

const DAEMON_RECORD_VERSION = 1;

export function resolveDaemonRecordPath(opts?: { homeDir?: string; xdgStateHome?: string }): string {
  return resolveCanonicalDaemonRecordPath({ homeDir: opts?.homeDir });
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
  const ralphVersion = typeof obj.ralphVersion === "string" ? obj.ralphVersion : null;
  const command = Array.isArray(obj.command) ? obj.command.filter((item) => typeof item === "string") : null;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const controlFilePath = typeof obj.controlFilePath === "string" ? obj.controlFilePath : null;

  if (!daemonId || pid === null || !startedAt || !command || command.length === 0 || !cwd || !controlFilePath) return null;

  return {
    version: DAEMON_RECORD_VERSION,
    daemonId,
    pid,
    startedAt,
    ralphVersion,
    command,
    cwd,
    controlFilePath,
  };
}

export function readDaemonRecord(opts?: {
  homeDir?: string;
  xdgStateHome?: string;
  log?: (message: string) => void;
}): DaemonRecord | null {
  const primaryPath = resolveDaemonRecordPath(opts);
  if (existsSync(primaryPath)) {
    try {
      assertSafeRecordFile(primaryPath);
      const raw = readFileSync(primaryPath, "utf8");
      const record = parseRecord(raw);
      if (record) return record;
    } catch (e: any) {
      opts?.log?.(`[ralph] Failed to read daemon record ${primaryPath}: ${e?.message ?? String(e)}`);
    }
  }

  const fallbacks = resolveDaemonRecordPathCandidates(opts).filter((p) => p !== primaryPath);
  const parsed: DaemonRecord[] = [];

  for (const path of fallbacks) {
    if (!existsSync(path)) continue;
    try {
      assertSafeRecordFile(path);
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
    const aTs = Date.parse(a.startedAt);
    const bTs = Date.parse(b.startedAt);
    if (Number.isFinite(aTs) && Number.isFinite(bTs)) return bTs - aTs;
    if (Number.isFinite(aTs)) return -1;
    if (Number.isFinite(bTs)) return 1;
    return 0;
  });

  return pool[0] ?? null;
}

export function writeDaemonRecord(record: DaemonRecord, opts?: { homeDir?: string; xdgStateHome?: string }): void {
  const path = resolveDaemonRecordPath(opts);
  ensureParentDir(path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(record, null, 2) + "\n";
  writeFileSync(tempPath, payload, { mode: 0o600 });
  renameSync(tempPath, path);
}

export function removeDaemonRecord(opts?: { homeDir?: string; xdgStateHome?: string }): void {
  const path = resolveDaemonRecordPath(opts);
  if (!existsSync(path)) return;
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
