import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";

import {
  bumpLoopTriageAttempt,
  closeStateDbForTests,
  completeRalphRun,
  createRalphRun,
  createNewRollupBatch,
  classifyDurableStateInitError,
  isDurableStateInitError,
  deleteIdempotencyKey,
  ensureRalphRunGateRows,
  getIdempotencyPayload,
  getLoopTriageAttempt,
  getCiQuarantineFollowupMapping,
  getDurableStateSchemaWindow,
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
  probeDurableState,
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
  shouldAllowLoopTriageAttempt,
  upsertCiQuarantineFollowupMapping,
  upsertIdempotencyKey,
} from "../state";
import { getRalphStateDbPath } from "../paths";
import { acquireGlobalTestLock } from "./helpers/test-lock";

let homeDir: string;
let priorStateDbPath: string | undefined;
let priorMigrationBusyTimeoutMs: string | undefined;
let priorProbeBusyTimeoutMs: string | undefined;
let priorBackupBeforeMigrate: string | undefined;
let priorBackupDir: string | undefined;
let releaseLock: (() => void) | null = null;

describe("State SQLite (~/.ralph/state.sqlite)", () => {
  beforeEach(async () => {
    priorStateDbPath = process.env.RALPH_STATE_DB_PATH;
    priorMigrationBusyTimeoutMs = process.env.RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS;
    priorProbeBusyTimeoutMs = process.env.RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS;
    priorBackupBeforeMigrate = process.env.RALPH_STATE_DB_BACKUP_BEFORE_MIGRATE;
    priorBackupDir = process.env.RALPH_STATE_DB_BACKUP_DIR;
    releaseLock = await acquireGlobalTestLock();
    homeDir = await mkdtemp(join(tmpdir(), "ralph-home-"));
    process.env.RALPH_STATE_DB_PATH = join(homeDir, "state.sqlite");
    delete process.env.RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS;
    delete process.env.RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS;
    delete process.env.RALPH_STATE_DB_BACKUP_BEFORE_MIGRATE;
    delete process.env.RALPH_STATE_DB_BACKUP_DIR;
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
      if (priorMigrationBusyTimeoutMs === undefined) {
        delete process.env.RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS;
      } else {
        process.env.RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS = priorMigrationBusyTimeoutMs;
      }
      if (priorProbeBusyTimeoutMs === undefined) {
        delete process.env.RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS;
      } else {
        process.env.RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS = priorProbeBusyTimeoutMs;
      }
      if (priorBackupBeforeMigrate === undefined) {
        delete process.env.RALPH_STATE_DB_BACKUP_BEFORE_MIGRATE;
      } else {
        process.env.RALPH_STATE_DB_BACKUP_BEFORE_MIGRATE = priorBackupBeforeMigrate;
      }
      if (priorBackupDir === undefined) {
        delete process.env.RALPH_STATE_DB_BACKUP_DIR;
      } else {
        process.env.RALPH_STATE_DB_BACKUP_DIR = priorBackupDir;
      }
      releaseLock?.();
      releaseLock = null;
    }
  });

  test("refuses newer schema versions with actionable guidance", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
    } finally {
      db.close();
    }

    closeStateDbForTests();
    expect(() => initStateDb()).toThrow(/writable range=1\.\.\d+/);
    expect(() => initStateDb()).toThrow(/restore a compatible state\.sqlite backup/);
    expect(() => initStateDb()).not.toThrow(/delete ~\/\.ralph\/state\.sqlite/);
  });

  test("probeDurableState classifies forward-incompatible schema", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '999')");
    } finally {
      db.close();
    }

    closeStateDbForTests();
    const probe = probeDurableState();
    expect(probe.ok).toBeFalse();
    if (!probe.ok) {
      expect(probe.code).toBe("forward_incompatible");
      expect(probe.verdict).toBe("unreadable_forward_incompatible");
      expect(probe.canReadState).toBeFalse();
      expect(probe.canWriteState).toBeFalse();
      expect(probe.requiresMigration).toBeTrue();
      expect(probe.schemaVersion).toBe(999);
      expect(probe.supportedRange).toBe(`1..${getDurableStateSchemaWindow().maxReadableSchema}`);
      expect(probe.writableRange).toBe(`1..${getDurableStateSchemaWindow().maxWritableSchema}`);
    }
  });

  test("probeDurableState returns readable readonly for forward-newer within readable window", () => {
    const window = getDurableStateSchemaWindow();
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec(`INSERT INTO meta(key, value) VALUES ('schema_version', '${window.maxWritableSchema + 1}')`);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    const probe = probeDurableState();
    expect(probe.ok).toBeTrue();
    if (probe.ok) {
      expect(probe.verdict).toBe("readable_readonly_forward_newer");
      expect(probe.canReadState).toBeTrue();
      expect(probe.canWriteState).toBeFalse();
      expect(probe.requiresMigration).toBeTrue();
      expect(probe.schemaVersion).toBe(window.maxWritableSchema + 1);
      expect(probe.maxReadableSchema).toBe(window.maxReadableSchema);
      expect(probe.maxWritableSchema).toBe(window.maxWritableSchema);
    }
  });

  test("classifyDurableStateInitError maps known failure classes", () => {
    const forward = classifyDurableStateInitError(
      new Error("Unsupported state.sqlite schema_version=22; supported range=1..22 writable range=1..21.")
    );
    expect(forward.code).toBe("forward_incompatible");
    expect(forward.supportedRange).toBe(`1..${getDurableStateSchemaWindow().maxReadableSchema}`);
    expect(forward.writableRange).toBe(`1..${getDurableStateSchemaWindow().maxWritableSchema}`);

    const invariant = classifyDurableStateInitError(
      new Error("state.sqlite schema invariant failed: table=x has incompatible object type=view")
    );
    expect(invariant.code).toBe("invariant_failure");
    expect(invariant.verdict).toBe("unreadable_invariant_failure");

    const locked = classifyDurableStateInitError(new Error("state.sqlite migration lock timeout after 3000ms."));
    expect(locked.code).toBe("lock_timeout");

    expect(isDurableStateInitError(new Error("state.sqlite migration lock timeout after 3000ms."))).toBe(true);
    expect(isDurableStateInitError(new Error("boom"))).toBe(false);
  });

  test("backs up state.sqlite before migration", async () => {
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

    process.env.RALPH_STATE_DB_BACKUP_DIR = join(homeDir, "backups");

    closeStateDbForTests();
    initStateDb();

    const backupFiles = await readdir(process.env.RALPH_STATE_DB_BACKUP_DIR);
    expect(backupFiles.some((name) => name.startsWith("state.schema-v7."))).toBe(true);
  });

  test("aborts migration when backup creation fails before first schema write", () => {
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

    const blockedBackupPath = join(homeDir, "backup-target-is-file");
    const blocked = new Database(blockedBackupPath);
    blocked.close();
    process.env.RALPH_STATE_DB_BACKUP_DIR = blockedBackupPath;

    closeStateDbForTests();
    expect(() => initStateDb()).toThrow();

    const verify = new Database(dbPath, { readonly: true });
    try {
      const meta = verify.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("7");
    } finally {
      verify.close();
    }
  });

  test("records migration backup and ledger metadata", async () => {
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

    process.env.RALPH_STATE_DB_BACKUP_DIR = join(homeDir, "backups");

    closeStateDbForTests();
    initStateDb();

    const verify = new Database(dbPath, { readonly: true });
    try {
      const backupRow = verify.query(
        "SELECT from_schema_version, to_schema_version, backup_sha256, backup_size_bytes, integrity_check_result FROM state_migration_backups ORDER BY id DESC LIMIT 1"
      ).get() as {
        from_schema_version?: number;
        to_schema_version?: number;
        backup_sha256?: string;
        backup_size_bytes?: number;
        integrity_check_result?: string;
      };
      expect(backupRow.from_schema_version).toBe(7);
      expect(backupRow.to_schema_version).toBe(24);
      expect(backupRow.integrity_check_result).toBe("ok");
      expect(backupRow.backup_size_bytes).toBeGreaterThan(0);
      expect(backupRow.backup_sha256).toMatch(/^[a-f0-9]{64}$/);

      const attemptRow = verify.query(
        "SELECT from_schema_version, to_schema_version, completed_at FROM state_migration_attempts ORDER BY id DESC LIMIT 1"
      ).get() as { from_schema_version?: number; to_schema_version?: number; completed_at?: string | null };
      expect(attemptRow.from_schema_version).toBe(7);
      expect(attemptRow.to_schema_version).toBe(24);
      expect(attemptRow.completed_at).toBeString();

      const completionCheckpoint = verify.query(
        "SELECT checkpoint FROM state_migration_ledger WHERE checkpoint = 'schema-v24-complete' LIMIT 1"
      ).get() as { checkpoint?: string } | undefined;
      expect(completionCheckpoint?.checkpoint).toBe("schema-v24-complete");
    } finally {
      verify.close();
    }
  });

  test("fails deterministically when migration lock times out", () => {
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
          status TEXT,
          session_id TEXT,
          worktree_path TEXT,
          worker_id TEXT,
          repo_slot TEXT,
          daemon_id TEXT,
          heartbeat_at TEXT,
          created_at TEXT,
          updated_at TEXT,
          UNIQUE(repo_id, task_path)
        )
      `);
    } finally {
      db.close();
    }

    const lockDb = new Database(dbPath);
    lockDb.exec("BEGIN IMMEDIATE");
    process.env.RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS = "1";

    closeStateDbForTests();
    try {
      expect(() => initStateDb()).toThrow(/migration lock timeout/);
    } finally {
      lockDb.exec("ROLLBACK");
      lockDb.close();
    }
  });

  test("probeDurableState reports lock timeout under exclusive lock", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '1')");
    } finally {
      db.close();
    }

    const lockDb = new Database(dbPath);
    lockDb.exec("BEGIN EXCLUSIVE");
    process.env.RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS = "1";

    try {
      const probe = probeDurableState();
      expect(probe.ok).toBeFalse();
      if (!probe.ok) {
        expect(probe.code).toBe("lock_timeout");
      }
    } finally {
      lockDb.exec("ROLLBACK");
      lockDb.close();
    }
  });
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
      expect(meta.value).toBe("24");

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

      const bootstrapCursorTable = migrated
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_github_issue_sync_bootstrap_cursor'"
        )
        .get() as { name?: string } | undefined;
      expect(bootstrapCursorTable?.name).toBe("repo_github_issue_sync_bootstrap_cursor");

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

      const parentVerifyTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'parent_verification_state'")
        .get() as { name?: string } | undefined;
      expect(parentVerifyTable?.name).toBe("parent_verification_state");

      const runMetricsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_metrics'")
        .get() as { name?: string } | undefined;
      expect(runMetricsTable?.name).toBe("ralph_run_metrics");

      const stepMetricsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_step_metrics'")
        .get() as { name?: string } | undefined;
      expect(stepMetricsTable?.name).toBe("ralph_run_step_metrics");
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
      expect(meta.value).toBe("24");

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

      const gateColumns = migrated.query("PRAGMA table_info(ralph_run_gate_results)").all() as Array<{ name: string }>;
      const gateColumnNames = gateColumns.map((column) => column.name);
      expect(gateColumnNames).toContain("reason");

      const gateArtifactsTable = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_gate_artifacts'")
        .get() as { name?: string } | undefined;
      expect(gateArtifactsTable?.name).toBe("ralph_run_gate_artifacts");

      const bootstrapCursorTable = migrated
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo_github_issue_sync_bootstrap_cursor'"
        )
        .get() as { name?: string } | undefined;
      expect(bootstrapCursorTable?.name).toBe("repo_github_issue_sync_bootstrap_cursor");
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

  test("fills missing v10+ columns idempotently during migration", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '9')");
      db.exec(`
        CREATE TABLE IF NOT EXISTS repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          local_path TEXT,
          bot_branch TEXT,
          label_write_last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT NOT NULL,
          status TEXT,
          session_id TEXT,
          worktree_path TEXT,
          worker_id TEXT,
          repo_slot TEXT,
          daemon_id TEXT,
          heartbeat_at TEXT,
          released_reason TEXT,
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
      const repoColumns = migrated.query("PRAGMA table_info(repos)").all() as Array<{ name: string }>;
      const repoColumnNames = repoColumns.map((column) => column.name);
      expect(repoColumnNames).toContain("label_write_blocked_until_ms");
      expect(repoColumnNames).toContain("label_write_last_error");

      const taskColumns = migrated.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      const taskColumnNames = taskColumns.map((column) => column.name);
      expect(taskColumnNames).toContain("released_at_ms");
      expect(taskColumnNames).toContain("released_reason");
    } finally {
      migrated.close();
    }
  });

  test("repairs same-version gate schema drift idempotently at startup", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '22')");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ralph_run_gate_results (
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          status TEXT NOT NULL,
          command TEXT,
          skip_reason TEXT,
          url TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, gate)
        );
        CREATE TABLE IF NOT EXISTS ralph_run_gate_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          original_chars INTEGER,
          original_lines INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();
    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const gateColumns = migrated.query("PRAGMA table_info(ralph_run_gate_results)").all() as Array<{ name: string }>;
      const gateColumnNames = gateColumns.map((column) => column.name);
      expect(gateColumnNames).toContain("reason");

      const issueIndex = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ralph_run_gate_results_repo_issue_updated'")
        .get() as { name?: string } | undefined;
      expect(issueIndex?.name).toBe("idx_ralph_run_gate_results_repo_issue_updated");

      const prIndex = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ralph_run_gate_results_repo_pr'")
        .get() as { name?: string } | undefined;
      expect(prIndex?.name).toBe("idx_ralph_run_gate_results_repo_pr");

      const gateResultsSql = migrated
        .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'ralph_run_gate_results'")
        .get() as { sql?: string } | undefined;
      expect(gateResultsSql?.sql).toContain("plan_review");

      const gateArtifactColumns = migrated.query("PRAGMA table_info(ralph_run_gate_artifacts)").all() as Array<{ name: string }>;
      const gateArtifactColumnNames = gateArtifactColumns.map((column) => column.name);
      expect(gateArtifactColumnNames).toContain("artifact_policy_version");
      expect(gateArtifactColumnNames).toContain("truncation_mode");
    } finally {
      migrated.close();
    }
  });

  test("fails closed with explicit diagnostics when invariant object type is incompatible", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '19')");
      db.exec("CREATE VIEW ralph_run_gate_results AS SELECT 'run-1' AS run_id");
    } finally {
      db.close();
    }

    closeStateDbForTests();
    expect(() => initStateDb()).toThrow(/schema invariant failed/);
    expect(() => initStateDb()).toThrow(/table=ralph_run_gate_results has incompatible object type=view/);
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

  test("persists normalized non-empty details for failed runs", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#795",
      taskPath: "github:3mdistal/ralph#795",
      attemptKind: "process",
      startedAt: "2026-02-24T10:00:00.000Z",
    });

    completeRalphRun({
      runId,
      outcome: "failed",
      completedAt: "2026-02-24T10:05:00.000Z",
    });

    const db = new Database(getRalphStateDbPath());
    try {
      const runRow = db
        .query("SELECT details_json FROM ralph_runs WHERE run_id = $run_id")
        .get({ $run_id: runId }) as { details_json?: string | null };

      expect(runRow.details_json).toBeTruthy();
      const details = JSON.parse(String(runRow.details_json));
      expect(details.reasonCode).toBe("failed");
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
    expect(state.results.length).toBe(6);
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
      reason: "Required checks failed",
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
    expect(ciGate?.reason).toBe("Required checks failed");
    expect(ciGate?.prNumber).toBe(233);
    expect(ciGate?.prUrl).toContain("pull/233");
  });

  test("pr_evidence pass is sticky and cannot be downgraded", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#299",
      taskPath: "github:3mdistal/ralph#299",
      attemptKind: "process",
      startedAt: "2026-01-20T12:11:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:11:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "pr_evidence",
      status: "pass",
      prNumber: 299,
      prUrl: "https://github.com/3mdistal/ralph/pull/299",
      at: "2026-01-20T12:11:02.000Z",
    });
    upsertRalphRunGateResult({
      runId,
      gate: "pr_evidence",
      status: "fail",
      skipReason: "missing pr_url",
      at: "2026-01-20T12:11:03.000Z",
    });

    const state = getRalphRunGateState(runId);
    const gate = state.results.find((result) => result.gate === "pr_evidence");
    expect(gate?.status).toBe("pass");
    expect(gate?.prNumber).toBe(299);
    expect(gate?.prUrl).toContain("pull/299");
  });

  test("migrates v15 gate tables to support pr_evidence and plan_review", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '15')");
      db.exec(`
        CREATE TABLE repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO repos(name, created_at, updated_at)
        VALUES ('3mdistal/ralph', '2026-01-20T12:00:00.000Z', '2026-01-20T12:00:00.000Z');

        CREATE TABLE ralph_runs (
          run_id TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          attempt_kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );
        INSERT INTO ralph_runs(
          run_id, repo_id, issue_number, task_path, attempt_kind, started_at, created_at, updated_at
        ) VALUES (
          'run_v15', 1, 1, 'github:3mdistal/ralph#1', 'process',
          '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z'
        );

        CREATE TABLE ralph_run_gate_results (
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'pass', 'fail', 'skipped')),
          command TEXT,
          skip_reason TEXT,
          url TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, gate),
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE ralph_run_gate_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci')),
          kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
          content TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          original_chars INTEGER,
          original_lines INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
        );

        INSERT INTO ralph_run_gate_results(
          run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
        ) VALUES (
          'run_v15', 'ci', 'pending', 1, 1, 'github:3mdistal/ralph#1', '2026-01-20T12:00:02.000Z', '2026-01-20T12:00:02.000Z'
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("24");

      migrated
        .query(
          `INSERT INTO ralph_run_gate_results(
             run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
           ) VALUES (
             'run_v15', 'pr_evidence', 'pending', 1, 1, 'github:3mdistal/ralph#1', '2026-01-20T12:00:03.000Z', '2026-01-20T12:00:03.000Z'
           )`
        )
        .run();

      const row = migrated
        .query("SELECT gate FROM ralph_run_gate_results WHERE run_id = 'run_v15' AND gate = 'pr_evidence'")
        .get() as { gate?: string } | undefined;
      expect(row?.gate).toBe("pr_evidence");

      const planReview = migrated
        .query("SELECT gate, status FROM ralph_run_gate_results WHERE run_id = 'run_v15' AND gate = 'plan_review'")
        .get() as { gate?: string; status?: string } | undefined;
      expect(planReview?.gate).toBe("plan_review");
      expect(planReview?.status).toBe("pending");
    } finally {
      migrated.close();
    }
  });

  test("migrates v18 gate CHECK constraints to support pr_evidence and plan_review", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '18')");
      db.exec(`
        CREATE TABLE repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO repos(name, created_at, updated_at)
        VALUES ('3mdistal/ralph', '2026-01-20T12:00:00.000Z', '2026-01-20T12:00:00.000Z');

        CREATE TABLE ralph_runs (
          run_id TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          attempt_kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );
        INSERT INTO ralph_runs(
          run_id, repo_id, issue_number, task_path, attempt_kind, started_at, created_at, updated_at
        ) VALUES (
          'run_v18', 1, 1, 'github:3mdistal/ralph#1', 'process',
          '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z'
        );

        CREATE TABLE ralph_run_gate_results (
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'pass', 'fail', 'skipped')),
          command TEXT,
          skip_reason TEXT,
          reason TEXT,
          url TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, gate),
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE ralph_run_gate_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci')),
          kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
          content TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          original_chars INTEGER,
          original_lines INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
        );

        INSERT INTO ralph_run_gate_results(
          run_id, gate, status, reason, repo_id, issue_number, task_path, created_at, updated_at
        ) VALUES (
          'run_v18', 'ci', 'pending', 'old constraint', 1, 1, 'github:3mdistal/ralph#1', '2026-01-20T12:00:02.000Z', '2026-01-20T12:00:02.000Z'
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("24");

      const row = migrated
        .query("SELECT reason FROM ralph_run_gate_results WHERE run_id = 'run_v18' AND gate = 'ci'")
        .get() as { reason?: string } | undefined;
      expect(row?.reason).toBe("old constraint");

      migrated
        .query(
          `INSERT INTO ralph_run_gate_results(
             run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
           ) VALUES (
             'run_v18', 'pr_evidence', 'pending', 1, 1, 'github:3mdistal/ralph#1', '2026-01-20T12:00:03.000Z', '2026-01-20T12:00:03.000Z'
           )`
        )
        .run();

      const inserted = migrated
        .query("SELECT gate FROM ralph_run_gate_results WHERE run_id = 'run_v18' AND gate = 'pr_evidence'")
        .get() as { gate?: string } | undefined;
      expect(inserted?.gate).toBe("pr_evidence");

      const planReview = migrated
        .query("SELECT gate, status FROM ralph_run_gate_results WHERE run_id = 'run_v18' AND gate = 'plan_review'")
        .get() as { gate?: string; status?: string } | undefined;
      expect(planReview?.gate).toBe("plan_review");
      expect(planReview?.status).toBe("pending");
    } finally {
      migrated.close();
    }
  });

  test("migrates v20 gate CHECK constraints to support plan_review and backfills rows", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '20')");
      db.exec(`
        CREATE TABLE repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO repos(name, created_at, updated_at)
        VALUES ('3mdistal/ralph', '2026-01-20T12:00:00.000Z', '2026-01-20T12:00:00.000Z');

        CREATE TABLE ralph_runs (
          run_id TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          attempt_kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );
        INSERT INTO ralph_runs(
          run_id, repo_id, issue_number, task_path, attempt_kind, started_at, created_at, updated_at
        ) VALUES (
          'run_v20', 1, 1, 'github:3mdistal/ralph#1', 'process',
          '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z'
        );

        CREATE TABLE ralph_run_gate_results (
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci', 'pr_evidence')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'pass', 'fail', 'skipped')),
          command TEXT,
          skip_reason TEXT,
          reason TEXT,
          url TEXT,
          pr_number INTEGER,
          pr_url TEXT,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(run_id, gate),
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );

        CREATE TABLE ralph_run_gate_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL CHECK (gate IN ('preflight', 'product_review', 'devex_review', 'ci', 'pr_evidence')),
          kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
          content TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          original_chars INTEGER,
          original_lines INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
        );

        INSERT INTO ralph_run_gate_results(
          run_id, gate, status, reason, repo_id, issue_number, task_path, created_at, updated_at
        ) VALUES (
          'run_v20', 'ci', 'pending', 'before v21', 1, 1, 'github:3mdistal/ralph#1', '2026-01-20T12:00:02.000Z', '2026-01-20T12:00:02.000Z'
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();
    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("24");

      const backfilled = migrated
        .query("SELECT status FROM ralph_run_gate_results WHERE run_id = 'run_v20' AND gate = 'plan_review'")
        .get() as { status?: string } | undefined;
      expect(backfilled?.status).toBe("pending");

      const backfillCount = migrated
        .query("SELECT COUNT(*) as count FROM ralph_run_gate_results WHERE run_id = 'run_v20' AND gate = 'plan_review'")
        .get() as { count?: number } | undefined;
      expect(backfillCount?.count).toBe(1);

      migrated
        .query(
          `INSERT INTO ralph_run_gate_artifacts(
             run_id, gate, kind, content, created_at, updated_at
           ) VALUES (
             'run_v20', 'plan_review', 'note', 'artifact', '2026-01-20T12:00:05.000Z', '2026-01-20T12:00:05.000Z'
           )`
        )
        .run();

      const artifact = migrated
        .query("SELECT gate FROM ralph_run_gate_artifacts WHERE run_id = 'run_v20' AND gate = 'plan_review' LIMIT 1")
        .get() as { gate?: string } | undefined;
      expect(artifact?.gate).toBe("plan_review");

      const issueIndex = migrated
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_ralph_run_gate_results_repo_issue_updated'")
        .get() as { name?: string } | undefined;
      expect(issueIndex?.name).toBe("idx_ralph_run_gate_results_repo_issue_updated");
    } finally {
      migrated.close();
    }
  });

  test("migrates v21 gate artifacts to include artifact policy metadata columns", () => {
    const dbPath = getRalphStateDbPath();
    const db = new Database(dbPath);

    try {
      db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.exec("INSERT INTO meta(key, value) VALUES ('schema_version', '21')");
      db.exec(`
        CREATE TABLE repos (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO repos(name, created_at, updated_at)
        VALUES ('3mdistal/ralph', '2026-01-20T12:00:00.000Z', '2026-01-20T12:00:00.000Z');

        CREATE TABLE ralph_runs (
          run_id TEXT PRIMARY KEY,
          repo_id INTEGER NOT NULL,
          issue_number INTEGER,
          task_path TEXT,
          attempt_kind TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT,
          details_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
        );
        INSERT INTO ralph_runs(
          run_id, repo_id, issue_number, task_path, attempt_kind, started_at, created_at, updated_at
        ) VALUES (
          'run_v21', 1, 1, 'github:3mdistal/ralph#1', 'process',
          '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z', '2026-01-20T12:00:01.000Z'
        );

        CREATE TABLE ralph_run_gate_artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_id TEXT NOT NULL,
          gate TEXT NOT NULL,
          kind TEXT NOT NULL,
          content TEXT NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0,
          original_chars INTEGER,
          original_lines INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
        );

        INSERT INTO ralph_run_gate_artifacts(
          run_id, gate, kind, content, truncated, original_chars, original_lines, created_at, updated_at
        ) VALUES (
          'run_v21', 'ci', 'failure_excerpt', 'legacy-artifact', 0, 15, 1, '2026-01-20T12:00:02.000Z', '2026-01-20T12:00:02.000Z'
        );
      `);
    } finally {
      db.close();
    }

    closeStateDbForTests();
    initStateDb();

    const migrated = new Database(dbPath);
    try {
      const meta = migrated.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value?: string };
      expect(meta.value).toBe("24");

      const row = migrated
        .query(
          "SELECT content, artifact_policy_version, truncation_mode FROM ralph_run_gate_artifacts WHERE run_id = 'run_v21' LIMIT 1"
        )
        .get() as { content?: string; artifact_policy_version?: number; truncation_mode?: string } | undefined;
      expect(row?.content).toBe("legacy-artifact");
      expect(row?.artifact_policy_version).toBe(0);
      expect(row?.truncation_mode).toBe("tail");
    } finally {
      migrated.close();
    }
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

  test("gate artifact policy persists truncation mode and policy version", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#234",
      taskPath: "github:3mdistal/ralph#234",
      attemptKind: "process",
      startedAt: "2026-01-20T12:20:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:20:01.000Z" });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "note",
      content: `head-${"x".repeat(900)}`,
      at: "2026-01-20T12:20:02.000Z",
    });
    recordRalphRunGateArtifact({
      runId,
      gate: "ci",
      kind: "failure_excerpt",
      content: `prefix-${"y".repeat(9000)}-suffix`,
      at: "2026-01-20T12:20:03.000Z",
    });

    const state = getRalphRunGateState(runId);
    const note = state.artifacts.find((artifact) => artifact.kind === "note");
    const excerpt = state.artifacts.find((artifact) => artifact.kind === "failure_excerpt");

    expect(note?.artifactPolicyVersion).toBe(1);
    expect(note?.truncationMode).toBe("head");
    expect(note?.truncated).toBe(true);
    expect(note?.content.startsWith("head-")).toBe(true);

    expect(excerpt?.artifactPolicyVersion).toBe(1);
    expect(excerpt?.truncationMode).toBe("tail");
    expect(excerpt?.truncated).toBe(true);
    expect(excerpt?.content.endsWith("-suffix")).toBe(true);
  });

  test("gate result fields are redacted and bounded", () => {
    initStateDb();

    const runId = createRalphRun({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#234",
      taskPath: "github:3mdistal/ralph#234",
      attemptKind: "process",
      startedAt: "2026-01-20T12:20:00.000Z",
    });

    ensureRalphRunGateRows({ runId, at: "2026-01-20T12:20:01.000Z" });
    upsertRalphRunGateResult({
      runId,
      gate: "ci",
      status: "fail",
      reason: `Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234567890 ${"z".repeat(500)}`,
      at: "2026-01-20T12:20:04.000Z",
    });

    const state = getRalphRunGateState(runId);
    const ci = state.results.find((result) => result.gate === "ci");
    expect(ci?.reason).not.toContain("ghp_");
    expect(ci?.reason).toContain("[REDACTED]");
    expect((ci?.reason ?? "").length).toBeLessThanOrEqual(400);
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
      labels: ["ralph:status:queued", "dx"],
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
      expect(meta.value).toBe("24");

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
      expect(labelRows).toEqual([{ name: "dx" }, { name: "ralph:status:queued" }]);

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

  test("records loop triage attempts per signature", () => {
    initStateDb();

    expect(getLoopTriageAttempt({ repo: "3mdistal/ralph", issueNumber: 347, signature: "sig-a" })).toBeNull();

    const first = bumpLoopTriageAttempt({
      repo: "3mdistal/ralph",
      issueNumber: 347,
      signature: "sig-a",
      decision: "restart-new-agent",
      rationale: "Parse failed",
      nowMs: 1000,
    });

    expect(first.attemptCount).toBe(1);
    expect(first.lastDecision).toBe("restart-new-agent");
    expect(first.lastRationale).toBe("Parse failed");

    const second = bumpLoopTriageAttempt({
      repo: "3mdistal/ralph",
      issueNumber: 347,
      signature: "sig-a",
      decision: "resume-existing",
      rationale: "Model decision",
      nowMs: 2000,
    });
    expect(second.attemptCount).toBe(2);

    const differentSig = bumpLoopTriageAttempt({
      repo: "3mdistal/ralph",
      issueNumber: 347,
      signature: "sig-b",
      decision: "restart-ci-debug",
      rationale: "CI override",
      nowMs: 3000,
    });
    expect(differentSig.attemptCount).toBe(1);

    const db = new Database(getRalphStateDbPath());
    try {
      const rows = db
        .query("SELECT signature, attempt_count FROM loop_triage_attempts ORDER BY signature")
        .all() as Array<{ signature: string; attempt_count: number }>;
      expect(rows).toEqual([
        { signature: "sig-a", attempt_count: 2 },
        { signature: "sig-b", attempt_count: 1 },
      ]);
    } finally {
      db.close();
    }
  });

  test("loop triage attempt budget helper is strict", () => {
    expect(shouldAllowLoopTriageAttempt(0, 2)).toBe(true);
    expect(shouldAllowLoopTriageAttempt(1, 2)).toBe(true);
    expect(shouldAllowLoopTriageAttempt(2, 2)).toBe(false);
    expect(shouldAllowLoopTriageAttempt(3, 2)).toBe(false);
  });

  test("upserts and reads CI quarantine follow-up mapping by signature", () => {
    initStateDb();

    expect(getCiQuarantineFollowupMapping({ repo: "3mdistal/ralph", signature: "sig-1" })).toBeNull();

    const first = upsertCiQuarantineFollowupMapping({
      repo: "3mdistal/ralph",
      signature: "sig-1",
      followupIssueNumber: 9001,
      followupIssueUrl: "https://github.com/3mdistal/ralph/issues/9001",
      sourceIssueNumber: 732,
      at: "2026-02-18T00:00:00.000Z",
    });
    expect(first.issueNumber).toBe(9001);

    const second = upsertCiQuarantineFollowupMapping({
      repo: "3mdistal/ralph",
      signature: "sig-1",
      followupIssueNumber: 9002,
      followupIssueUrl: "https://github.com/3mdistal/ralph/issues/9002",
      sourceIssueNumber: 732,
      at: "2026-02-18T00:00:10.000Z",
    });
    expect(second.issueNumber).toBe(9002);

    const mapped = getCiQuarantineFollowupMapping({ repo: "3mdistal/ralph", signature: "sig-1" });
    expect(mapped).not.toBeNull();
    expect(mapped?.issueNumber).toBe(9002);
    expect(mapped?.issueUrl).toBe("https://github.com/3mdistal/ralph/issues/9002");
    expect(mapped?.sourceIssueNumber).toBe(732);
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
      labels: ["ralph:status:escalated", "ralph:status:queued"],
      at: "2026-01-11T00:00:00.000Z",
    });

    recordIssueLabelsSnapshot({
      repo: "3mdistal/ralph",
      issue: "3mdistal/ralph#11",
      labels: ["ralph:status:escalated"],
      at: "2026-01-11T00:00:01.000Z",
    });

    const matches = listIssuesWithAllLabels({
      repo: "3mdistal/ralph",
      labels: ["ralph:status:escalated", "ralph:status:queued"],
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
