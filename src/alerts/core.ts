import { sanitizeExternalText } from "../util/sanitize-text";
export type AlertKind = "error" | "rollup-ready";
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

const ALERT_SUMMARY_MAX_CHARS = 300;
const ALERT_DETAILS_MAX_CHARS = 4000;
const ALERT_FINGERPRINT_MAX_CHARS = 2000;

function truncateText(input: string, maxChars: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeText(text: string): string {
  return sanitizeExternalText(text).trim();
}

function hashFNV1a(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function formatAlertSummary(input: string): string {
  const safe = normalizeWhitespace(sanitizeText(input));
  return truncateText(safe || "(unknown error)", ALERT_SUMMARY_MAX_CHARS);
}

export function formatAlertDetails(input: string): string | null {
  const safe = sanitizeText(input);
  if (!safe) return null;
  return truncateText(safe, ALERT_DETAILS_MAX_CHARS);
}

export function buildAlertFingerprintFromSeed(seed: string): string {
  const safeSeed = sanitizeText(seed);
  const base = truncateText(safeSeed, ALERT_FINGERPRINT_MAX_CHARS);
  return hashFNV1a(base);
}

export function buildAlertSummary(context: string, error: string): string {
  const safeContext = normalizeWhitespace(sanitizeText(context));
  const firstLine = normalizeWhitespace(sanitizeText(error).split("\n")[0] ?? "");
  const combined = firstLine ? `${safeContext}: ${firstLine}` : safeContext;
  return formatAlertSummary(combined || "(unknown error)");
}

function buildAlertDetails(error: string): string | null {
  return formatAlertDetails(error);
}

export function buildAlertFingerprint(context: string, error: string): string {
  const safeContext = sanitizeText(context);
  const safeError = sanitizeText(error);
  const base = truncateText(`${safeContext}\n${safeError}`, ALERT_FINGERPRINT_MAX_CHARS);
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
