import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { closeStateDbForTests, getRepoLabelWriteState, initStateDb } from "../state";
import { recordLabelWriteFailure, canAttemptLabelWrite, recordLabelWriteSuccess } from "../github/label-write-backoff";
import { GitHubApiError } from "../github/client";

describe("label write backoff", () => {
  let priorStateDbPath: string | undefined;

  beforeEach(() => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    const homeDir = mkdtempSync(join(tmpdir(), "ralph-label-backoff-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
    initStateDb();
  });

  afterEach(() => {
    closeStateDbForTests();
    if (priorStateDbPath === undefined) delete process.env.RALPH_STATE_DB_PATH;
    else process.env.RALPH_STATE_DB_PATH = priorStateDbPath;
  });

  test("records backoff and blocks until resume", () => {
    const repo = "3mdistal/ralph";
    const nowMs = Date.parse("2026-01-11T00:00:00.000Z");
    const error = new GitHubApiError({
      message: "Rate limit",
      code: "rate_limit",
      status: 429,
      requestId: "req-1",
      responseText: "secondary rate limit",
    });

    const blockedUntil = recordLabelWriteFailure(repo, error, nowMs);
    expect(typeof blockedUntil).toBe("number");
    expect(canAttemptLabelWrite(repo, nowMs)).toBe(false);

    const state = getRepoLabelWriteState(repo);
    expect(state.blockedUntilMs).toBe(blockedUntil);
    expect(state.lastError).toContain("Rate limit");

    recordLabelWriteSuccess(repo, nowMs + 60_000);
    expect(canAttemptLabelWrite(repo, nowMs + 60_000)).toBe(true);
  });
});
