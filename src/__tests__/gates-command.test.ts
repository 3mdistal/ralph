import { expect, test } from "bun:test";

import { buildGateJsonPayload } from "../commands/gates";

test("buildGateJsonPayload includes schema version and state", () => {
  const payload = buildGateJsonPayload({
    repo: "3mdistal/ralph",
    issueNumber: 232,
    state: {
      results: [
        {
          runId: "run-232",
          gate: "ci",
          status: "pass",
          command: null,
          skipReason: null,
          url: "https://github.com/3mdistal/ralph/actions/runs/123",
          prNumber: 232,
          prUrl: "https://github.com/3mdistal/ralph/pull/232",
          repoId: 1,
          issueNumber: 232,
          taskPath: "github:3mdistal/ralph#232",
          createdAt: "2026-01-21T10:00:00.000Z",
          updatedAt: "2026-01-21T10:01:00.000Z",
        },
      ],
      artifacts: [
        {
          id: 1,
          runId: "run-232",
          gate: "ci",
          kind: "failure_excerpt",
          content: "oops",
          truncated: false,
          originalChars: 4,
          originalLines: 1,
          createdAt: "2026-01-21T10:00:30.000Z",
          updatedAt: "2026-01-21T10:00:30.000Z",
        },
      ],
    },
  });

  expect(payload.schemaVersion).toBe(1);
  expect(payload.repo).toBe("3mdistal/ralph");
  expect(payload.issueNumber).toBe(232);
  expect(payload.runId).toBe("run-232");
  expect(payload.results).toHaveLength(1);
  expect(payload.artifacts).toHaveLength(1);
});

test("buildGateJsonPayload handles missing state", () => {
  const payload = buildGateJsonPayload({ repo: "3mdistal/ralph", issueNumber: 232, state: null });

  expect(payload.schemaVersion).toBe(1);
  expect(payload.runId).toBeNull();
  expect(payload.results).toHaveLength(0);
  expect(payload.artifacts).toHaveLength(0);
});
