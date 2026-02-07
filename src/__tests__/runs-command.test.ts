import { mkdtemp, rm } from "fs/promises";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import {
  closeStateDbForTests,
  completeRalphRun,
  createRalphRun,
  initStateDb,
  recordRalphRunSessionUse,
  recordRalphRunTokenTotals,
  recordRalphRunTracePointer,
} from "../state";
import { runRunsCommand } from "../commands/runs";
import { getRalphStateDbPath } from "../paths";

function insertStepMetric(params: {
  runId: string;
  stepTitle: string;
  tokensTotal?: number | null;
  wallTimeMs?: number | null;
  toolCallCount?: number;
  toolTimeMs?: number | null;
  quality?: string;
  at?: string;
}) {
  const now = params.at ?? "2026-02-05T12:30:00.000Z";
  const db = new Database(getRalphStateDbPath());
  try {
    db.query(
      `INSERT INTO ralph_run_step_metrics(
         run_id, step_title, wall_time_ms, tool_call_count, tool_time_ms, anomaly_count, anomaly_recent_burst,
         tokens_total, event_count, parse_error_count, quality, computed_at, created_at, updated_at
       ) VALUES (
         $run_id, $step_title, $wall_time_ms, $tool_call_count, $tool_time_ms, 0, 0,
         $tokens_total, 0, 0, $quality, $computed_at, $created_at, $updated_at
       )
       ON CONFLICT(run_id, step_title) DO UPDATE SET
         wall_time_ms = excluded.wall_time_ms,
         tool_call_count = excluded.tool_call_count,
         tool_time_ms = excluded.tool_time_ms,
         tokens_total = excluded.tokens_total,
         quality = excluded.quality,
         computed_at = excluded.computed_at,
         updated_at = excluded.updated_at`
    ).run({
      $run_id: params.runId,
      $step_title: params.stepTitle,
      $wall_time_ms: typeof params.wallTimeMs === "number" ? params.wallTimeMs : null,
      $tool_call_count: typeof params.toolCallCount === "number" ? params.toolCallCount : 0,
      $tool_time_ms: typeof params.toolTimeMs === "number" ? params.toolTimeMs : null,
      $tokens_total: typeof params.tokensTotal === "number" ? params.tokensTotal : null,
      $quality: params.quality ?? "ok",
      $computed_at: now,
      $created_at: now,
      $updated_at: now,
    });
  } finally {
    db.close();
  }
}

async function invokeRuns(args: string[], opts?: { nowMs?: number }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const priorLog = console.log;
  const priorError = console.error;
  const priorExit = process.exit;
  const priorNow = Date.now;
  let exitCode = 0;

  if (typeof opts?.nowMs === "number") {
    Date.now = () => opts.nowMs as number;
  }

  console.log = (msg?: unknown) => {
    stdout.push(String(msg ?? ""));
  };
  console.error = (msg?: unknown) => {
    stderr.push(String(msg ?? ""));
  };
  process.exit = ((code?: number) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`exit:${exitCode}`);
  }) as typeof process.exit;

  try {
    await runRunsCommand({ args: ["runs", ...args] });
  } catch (err: any) {
    if (!String(err?.message ?? "").startsWith("exit:")) throw err;
  } finally {
    console.log = priorLog;
    console.error = priorError;
    process.exit = priorExit;
    Date.now = priorNow;
  }

  return { exitCode, stdout, stderr };
}

function parseJsonOutput(lines: string[]): any {
  for (const entry of lines) {
    try {
      return JSON.parse(entry);
    } catch {
      // ignore non-json output
    }
  }
  return null;
}

describe("runs command", () => {
  let homeDir: string;
  let priorStateDbPath: string | undefined;
  let releaseLock: (() => void) | null = null;

  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      if (priorStateDbPath === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("emits stable json schema for runs top", async () => {
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#301",
      taskPath: "github:3mdistal/ralph#301",
      attemptKind: "process",
      startedAt: "2026-02-05T12:00:00.000Z",
    });

    completeRalphRun({ runId, outcome: "success", completedAt: "2026-02-05T12:40:00.000Z" });
    recordRalphRunTokenTotals({ runId, tokensTotal: 1234, tokensComplete: true, sessionCount: 1 });
    recordRalphRunSessionUse({ runId, sessionId: "ses_test_001" });
    recordRalphRunTracePointer({ runId, kind: "run_log_path", path: "/tmp/ralph/run.log" });
    insertStepMetric({ runId, stepTitle: "build", tokensTotal: 900, wallTimeMs: 120000, toolCallCount: 4, toolTimeMs: 90000 });
    insertStepMetric({ runId, stepTitle: "plan", tokensTotal: 200, wallTimeMs: 30000, toolCallCount: 1, toolTimeMs: 1000 });

    const result = await invokeRuns([
      "top",
      "--json",
      "--since",
      "2026-02-05T00:00:00.000Z",
      "--until",
      "2026-02-05T23:59:59.999Z",
    ]);

    const payload = parseJsonOutput(result.stdout);

    expect(payload).toBeTruthy();
    expect(Array.isArray(payload.runs)).toBe(true);
    let runEntry: any = null;
    for (const entry of payload.runs as any[]) {
      if (entry && entry.runId === runId) {
        runEntry = entry;
        break;
      }
    }
    expect(runEntry).toBeTruthy();
    expect(runEntry).toMatchObject({
      runId,
      dominantStep: {
        stepTitle: "build",
        basis: "tokens_total",
      },
      tracePointers: {
        runLogPaths: expect.any(Array),
        sessionEventPaths: expect.any(Array),
        sessionIds: expect.any(Array),
      },
    });
  });

  test("uses bounded defaults and default sort for runs top", async () => {
    const recentRun = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#302",
      taskPath: "github:3mdistal/ralph#302",
      attemptKind: "process",
      startedAt: "2026-02-07T12:00:00.000Z",
    });
    const oldRun = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#303",
      taskPath: "github:3mdistal/ralph#303",
      attemptKind: "process",
      startedAt: "2026-01-20T12:00:00.000Z",
    });

    recordRalphRunTokenTotals({ runId: recentRun, tokensTotal: 200, tokensComplete: true, sessionCount: 1 });
    recordRalphRunTokenTotals({ runId: oldRun, tokensTotal: 400, tokensComplete: true, sessionCount: 1 });

    const nowMs = Date.parse("2026-02-08T00:00:00.000Z");
    const result = await invokeRuns(["top", "--json"], { nowMs });
    const payload = parseJsonOutput(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.sort).toBe("tokens_total");
    expect(payload.limit).toBe(20);
    expect(payload.range).toEqual({
      since: "2026-02-01T00:00:00.000Z",
      until: "2026-02-08T00:00:00.000Z",
    });
    expect((payload.runs as Array<{ runId: string }>).map((r) => r.runId)).toEqual([recentRun]);
  });

  test("supports unbounded query only with --all when since is omitted", async () => {
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#304",
      taskPath: "github:3mdistal/ralph#304",
      attemptKind: "process",
      startedAt: "2026-01-01T12:00:00.000Z",
    });
    recordRalphRunTokenTotals({ runId, tokensTotal: 123, tokensComplete: true, sessionCount: 1 });

    const result = await invokeRuns(["top", "--all", "--json"], {
      nowMs: Date.parse("2026-02-08T00:00:00.000Z"),
    });
    const payload = parseJsonOutput(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(payload.range.since).toBeNull();
    expect((payload.runs as Array<{ runId: string }>).some((row) => row.runId === runId)).toBe(true);
  });

  test("includes missing metrics only with --include-missing and emits null JSON values", async () => {
    const runWithMetrics = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#305",
      taskPath: "github:3mdistal/ralph#305",
      attemptKind: "process",
      startedAt: "2026-02-05T10:00:00.000Z",
    });
    const runMissing = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#306",
      taskPath: "github:3mdistal/ralph#306",
      attemptKind: "process",
      startedAt: "2026-02-05T11:00:00.000Z",
    });
    recordRalphRunTokenTotals({ runId: runWithMetrics, tokensTotal: 50, tokensComplete: true, sessionCount: 1 });

    const baseArgs = [
      "top",
      "--json",
      "--since",
      "2026-02-05T00:00:00.000Z",
      "--until",
      "2026-02-05T23:59:59.999Z",
    ];
    const withoutMissing = parseJsonOutput((await invokeRuns(baseArgs)).stdout);
    const withMissing = parseJsonOutput((await invokeRuns([...baseArgs, "--include-missing"])).stdout);

    expect((withoutMissing.runs as Array<{ runId: string }>).find((row) => row.runId === runMissing)).toBeUndefined();

    const missingEntry = (withMissing.runs as Array<any>).find((row) => row.runId === runMissing);
    expect(missingEntry).toBeTruthy();
    expect(missingEntry.tokensTotal).toBeNull();
    expect(missingEntry.triageScore).toBeNull();
    expect(Array.isArray(missingEntry.triageFlags)).toBe(true);
  });

  test("redacts home paths and secrets in trace pointers", async () => {
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#307",
      taskPath: "github:3mdistal/ralph#307",
      attemptKind: "process",
      startedAt: "2026-02-05T12:00:00.000Z",
    });
    const sensitivePath = join(homedir(), "logs", "ghp_123456789012345678901234567890.log");
    recordRalphRunTracePointer({ runId, kind: "run_log_path", path: sensitivePath });

    const payload = parseJsonOutput((await invokeRuns(["show", runId, "--json"])).stdout);
    const path = payload.run.tracePointers.runLogPaths[0] as string;

    expect(path.includes(homeDir)).toBe(false);
    expect(path.includes("~")).toBe(true);
    expect(path.includes("ghp_[REDACTED]")).toBe(true);
  });

  test("rejects invalid sort and malformed time inputs", async () => {
    const badSort = await invokeRuns(["top", "--sort", "invalid"]);
    expect(badSort.exitCode).toBe(1);
    expect(badSort.stderr[0]).toContain("Usage:");

    const badSince = await invokeRuns(["top", "--since", "nonsense"]);
    expect(badSince.exitCode).toBe(1);
    expect(badSince.stderr[0]).toContain("Usage:");

    const badUntil = await invokeRuns(["top", "--until", "still-not-a-time"]);
    expect(badUntil.exitCode).toBe(1);
    expect(badUntil.stderr[0]).toContain("Usage:");
  });

  test("fails runs show for unknown run id", async () => {
    const result = await invokeRuns(["show", "run_missing_123"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr[0]).toContain("Run not found");
  });

  test("shows dominant step details for run", async () => {
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#308",
      taskPath: "github:3mdistal/ralph#308",
      attemptKind: "process",
      startedAt: "2026-02-05T13:00:00.000Z",
    });
    insertStepMetric({ runId, stepTitle: "survey", wallTimeMs: 90000, toolCallCount: 7, toolTimeMs: 70000 });
    insertStepMetric({ runId, stepTitle: "plan", wallTimeMs: 20000, toolCallCount: 1, toolTimeMs: 1000 });

    const result = await invokeRuns(["show", runId]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join("\n")).toContain("Dominant step: survey");
    expect(result.stdout.join("\n")).toContain("wall_time_ms");
  });
});
