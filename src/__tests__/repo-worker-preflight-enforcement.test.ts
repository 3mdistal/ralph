import { describe, expect, mock, test } from "bun:test";
import { $ } from "bun";
import { mkdtempSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { RepoWorker } from "../worker";

const queueAdapter = {
  updateTaskStatus: async () => true,
};

function createMockTask(overrides: Record<string, unknown> = {}) {
  return {
    _path: "orchestration/tasks/test-task.md",
    _name: "test-task",
    type: "agent-task",
    "creation-date": "2026-01-10",
    scope: "builder",
    issue: "3mdistal/ralph#729",
    repo: "3mdistal/ralph",
    status: "queued",
    priority: "p0-critical",
    name: "Deterministic preflight",
    ...overrides,
  } as any;
}

describe("RepoWorker preflight enforcement", () => {
  test("runDeterministicPreflightForPrCreate fails closed for missing config", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const persist = mock(() => {});
    const execute = mock(async () => ({ status: "pass", commands: ["bun test"] }));

    (worker as any).resolveRepoPreflightPolicyForPrCreate = () => ({
      kind: "missing",
      commands: [],
      source: "none",
      configured: false,
      reason: "no repo preflight command configured",
    });
    (worker as any).persistPreflightPolicyFailure = persist;
    (worker as any).executePreflightGate = execute;

    const result = await (worker as any).runDeterministicPreflightForPrCreate({
      runId: "run-missing",
      worktreePath: "/tmp",
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.causeCode).toBe("POLICY_DENIED");
    expect(result.diagnostics.join("\n")).toContain("Preflight policy failed");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(0);
  });

  test("runDeterministicPreflightForPrCreate allows explicit disable", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const execute = mock(async (params: any) => ({ status: "skipped", commands: [], skipReason: params.skipReason }));

    (worker as any).resolveRepoPreflightPolicyForPrCreate = () => ({
      kind: "disabled",
      commands: [],
      source: "preflightCommand",
      configured: true,
    });
    (worker as any).executePreflightGate = execute;

    const result = await (worker as any).runDeterministicPreflightForPrCreate({
      runId: "run-disabled",
      worktreePath: "/tmp",
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const args = execute.mock.calls[0]?.[0] as any;
    expect(args.commands).toEqual([]);
    expect(args.skipReason).toBe("preflight disabled (preflightCommand=[])");
  });

  test("tryEnsurePrFromWorktree blocks PR creation when deterministic preflight fails", async () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp", { queue: queueAdapter });
    const wtRoot = mkdtempSync(join(tmpdir(), "ralph-preflight-block-"));
    const wtPath = join(wtRoot, "729", "github-3mdistal-ralph-729");
    mkdirSync(wtPath, { recursive: true });
    await $`git init -q`.cwd(wtPath);

    (worker as any).activeRunId = "run-preflight-block";
    (worker as any).maybeSkipIssueForPrRecovery = async () => null;
    (worker as any).getIssuePrResolution = async () => ({
      selectedUrl: null,
      duplicates: [],
      source: "none",
      diagnostics: [],
    });
    (worker as any).getGitWorktrees = async () => [
      {
        worktreePath: wtPath,
        branch: "feature/preflight-block",
        detached: false,
      },
    ];
    (worker as any).runDeterministicPreflightForPrCreate = async () => ({
      ok: false,
      diagnostics: ["- Preflight policy failed; refusing to create PR"],
      causeCode: "POLICY_DENIED",
    });

    const result = await (worker as any).tryEnsurePrFromWorktree({
      task: createMockTask({ status: "in-progress" }),
      issueNumber: "729",
      issueTitle: "Deterministic gates",
      botBranch: "bot/integration",
      started: new Date("2026-02-16T00:00:00.000Z"),
    });

    expect(result.prUrl).toBeNull();
    expect(result.causeCode).toBe("POLICY_DENIED");
    expect(result.diagnostics).toContain("Preflight policy failed");
  });
});
