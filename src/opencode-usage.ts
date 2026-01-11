import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

export interface UsageWindowConfig {
  name: string;
  /** Window size in milliseconds (e.g. 5h, 7d). */
  durationMs: number;
  /** Upcoming reset time for this window. */
  resetAt: Date | string | number;
  /** Optional denominator for derived % used. */
  budgetTokens?: number;
}

export interface UsageWindowTokens {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Matches Codex dashboard calibration by default: input + output + reasoning. */
  dashboardTotal: number;
  /** dashboardTotal + cacheWeight*(cacheRead+cacheWrite). */
  weightedTotal: number;
}

export interface UsageWindowSnapshot {
  name: string;
  now: string;
  startAt: string;
  resetAt: string;
  timeToResetMs: number;
  messageCount: number;
  tokens: UsageWindowTokens;
  budgetTokens?: number;
  usedPct?: number;
}

export interface OpencodeUsageSnapshot {
  providerID: string;
  cacheWeight: number;
  now: string;
  messagesRootDir: string;
  scannedFiles: number;
  skippedFiles: number;
  countedMessages: number;
  windows: Record<string, UsageWindowSnapshot>;
}

export function getDefaultOpencodeMessagesRootDir(): string {
  return join(homedir(), ".local/share/opencode/storage/message");
}

function toFiniteNumber(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isFinite(value)) return 0;
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

    const asNumber = Number(trimmed);
    if (Number.isFinite(asNumber)) return parseTimestampMs(asNumber);

    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

async function listMessageFiles(rootDir: string): Promise<string[]> {
  if (!existsSync(rootDir)) return [];

  const out: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }

      if (entry.isFile() && entry.name.startsWith("msg_") && entry.name.endsWith(".json")) {
        out.push(full);
      }
    }
  };

  await walk(rootDir);
  return out;
}

type OpencodeMessage = {
  providerID?: unknown;
  role?: unknown;
  time?: { created?: unknown };
  tokens?: {
    input?: unknown;
    output?: unknown;
    reasoning?: unknown;
    cache?: { read?: unknown; write?: unknown };
  };
};

function getMessageCreatedAtMs(msg: OpencodeMessage): number | null {
  return parseTimestampMs(msg?.time?.created);
}

function getDashboardTokens(msg: OpencodeMessage): { input: number; output: number; reasoning: number } {
  return {
    input: toFiniteNumber(msg?.tokens?.input),
    output: toFiniteNumber(msg?.tokens?.output),
    reasoning: toFiniteNumber(msg?.tokens?.reasoning),
  };
}

function getCacheTokens(msg: OpencodeMessage): { read: number; write: number } {
  return {
    read: toFiniteNumber(msg?.tokens?.cache?.read),
    write: toFiniteNumber(msg?.tokens?.cache?.write),
  };
}

function buildEmptyWindowSnapshot(opts: {
  name: string;
  nowMs: number;
  startAtMs: number;
  resetAtMs: number;
  cacheWeight: number;
  budgetTokens?: number;
}): UsageWindowSnapshot {
  const nowIso = new Date(opts.nowMs).toISOString();
  const startIso = new Date(opts.startAtMs).toISOString();
  const resetIso = new Date(opts.resetAtMs).toISOString();
  const timeToResetMs = Math.max(0, opts.resetAtMs - opts.nowMs);

  const tokens: UsageWindowTokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    dashboardTotal: 0,
    weightedTotal: 0,
  };

  return {
    name: opts.name,
    now: nowIso,
    startAt: startIso,
    resetAt: resetIso,
    timeToResetMs,
    messageCount: 0,
    tokens,
    budgetTokens: opts.budgetTokens,
    usedPct: undefined,
  };
}

function finalizeWindowSnapshot(snapshot: UsageWindowSnapshot, cacheWeight: number): UsageWindowSnapshot {
  snapshot.tokens.dashboardTotal = snapshot.tokens.input + snapshot.tokens.output + snapshot.tokens.reasoning;
  snapshot.tokens.weightedTotal =
    snapshot.tokens.dashboardTotal + cacheWeight * (snapshot.tokens.cacheRead + snapshot.tokens.cacheWrite);

  if (typeof snapshot.budgetTokens === "number" && Number.isFinite(snapshot.budgetTokens) && snapshot.budgetTokens > 0) {
    snapshot.usedPct = snapshot.tokens.weightedTotal / snapshot.budgetTokens;
  }

  return snapshot;
}

export async function readOpencodeUsageSnapshot(opts: {
  now: Date | string | number;
  resetAt5h: Date | string | number;
  resetAt7d: Date | string | number;
  providerID?: string;
  cacheWeight?: number;
  messagesRootDir?: string;
  /** Default: 5h */
  duration5hMs?: number;
  /** Default: 7d */
  duration7dMs?: number;
  budget5hTokens?: number;
  budget7dTokens?: number;
}): Promise<OpencodeUsageSnapshot> {
  const providerID = opts.providerID ?? "openai";
  const cacheWeight = typeof opts.cacheWeight === "number" && Number.isFinite(opts.cacheWeight) ? opts.cacheWeight : 0;
  const messagesRootDir = opts.messagesRootDir ?? getDefaultOpencodeMessagesRootDir();

  const nowMs = parseTimestampMs(opts.now);
  if (nowMs == null) throw new Error("Invalid now timestamp");

  const resetAt5hMs = parseTimestampMs(opts.resetAt5h);
  if (resetAt5hMs == null) throw new Error("Invalid resetAt5h timestamp");

  const resetAt7dMs = parseTimestampMs(opts.resetAt7d);
  if (resetAt7dMs == null) throw new Error("Invalid resetAt7d timestamp");

  const duration5hMs =
    typeof opts.duration5hMs === "number" && Number.isFinite(opts.duration5hMs) ? opts.duration5hMs : 5 * 60 * 60 * 1000;
  const duration7dMs =
    typeof opts.duration7dMs === "number" && Number.isFinite(opts.duration7dMs) ? opts.duration7dMs : 7 * 24 * 60 * 60 * 1000;

  const start5hMs = resetAt5hMs - duration5hMs;
  const start7dMs = resetAt7dMs - duration7dMs;

  const windows: Record<string, UsageWindowSnapshot> = {
    rolling5h: buildEmptyWindowSnapshot({
      name: "rolling5h",
      nowMs,
      startAtMs: start5hMs,
      resetAtMs: resetAt5hMs,
      cacheWeight,
      budgetTokens: opts.budget5hTokens,
    }),
    rolling7d: buildEmptyWindowSnapshot({
      name: "rolling7d",
      nowMs,
      startAtMs: start7dMs,
      resetAtMs: resetAt7dMs,
      cacheWeight,
      budgetTokens: opts.budget7dTokens,
    }),
  };

  const files = await listMessageFiles(messagesRootDir);

  let scannedFiles = 0;
  let skippedFiles = 0;
  let countedMessages = 0;

  for (const path of files) {
    scannedFiles++;

    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      skippedFiles++;
      continue;
    }

    let msg: OpencodeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      skippedFiles++;
      continue;
    }

    if (msg.providerID !== providerID) continue;
    if (msg.role !== "assistant") continue;

    const createdAtMs = getMessageCreatedAtMs(msg);
    if (createdAtMs == null) continue;
    if (createdAtMs > nowMs) continue;

    const dash = getDashboardTokens(msg);
    const cache = getCacheTokens(msg);

    const in5h = createdAtMs >= start5hMs && createdAtMs <= nowMs;
    const in7d = createdAtMs >= start7dMs && createdAtMs <= nowMs;
    if (!in5h && !in7d) continue;

    countedMessages++;

    if (in5h) {
      const w = windows.rolling5h;
      w.messageCount++;
      w.tokens.input += dash.input;
      w.tokens.output += dash.output;
      w.tokens.reasoning += dash.reasoning;
      w.tokens.cacheRead += cache.read;
      w.tokens.cacheWrite += cache.write;
    }

    if (in7d) {
      const w = windows.rolling7d;
      w.messageCount++;
      w.tokens.input += dash.input;
      w.tokens.output += dash.output;
      w.tokens.reasoning += dash.reasoning;
      w.tokens.cacheRead += cache.read;
      w.tokens.cacheWrite += cache.write;
    }
  }

  finalizeWindowSnapshot(windows.rolling5h, cacheWeight);
  finalizeWindowSnapshot(windows.rolling7d, cacheWeight);

  return {
    providerID,
    cacheWeight,
    now: new Date(nowMs).toISOString(),
    messagesRootDir,
    scannedFiles,
    skippedFiles,
    countedMessages,
    windows,
  };
}
