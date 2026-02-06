import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { buildGatesJsonOutput } from "../commands/gates";
import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  getLatestRunGateStateForIssue,
  initStateDb,
  recordRalphRunGateArtifact,
  upsertRalphRunGateResult,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

describe("gates command output", () => {
  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    closeStateDbForTests();
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

  test("projects stable JSON output", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#240",
      taskPath: "github:3mdistal/ralph#240",
      attemptKind: "process",
      startedAt: "2026-01-20T13:00:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T13:00:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      url: "https://github.com/3mdistal/ralph/actions/runs/1200",
      prNumber: 240,
      prUrl: "https://github.com/3mdistal/ralph/pull/240",
      at: "2026-01-20T13:00:02.000Z",
    });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "failure_excerpt",
      content: "short log",
      at: "2026-01-20T13:00:03.000Z",
    });

    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 240 });
    const json = buildGatesJsonOutput({ repo: "3mdistal/ralph", issueNumber: 240, state });

    expect(json).toEqual({
      version: 1,
      repo: "3mdistal/ralph",
      issueNumber: 240,
      runId,
      gates: [
        {
          name: "ci",
          status: "fail",
          command: null,
          skipReason: null,
          url: "https://github.com/3mdistal/ralph/actions/runs/1200",
          prNumber: 240,
          prUrl: "https://github.com/3mdistal/ralph/pull/240",
        },
        {
          name: "devex_review",
          status: "pending",
          command: null,
          skipReason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "pr_evidence",
          status: "pending",
          command: null,
          skipReason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "preflight",
          status: "pending",
          command: null,
          skipReason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "product_review",
          status: "pending",
          command: null,
          skipReason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
      ],
      artifacts: [
        {
          gate: "ci",
          kind: "failure_excerpt",
          truncated: false,
          content: "short log",
        },
      ],
    });
  });
});
