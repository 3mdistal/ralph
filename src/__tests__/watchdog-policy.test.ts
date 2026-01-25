import { buildWatchdogSignature, shouldEarlyTerminateWatchdog } from "../watchdog-policy";
import type { WatchdogTimeoutInfo } from "../session";

describe("watchdog-policy", () => {
  test("buildWatchdogSignature is deterministic", () => {
    const timeout: WatchdogTimeoutInfo = {
      kind: "watchdog-timeout",
      source: "tool-watchdog",
      toolName: "bash",
      callId: "call-1",
      elapsedMs: 1000,
      softMs: 100,
      hardMs: 1000,
      lastProgressMsAgo: 1000,
      argsPreview: "echo hi",
    };

    const sigA = buildWatchdogSignature({ stage: "plan", timeout });
    const sigB = buildWatchdogSignature({ stage: "plan", timeout });
    const sigC = buildWatchdogSignature({ stage: "build", timeout });

    expect(sigA).toBe(sigB);
    expect(sigA).not.toBe(sigC);
  });

  test("shouldEarlyTerminateWatchdog returns true on repeated tool pattern", () => {
    const timeout: WatchdogTimeoutInfo = {
      kind: "watchdog-timeout",
      source: "tool-watchdog",
      toolName: "bash",
      callId: "call-1",
      elapsedMs: 1000,
      softMs: 100,
      hardMs: 1000,
      lastProgressMsAgo: 1000,
      argsPreview: "echo hi",
      recentEvents: [
        JSON.stringify({ type: "tool-start", tool: { name: "bash", input: "echo hi" } }),
        JSON.stringify({ type: "tool-start", tool: { name: "bash", input: "echo hi" } }),
        JSON.stringify({ type: "tool-start", tool: { name: "bash", input: "echo hi" } }),
      ],
    };

    const currentSignature = buildWatchdogSignature({ stage: "plan", timeout });
    expect(
      shouldEarlyTerminateWatchdog({
        retryCount: 0,
        currentSignature,
        priorSignature: null,
        sessionId: "ses_1",
        priorSessionId: "ses_1",
        timeout,
      })
    ).toBe(true);
  });

  test("shouldEarlyTerminateWatchdog only trusts prior signature on same session", () => {
    const timeout: WatchdogTimeoutInfo = {
      kind: "watchdog-timeout",
      source: "tool-watchdog",
      toolName: "bash",
      callId: "call-1",
      elapsedMs: 1000,
      softMs: 100,
      hardMs: 1000,
      lastProgressMsAgo: 1000,
      argsPreview: "echo hi",
    };

    const currentSignature = buildWatchdogSignature({ stage: "plan", timeout });
    expect(
      shouldEarlyTerminateWatchdog({
        retryCount: 0,
        currentSignature,
        priorSignature: currentSignature,
        sessionId: "ses_1",
        priorSessionId: "ses_2",
        timeout,
      })
    ).toBe(false);

    expect(
      shouldEarlyTerminateWatchdog({
        retryCount: 0,
        currentSignature,
        priorSignature: currentSignature,
        sessionId: "ses_1",
        priorSessionId: "ses_1",
        timeout,
      })
    ).toBe(true);
  });
});
