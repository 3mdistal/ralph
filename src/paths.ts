import { homedir } from "os";
import { isAbsolute, join } from "path";

export function getRalphSessionsDir(): string {
  const raw = process.env.RALPH_SESSIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(homedir(), ".ralph", "sessions");
}

export function getRalphSessionDir(sessionId: string): string {
  return join(getRalphSessionsDir(), sessionId);
}

export function getRalphSessionLockPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "active.lock");
}

export function getRalphSessionNudgesPath(sessionId: string): string {
  return join(getRalphSessionDir(sessionId), "nudges.jsonl");
}
