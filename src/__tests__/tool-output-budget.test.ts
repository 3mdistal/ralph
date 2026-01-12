import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile, readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

import { applyToolOutputBudget, enforceToolOutputBudgetInStorage } from "../session";

describe("tool output budget", () => {
  test("applyToolOutputBudget adds an explicit marker", () => {
    const huge = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
    const out = applyToolOutputBudget(huge);
    expect(out.truncated).toBe(true);
    expect(out.text).toContain("output truncated");
  });

  test("enforceToolOutputBudgetInStorage truncates tool parts", async () => {
    const sessionId = `ses_test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const homeDir = homedir();
    const xdgDataHome = join(homeDir, ".local", "share");
    const storageDir = join(xdgDataHome, "opencode", "storage");

    const messageId = `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    const messagesDir = join(storageDir, "message", sessionId);
    const partsDir = join(storageDir, "part", messageId);

    await mkdir(messagesDir, { recursive: true });
    await mkdir(partsDir, { recursive: true });

    const messagePath = join(messagesDir, "1.json");
    await writeFile(
      messagePath,
      JSON.stringify({ id: messageId, sessionID: sessionId, role: "assistant", time: { created: Date.now() } }),
      "utf8"
    );

    const toolOutput = Array.from({ length: 300 }, () => "x".repeat(120)).join("\n");

    const partPath = join(partsDir, "1.json");
    await writeFile(partPath, JSON.stringify({ type: "toolResult", output: toolOutput }), "utf8");

    try {
      await enforceToolOutputBudgetInStorage(sessionId, { homeDir, xdgDataHome });

      const updated = JSON.parse(await readFile(partPath, "utf8"));
      expect(typeof updated.output).toBe("string");
      expect(updated.output).toContain("output truncated");
      // Hard cap: should now be comfortably below the original size.
      expect(updated.output.length).toBeLessThan(toolOutput.length);
    } finally {
      // Clean up just this session's storage.
      await rm(join(storageDir, "message", sessionId), { recursive: true, force: true });
      await rm(join(storageDir, "part", messageId), { recursive: true, force: true });
    }
  });
});
