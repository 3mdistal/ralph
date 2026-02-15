import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { mutateIssueLabels } from "../github/label-mutation";
import { clearIssueWriteCoalescerForTests } from "../github/write-coalescer";

describe("label mutation coalescing", () => {
  let priorWindow: string | undefined;

  beforeEach(() => {
    priorWindow = process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = "10";
    clearIssueWriteCoalescerForTests();
  });

  afterEach(() => {
    if (priorWindow === undefined) delete process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS;
    else process.env.RALPH_GITHUB_WRITE_COALESCE_WINDOW_MS = priorWindow;
    clearIssueWriteCoalescerForTests();
  });

  test("coalesces duplicate concurrent mutations on same issue", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        const method = (opts.method ?? "GET").toUpperCase();
        calls.push({ path, method });
        if (path === "/graphql" && method === "POST" && String(opts.body?.query ?? "").includes("repository(owner:")) {
          return {
            data: {
              data: {
                repository: {
                  labels: {
                    nodes: [{ name: "ralph:meta:blocked", id: "LBL_1" }],
                  },
                },
              },
            },
          };
        }
        if (path === "/graphql" && method === "POST") {
          return { data: { data: { addLabelsToLabelable: { clientMutationId: null } } } };
        }
        throw new Error(`Unexpected request ${method} ${path}`);
      },
    } as any;

    const [a, b] = await Promise.all([
      mutateIssueLabels({
        github,
        repo: "3mdistal/ralph",
        issueNumber: 762,
        issueNodeId: "ISSUE_NODE_1",
        plan: { add: ["ralph:meta:blocked"], remove: [] },
      }),
      mutateIssueLabels({
        github,
        repo: "3mdistal/ralph",
        issueNumber: 762,
        issueNodeId: "ISSUE_NODE_1",
        plan: { add: ["ralph:meta:blocked"], remove: [] },
      }),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const mutations = calls.filter((call) => call.path === "/graphql" && call.method === "POST");
    expect(mutations.length).toBe(2);
  });
});
