import { existsSync, lstatSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { getConfig } from "../../config";
import { resolveDaemonRecordPath } from "../../daemon-record";
import type { DoctorLiveness, DoctorObservedRecord } from "./types";

function resolveTmpStateDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : "unknown";
  return join("/tmp", "ralph", String(uid));
}

function resolveHomeDirFallback(): string | undefined {
  const homeEnv = process.env.HOME?.trim();
  if (homeEnv) return homeEnv;
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

function getCanonicalRoot(rootOverride?: string): string {
  if (rootOverride?.trim()) return resolve(rootOverride.trim());
  return dirname(resolveDaemonRecordPath());
}

function assertSafeDir(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${path}`);
  if (stat.isSymbolicLink()) throw new Error(`Directory is symlink: ${path}`);
}

function toRootPath(value: string): string {
  return resolve(value.trim());
}

function probePidLiveness(pid: number): DoctorLiveness {
  if (!Number.isFinite(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error: any) {
    const code = String(error?.code ?? "").toUpperCase();
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "unknown";
    return "unknown";
  }
}

function parseDaemonPayload(path: string, root: string, raw: string): DoctorObservedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return {
      kind: "daemon.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: error?.message ?? String(error),
      payloadText: raw,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "daemon.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: "Expected JSON object",
      payloadText: raw,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const daemonId = typeof obj.daemonId === "string" ? obj.daemonId : null;
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? obj.pid : null;
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : null;
  const ralphVersion = typeof obj.ralphVersion === "string" ? obj.ralphVersion : null;
  const command = Array.isArray(obj.command) ? obj.command.filter((item) => typeof item === "string") : null;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : null;
  const controlFilePath = typeof obj.controlFilePath === "string" ? obj.controlFilePath : null;

  if (!daemonId || pid === null || !startedAt || !command || command.length === 0 || !cwd || !controlFilePath) {
    return {
      kind: "daemon.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: "Missing required daemon record fields",
      payloadText: raw,
    };
  }

  const liveness = probePidLiveness(pid);
  return {
    kind: "daemon.json",
    path,
    root,
    exists: true,
    isReadable: true,
    status: liveness === "alive" ? "live" : "stale",
    payloadText: raw,
    daemon: {
      daemonId,
      pid,
      startedAt,
      ralphVersion,
      command,
      cwd,
      controlFilePath,
      liveness,
    },
  };
}

function parseControlPayload(path: string, root: string, raw: string): DoctorObservedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return {
      kind: "control.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: error?.message ?? String(error),
      payloadText: raw,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      kind: "control.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: "Expected JSON object",
      payloadText: raw,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const mode = obj.mode;
  if (mode !== "running" && mode !== "draining" && mode !== "paused") {
    return {
      kind: "control.json",
      path,
      root,
      exists: true,
      isReadable: true,
      status: "invalid",
      parseError: "Invalid mode",
      payloadText: raw,
    };
  }

  return {
    kind: "control.json",
    path,
    root,
    exists: true,
    isReadable: true,
    status: "live",
    payloadText: raw,
    control: {
      mode,
      pauseRequested: typeof obj.pause_requested === "boolean" ? obj.pause_requested : undefined,
      pauseAtCheckpoint: typeof obj.pause_at_checkpoint === "string" ? obj.pause_at_checkpoint : undefined,
      drainTimeoutMs:
        typeof obj.drain_timeout_ms === "number" && Number.isFinite(obj.drain_timeout_ms)
          ? obj.drain_timeout_ms
          : undefined,
    },
  };
}

function readObservedRecord(kind: "daemon.json" | "control.json", path: string, root: string): DoctorObservedRecord {
  if (!existsSync(path)) {
    return {
      kind,
      path,
      root,
      exists: false,
      isReadable: false,
      status: "missing",
    };
  }

  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      return {
        kind,
        path,
        root,
        exists: true,
        isReadable: false,
        status: "unreadable",
        parseError: "File is symlink",
      };
    }
    if (!stat.isFile()) {
      return {
        kind,
        path,
        root,
        exists: true,
        isReadable: false,
        status: "unreadable",
        parseError: "Not a regular file",
      };
    }

    const raw = readFileSync(path, "utf8");
    const parsed = kind === "daemon.json" ? parseDaemonPayload(path, root, raw) : parseControlPayload(path, root, raw);
    parsed.mtimeMs = stat.mtimeMs;
    parsed.size = stat.size;
    return parsed;
  } catch (error: any) {
    return {
      kind,
      path,
      root,
      exists: true,
      isReadable: false,
      status: "unreadable",
      parseError: error?.message ?? String(error),
    };
  }
}

export type DoctorCollectedState = {
  canonicalRoot: string;
  searchedRoots: string[];
  records: DoctorObservedRecord[];
  warnings: string[];
};

export function collectDoctorState(opts?: { rootOverride?: string }): DoctorCollectedState {
  const warnings: string[] = [];
  const canonicalRoot = getCanonicalRoot(opts?.rootOverride);
  try {
    assertSafeDir(canonicalRoot);
  } catch (error: any) {
    throw new Error(`Invalid canonical root ${canonicalRoot}: ${error?.message ?? String(error)}`);
  }

  const roots = new Set<string>();
  roots.add(canonicalRoot);

  const ambient = process.env.XDG_STATE_HOME?.trim();
  if (ambient) roots.add(toRootPath(join(ambient, "ralph")));

  const home = resolveHomeDirFallback();
  if (home) roots.add(toRootPath(join(home, ".local", "state", "ralph")));

  roots.add(toRootPath(resolveTmpStateDir()));

  try {
    const config = getConfig();
    const profiles = config.opencode?.profiles ?? {};
    for (const profile of Object.values(profiles)) {
      const stateHome = profile?.xdgStateHome?.trim();
      if (!stateHome) continue;
      roots.add(toRootPath(join(stateHome, "ralph")));
    }
  } catch (error: any) {
    warnings.push(`Failed to load config profiles: ${error?.message ?? String(error)}`);
  }

  const searchedRoots = [...roots].sort((a, b) => a.localeCompare(b));
  const records: DoctorObservedRecord[] = [];

  for (const root of searchedRoots) {
    try {
      assertSafeDir(root);
    } catch (error: any) {
      warnings.push(`Skipping unsafe root ${root}: ${error?.message ?? String(error)}`);
      continue;
    }

    const daemonPath = join(root, "daemon.json");
    const controlPath = join(root, "control.json");
    records.push(readObservedRecord("daemon.json", daemonPath, root));
    records.push(readObservedRecord("control.json", controlPath, root));
  }

  const canonicalDaemonPath = join(canonicalRoot, "daemon.json");
  const canonicalDaemon = records.find((record) => record.kind === "daemon.json" && record.path === canonicalDaemonPath);
  records.push({
    kind: "registry",
    path: canonicalDaemonPath,
    root: canonicalRoot,
    exists: Boolean(canonicalDaemon?.exists),
    isReadable: Boolean(canonicalDaemon?.isReadable),
    status: canonicalDaemon?.status ?? "missing",
    parseError: canonicalDaemon?.parseError,
    payloadText: canonicalDaemon?.payloadText,
    mtimeMs: canonicalDaemon?.mtimeMs,
    size: canonicalDaemon?.size,
    daemon: canonicalDaemon?.daemon,
  });

  return {
    canonicalRoot,
    searchedRoots,
    records,
    warnings,
  };
}
