import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { closeStateDbForTests, createRalphRun, initStateDb, recordRalphRunSessionUse } from "../state";
import { computeAndStoreRunMetrics } from "../metrics/compute-and-store";
import { getSessionEventsPathFromDir } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("metrics persistence", () => {
  const testIfNotGitHubActions = process.env.GITHUB_ACTIONS ? test.skip : test;

  testIfNotGitHubActions("stores run and step metrics from session events", async () => {
    const releaseLock = await acquireGlobalTestLock();
    const root = await mkdtemp(join(tmpdir(), "ralph-metrics-"));
    const statePath = join(root, "state.sqlite");
    const sessionsDir = join(root, "sessions");

    const priorState = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = statePath;

    try {
      closeStateDbForTests();
      initStateDb();
      const runId = createRalphRun({
        repo: "3mdistal/ralph",
        issue: "3mdistal/ralph#295",
        taskPath: "github:3mdistal/ralph#295",
        attemptKind: "process",
        startedAt: "2026-01-31T09:00:00.000Z",
      });

      recordRalphRunSessionUse({
        runId,
        sessionId: "ses_metrics",
        stepTitle: "plan",
        at: "2026-01-31T09:01:00.000Z",
      });

      // Ensure cross-connection visibility for the DB writes (CI can be flaky
      // when a second sqlite connection reads before the writer is closed).
      closeStateDbForTests();

      const eventsPath = getSessionEventsPathFromDir(sessionsDir, "ses_metrics");
      await mkdir(dirname(eventsPath), { recursive: true });
      await writeFile(
        eventsPath,
        [
          JSON.stringify({ type: "run-start", ts: 0, stepTitle: "plan" }),
          JSON.stringify({ type: "tool-start", ts: 10, toolName: "bash", callId: "c1" }),
          JSON.stringify({ type: "tool-end", ts: 30, toolName: "bash", callId: "c1" }),
          JSON.stringify({ type: "run-end", ts: 40, success: true }),
        ].join("\n") + "\n",
        "utf8"
      );

      await computeAndStoreRunMetrics({ runId, sessionsDir });

      // Some runners (notably CI) have shown flaky visibility of writes when
      // reading the same sqlite file from a fresh connection.
      closeStateDbForTests();

      const db = new Database(statePath);
      try {
        const runRow = db
          .query("SELECT quality, tool_call_count as tool_calls, wall_time_ms as wall_time FROM ralph_run_metrics WHERE run_id = $run_id")
          .get({ $run_id: runId }) as { quality?: string; tool_calls?: number; wall_time?: number } | undefined;
        expect(runRow?.tool_calls).toBe(1);
        expect(runRow?.wall_time).toBe(40);
        expect(runRow?.quality).toBe("partial");

        const stepRow = db
          .query(
            "SELECT step_title as step_title, tool_call_count as tool_calls FROM ralph_run_step_metrics WHERE run_id = $run_id"
          )
          .get({ $run_id: runId }) as { step_title?: string; tool_calls?: number } | undefined;
        expect(stepRow?.step_title).toBe("plan");
        expect(stepRow?.tool_calls).toBe(1);
      } finally {
        db.close();
      }
    } finally {
      closeStateDbForTests();
      if (priorState === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorState;
      releaseLock();
      await rm(root, { recursive: true, force: true });
    }
  });

  testIfNotGitHubActions("marks too-large traces with quality", async () => {
    const releaseLock = await acquireGlobalTestLock();
    const root = await mkdtemp(join(tmpdir(), "ralph-metrics-"));
    const statePath = join(root, "state.sqlite");
    const sessionsDir = join(root, "sessions");

    const priorState = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = statePath;

    try {
      closeStateDbForTests();
      initStateDb();
      const runId = createRalphRun({
        repo: "3mdistal/ralph",
        issue: "3mdistal/ralph#296",
        taskPath: "github:3mdistal/ralph#296",
        attemptKind: "process",
        startedAt: "2026-01-31T09:10:00.000Z",
      });

      recordRalphRunSessionUse({
        runId,
        sessionId: "ses_big",
        stepTitle: "plan",
        at: "2026-01-31T09:11:00.000Z",
      });

      // Ensure cross-connection visibility for the DB writes (CI can be flaky
      // when a second sqlite connection reads before the writer is closed).
      closeStateDbForTests();

      const eventsPath = getSessionEventsPathFromDir(sessionsDir, "ses_big");
      await mkdir(dirname(eventsPath), { recursive: true });
      await writeFile(eventsPath, "{\"type\":\"run-start\",\"ts\":0}\n".repeat(100), "utf8");

      await computeAndStoreRunMetrics({ runId, maxBytesPerSession: 10, sessionsDir });

      // Some runners (notably CI) have shown flaky visibility of writes when
      // reading the same sqlite file from a fresh connection.
      closeStateDbForTests();

      const db = new Database(statePath);
      try {
        const runRow = db
          .query("SELECT quality FROM ralph_run_metrics WHERE run_id = $run_id")
          .get({ $run_id: runId }) as { quality?: string } | undefined;
        expect(runRow?.quality).toBe("too_large");
      } finally {
        db.close();
      }
    } finally {
      closeStateDbForTests();
      if (priorState === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorState;
      releaseLock();
      await rm(root, { recursive: true, force: true });
    }
  });
});
