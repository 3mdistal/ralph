import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function readCanonicalClaims(): Map<string, any> {
  const filePath = resolve(process.cwd(), "claims/canonical.jsonl");
  const contents = readFileSync(filePath, "utf8");
  const lines = contents
    .split(/\r?\n/)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);

  const claims = new Map<string, any>();
  for (const line of lines) {
    const parsed = JSON.parse(line) as any;
    const id = String(parsed?.id ?? "");
    if (!id) continue;
    claims.set(id, parsed);
  }

  return claims;
}

describe("claims/canonical.jsonl statuses", () => {
  test("key shipped claims are marked implemented", () => {
    const claims = readCanonicalClaims();

    const requiredImplemented = [
      "review.marker.contract",
      "ci-debug.lane",
      "merge-conflict.lane",
      "retry-budgets.per-lane-configurable",
      "ci-remediation.on-required-checks-failure",
      "claims.canonical.status-in-sync",
      "daemon.control-root.canonical",
      "daemon.discovery.profile-agnostic",
      "daemon.pid-liveness.required",
      "profiles.selection-not-identity",
      "daemon.singleton.locked",
      "doctor.discovery-repair",
    ];

    for (const id of requiredImplemented) {
      const claim = claims.get(id);
      expect(claim, `Missing canonical claim id: ${id}`).toBeTruthy();
      expect(claim.status, `Claim ${id} must be implemented`).toBe("implemented");
    }
  });
});
