import { Database } from "bun:sqlite";
import { getRalphStateDbPath } from "../paths";
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

  const stateDbPath = getRalphStateDbPath();
  const stateDb = new Database(stateDbPath);

  const maxBytesPerSession = params.maxBytesPerSession ?? DEFAULT_MAX_BYTES;
  const timeBudgetMs = params.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startedAt = Date.now();

  try {
    const sessionIds = (stateDb
      .query("SELECT session_id as session_id FROM ralph_run_sessions WHERE run_id = $run_id ORDER BY session_id")
      .all({ $run_id: runId }) as Array<{ session_id?: string } | undefined>)
      .map((row) => row?.session_id ?? "")
      .filter((id) => Boolean(id));

    if (sessionIds.length === 0) return;

    const tokenTotalsBySession = new Map(
      (
        stateDb
          .query(
            "SELECT session_id as session_id, tokens_total as tokens_total, quality as quality FROM ralph_run_session_token_totals WHERE run_id = $run_id"
          )
          .all({ $run_id: runId }) as Array<{ session_id?: string; tokens_total?: number | null; quality?: string } | undefined>
      )
        .map((row) => {
          const sessionId = row?.session_id ?? "";
          const quality = typeof row?.quality === "string" && row.quality ? row.quality : "missing";
          const tokensTotal = typeof row?.tokens_total === "number" ? row.tokens_total : null;
          return [sessionId, { sessionId, quality, tokensTotal }] as const;
        })
        .filter(([sessionId]) => Boolean(sessionId))
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
      const readResult = await readSessionEventLines({
        path: eventsPath,
        maxBytes: maxBytesPerSession,
        timeBudgetMs: remainingBudgetMs,
      });
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

    const runTokenTotals = stateDb
      .query(
        "SELECT tokens_total as tokens_total, tokens_complete as tokens_complete FROM ralph_run_token_totals WHERE run_id = $run_id"
      )
      .get({ $run_id: runId }) as { tokens_total?: number | null; tokens_complete?: number | null } | undefined;

    const tokensTotal = typeof runTokenTotals?.tokens_total === "number" ? runTokenTotals.tokens_total : null;
    const tokensComplete = Boolean(runTokenTotals?.tokens_complete);

    const { run, steps } = aggregateRunMetrics({ runId, sessions, tokensTotal, tokensComplete });
    const finalQuality = timedOut ? preferQuality(run.quality, "timeout") : run.quality;
    const computedAt = new Date().toISOString();

    stateDb
      .query(
        `INSERT INTO ralph_run_metrics(
           run_id, wall_time_ms, tool_call_count, tool_time_ms, anomaly_count, anomaly_recent_burst,
           tokens_total, tokens_complete, event_count, parse_error_count, quality, computed_at, created_at, updated_at
         ) VALUES (
           $run_id, $wall_time_ms, $tool_call_count, $tool_time_ms, $anomaly_count, $anomaly_recent_burst,
           $tokens_total, $tokens_complete, $event_count, $parse_error_count, $quality, $computed_at, $created_at, $updated_at
         )
         ON CONFLICT(run_id) DO UPDATE SET
           wall_time_ms = excluded.wall_time_ms,
           tool_call_count = excluded.tool_call_count,
           tool_time_ms = excluded.tool_time_ms,
           anomaly_count = excluded.anomaly_count,
           anomaly_recent_burst = excluded.anomaly_recent_burst,
           tokens_total = excluded.tokens_total,
           tokens_complete = excluded.tokens_complete,
           event_count = excluded.event_count,
           parse_error_count = excluded.parse_error_count,
           quality = excluded.quality,
           computed_at = excluded.computed_at,
           updated_at = excluded.updated_at`
      )
      .run({
        $run_id: run.runId,
        $wall_time_ms: typeof run.wallTimeMs === "number" ? Math.max(0, Math.floor(run.wallTimeMs)) : null,
        $tool_call_count: Number.isFinite(run.toolCallCount) ? Math.max(0, Math.floor(run.toolCallCount)) : 0,
        $tool_time_ms: typeof run.toolTimeMs === "number" ? Math.max(0, Math.floor(run.toolTimeMs)) : null,
        $anomaly_count: Number.isFinite(run.anomalyCount) ? Math.max(0, Math.floor(run.anomalyCount)) : 0,
        $anomaly_recent_burst: run.recentBurstAtEnd ? 1 : 0,
        $tokens_total: typeof run.tokensTotal === "number" ? run.tokensTotal : null,
        $tokens_complete: run.tokensComplete ? 1 : 0,
        $event_count: Number.isFinite(run.eventCount) ? Math.max(0, Math.floor(run.eventCount)) : 0,
        $parse_error_count: Number.isFinite(run.parseErrorCount) ? Math.max(0, Math.floor(run.parseErrorCount)) : 0,
        $quality: finalQuality,
        $computed_at: computedAt,
        $created_at: computedAt,
        $updated_at: computedAt,
      });

    for (const step of steps) {
      stateDb
        .query(
          `INSERT INTO ralph_run_step_metrics(
             run_id, step_title, wall_time_ms, tool_call_count, tool_time_ms, anomaly_count, anomaly_recent_burst,
             tokens_total, event_count, parse_error_count, quality, computed_at, created_at, updated_at
           ) VALUES (
             $run_id, $step_title, $wall_time_ms, $tool_call_count, $tool_time_ms, $anomaly_count, $anomaly_recent_burst,
             $tokens_total, $event_count, $parse_error_count, $quality, $computed_at, $created_at, $updated_at
           )
           ON CONFLICT(run_id, step_title) DO UPDATE SET
             wall_time_ms = excluded.wall_time_ms,
             tool_call_count = excluded.tool_call_count,
             tool_time_ms = excluded.tool_time_ms,
             anomaly_count = excluded.anomaly_count,
             anomaly_recent_burst = excluded.anomaly_recent_burst,
             tokens_total = excluded.tokens_total,
             event_count = excluded.event_count,
             parse_error_count = excluded.parse_error_count,
             quality = excluded.quality,
             computed_at = excluded.computed_at,
             updated_at = excluded.updated_at`
        )
        .run({
          $run_id: step.runId,
          $step_title: step.stepTitle,
          $wall_time_ms: typeof step.wallTimeMs === "number" ? Math.max(0, Math.floor(step.wallTimeMs)) : null,
          $tool_call_count: Number.isFinite(step.toolCallCount) ? Math.max(0, Math.floor(step.toolCallCount)) : 0,
          $tool_time_ms: typeof step.toolTimeMs === "number" ? Math.max(0, Math.floor(step.toolTimeMs)) : null,
          $anomaly_count: Number.isFinite(step.anomalyCount) ? Math.max(0, Math.floor(step.anomalyCount)) : 0,
          $anomaly_recent_burst: step.recentBurstAtEnd ? 1 : 0,
          $tokens_total: typeof step.tokensTotal === "number" ? step.tokensTotal : null,
          $event_count: Number.isFinite(step.eventCount) ? Math.max(0, Math.floor(step.eventCount)) : 0,
          $parse_error_count: Number.isFinite(step.parseErrorCount) ? Math.max(0, Math.floor(step.parseErrorCount)) : 0,
          $quality: step.quality,
          $computed_at: computedAt,
          $created_at: computedAt,
          $updated_at: computedAt,
        });
    }
  } finally {
    stateDb.close();
  }
}
