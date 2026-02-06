const DEFAULT_PARENT_VERIFY_MAX_ATTEMPTS = 3;
const DEFAULT_PARENT_VERIFY_BACKOFF_MS = 2 * 60_000;
const DEFAULT_PARENT_VERIFY_BACKOFF_CAP_MS = 10 * 60_000;

const env = ((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>;

export const PARENT_VERIFY_MARKER_PREFIX = "RALPH_PARENT_VERIFY";
export const PARENT_VERIFY_MARKER_VERSION = 1;

const MAX_CHECKED_ITEMS = 20;
const MAX_EVIDENCE_ITEMS = 20;
const MAX_TEXT_LENGTH = 300;

export type ParentVerificationConfidence = "low" | "medium" | "high";

export type ParentVerificationEvidence = {
  url: string;
  note?: string;
};

export type ParentVerificationMarker = {
  version: number;
  work_remains: boolean;
  reason: string;
  confidence?: ParentVerificationConfidence;
  checked?: string[];
  why_satisfied?: string;
  evidence?: ParentVerificationEvidence[];
};

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return null;
}

function parsePositiveInt(value: string | undefined): number | null {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function trimText(value: unknown, maxLen = MAX_TEXT_LENGTH): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd();
}

function parseConfidence(value: unknown): ParentVerificationConfidence | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return null;
}

function parseChecked(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const checked: string[] = [];
  for (const entry of value) {
    if (checked.length >= MAX_CHECKED_ITEMS) break;
    const text = trimText(entry);
    if (text) checked.push(text);
  }
  return checked.length ? checked : undefined;
}

function parseEvidence(value: unknown): ParentVerificationEvidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const evidence: ParentVerificationEvidence[] = [];
  for (const entry of value) {
    if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const url = trimText(record.url);
    if (!url) continue;
    const note = trimText(record.note);
    evidence.push(note ? { url, note } : { url });
  }
  return evidence.length ? evidence : undefined;
}

export function isParentVerificationDisabled(): boolean {
  const disabled = parseBooleanEnv(env.RALPH_PARENT_VERIFY_DISABLED);
  return disabled === true;
}

export function getParentVerificationMaxAttempts(): number {
  return parsePositiveInt(env.RALPH_PARENT_VERIFY_MAX_ATTEMPTS) ?? DEFAULT_PARENT_VERIFY_MAX_ATTEMPTS;
}

export function getParentVerificationBackoffMs(attempt: number): number {
  const base = parsePositiveInt(env.RALPH_PARENT_VERIFY_BACKOFF_MS) ?? DEFAULT_PARENT_VERIFY_BACKOFF_MS;
  const cap = parsePositiveInt(env.RALPH_PARENT_VERIFY_BACKOFF_CAP_MS) ?? DEFAULT_PARENT_VERIFY_BACKOFF_CAP_MS;
  if (!Number.isFinite(attempt) || attempt <= 0) return base;
  const scaled = base * attempt;
  return Math.min(scaled, cap);
}

export function parseParentVerificationMarker(value: unknown): ParentVerificationMarker | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const version = Number(record.version ?? NaN);
  if (!Number.isFinite(version)) return null;
  if (record.work_remains !== true && record.work_remains !== false) return null;
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  if (!reason) return null;
  const confidence = parseConfidence(record.confidence);
  const checked = parseChecked(record.checked);
  const whySatisfiedRaw = trimText(record.why_satisfied);
  const whySatisfied = whySatisfiedRaw ? whySatisfiedRaw : undefined;
  const evidence = parseEvidence(record.evidence);

  return {
    version,
    work_remains: record.work_remains as boolean,
    reason,
    confidence: confidence ?? undefined,
    checked,
    why_satisfied: whySatisfied,
    evidence,
  };
}
