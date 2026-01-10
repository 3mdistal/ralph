import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "fs/promises";

import { getSessionNowDoing } from "../live-status";
import { getSessionDir, getSessionEventsPath } from "../paths";

describe("live status", () => {
  test("detects current step and in-flight tool", async () => {
    const sessionId = `ses_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const dir = getSessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const toolStartTs = Date.now() - 65_000;

    const lines = [
      JSON.stringify({ type: "step-start", ts: Date.now() - 70_000, step: 3, title: "build", repo: "3mdistal/ralph", issue: "3mdistal/ralph#8", taskName: "Improve logs" }),
      JSON.stringify({ type: "tool-start", ts: toolStartTs, toolName: "task", callId: "call_1" }),
    ];

    await writeFile(getSessionEventsPath(sessionId), lines.join("\n") + "\n", "utf8");

    try {
      const nowDoing = await getSessionNowDoing(sessionId);
      expect(nowDoing).not.toBeNull();
      expect(nowDoing?.step).toBe(3);
      expect(nowDoing?.toolName).toBe("task");
      expect(nowDoing?.toolCallId).toBe("call_1");
      expect((nowDoing?.toolElapsedMs ?? 0) >= 64_000).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("clears in-flight tool after tool-end", async () => {
    const sessionId = `ses_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const dir = getSessionDir(sessionId);
    await mkdir(dir, { recursive: true });

    const now = Date.now();

    const lines = [
      JSON.stringify({ type: "step-start", ts: now - 10_000, step: 1, title: "next-task" }),
      JSON.stringify({ type: "tool-start", ts: now - 5_000, toolName: "bash", callId: "call_2" }),
      JSON.stringify({ type: "tool-end", ts: now - 1_000, toolName: "bash", callId: "call_2" }),
    ];

    await writeFile(getSessionEventsPath(sessionId), lines.join("\n") + "\n", "utf8");

    try {
      const nowDoing = await getSessionNowDoing(sessionId);
      expect(nowDoing).not.toBeNull();
      expect(nowDoing?.toolName).toBeUndefined();
      expect(nowDoing?.toolElapsedMs).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
