import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { RepoWorker } from "../worker";
import type { SessionResult, WatchdogTimeoutInfo } from "../session";
import { closeStateDbForTests } from "../state";

describe("watchdog timeout handling", () => {
  const updateTaskStatusMock = mock(async () => true);
  const notifyEscalationMock = mock(async () => true);
  const writeStuckMock = mock(async () => ({
    commentUrl: "https://github.com/3mdistal/ralph/issues/1#issuecomment-1",
    failed: false,
  }));
  const writeEscalationMock = mock(async () => "https://github.com/3mdistal/ralph/issues/1#issuecomment-2");

  let cacheDir: string;
  let stateDir: string;
  let priorStatePath: string | undefined;

  beforeEach(async () => {
    updateTaskStatusMock.mockClear();
    notifyEscalationMock.mockClear();
    writeStuckMock.mockClear();
    writeEscalationMock.mockClear();
    cacheDir = await mkdtemp(join(tmpdir(), "ralph-watchdog-cache-"));
    stateDir = await mkdtemp(join(tmpdir(), "ralph-watchdog-state-"));
    priorStatePath = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = join(stateDir, "state.sqlite");
    closeStateDbForTests();
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
    closeStateDbForTests();
    if (priorStatePath === undefined) {
      delete process.env.RALPH_STATE_DB_PATH;
    } else {
      process.env.RALPH_STATE_DB_PATH = priorStatePath;
    }
  });

  test("first watchdog timeout requeues and posts stuck comment", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: {
        runAgent: async () => ({ success: false, output: "" }) as any,
        continueSession: async () => ({ success: false, output: "" }) as any,
        continueCommand: async () => ({ success: false, output: "" }) as any,
        getRalphXdgCacheHome: () => cacheDir,
      },
      queue: { updateTaskStatus: updateTaskStatusMock },
      notify: {
        notifyEscalation: notifyEscalationMock,
        notifyError: async () => {},
        notifyTaskComplete: async () => {},
      },
      throttle: {
        getThrottleDecision: async () => ({ state: "ok", resumeAtTs: null, snapshot: {} }) as any,
      },
    });

    (worker as any).writeWatchdogStuckWriteback = writeStuckMock;
    (worker as any).writeEscalationWriteback = writeEscalationMock;

    const task = {
      _path: "orchestration/tasks/test.md",
      _name: "test",
      type: "agent-task",
      "creation-date": "2026-01-01",
      scope: "builder",
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "Watchdog Task",
    } as any;

    const timeout: WatchdogTimeoutInfo = {
      kind: "watchdog-timeout",
      source: "tool-watchdog",
      toolName: "bash",
      callId: "call-1",
      elapsedMs: 120000,
      softMs: 30000,
      hardMs: 120000,
      lastProgressMsAgo: 120000,
    };

    const result: SessionResult = {
      sessionId: "ses_123",
      output: "timeout",
      success: false,
      exitCode: 124,
      watchdogTimeout: timeout,
    };

    await (worker as any).handleWatchdogTimeout(task, "cache-key", "plan", result, undefined);

    expect(writeStuckMock).toHaveBeenCalledTimes(1);
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    const updateArgs = updateTaskStatusMock.mock.calls[0] ?? [];
    expect(updateArgs[1]).toBe("queued");
    expect(updateArgs[2]["watchdog-retries"]).toBe("1");
    expect(notifyEscalationMock).not.toHaveBeenCalled();
  });

  test("second watchdog timeout escalates and notifies", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      session: {
        runAgent: async () => ({ success: false, output: "" }) as any,
        continueSession: async () => ({ success: false, output: "" }) as any,
        continueCommand: async () => ({ success: false, output: "" }) as any,
        getRalphXdgCacheHome: () => cacheDir,
      },
      queue: { updateTaskStatus: updateTaskStatusMock },
      notify: {
        notifyEscalation: notifyEscalationMock,
        notifyError: async () => {},
        notifyTaskComplete: async () => {},
      },
      throttle: {
        getThrottleDecision: async () => ({ state: "ok", resumeAtTs: null, snapshot: {} }) as any,
      },
    });

    (worker as any).writeWatchdogStuckWriteback = writeStuckMock;
    (worker as any).writeEscalationWriteback = writeEscalationMock;

    const timeout: WatchdogTimeoutInfo = {
      kind: "watchdog-timeout",
      source: "tool-watchdog",
      toolName: "bash",
      callId: "call-1",
      elapsedMs: 120000,
      softMs: 30000,
      hardMs: 120000,
      lastProgressMsAgo: 120000,
    };

    const task = {
      _path: "orchestration/tasks/test.md",
      _name: "test",
      type: "agent-task",
      "creation-date": "2026-01-01",
      scope: "builder",
      issue: "3mdistal/ralph#1",
      repo: "3mdistal/ralph",
      status: "in-progress",
      name: "Watchdog Task",
      "watchdog-retries": "1",
    } as any;

    const result: SessionResult = {
      sessionId: "ses_124",
      output: "timeout",
      success: false,
      exitCode: 124,
      watchdogTimeout: timeout,
    };

    await (worker as any).handleWatchdogTimeout(task, "cache-key", "plan", result, undefined);

    expect(writeStuckMock).not.toHaveBeenCalled();
    expect(writeEscalationMock).toHaveBeenCalledTimes(1);
    expect(notifyEscalationMock).toHaveBeenCalledTimes(1);
    const updateArgs = updateTaskStatusMock.mock.calls.find((call) => call[1] === "escalated") ?? [];
    expect(updateArgs[1]).toBe("escalated");
  });
});
