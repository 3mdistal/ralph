import { describe, expect, test } from "bun:test";
import { mkdir } from "fs/promises";

import { classifyActivity } from "../activity-classifier";
import { getSessionEventsPath } from "../paths";

const buildEvents = (lines: Array<Record<string, unknown>>): string =>
  lines.map((line) => JSON.stringify(line)).join("\n") + "\n";

const ensureDirForFile = async (filePath: string): Promise<void> => {
  const url = new URL(filePath, "file://");
  const dir = url.pathname.split("/").slice(0, -1).join("/") || ".";
  if (dir !== ".") {
    await mkdir(dir, { recursive: true });
  }
};

describe("activity classifier", () => {
  test("prefers tool signals and applies precedence", async () => {
    const sessionId = "ses_activity_precedence";
    const eventsPath = getSessionEventsPath(sessionId);
    const now = Date.now();

    await ensureDirForFile(eventsPath);
    await Bun.write(
      eventsPath,
      buildEvents([
        { type: "tool-start", ts: now - 2000, toolName: "read" },
        { type: "tool-start", ts: now - 1500, toolName: "bash", argsPreview: "git status" },
        { type: "tool-start", ts: now - 1000, toolName: "bash", argsPreview: "gh pr list" },
      ])
    );

    const result = await classifyActivity({ sessionId, now });
    expect(result.activity).toBe("github");
  });

  test("marks waiting after idle threshold", async () => {
    const sessionId = "ses_activity_waiting";
    const eventsPath = getSessionEventsPath(sessionId);
    const now = Date.now();

    await ensureDirForFile(eventsPath);
    await Bun.write(eventsPath, buildEvents([{ type: "tool-start", ts: now - 20_000, toolName: "read" }]));

    const result = await classifyActivity({ sessionId, now });
    expect(result.activity).toBe("waiting");
  });
});
