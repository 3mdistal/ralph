import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import { collectSandboxTraceBundle } from "../sandbox/collect";
import {
  closeStateDbForTests,
  completeRalphRun,
  createRalphRun,
  initStateDb,
  recordRalphRunSessionUse,
  recordRalphRunTracePointer,
} from "../state";
import { getRalphEventsDayLogPath, getSessionEventsPath } from "../paths";

describe("sandbox trace bundle collect", () => {
  let homeDir: string;
  let priorHome: string | undefined;
  let priorStateDbPath: string | undefined;
  let releaseLock: (() => void) | null = null;

  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-sandbox-collect-"));
    priorHome = process.env.HOME;
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      if (priorHome === undefined) delete process.env.HOME;
      else process.env.HOME = priorHome;
      if (priorStateDbPath === undefined) delete process.env.RALPH_STATE_DB_PATH;
      else process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("collects timeline + github request ids and redacts sensitive data", async () => {
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#254",
      taskPath: "github:3mdistal/ralph#254",
      attemptKind: "process",
      startedAt: "2026-02-08T10:00:00.000Z",
    });
    completeRalphRun({ runId, outcome: "success", completedAt: "2026-02-08T10:15:00.000Z" });

    const sessionId = "ses_collect_001";
    recordRalphRunSessionUse({ runId, sessionId, stepTitle: "implementation" });
    const sessionEventsPath = getSessionEventsPath(sessionId);
    await mkdir(join(homeDir, ".ralph", "sessions", sessionId), { recursive: true });
    await writeFile(
      sessionEventsPath,
      [
        JSON.stringify({ type: "run-start", ts: Date.parse("2026-02-08T10:00:01.000Z") }),
        JSON.stringify({
          type: "tool-start",
          ts: Date.parse("2026-02-08T10:00:03.000Z"),
          toolName: "bash",
          callId: "call_1",
          argsPreview: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const runLogPath = join(homeDir, "run.log");
    await writeFile(runLogPath, "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890\n", "utf8");
    recordRalphRunTracePointer({ runId, kind: "run_log_path", path: runLogPath });

    const eventDayPath = getRalphEventsDayLogPath("2026-02-08");
    await mkdir(join(homeDir, ".ralph", "events"), { recursive: true });
    await writeFile(
      eventDayPath,
      [
        JSON.stringify({
          ts: "2026-02-08T10:00:10.000Z",
          type: "github.request",
          level: "info",
          runId,
          data: {
            method: "GET",
            path: "/repos/3mdistal/ralph/issues/254",
            status: 200,
            ok: true,
            write: false,
            durationMs: 42,
            attempt: 1,
            requestId: "A1B2:C3D4:REQ123:1",
            source: "repo-worker",
          },
        }),
        JSON.stringify({
          ts: "2026-02-08T10:00:11.000Z",
          type: "github.request",
          level: "info",
          runId: "run-other",
          data: {
            method: "GET",
            path: "/repos/3mdistal/ralph/issues/1",
            status: 200,
            ok: true,
            write: false,
            durationMs: 20,
            attempt: 1,
          },
        }),
      ].join("\n") + "\n",
      "utf8"
    );

    const result = await collectSandboxTraceBundle({ runId });

    expect(result.runLogCount).toBe(1);
    expect(result.sessionEventsCount).toBe(1);
    expect(result.githubRequestCount).toBe(1);

    const timeline = await readFile(result.workerToolTimelinePath, "utf8");
    expect(timeline).toContain('"type":"tool-start"');
    expect(timeline).toContain('"toolName":"bash"');

    const githubRequests = await readFile(result.githubRequestsPath, "utf8");
    expect(githubRequests).toContain('"requestId":"A1B2:C3D4:REQ123:1"');
    expect(githubRequests).toContain('"status":200');
    expect(githubRequests).toContain('"path":"/repos/3mdistal/ralph/issues/254"');

    const copiedRunLog = await readFile(join(result.outputDir, "raw", "run-logs", "01-run.log.log"), "utf8");
    expect(copiedRunLog).not.toContain("abcdefghijklmnopqrstuvwxyz1234567890");
    expect(copiedRunLog).toContain("[REDACTED]");
  });
});
