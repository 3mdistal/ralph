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

  /** Inclusive start timestamp used for counting in this window (best-effort). */
  windowStartTs?: number | null;
  /** Exclusive end timestamp used for counting in this window (best-effort). */
  windowEndTs?: number | null;

  budgetTokens: number;
  softCapTokens: number;
  hardCapTokens: number;
  usedTokens: number;
  usedPct: number;
  oldestTsInWindow: number | null;
  resumeAtTs: number | null;

  /** Weekly reset metadata (only set when weekly reset is configured). */
  weeklyLastResetTs?: number | null;
  weeklyNextResetTs?: number | null;
  weeklyResetTimeZone?: string | null;
  weeklyResetDayOfWeek?: number | null;
  weeklyResetHour?: number | null;
  weeklyResetMinute?: number | null;

  softResumeAtTs?: number | null;
  hardResumeAtTs?: number | null;
}

export interface ThrottleSnapshot {
  computedAt: string;
  providerID: string;

  /** Best-effort, config-selected profile name (for debugging). */
  opencodeProfile?: string | null;

  /** Best-effort, XDG_DATA_HOME used to compute scan paths (for debugging). */
  xdgDataHome?: string;

  /** Best-effort, messages root scanned for usage (for debugging). */
  messagesRootDir?: string;

  /** Best-effort, OpenCode auth file path (for debugging). */
  authFilePath?: string;
  authFileExists?: boolean;

  /** Best-effort scan diagnostics (helps validate profile usage is measured). */
  messagesRootDirExists?: boolean;
  scannedSessionDirs?: number;
  scannedFiles?: number;
  parsedFiles?: number;
  newestMessageTs?: number | null;
  newestMessageAt?: string | null;
  newestCountedEventTs?: number | null;

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

const ROLLING_5H_MS = 5 * 60 * 60 * 1000;
const ROLLING_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_BUDGET_5H_TOKENS = 16_987_015;
const DEFAULT_BUDGET_WEEKLY_TOKENS = 55_769_305;

const DEFAULT_SOFT_PCT = 0.65;
const DEFAULT_HARD_PCT = 0.75;

const DEFAULT_MIN_CHECK_INTERVAL_MS = 15_000;

type ThrottleCacheEntry = { lastCheckedAt: number; lastDecision: ThrottleDecision | null };
const decisionCache = new Map<string, ThrottleCacheEntry>();

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  const fromTime = parseTimestampMs(message?.time?.created);
  if (fromTime != null) return fromTime;

  const fromCreated = parseTimestampMs(message?.created);
  if (fromCreated != null) return fromCreated;

  const fromTs = parseTimestampMs(message?.ts);
  if (fromTs != null) return fromTs;

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
    return entries
      .filter((e) => e.isFile() && e.name.startsWith("msg_") && e.name.endsWith(".json"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export type UsageScanStats = {
  messagesRootDirExists: boolean;
  scannedSessionDirs: number;
  scannedFiles: number;
  parsedFiles: number;
  newestMessageTs: number | null;
  newestCountedEventTs: number | null;
};

export async function scanOpencodeUsageEvents(
  now: number,
  providerID: string,
  messagesRoot: string,
  maxWindowMs: number
): Promise<{ events: { ts: number; tokens: number }[]; stats: UsageScanStats }> {
  const stats: UsageScanStats = {
    messagesRootDirExists: false,
    scannedSessionDirs: 0,
    scannedFiles: 0,
    parsedFiles: 0,
    newestMessageTs: null,
    newestCountedEventTs: null,
  };

  if (!existsSync(messagesRoot)) return { events: [], stats };
  stats.messagesRootDirExists = true;

  const oldestStart = now - maxWindowMs;

  const events: { ts: number; tokens: number }[] = [];

  const sessionDirs = await listSessionDirs(messagesRoot);
  stats.scannedSessionDirs = sessionDirs.length;

  for (const session of sessionDirs) {
    const sessionDir = join(messagesRoot, session);
    const files = await listJsonFiles(sessionDir);

    for (const file of files) {
      const path = join(sessionDir, file);
      stats.scannedFiles++;

      try {
        const raw = await readFile(path, "utf8");
        const msg = JSON.parse(raw);
        stats.parsedFiles++;

        const ts = extractCreatedTs(msg);
        if (ts == null) continue;

        if (stats.newestMessageTs == null || ts > stats.newestMessageTs) stats.newestMessageTs = ts;
        if (ts < oldestStart) continue;

        const role = extractRole(msg);
        if (role && role !== "assistant") continue;

        const msgProvider = extractProviderId(msg);
        if (msgProvider && msgProvider !== providerID) continue;

        const tokens = extractTokenCount(msg);
        if (tokens <= 0) continue;

        events.push({ ts, tokens });
        if (stats.newestCountedEventTs == null || ts > stats.newestCountedEventTs) stats.newestCountedEventTs = ts;
      } catch {
        // ignore malformed message files
      }
    }
  }

  return { events, stats };
}

type WeeklyResetSchedule = {
  dayOfWeek: number;
  hour: number;
  minute: number;
  timeZone: string;
};

type Ymd = { year: number; month: number; day: number };

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dayOfWeek: number; // 0=Sun..6=Sat
};

const WEEKDAY_TO_IDX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getSystemTimeZone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return typeof tz === "string" && tz.trim() ? tz.trim() : "UTC";
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });

  const parts = fmt.formatToParts(date);
  const lookup: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== "literal") lookup[p.type] = p.value;
  }

  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  const hour = Number(lookup.hour);
  const minute = Number(lookup.minute);
  const second = Number(lookup.second);
  const weekdayRaw = lookup.weekday;
  const dayOfWeek = WEEKDAY_TO_IDX[weekdayRaw] ?? 0;

  return { year, month, day, hour, minute, second, dayOfWeek };
}

function tzOffsetMs(at: Date, timeZone: string): number {
  const p = getZonedParts(at, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - at.getTime();
}

function shiftYmd(ymd: Ymd, deltaDays: number): Ymd {
  const base = Date.UTC(ymd.year, ymd.month - 1, ymd.day);
  const shifted = new Date(base + deltaDays * 24 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function zonedDateTimeToInstantMs(args: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
  timeZone: string;
}): number {
  const guessUTC = Date.UTC(args.year, args.month - 1, args.day, args.hour, args.minute, args.second ?? 0);

  let t = guessUTC;
  for (let i = 0; i < 3; i++) {
    const offset = tzOffsetMs(new Date(t), args.timeZone);
    t = guessUTC - offset;
  }
  return t;
}

function resolveWeeklyResetSchedule(opts: { global?: any; perProfile?: any }): WeeklyResetSchedule {
  const systemTz = getSystemTimeZone();
  const raw = (opts.perProfile?.reset?.weekly ?? opts.global?.reset?.weekly ?? {}) as any;

  const dayOfWeek =
    typeof raw?.dayOfWeek === "number" && Number.isFinite(raw.dayOfWeek) ? Math.max(0, Math.min(6, Math.floor(raw.dayOfWeek))) : 4;
  const hour = typeof raw?.hour === "number" && Number.isFinite(raw.hour) ? Math.max(0, Math.min(23, Math.floor(raw.hour))) : 19;
  const minute = typeof raw?.minute === "number" && Number.isFinite(raw.minute) ? Math.max(0, Math.min(59, Math.floor(raw.minute))) : 9;

  const tzRaw = typeof raw?.timeZone === "string" && raw.timeZone.trim() ? raw.timeZone.trim() : systemTz;

  return { dayOfWeek, hour, minute, timeZone: tzRaw };
}

function computeWeeklyResetBoundaries(nowMs: number, schedule: WeeklyResetSchedule): { lastResetTs: number; nextResetTs: number } {
  const now = new Date(nowMs);
  const zonedNow = getZonedParts(now, schedule.timeZone);
  const nowMinutes = zonedNow.hour * 60 + zonedNow.minute + zonedNow.second / 60;
  const resetMinutes = schedule.hour * 60 + schedule.minute;

  const deltaForward = (schedule.dayOfWeek - zonedNow.dayOfWeek + 7) % 7;

  const todayYmd: Ymd = { year: zonedNow.year, month: zonedNow.month, day: zonedNow.day };
  const nextResetYmd = shiftYmd(todayYmd, deltaForward);

  const candidateNextResetTs = zonedDateTimeToInstantMs({
    ...nextResetYmd,
    hour: schedule.hour,
    minute: schedule.minute,
    second: 0,
    timeZone: schedule.timeZone,
  });

  const isTodayResetDay = deltaForward === 0;
  const beforeResetToday = isTodayResetDay && nowMinutes < resetMinutes;

  if (beforeResetToday || deltaForward > 0) {
    const lastYmd = shiftYmd(nextResetYmd, -7);
    const lastResetTs = zonedDateTimeToInstantMs({
      ...lastYmd,
      hour: schedule.hour,
      minute: schedule.minute,
      second: 0,
      timeZone: schedule.timeZone,
    });
    return { lastResetTs, nextResetTs: candidateNextResetTs };
  }

  const nextYmd = shiftYmd(nextResetYmd, 7);
  const nextResetTs = zonedDateTimeToInstantMs({
    ...nextYmd,
    hour: schedule.hour,
    minute: schedule.minute,
    second: 0,
    timeZone: schedule.timeZone,
  });
  return { lastResetTs: candidateNextResetTs, nextResetTs };
}

function computeFixedWeeklySnapshot(opts: {
  now: number;
  events: { ts: number; tokens: number }[];
  budgetTokens: number;
  softPct: number;
  hardPct: number;
  threshold: "soft" | "hard";
  schedule: WeeklyResetSchedule;
  boundaries: { lastResetTs: number; nextResetTs: number };
}): ThrottleWindowSnapshot {
  const inWindow = opts.events.filter((e) => e.ts >= opts.boundaries.lastResetTs);

  let usedTokens = 0;
  let oldestTs: number | null = null;
  for (const e of inWindow) {
    usedTokens += e.tokens;
    if (oldestTs === null || e.ts < oldestTs) oldestTs = e.ts;
  }

  const softCapTokens = Math.floor(opts.budgetTokens * opts.softPct);
  const hardCapTokens = Math.floor(opts.budgetTokens * opts.hardPct);
  const cap = opts.threshold === "hard" ? hardCapTokens : softCapTokens;

  const resumeAtTs = usedTokens >= cap ? opts.boundaries.nextResetTs : null;

  return {
    name: "weekly",
    windowMs: ROLLING_WEEKLY_MS,
    windowStartTs: opts.boundaries.lastResetTs,
    windowEndTs: opts.boundaries.nextResetTs,
    budgetTokens: opts.budgetTokens,
    softCapTokens,
    hardCapTokens,
    usedTokens,
    usedPct: opts.budgetTokens > 0 ? usedTokens / opts.budgetTokens : 0,
    oldestTsInWindow: oldestTs,
    resumeAtTs,
    weeklyLastResetTs: opts.boundaries.lastResetTs,
    weeklyNextResetTs: opts.boundaries.nextResetTs,
    weeklyResetTimeZone: opts.schedule.timeZone,
    weeklyResetDayOfWeek: opts.schedule.dayOfWeek,
    weeklyResetHour: opts.schedule.hour,
    weeklyResetMinute: opts.schedule.minute,
  };
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
    windowStartTs: start,
    windowEndTs: opts.now,
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
  xdgDataHome: string;
  messagesRootDir: string;
} {
  const requested = (opencodeProfile ?? "").trim();
  if (requested) {
    const resolved = resolveOpencodeProfile(requested);
    if (resolved) {
      return {
        effectiveProfile: resolved.name,
        xdgDataHome: resolved.xdgDataHome,
        messagesRootDir: join(resolved.xdgDataHome, "opencode", "storage", "message"),
      };
    }

    // Unknown profile: fall back to ambient XDG dirs.
    const xdgDataHome = resolveDefaultXdgDataHome();
    return { effectiveProfile: null, xdgDataHome, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
  }

  // No explicit profile: prefer configured default profile if enabled.
  const resolvedDefault = resolveOpencodeProfile(null);
  if (resolvedDefault) {
    return {
      effectiveProfile: resolvedDefault.name,
      xdgDataHome: resolvedDefault.xdgDataHome,
      messagesRootDir: join(resolvedDefault.xdgDataHome, "opencode", "storage", "message"),
    };
  }

  const xdgDataHome = resolveDefaultXdgDataHome();
  return { effectiveProfile: null, xdgDataHome, messagesRootDir: join(xdgDataHome, "opencode", "storage", "message") };
}

export async function getThrottleDecision(
  now: number = Date.now(),
  opts?: { opencodeProfile?: string | null }
): Promise<ThrottleDecision> {
  const cfg = loadConfig().throttle;

  const { effectiveProfile, xdgDataHome, messagesRootDir } = resolveOpencodeMessagesRootDir(opts?.opencodeProfile);
  const perProfileCfg = effectiveProfile ? cfg?.perProfile?.[effectiveProfile] : undefined;

  const enabled = perProfileCfg?.enabled ?? cfg?.enabled ?? true;

  const providerID =
    String(perProfileCfg?.providerID ?? cfg?.providerID ?? DEFAULT_PROVIDER_ID).trim() || DEFAULT_PROVIDER_ID;

  const softPct =
    typeof perProfileCfg?.softPct === "number" && Number.isFinite(perProfileCfg.softPct)
      ? perProfileCfg.softPct
      : typeof cfg?.softPct === "number" && Number.isFinite(cfg.softPct)
        ? cfg.softPct
        : DEFAULT_SOFT_PCT;

  const hardPct =
    typeof perProfileCfg?.hardPct === "number" && Number.isFinite(perProfileCfg.hardPct)
      ? perProfileCfg.hardPct
      : typeof cfg?.hardPct === "number" && Number.isFinite(cfg.hardPct)
        ? cfg.hardPct
        : DEFAULT_HARD_PCT;

  const minCheckIntervalMs =
    typeof perProfileCfg?.minCheckIntervalMs === "number" && Number.isFinite(perProfileCfg.minCheckIntervalMs)
      ? Math.max(0, Math.floor(perProfileCfg.minCheckIntervalMs))
      : typeof cfg?.minCheckIntervalMs === "number" && Number.isFinite(cfg.minCheckIntervalMs)
        ? Math.max(0, Math.floor(cfg.minCheckIntervalMs))
        : DEFAULT_MIN_CHECK_INTERVAL_MS;

  const budget5hTokens =
    typeof perProfileCfg?.windows?.rolling5h?.budgetTokens === "number" && Number.isFinite(perProfileCfg.windows.rolling5h.budgetTokens)
      ? perProfileCfg.windows.rolling5h.budgetTokens
      : typeof cfg?.windows?.rolling5h?.budgetTokens === "number" && Number.isFinite(cfg.windows.rolling5h.budgetTokens)
        ? cfg.windows.rolling5h.budgetTokens
        : DEFAULT_BUDGET_5H_TOKENS;

  const budgetWeeklyTokens =
    typeof perProfileCfg?.windows?.weekly?.budgetTokens === "number" && Number.isFinite(perProfileCfg.windows.weekly.budgetTokens)
      ? perProfileCfg.windows.weekly.budgetTokens
      : typeof cfg?.windows?.weekly?.budgetTokens === "number" && Number.isFinite(cfg.windows.weekly.budgetTokens)
        ? cfg.windows.weekly.budgetTokens
        : DEFAULT_BUDGET_WEEKLY_TOKENS;

  const hasWeeklyResetCfg = !!(perProfileCfg?.reset?.weekly || cfg?.reset?.weekly);
  const weeklySchedule = hasWeeklyResetCfg ? resolveWeeklyResetSchedule({ global: cfg, perProfile: perProfileCfg }) : null;
  const weeklyBoundaries = weeklySchedule ? computeWeeklyResetBoundaries(now, weeklySchedule) : null;

  const windows = [
    { name: "rolling5h", windowMs: ROLLING_5H_MS, budgetTokens: budget5hTokens },
    { name: "weekly", windowMs: ROLLING_WEEKLY_MS, budgetTokens: budgetWeeklyTokens },
  ];

  const cacheKey =
    `${providerID}|${messagesRootDir}|` +
    `b5h=${budget5hTokens}|bw=${budgetWeeklyTokens}|soft=${softPct}|hard=${hardPct}|enabled=${enabled}`;

  const cached = decisionCache.get(cacheKey);
  if (cached?.lastDecision && now - cached.lastCheckedAt < minCheckIntervalMs) return cached.lastDecision;

  const prevState: ThrottleState = cached?.lastDecision?.state ?? "ok";

  const weeklyLookbackMs = weeklyBoundaries ? Math.max(0, now - weeklyBoundaries.lastResetTs) : ROLLING_WEEKLY_MS;
  const maxWindowMs = Math.max(ROLLING_5H_MS, ROLLING_WEEKLY_MS, weeklyLookbackMs) + 2 * 60 * 60 * 1000;
  const usage =
    enabled
      ? await scanOpencodeUsageEvents(now, providerID, messagesRootDir, maxWindowMs)
      : {
          events: [],
          stats: {
            messagesRootDirExists: existsSync(messagesRootDir),
            scannedSessionDirs: 0,
            scannedFiles: 0,
            parsedFiles: 0,
            newestMessageTs: null,
            newestCountedEventTs: null,
          },
        };
  const events = usage.events;

  // First compute hard/soft separately so the snapshot includes both caps.
  const hardRolling5h = computeWindowSnapshot({
    now,
    events,
    name: "rolling5h",
    windowMs: ROLLING_5H_MS,
    budgetTokens: budget5hTokens,
    softPct,
    hardPct,
    threshold: "hard",
  });

  const softRolling5h = computeWindowSnapshot({
    now,
    events,
    name: "rolling5h",
    windowMs: ROLLING_5H_MS,
    budgetTokens: budget5hTokens,
    softPct,
    hardPct,
    threshold: "soft",
  });

  const hardWeekly = weeklySchedule && weeklyBoundaries
    ? computeFixedWeeklySnapshot({
        now,
        events,
        budgetTokens: budgetWeeklyTokens,
        softPct,
        hardPct,
        threshold: "hard",
        schedule: weeklySchedule,
        boundaries: weeklyBoundaries,
      })
    : computeWindowSnapshot({
        now,
        events,
        name: "weekly",
        windowMs: ROLLING_WEEKLY_MS,
        budgetTokens: budgetWeeklyTokens,
        softPct,
        hardPct,
        threshold: "hard",
      });

  const softWeekly = weeklySchedule && weeklyBoundaries
    ? computeFixedWeeklySnapshot({
        now,
        events,
        budgetTokens: budgetWeeklyTokens,
        softPct,
        hardPct,
        threshold: "soft",
        schedule: weeklySchedule,
        boundaries: weeklyBoundaries,
      })
    : computeWindowSnapshot({
        now,
        events,
        name: "weekly",
        windowMs: ROLLING_WEEKLY_MS,
        budgetTokens: budgetWeeklyTokens,
        softPct,
        hardPct,
        threshold: "soft",
      });

  const hardWindows = [hardRolling5h, hardWeekly];
  const softWindows = [softRolling5h, softWeekly];

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

  const authFilePath = join(xdgDataHome, "opencode", "auth.json");
  const authFileExists = existsSync(authFilePath);

  const newestMessageAt = usage.stats.newestMessageTs != null ? new Date(usage.stats.newestMessageTs).toISOString() : null;

  const snapshot: ThrottleSnapshot = {
    computedAt: new Date(now).toISOString(),
    providerID,
    opencodeProfile: effectiveProfile,
    xdgDataHome,
    messagesRootDir,
    authFilePath,
    authFileExists,
    messagesRootDirExists: usage.stats.messagesRootDirExists,
    scannedSessionDirs: usage.stats.scannedSessionDirs,
    scannedFiles: usage.stats.scannedFiles,
    parsedFiles: usage.stats.parsedFiles,
    newestMessageTs: usage.stats.newestMessageTs,
    newestMessageAt,
    newestCountedEventTs: usage.stats.newestCountedEventTs,
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

export function __computeWeeklyResetBoundariesForTests(
  nowMs: number,
  schedule: { dayOfWeek: number; hour: number; minute: number; timeZone: string }
): { lastResetTs: number; nextResetTs: number } {
  return computeWeeklyResetBoundaries(nowMs, schedule);
}

