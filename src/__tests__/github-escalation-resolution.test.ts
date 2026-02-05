import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { __shouldFetchEscalationCommentsForTests, reconcileEscalationResolutions } from "../github/escalation-resolution";
import {
  closeStateDbForTests,
  getEscalationCommentCheckState,
  getIssueSnapshotByNumber,
  initStateDb,
  listIssuesWithAllLabels,
  recordEscalationCommentCheckState,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

beforeEach(async () => {
  priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
  releaseLock = await acquireGlobalTestLock();
  homeDir = await mkdtemp(join(tmpdir(), "ralph-escalation-"));
  process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
  closeStateDbForTests();
  initStateDb();
});

afterEach(async () => {
  try {
    closeStateDbForTests();
    await rm(homeDir, { recursive: true, force: true });
  } finally {
    if (priorStateDbPath === undefined) {
      delete process.env.RALPH_STATE_DB_PATH;
    } else {
      process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
    }
    releaseLock?.();
    releaseLock = null;
  }
});

describe("escalation resolution reconciliation", () => {
  test("requeues on queued label and RALPH RESOLVED comment", async () => {
    const requests: Array<{ path: string; method: string }> = [];

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        requests.push({ path, method: opts.method ?? "GET" });

        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }

        if (path === "/graphql") {
          const number = opts.body?.variables?.number;
          const nodes =
            number === 11
              ? [
                  {
                    body: "RALPH RESOLVED: proceed",
                    databaseId: 101,
                    createdAt: "2026-01-11T00:00:00.000Z",
                    author: { login: "3mdistal" },
                    authorAssociation: "OWNER",
                  },
                ]
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
      if (labels.includes("ralph:status:queued")) {
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

    const checkStates = new Map<
      number,
      {
        lastCheckedAt: string | null;
        lastSeenUpdatedAt: string | null;
        lastResolvedCommentId: number | null;
        lastResolvedCommentAt: string | null;
      }
    >();
    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
        getIssueSnapshotByNumber: (_repo, issueNumber) => ({
          repo: "3mdistal/ralph",
          number: issueNumber,
          title: null,
          state: null,
          url: null,
          githubNodeId: null,
          githubUpdatedAt: "2026-01-11T00:00:00.000Z",
          labels: [],
        }),
        getEscalationCommentCheckState: (_repo, issueNumber) => checkStates.get(issueNumber) ?? null,
        recordEscalationCommentCheckState: ({ issueNumber, lastCheckedAt, lastSeenUpdatedAt, lastResolvedCommentId, lastResolvedCommentAt }) => {
          const prior = checkStates.get(issueNumber) ?? {
            lastCheckedAt: null,
            lastSeenUpdatedAt: null,
            lastResolvedCommentId: null,
            lastResolvedCommentAt: null,
          };
          checkStates.set(issueNumber, {
            lastCheckedAt,
            lastSeenUpdatedAt: lastSeenUpdatedAt ?? null,
            lastResolvedCommentId: lastResolvedCommentId ?? prior.lastResolvedCommentId,
            lastResolvedCommentAt: lastResolvedCommentAt ?? prior.lastResolvedCommentAt,
          });
        },
      },
      log: () => {},
    });

    expect(updated.sort()).toEqual(["3mdistal/ralph#10:queued", "3mdistal/ralph#11:queued"]);

    const removed = requests.filter((req) => req.method === "DELETE").map((req) => req.path);
    expect(removed).toEqual(
      expect.arrayContaining([
        "/repos/3mdistal/ralph/issues/10/labels/ralph%3Astatus%3Ablocked",
        "/repos/3mdistal/ralph/issues/11/labels/ralph%3Astatus%3Ablocked",
      ])
    );

    const added = requests.filter((req) => req.method === "POST").map((req) => req.path);
    expect(added).toEqual(expect.arrayContaining(["/repos/3mdistal/ralph/issues/11/labels"]));
  });

  test("translates RALPH APPROVE into RALPH RESOLVED using consultant proposed resolution", async () => {
    const requests: Array<{ path: string; method: string; body?: any }> = [];

    const consultantComment = [
      "<!-- ralph-escalation:id=deadbeef -->",
      "Ralph needs a decision.",
      "",
      "---",
      "",
      "<!-- ralph-consultant:v1 -->",
      "## Consultant Brief",
      "Keep going.",
      "",
      "## Consultant Decision (machine)",
      "```json",
      JSON.stringify(
        {
          schema_version: 1,
          decision: "needs-human",
          confidence: "high",
          requires_approval: true,
          proposed_resolution_text: "Proceed with GitHub-first implementation; ignore bwrb.",
          reason: "User confirmed GH+SQLite",
          followups: [],
        },
        null,
        2
      ),
      "```",
      "",
    ].join("\n");

    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        requests.push({ path, method: opts.method ?? "GET", body: opts.body });

        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }

        if (path === "/graphql") {
          const number = opts.body?.variables?.number;
          const nodes =
            number === 13
              ? [
                  {
                    body: consultantComment,
                    databaseId: 300,
                    createdAt: "2026-01-11T00:00:00.000Z",
                    author: { login: "teenylilralph" },
                    authorAssociation: "CONTRIBUTOR",
                  },
                  {
                    body: "RALPH APPROVE",
                    databaseId: 301,
                    createdAt: "2026-01-11T00:01:00.000Z",
                    author: { login: "3mdistal" },
                    authorAssociation: "OWNER",
                  },
                ]
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

        if (path === "/repos/3mdistal/ralph/issues/13/comments" && (opts.method ?? "GET") === "POST") {
          return {
            data: {
              id: 999,
              created_at: "2026-01-11T00:02:00.000Z",
              html_url: "https://github.com/3mdistal/ralph/issues/13#issuecomment-999",
            },
          };
        }

        return { data: {} };
      },
    } as any;

    const listIssuesWithAllLabels = ({ labels }: { labels: string[] }) => {
      if (labels.includes("ralph:status:queued")) return [];
      return [{ repo: "3mdistal/ralph", number: 13 }];
    };

    const task = {
      _path: "orchestration/tasks/3mdistal-ralph-13.md",
      _name: "3mdistal/ralph#13",
      type: "agent-task" as const,
      "creation-date": "2026-01-11",
      scope: "builder",
      issue: "3mdistal/ralph#13",
      repo: "3mdistal/ralph",
      status: "escalated" as const,
      name: "Task 13",
    };

    const updated: string[] = [];
    const resolveAgentTaskByIssue = async () => task as any;
    const updateTaskStatus = async (_task: any, status: string) => {
      updated.push(status);
      return true;
    };

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
        getIssueSnapshotByNumber: (_repo, issueNumber) => ({
          repo: "3mdistal/ralph",
          number: issueNumber,
          title: null,
          state: null,
          url: null,
          githubNodeId: null,
          githubUpdatedAt: "2026-01-11T00:00:00.000Z",
          labels: [],
        }),
        getEscalationCommentCheckState: () => null,
        recordEscalationCommentCheckState: () => {},
      },
      log: () => {},
    });

    expect(updated).toEqual(["queued"]);

    const postComment = requests.find(
      (req) => req.method === "POST" && req.path === "/repos/3mdistal/ralph/issues/13/comments"
    );
    expect(postComment?.body?.body).toContain("RALPH RESOLVED:");
    expect(postComment?.body?.body).toContain("Proceed with GitHub-first implementation; ignore bwrb.");
  });

  test("ignores RALPH RESOLVED from non-operator", async () => {
    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }
        if (path === "/graphql") {
          const nodes = [
            {
              body: "RALPH RESOLVED: attempt without operator",
              databaseId: 200,
              createdAt: "2026-01-11T00:00:00.000Z",
              author: { login: "someone" },
              authorAssociation: "CONTRIBUTOR",
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
      if (labels.includes("ralph:status:queued")) return [];
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

    const checkStates = new Map<
      number,
      {
        lastCheckedAt: string | null;
        lastSeenUpdatedAt: string | null;
        lastResolvedCommentId: number | null;
        lastResolvedCommentAt: string | null;
      }
    >();
    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
        getIssueSnapshotByNumber: (_repo, issueNumber) => ({
          repo: "3mdistal/ralph",
          number: issueNumber,
          title: null,
          state: null,
          url: null,
          githubNodeId: null,
          githubUpdatedAt: "2026-01-11T00:00:00.000Z",
          labels: [],
        }),
        getEscalationCommentCheckState: (_repo, issueNumber) => checkStates.get(issueNumber) ?? null,
        recordEscalationCommentCheckState: ({ issueNumber, lastCheckedAt, lastSeenUpdatedAt, lastResolvedCommentId, lastResolvedCommentAt }) => {
          const prior = checkStates.get(issueNumber) ?? {
            lastCheckedAt: null,
            lastSeenUpdatedAt: null,
            lastResolvedCommentId: null,
            lastResolvedCommentAt: null,
          };
          checkStates.set(issueNumber, {
            lastCheckedAt,
            lastSeenUpdatedAt: lastSeenUpdatedAt ?? null,
            lastResolvedCommentId: lastResolvedCommentId ?? prior.lastResolvedCommentId,
            lastResolvedCommentAt: lastResolvedCommentAt ?? prior.lastResolvedCommentAt,
          });
        },
      },
      log: () => {},
    });

    expect(updated).toEqual([]);
  });

  test("skips comment fetch when interval has not elapsed", async () => {
    const requests: string[] = [];
    const github = {
      request: async (path: string) => {
        requests.push(path);
        return { data: {} };
      },
    } as any;

    const listIssuesWithAllLabels = ({ labels }: { labels: string[] }) => {
      if (labels.includes("ralph:status:queued")) return [];
      return [{ repo: "3mdistal/ralph", number: 42 }];
    };

    const checkStates = new Map<
      number,
      {
        lastCheckedAt: string | null;
        lastSeenUpdatedAt: string | null;
        lastResolvedCommentId: number | null;
        lastResolvedCommentAt: string | null;
      }
    >();
    checkStates.set(42, {
      lastCheckedAt: "2026-01-11T00:00:00.000Z",
      lastSeenUpdatedAt: "2026-01-11T00:00:00.000Z",
      lastResolvedCommentId: null,
      lastResolvedCommentAt: null,
    });

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      minRecheckIntervalMs: 10 * 60_000,
      now: () => new Date("2026-01-11T00:01:00.000Z"),
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue: async () => null,
        updateTaskStatus: async () => true,
        getIssueSnapshotByNumber: (_repo, issueNumber) => ({
          repo: "3mdistal/ralph",
          number: issueNumber,
          title: null,
          state: null,
          url: null,
          githubNodeId: null,
          githubUpdatedAt: "2026-01-11T00:00:00.000Z",
          labels: [],
        }),
        getEscalationCommentCheckState: (_repo, issueNumber) => checkStates.get(issueNumber) ?? null,
        recordEscalationCommentCheckState: ({ issueNumber, lastCheckedAt, lastSeenUpdatedAt, lastResolvedCommentId, lastResolvedCommentAt }) => {
          const prior = checkStates.get(issueNumber) ?? {
            lastCheckedAt: null,
            lastSeenUpdatedAt: null,
            lastResolvedCommentId: null,
            lastResolvedCommentAt: null,
          };
          checkStates.set(issueNumber, {
            lastCheckedAt,
            lastSeenUpdatedAt: lastSeenUpdatedAt ?? null,
            lastResolvedCommentId: lastResolvedCommentId ?? prior.lastResolvedCommentId,
            lastResolvedCommentAt: lastResolvedCommentAt ?? prior.lastResolvedCommentAt,
          });
        },
      },
      log: () => {},
    });

    expect(requests).toEqual([]);
  });

  test("uses persisted check state to avoid immediate refetch", async () => {
    recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#77",
      title: "Escalation",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/77",
      githubUpdatedAt: "2026-01-11T00:00:00.000Z",
      at: "2026-01-11T00:00:00.000Z",
    });
    recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#77",
      labels: ["ralph:status:escalated"],
      at: "2026-01-11T00:00:00.000Z",
    });
    recordEscalationCommentCheckState({
      repo: "3mdistal/ralph",
      issueNumber: 77,
      lastCheckedAt: "2026-01-11T00:00:30.000Z",
      lastSeenUpdatedAt: "2026-01-11T00:00:00.000Z",
    });

    const requests: string[] = [];
    const github = {
      request: async (path: string) => {
        requests.push(path);
        return { data: { data: {} } };
      },
    } as any;

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      minRecheckIntervalMs: 10 * 60_000,
      now: () => new Date("2026-01-11T00:02:00.000Z"),
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue: async () => null,
        updateTaskStatus: async () => true,
        getIssueSnapshotByNumber,
        getEscalationCommentCheckState,
        recordEscalationCommentCheckState,
      },
      log: () => {},
    });

    expect(requests).toEqual([]);
  });

  test("does not re-resolve the same RALPH RESOLVED comment", async () => {
    const requests: Array<{ path: string; method: string }> = [];
    const github = {
      request: async (path: string, opts: { method?: string; body?: any } = {}) => {
        requests.push({ path, method: opts.method ?? "GET" });
        if (path.startsWith("/repos/3mdistal/ralph/labels")) {
          return { data: [] };
        }
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [
                        {
                          body: "RALPH RESOLVED: proceed",
                          databaseId: 555,
                          createdAt: "2026-01-11T00:00:00.000Z",
                          author: { login: "3mdistal" },
                          authorAssociation: "OWNER",
                        },
                      ],
                    },
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
      if (labels.includes("ralph:status:queued")) return [];
      return [{ repo: "3mdistal/ralph", number: 99 }];
    };

    const task = {
      _path: "orchestration/tasks/3mdistal-ralph-99.md",
      _name: "3mdistal/ralph#99",
      type: "agent-task" as const,
      "creation-date": "2026-01-11",
      scope: "builder",
      issue: "3mdistal/ralph#99",
      repo: "3mdistal/ralph",
      status: "escalated" as const,
      name: "Task 99",
    };

    const updated: string[] = [];
    const resolveAgentTaskByIssue = async () => task;
    const updateTaskStatus = async (_task: any, status: string) => {
      updated.push(status);
      return true;
    };

    const checkStates = new Map<
      number,
      {
        lastCheckedAt: string | null;
        lastSeenUpdatedAt: string | null;
        lastResolvedCommentId: number | null;
        lastResolvedCommentAt: string | null;
      }
    >();
    checkStates.set(99, {
      lastCheckedAt: "2026-01-11T00:00:00.000Z",
      lastSeenUpdatedAt: "2026-01-11T00:00:00.000Z",
      lastResolvedCommentId: 555,
      lastResolvedCommentAt: "2026-01-11T00:00:00.000Z",
    });

    await reconcileEscalationResolutions({
      repo: "3mdistal/ralph",
      deps: {
        github,
        listIssuesWithAllLabels,
        resolveAgentTaskByIssue,
        updateTaskStatus,
        getIssueSnapshotByNumber: (_repo, issueNumber) => ({
          repo: "3mdistal/ralph",
          number: issueNumber,
          title: null,
          state: null,
          url: null,
          githubNodeId: null,
          githubUpdatedAt: "2026-01-11T00:00:00.000Z",
          labels: [],
        }),
        getEscalationCommentCheckState: (_repo, issueNumber) => checkStates.get(issueNumber) ?? null,
        recordEscalationCommentCheckState: ({ issueNumber, lastCheckedAt, lastSeenUpdatedAt, lastResolvedCommentId, lastResolvedCommentAt }) => {
          const prior = checkStates.get(issueNumber) ?? {
            lastCheckedAt: null,
            lastSeenUpdatedAt: null,
            lastResolvedCommentId: null,
            lastResolvedCommentAt: null,
          };
          checkStates.set(issueNumber, {
            lastCheckedAt,
            lastSeenUpdatedAt: lastSeenUpdatedAt ?? null,
            lastResolvedCommentId: lastResolvedCommentId ?? prior.lastResolvedCommentId,
            lastResolvedCommentAt: lastResolvedCommentAt ?? prior.lastResolvedCommentAt,
          });
        },
      },
      log: () => {},
      // Force a fetch so we exercise the skip logic.
      minRecheckIntervalMs: 0,
    });

    expect(updated).toEqual([]);
    const labelMutations = requests
      .filter((req) => req.method === "DELETE" || req.method === "POST")
      .filter((req) => req.path.includes("/repos/3mdistal/ralph/issues/") && req.path.includes("/labels"));
    expect(labelMutations).toEqual([]);
  });

  test("allows fetch when issue updated", () => {
    const decision = __shouldFetchEscalationCommentsForTests({
      nowMs: Date.parse("2026-01-11T00:02:00.000Z"),
      lastCheckedAt: "2026-01-11T00:00:30.000Z",
      lastSeenUpdatedAt: "2026-01-11T00:00:00.000Z",
      githubUpdatedAt: "2026-01-11T00:01:00.000Z",
      minIntervalMs: 10 * 60_000,
    });

    expect(decision.shouldFetch).toBe(true);
    expect(decision.reason).toBe("updated");
  });
});
