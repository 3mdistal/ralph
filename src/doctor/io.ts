import { existsSync, readFileSync } from "fs";
import { dirname } from "path";
import { resolveCanonicalControlFilePath, resolveLegacyControlFilePathCandidates } from "../control-root";
import { resolveDaemonRecordPath, resolveDaemonRecordPathCandidates } from "../daemon-record";
import type {
  DoctorControlCandidate,
  DoctorControlStateView,
  DoctorDaemonCandidate,
  DoctorDaemonRecordView,
  DoctorIdentityCheck,
  DoctorRootSummary,
  DoctorSnapshot,
} from "./types";

type ProbeDeps = {
  pidAlive: (pid: number) => boolean;
  readProcessCommandLine: (pid: number) => string | null;
};

const DAEMON_RECORD_VERSION = 1;

function dedupe(paths: string[]): string[] {
  return Array.from(new Set(paths));
}

function defaultPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultReadProcessCommandLine(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, "utf8");
    const text = raw.replace(/\0+/g, " ").trim();
    if (text) return text;
  } catch {
    // ignore
  }
  return null;
}

function parseDaemonRecord(raw: string, fallbackRoot: string, fallbackControlPath: string): {
  record: DoctorDaemonRecordView | null;
  error: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return { record: null, error: `invalid JSON: ${error?.message ?? String(error)}` };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { record: null, error: "invalid schema: expected JSON object" };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.version !== DAEMON_RECORD_VERSION) {
    return { record: null, error: `invalid schema: version must be ${DAEMON_RECORD_VERSION}` };
  }

  const daemonId = typeof obj.daemonId === "string" ? obj.daemonId.trim() : "";
  const pid = typeof obj.pid === "number" && Number.isFinite(obj.pid) ? Math.floor(obj.pid) : NaN;
  const startedAt = typeof obj.startedAt === "string" ? obj.startedAt : "";
  const heartbeatAtRaw = typeof obj.heartbeatAt === "string" ? obj.heartbeatAt : "";
  const heartbeatAt = heartbeatAtRaw || startedAt;
  const controlRootRaw = typeof obj.controlRoot === "string" ? obj.controlRoot.trim() : "";
  const controlRoot = controlRootRaw || fallbackRoot;
  const controlFilePathRaw = typeof obj.controlFilePath === "string" ? obj.controlFilePath.trim() : "";
  const controlFilePath = controlFilePathRaw || fallbackControlPath;
  const cwdRaw = typeof obj.cwd === "string" ? obj.cwd.trim() : "";
  const cwd = cwdRaw || process.cwd();
  const command = Array.isArray(obj.command) ? obj.command.filter((token): token is string => typeof token === "string") : [];
  const ralphVersion = typeof obj.ralphVersion === "string" ? obj.ralphVersion : null;

  if (!daemonId || !Number.isFinite(pid) || pid <= 0 || !startedAt || !heartbeatAt || !controlRoot || !controlFilePath) {
    return { record: null, error: "invalid schema: missing required daemon record fields" };
  }

  return {
    record: {
      daemonId,
      pid,
      startedAt,
      heartbeatAt,
      controlRoot,
      controlFilePath,
      cwd,
      command,
      ralphVersion,
    },
    error: null,
  };
}

function verifyIdentity(record: DoctorDaemonRecordView, deps: ProbeDeps): DoctorIdentityCheck {
  const commandLine = deps.readProcessCommandLine(record.pid);
  if (!commandLine) {
    return { ok: false, reason: "unable to read process command line" };
  }

  const haystack = commandLine.toLowerCase();
  const tokens = record.command
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => token.split("/").pop() ?? token)
    .map((token) => token.toLowerCase())
    .slice(0, 3);

  if (tokens.length === 0) return { ok: true, reason: null };
  if (tokens.some((token) => haystack.includes(token))) return { ok: true, reason: null };
  return { ok: false, reason: `pid command mismatch (expected one of: ${tokens.join(", ")}; actual: ${commandLine})` };
}

function parseControlFile(raw: string): { control: DoctorControlStateView | null; error: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: any) {
    return { control: null, error: `invalid JSON: ${error?.message ?? String(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { control: null, error: "invalid schema: expected JSON object" };
  }
  const obj = parsed as Record<string, unknown>;
  const versionRaw = obj.version;
  const version = versionRaw === undefined ? 0 : versionRaw;
  if (version !== 0 && version !== 1) {
    return { control: null, error: `invalid schema: version must be 1 (or omitted legacy 0), got ${JSON.stringify(versionRaw)}` };
  }
  const mode = obj.mode;
  if (mode !== "running" && mode !== "draining" && mode !== "paused") {
    return { control: null, error: `invalid schema: mode must be running|draining|paused, got ${JSON.stringify(mode)}` };
  }

  const pauseRequested = typeof obj.pause_requested === "boolean" ? obj.pause_requested : null;
  const pauseAtCheckpoint = typeof obj.pause_at_checkpoint === "string" && obj.pause_at_checkpoint.trim()
    ? obj.pause_at_checkpoint.trim()
    : null;
  const drainTimeoutMs = typeof obj.drain_timeout_ms === "number" && Number.isFinite(obj.drain_timeout_ms)
    ? Math.max(0, Math.floor(obj.drain_timeout_ms))
    : null;

  return {
    control: {
      mode,
      pause_requested: pauseRequested,
      pause_at_checkpoint: pauseAtCheckpoint,
      drain_timeout_ms: drainTimeoutMs,
    },
    error: null,
  };
}

function scanDaemonCandidates(deps: ProbeDeps): DoctorDaemonCandidate[] {
  const canonicalPath = resolveDaemonRecordPath();
  const paths = dedupe(resolveDaemonRecordPathCandidates());

  return paths.map((path): DoctorDaemonCandidate => {
    const exists = existsSync(path);
    if (!exists) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "missing",
        parse_error: null,
        record: null,
        pid_alive: null,
        identity: null,
      };
    }

    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error: any) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "unreadable",
        parse_error: error?.message ?? String(error),
        record: null,
        pid_alive: null,
        identity: null,
      };
    }

    const parsed = parseDaemonRecord(raw, dirname(path), resolveCanonicalControlFilePath());
    if (!parsed.record) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "unreadable",
        parse_error: parsed.error,
        record: null,
        pid_alive: null,
        identity: null,
      };
    }

    const pidAlive = deps.pidAlive(parsed.record.pid);
    const identity = pidAlive ? verifyIdentity(parsed.record, deps) : null;
    return {
      path,
      root: dirname(path),
      is_canonical: path === canonicalPath,
      exists,
      state: pidAlive ? "live" : "stale",
      parse_error: null,
      record: parsed.record,
      pid_alive: pidAlive,
      identity,
    };
  });
}

function scanControlCandidates(): DoctorControlCandidate[] {
  const canonicalPath = resolveCanonicalControlFilePath();
  const paths = dedupe([canonicalPath, ...resolveLegacyControlFilePathCandidates()]);
  return paths.map((path): DoctorControlCandidate => {
    const exists = existsSync(path);
    if (!exists) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "missing",
        parse_error: null,
        control: null,
      };
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (error: any) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "unreadable",
        parse_error: error?.message ?? String(error),
        control: null,
      };
    }
    const parsed = parseControlFile(raw);
    if (!parsed.control) {
      return {
        path,
        root: dirname(path),
        is_canonical: path === canonicalPath,
        exists,
        state: "unreadable",
        parse_error: parsed.error,
        control: null,
      };
    }
    return {
      path,
      root: dirname(path),
      is_canonical: path === canonicalPath,
      exists,
      state: "readable",
      parse_error: null,
      control: parsed.control,
    };
  });
}

function summarizeRoots(daemonCandidates: DoctorDaemonCandidate[], controlCandidates: DoctorControlCandidate[]): DoctorRootSummary[] {
  const roots = new Set<string>();
  for (const candidate of daemonCandidates) roots.add(candidate.root);
  for (const candidate of controlCandidates) roots.add(candidate.root);

  return Array.from(roots)
    .sort((a, b) => a.localeCompare(b))
    .map((root) => {
      const daemonPaths = daemonCandidates.filter((entry) => entry.root === root).map((entry) => entry.path);
      const controlPaths = controlCandidates.filter((entry) => entry.root === root).map((entry) => entry.path);
      return {
        root,
        daemon_record_paths: daemonPaths,
        daemon_records_present: daemonCandidates.filter((entry) => entry.root === root && entry.exists).length,
        control_file_paths: controlPaths,
        control_files_present: controlCandidates.filter((entry) => entry.root === root && entry.exists).length,
      };
    });
}

export function collectDoctorSnapshot(input?: {
  pidAlive?: (pid: number) => boolean;
  readProcessCommandLine?: (pid: number) => string | null;
}): DoctorSnapshot {
  const deps: ProbeDeps = {
    pidAlive: input?.pidAlive ?? defaultPidAlive,
    readProcessCommandLine: input?.readProcessCommandLine ?? defaultReadProcessCommandLine,
  };
  const daemonCandidates = scanDaemonCandidates(deps);
  const controlCandidates = scanControlCandidates();
  return {
    daemonCandidates,
    controlCandidates,
    roots: summarizeRoots(daemonCandidates, controlCandidates),
  };
}
