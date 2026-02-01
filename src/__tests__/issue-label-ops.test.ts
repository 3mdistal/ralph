import { describe, expect, mock, test } from "bun:test";

import { GitHubApiError } from "../github/client";
import { applyIssueLabelOps } from "../github/issue-label-io";

describe("applyIssueLabelOps", () => {
  test("retries once after missing label error", async () => {
    let addCalls = 0;
    const ensureLabels = mock(async () => ({
      ok: true as const,
      created: [] as string[],
      updated: [] as string[],
    }));
    const io = {
      addLabel: async () => {
        addCalls += 1;
        if (addCalls === 1) {
          throw new GitHubApiError({
            message: "Unprocessable",
            code: "unknown",
            status: 422,
            requestId: "req-1",
            responseText: "Validation failed: Label does not exist",
          });
        }
      },
      removeLabel: async () => ({ removed: true }),
    };

    const result = await applyIssueLabelOps({
      ops: [{ action: "add", label: "ralph:status:queued" }],
      io,
      ensureLabels,
      retryMissingLabelOnce: true,
    });

    expect(result.ok).toBe(true);
    expect(result.didRetry).toBe(true);
    expect(addCalls).toBe(2);
    expect(ensureLabels).toHaveBeenCalledTimes(1);
  });

  test("skips retry when ensure fails auth", async () => {
    const ensureLabels = mock(async () => ({
      ok: false as const,
      kind: "auth" as const,
      error: new Error("nope"),
    }));
    const io = {
      addLabel: async () => {
        throw new GitHubApiError({
          message: "Unprocessable",
          code: "unknown",
          status: 422,
          requestId: "req-2",
          responseText: "Label does not exist",
        });
      },
      removeLabel: async () => ({ removed: true }),
    };

    const result = await applyIssueLabelOps({
      ops: [{ action: "add", label: "ralph:status:queued" }],
      io,
      ensureLabels,
      retryMissingLabelOnce: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("auth");
    }
    expect(ensureLabels).toHaveBeenCalledTimes(1);
  });

  test("rolls back applied labels on failure", async () => {
    const calls: string[] = [];
    let removeCalls = 0;
    const io = {
      addLabel: async (label: string) => {
        calls.push(`add:${label}`);
      },
      removeLabel: async (label: string) => {
        calls.push(`remove:${label}`);
        removeCalls += 1;
        if (removeCalls === 1) {
          throw new Error("boom");
        }
        return { removed: true };
      },
    };

    const result = await applyIssueLabelOps({
      ops: [
        { action: "add", label: "ralph:status:queued" },
        { action: "remove", label: "ralph:status:in-progress" },
      ],
      io,
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      "add:ralph:status:queued",
      "remove:ralph:status:in-progress",
      "remove:ralph:status:queued",
    ]);
  });

  test("skips rollback on transient failures", async () => {
    const calls: string[] = [];
    const io = {
      addLabel: async (label: string) => {
        calls.push(`add:${label}`);
      },
      removeLabel: async (label: string) => {
        calls.push(`remove:${label}`);
        throw new GitHubApiError({
          message: "Rate limit",
          code: "rate_limit",
          status: 429,
          requestId: "req-3",
          responseText: "secondary rate limit",
        });
      },
    };

    const result = await applyIssueLabelOps({
      ops: [
        { action: "add", label: "ralph:status:queued" },
        { action: "remove", label: "ralph:status:in-progress" },
      ],
      io,
      repo: "3mdistal/ralph",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("transient");
    }
    expect(calls).toEqual(["add:ralph:status:queued", "remove:ralph:status:in-progress"]);
  });
});
