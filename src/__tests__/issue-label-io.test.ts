import { executeIssueLabelOps, planIssueLabelOps } from "../github/issue-label-io";

type RequestOptions = { method?: string; body?: unknown; allowNotFound?: boolean };

describe("issue label io", () => {
  test("executeIssueLabelOps preserves non-ralph labels", async () => {
    const labels = new Set(["bug", "p1-high", "ralph:in-progress"]);
    const calls: Array<{ method: string; path: string }> = [];
    const request = async (path: string, opts: RequestOptions = {}) => {
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
