import { describe, expect, test } from "bun:test";
import { buildDoctorPlan } from "../commands/doctor/core";
import type { DoctorObservedRecord } from "../commands/doctor/types";

function daemonRecord(params: {
  root: string;
  path: string;
  daemonId: string;
  pid: number;
  startedAt: string;
  liveness: "alive" | "dead" | "unknown";
  controlFilePath?: string;
  status?: "live" | "stale" | "invalid";
}): DoctorObservedRecord {
  return {
    kind: "daemon.json",
    root: params.root,
    path: params.path,
    exists: true,
    isReadable: true,
    status: params.status ?? (params.liveness === "alive" ? "live" : "stale"),
    payloadText: JSON.stringify({ daemonId: params.daemonId }),
    mtimeMs: 10,
    size: 20,
    daemon: {
      daemonId: params.daemonId,
      pid: params.pid,
      startedAt: params.startedAt,
      ralphVersion: "0.1.0",
      command: ["bun", "src/index.ts"],
      cwd: "/tmp",
      controlFilePath: params.controlFilePath ?? `${params.root}/control.json`,
      liveness: params.liveness,
    },
  };
}

describe("doctor core", () => {
  test("reports healthy when canonical live daemon is clean", () => {
    const canonicalRoot = "/state/ralph";
    const plan = buildDoctorPlan({
      canonicalRoot,
      records: [
        daemonRecord({
          root: canonicalRoot,
          path: `${canonicalRoot}/daemon.json`,
          daemonId: "d1",
          pid: 100,
          startedAt: "2026-02-01T00:00:00.000Z",
          liveness: "alive",
        }),
      ],
      warnings: [],
      now: 1,
    });

    expect(plan.result).toBe("healthy");
    expect(plan.actions).toHaveLength(0);
  });

  test("plans canonical write and stale quarantine for mismatched roots", () => {
    const canonicalRoot = "/state/ralph";
    const otherRoot = "/tmp/ralph/1000";
    const plan = buildDoctorPlan({
      canonicalRoot,
      records: [
        daemonRecord({
          root: canonicalRoot,
          path: `${canonicalRoot}/daemon.json`,
          daemonId: "old",
          pid: 200,
          startedAt: "2026-01-01T00:00:00.000Z",
          liveness: "dead",
        }),
        daemonRecord({
          root: otherRoot,
          path: `${otherRoot}/daemon.json`,
          daemonId: "live",
          pid: 300,
          startedAt: "2026-02-01T00:00:00.000Z",
          liveness: "alive",
        }),
      ],
      warnings: [],
      now: 42,
    });

    expect(plan.result).toBe("needs_repair");
    expect(plan.actions.some((action) => action.code === "write-canonical-daemon-record")).toBe(true);
    expect(plan.actions.some((action) => action.code === "quarantine-stale-daemon-record")).toBe(true);
  });

  test("returns collision when multiple live daemons are present", () => {
    const canonicalRoot = "/state/ralph";
    const plan = buildDoctorPlan({
      canonicalRoot,
      records: [
        daemonRecord({
          root: canonicalRoot,
          path: `${canonicalRoot}/daemon.json`,
          daemonId: "d1",
          pid: 101,
          startedAt: "2026-02-01T00:00:00.000Z",
          liveness: "alive",
        }),
        daemonRecord({
          root: "/other",
          path: "/other/daemon.json",
          daemonId: "d2",
          pid: 202,
          startedAt: "2026-02-01T01:00:00.000Z",
          liveness: "alive",
        }),
      ],
      warnings: [],
      now: 1,
    });

    expect(plan.result).toBe("collision");
    expect(plan.actions).toHaveLength(0);
  });

  test("does not quarantine unknown liveness records", () => {
    const canonicalRoot = "/state/ralph";
    const plan = buildDoctorPlan({
      canonicalRoot,
      records: [
        daemonRecord({
          root: "/x",
          path: "/x/daemon.json",
          daemonId: "d1",
          pid: 123,
          startedAt: "2026-02-01T00:00:00.000Z",
          liveness: "unknown",
        }),
      ],
      warnings: [],
      now: 1,
    });

    expect(plan.actions.some((action) => action.code === "quarantine-stale-daemon-record")).toBe(false);
  });
});
