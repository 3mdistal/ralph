import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getRalphStateDbPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";
import {
  closeStateDbForTests,
  createRalphRun,
  initStateDb,
  listRalphRunsTop,
  recordRalphRunTokenTotals,
} from "../state";

function insertTriageScore(params: { runId: string; score: number; reasons?: string[]; at: string }) {
  const db = new Database(getRalphStateDbPath());
  db.query(
    `INSERT INTO ralph_run_metrics(
       run_id, quality, computed_at, created_at, updated_at, triage_score, triage_reasons_json, triage_computed_at
     ) VALUES (
       $run_id, $quality, $computed_at, $created_at, $updated_at, $triage_score, $triage_reasons_json, $triage_computed_at
     )
     ON CONFLICT(run_id) DO UPDATE SET
       triage_score = excluded.triage_score,
       triage_reasons_json = excluded.triage_reasons_json,
       triage_computed_at = excluded.triage_computed_at,
       updated_at = excluded.updated_at`
  ).run({
    $run_id: params.runId,
    $quality: "ok",
    $computed_at: params.at,
    $created_at: params.at,
    $updated_at: params.at,
    $triage_score: params.score,
    $triage_reasons_json: JSON.stringify(params.reasons ?? []),
    $triage_computed_at: params.at,
  });
}

describe("runs query", () => {
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

  test("orders tokens_total and excludes missing by default", () => {
    const runA = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#101",
      taskPath: "github:3mdistal/ralph#101",
      attemptKind: "process",
      startedAt: "2026-02-05T10:00:00.000Z",
    });
    const runB = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#102",
      taskPath: "github:3mdistal/ralph#102",
      attemptKind: "process",
      startedAt: "2026-02-05T11:00:00.000Z",
    });
    const runC = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#103",
      taskPath: "github:3mdistal/ralph#103",
      attemptKind: "process",
      startedAt: "2026-02-05T12:00:00.000Z",
    });

    recordRalphRunTokenTotals({ runId: runA, tokensTotal: 500, tokensComplete: true, sessionCount: 1 });
    recordRalphRunTokenTotals({ runId: runC, tokensTotal: 900, tokensComplete: true, sessionCount: 1 });

    const rows = listRalphRunsTop({
      sort: "tokens_total",
      includeMissing: false,
      sinceIso: "2026-02-05T00:00:00.000Z",
      untilIso: "2026-02-05T23:59:59.999Z",
    });

    expect(rows.map((r) => r.runId)).toEqual([runC, runA]);
    expect(rows.find((r) => r.runId === runB)).toBeUndefined();
  });

  test("includes missing tokens_total when requested", () => {
    const runA = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#111",
      taskPath: "github:3mdistal/ralph#111",
      attemptKind: "process",
      startedAt: "2026-02-05T10:00:00.000Z",
    });
    const runB = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#112",
      taskPath: "github:3mdistal/ralph#112",
      attemptKind: "process",
      startedAt: "2026-02-05T11:00:00.000Z",
    });
    const runC = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#113",
      taskPath: "github:3mdistal/ralph#113",
      attemptKind: "process",
      startedAt: "2026-02-05T12:00:00.000Z",
    });

    recordRalphRunTokenTotals({ runId: runA, tokensTotal: 500, tokensComplete: true, sessionCount: 1 });
    recordRalphRunTokenTotals({ runId: runC, tokensTotal: 900, tokensComplete: true, sessionCount: 1 });

    const rows = listRalphRunsTop({
      sort: "tokens_total",
      includeMissing: true,
      sinceIso: "2026-02-05T00:00:00.000Z",
      untilIso: "2026-02-05T23:59:59.999Z",
    });

    expect(rows.map((r) => r.runId)).toEqual([runC, runA, runB]);
  });

  test("orders triage_score and respects window", () => {
    const runA = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#201",
      taskPath: "github:3mdistal/ralph#201",
      attemptKind: "process",
      startedAt: "2026-02-05T10:00:00.000Z",
    });
    const runB = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#202",
      taskPath: "github:3mdistal/ralph#202",
      attemptKind: "process",
      startedAt: "2026-02-05T11:00:00.000Z",
    });
    const runC = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#203",
      taskPath: "github:3mdistal/ralph#203",
      attemptKind: "process",
      startedAt: "2026-02-05T12:00:00.000Z",
    });

    insertTriageScore({ runId: runA, score: 2.5, at: "2026-02-05T10:10:00.000Z" });
    insertTriageScore({ runId: runB, score: 9.0, at: "2026-02-05T11:10:00.000Z" });

    const rows = listRalphRunsTop({
      sort: "triage_score",
      includeMissing: false,
      sinceIso: "2026-02-05T10:30:00.000Z",
      untilIso: "2026-02-05T12:30:00.000Z",
    });

    expect(rows.map((r) => r.runId)).toEqual([runB]);

    const fullRows = listRalphRunsTop({
      sort: "triage_score",
      includeMissing: false,
      sinceIso: "2026-02-05T00:00:00.000Z",
      untilIso: "2026-02-05T23:59:59.999Z",
    });

    expect(fullRows.map((r) => r.runId)).toEqual([runB, runA]);
    expect(fullRows.find((r) => r.runId === runC)).toBeUndefined();
  });
});
