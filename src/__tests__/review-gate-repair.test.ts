import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { runReviewGate, type ReviewDiffArtifacts } from "../gates/review";
import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  initStateDb,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

function createRun(): { runId: string } {
  const runId = createRalphRun({
    repo: "3mdistal/ralph",
    issue: "3mdistal/ralph#642",
    taskPath: "github:3mdistal/ralph#642",
    attemptKind: "process",
    startedAt: "2026-02-08T00:00:00.000Z",
  });
  ensureRalphRunGateRows({ runId, at: "2026-02-08T00:00:01.000Z" });
  return { runId };
}

function createDiff(): ReviewDiffArtifacts {
  return {
    baseRef: "bot/integration",
    headRef: "deadbeef",
    diffPath: "/tmp/review-diff.patch",
    diffStat: " src/index.ts | 1 +\n 1 file changed, 1 insertion(+) ",
    diffExcerpt: "diff --git a/src/index.ts b/src/index.ts\n",
  };
}

describe("runReviewGate marker repair", () => {
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
      if (priorStateDbPath === undefined) {
        delete process.env.RALPH_STATE_DB_PATH;
      } else {
        process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
      }
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("repairs a missing marker with bounded retry", async () => {
    const { runId } = createRun();
    const diff = createDiff();

    let repairPrompt = "";
    let repairCalls = 0;

    const result = await runReviewGate({
      runId,
      gate: "product_review",
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#642",
      prUrl: "https://github.com/3mdistal/ralph/pull/999",
      diff,
      runAgent: async () => ({
        sessionId: "ses_product",
        success: true,
        output: "product review ok (missing marker)",
      }),
      runRepairAgent: async (prompt: string) => {
        repairCalls += 1;
        repairPrompt = prompt;
        return {
          sessionId: "ses_product",
          success: true,
          output: 'RALPH_REVIEW: {"status":"pass","reason":"Repair succeeded"}',
        };
      },
    });

    expect(result.status).toBe("pass");
    expect(repairCalls).toBe(1);
    expect(repairPrompt).toContain("Prior response (verbatim):");
    expect(repairPrompt).toContain("product review ok (missing marker)");
  });

  test("stops after exhausting repair attempts", async () => {
    const { runId } = createRun();
    const diff = createDiff();

    let repairCalls = 0;

    const result = await runReviewGate({
      runId,
      gate: "devex_review",
      repo: "3mdistal/ralph",
      issueRef: "3mdistal/ralph#642",
      prUrl: "https://github.com/3mdistal/ralph/pull/999",
      diff,
      runAgent: async () => ({
        sessionId: "ses_devex",
        success: true,
        output: "devex review ok (missing marker)",
      }),
      runRepairAgent: async () => {
        repairCalls += 1;
        return {
          sessionId: "ses_devex",
          success: true,
          output: "still missing marker",
        };
      },
    });

    expect(result.status).toBe("fail");
    expect(repairCalls).toBe(2);
  });
});
