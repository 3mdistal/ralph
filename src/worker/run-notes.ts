import { existsSync } from "fs";

import type { AgentTask } from "../queue-backend";
import { sanitizeEscalationReason } from "../github/escalation-writeback";
import { getSessionEventsPath } from "../paths";
import { redactHomePathForDisplay } from "../redaction";
import { isSafeSessionId } from "../session-id";

import type { BlockedSource } from "../blocked-sources";

const BLOCKED_REASON_MAX_LEN = 200;
const BLOCKED_DETAILS_MAX_LEN = 2000;

export function summarizeForNote(text: string, maxChars = 900): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trimEnd() + "…";
}

function sanitizeDiagnosticsText(text: string): string {
  return sanitizeEscalationReason(text);
}

function summarizeBlockedReason(text: string): string {
  const trimmed = sanitizeDiagnosticsText(text).trim();
  if (!trimmed) return "";
  if (trimmed.length <= BLOCKED_REASON_MAX_LEN) return trimmed;
  return trimmed.slice(0, BLOCKED_REASON_MAX_LEN).trimEnd() + "…";
}

export function summarizeBlockedDetails(text: string): string {
  const trimmed = sanitizeDiagnosticsText(text).trim();
  if (!trimmed) return "";
  if (trimmed.length <= BLOCKED_DETAILS_MAX_LEN) return trimmed;
  return trimmed.slice(0, BLOCKED_DETAILS_MAX_LEN).trimEnd() + "…";
}

function buildBlockedSignature(source?: string, reason?: string): string {
  return `${source ?? ""}::${reason ?? ""}`;
}

export function computeBlockedPatch(
  task: AgentTask,
  opts: { source: BlockedSource; reason?: string; details?: string; nowIso: string }
): {
  patch: Record<string, string>;
  didEnterBlocked: boolean;
  reasonSummary: string;
  detailsSummary: string;
} {
  const reasonSummary = opts.reason ? summarizeBlockedReason(opts.reason) : "";
  const detailsSource = opts.details ?? opts.reason ?? "";
  const detailsSummary = detailsSource ? summarizeBlockedDetails(detailsSource) : "";

  // Guard against legacy rows that may still miss blocked-* metadata after migration.
  // Without this, status-only blocked rows can cause noisy duplicate blocked notifications.
  const priorBlockedSource = typeof task["blocked-source"] === "string" ? task["blocked-source"].trim() : "";
  const priorBlockedReason = typeof task["blocked-reason"] === "string" ? task["blocked-reason"].trim() : "";
  const hasPriorBlockedSignature = Boolean(priorBlockedSource || priorBlockedReason);

  const previousSignature = buildBlockedSignature(priorBlockedSource, priorBlockedReason);
  const nextSignature = buildBlockedSignature(opts.source, reasonSummary);
  const didChangeSignature = previousSignature !== nextSignature;

  const didEnterBlocked = task.status !== "blocked" ? true : hasPriorBlockedSignature ? didChangeSignature : false;

  const patch: Record<string, string> = {
    "blocked-source": opts.source,
    "blocked-reason": reasonSummary,
    "blocked-details": detailsSummary,
    "blocked-checked-at": opts.nowIso,
  };

  if (didEnterBlocked) {
    patch["blocked-at"] = opts.nowIso;
  }

  return { patch, didEnterBlocked, reasonSummary, detailsSummary };
}

export function buildAgentRunBodyPrefix(params: {
  task: AgentTask;
  headline: string;
  reason?: string;
  details?: string;
  sessionId?: string;
  runLogPath?: string;
}): string {
  const lines: string[] = [params.headline];
  lines.push("", `Issue: ${params.task.issue}`, `Repo: ${params.task.repo}`);
  if (params.sessionId) lines.push(`Session: ${params.sessionId}`);
  if (params.runLogPath) lines.push(`Run log: ${redactHomePathForDisplay(params.runLogPath)}`);
  if (params.sessionId && isSafeSessionId(params.sessionId)) {
    const eventsPath = getSessionEventsPath(params.sessionId);
    if (existsSync(eventsPath)) {
      lines.push(`Trace: ${redactHomePathForDisplay(eventsPath)}`);
    }
  }

  const sanitizedReason = params.reason ? sanitizeDiagnosticsText(params.reason) : "";
  const reasonSummary = sanitizedReason ? summarizeForNote(sanitizedReason, 800) : "";
  if (reasonSummary) lines.push("", `Reason: ${reasonSummary}`);

  const sanitizedDetails = params.details ? sanitizeDiagnosticsText(params.details) : "";
  const detailText = sanitizedDetails && sanitizedDetails !== sanitizedReason ? summarizeForNote(sanitizedDetails, 1400) : "";
  if (detailText) lines.push("", "Details:", detailText);

  return lines.join("\n").trim();
}
