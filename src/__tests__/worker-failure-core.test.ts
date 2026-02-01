import { describe, expect, test } from "bun:test";
import { buildWorkerFailureAlert } from "../alerts/worker-failure-core";

describe("worker failure alert core", () => {
  test("fingerprint seed ignores pointer changes", () => {
    const base = buildWorkerFailureAlert({
      kind: "runtime-error",
      stage: "plan",
      reason: "Planner failed",
      pointers: { sessionId: "sess-1", worktreePath: "/home/alice/repo" },
    });

    const updated = buildWorkerFailureAlert({
      kind: "runtime-error",
      stage: "plan",
      reason: "Planner failed",
      pointers: { sessionId: "sess-2", worktreePath: "/Users/bob/repo" },
    });

    expect(base.fingerprintSeed).toBe(updated.fingerprintSeed);
  });

  test("details redact local paths", () => {
    const alert = buildWorkerFailureAlert({
      kind: "blocked",
      stage: "blocked:dirty-repo",
      reason: "Repo root dirty",
      pointers: { worktreePath: "/home/alice/Developer/project" },
    });

    expect(alert.details).toContain("~/Developer/project");
  });
});
