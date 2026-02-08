import { describe, expect, test } from "bun:test";

import { deriveDaemonLiveness } from "../daemon-liveness";

describe("daemon liveness", () => {
  test("fails closed when desired mode is running and daemon record is missing", () => {
    const result = deriveDaemonLiveness({ desiredMode: "running", daemonRecord: null });
    expect(result.desiredMode).toBe("running");
    expect(result.effectiveMode).toBe("stale");
    expect(result.daemonLiveness.state).toBe("missing");
    expect(result.daemonLiveness.mismatch).toBe(true);
    expect(result.daemonLiveness.hint).toContain("Daemon liveness mismatch");
  });

  test("marks dead pid as mismatch for running mode", () => {
    const result = deriveDaemonLiveness({
      desiredMode: "running",
      daemonRecord: { daemonId: "d1", pid: 42 },
      probe: () => "dead",
    });
    expect(result.effectiveMode).toBe("stale");
    expect(result.daemonLiveness.state).toBe("dead");
    expect(result.daemonLiveness.mismatch).toBe(true);
  });

  test("treats unknown pid probe as unconfirmed liveness", () => {
    const result = deriveDaemonLiveness({
      desiredMode: "running",
      daemonRecord: { daemonId: "d2", pid: 88 },
      probe: () => "unknown",
    });
    expect(result.effectiveMode).toBe("stale");
    expect(result.daemonLiveness.state).toBe("unknown");
    expect(result.daemonLiveness.mismatch).toBe(true);
  });

  test("does not rewrite non-running desired modes", () => {
    const result = deriveDaemonLiveness({
      desiredMode: "paused",
      daemonRecord: { daemonId: "d3", pid: 99 },
      probe: () => "dead",
    });
    expect(result.effectiveMode).toBe("paused");
    expect(result.daemonLiveness.state).toBe("dead");
    expect(result.daemonLiveness.mismatch).toBe(false);
  });
});
