import { homedir } from "os";
import { isAbsolute, join } from "path";

export function getRalphHomeDir(): string {
  return join(homedir(), ".ralph");
}

export function getRalphConfigTomlPath(): string {
  return join(getRalphHomeDir(), "config.toml");
}

export function getRalphConfigJsonPath(): string {
  return join(getRalphHomeDir(), "config.json");
}

export function getRalphLegacyConfigPath(): string {
  return join(homedir(), ".config", "opencode", "ralph", "ralph.json");
}

export function getRalphStateDbPath(): string {
  return join(getRalphHomeDir(), "state.sqlite");
}

export function getRalphSessionsDir(): string {
  const raw = process.env.RALPH_SESSIONS_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(getRalphHomeDir(), "sessions");
}

export function getRalphWorktreesDir(): string {
  const raw = process.env.RALPH_WORKTREES_DIR?.trim();
  if (raw) return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(getRalphHomeDir(), "worktrees");
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
