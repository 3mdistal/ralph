import { describe, test, expect } from "bun:test";
import { planAlertWriteback, extractExistingAlertMarker, writeAlertToGitHub } from "../github/alert-writeback";

describe("github alert writeback", () => {
  test("extractExistingAlertMarker parses marker id", () => {
    expect(extractExistingAlertMarker("<!-- ralph-alert:id=deadbeef -->")).toBe("deadbeef");
  });

  test("writeAlertToGitHub posts once and records idempotency", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];
    const deliveries: any[] = [];

    const plan = planAlertWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 42,
      taskName: "Alert task",
      kind: "error",
      fingerprint: "abc",
      alertId: 1,
      summary: "Error: boom",
      details: "boom",
      count: 1,
      lastSeenAt: "2026-01-11T00:00:00.000Z",
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: { nodes: [], pageInfo: { hasPreviousPage: false } },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: { html_url: "https://github.com/3mdistal/ralph/issues/42#issuecomment-1" } };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeAlertToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 42,
        taskName: "Alert task",
        kind: "error",
        fingerprint: "abc",
        alertId: 1,
        summary: "Error: boom",
        details: "boom",
        count: 1,
        lastSeenAt: "2026-01-11T00:00:00.000Z",
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
        recordAlertDeliveryAttempt: (input: any) => {
          deliveries.push(input);
        },
        getAlertDelivery: () => null,
      }
    );

    expect(result.postedComment).toBe(true);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
    expect(postedBodies.length).toBe(1);
    expect(postedBodies[0]).toContain(plan.marker);
    expect(deliveries.some((entry) => entry.status === "success")).toBe(true);
  });

  test("writeAlertToGitHub skips when marker already present", async () => {
    const keys = new Set<string>();
    const postedBodies: string[] = [];
    const deliveries: any[] = [];

    const plan = planAlertWriteback({
      repo: "3mdistal/ralph",
      issueNumber: 42,
      taskName: "Alert task",
      kind: "error",
      fingerprint: "abc",
      alertId: 1,
      summary: "Error: boom",
      details: "boom",
      count: 1,
    });

    const github = {
      request: async (path: string, opts: { method?: string; body?: { body?: string } } = {}) => {
        if (path === "/graphql") {
          return {
            data: {
              data: {
                repository: {
                  issue: {
                    comments: {
                      nodes: [{ body: `prior\n${plan.marker}` }],
                      pageInfo: { hasPreviousPage: false },
                    },
                  },
                },
              },
            },
          };
        }
        if (path.includes("/comments") && opts.method === "POST") {
          postedBodies.push(opts.body?.body ?? "");
          return { data: {} };
        }
        return { data: {} };
      },
    } as any;

    const result = await writeAlertToGitHub(
      {
        repo: "3mdistal/ralph",
        issueNumber: 42,
        taskName: "Alert task",
        kind: "error",
        fingerprint: "abc",
        alertId: 1,
        summary: "Error: boom",
        details: "boom",
        count: 1,
      },
      {
        github,
        hasIdempotencyKey: (key) => keys.has(key),
        recordIdempotencyKey: (input) => {
          keys.add(input.key);
          return true;
        },
        deleteIdempotencyKey: (key) => {
          keys.delete(key);
        },
        recordAlertDeliveryAttempt: (input: any) => {
          deliveries.push(input);
        },
        getAlertDelivery: () => null,
      }
    );

    expect(result.postedComment).toBe(false);
    expect(result.markerFound).toBe(true);
    expect(postedBodies.length).toBe(0);
    expect(keys.has(plan.idempotencyKey)).toBe(true);
    expect(deliveries.some((entry) => entry.status === "skipped")).toBe(true);
  });
});
