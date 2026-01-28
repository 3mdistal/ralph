import { shouldLog } from "../logging";
import { getRepoLabelWriteState, isStateDbInitialized, setRepoLabelWriteState } from "../state";
import { GitHubApiError } from "./client";

const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const LOG_INTERVAL_MS = 60_000;

function isSecondaryRateLimitText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes("secondary rate limit") || value.includes("abuse detection") || value.includes("temporarily blocked");
}

export function isTransientLabelWriteError(error: unknown): boolean {
  if (error instanceof GitHubApiError) {
    if (error.status === 429 || error.code === "rate_limit") return true;
    if (isSecondaryRateLimitText(error.responseText)) return true;
    if (error.status === 403 && isSecondaryRateLimitText(error.responseText)) return true;
  }
  if (error instanceof Error && isSecondaryRateLimitText(error.message)) return true;
  return false;
}

function formatLabelWriteError(error: unknown): string {
  if (error instanceof GitHubApiError) {
    const message = error.message || error.name;
    const response = error.responseText?.trim() || "";
    const combined = response ? `${message}; ${response}` : message;
    return combined.replace(/\s+/g, " ").slice(0, 400).trim();
  }
  if (error instanceof Error) {
    return (error.message || error.name).replace(/\s+/g, " ").slice(0, 400).trim();
  }
  return String(error).replace(/\s+/g, " ").slice(0, 400).trim();
}

export function canAttemptLabelWrite(repo: string, nowMs: number = Date.now()): boolean {
  if (!isStateDbInitialized()) return true;
  const state = getRepoLabelWriteState(repo);
  const blockedUntilMs = state.blockedUntilMs;
  if (typeof blockedUntilMs === "number" && Number.isFinite(blockedUntilMs) && blockedUntilMs > nowMs) {
    if (shouldLog(`labels:blocked:${repo}`, LOG_INTERVAL_MS)) {
      const untilIso = new Date(blockedUntilMs).toISOString();
      const lastError = state.lastError ? `; lastError="${state.lastError}"` : "";
      console.warn(`[ralph:labels:${repo}] label writes blocked until ${untilIso}${lastError}`);
    }
    return false;
  }
  return true;
}

export function recordLabelWriteFailure(repo: string, error: unknown, nowMs: number = Date.now()): number | null {
  if (!isStateDbInitialized()) return null;
  if (!isTransientLabelWriteError(error)) return null;

  const state = getRepoLabelWriteState(repo);
  const blockedUntilMs = typeof state.blockedUntilMs === "number" ? state.blockedUntilMs : null;
  const remaining = blockedUntilMs && blockedUntilMs > nowMs ? blockedUntilMs - nowMs : 0;
  const backoffMs = Math.min(MAX_BACKOFF_MS, Math.max(MIN_BACKOFF_MS, remaining > 0 ? remaining * 2 : MIN_BACKOFF_MS));
  const nextBlockedUntilMs = nowMs + backoffMs;
  const lastError = formatLabelWriteError(error);

  setRepoLabelWriteState({
    repo,
    blockedUntilMs: nextBlockedUntilMs,
    lastError,
    at: new Date(nowMs).toISOString(),
  });

  if (shouldLog(`labels:blocked:${repo}`, LOG_INTERVAL_MS)) {
    const untilIso = new Date(nextBlockedUntilMs).toISOString();
    console.warn(`[ralph:labels:${repo}] label writes blocked until ${untilIso}; lastError="${lastError}"`);
  }

  return nextBlockedUntilMs;
}

export function recordLabelWriteSuccess(repo: string, nowMs: number = Date.now()): void {
  if (!isStateDbInitialized()) return;
  const state = getRepoLabelWriteState(repo);
  if (!state.blockedUntilMs && !state.lastError) return;
  setRepoLabelWriteState({ repo, blockedUntilMs: null, lastError: null, at: new Date(nowMs).toISOString() });
}
