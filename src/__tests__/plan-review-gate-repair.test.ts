import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { resolvePlanReviewInput, runPlanReviewGate } from "../gates/plan-review";
import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  initStateDb,
} from "../state";

let homeDir = "";
let priorStateDbPath: string | undefined;

function createRun(): { runId: string } {
  const runId = createRalphRun({
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#730",
    taskPath: "github:3mdistal/ralph#730",
    attemptKind: "process",
    startedAt: "2026-02-17T00:00:00.000Z",
  });
  ensureRalphRunGateRows({ runId, at: "2026-02-17T00:00:01.000Z" });
  return { runId };
}

describe("runPlanReviewGate", () => {
  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      if (homeDir) {
        await rm(homeDir, { recursive: true, force: true });
      }
    } finally {
      if (priorStateDbPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      }
      homeDir = "";
    }
  });

  test("repairs missing marker with bounded retry", async () => {
    const { runId } = createRun();
    let repairCalls = 0;

    const result = await runPlanReviewGate({
      runId,
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#730",
      planInput: {
        source: "plan_file",
        planText: "# Plan\n- [ ] Ship marker enforcement",
        note: "Using plan input from .ralph/plan.md",
      },
      runAgent: async () => ({
        sessionId: "ses_plan_review",
        success: true,
        output: "plan review content with missing marker",
      }),
      runRepairAgent: async () => {
        repairCalls += 1;
        return {
          sessionId: "ses_plan_review",
          success: true,
          output: 'RALPH_PLAN_REVIEW: {"status":"pass","reason":"marker repaired"}',
        };
      },
    });

    expect(result.status).toBe("pass");
    expect(repairCalls).toBe(1);
  });

  test("stops after exhausting repair attempts", async () => {
    const { runId } = createRun();
    let repairCalls = 0;

    const result = await runPlanReviewGate({
      runId,
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#730",
      planInput: {
        source: "plan_file",
        planText: "# Plan\n- [ ] enforce gate",
        note: "Using plan input from .ralph/plan.md",
      },
      runAgent: async () => ({
        sessionId: "ses_plan_review",
        success: true,
        output: "still missing marker",
      }),
      runRepairAgent: async () => {
        repairCalls += 1;
        return {
          sessionId: "ses_plan_review",
          success: true,
          output: "still missing marker",
        };
      },
    });

    expect(result.status).toBe("fail");
    expect(repairCalls).toBe(2);
  });

  test("does not attempt repair for invalid payload semantics", async () => {
    const { runId } = createRun();
    let repairCalls = 0;

    const result = await runPlanReviewGate({
      runId,
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#730",
      planInput: {
        source: "plan_file",
        planText: "# Plan\n- [ ] enforce gate",
        note: "Using plan input from .ralph/plan.md",
      },
      runAgent: async () => ({
        sessionId: "ses_plan_review",
        success: true,
        output: 'RALPH_PLAN_REVIEW: {"status":"maybe","reason":""}',
      }),
      runRepairAgent: async () => {
        repairCalls += 1;
        return {
          sessionId: "ses_plan_review",
          success: true,
          output: 'RALPH_PLAN_REVIEW: {"status":"pass","reason":"fixed"}',
        };
      },
    });

    expect(result.status).toBe("fail");
    expect(repairCalls).toBe(0);
  });
});

describe("resolvePlanReviewInput", () => {
  test("uses plan file when non-default", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "plan-input-"));
    try {
      await mkdir(join(worktree, ".ralph"), { recursive: true });
      await writeFile(join(worktree, ".ralph", "plan.md"), "# Plan\n- [x] concrete", "utf8");

      const input = await resolvePlanReviewInput({
        worktreePath: worktree,
        plannerOutput: "planner fallback",
      });

      expect(input.source).toBe("plan_file");
      expect(input.planText).toContain("concrete");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  test("falls back to planner output when plan file is default", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "plan-input-"));
    try {
      await mkdir(join(worktree, ".ralph"), { recursive: true });
      const defaultTemplate = [
        "# Plan",
        "",
        "- [ ] Capture the plan steps here.",
        "- [ ] Update this checklist as steps complete.",
        "",
      ].join("\n");
      await writeFile(join(worktree, ".ralph", "plan.md"), defaultTemplate, "utf8");

      const input = await resolvePlanReviewInput({
        worktreePath: worktree,
        plannerOutput: "planner fallback text",
      });

      expect(input.source).toBe("planner_output");
      expect(input.planText).toContain("planner fallback text");
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });
});
