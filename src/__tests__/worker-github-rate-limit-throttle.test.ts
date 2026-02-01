import { describe, expect, mock, test } from "bun:test";

import { RepoWorker } from "../worker";
import { GitHubApiError } from "../github/client";

function createTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "github:3mdistal/ralph#10",
    _name: "issue-10",
    type: "agent-task",
    "creation-date": "2026-02-01",
    scope: "builder",
    issue: "3mdistal/ralph#10",
    repo: "3mdistal/ralph",
    status: "in-progress",
    name: "Issue 10",
    ...overrides,
  } as any;
}

describe("RepoWorker.pauseIfGitHubRateLimited", () => {
  test("rate-limit error moves task to throttled", async () => {
    const updateTaskStatusMock = mock(async () => true);
    const queueAdapter = { updateTaskStatus: updateTaskStatusMock } as any;
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const task = createTask();

    const error = new GitHubApiError({
      message: "API rate limit exceeded",
      code: "rate_limit",
      status: 403,
      requestId: "req-1",
      responseText: "API rate limit exceeded for installation ID 123",
      resumeAtTs: Date.now() + 60_000,
    });

    const result = await (worker as any).pauseIfGitHubRateLimited(task, "process", error, {
      sessionId: "sess-1",
    });

    expect(result?.outcome).toBe("throttled");
    expect(updateTaskStatusMock).toHaveBeenCalled();
    const call = updateTaskStatusMock.mock.calls[0] as any;
    expect(call?.[1]).toBe("throttled");
    expect(typeof call?.[2]?.["resume-at"]).toBe("string");
  });

  test("non-rate-limit errors do not throttle", async () => {
    const updateTaskStatusMock = mock(async () => true);
    const queueAdapter = { updateTaskStatus: updateTaskStatusMock } as any;
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const task = createTask();

    const error = new GitHubApiError({
      message: "Forbidden",
      code: "auth",
      status: 403,
      requestId: "req-auth",
      responseText: "Forbidden",
    });

    const result = await (worker as any).pauseIfGitHubRateLimited(task, "process", error);
    expect(result).toBeNull();
    expect(updateTaskStatusMock).not.toHaveBeenCalled();
  });
});
