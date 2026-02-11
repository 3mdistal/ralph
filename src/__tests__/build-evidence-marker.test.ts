import { describe, expect, test } from "bun:test";

import { parseRalphBuildEvidenceMarker } from "../gates/build-evidence";

describe("parseRalphBuildEvidenceMarker", () => {
  test("parses a valid final-line marker", () => {
    const output = [
      "Implementation complete.",
      "RALPH_BUILD_EVIDENCE: {\"version\":1,\"branch\":\"ralph/706-single-writer\",\"base\":\"bot/integration\",\"head_sha\":\"2f3c6d0d9b5e2a1c8d4f0a6c2a9f0b1c3d4e5f6a\",\"worktree_clean\":true,\"preflight\":{\"status\":\"pass\",\"command\":\"bun test\",\"summary\":\"pass\"},\"ready_for_pr_create\":true}",
      "",
    ].join("\n");

    const result = parseRalphBuildEvidenceMarker(output);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.evidence.branch).toBe("ralph/706-single-writer");
    expect(result.evidence.base).toBe("bot/integration");
    expect(result.evidence.preflight.status).toBe("pass");
    expect(result.evidence.ready_for_pr_create).toBe(true);
  });

  test("fails on malformed marker JSON", () => {
    const output = "RALPH_BUILD_EVIDENCE: {not json}";
    const result = parseRalphBuildEvidenceMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("invalid_json");
    }
  });

  test("fails when marker is not on final non-empty line", () => {
    const output = [
      "RALPH_BUILD_EVIDENCE: {\"version\":1,\"branch\":\"x\",\"base\":\"bot/integration\",\"head_sha\":\"abcdef1\",\"worktree_clean\":true,\"preflight\":{\"status\":\"pass\",\"command\":\"bun test\",\"summary\":\"pass\"},\"ready_for_pr_create\":true}",
      "extra content",
    ].join("\n");

    const result = parseRalphBuildEvidenceMarker(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe("marker_not_final_line");
    }
  });
});
