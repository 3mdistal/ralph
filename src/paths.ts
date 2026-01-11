import { homedir } from "os";
import { isAbsolute, join } from "path";

function normalizePathSegment(value: string): string {
  return String(value ?? "")
    .trim()
    .replace(/[\/]/g, "__")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 80);
}

export function getRalphSessionsDir(): string {
  const raw = process.env.RALPH_SESSIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(homedir(), ".ralph", "sessions");
}

export function getRalphWorktreesDir(): string {
  const raw = process.env.RALPH_WORKTREES_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(homedir(), ".ralph", "worktrees");
}

export function getRalphStateDir(): string {
  const raw = process.env.XDG_STATE_HOME?.trim();
  const stateHome = raw ? raw : join(homedir(), ".local", "state");
  return join(stateHome, "ralph");
}

export function getRalphRunLogsDir(): string {
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

export function getRalphSessionLockPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "active.lock");
}

export function getRalphSessionNudgesPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "nudges.jsonl");
}
