export function parseHeartbeatMs(value?: string): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isHeartbeatStale(value: string | undefined, nowMs: number, ttlMs: number): boolean {
  const parsed = parseHeartbeatMs(value);
  if (parsed === null) return true;
  return nowMs - parsed > ttlMs;
}

export function canActOnTask(
  task: { "daemon-id"?: string; "heartbeat-at"?: string },
  daemonId: string,
  nowMs: number,
  ttlMs: number
): boolean {
  const owner = task["daemon-id"]?.trim() ?? "";
  if (owner && owner === daemonId) return true;
  return isHeartbeatStale(task["heartbeat-at"], nowMs, ttlMs);
}

export function computeHeartbeatIntervalMs(ttlMs: number): number {
  const base = Math.min(10_000, Math.floor(ttlMs / 3));
  const bounded = Math.max(2_000, base);
  return Math.min(60_000, bounded);
}
