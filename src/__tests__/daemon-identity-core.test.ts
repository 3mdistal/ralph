import { describe, expect, test } from "bun:test";
import { analyzeLiveDaemonCandidates } from "../daemon-identity-core";

describe("daemon identity core", () => {
  test("groups duplicate live records by daemonId+pid and prefers canonical representative", () => {
    const analysis = analyzeLiveDaemonCandidates([
      {
        path: "/tmp/legacy/daemon.json",
        isCanonical: false,
        alive: true,
        record: { daemonId: "d1", pid: 111, startedAt: "2026-02-09T00:00:00.000Z" },
      },
      {
        path: "/home/test/.ralph/control/daemon-registry.json",
        isCanonical: true,
        alive: true,
        record: { daemonId: "d1", pid: 111, startedAt: "2026-02-09T00:00:01.000Z" },
      },
    ]);

    expect(analysis.hasConflict).toBeFalse();
    expect(analysis.distinctLiveIdentities).toBe(1);
    expect(analysis.duplicateGroups.length).toBe(1);
    expect(analysis.primaryLiveCandidate?.path).toBe("/home/test/.ralph/control/daemon-registry.json");
  });

  test("marks conflict when multiple distinct live identities are present", () => {
    const analysis = analyzeLiveDaemonCandidates([
      {
        path: "/home/test/.ralph/control/daemon-registry.json",
        isCanonical: true,
        alive: true,
        record: { daemonId: "d1", pid: 111, startedAt: "2026-02-09T00:00:00.000Z" },
      },
      {
        path: "/tmp/legacy/daemon.json",
        isCanonical: false,
        alive: true,
        record: { daemonId: "d2", pid: 222, startedAt: "2026-02-09T00:00:00.000Z" },
      },
    ]);

    expect(analysis.hasConflict).toBeTrue();
    expect(analysis.distinctLiveIdentities).toBe(2);
    expect(analysis.primaryLiveCandidate).toBeNull();
  });
});
