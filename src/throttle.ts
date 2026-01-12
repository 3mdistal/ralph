import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { loadConfig, resolveOpencodeProfile } from "./config";
import { shouldLog } from "./logging";

export type ThrottleState = "ok" | "soft" | "hard";

export interface ThrottleWindowSnapshot {
  name: string;
  windowMs: number;
  budgetTokens: number;
  softCapTokens: number;
  hardCapTokens: number;
  usedTokens: number;
  usedPct: number;
  oldestTsInWindow: number | null;
  resumeAtTs: number | null;
  softResumeAtTs?: number | null;
  hardResumeAtTs?: number | null;
}

export interface ThrottleSnapshot {
  computedAt: string;
  providerID: string;
  /** Best-effort, config-selected profile name (for debugging). */
  opencodeProfile?: string | null;
  /** Best-effort, messages root scanned for usage (for debugging). */
  messagesRootDir?: string;
  state: ThrottleState;
  resumeAt: string | null;
  windows: ThrottleWindowSnapshot[];
}

export interface ThrottleDecision {
  state: ThrottleState;
  resumeAtTs: number | null;
  snapshot: ThrottleSnapshot;
}

const DEFAULT_PROVIDER_ID = "openai";

const WINDOWS = [
  { name: "rolling5h", windowMs: 5 * 60 * 60 * 1000, budgetTokens: 16_987_015 },
  { name: "weekly", windowMs: 7 * 24 * 60 * 60 * 1000, budgetTokens: 55_769_305 },
] as const;

const DEFAULT_SOFT_PCT = 0.65;
const DEFAULT_HARD_PCT = 0.75;

const DEFAULT_MIN_CHECK_INTERVAL_MS = 1_000;

type ThrottleCacheEntry = { lastCheckedAt: number; lastDecision: ThrottleDecision | null };
const decisionCache = new Map<string, ThrottleCacheEntry>();

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractProviderId(message: any): string | null {
  const direct = typeof message?.providerID === "string" ? message.providerID : null;
  if (direct) return direct;

  const alt = typeof message?.providerId === "string" ? message.providerId : null;
  if (alt) return alt;

  const nested = typeof message?.provider?.id === "string" ? message.provider.id : null;
  if (nested) return nested;

  return null;
}

function extractCreatedTs(message: any): number | null {
  const fromTime = num(message?.time?.created);
  if (fromTime) return fromTime;

  const fromCreated = num(message?.created);
  if (fromCreated) return fromCreated;

  const fromTs = num(message?.ts);
  if (fromTs) return fromTs;

  return null;
}

function extractRole(message: any): string {
  return typeof message?.role === "string" ? message.role : "";
}

function extractTokenCount(message: any): number {
  const tokens = message?.tokens;
  const input = num(tokens?.input) ?? 0;
  const output = num(tokens?.output) ?? 0;
  const reasoning = num(tokens?.reasoning) ?? 0;
  return input + output + reasoning;
}

async function listSessionDirs(messagesRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(messagesRoot, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isFile() && e.name.endsWith(".json")).map((e) => e.name);
  } catch {
    return [];
  }
}

async function readUsageEvents(
  now: number,
  providerID: string,
  messagesRoot: string
): Promise<{ ts: number; tokens: number }[]> {
  if (!existsSync(messagesRoot)) return [];

  const maxWindowMs = Math.max(...WINDOWS.map((w) => w.windowMs));
  const oldestStart = now - maxWindowMs;

  const out: { ts: number; tokens: number }[] = [];

  const sessionDirs = await listSessionDirs(messagesRoot);
  for (const session of sessionDirs) {
    const sessionDir = join(messagesRoot, session);
    const files = await listJsonFiles(sessionDir);

    for (const file of files) {
      const path = join(sessionDir, file);
      try {
        const raw = await readFile(path, "utf8");
        const msg = JSON.parse(raw);

        const ts = extractCreatedTs(msg);
        if (!ts) continue;
        if (ts < oldestStart) continue;

        const role = extractRole(msg);
        if (role && role !== "assistant") continue;

        const msgProvider = extractProviderId(msg);
        if (msgProvider && msgProvider !== providerID) continue;

        const tokens = extractTokenCount(msg);
        if (tokens <= 0) continue;

        out.push({ ts, tokens });
      } catch {
        // ignore malformed message files
      }
    }
  }

  return out;
}

function computeWindowSnapshot(opts: {
  now: number;
  events: { ts: number; tokens: number }[];
  name: string;
  windowMs: number;
  budgetTokens: number;
  softPct: number;
  hardPct: number;
  threshold: "soft" | "hard";
}): ThrottleWindowSnapshot {
  const start = opts.now - opts.windowMs;
  const inWindow = opts.events.filter((e) => e.ts >= start);

  let usedTokens = 0;
  let oldestTs: number | null = null;
  for (const e of inWindow) {
    usedTokens += e.tokens;
    if (oldestTs === null || e.ts < oldestTs) oldestTs = e.ts;
  }

  const softCapTokens = Math.floor(opts.budgetTokens * opts.softPct);
  const hardCapTokens = Math.floor(opts.budgetTokens * opts.hardPct);

  const cap = opts.threshold === "hard" ? hardCapTokens : softCapTokens;
  const isThrottled = usedTokens >= cap;

  let resumeAtTs: number | null = null;

  if (isThrottled) {
    const sorted = [...inWindow].sort((a, b) => a.ts - b.ts);
    let remaining = usedTokens;
    for (const e of sorted) {
      if (remaining < cap) break;
      remaining -= e.tokens;
      resumeAtTs = e.ts + opts.windowMs;
    }
  }

  return {
    name: opts.name,
    windowMs: opts.windowMs,
    budgetTokens: opts.budgetTokens,
    softCapTokens,
    hardCapTokens,
    usedTokens,
    usedPct: opts.budgetTokens > 0 ? usedTokens / opts.budgetTokens : 0,
    oldestTsInWindow: oldestTs,
    resumeAtTs,
  };
}

function resolveDefaultXdgDataHome(homeDir: string = homedir()): string {
  const raw = process.env.XDG_DATA_HOME?.trim();
  return raw ? raw : join(homeDir, ".local", "share");
}

function resolveOpencodeMessagesRootDir(opencodeProfile?: string | null): {
  effectiveProfile: string | null;
  messagesRootDir: string;
} {
  const requested = (opencodeProfile ?? "").trim();
  if (requested) {
    const resolved = resolveOpencodeProfile(requested);
    if (resolved) {
      return {
        effectiveProfile: resolved.name,
        messagesRootDir: join(resolved.xdgDataHome, "opencode", "storage", "message"),
      };
    }

    // Unknown profile: fall back to ambient XDG dirs.
    const xdgDataHome = resolveDefaultXdgDataHome();
    return { effectiveProfile: null, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
  }

  // No explicit profile: prefer configured default profile if enabled.
  const resolvedDefault = resolveOpencodeProfile(null);
  if (resolvedDefault) {
    return {
      effectiveProfile: resolvedDefault.name,
      messagesRootDir: join(resolvedDefault.xdgDataHome, "opencode", "storage", "message"),
    };
  }

  const xdgDataHome = resolveDefaultXdgDataHome();
  return { effectiveProfile: null, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
}

export async function getThrottleDecision(
  now: number = Date.now(),
  opts?: { opencodeProfile?: string | null }
): Promise<ThrottleDecision> {
  const cfg = loadConfig().throttle;
  const enabled = cfg?.enabled ?? true;

  const providerID = (cfg?.providerID?.trim() ?? "") || DEFAULT_PROVIDER_ID;
  const softPct = typeof cfg?.softPct === "number" && Number.isFinite(cfg.softPct) ? cfg.softPct : DEFAULT_SOFT_PCT;
  const hardPct = typeof cfg?.hardPct === "number" && Number.isFinite(cfg.hardPct) ? cfg.hardPct : DEFAULT_HARD_PCT;

  const minCheckIntervalMs =
    typeof cfg?.minCheckIntervalMs === "number" && Number.isFinite(cfg.minCheckIntervalMs)
      ? Math.max(0, Math.floor(cfg.minCheckIntervalMs))
      : DEFAULT_MIN_CHECK_INTERVAL_MS;

  const { effectiveProfile, messagesRootDir } = resolveOpencodeMessagesRootDir(opts?.opencodeProfile);
  const cacheKey = `${providerID}|${messagesRootDir}|soft=${softPct}|hard=${hardPct}`;

  const cached = decisionCache.get(cacheKey);
  if (cached?.lastDecision && now - cached.lastCheckedAt < minCheckIntervalMs) return cached.lastDecision;

  const prevState: ThrottleState = cached?.lastDecision?.state ?? "ok";
  const events = enabled ? await readUsageEvents(now, providerID, messagesRootDir) : [];

  // First compute hard/soft separately so the snapshot includes both caps.
  const hardWindows = WINDOWS.map((w) =>
    computeWindowSnapshot({
      now,
      events,
      name: w.name,
      windowMs: w.windowMs,
      budgetTokens: w.budgetTokens,
      softPct,
      hardPct,
      threshold: "hard",
    })
  );

  const softWindows = WINDOWS.map((w) =>
    computeWindowSnapshot({
      now,
      events,
      name: w.name,
      windowMs: w.windowMs,
      budgetTokens: w.budgetTokens,
      softPct,
      hardPct,
      threshold: "soft",
    })
  );

  const hardResumeCandidates = hardWindows.map((w) => w.resumeAtTs).filter((t): t is number => typeof t === "number");
  const softResumeCandidates = softWindows.map((w) => w.resumeAtTs).filter((t): t is number => typeof t === "number");

  let state: ThrottleState = "ok";
  let resumeAtTs: number | null = null;

  if (hardResumeCandidates.length > 0) {
    state = "hard";
    resumeAtTs = Math.max(...hardResumeCandidates);
  } else if (softResumeCandidates.length > 0) {
    state = "soft";
    resumeAtTs = Math.max(...softResumeCandidates);
  }

  const mergedWindows: ThrottleWindowSnapshot[] = hardWindows.map((hardWindow, idx) => {
    const softWindow = softWindows[idx];
    const softResumeAtTs = softWindow?.resumeAtTs ?? null;
    const hardResumeAtTs = hardWindow.resumeAtTs;
    const effectiveResumeAtTs = state === "hard" ? hardResumeAtTs : softResumeAtTs;

    return {
      ...hardWindow,
      resumeAtTs: effectiveResumeAtTs,
      softResumeAtTs,
      hardResumeAtTs,
    };
  });

  const snapshot: ThrottleSnapshot = {
    computedAt: new Date(now).toISOString(),
    providerID,
    opencodeProfile: effectiveProfile,
    messagesRootDir,
    state,
    resumeAt: resumeAtTs ? new Date(resumeAtTs).toISOString() : null,
    windows: mergedWindows,
  };

  if (prevState !== state) {
    const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
    const softParts = snapshot.windows.map((w) => {
      const resetAt = w.resumeAtTs ? new Date(w.resumeAtTs).toISOString() : "unknown";
      return (
        `${w.name} used=${pct(w.usedPct)} usedTokens=${w.usedTokens} ` +
        `softCapTokens=${w.softCapTokens} hardCapTokens=${w.hardCapTokens} budgetTokens=${w.budgetTokens} ` +
        `resetAt=${resetAt}`
      );
    });

    const label = effectiveProfile ? `profile=${effectiveProfile}` : "profile=ambient";

    if (state === "soft") {
      console.warn(`[ralph] Soft throttle enabled (${label}; ${softParts.join("; ")}) resumeAt=${snapshot.resumeAt ?? "unknown"}`);
    } else if (prevState === "soft" && state === "ok") {
      console.warn(`[ralph] Soft throttle disabled (${label}; ${softParts.join("; ")})`);
    }
  }

  if (state === "hard" && shouldLog(`throttle:${state}:${effectiveProfile ?? "ambient"}`, 60_000)) {
    console.warn(
      `[ralph:throttle] ${state} throttle active; profile=${effectiveProfile ?? "ambient"} resumeAt=${snapshot.resumeAt ?? "unknown"} ` +
        `5h=${hardWindows[0]?.usedTokens ?? 0}/${hardWindows[0]?.hardCapTokens ?? 0} ` +
        `week=${hardWindows[1]?.usedTokens ?? 0}/${hardWindows[1]?.hardCapTokens ?? 0}`
    );
  }

  const decision: ThrottleDecision = { state, resumeAtTs, snapshot };
  decisionCache.set(cacheKey, { lastCheckedAt: now, lastDecision: decision });
  return decision;
}

export async function isHardThrottled(opts?: { opencodeProfile?: string | null }): Promise<{ hard: boolean; decision: ThrottleDecision }> {
  const decision = await getThrottleDecision(Date.now(), opts);
  return { hard: decision.state === "hard", decision };
}
