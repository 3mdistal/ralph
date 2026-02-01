import { describe, test, expect } from "bun:test";

import { resolveMessageSessionId } from "../dashboard/message-targeting";

describe("message targeting", () => {
  test("workerId takes precedence over sessionId", () => {
    const resolved = resolveMessageSessionId({
      workerId: "worker-1",
      sessionId: "ses_fallback",
      resolveWorkerId: () => "ses_worker",
    });

    expect(resolved.sessionId).toBe("ses_worker");
    expect(resolved.source).toBe("workerId");
  });

  test("workerId resolves to null when inactive", () => {
    const resolved = resolveMessageSessionId({
      workerId: "worker-2",
      sessionId: "ses_unused",
      resolveWorkerId: () => null,
    });

    expect(resolved.sessionId).toBeNull();
    expect(resolved.source).toBe("workerId");
  });

  test("sessionId is used when no workerId provided", () => {
    const resolved = resolveMessageSessionId({
      sessionId: "ses_direct",
      resolveWorkerId: () => null,
    });

    expect(resolved.sessionId).toBe("ses_direct");
    expect(resolved.source).toBe("sessionId");
  });

  test("returns null when no target provided", () => {
    const resolved = resolveMessageSessionId({
      resolveWorkerId: () => null,
    });

    expect(resolved.sessionId).toBeNull();
    expect(resolved.source).toBeNull();
  });
});
