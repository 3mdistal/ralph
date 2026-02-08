import { homedir } from "os";
import { isAbsolute, join } from "path";

function resolveHomeDir(): string {
  const raw = process.env.HOME?.trim();
  return raw ? raw : homedir();
}

function normalizePathSegment(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[\/]/g, "__")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
}

export function getRalphHomeDir(): string {
  return join(resolveHomeDir(), ".ralph");
}

function getRalphArtifactsDir(): string {
  return join(getRalphHomeDir(), "artifacts");
}

export function getRalphRunArtifactsDir(runId: string): string {
  return join(getRalphArtifactsDir(), runId);
}

function getRalphSandboxDir(): string {
  return join(getRalphHomeDir(), "sandbox");
}

export function getRalphSandboxManifestsDir(): string {
  return join(getRalphSandboxDir(), "manifests");
}

export function getRalphSandboxManifestPath(runId: string): string {
  return join(getRalphSandboxManifestsDir(), `${runId}.json`);
}

export function getRalphEventsDir(): string {
  return join(getRalphHomeDir(), "events");
}

export function getRalphConfigTomlPath(): string {
  return join(getRalphHomeDir(), "config.toml");
}

export function getRalphConfigJsonPath(): string {
  return join(getRalphHomeDir(), "config.json");
}

export function getRalphOpencodeConfigDir(): string {
  return join(getRalphHomeDir(), "opencode");
}

export function getRalphGhConfigDir(): string {
  return join(getRalphHomeDir(), "gh");
}

export function getRalphLegacyConfigPath(): string {
  return join(resolveHomeDir(), ".config", "opencode", "ralph", "ralph.json");
}

export function getRalphStateDbPath(): string {
  const raw = process.env.RALPH_STATE_DB_PATH?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(getRalphHomeDir(), "state.sqlite");
}

function getRalphSessionsDir(): string {
  const raw = process.env.RALPH_SESSIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(getRalphHomeDir(), "sessions");
}

export function getRalphWorktreesDir(): string {
  const raw = process.env.RALPH_WORKTREES_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(getRalphHomeDir(), "worktrees");
}

function getRalphStateDir(): string {
  const raw = process.env.XDG_STATE_HOME?.trim();
  const stateHome = raw ? raw : join(resolveHomeDir(), ".local", "state");
  return join(stateHome, "ralph");
}

function getRalphRunLogsDir(): string {
  return join(getRalphStateDir(), "run-logs");
}

export function getRalphRunLogPath(opts: {
  repo: string;
  issueNumber?: string;
  stepTitle?: string;
  ts?: number;
}): string {
  const repo = normalizePathSegment(opts.repo);
  const issue = normalizePathSegment(opts.issueNumber ?? "unknown-issue");
  const step = normalizePathSegment(opts.stepTitle ?? "run");
  const ts = typeof opts.ts === "number" ? opts.ts : Date.now();
  return join(getRalphRunLogsDir(), repo, issue, `${step}-${ts}.log`);
}

export function getRalphSessionDir(sessionId: string): string {
  return join(getRalphSessionsDir(), sessionId);
}

// Back-compat for bot/integration helpers
export function getSessionDir(sessionId: string): string {
  return getRalphSessionDir(sessionId);
}

export function getSessionEventsPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "events.jsonl");
}

export function getSessionEventsPathFromDir(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId, "events.jsonl");
}

export function getRalphSessionLockPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "active.lock");
}

export function getRalphSessionNudgesPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "nudges.jsonl");
}

export function getRalphEventsDayLogPath(day: string, eventsDir?: string): string {
  const baseDir = eventsDir ?? getRalphEventsDir();
  return join(baseDir, `${day}.jsonl`);
}
