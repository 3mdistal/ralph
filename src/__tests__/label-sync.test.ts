import { describe, expect, mock, test } from "bun:test";

import { GitHubApiError } from "../github/client";
import { ensureRalphWorkflowLabelsOnce, createRalphWorkflowLabelsEnsurer } from "../github/ensure-ralph-workflow-labels";
import { RALPH_WORKFLOW_LABELS } from "../github-labels";
import { RALPH_PRIORITY_LABELS } from "../queue/priority";

describe("ensureRalphWorkflowLabelsOnce", () => {
  test("includes priority labels in the workflow set", () => {
    const labelNames = new Set(RALPH_WORKFLOW_LABELS.map((label) => label.name));
    for (const label of RALPH_PRIORITY_LABELS) {
      expect(labelNames.has(label)).toBe(true);
    }
  });

  test("no-ops when labels already match", async () => {
    const listLabelSpecs = mock(async () => RALPH_WORKFLOW_LABELS);
    const createLabel = mock(async () => {});
    const updateLabel = mock(async () => {});

    const outcome = await ensureRalphWorkflowLabelsOnce({
      repo: "3mdistal/ralph",
      github: { listLabelSpecs, createLabel, updateLabel } as any,
    });

    expect(outcome).toEqual({ ok: true, created: [], updated: [] });
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
  });

  test("creates missing labels", async () => {
    const listLabelSpecs = mock(async () => []);
    const createLabel = mock(async () => {});
    const updateLabel = mock(async () => {});

    const outcome = await ensureRalphWorkflowLabelsOnce({
      repo: "3mdistal/ralph",
      github: { listLabelSpecs, createLabel, updateLabel } as any,
    });

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.created).toEqual(RALPH_WORKFLOW_LABELS.map((label) => label.name));
      expect(outcome.updated).toEqual([]);
    }
    expect(createLabel).toHaveBeenCalledTimes(RALPH_WORKFLOW_LABELS.length);
  });

  test("returns auth outcome on permission error", async () => {
    const listLabelSpecs = mock(async () => {
      throw new GitHubApiError({
        message: "Forbidden",
        code: "auth",
        status: 403,
        requestId: null,
        responseText: "forbidden",
      });
    });

    const outcome = await ensureRalphWorkflowLabelsOnce({
      repo: "3mdistal/ralph",
      github: { listLabelSpecs, createLabel: mock(async () => {}), updateLabel: mock(async () => {}) } as any,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("auth");
    }
  });

  test("treats secondary rate limit as transient", async () => {
    const listLabelSpecs = mock(async () => {
      throw new GitHubApiError({
        message: "Rate limited",
        code: "auth",
        status: 403,
        requestId: "req-123",
        responseText: "You have exceeded a secondary rate limit",
      });
    });

    const outcome = await ensureRalphWorkflowLabelsOnce({
      repo: "3mdistal/ralph",
      github: { listLabelSpecs, createLabel: mock(async () => {}), updateLabel: mock(async () => {}) } as any,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transient");
    }
  });

  test("treats rate limit status as transient", async () => {
    const listLabelSpecs = mock(async () => {
      throw new GitHubApiError({
        message: "Rate limit",
        code: "rate_limit",
        status: 429,
        requestId: "req-429",
        responseText: "API rate limit exceeded",
      });
    });

    const outcome = await ensureRalphWorkflowLabelsOnce({
      repo: "3mdistal/ralph",
      github: { listLabelSpecs, createLabel: mock(async () => {}), updateLabel: mock(async () => {}) } as any,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.kind).toBe("transient");
    }
  });
});

describe("createRalphWorkflowLabelsEnsurer", () => {
  test("caches auth failures per repo", async () => {
    const listLabelSpecs = mock(async () => {
      throw new GitHubApiError({
        message: "Forbidden",
        code: "auth",
        status: 403,
        requestId: null,
        responseText: "forbidden",
      });
    });

    const github = { listLabelSpecs, createLabel: mock(async () => {}), updateLabel: mock(async () => {}) } as any;
    const ensurer = createRalphWorkflowLabelsEnsurer({ githubFactory: () => github });

    await ensurer.ensure("3mdistal/ralph");
    await ensurer.ensure("3mdistal/ralph");

    expect(listLabelSpecs).toHaveBeenCalledTimes(1);
  });

  test("throttles transient failures", async () => {
    let calls = 0;
    const listLabelSpecs = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return RALPH_WORKFLOW_LABELS;
    });

    const github = { listLabelSpecs, createLabel: mock(async () => {}), updateLabel: mock(async () => {}) } as any;
    const ensurer = createRalphWorkflowLabelsEnsurer({ githubFactory: () => github });

    await ensurer.ensure("3mdistal/ralph");
    await ensurer.ensure("3mdistal/ralph");

    expect(listLabelSpecs).toHaveBeenCalledTimes(1);
  });
});
