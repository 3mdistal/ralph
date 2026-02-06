import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { acquireGlobalTestLock } from "./helpers/test-lock";
import {
  closeStateDbForTests,
  createRalphRun,
  initStateDb,
  recordRalphRunSessionUse,
  recordRalphRunTokenTotals,
  recordRalphRunTracePointer,
} from "../state";
import { runRunsCommand } from "../commands/runs";

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

    recordRalphRunTokenTotals({ runId, tokensTotal: 1234, tokensComplete: true, sessionCount: 1 });
    recordRalphRunSessionUse({ runId, sessionId: "ses_test_001" });
    recordRalphRunTracePointer({ runId, kind: "run_log_path", path: "/tmp/ralph/run.log" });

    const logs: string[] = [];
    const priorLog = console.log;
    const priorExit = process.exit;

    console.log = (msg?: any) => {
      logs.push(String(msg));
    };
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await runRunsCommand({
        args: [
          "runs",
          "top",
          "--json",
          "--since",
          "2026-02-05T00:00:00.000Z",
          "--until",
          "2026-02-05T23:59:59.999Z",
        ],
      });
    } catch (err: any) {
      if (!String(err?.message ?? "").startsWith("exit:")) throw err;
    } finally {
      console.log = priorLog;
      process.exit = priorExit;
    }

    let payload: any = null;
    for (const entry of logs) {
      try {
        const candidate = JSON.parse(entry);
        if (candidate && candidate.schemaVersion === 1 && "runs" in candidate) {
          payload = candidate;
          break;
        }
      } catch {
        // ignore non-json logs
      }
    }

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
      tracePointers: {
        runLogPaths: expect.any(Array),
        sessionEventPaths: expect.any(Array),
        sessionIds: expect.any(Array),
      },
    });
  });
});
