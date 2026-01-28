import { sanitizeEscalationReason } from "../github/escalation-writeback";

export type AlertKind = "error";
export type AlertTargetType = "issue" | "repo";

export type AlertRecordPlanInput = {
  kind: AlertKind;
  targetType: AlertTargetType;
  targetNumber: number;
  context: string;
  error: string;
};

export type PlannedAlertRecord = {
  kind: AlertKind;
  targetType: AlertTargetType;
  targetNumber: number;
  summary: string;
  details: string | null;
  fingerprint: string;
};

const MAX_SUMMARY_CHARS = 300;
const MAX_DETAILS_CHARS = 4000;
const MAX_FINGERPRINT_CHARS = 2000;

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeText(text: string): string {
  return sanitizeEscalationReason(text).trim();
}

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildAlertSummary(context: string, error: string): string {
  const safeContext = normalizeWhitespace(sanitizeText(context));
  const firstLine = normalizeWhitespace(sanitizeText(error).split("\n")[0] ?? "");
  const combined = firstLine ? `${safeContext}: ${firstLine}` : safeContext;
  return truncateText(combined || "(unknown error)", MAX_SUMMARY_CHARS);
}

export function buildAlertDetails(error: string): string | null {
  const safe = sanitizeText(error);
  if (!safe) return null;
  return truncateText(safe, MAX_DETAILS_CHARS);
}

export function buildAlertFingerprint(context: string, error: string): string {
  const safeContext = sanitizeText(context);
  const safeError = sanitizeText(error);
  const base = truncateText(`${safeContext}\n${safeError}`, MAX_FINGERPRINT_CHARS);
  return hashFNV1a(base);
}

export function planAlertRecord(input: AlertRecordPlanInput): PlannedAlertRecord {
  const summary = buildAlertSummary(input.context, input.error);
  const details = buildAlertDetails(input.error);
  const fingerprint = buildAlertFingerprint(input.context, input.error);
  return {
    kind: input.kind,
    targetType: input.targetType,
    targetNumber: input.targetNumber,
    summary,
    details,
    fingerprint,
  };
}
