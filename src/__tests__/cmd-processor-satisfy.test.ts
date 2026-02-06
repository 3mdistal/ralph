import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { RALPH_LABEL_CMD_SATISFY } from "../github-labels";
import { processOneCommand } from "../github/cmd-processor";
import {
  closeStateDbForTests,
  getIdempotencyPayload,
  getIssueLabels,
  initStateDb,
  recordIssueLabelsSnapshot,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

const ISSUE_NUMBER = 123;
const REPO = "3mdistal/ralph";

describe("cmd processor satisfy", () => {
  let homeDir = "";
  let priorHome: string | undefined;
  let priorStateDb: string | undefined;
  let priorToken: string | undefined;
  let priorFetch: typeof globalThis.fetch | undefined;
  let releaseLock: (() => void) | null = null;

  beforeEach(async () => {
    priorHome = process.env.HOME;
    priorStateDb = process.env.RALPH_STATE_DB_PATH;
    priorToken = process.env.GITHUB_TOKEN;
    priorFetch = globalThis.fetch;

    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-cmd-satisfy-"));
    process.env.HOME = homeDir;
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    process.env.GITHUB_TOKEN = "test-token";

    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.includes(`/issues/${ISSUE_NUMBER}/events`)) {
        return new Response(
          JSON.stringify([
            {
              id: 1,
              event: "labeled",
              label: { name: RALPH_LABEL_CMD_SATISFY },
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes(`/issues/${ISSUE_NUMBER}/comments`) && method === "GET") {
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes(`/issues/${ISSUE_NUMBER}/comments`) && method === "POST") {
        return new Response("{}", { status: 201, headers: { "Content-Type": "application/json" } });
      }

      if (url.includes(`/issues/${ISSUE_NUMBER}/labels/ralph%3Acmd%3Asatisfy`) && method === "DELETE") {
        return new Response("", { status: 200 });
      }

      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });

    globalThis.fetch = fetchMock as unknown as typeof fetch;

    closeStateDbForTests();
    initStateDb();

    recordIssueLabelsSnapshot({
      repo: REPO,
      issue: `${REPO}#${ISSUE_NUMBER}`,
      labels: [RALPH_LABEL_CMD_SATISFY, "ralph:status:queued"],
      at: new Date("2026-02-05T12:00:00.000Z").toISOString(),
    });
  });

  afterEach(async () => {
    closeStateDbForTests();

    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;

    if (priorStateDb === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDb;

    if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorToken;

    if (priorFetch) globalThis.fetch = priorFetch;

    if (homeDir) {
      await rm(homeDir, { recursive: true, force: true });
    }

    releaseLock?.();
    releaseLock = null;
  });

  test("records dependency satisfaction without changing status labels", async () => {
    const result = await processOneCommand({
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      cmdLabel: RALPH_LABEL_CMD_SATISFY,
      currentLabels: [RALPH_LABEL_CMD_SATISFY, "ralph:status:queued"],
      issueState: "OPEN",
    });

    expect(result.processed).toBe(true);
    expect(result.removedCmdLabel).toBe(true);

    expect(getIssueLabels(REPO, ISSUE_NUMBER)).toEqual(["ralph:status:queued"]);

    const satisfactionPayload = getIdempotencyPayload(`ralph:satisfy:v1:${REPO}#${ISSUE_NUMBER}`);
    expect(satisfactionPayload).toBeTruthy();
    expect(JSON.parse(satisfactionPayload ?? "{}")).toMatchObject({
      version: 1,
      via: "ralph:cmd:satisfy",
    });
  });
});
