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
  const base = Math.floor(ttlMs / 3);
  const minInterval = 2_000;
  const maxInterval = ttlMs <= 60_000 ? 10_000 : 60_000;
  return Math.min(maxInterval, Math.max(minInterval, base));
}
