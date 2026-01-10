import { homedir } from "os";
import { isAbsolute, join } from "path";

export function getRalphSessionsDir(): string {
  const raw = process.env.RALPH_SESSIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(homedir(), ".ralph", "sessions");
}

export const RALPH_SESSIONS_DIR = getRalphSessionsDir();

export function getRalphSessionDir(sessionId: string): string {
  return join(RALPH_SESSIONS_DIR, sessionId);
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
