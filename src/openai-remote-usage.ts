import { existsSync } from "fs";
import { chmod, copyFile, readFile, rename, stat, writeFile } from "fs/promises";
import { dirname, join } from "path";

type OpenCodeAuthFile = {
  openai?: {
    type?: unknown;
    access?: unknown;
    refresh?: unknown;
    expires?: unknown;
  };
};

export type RemoteOpenaiUsageWindow = {
  usedPct: number;
  resetAt: string | null;
  resetAtTs: number | null;
  usedPercentRaw: number | null;
};

export type RemoteOpenaiUsage = {
  fetchedAt: string;
  planType: string;
  rolling5h: RemoteOpenaiUsageWindow;
  weekly: RemoteOpenaiUsageWindow;
};

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

const DEFAULT_REMOTE_USAGE_TIMEOUT_MS = 2_000;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_FAILURE_COOLDOWN_MS = 60_000;

// Observed OpenAI web client id used by OpenCode/ChatGPT OAuth refresh flow.
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

type CacheEntry = { fetchedAtMs: number; data: RemoteOpenaiUsage };
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<RemoteOpenaiUsage>>();
const failureState = new Map<string, { count: number; lastFailureAtMs: number }>();

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function parseTimestampMs(value: unknown): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    // Heuristic: treat small numbers as epoch seconds.
    if (value > 0 && value < 1e12) return Math.floor(value * 1000);
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeUsedPct(raw: number | null): { usedPct: number; usedPercentRaw: number | null } {
  if (raw == null) return { usedPct: 0, usedPercentRaw: null };
  const usedPercentRaw = raw;
  // Some responses return 0..1, others return 0..100.
  // Important: some responses use integer percents like 0 or 1 (meaning 0%/1%),
  // while others use 0..1 fractions (e.g. 0.12 meaning 12%).
  const frac = raw <= 1
    ? (Number.isInteger(raw) ? raw / 100 : raw)
    : raw / 100;
  const clamped = Math.max(0, Math.min(1, frac));
  return { usedPct: clamped, usedPercentRaw };
}

function normalizeResetAt(value: unknown): { resetAt: string | null; resetAtTs: number | null } {
  const ts = parseTimestampMs(value);
  if (ts == null) return { resetAt: null, resetAtTs: null };
  return { resetAt: new Date(ts).toISOString(), resetAtTs: ts };
}

async function readAuthFile(path: string): Promise<OpenCodeAuthFile> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as OpenCodeAuthFile;
}

async function writeAuthFileAtomic(path: string, auth: OpenCodeAuthFile): Promise<void> {
  const dir = dirname(path);
  const tmp = join(dir, `.auth.json.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`);
  const backup = join(dir, "auth.json.bak");
  const content = JSON.stringify(auth, null, 2) + "\n";
  const priorStat = await stat(path).catch(() => null);
  const mode = priorStat ? priorStat.mode & 0o777 : 0o600;
  if (priorStat) {
    await copyFile(path, backup);
    await chmod(backup, mode).catch(() => undefined);
  }
  await writeFile(tmp, content, { encoding: "utf8", mode });
  await chmod(tmp, mode).catch(() => undefined);
  await rename(tmp, path);
}

function isTokenExpired(expiresAtMs: number, nowMs: number): boolean {
  // 5 minute buffer.
  const bufferMs = 5 * 60 * 1000;
  return nowMs >= expiresAtMs - bufferMs;
}

async function refreshToken(
  refreshTokenValue: string,
  timeoutMs: number
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
}> {
  const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(input, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const attemptJson = async (): Promise<Response> => {
    return fetchWithTimeout(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshTokenValue,
        client_id: OPENAI_CLIENT_ID,
      }),
    });
  };

  const attemptForm = async (): Promise<Response> => {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenValue,
      client_id: OPENAI_CLIENT_ID,
    });

    return fetchWithTimeout(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  };

  let response = await attemptJson();

  if (!response.ok && (response.status === 400 || response.status === 415)) {
    // Some OAuth servers only accept form-encoded refresh requests.
    response = await attemptForm();
  }

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`.trim());
  }

  return response.json();
}

function parseUsageResponse(raw: unknown): {
  planType: string;
  rollingUsedPercent: number | null;
  rollingResetAt: unknown;
  weeklyUsedPercent: number | null;
  weeklyResetAt: unknown;
} {
  const data = (raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}) as Record<string, unknown>;

  const planType =
    (typeof data.planType === "string" && data.planType.trim() ? data.planType.trim() : null) ??
    (typeof data.plan_type === "string" && data.plan_type.trim() ? data.plan_type.trim() : null) ??
    "unknown";

  let rollingUsedPercent: number | null = null;
  let rollingResetAt: unknown = null;
  let weeklyUsedPercent: number | null = null;
  let weeklyResetAt: unknown = null;

  const breakdown = data.usage_breakdown;
  if (breakdown && typeof breakdown === "object" && !Array.isArray(breakdown)) {
    const b = breakdown as Record<string, unknown>;
    const rolling = b.rolling;
    if (rolling && typeof rolling === "object" && !Array.isArray(rolling)) {
      const r = rolling as Record<string, unknown>;
      rollingUsedPercent = toFiniteNumber(r.used_percent);
      rollingResetAt = r.reset_at;
    }
    const weekly = b.weekly;
    if (weekly && typeof weekly === "object" && !Array.isArray(weekly)) {
      const w = weekly as Record<string, unknown>;
      weeklyUsedPercent = toFiniteNumber(w.used_percent);
      weeklyResetAt = w.reset_at;
    }
  }

  // ChatGPT "wham" rate_limit structure.
  const rateLimit = data.rate_limit;
  if (rateLimit && typeof rateLimit === "object" && !Array.isArray(rateLimit)) {
    const rl = rateLimit as Record<string, unknown>;

    const primary = rl.primary_window;
    if (primary && typeof primary === "object" && !Array.isArray(primary)) {
      const w = primary as Record<string, unknown>;
      if (rollingUsedPercent == null) rollingUsedPercent = toFiniteNumber(w.used_percent);
      if (rollingResetAt == null) rollingResetAt = w.reset_at;
    }

    const secondary = rl.secondary_window;
    if (secondary && typeof secondary === "object" && !Array.isArray(secondary)) {
      const w = secondary as Record<string, unknown>;
      if (weeklyUsedPercent == null) weeklyUsedPercent = toFiniteNumber(w.used_percent);
      if (weeklyResetAt == null) weeklyResetAt = w.reset_at;
    }
  }

  // Flat fallbacks (best-effort).
  if (rollingUsedPercent == null) rollingUsedPercent = toFiniteNumber(data.primary_used_percent);
  if (weeklyUsedPercent == null) weeklyUsedPercent = toFiniteNumber(data.secondary_used_percent);
  if (rollingUsedPercent == null) rollingUsedPercent = toFiniteNumber(data.used_percent);

  return {
    planType,
    rollingUsedPercent,
    rollingResetAt,
    weeklyUsedPercent,
    weeklyResetAt,
  };
}

async function fetchUsage(accessToken: string, timeoutMs: number): Promise<RemoteOpenaiUsage> {
  const fetchWithTimeout = async (input: RequestInfo | URL, init: RequestInit): Promise<Response> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(input, init);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  const response = await fetchWithTimeout(USAGE_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Usage API failed: ${response.status}`.trim());
  }

  const raw = await response.json();
  const parsed = parseUsageResponse(raw);

  // If the API response shape changes, do not silently return 0%.
  if (parsed.rollingUsedPercent == null && parsed.weeklyUsedPercent == null) {
    const keys = raw && typeof raw === "object" ? Object.keys(raw as Record<string, unknown>).slice(0, 20) : [];
    throw new Error(`Usage API parse failed (missing used_percent fields). keys=${JSON.stringify(keys)}`);
  }

  const rollingPct = normalizeUsedPct(parsed.rollingUsedPercent);
  const weeklyPct = normalizeUsedPct(parsed.weeklyUsedPercent);
  const rollingReset = normalizeResetAt(parsed.rollingResetAt);
  const weeklyReset = normalizeResetAt(parsed.weeklyResetAt);

  return {
    fetchedAt: new Date().toISOString(),
    planType: parsed.planType,
    rolling5h: {
      usedPct: rollingPct.usedPct,
      usedPercentRaw: rollingPct.usedPercentRaw,
      resetAt: rollingReset.resetAt,
      resetAtTs: rollingReset.resetAtTs,
    },
    weekly: {
      usedPct: weeklyPct.usedPct,
      usedPercentRaw: weeklyPct.usedPercentRaw,
      resetAt: weeklyReset.resetAt,
      resetAtTs: weeklyReset.resetAtTs,
    },
  };
}

export async function getRemoteOpenaiUsage(opts: {
  authFilePath: string;
  now?: number;
  skipCache?: boolean;
  cacheTtlMs?: number;
  autoRefresh?: boolean;
  timeoutMs?: number;
  failureThreshold?: number;
  failureCooldownMs?: number;
}): Promise<RemoteOpenaiUsage> {
  const nowMs = typeof opts.now === "number" && Number.isFinite(opts.now) ? Math.floor(opts.now) : Date.now();
  const skipCache = opts.skipCache === true;
  const autoRefresh = opts.autoRefresh !== false;
  const timeoutMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs)
      ? Math.max(0, Math.floor(opts.timeoutMs))
      : DEFAULT_REMOTE_USAGE_TIMEOUT_MS;
  const failureThreshold =
    typeof opts.failureThreshold === "number" && Number.isFinite(opts.failureThreshold)
      ? Math.max(1, Math.floor(opts.failureThreshold))
      : DEFAULT_FAILURE_THRESHOLD;
  const failureCooldownMs =
    typeof opts.failureCooldownMs === "number" && Number.isFinite(opts.failureCooldownMs)
      ? Math.max(0, Math.floor(opts.failureCooldownMs))
      : DEFAULT_FAILURE_COOLDOWN_MS;

  const ttlMs =
    typeof opts.cacheTtlMs === "number" && Number.isFinite(opts.cacheTtlMs) ? Math.max(0, Math.floor(opts.cacheTtlMs)) : 120_000;

  if (!skipCache) {
    const cached = cache.get(opts.authFilePath);
    if (cached && nowMs - cached.fetchedAtMs < ttlMs) return cached.data;
  }

  const existing = inFlight.get(opts.authFilePath);
  if (existing) return existing;

  const recentFailure = failureState.get(opts.authFilePath);
  if (
    recentFailure &&
    recentFailure.count >= failureThreshold &&
    nowMs - recentFailure.lastFailureAtMs < failureCooldownMs
  ) {
    throw new Error("Remote usage temporarily disabled after recent failures");
  }

  const promise = (async (): Promise<RemoteOpenaiUsage> => {
    if (!existsSync(opts.authFilePath)) {
      throw new Error(`Missing auth file: ${opts.authFilePath}`);
    }

    const auth = await readAuthFile(opts.authFilePath);
    const openai = auth.openai;
    const access = typeof openai?.access === "string" ? openai.access.trim() : "";
    if (!access) throw new Error("No OpenAI access token in auth.json");

    const expiresAtMs = parseTimestampMs(openai?.expires);
    const expired = expiresAtMs != null ? isTokenExpired(expiresAtMs, nowMs) : false;

    let accessToken = access;

    if (expired) {
      if (!autoRefresh) throw new Error("OpenAI access token expired");
      const refresh = typeof openai?.refresh === "string" ? openai.refresh.trim() : "";
      if (!refresh) throw new Error("OpenAI access token expired and no refresh token available");

      const tokens = await refreshToken(refresh, timeoutMs);
      accessToken = tokens.access_token;

      auth.openai = {
        type: openai?.type,
        access: tokens.access_token,
        refresh: tokens.refresh_token ?? refresh,
        expires: nowMs + tokens.expires_in * 1000,
      };

      try {
        await writeAuthFileAtomic(opts.authFilePath, auth);
      } catch {
        // Best-effort writeback only; continue with in-memory token.
      }
    }

    const data = await fetchUsage(accessToken, timeoutMs);
    if (!skipCache && ttlMs > 0) {
      cache.set(opts.authFilePath, { fetchedAtMs: nowMs, data });
    }
    return data;
  })();

  inFlight.set(opts.authFilePath, promise);
  try {
    const data = await promise;
    failureState.delete(opts.authFilePath);
    return data;
  } catch (error) {
    const existingFailure = failureState.get(opts.authFilePath);
    const nextCount = existingFailure ? existingFailure.count + 1 : 1;
    failureState.set(opts.authFilePath, { count: nextCount, lastFailureAtMs: nowMs });
    throw error;
  } finally {
    inFlight.delete(opts.authFilePath);
  }
}

export function __clearRemoteOpenaiUsageCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  failureState.clear();
}
