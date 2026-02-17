import { describe, expect, test } from "bun:test";

import { buildStageSendLedgerKey, buildStageSendMessageId, buildStageSendPayload } from "../worker/stage-sends";

describe("stage send helpers", () => {
  test("buildStageSendMessageId is deterministic and whitespace-stable", () => {
    const a = buildStageSendMessageId({
      sessionId: "ses_123",
      stage: "resume",
      content: "Continue implementation",
    });
    const b = buildStageSendMessageId({
      sessionId: "  ses_123  ",
      stage: " resume ",
      content: "Continue   implementation",
    });

    expect(a).toBe(b);
    expect(a.startsWith("stg_")).toBe(true);
  });

  test("buildStageSendLedgerKey scopes by repo task and stage", () => {
    const key = buildStageSendLedgerKey({
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#399",
      stage: "resume",
    });

    expect(key).toBe("ralph:stage-send:v1:3mdistal/ralph:github:3mdistal/ralph#399:resume");
  });

  test("buildStageSendPayload includes canonical restart metadata", () => {
    const payload = buildStageSendPayload({
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#399",
      stage: "resume-survey",
      sessionId: "ses_123",
      messageId: "stg_abc",
      mode: "command",
      command: "survey",
      args: ["--json"],
      at: "2026-02-17T00:00:00.000Z",
    });

    expect(JSON.parse(payload)).toEqual({
      version: 1,
      repo: "3mdistal/ralph",
      taskPath: "github:3mdistal/ralph#399",
      stage: "resume-survey",
      sessionId: "ses_123",
      messageId: "stg_abc",
      mode: "command",
      command: "survey",
      args: ["--json"],
      at: "2026-02-17T00:00:00.000Z",
    });
  });
});
