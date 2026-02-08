import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { executeDoctorPlan } from "../commands/doctor/execute";

describe("doctor execute", () => {
  test("fails quarantine when preconditions drift", () => {
    const base = mkdtempSync(join(tmpdir(), "ralph-doctor-"));
    try {
      const path = join(base, "daemon.json");
      writeFileSync(path, "{}\n");
      const beforeSize = 3;
      writeFileSync(path, '{"version":1}\n');

      const result = executeDoctorPlan([
        {
          kind: "quarantine",
          code: "quarantine-stale-daemon-record",
          from: path,
          to: `${path}.quarantine`,
          preconditions: { size: beforeSize },
        },
      ]);

      expect(result.failures).toBe(1);
      expect(result.actions[0]?.ok).toBe(false);
      expect(result.actions[0]?.error).toContain("size drift");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
