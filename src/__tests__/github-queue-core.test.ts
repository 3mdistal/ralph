import { describe, expect, test } from "bun:test";

import { executeIssueLabelOps, planIssueLabelOps } from "../github/issue-label-io";

import {
  deriveRalphStatus,
  deriveTaskView,
  planClaim,
  computeStaleInProgressRecovery,
  shouldDebounceOppositeStatusTransition,
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
        labels: ["ralph:priority:p0", "ralph:status:queued"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p0-critical");
  });

  test("deriveTaskView prefers ralph:priority labels", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 285,
        title: "Priority labels",
        labels: ["p0-critical", "ralph:priority:p3"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p3-low");
  });

  test("deriveTaskView prefers highest priority label", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 286,
        title: "Priority labels",
        labels: ["ralph:priority:p3", "ralph:priority:p1"],
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
        labels: ["bug", "ralph:status:queued"],
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
        labels: ["ralph:priority:P2", "p4 backlog"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p2-medium");
  });

  test("deriveTaskView prefers canonical labels over legacy", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 288,
        title: "Priority labels",
        labels: ["p0-critical", "ralph:priority:p3"],
      },
      nowIso: "2026-01-23T00:00:00.000Z",
    });

    expect(task.priority).toBe("p3-low");
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
    const delta = statusToRalphLabelDelta("in-progress", ["bug", "ralph:status:queued", "dx"]);
    expect(delta).toEqual({ add: ["ralph:status:in-progress"], remove: ["ralph:status:queued"] });
  });

  test("statusToRalphLabelDelta maps deps-blocked to queued", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:status:in-progress"], {
      opState: { status: "blocked", blockedSource: "deps" },
    });
    expect(delta).toEqual({ add: ["ralph:status:queued"], remove: ["ralph:status:in-progress"] });
  });

  test("statusToRalphLabelDelta preserves in-progress when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:status:in-progress"]);
    expect(delta).toEqual({ add: [], remove: [] });
  });

  test("statusToRalphLabelDelta removes other status labels when non-deps blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", ["ralph:status:queued", "ralph:status:in-progress"], {
      opState: { status: "blocked", blockedSource: "runtime-error" },
    });
    expect(delta).toEqual({ add: ["ralph:status:in-progress"], remove: ["ralph:status:queued"] });
  });

  test("statusToRalphLabelDelta guards against remove-only status mutation", () => {
    const delta = statusToRalphLabelDelta("in-progress", ["ralph:status:queued", "ralph:status:in-progress"]);
    expect(delta).toEqual({ add: ["ralph:status:in-progress"], remove: ["ralph:status:queued"] });
  });

  test("statusToRalphLabelDelta preserves non-ralph labels when blocked", () => {
    const delta = statusToRalphLabelDelta("blocked", [
      "bug",
      "ralph:status:queued",
      "p1-high",
      "ralph:status:in-progress",
    ]);
    expect(delta).toEqual({
      add: ["ralph:status:in-progress"],
      remove: ["ralph:status:queued"],
    });
  });

  test("statusToRalphLabelDelta maps blocked to in-progress when no status label exists", () => {
    const delta = statusToRalphLabelDelta("blocked", ["bug"]);
    expect(delta).toEqual({ add: ["ralph:status:in-progress"], remove: [] });
  });

  test("statusToRalphLabelDelta keeps queued for deps-blocked", () => {
    const blockedDelta = statusToRalphLabelDelta("blocked", ["ralph:status:queued"], {
      opState: { status: "blocked", blockedSource: "deps" },
    });
    const blockedLabels = applyDelta(["ralph:status:queued"], blockedDelta);
    expect(blockedLabels).toContain("ralph:status:queued");
    expect(blockedLabels).not.toContain("ralph:status:in-progress");
  });

  test("statusToRalphLabelDelta maps escalated to escalated", () => {
    const delta = statusToRalphLabelDelta("escalated", ["ralph:status:queued"]);
    expect(delta).toEqual({ add: ["ralph:status:escalated"], remove: ["ralph:status:queued"] });
  });

  test("statusToRalphLabelDelta maps waiting-on-pr to in-progress label", () => {
    const delta = statusToRalphLabelDelta("waiting-on-pr", ["ralph:status:queued"]);
    expect(delta).toEqual({ add: ["ralph:status:in-progress"], remove: ["ralph:status:queued"] });
  });

  test("debounces opposite queued/in-progress transition with unchanged reason", () => {
    const result = shouldDebounceOppositeStatusTransition({
      fromStatus: "in-progress",
      toStatus: "queued",
      reason: "stale-heartbeat",
      nowMs: 1_000,
      windowMs: 5_000,
      previous: {
        fromStatus: "queued",
        toStatus: "in-progress",
        reason: "stale-heartbeat",
        atMs: 500,
      },
    });
    expect(result.suppress).toBe(true);
  });

  test("allows opposite transition when reason changes", () => {
    const result = shouldDebounceOppositeStatusTransition({
      fromStatus: "in-progress",
      toStatus: "queued",
      reason: "operator-queue",
      nowMs: 1_000,
      windowMs: 5_000,
      previous: {
        fromStatus: "queued",
        toStatus: "in-progress",
        reason: "stale-heartbeat",
        atMs: 500,
      },
    });
    expect(result.suppress).toBe(false);
  });

  test("planClaim requires queued label", () => {
    const plan = planClaim(["ralph:status:queued"]);
    expect(plan.claimable).toBe(true);
    expect(plan.steps).toEqual([
      { action: "add", label: "ralph:status:in-progress" },
      { action: "remove", label: "ralph:status:queued" },
    ]);
  });

  test("planClaim rejects in-progress issues", () => {
    const plan = planClaim(["ralph:status:in-progress"]);
    expect(plan.claimable).toBe(false);
  });

  test("planClaim rejects escalated issues", () => {
    const plan = planClaim(["ralph:status:queued", "ralph:status:escalated"]);
    expect(plan.claimable).toBe(false);
    expect(plan.steps).toEqual([]);
  });

  test("planClaim rejects done issues", () => {
    const plan = planClaim(["ralph:status:queued", "ralph:status:done"]);
    expect(plan.claimable).toBe(false);
  });

  test("legacy blocked labels are removed when queued", () => {
    const blockedLabels = ["ralph:status:queued", "ralph:status:blocked"];
    const delta = statusToRalphLabelDelta("queued", blockedLabels);
    const updated = applyDelta(blockedLabels, delta);
    expect(updated).toEqual(["ralph:status:queued"]);
    expect(planClaim(updated).claimable).toBe(true);
  });

  test("deriveRalphStatus treats legacy blocked as blocked", () => {
    const status = deriveRalphStatus(["ralph:status:blocked"], "OPEN");
    expect(status).toBe("blocked");
  });

  test("deriveRalphStatus treats ralph:status:done as done", () => {
    const status = deriveRalphStatus(["ralph:status:done", "ralph:status:queued"], "OPEN");
    expect(status).toBe("done");
  });

  test("deriveRalphStatus treats paused as paused", () => {
    const status = deriveRalphStatus(["ralph:status:queued", "ralph:status:paused"], "OPEN");
    expect(status).toBe("paused");
  });

  test("computeStaleInProgressRecovery does not recover missing session id before grace", () => {
    const nowMs = Date.parse("2026-01-11T00:01:00.000Z");
    const ttlMs = 10 * 60_000;
    const graceMs = 2 * 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "",
      },
      nowMs,
      ttlMs,
      graceMs,
    });

    expect(recovery.shouldRecover).toBe(false);
  });

  test("computeStaleInProgressRecovery recovers missing session id after grace", () => {
    const nowMs = Date.parse("2026-01-11T00:03:00.000Z");
    const ttlMs = 10 * 60_000;
    const graceMs = 2 * 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "",
      },
      nowMs,
      ttlMs,
      graceMs,
    });

    expect(recovery).toEqual({ shouldRecover: true, reason: "missing-session-id" });
  });

  test("computeStaleInProgressRecovery recovers stale heartbeat", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "opencode-session-123",
      },
      nowMs,
      ttlMs,
    });

    expect(recovery).toEqual({ shouldRecover: true, reason: "stale-heartbeat" });
  });

  test("computeStaleInProgressRecovery ignores fresh heartbeat", () => {
    const nowMs = Date.parse("2026-01-11T00:01:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:30.000Z",
        sessionId: "opencode-session-123",
      },
      nowMs,
      ttlMs,
    });

    expect(recovery.shouldRecover).toBe(false);
  });

  test("computeStaleInProgressRecovery keeps in-progress when authoritative activity is fresh", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "opencode-session-123",
      },
      nowMs,
      ttlMs,
      authoritativeActivityAtMs: Date.parse("2026-01-11T00:09:30.000Z"),
    });

    expect(recovery.shouldRecover).toBe(false);
  });

  test("computeStaleInProgressRecovery still recovers when authoritative activity is stale", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 63,
        taskPath: "github:3mdistal/ralph#63",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "opencode-session-123",
      },
      nowMs,
      ttlMs,
      authoritativeActivityAtMs: Date.parse("2026-01-11T00:01:00.000Z"),
    });

    expect(recovery).toEqual({ shouldRecover: true, reason: "stale-heartbeat" });
  });

  test("computeStaleInProgressRecovery ignores released tasks", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
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

    expect(recovery.shouldRecover).toBe(false);
  });

  test("computeStaleInProgressRecovery ignores blocked op-state", () => {
    const nowMs = Date.parse("2026-01-11T00:10:00.000Z");
    const ttlMs = 60_000;

    const recovery = computeStaleInProgressRecovery({
      labels: ["ralph:status:in-progress"],
      opState: {
        repo: "3mdistal/ralph",
        issueNumber: 65,
        taskPath: "github:3mdistal/ralph#65",
        status: "blocked",
        heartbeatAt: "2026-01-11T00:00:00.000Z",
        sessionId: "",
      },
      nowMs,
      ttlMs,
    });

    expect(recovery.shouldRecover).toBe(false);
  });

  test("deriveTaskView treats released tasks as queued", () => {
    const task = deriveTaskView({
      issue: {
        repo: "3mdistal/ralph",
        number: 290,
        title: "Released",
        labels: ["ralph:status:in-progress"],
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
    const labels = new Set(["bug", "p1-high", "ralph:status:in-progress"]);
    const calls: Array<{ method: string; path: string }> = [];
    const request = async <T>(path: string, opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      calls.push({ method, path });
      if (method === "POST" && /\/issues\/\d+\/labels$/.test(path)) {
        const body = opts.body as { labels?: string[] } | undefined;
        for (const label of body?.labels ?? []) {
          labels.add(label);
        }
        return { data: null, etag: null, status: 200 } as any;
      }
      if (method === "DELETE") {
        const match = path.match(/\/labels\/([^/]+)$/);
        const label = match ? decodeURIComponent(match[1]) : "";
        const removed = labels.delete(label);
        return { data: null, etag: null, status: removed ? 204 : 404 } as any;
      }
      if (method === "GET" && /\/issues\/\d+\/labels$/.test(path)) {
        return {
          data: Array.from(labels).map((name) => ({ name })),
          etag: null,
          status: 200,
        } as any;
      }
      return { data: null, etag: null, status: 200 } as any;
    };

    const ops = planIssueLabelOps({ add: ["ralph:status:escalated"], remove: ["ralph:status:in-progress"] });
    const result = await executeIssueLabelOps({
      github: { request },
      repo: "3mdistal/ralph",
      issueNumber: 286,
      ops,
    });

    expect(result.ok).toBe(true);
    expect(labels.has("bug")).toBe(true);
    expect(labels.has("p1-high")).toBe(true);
    expect(labels.has("ralph:status:escalated")).toBe(true);
    expect(labels.has("ralph:status:in-progress")).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["POST", "DELETE", "GET"]);
  });

  test("planIssueLabelOps refuses non-ralph labels", () => {
    expect(() => planIssueLabelOps({ add: ["bug"], remove: [] })).toThrow(
      "Refusing to mutate non-Ralph label"
    );
  });
});
