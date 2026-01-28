import { describe, expect, test } from "bun:test";

import { executeIssueLabelOps, planIssueLabelOps } from "../github/issue-label-io";

import {
  deriveRalphStatus,
  deriveTaskView,
  planClaim,
  shouldRecoverStaleInProgress,
  statusToRalphLabelDelta,
} from "../github-queue/core";

function applyDelta(labels: string[], delta: { add: string[]; remove: string[] }): string[] {
  const set = new Set(labels);
  for (const label of delta.remove) {
    set.delete(label);
  }
  for (const label of delta.add) {
    set.add(label);
  }
  return Array.from(set);
}

describe("github queue core", () => {
  test("deriveTaskView infers priority from labels", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 285,
        title: "Priority labels",
        labels: ["p0-critical", "ralph:queued"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p0-critical");
  });

  test("deriveTaskView prefers highest priority label", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 286,
        title: "Priority labels",
        labels: ["p3-low", "p1-high"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p1-high");
  });

  test("deriveTaskView defaults to p2-medium when no priority labels", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 287,
        title: "Priority labels",
        labels: ["bug", "ralph:queued"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p2-medium");
  });

  test("deriveTaskView matches case-insensitive priority prefixes", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 288,
        title: "Priority labels",
        labels: ["P2", "p4 backlog"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p2-medium");
  });

  test("deriveTaskView accepts priority prefixes with suffixes", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 289,
        title: "Priority labels",
        labels: ["p3:low"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p3-low");
  });

  test("statusToRalphLabelDelta only mutates ralph labels", () => {
    const delta = statusToRalphLabelDelta("in-progress", ["bug", "ralph:queued", "dx"]);
    expect(delta).toEqual({ add: ["ralph:in-progress"], remove: ["ralph:queued"] });
  });

  test("statusToRalphLabelDelta preserves queued when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:queued"]);
    expect(delta).toEqual({ add: ["ralph:blocked"], remove: [] });
  });

  test("statusToRalphLabelDelta removes other status labels when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:queued", "ralph:in-progress"]);
    expect(delta).toEqual({ add: ["ralph:blocked"], remove: ["ralph:in-progress"] });
  });

  test("statusToRalphLabelDelta preserves non-ralph labels when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["bug", "ralph:queued", "p1-high", "ralph:in-progress"]);
    expect(delta).toEqual({ add: ["ralph:blocked"], remove: ["ralph:in-progress"] });
  });

  test("statusToRalphLabelDelta still removes queued when escalated", () => {
    const delta = statusToRalphLabelDelta("escalated", ["ralph:queued"]);
    expect(delta).toEqual({ add: ["ralph:escalated"], remove: ["ralph:queued"] });
  });

  test("planClaim requires queued label", () => {
    const plan = planClaim(["ralph:queued"]);
    expect(plan.claimable).toBe(true);
    expect(plan.steps).toEqual([
      { action: "add", label: "ralph:in-progress" },
      { action: "remove", label: "ralph:queued" },
    ]);
  });

  test("planClaim rejects in-progress issues", () => {
    const plan = planClaim(["ralph:in-progress"]);
    expect(plan.claimable).toBe(false);
  });

  test("planClaim allows blocked issues to requeue", () => {
    const plan = planClaim(["ralph:queued", "ralph:blocked"]);
    expect(plan.claimable).toBe(true);
    expect(plan.steps).toEqual([
      { action: "add", label: "ralph:in-progress" },
      { action: "remove", label: "ralph:queued" },
      { action: "remove", label: "ralph:blocked" },
    ]);
  });

  test("planClaim rejects done issues", () => {
    const plan = planClaim(["ralph:queued", "ralph:done"]);
    expect(plan.claimable).toBe(false);
  });

  test("unblocked issues remain queued and claimable", () => {
    const blockedLabels = ["ralph:queued", "ralph:blocked"];
    const delta = statusToRalphLabelDelta("queued", blockedLabels);
    const updated = applyDelta(blockedLabels, delta);
    expect(updated).toEqual(["ralph:queued"]);
    expect(planClaim(updated).claimable).toBe(true);
  });

  test("deriveRalphStatus treats queued+blocked as queued", () => {
    const status = deriveRalphStatus(["ralph:queued", "ralph:blocked"], "OPEN");
    expect(status).toBe("queued");
  });

  test("deriveRalphStatus treats ralph:done as done", () => {
    const status = deriveRalphStatus(["ralph:done", "ralph:queued"], "OPEN");
    expect(status).toBe("done");
  });

  test("shouldRecoverStaleInProgress requires stale heartbeat", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recover = shouldRecoverStaleInProgress({
      labels: ["ralph:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "",
      },
      nowMs,
      ttlMs,
    });

    expect(recover).toBe(true);
  });

  test("shouldRecoverStaleInProgress ignores released tasks", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recover = shouldRecoverStaleInProgress({
      labels: ["ralph:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 64,
        taskPath: "github:3mdistal/ralph#64",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        releasedAtMs: Date.parse("2026-01-11T00:05:00.000Z"),
      },
      nowMs,
      ttlMs,
    });

    expect(recover).toBe(false);
  });

  test("deriveTaskView treats released tasks as queued", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 290,
        title: "Released",
        labels: ["ralph:in-progress"],
      },
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 290,
        taskPath: "github:3mdistal/ralph#290",
        status: "in-progress",
        releasedAtMs: Date.parse("2026-01-23T00:00:00.000Z"),
      },
      nowIso: "2026-01-23T00:10:00.000Z",
    });

    expect(task.status).toBe("queued");
  });
});

describe("issue label io", () => {
  test("executeIssueLabelOps preserves non-ralph labels", async () => {
    const labels = new Set(["bug", "p1-high", "ralph:in-progress"]);
    const calls: Array<{ method: string; path: string }> = [];
    const request = async (path: string, opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      calls.push({ method, path });
      if (method === "POST" && /\/issues\/\d+\/labels$/.test(path)) {
        const body = opts.body as { labels?: string[] } | undefined;
        for (const label of body?.labels ?? []) {
          labels.add(label);
        }
        return { data: null, etag: null, status: 200 };
      }
      if (method === "DELETE") {
        const match = path.match(/\/labels\/([^/]+)$/);
        const label = match ? decodeURIComponent(match[1]) : "";
        const removed = labels.delete(label);
        return { data: null, etag: null, status: removed ? 204 : 404 };
      }
      return { data: null, etag: null, status: 200 };
    };

    const ops = planIssueLabelOps({ add: ["ralph:blocked"], remove: ["ralph:in-progress"] });
    const result = await executeIssueLabelOps({
      github: { request },
      repo: "3mdistal/ralph",
      issueNumber: 286,
      ops,
    });

    expect(result.ok).toBe(true);
    expect(labels.has("bug")).toBe(true);
    expect(labels.has("p1-high")).toBe(true);
    expect(labels.has("ralph:blocked")).toBe(true);
    expect(labels.has("ralph:in-progress")).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE"]);
  });

  test("planIssueLabelOps refuses non-ralph labels", () => {
    expect(() => planIssueLabelOps({ add: ["bug"], remove: [] })).toThrow(
      "Refusing to mutate non-Ralph label"
    );
  });
});
