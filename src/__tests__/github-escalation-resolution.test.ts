import { describe, expect, test } from "bun:test";

import { reconcileEscalationResolutions } from "../github/escalation-resolution";

describe("escalation resolution reconciliation", () => {
  test("requeues on queued label and RALPH RESOLVED comment", async () => {
    const requests: Array<{ path: string; method: string }> = [];

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        requests.push({ path, method: opts.method ?? "GET" });

        if (path === "/graphql") {
          const number = opts.body?.variables?.number;
          const nodes =
            number === 11
              ? [{ body: "RALPH RESOLVED: proceed", author: { login: "3mdistal" } }]
              : [];
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes },
                  },
                },
              },
            },
          };
        }

        return { data: {} };
      },
    } as any;

    const listIssuesWithAllLabels = ({ labels }: { labels: string[] }) => {
      if (labels.includes("ralph:queued")) {
        return [{ repo: "3mdistal/ralph", number: 10 }];
      }
      return [
        { repo: "3mdistal/ralph", number: 10 },
        { repo: "3mdistal/ralph", number: 11 },
      ];
    };

    const makeTask = (issue: string) => ({
      _path: `orchestration/tasks/${issue}.md`,
      _name: issue,
      type: "agent-task" as const,
      "creation-date": "2026-01-11",
      scope: "builder",
      issue,
      repo: "3mdistal/ralph",
      status: "escalated" as const,
      name: `Task ${issue}`,
    });

    const tasks = new Map([
      ["3mdistal/ralph#10", makeTask("3mdistal/ralph#10")],
      ["3mdistal/ralph#11", makeTask("3mdistal/ralph#11")],
    ]);

    const updated: string[] = [];
    const resolveAgentTaskByIssue = async (issue: string) => tasks.get(issue) ?? null;
    const updateTaskStatus = async (task: any, status: string) => {
      updated.push(`${task.issue}:${status}`);
      task.status = status;
      return true;
    };

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
      },
      log: () => {},
    });

    expect(updated.sort()).toEqual(["3mdistal/ralph#10:queued", "3mdistal/ralph#11:queued"]);

    const removed = requests.filter((req) => req.method === "DELETE").map((req) => req.path);
    expect(removed).toEqual(
      expect.arrayContaining([
        "/repos/3mdistal/ralph/issues/10/labels/ralph%3Aescalated",
        "/repos/3mdistal/ralph/issues/11/labels/ralph%3Aescalated",
      ])
    );

    const added = requests.filter((req) => req.method === "POST").map((req) => req.path);
    expect(added).toEqual(expect.arrayContaining(["/repos/3mdistal/ralph/issues/11/labels"]));
  });

  test("ignores RALPH RESOLVED from non-operator", async () => {
    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        if (path === "/graphql") {
          const nodes = [
            {
              body: "RALPH RESOLVED: attempt without operator",
              author: { login: "someone" },
            },
          ];
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes },
                  },
                },
              },
            },
          };
        }

        return { data: {} };
      },
    } as any;

    const listIssuesWithAllLabels = ({ labels }: { labels: string[] }) => {
      if (labels.includes("ralph:queued")) return [];
      return [{ repo: "3mdistal/ralph", number: 12 }];
    };

    const tasks = new Map([
      [
        "3mdistal/ralph#12",
        {
          _path: "orchestration/tasks/3mdistal-ralph-12.md",
          _name: "3mdistal/ralph#12",
          type: "agent-task" as const,
          "creation-date": "2026-01-11",
          scope: "builder",
          issue: "3mdistal/ralph#12",
          repo: "3mdistal/ralph",
          status: "escalated" as const,
          name: "Task 12",
        },
      ],
    ]);

    const updated: string[] = [];
    const resolveAgentTaskByIssue = async (issue: string) => tasks.get(issue) ?? null;
    const updateTaskStatus = async (task: any, status: string) => {
      updated.push(`${task.issue}:${status}`);
      task.status = status;
      return true;
    };

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
      },
      log: () => {},
    });

    expect(updated).toEqual([]);
  });
});
