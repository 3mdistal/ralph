import { describe, expect, test } from "bun:test";

import { matchAnyToken, parseReplayLast, serializeStateSnapshot } from "../dashboard/control-plane-core";

describe("control plane core", () => {
  test("matchAnyToken accepts any matching token", () => {
    const result = matchAnyToken({
      expected: "secret",
      headerToken: null,
      protocolToken: "wrong",
      protocol: "ralph.bearer.wrong",
      queryToken: "secret",
    });

    expect(result.authorized).toBe(true);
    expect(result.protocol).toBe(null);
  });

  test("matchAnyToken echoes protocol when it matches", () => {
    const result = matchAnyToken({
      expected: "secret",
      headerToken: null,
      protocolToken: "secret",
      protocol: "ralph.bearer.secret",
      queryToken: null,
    });

    expect(result.authorized).toBe(true);
    expect(result.protocol).toBe("ralph.bearer.secret");
  });

  test("parseReplayLast clamps and defaults", () => {
    expect(parseReplayLast(null, 3, 5)).toBe(3);
    expect(parseReplayLast("nan", 3, 5)).toBe(3);
    expect(parseReplayLast("-1", 3, 5)).toBe(0);
    expect(parseReplayLast("2.9", 3, 5)).toBe(2);
    expect(parseReplayLast("100", 3, 5)).toBe(5);
  });

  test("serializeStateSnapshot redacts sensitive text", () => {
    const payload = serializeStateSnapshot({ token: "ghp_1234567890123456789012345" });
    expect(payload).toContain("ghp_[REDACTED]");
    expect(payload).not.toContain("ghp_1234567890123456789012345");
    expect(JSON.parse(payload).token).toBe("ghp_[REDACTED]");
  });
});
