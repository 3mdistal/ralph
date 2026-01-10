const lastLogAt = new Map<string, number>();

export function shouldLog(key: string, intervalMs: number): boolean {
  const now = Date.now();
  const last = lastLogAt.get(key) ?? 0;
  if (now - last < intervalMs) return false;
  lastLogAt.set(key, now);
  return true;
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
