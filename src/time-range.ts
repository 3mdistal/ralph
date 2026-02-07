export type ResolvedTimeRange = {
  sinceMs: number;
  untilMs: number;
};

export function parseDurationMs(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  switch (match[2]) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60_000;
    case "h":
      return amount * 60 * 60_000;
    case "d":
      return amount * 24 * 60 * 60_000;
    default:
      return null;
  }
}

export function parseTimestampMs(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "now") return nowMs;
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed);
    return Number.isFinite(ms) ? ms : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function resolveTimeRange(params: {
  sinceRaw: string | null;
  untilRaw: string | null;
  defaultSinceMs: number;
  nowMs?: number;
}): ResolvedTimeRange {
  const nowMs = params.nowMs ?? Date.now();
  const untilMs = parseTimestampMs(params.untilRaw, nowMs) ?? nowMs;

  const absSince = parseTimestampMs(params.sinceRaw, nowMs);
  if (absSince != null) return { sinceMs: absSince, untilMs };

  const dur = parseDurationMs(params.sinceRaw) ?? params.defaultSinceMs;
  return { sinceMs: untilMs - dur, untilMs };
}
