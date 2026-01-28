import { describe, expect, test } from "bun:test";

import {
  SANDBOX_MARKER_TOPIC,
  hasSandboxMarker,
  isSandboxCandidate,
  isSandboxMutableRepo,
} from "../sandbox/selector";

describe("sandbox selector", () => {
  const rules = { allowedOwners: ["3mdistal"], repoNamePrefix: "ralph-sandbox-" };

  test("matches owner + prefix (case-insensitive)", () => {
    const repo = { owner: "3MDistal", name: "Ralph-Sandbox-demo", fullName: "3MDistal/Ralph-Sandbox-demo" };
    expect(isSandboxCandidate(repo, rules)).toBe(true);
  });

  test("rejects missing prefix", () => {
    const repo = { owner: "3mdistal", name: "not-sandbox", fullName: "3mdistal/not-sandbox" };
    expect(isSandboxCandidate(repo, rules)).toBe(false);
  });

  test("marker detection is case-insensitive", () => {
    expect(hasSandboxMarker({ owner: "3mdistal", name: "x", fullName: "3mdistal/x", topics: ["RALPH-SANDBOX"] })).toBe(true);
  });

  test("mutable requires candidate + marker", () => {
    const repo = {
      owner: "3mdistal",
      name: "ralph-sandbox-demo",
      fullName: "3mdistal/ralph-sandbox-demo",
      topics: [SANDBOX_MARKER_TOPIC],
    };
    expect(isSandboxMutableRepo(repo, rules)).toBe(true);
  });
});
