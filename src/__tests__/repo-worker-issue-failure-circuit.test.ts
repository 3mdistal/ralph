import { beforeEach, describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";
import { createIssueFailureCircuitBreaker } from "../worker/issue-failure-circuit-breaker";

function createTask() {
  return {
    _path: "orchestration/tasks/circuit.md",
    _name: "circuit",
    type: "agent-task",
    issue: "3mdistal/ralph#792",
    repo: "3mdistal/ralph",
    scope: "builder",
    priority: "p0",
    name: "Circuit breaker task",
    status: "queued",
    "session-id": "",
    "run-log-path": "/tmp/run.log",
  } as any;
}

describe("repo worker issue failure circuit integration", () => {
  const updateTaskStatusMock = mock(async (task: any, status: string, fields: Record<string, string>) => {
    task.status = status;
    Object.assign(task, fields);
    return true;
  });

  const notifyEscalationMock = mock(async () => true);
  const notifyErrorMock = mock(async () => true);
  const notifyTaskCompleteMock = mock(async () => true);
  const writeEscalationWritebackMock = mock(async () => null);
  const recordEscalatedRunNoteMock = mock(async () => {});

  beforeEach(() => {
    updateTaskStatusMock.mockClear();
    notifyEscalationMock.mockClear();
    notifyErrorMock.mockClear();
    notifyTaskCompleteMock.mockClear();
    writeEscalationWritebackMock.mockClear();
    recordEscalatedRunNoteMock.mockClear();
  });

  test("caps repeated same-fingerprint failures with backoff then escalation", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", {
      queue: { updateTaskStatus: updateTaskStatusMock },
    });

    (worker as any).issueFailureCircuit = createIssueFailureCircuitBreaker({
      windowMs: 60_000,
      openAfterCount: 3,
      backoffBaseMs: 1_000,
      backoffCapMs: 10_000,
      jitterMs: 0,
    });
    (worker as any).notify = {
      notifyEscalation: notifyEscalationMock,
      notifyError: notifyErrorMock,
      notifyTaskComplete: notifyTaskCompleteMock,
    };
    (worker as any).writeEscalationWriteback = writeEscalationWritebackMock;
    (worker as any).recordEscalatedRunNote = recordEscalatedRunNoteMock;

    const task = createTask();
    const run = {
      taskName: task.name,
      repo: task.repo,
      outcome: "failed",
      escalationReason: "Failed to mark task starting (queue update failed)",
    } as any;

    await (worker as any).applyIssueFailureCircuitBreaker(task, run, "process");
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(0);

    await (worker as any).applyIssueFailureCircuitBreaker(task, run, "process");
    expect(updateTaskStatusMock).toHaveBeenCalledTimes(1);
    expect(updateTaskStatusMock.mock.calls[0]?.[1]).toBe("throttled");
    expect(updateTaskStatusMock.mock.calls[0]?.[2]?.["resume-at"]).toBeTruthy();

    // Simulate cooldown completion and retry.
    task.status = "queued";
    await (worker as any).applyIssueFailureCircuitBreaker(task, run, "process");

    expect(updateTaskStatusMock).toHaveBeenCalledTimes(2);
    expect(updateTaskStatusMock.mock.calls[1]?.[1]).toBe("escalated");
    expect(notifyEscalationMock).toHaveBeenCalledTimes(1);
    expect(writeEscalationWritebackMock).toHaveBeenCalledTimes(1);
  });
});
