import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { appendConsultantPacket } from "../escalation-consultant/io";
import { CONSULTANT_MARKER } from "../escalation-consultant/core";
import { closeStateDbForTests } from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

describe("escalation consultant io", () => {
  let tempDir = "";
  let releaseLock: (() => void) | null = null;
  let priorStateDbPath: string | undefined;

  beforeEach(async () => {
    releaseLock = await acquireGlobalTestLock();
    tempDir = await mkdtemp(join(tmpdir(), "ralph-consultant-"));
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    process.env.RALPH_STATE_DB_PATH = join(tempDir, "state.sqlite");
    closeStateDbForTests();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    closeStateDbForTests();
    if (priorStateDbPath === undefined) {
      delete process.env.RALPH_STATE_DB_PATH;
    } else {
      process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
    }
    releaseLock?.();
  });

  test("appends consultant packet once", async () => {
    const notePath = join(tempDir, "escalation.md");
    await writeFile(notePath, "## Escalation Summary\n\n| Field | Value |\n| Reason | Needs guidance |\n", "utf8");

    const output = [
      "RALPH_CONSULTANT_BRIEF_BEGIN",
      "Trigger: Needs input",
      "Recommendation: Needs human decision.",
      "RALPH_CONSULTANT_BRIEF_END",
      "RALPH_CONSULTANT_JSON_BEGIN",
      JSON.stringify({
        schema_version: 1,
        decision: "needs-human",
        confidence: "low",
        requires_approval: true,
        proposed_resolution_text: "Add guidance",
        reason: "Missing requirements",
        followups: [],
      }),
      "RALPH_CONSULTANT_JSON_END",
    ].join("\n");

    const runAgent = async () => ({
      sessionId: "ses_test",
      output,
      success: true,
    });

    const first = await appendConsultantPacket(
      notePath,
      {
        issue: "3mdistal/ralph#1",
        repo: "3mdistal/ralph",
        taskName: "Test task",
        escalationType: "other",
        reason: "Needs guidance",
      },
      { runAgent }
    );

    const second = await appendConsultantPacket(
      notePath,
      {
        issue: "3mdistal/ralph#1",
        repo: "3mdistal/ralph",
        taskName: "Test task",
        escalationType: "other",
        reason: "Needs guidance",
      },
      { runAgent }
    );

    const content = await readFile(notePath, "utf8");
    expect(first.status).toBe("appended");
    expect(second.status).toBe("skipped");
    expect(content).toContain(CONSULTANT_MARKER);
  });
});
