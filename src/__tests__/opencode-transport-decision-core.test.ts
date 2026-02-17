import { describe, expect, test } from "bun:test";

import { decideTransport } from "../opencode/transport-decision-core";

describe("opencode transport decision core", () => {
  test("cli mode always chooses cli without fallback", () => {
    const result = decideTransport("cli", { fallbackConsumed: false });
    expect(result).toEqual({ mode: "cli", allowFallback: false });
  });

  test("sdk mode always chooses sdk without fallback", () => {
    const result = decideTransport("sdk", { fallbackConsumed: false });
    expect(result).toEqual({ mode: "sdk", allowFallback: false });
  });

  test("sdk-preferred chooses sdk before fallback is consumed", () => {
    const result = decideTransport("sdk-preferred", { fallbackConsumed: false });
    expect(result).toEqual({ mode: "sdk", allowFallback: true });
  });

  test("sdk-preferred chooses cli after fallback is consumed", () => {
    const result = decideTransport("sdk-preferred", { fallbackConsumed: true });
    expect(result).toEqual({ mode: "cli", allowFallback: false });
  });
});
