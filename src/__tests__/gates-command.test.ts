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

    expect(json).toMatchObject({
      version: 2,
      repo: "3mdistal/ralph",
      issueNumber: 240,
      runId,
      error: null,
    });
    expect(json.gates).toHaveLength(6);
    expect(json.gates[0]?.name).toBe("preflight");
    expect(json.gates[0]?.status).toBe("pending");
    const ciGate = json.gates.find((gate) => gate.name === "ci");
    expect(ciGate).toMatchObject({
      status: "fail",
      url: "https://github.com/3mdistal/ralph/actions/runs/1200",
      prNumber: 240,
      prUrl: "https://github.com/3mdistal/ralph/pull/240",
      classifierVersion: null,
      classifierPayload: null,
      classifierSource: null,
      classifierSummary: null,
      classifierUnsupportedVersion: null,
    });
    expect(json.artifacts).toEqual([
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
    ]);
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

  test("projects persisted CI classifier payload in JSON output", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#241",
      taskPath: "github:3mdistal/ralph#241",
      attemptKind: "process",
      startedAt: "2026-01-20T13:10:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T13:10:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      ciClassifierVersion: 1,
      ciClassifierPayloadJson: JSON.stringify({
        kind: "ci-triage-classifier",
        version: 1,
        signatureVersion: 2,
        signature: "sig-241",
        classification: "regression",
        classificationReason: "regression_checks",
        action: "resume",
        actionReason: "resume_has_session",
        timedOut: false,
        attempt: 1,
        maxAttempts: 5,
        priorSignature: null,
        failingChecks: [{ name: "test", rawState: "FAILURE", detailsUrl: null }],
        commands: ["bun test"],
      }),
      at: "2026-01-20T13:10:02.000Z",
    });

    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 241 });
    const json = buildGatesJsonOutput({ repo: "3mdistal/ralph", issueNumber: 241, state });
    const ciGate = json.gates.find((gate) => gate.name === "ci");
    expect(ciGate?.classifierVersion).toBe(1);
    expect(ciGate?.classifierSource).toBe("persisted");
    expect(ciGate?.classifierSummary).toContain("classification=regression");
    expect(ciGate?.classifierPayload).toMatchObject({
      kind: "ci-triage-classifier",
      version: 1,
      signature: "sig-241",
      action: "resume",
    });
  });

  test("falls back to legacy CI classifier artifact when persisted payload is missing", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#242",
      taskPath: "github:3mdistal/ralph#242",
      attemptKind: "process",
      startedAt: "2026-01-20T13:20:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T13:20:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      at: "2026-01-20T13:20:02.000Z",
    });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "note",
      content: JSON.stringify({
        version: 1,
        signatureVersion: 2,
        signature: "legacy-242",
        classification: "infra",
        classificationReason: "infra_timeout",
        action: "spawn",
        actionReason: "spawn_flake_or_infra",
        timedOut: true,
        attempt: 2,
        maxAttempts: 5,
        priorSignature: null,
        failingChecks: [],
        commands: [],
      }),
      at: "2026-01-20T13:20:03.000Z",
    });

    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 242 });
    const json = buildGatesJsonOutput({ repo: "3mdistal/ralph", issueNumber: 242, state });
    const ciGate = json.gates.find((gate) => gate.name === "ci");
    expect(ciGate?.classifierVersion).toBe(1);
    expect(ciGate?.classifierSource).toBe("artifact");
    expect(ciGate?.classifierSummary).toContain("classification=infra");
  });

  test("does not fall back to legacy artifact when persisted version is unsupported", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#243",
      taskPath: "github:3mdistal/ralph#243",
      attemptKind: "process",
      startedAt: "2026-01-20T13:30:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T13:30:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      ciClassifierVersion: 99,
      ciClassifierPayloadJson: JSON.stringify({ kind: "ci-triage-classifier", version: 99 }),
      at: "2026-01-20T13:30:02.000Z",
    });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "note",
      content: JSON.stringify({
        version: 1,
        signatureVersion: 2,
        signature: "legacy-243",
        classification: "regression",
        classificationReason: "regression_checks",
        action: "resume",
        actionReason: "resume_has_session",
        timedOut: false,
        attempt: 1,
        maxAttempts: 5,
        priorSignature: null,
        failingChecks: [],
        commands: [],
      }),
      at: "2026-01-20T13:30:03.000Z",
    });

    const state = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 243 });
    const json = buildGatesJsonOutput({ repo: "3mdistal/ralph", issueNumber: 243, state });
    const ciGate = json.gates.find((gate) => gate.name === "ci");
    expect(ciGate?.classifierVersion).toBe(99);
    expect(ciGate?.classifierSource).toBe("persisted");
    expect(ciGate?.classifierPayload).toBeNull();
    expect(ciGate?.classifierUnsupportedVersion).toBe(99);
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
