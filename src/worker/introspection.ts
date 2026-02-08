import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";

import { computeLiveAnomalyCountFromJsonl } from "../anomaly";
import { getProfile } from "../config";
import { cleanupSessionArtifacts } from "../introspection-traces";
import { isIntrospectionSummary, type IntrospectionSummary } from "../introspection/summary";
import { getRalphSessionDir, getSessionEventsPath } from "../paths";
import { isSafeSessionId } from "../session-id";

export interface LiveAnomalyCount {
  total: number;
  recentBurst: boolean;
}

export async function readIntrospectionSummary(sessionId: string): Promise<IntrospectionSummary | null> {
  if (!isSafeSessionId(sessionId)) return null;
  const summaryPath = join(getRalphSessionDir(sessionId), "summary.json");
  if (!existsSync(summaryPath)) return null;

  try {
    const content = await readFile(summaryPath, "utf8");
    const parsed = JSON.parse(content);
    return isIntrospectionSummary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read live anomaly count from the session's events.jsonl.
 * Returns total count and whether there's been a recent burst.
 */
export async function readLiveAnomalyCount(sessionId: string): Promise<LiveAnomalyCount> {
  if (!isSafeSessionId(sessionId)) return { total: 0, recentBurst: false };
  const eventsPath = getSessionEventsPath(sessionId);
  if (!existsSync(eventsPath)) return { total: 0, recentBurst: false };

  try {
    const content = await readFile(eventsPath, "utf8");
    return computeLiveAnomalyCountFromJsonl(content, Date.now());
  } catch {
    return { total: 0, recentBurst: false };
  }
}

export function hasRepeatedToolPattern(recentEvents?: string[]): boolean {
  if (!recentEvents?.length) return false;
  const counts = new Map<string, number>();

  for (const line of recentEvents) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object" || event.type !== "tool-start") continue;
    const toolName = String(event.toolName ?? "");
    if (!toolName) continue;
    const argsPreview = typeof event.argsPreview === "string" ? event.argsPreview : "";
    const key = `${toolName}:${argsPreview}`;
    const nextCount = (counts.get(key) ?? 0) + 1;
    if (nextCount >= 3) return true;
    counts.set(key, nextCount);
  }

  return false;
}

export async function cleanupIntrospectionLogs(sessionId: string): Promise<void> {
  if (getProfile() === "sandbox") return;
  try {
    await cleanupSessionArtifacts(sessionId);
  } catch (e) {
    console.warn(`[ralph:worker] Failed to cleanup introspection logs: ${e}`);
  }
}
