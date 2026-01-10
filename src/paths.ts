import { homedir } from "os";
import { join } from "path";

export const RALPH_SESSIONS_DIR = join(homedir(), ".ralph", "sessions");

export function getSessionDir(sessionId: string): string {
  return join(RALPH_SESSIONS_DIR, sessionId);
}

export function getSessionEventsPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "events.jsonl");
}
