import type { ThrottleConfig, ThrottleResetRolling5hConfig, ThrottleResetWeeklyConfig } from "../config";
import { loadConfig } from "../config";
import { readOpenCodeUsageTotals } from "./opencode-usage";

export type SoftThrottleMode = "running" | "soft-throttled";

export interface SoftThrottleWindowSnapshot {
  window: "rolling5h" | "weekly";
  usedTokens: number;
  budgetTokens: number;
  softCapTokens: number;
  usedPct: number;
  softPct: number;
  resetAt: string;
}

export interface SoftThrottleSnapshot {
  checkedAt: string;
  mode: SoftThrottleMode;
  resumeAt: string | null;
  windows: SoftThrottleWindowSnapshot[];
}

export interface SoftThrottleDecision {
  enabled: boolean;
  mode: SoftThrottleMode;
  snapshot: SoftThrottleSnapshot | null;
}

function toPositiveFiniteNumberOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0) return null;
  return value;
}

function toFractionOrNull(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value <= 0 || value >= 1) return null;
  return value;
}

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(1, pct));
}

function formatPct(value: number): number {
  return Math.round(value * 10_000) / 100;
}

function toLocalBoundary(now: Date, hour: number, minute: number, dayOffset: number): Date {
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

function resolveRolling5hReset(cfg?: ThrottleResetRolling5hConfig): { hours: number[]; minute: number } {
  const hoursRaw = Array.isArray(cfg?.hours) ? cfg!.hours : null;
  const hours = (hoursRaw ?? [1, 6, 11, 16, 21])
    .filter((h) => typeof h === "number" && Number.isInteger(h) && h >= 0 && h <= 23)
    .sort((a, b) => a - b);

  const minute = typeof cfg?.minute === "number" && Number.isInteger(cfg.minute) && cfg.minute >= 0 && cfg.minute <= 59 ? cfg.minute : 50;

  // Ensure at least one boundary.
  return { hours: hours.length > 0 ? hours : [1, 6, 11, 16, 21], minute };
}

function resolveWeeklyReset(cfg?: ThrottleResetWeeklyConfig): { dayOfWeek: number; hour: number; minute: number } {
  const dayOfWeek =
    typeof cfg?.dayOfWeek === "number" && Number.isInteger(cfg.dayOfWeek) && cfg.dayOfWeek >= 0 && cfg.dayOfWeek <= 6
      ? cfg.dayOfWeek
      : 4;

  const hour = typeof cfg?.hour === "number" && Number.isInteger(cfg.hour) && cfg.hour >= 0 && cfg.hour <= 23 ? cfg.hour : 19;
  const minute = typeof cfg?.minute === "number" && Number.isInteger(cfg.minute) && cfg.minute >= 0 && cfg.minute <= 59 ? cfg.minute : 9;

  return { dayOfWeek, hour, minute };
}

function computeRolling5hBounds(now: Date, cfg?: ThrottleResetRolling5hConfig): { startMs: number; resetAt: Date } {
  const { hours, minute } = resolveRolling5hReset(cfg);

  const candidatesToday = hours.map((h) => toLocalBoundary(now, h, minute, 0));
  const lastToday = [...candidatesToday].reverse().find((d) => d.getTime() <= now.getTime());

  let start: Date;
  if (lastToday) start = lastToday;
  else start = toLocalBoundary(now, hours[hours.length - 1]!, minute, -1);

  // Next reset is the next boundary after 'now'.
  const nextToday = candidatesToday.find((d) => d.getTime() > now.getTime());
  const resetAt = nextToday ?? toLocalBoundary(now, hours[0]!, minute, 1);

  return { startMs: start.getTime(), resetAt };
}

function computeWeeklyBounds(now: Date, cfg?: ThrottleResetWeeklyConfig): { startMs: number; resetAt: Date } {
  const { dayOfWeek, hour, minute } = resolveWeeklyReset(cfg);

  // Find the most recent reset boundary.
  const todayDow = now.getDay();
  const daysSince = (todayDow - dayOfWeek + 7) % 7;
  let start = toLocalBoundary(now, hour, minute, -daysSince);
  if (start.getTime() > now.getTime()) start = toLocalBoundary(now, hour, minute, -daysSince - 7);

  const resetAt = toLocalBoundary(start, hour, minute, 7);
  return { startMs: start.getTime(), resetAt };
}

function resolveSoftThrottleConfig(raw?: ThrottleConfig): {
  enabled: boolean;
  providerID: string;
  softPct: number;
  minCheckIntervalMs: number;
  budgets: { rolling5h: number; weekly: number };
  reset: { rolling5h?: ThrottleResetRolling5hConfig; weekly?: ThrottleResetWeeklyConfig };
} {
  const enabled = raw?.enabled !== false;
  const providerID = typeof raw?.providerID === "string" && raw.providerID.trim() ? raw.providerID.trim() : "openai";

  const softPct = toFractionOrNull(raw?.softPct) ?? 0.65;
  const minCheckIntervalMs =
    typeof raw?.minCheckIntervalMs === "number" && Number.isFinite(raw.minCheckIntervalMs) && raw.minCheckIntervalMs >= 0
      ? raw.minCheckIntervalMs
      : 15_000;

  const defaultRolling5h = 16_987_015;
  const defaultWeekly = 55_769_305;

  const rolling5hBudget = toPositiveFiniteNumberOrNull(raw?.windows?.rolling5h?.budgetTokens) ?? defaultRolling5h;
  const weeklyBudget = toPositiveFiniteNumberOrNull(raw?.windows?.weekly?.budgetTokens) ?? defaultWeekly;

  return {
    enabled,
    providerID,
    softPct,
    minCheckIntervalMs,
    budgets: { rolling5h: rolling5hBudget, weekly: weeklyBudget },
    reset: { rolling5h: raw?.reset?.rolling5h, weekly: raw?.reset?.weekly },
  };
}

export async function getSoftThrottleDecision(opts?: {
  now?: Date;
  throttle?: ThrottleConfig;
  homeDir?: string;
}): Promise<SoftThrottleDecision> {
  const now = opts?.now ?? new Date();
  const throttle = opts?.throttle ?? loadConfig().throttle;
  const cfg = resolveSoftThrottleConfig(throttle);

  if (!cfg.enabled) {
    return { enabled: false, mode: "running", snapshot: null };
  }

  const rolling = computeRolling5hBounds(now, cfg.reset.rolling5h);
  const weekly = computeWeeklyBounds(now, cfg.reset.weekly);

  const totals = await readOpenCodeUsageTotals({
    providerID: cfg.providerID,
    rolling5hStartMs: rolling.startMs,
    weeklyStartMs: weekly.startMs,
    homeDir: opts?.homeDir,
  });

  if (!totals) {
    return { enabled: true, mode: "running", snapshot: null };
  }

  const windows: SoftThrottleWindowSnapshot[] = [
    {
      window: "rolling5h",
      usedTokens: totals.rolling5hTokens,
      budgetTokens: cfg.budgets.rolling5h,
      softCapTokens: cfg.softPct * cfg.budgets.rolling5h,
      usedPct: formatPct(clampPct(totals.rolling5hTokens / cfg.budgets.rolling5h)),
      softPct: formatPct(cfg.softPct),
      resetAt: rolling.resetAt.toISOString(),
    },
    {
      window: "weekly",
      usedTokens: totals.weeklyTokens,
      budgetTokens: cfg.budgets.weekly,
      softCapTokens: cfg.softPct * cfg.budgets.weekly,
      usedPct: formatPct(clampPct(totals.weeklyTokens / cfg.budgets.weekly)),
      softPct: formatPct(cfg.softPct),
      resetAt: weekly.resetAt.toISOString(),
    },
  ];

  const triggered = windows.filter((w) => w.usedTokens >= w.softCapTokens);
  const mode: SoftThrottleMode = triggered.length > 0 ? "soft-throttled" : "running";

  let resumeAt: string | null = null;
  if (mode === "soft-throttled") {
    const resetTimes = triggered.map((w) => Date.parse(w.resetAt)).filter((ms) => Number.isFinite(ms));
    if (resetTimes.length > 0) {
      const maxResetMs = Math.max(...resetTimes);
      resumeAt = new Date(maxResetMs).toISOString();
    }
  }

  return {
    enabled: true,
    mode,
    snapshot: {
      checkedAt: now.toISOString(),
      mode,
      resumeAt,
      windows,
    },
  };
}

export class SoftThrottleMonitor {
  private mode: SoftThrottleMode = "running";
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private initialized = false;
  private checkInFlight = false;

  private lastCheckAtMs = 0;
  private lastDecision: SoftThrottleDecision | null = null;

  constructor(
    private readonly options: {
      pollIntervalMs?: number;
      homeDir?: string;
      log?: (message: string) => void;
      onModeChange?: (mode: SoftThrottleMode) => void;
    } = {}
  ) {}

  start(): void {
    if (this.pollTimer) return;

    const pollIntervalMs = this.options.pollIntervalMs ?? 5_000;
    this.pollOnce();

    this.pollTimer = setInterval(() => {
      this.pollOnce();
    }, pollIntervalMs);
  }

  stop(): void {
    if (!this.pollTimer) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  getMode(): SoftThrottleMode {
    return this.mode;
  }

  getLastSnapshot(): SoftThrottleSnapshot | null {
    return this.lastDecision?.snapshot ?? null;
  }

  private formatTransitionLog(mode: SoftThrottleMode, snapshot: SoftThrottleSnapshot): string {
    const parts = snapshot.windows.map((w) => {
      const usedPct = w.usedPct.toFixed(2);
      const softPct = w.softPct.toFixed(2);
      const usedTokens = Math.round(w.usedTokens);
      const softCapTokens = Math.round(w.softCapTokens);
      const budgetTokens = Math.round(w.budgetTokens);
      return `${w.window} used=${usedPct}% usedTokens=${usedTokens} softCapTokens=${softCapTokens} budgetTokens=${budgetTokens} soft=${softPct}% resetAt=${w.resetAt}`;
    });

    if (mode === "soft-throttled") {
      const resume = snapshot.resumeAt ? ` resumeAt=${snapshot.resumeAt}` : "";
      return `[ralph] Soft throttle enabled (${parts.join("; ")})${resume}`;
    }

    return `[ralph] Soft throttle disabled (${parts.join("; ")})`;
  }

  private pollOnce(): void {
    if (this.checkInFlight) return;
    this.checkInFlight = true;

    void this.pollOnceAsync()
      .catch(() => {
        // ignore
      })
      .finally(() => {
        this.checkInFlight = false;
      });
  }

  private async pollOnceAsync(): Promise<void> {
    const cfg = resolveSoftThrottleConfig(loadConfig().throttle);
    const now = Date.now();

    let decision: SoftThrottleDecision;
    if (this.lastDecision && now - this.lastCheckAtMs < cfg.minCheckIntervalMs) {
      decision = this.lastDecision;
    } else {
      decision = await getSoftThrottleDecision({ homeDir: this.options.homeDir });
      this.lastCheckAtMs = now;
      this.lastDecision = decision;
    }

    const nextMode: SoftThrottleMode = decision.enabled ? decision.mode : "running";

    if (!this.initialized) {
      this.initialized = true;
      this.mode = nextMode;
      if (nextMode === "soft-throttled" && decision.snapshot) {
        this.options.log?.(this.formatTransitionLog(nextMode, decision.snapshot));
      }
      return;
    }

    if (nextMode === this.mode) return;

    this.mode = nextMode;
    if (decision.snapshot) {
      this.options.log?.(this.formatTransitionLog(nextMode, decision.snapshot));
    }
    this.options.onModeChange?.(this.mode);
  }
}
