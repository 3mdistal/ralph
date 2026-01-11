import { existsSync } from "fs";
import { readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

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
}

export interface ThrottleSnapshot {
  computedAt: string;
  providerID: string;
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

const MIN_CHECK_INTERVAL_MS = 1_000;

let lastCheckedAt = 0;
let lastDecision: ThrottleDecision | null = null;

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

async function readUsageEvents(now: number, providerID: string): Promise<{ ts: number; tokens: number }[]> {
  const storageDir = join(homedir(), ".local/share/opencode/storage");
  const messagesRoot = join(storageDir, "message");
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

export async function getThrottleDecision(now: number = Date.now()): Promise<ThrottleDecision> {
  if (lastDecision && now - lastCheckedAt < MIN_CHECK_INTERVAL_MS) return lastDecision;

  lastCheckedAt = now;

  const providerID = DEFAULT_PROVIDER_ID;
  const events = await readUsageEvents(now, providerID);

  // First compute hard/soft separately so the snapshot includes both caps.
  const hardWindows = WINDOWS.map((w) =>
    computeWindowSnapshot({
      now,
      events,
      name: w.name,
      windowMs: w.windowMs,
      budgetTokens: w.budgetTokens,
      softPct: DEFAULT_SOFT_PCT,
      hardPct: DEFAULT_HARD_PCT,
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
      softPct: DEFAULT_SOFT_PCT,
      hardPct: DEFAULT_HARD_PCT,
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

  const prevState: ThrottleState = lastDecision?.state ?? "ok";

  // Use per-threshold resume timestamps so the snapshot matches the effective state.
  const windowsForSnapshot = state === "hard" ? hardWindows : softWindows;

  const snapshot: ThrottleSnapshot = {
    computedAt: new Date(now).toISOString(),
    providerID,
    state,
    resumeAt: resumeAtTs ? new Date(resumeAtTs).toISOString() : null,
    windows: windowsForSnapshot,
  };

  if (prevState !== state) {
    const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
    const softParts = softWindows.map((w) => {
      const resetAt = w.resumeAtTs ? new Date(w.resumeAtTs).toISOString() : "unknown";
      return (
        `${w.name} used=${pct(w.usedPct)} usedTokens=${w.usedTokens} ` +
        `softCapTokens=${w.softCapTokens} hardCapTokens=${w.hardCapTokens} budgetTokens=${w.budgetTokens} ` +
        `resetAt=${resetAt}`
      );
    });

    if (state === "soft") {
      console.warn(`[ralph] Soft throttle enabled (${softParts.join("; ")}) resumeAt=${snapshot.resumeAt ?? "unknown"}`);
    } else if (prevState === "soft" && state === "ok") {
      console.warn(`[ralph] Soft throttle disabled (${softParts.join("; ")})`);
    }
  }

  if (state === "hard" && shouldLog(`throttle:${state}`, 60_000)) {
    console.warn(
      `[ralph:throttle] ${state} throttle active; resumeAt=${snapshot.resumeAt ?? "unknown"} ` +
        `5h=${hardWindows[0]?.usedTokens ?? 0}/${hardWindows[0]?.hardCapTokens ?? 0} ` +
        `week=${hardWindows[1]?.usedTokens ?? 0}/${hardWindows[1]?.hardCapTokens ?? 0}`
    );
  }

  lastDecision = { state, resumeAtTs, snapshot };
  return lastDecision;
}

export async function isHardThrottled(): Promise<{ hard: boolean; decision: ThrottleDecision }>{
  const decision = await getThrottleDecision();
  return { hard: decision.state === "hard", decision };
}
