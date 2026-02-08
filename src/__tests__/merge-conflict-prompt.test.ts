import { describe, expect, test } from "bun:test";

import { RepoWorker } from "../worker";

describe("merge-conflict prompt", () => {
  test("forbids /tmp usage", () => {
    const worker = new RepoWorker("3mdistal/ralph", "/tmp");
    const prompt = (worker as any).buildMergeConflictPrompt(
      "https://github.com/3mdistal/ralph/pull/1",
      "bot/integration",
      "bot/integration"
    );

    expect(prompt).toContain("Do not use /tmp");
    expect(prompt).toContain("./.ralph-tmp/");
  });
});
