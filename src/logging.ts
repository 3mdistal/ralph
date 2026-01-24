type LogLimiterOptions = {
  maxKeys: number;
};

export class LogLimiter {
  private lastLogAt = new Map<string, number>();
  private maxKeys: number;

  constructor(options: LogLimiterOptions) {
    this.maxKeys = Math.max(1, options.maxKeys);
  }

  shouldLog(key: string, intervalMs: number, nowMs = Date.now()): boolean {
    const last = this.lastLogAt.get(key);
    if (last !== undefined && nowMs - last < intervalMs) return false;
    this.lastLogAt.delete(key);
    this.lastLogAt.set(key, nowMs);
    this.evict();
    return true;
  }

  private evict(): void {
    while (this.lastLogAt.size > this.maxKeys) {
      const oldestKey = this.lastLogAt.keys().next().value as string | undefined;
      if (!oldestKey) return;
      this.lastLogAt.delete(oldestKey);
    }
  }
}

const DEFAULT_LOG_LIMITER_MAX_KEYS = 2000;
const defaultLimiter = new LogLimiter({ maxKeys: DEFAULT_LOG_LIMITER_MAX_KEYS });

export function shouldLog(key: string, intervalMs: number): boolean {
  return defaultLimiter.shouldLog(key, intervalMs);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function wantsColor(): boolean {
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

export type LogLevel = "info" | "warn" | "error";

function color(level: LogLevel, text: string): string {
  if (!wantsColor()) return text;
  const reset = "\x1b[0m";
  const code =
    level === "error"
      ? "\x1b[31m"
      : level === "warn"
        ? "\x1b[33m"
        : "\x1b[36m";
  return `${code}${text}${reset}`;
}
