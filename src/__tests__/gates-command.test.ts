import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import { buildGatesJsonOutput, runGatesCommand } from "../commands/gates";
import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  getDurableStateSchemaWindow,
  getLatestRunGateStateForIssue,
  initStateDb,
  recordRalphRunGateArtifact,
  upsertRalphRunGateResult,
} from "../state";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

type CapturedRun = {
  logs: string[];
  errors: string[];
  thrown: unknown;
};

async function runGates(args: string[]): Promise<CapturedRun> {
  const logs: string[] = [];
  const errors: string[] = [];
  const priorLog = console.log;
  const priorError = console.error;
  const priorExit = process.exit;
  let thrown: unknown = null;

  console.log = (...line: any[]) => {
    logs.push(line.join(" "));
  };
  console.error = (...line: any[]) => {
    errors.push(line.join(" "));
  };
  (process.exit as any) = (code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  };

  try {
    await runGatesCommand({ args });
  } catch (error) {
    thrown = error;
  } finally {
    console.log = priorLog;
    console.error = priorError;
    process.exit = priorExit;
  }

  return { logs, errors, thrown };
}

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
      version: 2,
      repo: "3mdistal/ralph",
      issueNumber: 240,
      runId,
      gates: [
        {
          name: "preflight",
          status: "pending",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:01.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "plan_review",
          status: "pending",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:01.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "product_review",
          status: "pending",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:01.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "devex_review",
          status: "pending",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:01.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
        {
          name: "ci",
          status: "fail",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:02.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: "https://github.com/3mdistal/ralph/actions/runs/1200",
          prNumber: 240,
          prUrl: "https://github.com/3mdistal/ralph/pull/240",
        },
        {
          name: "pr_evidence",
          status: "pending",
          createdAt: "2026-01-20T13:00:01.000Z",
          updatedAt: "2026-01-20T13:00:01.000Z",
          command: null,
          skipReason: null,
          reason: null,
          url: null,
          prNumber: null,
          prUrl: null,
        },
      ],
      artifacts: [
        {
          id: 1,
          gate: "ci",
          kind: "failure_excerpt",
          createdAt: "2026-01-20T13:00:03.000Z",
          updatedAt: "2026-01-20T13:00:03.000Z",
          truncated: false,
          truncationMode: "tail",
          artifactPolicyVersion: 1,
          originalChars: 9,
          originalLines: 1,
          content: "short log",
        },
      ],
      error: null,
    });
  });

  test("uses read-only path when durable state is forward-newer but readable", async () => {
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
      gate: "preflight",
      status: "pass",
      reason: "ok",
      at: "2026-01-20T13:00:02.000Z",
    });

    closeStateDbForTests();
    const stateDbPath = process.env.RALPH_STATE_DB_PATH as string;
    const db = new Database(stateDbPath);
    try {
      const window = getDurableStateSchemaWindow();
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("DELETE FROM meta WHERE key = 'schema_version'");
      db.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '${window.maxWritableSchema + 1}')`);
    } finally {
      db.close();
    }

    const { logs, thrown } = await runGates(["gates", "3mdistal/ralph", "240", "--json"]);
    expect(String((thrown as any)?.message ?? "")).toContain("exit:0");
    const parsed = JSON.parse(logs.find((line) => line.trim().startsWith("{")) ?? "{}") as Record<string, any>;
    expect(parsed.error).toBeNull();
    expect(parsed.runId).toBe(runId);
    expect(parsed.gates[0]?.name).toBe("preflight");
    expect(parsed.gates[0]?.status).toBe("pass");
  });

  test("emits stable JSON error payload for forward-incompatible durable state", async () => {
    const stateDbPath = process.env.RALPH_STATE_DB_PATH as string;
    const db = new Database(stateDbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("DELETE FROM meta WHERE key = 'schema_version'");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
    } finally {
      db.close();
    }

    const { logs, thrown } = await runGates(["gates", "3mdistal/ralph", "240", "--json"]);
    expect(String((thrown as any)?.message ?? "")).toContain("exit:2");
    const parsed = JSON.parse(logs.find((line) => line.trim().startsWith("{")) ?? "{}") as Record<string, any>;
    expect(parsed.version).toBe(2);
    expect(parsed.repo).toBe("3mdistal/ralph");
    expect(parsed.issueNumber).toBe(240);
    expect(parsed.runId).toBeNull();
    expect(parsed.gates).toEqual([]);
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.error?.code).toBe("forward_incompatible");
    expect(typeof parsed.error?.message).toBe("string");
  });

  test("text output keeps artifact excerpts bounded", async () => {
    initStateDb();
    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#240",
      taskPath: "github:3mdistal/ralph#240",
      attemptKind: "process",
      startedAt: "2026-01-20T13:00:00.000Z",
    });
    ensureRalphRunGateRows({ runId, at: "2026-01-20T13:00:01.000Z" });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "failure_excerpt",
      content: "line-1\nline-2\nline-3\nline-4",
      at: "2026-01-20T13:00:03.000Z",
    });

    const { logs, thrown } = await runGates(["gates", "3mdistal/ralph", "240"]);
    expect(String((thrown as any)?.message ?? "")).toContain("exit:0");
    expect(logs.some((line) => line.includes("Artifacts:"))).toBeTrue();
    expect(logs.some((line) => line.includes("... (1 more lines)"))).toBeTrue();
  });
});
