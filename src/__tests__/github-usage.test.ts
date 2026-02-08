import { describe, expect, test } from "bun:test";

import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { collectGithubUsageSummary } from "../commands/github-usage";

function line(obj: any): string {
  return `${JSON.stringify(obj)}\n`;
}

describe("github-usage miner", () => {
  test("aggregates endpoints, writes, errors, and backoff", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    const logPath = join(dir, "2026-02-03.jsonl");

    const base = {
      repo: "3mdistal/ralph",
      type: "github.request",
      level: "info",
    };

    const sinceMs = Date.parse("2026-02-03T00:00:00.000Z");
    const untilMs = Date.parse("2026-02-03T23:59:59.999Z");

    const contents =
      line({
        ...base,
        ts: "2026-02-03T12:00:00.000Z",
        data: {
          method: "GET",
          path: "/repos/3mdistal/ralph/issues/207",
          status: 200,
          ok: true,
          write: false,
          durationMs: 12,
          attempt: 1,
          requestId: "REQ_OK",
          rateLimited: false,
          secondaryRateLimited: false,
          backoffWaitMs: 0,
          backoffSetUntilTs: null,
        },
      }) +
      line({
        ...base,
        ts: "2026-02-03T12:01:00.000Z",
        data: {
          method: "GET",
          path: "/repos/3mdistal/ralph/issues/207",
          status: 403,
          ok: false,
          write: false,
          durationMs: 89,
          attempt: 1,
          requestId: "REQ_RL",
          rateLimited: true,
          secondaryRateLimited: false,
          errorCode: "rate_limit",
          backoffWaitMs: 0,
          backoffSetUntilTs: Date.parse("2026-02-03T12:30:00.000Z"),
        },
      }) +
      line({
        ...base,
        ts: "2026-02-03T12:02:00.000Z",
        data: {
          method: "POST",
          path: "/repos/3mdistal/ralph/issues/207/labels",
          status: 200,
          ok: true,
          write: true,
          durationMs: 40,
          attempt: 1,
          requestId: "REQ_WRITE",
          rateLimited: false,
          secondaryRateLimited: false,
          backoffWaitMs: 2500,
          backoffSetUntilTs: null,
        },
      }) +
      line({
        repo: "3mdistal/ralph",
        type: "github.request",
        level: "warn",
        ts: "2026-02-03T12:03:00.000Z",
        data: {
          method: "GET",
          path: "/repos/3mdistal/ralph/issues/428",
          status: 500,
          ok: false,
          write: false,
          durationMs: 5,
          attempt: 1,
          requestId: "REQ_500",
          rateLimited: false,
          secondaryRateLimited: false,
          errorCode: "server_error",
          backoffWaitMs: 0,
          backoffSetUntilTs: null,
        },
      });

    await writeFile(logPath, contents, "utf8");

    const summary = await collectGithubUsageSummary({
      eventsDir: dir,
      sinceMs,
      untilMs,
      limit: 10,
      nowMs: Date.parse("2026-02-03T13:00:00.000Z"),
    });

    expect(summary.totals.requests).toBe(4);
    expect(summary.totals.ok).toBe(2);
    expect(summary.totals.errors).toBe(2);
    expect(summary.totals.writes).toBe(1);
    expect(summary.totals.rateLimited).toBe(1);
    expect(summary.totals.secondaryRateLimited).toBe(0);
    expect(summary.totals.statusCounts["200"]).toBe(2);
    expect(summary.totals.statusCounts["403"]).toBe(1);
    expect(summary.totals.statusCounts["500"]).toBe(1);
    expect(summary.totals.errorCodeCounts["rate_limit"]).toBe(1);

    expect(summary.backoff.windowCount).toBe(1);
    expect(summary.backoff.waitEventCount).toBe(1);
    expect(summary.backoff.maxWaitMs).toBe(2500);

    const top = summary.topEndpoints[0];
    expect(top.repo).toBe("3mdistal/ralph");
    expect(top.method).toBe("GET");
    expect(top.path).toBe("/repos/3mdistal/ralph/issues/207");
    expect(top.count).toBe(2);
    expect(top.errorCount).toBe(1);
    expect(top.rateLimitedCount).toBe(1);
    expect(top.requestIdSamples).toContain("REQ_RL");

    const topWrite = summary.topWriteEndpoints[0];
    expect(topWrite.method).toBe("POST");
    expect(topWrite.writeCount).toBe(1);

    const repos = summary.repos.map((r) => r.repo);
    expect(repos).toContain("3mdistal/ralph");
    expect(repos).toContain("3mdistal/ralph");
  });

  test("is resilient to missing day files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ralph-events-"));
    await writeFile(
      join(dir, "2026-02-03.jsonl"),
      line({
        repo: "3mdistal/ralph",
        type: "github.request",
        level: "info",
        ts: "2026-02-03T00:00:01.000Z",
        data: { method: "GET", path: "/rate_limit", status: 200, ok: true, write: false, durationMs: 1 },
      }),
      "utf8"
    );

    const summary = await collectGithubUsageSummary({
      eventsDir: dir,
      sinceMs: Date.parse("2026-02-02T00:00:00.000Z"),
      untilMs: Date.parse("2026-02-03T23:59:59.999Z"),
      limit: 5,
      nowMs: Date.parse("2026-02-03T13:00:00.000Z"),
    });

    expect(summary.files.length).toBe(2);
    expect(summary.files.some((f) => f.day === "2026-02-02" && f.missing)).toBe(true);
    expect(summary.totals.requests).toBe(1);
  });
});
