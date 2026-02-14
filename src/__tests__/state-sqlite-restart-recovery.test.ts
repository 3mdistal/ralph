import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

import {
  closeStateDbForTests,
  createRalphRun,
  ensureRalphRunGateRows,
  initStateDb,
  upsertRalphRunGateResult,
  type GateName,
  type GateStatus,
} from "../state";
import { getRalphStateDbPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

type GateRow = {
  gate: GateName;
  status: GateStatus;
  command: string | null;
  reason: string | null;
  url: string | null;
  prNumber: number | null;
  prUrl: string | null;
  createdAt: string;
  updatedAt: string;
};

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

function restartDb(): void {
  closeStateDbForTests();
  initStateDb();
}

function createRun(params: { issueNumber: number; startedAt: string }): string {
  return createRalphRun({
    repo: "3mdistal/ralph",
    issue: `3mdistal/ralph#${params.issueNumber}`,
    taskPath: `github:3mdistal/ralph#${params.issueNumber}`,
    attemptKind: "process",
    startedAt: params.startedAt,
  });
}

function readGateRows(runId: string): GateRow[] {
  const db = new Database(getRalphStateDbPath(), { readonly: true });
  try {
    return db
      .query(
        `SELECT gate, status, command, reason, url, pr_number, pr_url, created_at, updated_at
         FROM ralph_run_gate_results
         WHERE run_id = $run_id
         ORDER BY gate ASC`
      )
      .all({ $run_id: runId })
      .map((row) => {
        const typed = row as {
          gate: string;
          status: string;
          command?: string | null;
          reason?: string | null;
          url?: string | null;
          pr_number?: number | null;
          pr_url?: string | null;
          created_at: string;
          updated_at: string;
        };
        return {
          gate: typed.gate as GateName,
          status: typed.status as GateStatus,
          command: typed.command ?? null,
          reason: typed.reason ?? null,
          url: typed.url ?? null,
          prNumber: typed.pr_number ?? null,
          prUrl: typed.pr_url ?? null,
          createdAt: typed.created_at,
          updatedAt: typed.updated_at,
        };
      });
  } finally {
    db.close();
  }
}

function assertOneRowPerGate(runId: string): void {
  const db = new Database(getRalphStateDbPath(), { readonly: true });
  try {
    const rows = db
      .query(
        `SELECT gate, COUNT(*) as count
         FROM ralph_run_gate_results
         WHERE run_id = $run_id
         GROUP BY gate
         ORDER BY gate ASC`
      )
      .all({ $run_id: runId }) as Array<{ gate?: string; count?: number }>;

    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.count).toBe(1);
    }
  } finally {
    db.close();
  }
}

describe("state sqlite restart/recovery gate matrix", () => {
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

  test("restart during gate-write replay stays idempotent", () => {
    initStateDb();

    const runId = createRun({ issueNumber: 7341, startedAt: "2026-02-14T01:00:00.000Z" });
    ensureRalphRunGateRows({ runId, at: "2026-02-14T01:00:01.000Z" });

    const ciPayload = {
      runId,
      gate: "ci" as const,
      status: "fail" as const,
      reason: "Required checks failed",
      url: "https://github.com/3mdistal/ralph/actions/runs/7341",
      at: "2026-02-14T01:00:02.000Z",
    };

    upsertRalphRunGateResult(ciPayload);
    const beforeRestart = readGateRows(runId);
    const ciBefore = beforeRestart.find((row) => row.gate === "ci");
    expect(ciBefore?.status).toBe("fail");
    expect(ciBefore?.reason).toBe("Required checks failed");

    restartDb();
    upsertRalphRunGateResult(ciPayload);

    const afterReplay = readGateRows(runId);
    const ciAfter = afterReplay.find((row) => row.gate === "ci");
    expect(ciAfter?.status).toBe("fail");
    expect(ciAfter?.reason).toBe("Required checks failed");
    expect(ciAfter?.url).toContain("actions/runs/7341");

    assertOneRowPerGate(runId);
  });

  test("ci remediation survives restarts without duplicate or skipped transitions", () => {
    initStateDb();

    const runId = createRun({ issueNumber: 7342, startedAt: "2026-02-14T01:10:00.000Z" });
    ensureRalphRunGateRows({ runId, at: "2026-02-14T01:10:01.000Z" });

    const seenStatuses: GateStatus[] = [];

    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      reason: "job failed",
      at: "2026-02-14T01:10:02.000Z",
    });
    const failSnapshot = readGateRows(runId).find((row) => row.gate === "ci");
    expect(failSnapshot?.status).toBe("fail");
    expect(failSnapshot?.updatedAt).toBe("2026-02-14T01:10:02.000Z");
    seenStatuses.push(failSnapshot?.status ?? "pending");

    restartDb();
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "pending",
      reason: "remediation in progress",
      at: "2026-02-14T01:10:03.000Z",
    });
    const pendingSnapshot = readGateRows(runId).find((row) => row.gate === "ci");
    expect(pendingSnapshot?.status).toBe("pending");
    expect(pendingSnapshot?.updatedAt).toBe("2026-02-14T01:10:03.000Z");
    seenStatuses.push(pendingSnapshot?.status ?? "pending");

    restartDb();
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "pass",
      reason: "checks green",
      url: "https://github.com/3mdistal/ralph/actions/runs/7342",
      at: "2026-02-14T01:10:04.000Z",
    });
    const passSnapshot = readGateRows(runId).find((row) => row.gate === "ci");
    expect(passSnapshot?.status).toBe("pass");
    expect(passSnapshot?.updatedAt).toBe("2026-02-14T01:10:04.000Z");
    seenStatuses.push(passSnapshot?.status ?? "pending");

    expect(seenStatuses).toEqual(["fail", "pending", "pass"]);
    assertOneRowPerGate(runId);
  });

  test("resume continues from persisted gate rows after restart", () => {
    initStateDb();

    const runId = createRun({ issueNumber: 7343, startedAt: "2026-02-14T01:20:00.000Z" });
    ensureRalphRunGateRows({ runId, at: "2026-02-14T01:20:01.000Z" });

    upsertRalphRunGateResult({
      runId,
      gate: "preflight",
      status: "pass",
      command: "bun test src/__tests__/state-sqlite-restart-recovery.test.ts",
      at: "2026-02-14T01:20:02.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "plan_review",
      status: "pass",
      reason: "plan approved",
      at: "2026-02-14T01:20:03.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "product_review",
      status: "pass",
      reason: "product approved",
      at: "2026-02-14T01:20:04.000Z",
    });

    restartDb();
    const persisted = readGateRows(runId);
    expect(persisted.find((row) => row.gate === "preflight")?.status).toBe("pass");
    expect(persisted.find((row) => row.gate === "plan_review")?.status).toBe("pass");
    expect(persisted.find((row) => row.gate === "product_review")?.status).toBe("pass");

    upsertRalphRunGateResult({
      runId,
      gate: "devex_review",
      status: "pass",
      reason: "devex approved",
      at: "2026-02-14T01:20:05.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "pass",
      url: "https://github.com/3mdistal/ralph/actions/runs/7343",
      at: "2026-02-14T01:20:06.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "pr_evidence",
      status: "pass",
      prNumber: 7343,
      prUrl: "https://github.com/3mdistal/ralph/pull/7343",
      at: "2026-02-14T01:20:07.000Z",
    });

    const finalRows = readGateRows(runId);
    expect(finalRows.find((row) => row.gate === "preflight")?.status).toBe("pass");
    expect(finalRows.find((row) => row.gate === "plan_review")?.status).toBe("pass");
    expect(finalRows.find((row) => row.gate === "product_review")?.status).toBe("pass");
    expect(finalRows.find((row) => row.gate === "devex_review")?.status).toBe("pass");
    expect(finalRows.find((row) => row.gate === "ci")?.status).toBe("pass");
    expect(finalRows.find((row) => row.gate === "pr_evidence")?.status).toBe("pass");

    assertOneRowPerGate(runId);
  });
});
