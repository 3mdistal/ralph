import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { closeStateDbForTests, initStateDb } from "../state";
import { getRalphStateDbPath } from "../paths";
import { syncRepoIssuesOnce } from "../github-issues-sync";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorHome: string | undefined;
let releaseLock: (() => void) | null = null;

const repo = "3mdistal/ralph";

function buildIssue(params: {
  number: number;
  updatedAt: string;
  labels?: string[];
  nodeId?: string;
  isPr?: boolean;
}) {
  return {
    number: params.number,
    title: `Issue ${params.number}`,
    state: "open",
    html_url: `https://github.com/${repo}/issues/${params.number}`,
    updated_at: params.updatedAt,
    node_id: params.nodeId ?? `NODE_${params.number}`,
    labels: (params.labels ?? []).map((name) => ({ name })),
    pull_request: params.isPr ? {} : undefined,
  };
}

describe("github issue sync", () => {
  beforeEach(async () => {
    priorHome = process.env.HOME;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.HOME = homeDir;
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(async () => {
    try {
      closeStateDbForTests();
      await rm(homeDir, { recursive: true, force: true });
    } finally {
      process.env.HOME = priorHome;
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("syncs non-PR issues and labels, advances cursor", async () => {
    const calls: string[] = [];
    const fetchMock: typeof fetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify([
          buildIssue({ number: 1, updatedAt: "2026-01-11T00:00:01.000Z", labels: ["ralph:queued"] }),
          buildIssue({ number: 2, updatedAt: "2026-01-11T00:00:02.000Z", labels: ["dx", "chore"] }),
          buildIssue({ number: 3, updatedAt: "2026-01-11T00:00:03.000Z", isPr: true }),
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const result = await syncRepoIssuesOnce({
      repo,
      lastSyncAt: "2026-01-11T00:00:00.000Z",
      deps: {
        fetch: fetchMock,
        getToken: async () => "token",
        now: () => new Date("2026-01-11T00:00:10.000Z"),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stored).toBe(1);
    expect(result.ralphCount).toBe(1);
    expect(result.newLastSyncAt).toBe("2026-01-11T00:00:03.000Z");
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("since=2026-01-10T23%3A59%3A55.000Z");

    const db = new Database(getRalphStateDbPath());
    try {
      const issueCount = db.query("SELECT COUNT(*) as n FROM issues").get() as { n: number };
      expect(issueCount.n).toBe(1);

      const labels = db
        .query(
          `SELECT i.number as issue_number, l.name as name
           FROM issues i
           JOIN issue_labels l ON l.issue_id = i.id
           ORDER BY i.number, l.name`
        )
        .all() as Array<{ issue_number: number; name: string }>;

      expect(labels).toEqual([{ issue_number: 1, name: "ralph:queued" }]);
    } finally {
      db.close();
    }
  });

  test("clears labels when removed", async () => {
    const responses = [
      [buildIssue({ number: 1, updatedAt: "2026-01-11T00:00:01.000Z", labels: ["ralph:queued"] })],
      [buildIssue({ number: 1, updatedAt: "2026-01-11T00:00:02.000Z", labels: [] })],
    ];
    let idx = 0;
    const fetchMock: typeof fetch = async () => {
      const body = responses[Math.min(idx, responses.length - 1)];
      idx += 1;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    await syncRepoIssuesOnce({
      repo,
      lastSyncAt: null,
      deps: { fetch: fetchMock, getToken: async () => "token" },
    });

    await syncRepoIssuesOnce({
      repo,
      lastSyncAt: "2026-01-11T00:00:01.000Z",
      deps: { fetch: fetchMock, getToken: async () => "token" },
    });

    const db = new Database(getRalphStateDbPath());
    try {
      const labelCount = db.query("SELECT COUNT(*) as n FROM issue_labels").get() as { n: number };
      expect(labelCount.n).toBe(0);
    } finally {
      db.close();
    }
  });

  test("does not advance cursor on error", async () => {
    const fetchMock: typeof fetch = async () => new Response("nope", { status: 500 });

    const result = await syncRepoIssuesOnce({
      repo,
      lastSyncAt: "2026-01-11T00:00:00.000Z",
      deps: { fetch: fetchMock, getToken: async () => "token" },
    });

    expect(result.ok).toBe(false);
    expect(result.newLastSyncAt).toBe(null);

    const db = new Database(getRalphStateDbPath());
    try {
      const issueCount = db.query("SELECT COUNT(*) as n FROM issues").get() as { n: number };
      expect(issueCount.n).toBe(0);
    } finally {
      db.close();
    }
  });
});
