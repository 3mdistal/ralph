import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { scanOpencodeUsageEvents } from "../throttle";

describe("throttle usage scan diagnostics", () => {
  test("parses ISO timestamps, counts tokens, and records newest message", async () => {
    const root = await mkdtemp(join(tmpdir(), "ralph-throttle-scan-"));

    try {
      const providerID = "openai";
      const messagesRoot = join(root, "opencode", "storage", "message");
      const sessionDir = join(messagesRoot, "ses_test");
      await mkdir(sessionDir, { recursive: true });

      const created = "2026-01-12T12:00:00.000Z";
      const msgPath = join(sessionDir, "msg_1.json");
      await writeFile(
        msgPath,
        JSON.stringify({
          role: "assistant",
          providerID,
          time: { created },
          tokens: { input: 1, output: 2, reasoning: 3 },
        }),
        "utf8"
      );

      const now = Date.parse("2026-01-12T12:00:10.000Z");
      const maxWindowMs = 7 * 24 * 60 * 60 * 1000;
      const result = await scanOpencodeUsageEvents(now, providerID, messagesRoot, maxWindowMs);

      expect(result.stats.messagesRootDirExists).toBe(true);
      expect(result.stats.scannedSessionDirs).toBe(1);
      expect(result.stats.scannedFiles).toBe(1);
      expect(result.stats.parsedFiles).toBe(1);

      expect(result.events.length).toBe(1);
      expect(result.events[0]?.tokens).toBe(6);

      const expectedTs = Date.parse(created);
      expect(result.stats.newestMessageTs).toBe(expectedTs);
      expect(result.stats.newestCountedEventTs).toBe(expectedTs);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
