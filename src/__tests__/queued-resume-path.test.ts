import { describe, expect, test } from "bun:test";

import { classifyQueuedResumePath } from "../scheduler/queued-resume-path";

describe("queued resume path classification", () => {
  test("returns fresh when no session id", () => {
    expect(classifyQueuedResumePath({ blockedSource: "review", sessionId: "" })).toBe("fresh");
  });

  test("routes review-blocked queued tasks with a session to review resume path", () => {
    expect(classifyQueuedResumePath({ blockedSource: "review", sessionId: "ses_123" })).toBe("review");
  });

  test("keeps specialized merge-conflict/stall/loop-triage routing precedence", () => {
    expect(classifyQueuedResumePath({ blockedSource: "merge-conflict", sessionId: "ses_123" })).toBe("merge-conflict");
    expect(classifyQueuedResumePath({ blockedSource: "stall", sessionId: "ses_123" })).toBe("stall");
    expect(classifyQueuedResumePath({ blockedSource: "loop-triage", sessionId: "ses_123" })).toBe("loop-triage");
  });

  test("falls back to queued-session for other blocked sources with session", () => {
    expect(classifyQueuedResumePath({ blockedSource: "runtime-error", sessionId: "ses_123" })).toBe("queued-session");
  });
});
