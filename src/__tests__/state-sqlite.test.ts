import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import {
  closeStateDbForTests,
  completeRalphRun,
  createRalphRun,
  createNewRollupBatch,
  deleteIdempotencyKey,
  ensureRalphRunGateRows,
  getIdempotencyPayload,
  getLatestRunGateStateForIssue,
  getLatestRunGateStateForPr,
  getRalphRunGateState,
  getActiveRalphRunId,
  getOrCreateRollupBatch,
  initStateDb,
  listIssuesWithAllLabels,
  listOpenPrCandidatesForIssue,
  listOpenRollupBatches,
  listRalphRunSessionIds,
  listRollupBatchEntries,
  markRollupBatchRolledUp,
  recordRalphRunGateArtifact,
  recordIdempotencyKey,
  hasIdempotencyKey,
  recordRepoSync,
  recordIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordRepoGithubIssueSync,
  recordRepoGithubDoneReconcileCursor,
  getRepoGithubDoneReconcileCursor,
  recordRalphRunSessionUse,
  recordTaskSnapshot,
  recordPrSnapshot,
  recordAlertOccurrence,
  recordAlertDeliveryAttempt,
  listIssueAlertSummaries,
  PR_STATE_MERGED,
  PR_STATE_OPEN,
  recordRollupMerge,
  upsertRalphRunGateResult,
  upsertIdempotencyKey,
} from "../state";
import { getRalphStateDbPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let releaseLock: (() => void) | null = null;

describe("State SQLite (~/.ralph/state.sqlite)", () => {
  test("migrates schema from v3", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '3')");
      db.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          local_path TEXT,
          bot_branch TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          number INTEGER NOT NULL,
          title TEXT,
          state TEXT,
          url TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_id, number),
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT NOT NULL,
          task_name TEXT,
          status TEXT,
          session_id TEXT,
          worktree_path TEXT,
          worker_id TEXT,
          repo_slot TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_id, task_path),
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS prs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          pr_number INTEGER,
          url TEXT,
          state TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_id, url),
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS repo_sync (
          repo_id INTEGER PRIMARY KEY,
          last_sync_at TEXT NOT NULL,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS idempotency (
          key TEXT PRIMARY KEY,
          scope TEXT,
          created_at TEXT NOT NULL,
          payload_json TEXT
        );

        CREATE TABLE IF NOT EXISTS rollup_batches (
          id TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          bot_branch TEXT NOT NULL,
          batch_size INTEGER NOT NULL,
          status TEXT NOT NULL,
          rollup_pr_url TEXT,
          rollup_pr_number INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          rollup_created_at TEXT,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE,
          UNIQUE(repo_id, bot_branch, status)
        );

        CREATE TABLE IF NOT EXISTS rollup_batch_prs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          pr_url TEXT NOT NULL,
          pr_number INTEGER,
          issue_refs_json TEXT,
          merged_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY(batch_id) REFERENCES rollup_batches(id) ON DELETE CASCADE,
          UNIQUE(batch_id, pr_url)
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value?: string };
      expect(meta.value).toBe("12");

      const issueColumns = migrated.query("PRAGMA table_info(issues)").all() as Array<{ name: string }>;
      const issueColumnNames = issueColumns.map((column) => column.name);
      expect(issueColumnNames).toContain("github_node_id");
      expect(issueColumnNames).toContain("github_updated_at");

      const taskColumns = migrated.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const taskColumnNames = taskColumns.map((column) => column.name);
      expect(taskColumnNames).toContain("session_events_path");

      const issueLabelsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'issue_labels'")
        .get() as { name?: string } | undefined;
      expect(issueLabelsTable?.name).toBe("issue_labels");

      const cursorTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_github_issue_sync'")
        .get() as { name?: string } | undefined;
      expect(cursorTable?.name).toBe("repo_github_issue_sync");

      const runsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_runs'")
        .get() as { name?: string } | undefined;
      expect(runsTable?.name).toBe("ralph_runs");

      const runSessionsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_sessions'")
        .get() as { name?: string } | undefined;
      expect(runSessionsTable?.name).toBe("ralph_run_sessions");

      const runSessionTokensTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_session_token_totals'")
        .get() as { name?: string } | undefined;
      expect(runSessionTokensTable?.name).toBe("ralph_run_session_token_totals");

      const runTokensTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_token_totals'")
        .get() as { name?: string } | undefined;
      expect(runTokensTable?.name).toBe("ralph_run_token_totals");

      const doneCursorTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_github_done_reconcile_cursor'")
        .get() as { name?: string } | undefined;
      expect(doneCursorTable?.name).toBe("repo_github_done_reconcile_cursor");

      const alertsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alerts'")
        .get() as { name?: string } | undefined;
      expect(alertsTable?.name).toBe("alerts");

      const deliveriesTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_deliveries'")
        .get() as { name?: string } | undefined;
      expect(deliveriesTable?.name).toBe("alert_deliveries");
    } finally {
      migrated.close();
    }
  });

  test("migrates schema from v7", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '7')");
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT NOT NULL,
          task_name TEXT,
          status TEXT,
          session_id TEXT,
          worktree_path TEXT,
          worker_id TEXT,
          repo_slot TEXT,
          daemon_id TEXT,
          heartbeat_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(repo_id, task_path)
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated
        .query("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as { value?: string };
      expect(meta.value).toBe("12");

      const columns = migrated.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const columnNames = columns.map((column) => column.name);
      expect(columnNames).toContain("session_events_path");

      const runsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_runs'")
        .get() as { name?: string } | undefined;
      expect(runsTable?.name).toBe("ralph_runs");

      const runSessionsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_sessions'")
        .get() as { name?: string } | undefined;
      expect(runSessionsTable?.name).toBe("ralph_run_sessions");

      const gateResultsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_gate_results'")
        .get() as { name?: string } | undefined;
      expect(gateResultsTable?.name).toBe("ralph_run_gate_results");

      const gateArtifactsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_gate_artifacts'")
        .get() as { name?: string } | undefined;
      expect(gateArtifactsTable?.name).toBe("ralph_run_gate_artifacts");
      const alertsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alerts'")
        .get() as { name?: string } | undefined;
      expect(alertsTable?.name).toBe("alerts");

      const deliveriesTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alert_deliveries'")
        .get() as { name?: string } | undefined;
      expect(deliveriesTable?.name).toBe("alert_deliveries");
    } finally {
      migrated.close();
    }
  });

  test("records ralph runs and session usage", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#101",
      taskPath: "github:3mdistal/ralph#101",
      attemptKind: "process",
      startedAt: "2026-01-20T10:00:00.000Z",
    });

    recordRalphRunSessionUse({
      runId,
      sessionId: "ses_alpha",
      stepTitle: "plan",
      agent: "ralph-plan",
      at: "2026-01-20T10:01:00.000Z",
    });

    recordRalphRunSessionUse({
      runId,
      sessionId: "ses_alpha",
      stepTitle: "build",
      agent: "general",
      at: "2026-01-20T10:02:00.000Z",
    });

    recordRalphRunSessionUse({
      runId,
      sessionId: "ses_beta",
      stepTitle: "survey",
      at: "2026-01-20T10:03:00.000Z",
    });

    completeRalphRun({
      runId,
      outcome: "success",
      completedAt: "2026-01-20T10:10:00.000Z",
      details: { prUrl: "https://github.com/3mdistal/ralph/pull/123" },
    });

    completeRalphRun({
      runId,
      outcome: "failed",
      completedAt: "2026-01-20T10:20:00.000Z",
      details: { reasonCode: "late-write" },
    });

    const db = new Database(getRalphStateDbPath());
    try {
      const runRow = db
        .query("SELECT outcome, completed_at, details_json FROM ralph_runs WHERE run_id = $run_id")
        .get({ $run_id: runId }) as { outcome?: string; completed_at?: string; details_json?: string };

      expect(runRow.outcome).toBe("success");
      expect(runRow.completed_at).toBe("2026-01-20T10:10:00.000Z");
      expect(runRow.details_json).toContain("pull/123");

      const sessionRows = db
        .query(
          "SELECT session_id, first_step_title, last_step_title, first_agent, last_agent, first_seen_at, last_seen_at FROM ralph_run_sessions WHERE run_id = $run_id ORDER BY session_id"
        )
        .all({ $run_id: runId }) as Array<{
        session_id: string;
        first_step_title?: string | null;
        last_step_title?: string | null;
        first_agent?: string | null;
        last_agent?: string | null;
        first_seen_at: string;
        last_seen_at: string;
      }>;

      expect(sessionRows).toHaveLength(2);
      expect(sessionRows[0]?.session_id).toBe("ses_alpha");
      expect(sessionRows[0]?.first_step_title).toBe("plan");
      expect(sessionRows[0]?.last_step_title).toBe("build");
      expect(sessionRows[0]?.first_agent).toBe("ralph-plan");
      expect(sessionRows[0]?.last_agent).toBe("general");
      expect(sessionRows[0]?.first_seen_at).toBe("2026-01-20T10:01:00.000Z");
      expect(sessionRows[0]?.last_seen_at).toBe("2026-01-20T10:02:00.000Z");

      expect(sessionRows[1]?.session_id).toBe("ses_beta");
      expect(sessionRows[1]?.first_step_title).toBe("survey");
      expect(sessionRows[1]?.last_step_title).toBe("survey");
    } finally {
      db.close();
    }
  });

  test("persists gate state across restarts", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#232",
      taskPath: "github:3mdistal/ralph#232",
      attemptKind: "process",
      startedAt: "2026-01-20T12:00:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:00:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      url: "https://github.com/3mdistal/ralph/actions/runs/999",
      prNumber: 232,
      prUrl: "https://github.com/3mdistal/ralph/pull/232",
      at: "2026-01-20T12:00:02.000Z",
    });

    const noisyLog = [
      ...Array.from({ length: 210 }, (_, index) => `line-${index}`),
      "ghp_abcdefghijklmnopqrstuv",
    ].join("\n");

    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "failure_excerpt",
      content: noisyLog,
      at: "2026-01-20T12:00:03.000Z",
    });

    closeStateDbForTests();
    initStateDb();

    const state = getRalphRunGateState(runId);
    expect(state.results.length).toBe(4);
    const ciGate = state.results.find((result) => result.gate === "ci");
    expect(ciGate?.status).toBe("fail");
    expect(ciGate?.url).toContain("actions/runs/999");
    expect(ciGate?.prNumber).toBe(232);
    expect(ciGate?.prUrl).toContain("pull/232");

    const artifact = state.artifacts[0];
    expect(artifact?.kind).toBe("failure_excerpt");
    expect(artifact?.truncated).toBe(true);
    expect(artifact?.content).not.toContain("ghp_abcdefghijklmnopqrstuv");
    expect(artifact?.content.split("\n").length).toBeLessThanOrEqual(200);

    const latest = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 232 });
    expect(latest?.results.find((result) => result.gate === "ci")?.status).toBe("fail");
  });

  test("gate updates do not clobber existing fields", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#233",
      taskPath: "github:3mdistal/ralph#233",
      attemptKind: "process",
      startedAt: "2026-01-20T12:10:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:10:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      url: "https://github.com/3mdistal/ralph/actions/runs/1001",
      at: "2026-01-20T12:10:02.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      prNumber: 233,
      prUrl: "https://github.com/3mdistal/ralph/pull/233",
      at: "2026-01-20T12:10:03.000Z",
    });

    const state = getRalphRunGateState(runId);
    const ciGate = state.results.find((result) => result.gate === "ci");
    expect(ciGate?.status).toBe("fail");
    expect(ciGate?.url).toContain("runs/1001");
    expect(ciGate?.prNumber).toBe(233);
    expect(ciGate?.prUrl).toContain("pull/233");
  });

  test("gate artifacts enforce retention cap", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#234",
      taskPath: "github:3mdistal/ralph#234",
      attemptKind: "process",
      startedAt: "2026-01-20T12:20:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:20:01.000Z" });

    for (let i = 0; i < 12; i += 1) {
      recordRalphRunGateArtifact({
        runId,
        gate: "ci",
        kind: "failure_excerpt",
        content: `artifact-${i}`,
        at: `2026-01-20T12:20:${String(i).padStart(2, "0")}.000Z`,
      });
    }

    const state = getRalphRunGateState(runId);
    const artifacts = state.artifacts.filter(
      (artifact) => artifact.gate === "ci" && artifact.kind === "failure_excerpt"
    );
    expect(artifacts).toHaveLength(10);
    expect(artifacts.some((artifact) => artifact.content === "artifact-0")).toBe(false);
    expect(artifacts.some((artifact) => artifact.content === "artifact-1")).toBe(false);
    expect(artifacts.some((artifact) => artifact.content.includes("artifact-11"))).toBe(true);
  });

  test("latest gate selection is deterministic with ties", () => {
    initStateDb();

    const runIdOne = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#235",
      taskPath: "github:3mdistal/ralph#235",
      attemptKind: "process",
      startedAt: "2026-01-20T12:30:00.000Z",
    });
    const runIdTwo = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#235",
      taskPath: "github:3mdistal/ralph#235",
      attemptKind: "process",
      startedAt: "2026-01-20T12:30:10.000Z",
    });

    ensureRalphRunGateRows({ runId: runIdOne, at: "2026-01-20T12:30:05.000Z" });
    ensureRalphRunGateRows({ runId: runIdTwo, at: "2026-01-20T12:30:05.000Z" });

    upsertRalphRunGateResult({
      runId: runIdOne,
      gate: "ci",
      status: "fail",
      at: "2026-01-20T12:30:06.000Z",
    });
    upsertRalphRunGateResult({
      runId: runIdTwo,
      gate: "ci",
      status: "fail",
      at: "2026-01-20T12:30:06.000Z",
    });

    const latest = getLatestRunGateStateForIssue({ repo: "3mdistal/ralph", issueNumber: 235 });
    expect(latest?.results[0]?.runId).toBe(runIdTwo);
  });

  test("latest gate selection by PR number", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#236",
      taskPath: "github:3mdistal/ralph#236",
      attemptKind: "process",
      startedAt: "2026-01-20T12:40:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:40:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "pass",
      prNumber: 236,
      prUrl: "https://github.com/3mdistal/ralph/pull/236",
      at: "2026-01-20T12:40:02.000Z",
    });

    const latest = getLatestRunGateStateForPr({ repo: "3mdistal/ralph", prNumber: 236 });
    expect(latest?.results[0]?.runId).toBe(runId);
  });

  test("selects active run and lists session ids", () => {
    initStateDb();

    const run1 = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#201",
      taskPath: "github:3mdistal/ralph#201",
      attemptKind: "process",
      startedAt: "2026-01-20T10:01:00.000Z",
    });

    const run2 = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#201",
      taskPath: "github:3mdistal/ralph#201",
      attemptKind: "process",
      startedAt: "2026-01-20T10:02:00.000Z",
    });

    completeRalphRun({
      runId: run2,
      outcome: "success",
      completedAt: "2026-01-20T10:03:00.000Z",
    });

    recordRalphRunSessionUse({
      runId: run1,
      sessionId: "ses_new_a",
      stepTitle: "plan",
      at: "2026-01-20T10:01:30.000Z",
    });

    recordRalphRunSessionUse({
      runId: run1,
      sessionId: "ses_new_b",
      stepTitle: "build",
      at: "2026-01-20T10:01:40.000Z",
    });

    const active = getActiveRalphRunId({ repo: "3mdistal/ralph", issueNumber: 201 });
    expect(active).toBe(run1);

    const sessions = listRalphRunSessionIds(run1);
    expect(sessions).toEqual(["ses_new_a", "ses_new_b"]);
  });

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

  test("initializes schema and supports metadata writes", () => {
    initStateDb();

    recordRepoSync({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastSyncAt: "2026-01-11T00:00:00.000Z",
    });

    recordRepoGithubIssueSync({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastSyncAt: "2026-01-11T00:00:00.250Z",
    });

    recordRepoGithubDoneReconcileCursor({
      repo: "3mdistal/ralph",
      repoPath: "/tmp/ralph",
      botBranch: "bot/integration",
      lastMergedAt: "2026-01-12T00:00:00.250Z",
      lastPrNumber: 42,
      updatedAt: "2026-01-12T00:00:00.500Z",
    });

    expect(getRepoGithubDoneReconcileCursor("3mdistal/ralph")).toEqual({
      lastMergedAt: "2026-01-12T00:00:00.250Z",
      lastPrNumber: 42,
    });

    recordIssueSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      title: "Local state + config",
      state: "OPEN",
      url: "https://github.com/3mdistal/ralph/issues/59",
      githubNodeId: "MDU6SXNzdWUxMjM0NTY=",
      githubUpdatedAt: "2026-01-11T00:00:00.250Z",
      at: "2026-01-11T00:00:00.500Z",
    });

    recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      labels: ["ralph:queued", "dx"],
      at: "2026-01-11T00:00:00.750Z",
    });

    recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      taskPath: "orchestration/tasks/test.md",
      taskName: "Test Task",
      status: "queued",
      sessionId: "ses_123",
      worktreePath: "/tmp/worktree",
      workerId: "3mdistal/ralph#orchestration/tasks/test.md",
      repoSlot: "1",
      daemonId: "daemon-1",
      heartbeatAt: "2026-01-11T00:00:01.250Z",
      at: "2026-01-11T00:00:01.000Z",
    });

    recordTaskSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#60",
      taskPath: "orchestration/tasks/test-no-slot.md",
      taskName: "Test Task No Slot",
      status: "queued",
      sessionId: "ses_124",
      worktreePath: "/tmp/worktree-2",
      workerId: "w_123",
      at: "2026-01-11T00:00:01.500Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      state: PR_STATE_MERGED,
      at: "2026-01-11T00:00:02.000Z",
    });

    expect(hasIdempotencyKey("k1")).toBe(false);
    expect(recordIdempotencyKey({ key: "k1", scope: "test" })).toBe(true);
    expect(recordIdempotencyKey({ key: "k1", scope: "test" })).toBe(false);
    expect(hasIdempotencyKey("k1")).toBe(true);

    expect(getIdempotencyPayload("k1")).toBe(null);
    upsertIdempotencyKey({ key: "k1", scope: "test", payloadJson: JSON.stringify({ ok: true }) });
    expect(JSON.parse(getIdempotencyPayload("k1") ?? "{}")).toEqual({ ok: true });
    deleteIdempotencyKey("k1");
    expect(hasIdempotencyKey("k1")).toBe(false);

    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      const meta = db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("12");

      const repoCount = db.query("SELECT COUNT(*) as n FROM repos").get() as { n: number };
      expect(repoCount.n).toBe(1);

      const issueRow = db
        .query("SELECT title, state, url, github_node_id, github_updated_at FROM issues")
        .get() as {
        title?: string;
        state?: string;
        url?: string;
        github_node_id?: string;
        github_updated_at?: string;
      };
      expect(issueRow.title).toBe("Local state + config");
      expect(issueRow.state).toBe("OPEN");
      expect(issueRow.url).toBe("https://github.com/3mdistal/ralph/issues/59");
      expect(issueRow.github_node_id).toBe("MDU6SXNzdWUxMjM0NTY=");
      expect(issueRow.github_updated_at).toBe("2026-01-11T00:00:00.250Z");

      const labelRows = db
        .query("SELECT name FROM issue_labels ORDER BY name")
        .all() as Array<{ name: string }>;
      expect(labelRows).toEqual([{ name: "dx" }, { name: "ralph:queued" }]);

      const taskRows = db
        .query("SELECT worker_id, repo_slot, daemon_id, heartbeat_at FROM tasks ORDER BY task_path")
        .all() as Array<{
        worker_id?: string;
        repo_slot?: string | null;
        daemon_id?: string | null;
        heartbeat_at?: string | null;
      }>;
      expect(taskRows).toEqual([
        { worker_id: "w_123", repo_slot: null, daemon_id: null, heartbeat_at: null },
        {
          worker_id: "3mdistal/ralph#orchestration/tasks/test.md",
          repo_slot: "1",
          daemon_id: "daemon-1",
          heartbeat_at: "2026-01-11T00:00:01.250Z",
        },
      ]);

      const taskCount = db.query("SELECT COUNT(*) as n FROM tasks").get() as { n: number };
      expect(taskCount.n).toBe(2);

      const prCount = db.query("SELECT COUNT(*) as n FROM prs").get() as { n: number };
      expect(prCount.n).toBe(1);

      const sync = db.query("SELECT last_sync_at FROM repo_sync").get() as { last_sync_at?: string };
      expect(sync.last_sync_at).toBe("2026-01-11T00:00:00.000Z");

      const githubSync = db
        .query("SELECT last_sync_at FROM repo_github_issue_sync")
        .get() as { last_sync_at?: string };
      expect(githubSync.last_sync_at).toBe("2026-01-11T00:00:00.250Z");
    } finally {
      db.close();
    }
  });

  test("updates PR snapshot state and stores multiple PRs", () => {
    initStateDb();

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      state: PR_STATE_OPEN,
      at: "2026-01-11T00:00:02.000Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      state: PR_STATE_MERGED,
      at: "2026-01-11T00:00:03.000Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/123",
      state: PR_STATE_OPEN,
      at: "2026-01-11T00:00:03.500Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/456",
      state: PR_STATE_OPEN,
      at: "2026-01-11T00:00:04.000Z",
    });

    const db = new Database(getRalphStateDbPath());
    try {
      const rows = db
        .query("SELECT url, state FROM prs ORDER BY url")
        .all() as Array<{ url: string; state: string }>;
      expect(rows).toEqual([
        { url: "https://github.com/3mdistal/ralph/pull/123", state: "merged" },
        { url: "https://github.com/3mdistal/ralph/pull/456", state: "open" },
      ]);
    } finally {
      db.close();
    }
  });

  test("lists open PR candidates for an issue", () => {
    initStateDb();

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/100",
      state: PR_STATE_OPEN,
      at: "2026-01-11T00:00:00.000Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/101",
      at: "2026-01-11T00:00:01.000Z",
    });

    recordPrSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#59",
      prUrl: "https://github.com/3mdistal/ralph/pull/102",
      state: PR_STATE_MERGED,
      at: "2026-01-11T00:00:02.000Z",
    });

    const candidates = listOpenPrCandidatesForIssue("3mdistal/ralph", 59);
    expect(candidates.map((candidate) => candidate.url)).toEqual([
      "https://github.com/3mdistal/ralph/pull/101",
      "https://github.com/3mdistal/ralph/pull/100",
    ]);
  });

  test("lists issues with all labels", () => {
    initStateDb();

    recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#10",
      labels: ["ralph:escalated", "ralph:queued"],
      at: "2026-01-11T00:00:00.000Z",
    });

    recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#11",
      labels: ["ralph:escalated"],
      at: "2026-01-11T00:00:01.000Z",
    });

    const matches = listIssuesWithAllLabels({
      repo: "3mdistal/ralph",
      labels: ["ralph:escalated", "ralph:queued"],
    });

    expect(matches).toEqual([{ repo: "3mdistal/ralph", number: 10 }]);
  });

  test("records rollup batches and merges", () => {
    initStateDb();

    const batch = getOrCreateRollupBatch({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
    });

    expect(batch.status).toBe("open");
    expect(batch.batchSize).toBe(2);

    const first = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/101",
      issueRefs: ["3mdistal/ralph#101"],
      mergedAt: "2026-01-11T00:00:03.000Z",
    });

    expect(first.entries).toHaveLength(1);
    expect(first.entryInserted).toBe(true);

    const duplicate = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/101",
      mergedAt: "2026-01-11T00:00:03.500Z",
    });

    expect(duplicate.entries).toHaveLength(1);
    expect(duplicate.entryInserted).toBe(false);

    const second = recordRollupMerge({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      prUrl: "https://github.com/3mdistal/ralph/pull/102",
      mergedAt: "2026-01-11T00:00:04.000Z",
    });

    expect(second.entries).toHaveLength(2);

    const entries = listRollupBatchEntries(batch.id);
    expect(entries).toHaveLength(2);
    expect(entries[0].prUrl).toBe("https://github.com/3mdistal/ralph/pull/101");

    markRollupBatchRolledUp({
      batchId: batch.id,
      rollupPrUrl: "https://github.com/3mdistal/ralph/pull/999",
      rollupPrNumber: 999,
      at: "2026-01-11T00:00:05.000Z",
    });

    const newBatch = createNewRollupBatch({
      repo: "3mdistal/ralph",
      botBranch: "bot/integration",
      batchSize: 2,
      at: "2026-01-11T00:00:06.000Z",
    });

    expect(newBatch.id).not.toBe(batch.id);

    const openBatches = listOpenRollupBatches();
    expect(openBatches).toHaveLength(1);
    expect(openBatches[0].id).toBe(newBatch.id);
  });

  test("records alert occurrences and summaries", () => {
    initStateDb();

    const first = recordAlertOccurrence({
      repo: "3mdistal/ralph",
      targetType: "issue",
      targetNumber: 42,
      kind: "error",
      fingerprint: "abc",
      summary: "Error: build failed",
      details: "build failed",
      at: "2026-01-11T00:00:10.000Z",
    });

    const second = recordAlertOccurrence({
      repo: "3mdistal/ralph",
      targetType: "issue",
      targetNumber: 42,
      kind: "error",
      fingerprint: "abc",
      summary: "Error: build failed",
      details: "build failed again",
      at: "2026-01-11T00:00:11.000Z",
    });

    const third = recordAlertOccurrence({
      repo: "3mdistal/ralph",
      targetType: "issue",
      targetNumber: 42,
      kind: "error",
      fingerprint: "def",
      summary: "Error: test failed",
      details: "test failed",
      at: "2026-01-11T00:00:12.000Z",
    });

    recordAlertDeliveryAttempt({
      alertId: third.id,
      channel: "github-issue-comment",
      markerId: "marker-1",
      targetType: "issue",
      targetNumber: 42,
      status: "success",
      commentId: 1,
      commentUrl: "https://github.com/3mdistal/ralph/issues/42#issuecomment-1",
      at: "2026-01-11T00:00:13.000Z",
    });

    const summaries = listIssueAlertSummaries({ repo: "3mdistal/ralph", issueNumbers: [42, 99] });
    const summary = summaries.find((row) => row.issueNumber === 42);

    expect(first.id).toBeGreaterThan(0);
    expect(second.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
    expect(summary?.totalCount).toBe(3);
    expect(summary?.latestSummary).toBe("Error: test failed");
    expect(summary?.latestAt).toBe("2026-01-11T00:00:12.000Z");
    expect(summary?.latestCommentUrl).toBe("https://github.com/3mdistal/ralph/issues/42#issuecomment-1");
  });
});
