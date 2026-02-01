import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { __resetConfigForTests } from "../config";
import { __resetQueueBackendStateForTests } from "../queue-backend";
import { __resetBwrbRunnerForTests, __setBwrbRunnerForTests } from "../queue";
import { closeStateDbForTests, createRalphRun, initStateDb, recordRalphRunSessionUse } from "../state";
import { runStatusCommand } from "../commands/status";
import { acquireGlobalTestLock } from "./helpers/test-lock";

type AgentTaskRow = Record<string, unknown>;

let homeDir = "";
let vaultDir = "";
let priorHome: string | undefined;
let priorStateDb: string | undefined;
let priorXdgData: string | undefined;
let releaseLock: (() => void) | null = null;

function createMockTask(overrides: AgentTaskRow = {}): AgentTaskRow {
  return {
    _path: "orchestration/tasks/task-1.md",
    _name: "task-1",
    type: "agent-task",
    "creation-date": "2026-01-01T00:00:00.000Z",
    scope: "issue",
    issue: "3mdistal/ralph#201",
    repo: "3mdistal/ralph",
    status: "in-progress",
    priority: "p2-medium",
    name: "Status tokens",
    ...overrides,
  };
}

function buildCommand(strings: TemplateStringsArray, values: unknown[]): string {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += String(values[i]);
  });
  return out.trim();
}

function applyWhereFilter(rows: AgentTaskRow[], command: string): AgentTaskRow[] {
  const match = command.match(/status == '([^']+)'/);
  if (!match) return rows;
  const status = match[1];
  return rows.filter((row) => row.status === status);
}

function createMockBwrbRunner(dataset: AgentTaskRow[]) {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const command = buildCommand(strings, values);
    const runner = {
      cwd: () => runner,
      quiet: async () => {
        const filtered = applyWhereFilter(dataset, command);
        return { stdout: Buffer.from(JSON.stringify(filtered)) };
      },
    };

    return runner;
  };
}

async function setupEnv(): Promise<void> {
  priorHome = process.env.HOME;
  priorStateDb = process.env.RALPH_STATE_DB_PATH;
  priorXdgData = process.env.XDG_DATA_HOME;

  homeDir = await mkdtemp(join(tmpdir(), "ralph-status-home-"));
  vaultDir = join(homeDir, "vault");

  process.env.HOME = homeDir;
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
  process.env.XDG_DATA_HOME = join(homeDir, "xdg-data");

  await mkdir(join(vaultDir, ".bwrb"), { recursive: true });
  await writeFile(join(vaultDir, ".bwrb", "schema.json"), "{}", "utf8");

  await mkdir(join(homeDir, ".ralph"), { recursive: true });
  await writeFile(
    join(homeDir, ".ralph", "config.json"),
    JSON.stringify({ queueBackend: "bwrb", bwrbVault: vaultDir }),
    "utf8"
  );

  __resetConfigForTests();
  __resetQueueBackendStateForTests();
  closeStateDbForTests();
  initStateDb();
}

async function teardownEnv(): Promise<void> {
  __resetBwrbRunnerForTests();
  __resetQueueBackendStateForTests();
  __resetConfigForTests();
  closeStateDbForTests();

  if (homeDir) {
    await rm(homeDir, { recursive: true, force: true });
  }

  if (priorHome === undefined) delete process.env.HOME;
  else process.env.HOME = priorHome;

  if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
  else process.env.RALPH_STATE_DB_PATH = priorStateDb;

  if (priorXdgData === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgData;
}

beforeEach(async () => {
  releaseLock = await acquireGlobalTestLock();
  await setupEnv();
});

afterEach(async () => {
  await teardownEnv();
  releaseLock?.();
  releaseLock = null;
});

describe("status token totals", () => {
  test("status output includes unknown tokens when logs missing", async () => {
    const dataset = [createMockTask({ "session-id": "" })];
    __setBwrbRunnerForTests(createMockBwrbRunner(dataset));

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#201",
      taskPath: "github:3mdistal/ralph#201",
      attemptKind: "process",
      startedAt: "2026-01-20T10:01:00.000Z",
    });

    recordRalphRunSessionUse({
      runId,
      sessionId: "ses_missing",
      stepTitle: "build",
      at: "2026-01-20T10:01:30.000Z",
    });

    const logs: string[] = [];
    const priorLog = console.log;
    const priorExit = process.exit;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await runStatusCommand({ args: [], drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null } });
      throw new Error("expected exit");
    } catch (err: any) {
      expect(String(err?.message ?? err)).toContain("exit:0");
    } finally {
      console.log = priorLog;
      process.exit = priorExit;
    }

    expect(logs.some((line) => line.includes("tokens=?"))).toBe(true);
  });

  test("status json includes token fields when logs missing", async () => {
    const dataset = [createMockTask({ "session-id": "" })];
    __setBwrbRunnerForTests(createMockBwrbRunner(dataset));

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#201",
      taskPath: "github:3mdistal/ralph#201",
      attemptKind: "process",
      startedAt: "2026-01-20T10:01:00.000Z",
    });

    recordRalphRunSessionUse({
      runId,
      sessionId: "ses_missing",
      stepTitle: "build",
      at: "2026-01-20T10:01:30.000Z",
    });

    const logs: string[] = [];
    const priorLog = console.log;
    const priorExit = process.exit;
    console.log = (...args: any[]) => {
      logs.push(args.join(" "));
    };
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await runStatusCommand({ args: ["--json"], drain: { requestedAt: null, timeoutMs: null, pauseRequested: false, pauseAtCheckpoint: null } });
      throw new Error("expected exit");
    } catch (err: any) {
      expect(String(err?.message ?? err)).toContain("exit:0");
    } finally {
      console.log = priorLog;
      process.exit = priorExit;
    }

    const payload = JSON.parse(logs[0] ?? "{}");
    expect(payload.inProgress?.[0]?.tokensTotal ?? null).toBeNull();
    expect(payload.inProgress?.[0]?.tokensComplete ?? false).toBe(false);
  });
});
