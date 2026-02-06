const DEFAULT_PARENT_VERIFY_MAX_ATTEMPTS = 3;
const DEFAULT_PARENT_VERIFY_BACKOFF_MS = 2 * 60_000;
const DEFAULT_PARENT_VERIFY_BACKOFF_CAP_MS = 10 * 60_000;

const env = ((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>;

export const PARENT_VERIFY_MARKER_PREFIX = "RALPH_PARENT_VERIFY";
export const PARENT_VERIFY_MARKER_VERSION = 1;

const PARENT_VERIFY_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
export type ParentVerificationConfidence = "low" | "medium" | "high";

export type ParentVerificationEvidenceItem = {
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
  evidence?: ParentVerificationEvidenceItem[];
};

export type ParentVerificationNoPrEligibility =
  | { ok: true }
  | { ok: false; reason: string };

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

  const parsed: ParentVerificationMarker = {
    version,
    work_remains: record.work_remains as boolean,
    reason,
  };

  const confidenceRaw = typeof record.confidence === "string" ? record.confidence.trim().toLowerCase() : "";
  if (confidenceRaw) {
    if (!PARENT_VERIFY_CONFIDENCE_LEVELS.includes(confidenceRaw as ParentVerificationConfidence)) return null;
    parsed.confidence = confidenceRaw as ParentVerificationConfidence;
  }

  if (Array.isArray(record.checked)) {
    const checked = record.checked
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean)
      .slice(0, 20);
    if (checked.length > 0) parsed.checked = checked;
  }

  const whySatisfied = typeof record.why_satisfied === "string" ? record.why_satisfied.trim() : "";
  if (whySatisfied) parsed.why_satisfied = whySatisfied;

  if (Array.isArray(record.evidence)) {
    const evidence = record.evidence
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const obj = item as Record<string, unknown>;
        const url = typeof obj.url === "string" ? obj.url.trim() : "";
        if (!url) return null;
        const note = typeof obj.note === "string" ? obj.note.trim() : "";
        return note ? { url, note } : { url };
      })
      .filter((item): item is ParentVerificationEvidenceItem => Boolean(item))
      .slice(0, 20);
    if (evidence.length > 0) parsed.evidence = evidence;
  }

  return parsed;
}

export function evaluateParentVerificationNoPrEligibility(marker: ParentVerificationMarker): ParentVerificationNoPrEligibility {
  if (marker.work_remains) return { ok: false, reason: "work_remains=true" };
  if (marker.confidence !== "medium" && marker.confidence !== "high") {
    return { ok: false, reason: "confidence must be medium or high" };
  }
  if (!Array.isArray(marker.checked) || marker.checked.length === 0) {
    return { ok: false, reason: "checked must contain at least one item" };
  }
  if (!marker.why_satisfied || !marker.why_satisfied.trim()) {
    return { ok: false, reason: "why_satisfied is required" };
  }
  if (!Array.isArray(marker.evidence) || marker.evidence.length === 0) {
    return { ok: false, reason: "evidence must contain at least one item" };
  }

  const hasValidEvidenceUrl = marker.evidence.some((item) => {
    try {
      const parsed = new URL(item.url);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  });

  if (!hasValidEvidenceUrl) {
    return { ok: false, reason: "evidence must include at least one valid http(s) URL" };
  }

  return { ok: true };
}
