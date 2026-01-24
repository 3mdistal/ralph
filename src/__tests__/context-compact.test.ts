import { describe, expect, test } from "bun:test";

import { buildContextResumePrompt, retryContextCompactOnce } from "../context-compact";

describe("context-compact helpers", () => {
  test("buildContextResumePrompt includes plan path and git status", () => {
    const prompt = buildContextResumePrompt({
      planPath: ".ralph/plan.md",
      gitStatus: "M src/index.ts",
    });

    expect(prompt).toContain(".ralph/plan.md");
    expect(prompt).toContain("M src/index.ts");
  });

  test("retryContextCompactOnce compacts then resumes", async () => {
    const calls: string[] = [];

    const session = {
      continueCommand: async () => {
        calls.push("compact");
        return { success: true, output: "", sessionId: "ses_abc" } as any;
      },
      continueSession: async () => {
        calls.push("resume");
        return { success: true, output: "ok", sessionId: "ses_abc" } as any;
      },
    };

    const result = await retryContextCompactOnce({
      session,
      repoPath: "/tmp",
      sessionId: "ses_abc",
      stepKey: "plan",
      attempt: { allowed: true, attempt: 1 },
      resumeMessage: "resume",
    });

    expect(calls).toEqual(["compact", "resume"]);
    expect(result?.success).toBe(true);
  });
});
