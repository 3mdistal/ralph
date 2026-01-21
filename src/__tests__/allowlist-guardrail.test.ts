import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { tmpdir } from "os";

import { __resetConfigForTests } from "../config";
import { getRalphConfigJsonPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

const updateTaskStatusMock = mock(async () => true);

const queueAdapter = {
  updateTaskStatus: updateTaskStatusMock,
};

import { RepoWorker } from "../worker";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

async function writeJson(path: string, obj: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 2), "utf8");
}

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "builder-org/repo#123",
    repo: "builder-org/repo",
    status: "queued",
    priority: "p2-medium",
    name: "Test Task",
    ...overrides,
  } as any;
}

afterAll(() => {
  mock.restore();
});

describe("allowlist guardrail", () => {
  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    __resetConfigForTests();

    await writeJson(getRalphConfigJsonPath(), {
      repos: [],
      maxWorkers: 1,
      batchSize: 10,
      pollInterval: 30_000,
      bwrbVault: "/tmp",
      owner: "3mdistal",
      allowedOwners: ["3mdistal"],
      devDir: "/tmp",
    });
    __resetConfigForTests();

    updateTaskStatusMock.mockClear();
  });

  afterEach(async () => {
    process.env.HOME = priorHome;
    await rm(homeDir, { recursive: true, force: true });
    __resetConfigForTests();
    releaseLock?.();
    releaseLock = null;
  });

  test("processTask blocks without touching gh when repo owner is not allowed", async () => {
    const worker = new RepoWorker("builder-org/repo", "/tmp", { queue: queueAdapter });

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask();

    const result = await worker.processTask(task);

    expect(result.outcome).toBe("failed");

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("blocked");
    expect(lastCall[2]["completed-at"]).toBeTruthy();
    expect(lastCall[2]["session-id"]).toBe("");

    expect(agentRunData?.outcome).toBe("failed");
    expect(agentRunData?.bodyPrefix).toContain("Blocked: repo owner not in allowlist");
    expect(agentRunData?.bodyPrefix).toContain("Allowed owners: 3mdistal");
    expect(agentRunData?.bodyPrefix).toContain("Repo: builder-org/repo");
  });

  test("resumeTask blocks without touching gh when repo owner is not allowed", async () => {
    const worker = new RepoWorker("builder-org/repo", "/tmp", { queue: queueAdapter });

    let agentRunData: any = null;
    (worker as any).createAgentRun = async (_task: any, data: any) => {
      agentRunData = data;
    };

    const task = createMockTask({ status: "in-progress", "session-id": "ses_abc" });

    const result = await worker.resumeTask(task);

    expect(result.outcome).toBe("failed");

    expect(updateTaskStatusMock).toHaveBeenCalled();
    const calls = updateTaskStatusMock.mock.calls;
    const lastCall = calls[calls.length - 1] as any[];
    expect(lastCall[1]).toBe("blocked");
    expect(lastCall[2]["completed-at"]).toBeTruthy();
    expect(lastCall[2]["session-id"]).toBe("");

    expect(agentRunData?.outcome).toBe("failed");
    expect(agentRunData?.bodyPrefix).toContain("Blocked: repo owner not in allowlist");
    expect(agentRunData?.bodyPrefix).toContain("Allowed owners: 3mdistal");
    expect(agentRunData?.bodyPrefix).toContain("Repo: builder-org/repo");
  });
});
