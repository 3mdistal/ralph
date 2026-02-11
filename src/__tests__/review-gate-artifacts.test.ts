import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { prepareReviewDiffArtifacts, runReviewGate } from "../gates/review";
import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  getLatestRunGateStateForIssue,
  initStateDb,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("prepareReviewDiffArtifacts", () => {
  let homeDir = "";
  let priorHome: string | undefined;
  let releaseLock: (() => void) | null = null;
  let priorStateDbPath: string | undefined;

  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    priorHome = process.env.HOME;
    homeDir = await mkdtemp(join(tmpdir(), "ralph-review-gate-"));
    process.env.HOME = homeDir;
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      process.env.HOME = priorHome;
      if (homeDir) {
        await rm(homeDir, { recursive: true, force: true });
      }
    } finally {
      if (priorStateDbPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      }
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("uses base fetch only and no-color diff for SHA head", async () => {
    const calls: string[][] = [];
    const execGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "diff" && args.includes("--stat")) {
        return " src/app.ts | 2 +-\n";
      }
      if (args[0] === "diff") {
        return "diff --git a/src/app.ts b/src/app.ts\n";
      }
      return "";
    };

    const result = await prepareReviewDiffArtifacts({
      runId: "run-sha-head",
      repoPath: "/tmp/repo",
      baseRef: "bot/integration",
      headRef: "abcdef1234567890",
      execGit,
    });

    expect(calls).toEqual([
      ["fetch", "origin", "bot/integration"],
      ["diff", "--no-color", "--stat", "origin/bot/integration...abcdef1234567890"],
      ["diff", "--no-color", "origin/bot/integration...abcdef1234567890"],
    ]);
    expect(result.diffStat).toBe("src/app.ts | 2 +-");
    const diffText = await readFile(result.diffPath, "utf8");
    expect(diffText).toContain("diff --git");
  });

  test("supports HEAD without attempting fetch origin HEAD", async () => {
    const calls: string[][] = [];
    const execGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "diff" && args.includes("--stat")) {
        return " src/main.ts | 1 +\n";
      }
      if (args[0] === "diff") {
        return "diff --git a/src/main.ts b/src/main.ts\n";
      }
      return "";
    };

    await prepareReviewDiffArtifacts({
      runId: "run-head-ref",
      repoPath: "/tmp/repo",
      baseRef: "bot/integration",
      headRef: "HEAD",
      execGit,
    });

    expect(calls).toEqual([
      ["fetch", "origin", "bot/integration"],
      ["diff", "--no-color", "--stat", "origin/bot/integration...HEAD"],
      ["diff", "--no-color", "origin/bot/integration...HEAD"],
    ]);
  });

  test("runReviewGate prompt uses diff artifact and stat without embedding full diff", async () => {
    initStateDb();
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#235",
      taskPath: "github:3mdistal/ralph#235",
      attemptKind: "process",
    });
    ensureRalphRunGateRows({ runId });

    let capturedPrompt = "";
    const result = await runReviewGate({
      runId,
      gate: "product_review",
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#235",
      prUrl: "https://github.com/3mdistal/ralph/pull/235",
      issueContext: "Issue context text",
      diff: {
        baseRef: "bot/integration",
        headRef: "HEAD",
        diffPath: "/tmp/ralph-review.diff",
        diffStat: " src/app.ts | 2 +-",
      },
      runAgent: async (prompt: string) => {
        capturedPrompt = prompt;
        return {
          sessionId: "ses_test",
          success: true,
          output: ["Looks good", 'RALPH_REVIEW: {"status":"pass","reason":"ok"}'].join("\n"),
        };
      },
    });

    expect(result.status).toBe("pass");
    expect(capturedPrompt).toContain("Full diff artifact");
    expect(capturedPrompt).toContain("/tmp/ralph-review.diff");
    expect(capturedPrompt).toContain("git diff --stat:");
    expect(capturedPrompt).toContain("Intent (required):");
    expect(capturedPrompt).not.toContain("diff --git a/");

    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 235 });
    const gate = state?.results.find((entry) => entry.gate === "product_review");
    expect(gate?.status).toBe("pass");
    expect(gate?.prUrl).toBe("https://github.com/3mdistal/ralph/pull/235");
    expect(gate?.prNumber).toBe(235);

    const commandOutputArtifact = state?.artifacts.find(
      (entry) => entry.gate === "product_review" && entry.kind === "command_output"
    );
    expect(commandOutputArtifact?.content).toContain('RALPH_REVIEW: {"status":"pass","reason":"ok"}');
  });

  test("persists raw output and marker parse failure for invalid response", async () => {
    initStateDb();
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#236",
      taskPath: "github:3mdistal/ralph#236",
      attemptKind: "process",
    });
    ensureRalphRunGateRows({ runId });

    const result = await runReviewGate({
      runId,
      gate: "product_review",
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#236",
      prUrl: "https://github.com/3mdistal/ralph/pull/236",
      issueContext: "Issue context text",
      diff: {
        baseRef: "bot/integration",
        headRef: "HEAD",
        diffPath: "/tmp/ralph-review.diff",
        diffStat: " src/app.ts | 2 +-",
      },
      runAgent: async () => ({
        sessionId: "ses_test_fail",
        success: true,
        output: "missing marker output",
      }),
      runRepairAgent: async () => ({
        sessionId: "ses_test_fail",
        success: true,
        output: "still missing marker",
      }),
    });

    expect(result.status).toBe("fail");
    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 236 });
    const gate = state?.results.find((entry) => entry.gate === "product_review");
    expect(gate?.status).toBe("fail");
    expect(gate?.prUrl).toBe("https://github.com/3mdistal/ralph/pull/236");
    expect(gate?.prNumber).toBe(236);

    const commandOutputs = state?.artifacts.filter(
      (entry) => entry.gate === "product_review" && entry.kind === "command_output"
    );
    expect(commandOutputs?.some((entry) => entry.content.includes("missing marker output"))).toBe(true);

    const parseArtifacts = state?.artifacts.filter(
      (entry) => entry.gate === "product_review" && entry.kind === "failure_excerpt"
    );
    expect(Boolean(parseArtifacts && parseArtifacts.length > 0)).toBe(true);
    const parsedPayload = JSON.parse(parseArtifacts?.[0]?.content ?? "{}");
    expect(parsedPayload).toHaveProperty("version", 1);
    expect(parsedPayload).toHaveProperty("ok", false);
    expect(parsedPayload).toHaveProperty("failure");
    expect(parsedPayload).toHaveProperty("reason");
  });
});
