export interface LiveAnomalyCount {
  total: number;
  recentBurst: boolean;
}

/**
 * Compute anomaly burst status from a Ralph session events.jsonl file.
 *
 * This is intentionally a pure helper so tests can be deterministic.
 * Runtime behavior should remain identical to the previous inlined logic.
 */
export function computeLiveAnomalyCountFromJsonl(content: string, nowMs: number): LiveAnomalyCount {
  const lines = content.trim().split("\n").filter(Boolean);

  let total = 0;
  const recentAnomalies: number[] = [];
  const BURST_WINDOW_MS = 10000; // 10 seconds

  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (event.type === "anomaly") {
        total++;
        if (event.ts && nowMs - event.ts < BURST_WINDOW_MS) {
          recentAnomalies.push(event.ts);
        }
      }
    } catch {
      // ignore malformed lines
    }
  }

  // A burst is 20+ anomalies in the last 10 seconds
  const recentBurst = recentAnomalies.length >= 20;

  return { total, recentBurst };
}
