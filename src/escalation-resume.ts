import type { AgentEscalationNote } from "./escalation-notes";

export const DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS = 30_000;

function parseIsoMs(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Returns true when we should skip resolution parsing for now.
 * Used to avoid tight retry loops while waiting for a human to fill `## Resolution`.
 */
export function shouldDeferWaitingResolutionCheck(
  escalation: Pick<AgentEscalationNote, "resume-status" | "resume-deferred-at">,
  nowMs: number,
  intervalMs = DEFAULT_RESOLUTION_RECHECK_INTERVAL_MS
): boolean {
  const resumeStatus = escalation["resume-status"]?.trim() ?? "";
  if (resumeStatus !== "waiting-resolution") return false;

  const deferredAtMs = parseIsoMs(escalation["resume-deferred-at"]);
  if (!deferredAtMs) return false;

  return nowMs - deferredAtMs < intervalMs;
}

export function buildWaitingResolutionUpdate(nowIso: string, reason: string): Record<string, string> {
  return {
    "resume-status": "waiting-resolution",
    "resume-deferred-at": nowIso,
    "resume-error": reason,
  };
}
