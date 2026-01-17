import { RepoWorker } from "../worker";

describe("worker isolation guardrails", () => {
  test("resume requires a recorded worktree path", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = {
      _path: "orchestration/tasks/test-task.md",
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      scope: "builder",
      issue: "3mdistal/ralph#102",
      repo: "3mdistal/ralph",
      status: "in-progress",
      priority: "p2-medium",
      name: "Isolation Resume Task",
      "session-id": "ses_123",
    } as any;

    await expect((worker as any).resolveTaskRepoPath(task, "102", "resume")).rejects.toThrow(
      "Missing worktree-path for in-progress task; refusing to resume in main checkout"
    );
  });

  test("rejects worktree path that matches repo root", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const task = {
      _path: "orchestration/tasks/test-task.md",
      _name: "test-task",
      type: "agent-task",
      "creation-date": "2026-01-10",
      scope: "builder",
      issue: "3mdistal/ralph#102",
      repo: "3mdistal/ralph",
      status: "starting",
      priority: "p2-medium",
      name: "Isolation Start Task",
      "worktree-path": "/tmp",
    } as any;

    await expect((worker as any).resolveTaskRepoPath(task, "102", "start")).rejects.toThrow(
      "Recorded worktree-path matches repo root; refusing to run in main checkout: /tmp"
    );
  });
});
