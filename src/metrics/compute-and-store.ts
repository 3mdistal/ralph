import {
  getRalphRunTokenTotals,
  listRalphRunSessionIds,
  listRalphRunSessionTokenTotals,
  recordRalphRunMetrics,
  recordRalphRunStepMetrics,
} from "../state";
import { getSessionEventsPath, getSessionEventsPathFromDir } from "../paths";
import { isAbsolute, join } from "path";
import { aggregateRunMetrics, computeSessionMetrics } from "./core";
import { readSessionEventLines } from "./io";
import { parseEventsFromLines } from "./parse";
import type { MetricsQuality, SessionMetrics } from "./types";

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIME_BUDGET_MS = 4_000;

const QUALITY_RANK: Record<MetricsQuality, number> = {
  ok: 1,
  partial: 2,
  missing: 3,
  too_large: 4,
  timeout: 5,
  error: 6,
};

function normalizeQuality(params: {
  missing: boolean;
  tooLarge: boolean;
  timedOut: boolean;
  error: boolean;
  parseErrorCount: number;
}): MetricsQuality {
  if (params.error) return "error";
  if (params.timedOut) return "timeout";
  if (params.tooLarge) return "too_large";
  if (params.missing) return "missing";
  if (params.parseErrorCount > 0) return "partial";
  return "ok";
}

function withTokenQuality(base: MetricsQuality, tokensMissing: boolean): MetricsQuality {
  if (!tokensMissing) return base;
  return base === "ok" ? "partial" : base;
}

function preferQuality(current: MetricsQuality, candidate: MetricsQuality): MetricsQuality {
  return QUALITY_RANK[candidate] > QUALITY_RANK[current] ? candidate : current;
}

export async function computeAndStoreRunMetrics(params: {
  runId: string;
  maxBytesPerSession?: number;
  timeBudgetMs?: number;
  sessionsDir?: string;
}): Promise<void> {
  const runId = params.runId?.trim();
  if (!runId) return;

  const maxBytesPerSession = params.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
  const timeBudgetMs = params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startedAt = Date.now();

  const sessionIds = listRalphRunSessionIds(runId);
  if (sessionIds.length === 0) return;

  const tokenTotalsBySession = new Map(
    listRalphRunSessionTokenTotals(runId).map((entry) => [entry.sessionId, entry])
  );

  const sessions: SessionMetrics[] = [];
  let timedOut = false;

  const resolveEventsPath = (sessionId: string): string => {
    if (!params.sessionsDir) return getSessionEventsPath(sessionId);
    const base = params.sessionsDir.trim();
    if (!base) return getSessionEventsPath(sessionId);
    const sessionsRoot = isAbsolute(base) ? base : join(process.cwd(), base);
    return getSessionEventsPathFromDir(sessionsRoot, sessionId);
  };

  for (const sessionId of sessionIds) {
    const elapsed = Date.now() - startedAt;
    const remainingBudgetMs = timeBudgetMs - elapsed;
    if (remainingBudgetMs <= 0) {
      timedOut = true;
      break;
    }

    const eventsPath = resolveEventsPath(sessionId);
    const readResult = await readSessionEventLines({ path: eventsPath, maxBytes: maxBytesPerSession, timeBudgetMs: remainingBudgetMs });
    const { events, eventCount, parseErrorCount } = parseEventsFromLines(readResult.lines);

    const tokenEntry = tokenTotalsBySession.get(sessionId);
    const tokensTotal = tokenEntry?.quality === "ok" ? tokenEntry.tokensTotal : null;
    const tokensMissing = tokensTotal == null;

    const quality = withTokenQuality(
      normalizeQuality({
        missing: readResult.missing,
        tooLarge: readResult.tooLarge,
        timedOut: readResult.timedOut,
        error: Boolean(readResult.error),
        parseErrorCount,
      }),
      tokensMissing
    );

    sessions.push(
      computeSessionMetrics({
        sessionId,
        events,
        eventCount,
        parseErrorCount,
        tokensTotal,
        quality,
      })
    );

    if (readResult.timedOut) {
      timedOut = true;
      break;
    }
  }

  const runTokenTotals = getRalphRunTokenTotals(runId);
  const tokensTotal = runTokenTotals?.tokensTotal ?? null;
  const tokensComplete = runTokenTotals?.tokensComplete ?? false;

  const { run, steps } = aggregateRunMetrics({ runId, sessions, tokensTotal, tokensComplete });
  const finalQuality = timedOut ? preferQuality(run.quality, "timeout") : run.quality;
  const computedAt = new Date().toISOString();

  recordRalphRunMetrics({
    runId: run.runId,
    wallTimeMs: run.wallTimeMs,
    toolCallCount: run.toolCallCount,
    toolTimeMs: run.toolTimeMs,
    anomalyCount: run.anomalyCount,
    anomalyRecentBurst: run.recentBurstAtEnd,
    tokensTotal: run.tokensTotal,
    tokensComplete: run.tokensComplete,
    eventCount: run.eventCount,
    parseErrorCount: run.parseErrorCount,
    quality: finalQuality,
    computedAt,
  });

  for (const step of steps) {
    recordRalphRunStepMetrics({
      runId: step.runId,
      stepTitle: step.stepTitle,
      wallTimeMs: step.wallTimeMs,
      toolCallCount: step.toolCallCount,
      toolTimeMs: step.toolTimeMs,
      anomalyCount: step.anomalyCount,
      anomalyRecentBurst: step.recentBurstAtEnd,
      tokensTotal: step.tokensTotal,
      eventCount: step.eventCount,
      parseErrorCount: step.parseErrorCount,
      quality: step.quality,
      computedAt,
    });
  }
}
