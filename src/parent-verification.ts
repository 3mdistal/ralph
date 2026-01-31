const DEFAULT_PARENT_VERIFY_MAX_ATTEMPTS = 3;
const DEFAULT_PARENT_VERIFY_BACKOFF_MS = 2 * 60_000;
const DEFAULT_PARENT_VERIFY_BACKOFF_CAP_MS = 10 * 60_000;

const env = ((globalThis as any).process?.env ?? {}) as Record<string, string | undefined>;

export const PARENT_VERIFY_MARKER_PREFIX = "RALPH_PARENT_VERIFY";
export const PARENT_VERIFY_MARKER_VERSION = 1;

export type ParentVerificationMarker = {
  version: number;
  work_remains: boolean;
  reason: string;
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
  return { version, work_remains: record.work_remains as boolean, reason };
}
