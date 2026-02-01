import { mkdirSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { Database } from "bun:sqlite";

import { getRalphHomeDir, getRalphStateDbPath, getSessionEventsPath } from "./paths";
import { redactSensitiveText } from "./redaction";
import { isSafeSessionId } from "./session-id";
import type { AlertKind, AlertTargetType } from "./alerts/core";

const SCHEMA_VERSION = 14;

export type PrState = "open" | "merged";
export type RalphRunOutcome = "success" | "throttled" | "escalated" | "failed";
export type RalphRunAttemptKind = "process" | "resume";
export type RalphRunDetails = {
  reasonCode?: string;
  errorCode?: string;
  escalationType?: string;
  prUrl?: string;
  completionKind?: "pr" | "verified";
  watchdogTimeout?: boolean;
};

export type AlertRecord = {
  id: number;
  repo: string;
  targetType: AlertTargetType;
  targetNumber: number;
  kind: AlertKind;
  fingerprint: string;
  summary: string;
  details: string | null;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type AlertDeliveryStatus = "success" | "skipped" | "failed";

export type AlertDeliveryRecord = {
  alertId: number;
  channel: string;
  markerId: string;
  targetType: AlertTargetType;
  targetNumber: number;
  status: AlertDeliveryStatus;
  commentId: number | null;
  commentUrl: string | null;
  attempts: number;
  lastAttemptAt: string;
  lastError: string | null;
};

export type IssueAlertSummary = {
  repo: string;
  issueNumber: number;
  totalCount: number;
  latestSummary: string | null;
  latestAt: string | null;
  latestCommentUrl: string | null;
};
export const PR_STATE_OPEN: PrState = "open";
export const PR_STATE_MERGED: PrState = "merged";

export type GateName = "preflight" | "product_review" | "devex_review" | "ci";
export type GateStatus = "pending" | "pass" | "fail" | "skipped";
export type GateArtifactKind = "command_output" | "failure_excerpt" | "note";

export type ParentVerificationStatus = "pending" | "running" | "complete";
export type ParentVerificationOutcome = "work_remains" | "no_work" | "failed" | "skipped";

export type ParentVerificationState = {
  repo: string;
  issueNumber: number;
  status: ParentVerificationStatus;
  pendingAtMs: number | null;
  attemptCount: number;
  lastAttemptAtMs: number | null;
  nextAttemptAtMs: number | null;
  outcome: ParentVerificationOutcome | null;
  outcomeDetails: string | null;
  updatedAtMs: number;
};

const GATE_NAMES: GateName[] = ["preflight", "product_review", "devex_review", "ci"];
const GATE_STATUSES: GateStatus[] = ["pending", "pass", "fail", "skipped"];
const GATE_ARTIFACT_KINDS: GateArtifactKind[] = ["command_output", "failure_excerpt", "note"];

const ARTIFACT_MAX_LINES = 200;
const ARTIFACT_MAX_CHARS = 20_000;
const ARTIFACT_MAX_PER_GATE_KIND = 10;

let db: Database | null = null;
let dbPath: string | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function toJson(value: unknown): string {
  if (value === undefined) return "[]";
  return JSON.stringify(value);
}

function trimRunLabel(value: string | undefined | null, maxLength = 200): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trimEnd();
}

function sanitizeRunDetailString(value: unknown, maxLength = 400): string | undefined {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trimEnd();
}

function sanitizeRalphRunDetails(details?: RalphRunDetails | null): RalphRunDetails | null {
  if (!details) return null;

  const sanitized: RalphRunDetails = {};
  const reasonCode = sanitizeRunDetailString(details.reasonCode, 120);
  const errorCode = sanitizeRunDetailString(details.errorCode, 120);
  const escalationType = sanitizeRunDetailString(details.escalationType, 120);
  const prUrl = sanitizeRunDetailString(details.prUrl, 500);
  const completionKind = details.completionKind === "verified" ? "verified" : details.completionKind === "pr" ? "pr" : undefined;

  if (reasonCode) sanitized.reasonCode = reasonCode;
  if (errorCode) sanitized.errorCode = errorCode;
  if (escalationType) sanitized.escalationType = escalationType;
  if (prUrl) sanitized.prUrl = prUrl;
  if (completionKind) sanitized.completionKind = completionKind;
  if (details.watchdogTimeout) sanitized.watchdogTimeout = true;

  return Object.keys(sanitized).length ? sanitized : null;
}

function parseJsonArray(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function assertGateName(value: string): GateName {
  if (GATE_NAMES.includes(value as GateName)) return value as GateName;
  throw new Error(`Unsupported gate name: ${value}`);
}

function assertGateStatus(value: string): GateStatus {
  if (GATE_STATUSES.includes(value as GateStatus)) return value as GateStatus;
  throw new Error(`Unsupported gate status: ${value}`);
}

function assertGateArtifactKind(value: string): GateArtifactKind {
  if (GATE_ARTIFACT_KINDS.includes(value as GateArtifactKind)) return value as GateArtifactKind;
  throw new Error(`Unsupported gate artifact kind: ${value}`);
}

function sanitizeOptionalText(
  value: string | null | undefined,
  maxLength: number
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength).trimEnd();
}

function redactAndBoundArtifact(value: string): {
  content: string;
  truncated: boolean;
  originalChars: number;
  originalLines: number;
} {
  const raw = String(value ?? "");
  const originalChars = raw.length;
  const originalLines = raw ? raw.split("\n").length : 0;
  let content = redactSensitiveText(raw);
  let truncated = false;

  if (content.length > ARTIFACT_MAX_CHARS) {
    content = content.slice(content.length - ARTIFACT_MAX_CHARS);
    truncated = true;
  }

  const lines = content.split("\n");
  if (lines.length > ARTIFACT_MAX_LINES) {
    content = lines.slice(lines.length - ARTIFACT_MAX_LINES).join("\n");
    truncated = true;
  }

  return { content, truncated, originalChars, originalLines };
}

function requireDb(): Database {
  if (!db) {
    throw new Error("State DB not initialized. Call initStateDb() at startup.");
  }
  return db;
}

function ensureSchema(database: Database): void {
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA synchronous = NORMAL;");
  database.exec("PRAGMA foreign_keys = ON;");

  database.exec(
    "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
  );

  const existing = database
    .query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;

  const existingVersion = existing?.value ? Number(existing.value) : null;
  if (existingVersion && existingVersion > SCHEMA_VERSION) {
    const schemaLabel = existing?.value ?? "unknown";
    throw new Error(
      `Unsupported state.sqlite schema_version=${schemaLabel}; expected ${SCHEMA_VERSION}`
    );
  }

  const tableExists = (name: string): boolean => {
    const row = database
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name")
      .get({ $name: name }) as { name?: string } | undefined;
    return row?.name === name;
  };

  if (existingVersion && existingVersion < SCHEMA_VERSION) {
    database.transaction(() => {
      if (existingVersion < 3) {
        database.exec("ALTER TABLE tasks ADD COLUMN worker_id TEXT");
        database.exec("ALTER TABLE tasks ADD COLUMN repo_slot TEXT");
      }
      if (existingVersion < 4) {
        database.exec("ALTER TABLE issues ADD COLUMN github_node_id TEXT");
        database.exec("ALTER TABLE issues ADD COLUMN github_updated_at TEXT");
      }
      if (existingVersion < 5) {
        database.exec(
          "CREATE TABLE IF NOT EXISTS repo_github_issue_sync (repo_id INTEGER PRIMARY KEY, last_sync_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
        );
      }
      if (existingVersion < 6) {
        database.exec("ALTER TABLE tasks ADD COLUMN daemon_id TEXT");
        database.exec("ALTER TABLE tasks ADD COLUMN heartbeat_at TEXT");
        database.exec(
          "UPDATE tasks SET task_path = 'github:' || (SELECT name FROM repos r WHERE r.id = tasks.repo_id) || '#' || tasks.issue_number " +
            "WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL"
        );
        database.exec(
          "DELETE FROM tasks WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL AND rowid NOT IN (" +
            "SELECT MAX(rowid) FROM tasks WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL GROUP BY repo_id, issue_number" +
            ")"
        );
      }
      if (existingVersion < 7) {
        database.exec(
          "CREATE TABLE IF NOT EXISTS repo_github_done_reconcile_cursor (repo_id INTEGER PRIMARY KEY, last_merged_at TEXT NOT NULL, last_pr_number INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
        );
      }
      if (existingVersion < 8) {
        database.exec("ALTER TABLE tasks ADD COLUMN session_events_path TEXT");
      }
      if (existingVersion < 14) {
        database.exec(
          "CREATE TABLE IF NOT EXISTS repo_github_issue_sync_bootstrap_cursor (repo_id INTEGER PRIMARY KEY, next_url TEXT NOT NULL, high_watermark_updated_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
        );
      }
      if (existingVersion < 9) {
        database.exec(
          "CREATE TABLE IF NOT EXISTS issue_escalation_comment_checks (" +
            "issue_id INTEGER PRIMARY KEY, " +
            "last_checked_at TEXT NOT NULL, " +
            "last_seen_updated_at TEXT, " +
            "last_resolved_comment_id INTEGER, " +
            "last_resolved_comment_at TEXT, " +
            "FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE" +
            ")"
        );
        database.exec(`
          CREATE TABLE IF NOT EXISTS ralph_runs (
            run_id TEXT PRIMARY KEY,
            repo_id INTEGER NOT NULL,
            issue_number INTEGER,
            task_path TEXT,
            attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('process', 'resume')),
            started_at TEXT NOT NULL,
            completed_at TEXT,
            outcome TEXT CHECK (outcome IN ('success', 'throttled', 'escalated', 'failed') OR outcome IS NULL),
            details_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS ralph_run_sessions (
            run_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            first_step_title TEXT,
            last_step_title TEXT,
            first_agent TEXT,
            last_agent TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(run_id, session_id),
            FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_ralph_run_sessions_session_id
            ON ralph_run_sessions(session_id);
          CREATE INDEX IF NOT EXISTS idx_ralph_runs_repo_issue_started
            ON ralph_runs(repo_id, issue_number, started_at);
        `);
      }
      if (existingVersion < 10) {
        if (tableExists("repos")) {
          try {
            database.exec("ALTER TABLE repos ADD COLUMN label_write_blocked_until_ms INTEGER");
          } catch {}
          try {
            database.exec("ALTER TABLE repos ADD COLUMN label_write_last_error TEXT");
          } catch {}
        }
        if (tableExists("tasks")) {
          try {
            database.exec("ALTER TABLE tasks ADD COLUMN released_at_ms INTEGER");
          } catch {}
          try {
            database.exec("ALTER TABLE tasks ADD COLUMN released_reason TEXT");
          } catch {}
        }

        database.exec(`
          CREATE TABLE IF NOT EXISTS ralph_run_gate_results (
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
          CREATE TABLE IF NOT EXISTS ralph_run_gate_artifacts (
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
          CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
            ON ralph_run_gate_results(repo_id, issue_number, updated_at);
          CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
            ON ralph_run_gate_results(repo_id, pr_number);
          CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
            ON ralph_run_gate_artifacts(run_id);
          CREATE TABLE IF NOT EXISTS alerts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_id INTEGER NOT NULL,
            target_type TEXT NOT NULL,
            target_number INTEGER NOT NULL,
            kind TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            summary TEXT NOT NULL,
            details TEXT,
            first_seen_at TEXT NOT NULL,
            last_seen_at TEXT NOT NULL,
            count INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE,
            UNIQUE(repo_id, target_type, target_number, kind, fingerprint)
          );
          CREATE TABLE IF NOT EXISTS alert_deliveries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            alert_id INTEGER NOT NULL,
            channel TEXT NOT NULL,
            marker_id TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_number INTEGER NOT NULL,
            status TEXT NOT NULL,
            comment_url TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_attempt_at TEXT NOT NULL,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
            UNIQUE(alert_id, channel, marker_id)
          );
          CREATE INDEX IF NOT EXISTS idx_alerts_repo_target ON alerts(repo_id, target_type, target_number, last_seen_at);
          CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_channel ON alert_deliveries(alert_id, channel);
          CREATE INDEX IF NOT EXISTS idx_alert_deliveries_target ON alert_deliveries(target_type, target_number, status);
        `);
        try {
          database.exec("ALTER TABLE issue_escalation_comment_checks ADD COLUMN last_resolved_comment_id INTEGER");
        } catch {}
        try {
          database.exec("ALTER TABLE issue_escalation_comment_checks ADD COLUMN last_resolved_comment_at TEXT");
        } catch {}
      }
      if (existingVersion < 11) {
        try {
          database.exec("ALTER TABLE alert_deliveries ADD COLUMN comment_id INTEGER");
        } catch {}
      }

      if (existingVersion < 12) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS ralph_run_session_token_totals (
            run_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            tokens_input INTEGER,
            tokens_output INTEGER,
            tokens_reasoning INTEGER,
            tokens_total INTEGER,
            quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'unreadable', 'timeout', 'error')),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(run_id, session_id),
            FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_ralph_run_session_token_totals_session
            ON ralph_run_session_token_totals(session_id);

          CREATE TABLE IF NOT EXISTS ralph_run_token_totals (
            run_id TEXT PRIMARY KEY,
            tokens_total INTEGER,
            tokens_complete INTEGER NOT NULL DEFAULT 0,
            session_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
          );
        `);
      }
      if (existingVersion < 13) {
        database.exec(`
          CREATE TABLE IF NOT EXISTS parent_verification_state (
            repo_id INTEGER NOT NULL,
            issue_number INTEGER NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete')),
            pending_at_ms INTEGER,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            last_attempt_at_ms INTEGER,
            next_attempt_at_ms INTEGER,
            outcome TEXT,
            outcome_details TEXT,
            updated_at_ms INTEGER NOT NULL,
            PRIMARY KEY(repo_id, issue_number),
            FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_parent_verification_state_repo_status
            ON parent_verification_state(repo_id, status, updated_at_ms);

          CREATE TABLE IF NOT EXISTS ralph_run_metrics (
            run_id TEXT PRIMARY KEY,
            wall_time_ms INTEGER,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            tool_time_ms INTEGER,
            anomaly_count INTEGER NOT NULL DEFAULT 0,
            anomaly_recent_burst INTEGER NOT NULL DEFAULT 0,
            tokens_total REAL,
            tokens_complete INTEGER NOT NULL DEFAULT 0,
            event_count INTEGER NOT NULL DEFAULT 0,
            parse_error_count INTEGER NOT NULL DEFAULT 0,
            quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'partial', 'too_large', 'timeout', 'error')),
            computed_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS ralph_run_step_metrics (
            run_id TEXT NOT NULL,
            step_title TEXT NOT NULL,
            wall_time_ms INTEGER,
            tool_call_count INTEGER NOT NULL DEFAULT 0,
            tool_time_ms INTEGER,
            anomaly_count INTEGER NOT NULL DEFAULT 0,
            anomaly_recent_burst INTEGER NOT NULL DEFAULT 0,
            tokens_total REAL,
            event_count INTEGER NOT NULL DEFAULT 0,
            parse_error_count INTEGER NOT NULL DEFAULT 0,
            quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'partial', 'too_large', 'timeout', 'error')),
            computed_at TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY(run_id, step_title),
            FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_ralph_run_step_metrics_run
            ON ralph_run_step_metrics(run_id);
          CREATE INDEX IF NOT EXISTS idx_ralph_run_metrics_quality
            ON ralph_run_metrics(quality);
        `);
      }
    })();
  }

  database.exec(
    `INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );

  database.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      local_path TEXT,
      bot_branch TEXT,
      label_write_blocked_until_ms INTEGER,
      label_write_last_error TEXT,
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
      github_node_id TEXT,
      github_updated_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo_id, number),
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS issue_labels (
      issue_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(issue_id, name),
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS parent_verification_state (
      repo_id INTEGER NOT NULL,
      issue_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete')),
      pending_at_ms INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at_ms INTEGER,
      next_attempt_at_ms INTEGER,
      outcome TEXT,
      outcome_details TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(repo_id, issue_number),
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_parent_verification_state_repo_status
      ON parent_verification_state(repo_id, status, updated_at_ms);

    CREATE TABLE IF NOT EXISTS issue_escalation_comment_checks (
      issue_id INTEGER PRIMARY KEY,
      last_checked_at TEXT NOT NULL,
      last_seen_updated_at TEXT,
      last_resolved_comment_id INTEGER,
      last_resolved_comment_at TEXT,
      FOREIGN KEY(issue_id) REFERENCES issues(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      issue_number INTEGER,
      task_path TEXT NOT NULL,
      task_name TEXT,
      status TEXT,
      session_id TEXT,
      session_events_path TEXT,
      worktree_path TEXT,
      worker_id TEXT,
      repo_slot TEXT,
      daemon_id TEXT,
      heartbeat_at TEXT,
      released_at_ms INTEGER,
      released_reason TEXT,
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

    CREATE TABLE IF NOT EXISTS repo_github_issue_sync (
      repo_id INTEGER PRIMARY KEY,
      last_sync_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repo_github_issue_sync_bootstrap_cursor (
      repo_id INTEGER PRIMARY KEY,
      next_url TEXT NOT NULL,
      high_watermark_updated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repo_github_done_reconcile_cursor (
      repo_id INTEGER PRIMARY KEY,
      last_merged_at TEXT NOT NULL,
      last_pr_number INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS ralph_runs (
      run_id TEXT PRIMARY KEY,
      repo_id INTEGER NOT NULL,
      issue_number INTEGER,
      task_path TEXT,
      attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('process', 'resume')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT CHECK (outcome IN ('success', 'throttled', 'escalated', 'failed') OR outcome IS NULL),
      details_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ralph_run_sessions (
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      first_step_title TEXT,
      last_step_title TEXT,
      first_agent TEXT,
      last_agent TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, session_id),
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ralph_run_session_token_totals (
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_total INTEGER,
      quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'unreadable', 'timeout', 'error')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, session_id),
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ralph_run_token_totals (
      run_id TEXT PRIMARY KEY,
      tokens_total INTEGER,
      tokens_complete INTEGER NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ralph_run_metrics (
      run_id TEXT PRIMARY KEY,
      wall_time_ms INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_time_ms INTEGER,
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      anomaly_recent_burst INTEGER NOT NULL DEFAULT 0,
      tokens_total REAL,
      tokens_complete INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      parse_error_count INTEGER NOT NULL DEFAULT 0,
      quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'partial', 'too_large', 'timeout', 'error')),
      computed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS ralph_run_step_metrics (
      run_id TEXT NOT NULL,
      step_title TEXT NOT NULL,
      wall_time_ms INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      tool_time_ms INTEGER,
      anomaly_count INTEGER NOT NULL DEFAULT 0,
      anomaly_recent_burst INTEGER NOT NULL DEFAULT 0,
      tokens_total REAL,
      event_count INTEGER NOT NULL DEFAULT 0,
      parse_error_count INTEGER NOT NULL DEFAULT 0,
      quality TEXT NOT NULL CHECK (quality IN ('ok', 'missing', 'partial', 'too_large', 'timeout', 'error')),
      computed_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, step_title),
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ralph_run_step_metrics_run
      ON ralph_run_step_metrics(run_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_metrics_quality
      ON ralph_run_metrics(quality);

    CREATE TABLE IF NOT EXISTS ralph_run_gate_results (
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

    CREATE TABLE IF NOT EXISTS ralph_run_gate_artifacts (
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

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      target_type TEXT NOT NULL,
      target_number INTEGER NOT NULL,
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      summary TEXT NOT NULL,
      details TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE,
      UNIQUE(repo_id, target_type, target_number, kind, fingerprint)
    );

    CREATE TABLE IF NOT EXISTS alert_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      marker_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      comment_id INTEGER,
      comment_url TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(alert_id) REFERENCES alerts(id) ON DELETE CASCADE,
      UNIQUE(alert_id, channel, marker_id)
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_repo_status ON tasks(repo_id, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_issue ON tasks(repo_id, issue_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_repo_issue_unique
      ON tasks(repo_id, issue_number)
      WHERE issue_number IS NOT NULL AND task_path LIKE 'github:%';
    CREATE INDEX IF NOT EXISTS idx_issues_repo_github_updated_at ON issues(repo_id, github_updated_at);
    CREATE INDEX IF NOT EXISTS idx_issue_labels_issue_id ON issue_labels(issue_id);
    CREATE INDEX IF NOT EXISTS idx_rollup_batches_repo_status ON rollup_batches(repo_id, bot_branch, status);
    CREATE INDEX IF NOT EXISTS idx_rollup_batch_prs_batch ON rollup_batch_prs(batch_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_sessions_session_id ON ralph_run_sessions(session_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_session_token_totals_session
      ON ralph_run_session_token_totals(session_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_runs_repo_issue_started ON ralph_runs(repo_id, issue_number, started_at);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
      ON ralph_run_gate_results(repo_id, issue_number, updated_at);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
      ON ralph_run_gate_results(repo_id, pr_number);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
      ON ralph_run_gate_artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_repo_target ON alerts(repo_id, target_type, target_number, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_channel ON alert_deliveries(alert_id, channel);
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_target ON alert_deliveries(target_type, target_number, status);
  `);
}

export function initStateDb(): void {
  const stateDbPath = getRalphStateDbPath();
  if (db) {
    if (dbPath === stateDbPath) return;
    db.close();
    db = null;
  }
  if (!process.env.RALPH_STATE_DB_PATH?.trim()) {
    mkdirSync(getRalphHomeDir(), { recursive: true });
  }
  mkdirSync(dirname(stateDbPath), { recursive: true });

  const database = new Database(stateDbPath);
  ensureSchema(database);

  db = database;
  dbPath = stateDbPath;
}

export function isStateDbInitialized(): boolean {
  return Boolean(db);
}

export function closeStateDbForTests(): void {
  if (!db) return;
  db.close();
  db = null;
  dbPath = null;
}

function parseIssueNumber(issueRef: string): number | null {
  const match = issueRef.match(/#(\d+)$/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

function upsertRepo(params: { repo: string; repoPath?: string; botBranch?: string; at?: string }): number {
  const database = requireDb();
  const at = params.at ?? nowIso();

  database
    .query(
      `INSERT INTO repos(name, local_path, bot_branch, created_at, updated_at)
       VALUES ($name, $local_path, $bot_branch, $created_at, $updated_at)
       ON CONFLICT(name) DO UPDATE SET
         local_path = COALESCE(excluded.local_path, repos.local_path),
         bot_branch = COALESCE(excluded.bot_branch, repos.bot_branch),
         updated_at = excluded.updated_at`
    )
    .run({
      $name: params.repo,
      $local_path: params.repoPath ?? null,
      $bot_branch: params.botBranch ?? null,
      $created_at: at,
      $updated_at: at,
    });

  const row = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: params.repo,
  }) as { id?: number } | undefined;

  if (!row?.id) {
    throw new Error(`Failed to resolve repo id for ${params.repo}`);
  }

  return row.id;
}

export function recordRepoSync(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  lastSyncAt?: string;
}): void {
  const database = requireDb();
  const at = params.lastSyncAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });

  database
    .query(
      `INSERT INTO repo_sync(repo_id, last_sync_at)
       VALUES ($repo_id, $last_sync_at)
       ON CONFLICT(repo_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`
    )
    .run({ $repo_id: repoId, $last_sync_at: at });
}

export function recordRepoGithubIssueSync(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  lastSyncAt?: string;
}): void {
  const database = requireDb();
  const at = params.lastSyncAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });

  database
    .query(
      `INSERT INTO repo_github_issue_sync(repo_id, last_sync_at)
       VALUES ($repo_id, $last_sync_at)
       ON CONFLICT(repo_id) DO UPDATE SET last_sync_at = excluded.last_sync_at`
    )
    .run({ $repo_id: repoId, $last_sync_at: at });
}

export function getRepoGithubIssueLastSyncAt(repo: string): string | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT rs.last_sync_at as last_sync_at
       FROM repo_github_issue_sync rs
       JOIN repos r ON r.id = rs.repo_id
       WHERE r.name = $name`
    )
    .get({ $name: repo }) as { last_sync_at?: string } | undefined;

  return typeof row?.last_sync_at === "string" ? row.last_sync_at : null;
}

export type RepoGithubIssueBootstrapCursor = {
  nextUrl: string;
  highWatermarkUpdatedAt: string;
  updatedAt: string;
};

export function getRepoGithubIssueBootstrapCursor(repo: string): RepoGithubIssueBootstrapCursor | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT bc.next_url as next_url, bc.high_watermark_updated_at as high_watermark_updated_at, bc.updated_at as updated_at
       FROM repo_github_issue_sync_bootstrap_cursor bc
       JOIN repos r ON r.id = bc.repo_id
       WHERE r.name = $name`
    )
    .get({ $name: repo }) as
    | { next_url?: string; high_watermark_updated_at?: string; updated_at?: string }
    | undefined;

  if (!row?.next_url || !row?.high_watermark_updated_at || !row?.updated_at) return null;
  return {
    nextUrl: row.next_url,
    highWatermarkUpdatedAt: row.high_watermark_updated_at,
    updatedAt: row.updated_at,
  };
}

export function recordRepoGithubIssueBootstrapCursor(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  nextUrl: string;
  highWatermarkUpdatedAt: string;
  updatedAt?: string;
}): void {
  const database = requireDb();
  const at = params.updatedAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });

  database
    .query(
      `INSERT INTO repo_github_issue_sync_bootstrap_cursor(repo_id, next_url, high_watermark_updated_at, updated_at)
       VALUES ($repo_id, $next_url, $high_watermark_updated_at, $updated_at)
       ON CONFLICT(repo_id) DO UPDATE SET
         next_url = excluded.next_url,
         high_watermark_updated_at = excluded.high_watermark_updated_at,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $next_url: params.nextUrl,
      $high_watermark_updated_at: params.highWatermarkUpdatedAt,
      $updated_at: at,
    });
}

export function clearRepoGithubIssueBootstrapCursor(params: { repo: string }): void {
  const database = requireDb();
  database
    .query(
      `DELETE FROM repo_github_issue_sync_bootstrap_cursor
       WHERE repo_id = (SELECT id FROM repos WHERE name = $name)`
    )
    .run({ $name: params.repo });
}

export type RepoGithubDoneCursor = { lastMergedAt: string; lastPrNumber: number };

export function getRepoGithubDoneReconcileCursor(repo: string): RepoGithubDoneCursor | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT dc.last_merged_at as last_merged_at, dc.last_pr_number as last_pr_number
       FROM repo_github_done_reconcile_cursor dc
       JOIN repos r ON r.id = dc.repo_id
       WHERE r.name = $name`
    )
    .get({ $name: repo }) as { last_merged_at?: string; last_pr_number?: number } | undefined;

  if (!row?.last_merged_at || typeof row.last_pr_number !== "number") return null;
  return { lastMergedAt: row.last_merged_at, lastPrNumber: row.last_pr_number };
}

export function recordRepoGithubDoneReconcileCursor(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  lastMergedAt: string;
  lastPrNumber: number;
  updatedAt?: string;
}): void {
  const database = requireDb();
  const at = params.updatedAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });

  database
    .query(
      `INSERT INTO repo_github_done_reconcile_cursor(repo_id, last_merged_at, last_pr_number, updated_at)
       VALUES ($repo_id, $last_merged_at, $last_pr_number, $updated_at)
       ON CONFLICT(repo_id) DO UPDATE SET
         last_merged_at = excluded.last_merged_at,
         last_pr_number = excluded.last_pr_number,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $last_merged_at: params.lastMergedAt,
      $last_pr_number: params.lastPrNumber,
      $updated_at: at,
    });
}

export function recordAlertOccurrence(params: {
  repo: string;
  targetType: AlertTargetType;
  targetNumber: number;
  kind: AlertKind;
  fingerprint: string;
  summary: string;
  details?: string | null;
  at?: string;
}): AlertRecord {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });

  database
    .query(
      `INSERT INTO alerts(
         repo_id,
         target_type,
         target_number,
         kind,
         fingerprint,
         summary,
         details,
         first_seen_at,
         last_seen_at,
         count,
         created_at,
         updated_at
       ) VALUES (
         $repo_id,
         $target_type,
         $target_number,
         $kind,
         $fingerprint,
         $summary,
         $details,
         $first_seen_at,
         $last_seen_at,
         1,
         $created_at,
         $updated_at
       )
       ON CONFLICT(repo_id, target_type, target_number, kind, fingerprint)
       DO UPDATE SET
         summary = excluded.summary,
         details = excluded.details,
         last_seen_at = excluded.last_seen_at,
         count = alerts.count + 1,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $target_type: params.targetType,
      $target_number: params.targetNumber,
      $kind: params.kind,
      $fingerprint: params.fingerprint,
      $summary: params.summary,
      $details: params.details ?? null,
      $first_seen_at: at,
      $last_seen_at: at,
      $created_at: at,
      $updated_at: at,
    });

  const row = database
    .query(
      `SELECT id, summary, details, count, first_seen_at, last_seen_at
       FROM alerts
       WHERE repo_id = $repo_id AND target_type = $target_type AND target_number = $target_number
         AND kind = $kind AND fingerprint = $fingerprint`
    )
    .get({
      $repo_id: repoId,
      $target_type: params.targetType,
      $target_number: params.targetNumber,
      $kind: params.kind,
      $fingerprint: params.fingerprint,
    }) as {
    id?: number;
    summary?: string;
    details?: string | null;
    count?: number;
    first_seen_at?: string;
    last_seen_at?: string;
  } | undefined;

  if (!row?.id) {
    throw new Error(`Failed to record alert for ${params.repo} ${params.targetType} ${params.targetNumber}`);
  }

  return {
    id: row.id,
    repo: params.repo,
    targetType: params.targetType,
    targetNumber: params.targetNumber,
    kind: params.kind,
    fingerprint: params.fingerprint,
    summary: row.summary ?? params.summary,
    details: row.details ?? null,
    count: typeof row.count === "number" ? row.count : 1,
    firstSeenAt: row.first_seen_at ?? at,
    lastSeenAt: row.last_seen_at ?? at,
  };
}

export function getAlertDelivery(params: {
  alertId: number;
  channel: string;
  markerId: string;
}): AlertDeliveryRecord | null {
  const database = requireDb();
  const row = database
    .query(
       `SELECT alert_id, channel, marker_id, target_type, target_number, status, comment_id, comment_url, attempts, last_attempt_at, last_error
        FROM alert_deliveries
        WHERE alert_id = $alert_id AND channel = $channel AND marker_id = $marker_id`
    )
    .get({
      $alert_id: params.alertId,
      $channel: params.channel,
      $marker_id: params.markerId,
    }) as {
    alert_id?: number;
    channel?: string;
    marker_id?: string;
    target_type?: AlertTargetType;
    target_number?: number;
    status?: AlertDeliveryStatus;
    comment_id?: number | null;
    comment_url?: string | null;
    attempts?: number;
    last_attempt_at?: string;
    last_error?: string | null;
  } | undefined;

  if (!row?.alert_id) return null;
  return {
    alertId: row.alert_id,
    channel: row.channel ?? params.channel,
    markerId: row.marker_id ?? params.markerId,
    targetType: row.target_type ?? "issue",
    targetNumber: typeof row.target_number === "number" ? row.target_number : 0,
    status: (row.status as AlertDeliveryStatus) ?? "failed",
    commentId: typeof row.comment_id === "number" ? row.comment_id : null,
    commentUrl: row.comment_url ?? null,
    attempts: typeof row.attempts === "number" ? row.attempts : 0,
    lastAttemptAt: row.last_attempt_at ?? "",
    lastError: row.last_error ?? null,
  };
}

export function recordAlertDeliveryAttempt(params: {
  alertId: number;
  channel: string;
  markerId: string;
  targetType: AlertTargetType;
  targetNumber: number;
  status: AlertDeliveryStatus;
  commentId?: number | null;
  commentUrl?: string | null;
  error?: string | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();

  database
    .query(
      `INSERT INTO alert_deliveries(
         alert_id,
         channel,
         marker_id,
         target_type,
         target_number,
         status,
         comment_id,
         comment_url,
         attempts,
         last_attempt_at,
         last_error,
         created_at,
         updated_at
       ) VALUES (
         $alert_id,
         $channel,
         $marker_id,
         $target_type,
         $target_number,
         $status,
         $comment_id,
         $comment_url,
         1,
         $last_attempt_at,
         $last_error,
         $created_at,
         $updated_at
       )
       ON CONFLICT(alert_id, channel, marker_id)
       DO UPDATE SET
         status = excluded.status,
         comment_id = COALESCE(excluded.comment_id, alert_deliveries.comment_id),
         comment_url = COALESCE(excluded.comment_url, alert_deliveries.comment_url),
         attempts = alert_deliveries.attempts + 1,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    )
    .run({
      $alert_id: params.alertId,
      $channel: params.channel,
      $marker_id: params.markerId,
      $target_type: params.targetType,
      $target_number: params.targetNumber,
      $status: params.status,
       $comment_id: params.commentId ?? null,
       $comment_url: params.commentUrl ?? null,
      $last_attempt_at: at,
      $last_error: params.error ?? null,
      $created_at: at,
      $updated_at: at,
    });
}

export function listIssueAlertSummaries(params: { repo: string; issueNumbers: number[] }): IssueAlertSummary[] {
  const database = requireDb();
  if (params.issueNumbers.length === 0) return [];

  const repoRow = database
    .query("SELECT id FROM repos WHERE name = $name")
    .get({ $name: params.repo }) as { id?: number } | undefined;
  const repoId = repoRow?.id;
  if (!repoId) return [];

  const placeholders = params.issueNumbers.map((_, idx) => `$issue${idx}`);
  const values: Record<string, number> = { $repo_id: repoId };
  params.issueNumbers.forEach((num, idx) => {
    values[`$issue${idx}`] = num;
  });

  const rows = database
    .query(
      `WITH issue_list(issue_number) AS (VALUES ${placeholders.map((p) => `(${p})`).join(", ")})
       SELECT
         issue_list.issue_number as issue_number,
         COALESCE(SUM(a.count), 0) as total_count,
         (
           SELECT a2.summary FROM alerts a2
           WHERE a2.repo_id = $repo_id
             AND a2.target_type = 'issue'
             AND a2.target_number = issue_list.issue_number
             AND a2.kind = 'error'
           ORDER BY a2.last_seen_at DESC
           LIMIT 1
         ) as latest_summary,
         (
           SELECT a2.last_seen_at FROM alerts a2
           WHERE a2.repo_id = $repo_id
             AND a2.target_type = 'issue'
             AND a2.target_number = issue_list.issue_number
             AND a2.kind = 'error'
           ORDER BY a2.last_seen_at DESC
           LIMIT 1
         ) as latest_at,
         (
           SELECT d.comment_url FROM alert_deliveries d
           JOIN alerts a3 ON a3.id = d.alert_id
           WHERE a3.repo_id = $repo_id
             AND a3.target_type = 'issue'
             AND a3.target_number = issue_list.issue_number
             AND a3.kind = 'error'
             AND d.channel = 'github-issue-comment'
             AND d.status = 'success'
           ORDER BY d.updated_at DESC
           LIMIT 1
         ) as latest_comment_url
       FROM issue_list
       LEFT JOIN alerts a
         ON a.repo_id = $repo_id
         AND a.target_type = 'issue'
         AND a.target_number = issue_list.issue_number
         AND a.kind = 'error'
       GROUP BY issue_list.issue_number`
    )
    .all(values) as Array<{
    issue_number?: number;
    total_count?: number;
    latest_summary?: string | null;
    latest_at?: string | null;
    latest_comment_url?: string | null;
  }>;

  return rows
    .map((row) => ({
      repo: params.repo,
      issueNumber: typeof row.issue_number === "number" ? row.issue_number : 0,
      totalCount: typeof row.total_count === "number" ? row.total_count : 0,
      latestSummary: row.latest_summary ?? null,
      latestAt: row.latest_at ?? null,
      latestCommentUrl: row.latest_comment_url ?? null,
    }))
    .filter((row) => row.issueNumber > 0);
}

export function hasIssueSnapshot(repo: string, issue: string): boolean {
  const database = requireDb();
  const issueNumber = parseIssueNumber(issue);
  if (issueNumber === null) return false;

  const repoRow = database
    .query("SELECT id FROM repos WHERE name = $name")
    .get({ $name: repo }) as { id?: number } | undefined;

  if (!repoRow?.id) return false;

  const issueRow = database
    .query("SELECT id FROM issues WHERE repo_id = $repo_id AND number = $number")
    .get({ $repo_id: repoRow.id, $number: issueNumber }) as { id?: number } | undefined;

  return Boolean(issueRow?.id);
}

export function runInStateTransaction(run: () => void): void {
  const database = requireDb();
  database.transaction(run)();
}

export function recordIssueSnapshot(input: {
  repo: string;
  issue: string;
  title?: string;
  state?: string;
  url?: string;
  githubNodeId?: string;
  githubUpdatedAt?: string;
  at?: string;
}): void {
  const database = requireDb();
  const at = input.at ?? nowIso();
  const repoId = upsertRepo({ repo: input.repo, at });
  const issueNumber = parseIssueNumber(input.issue);

  if (issueNumber === null) return;

  database
    .query(
      `INSERT INTO issues(
         repo_id, number, title, state, url, github_node_id, github_updated_at, created_at, updated_at
       )
       VALUES (
         $repo_id, $number, $title, $state, $url, $github_node_id, $github_updated_at, $created_at, $updated_at
       )
       ON CONFLICT(repo_id, number) DO UPDATE SET
          title = COALESCE(excluded.title, issues.title),
          state = COALESCE(excluded.state, issues.state),
          url = COALESCE(excluded.url, issues.url),
          github_node_id = COALESCE(excluded.github_node_id, issues.github_node_id),
          github_updated_at = COALESCE(excluded.github_updated_at, issues.github_updated_at),
          updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $number: issueNumber,
      $title: input.title ?? null,
      $state: input.state ?? null,
      $url: input.url ?? null,
      $github_node_id: input.githubNodeId ?? null,
      $github_updated_at: input.githubUpdatedAt ?? null,
      $created_at: at,
      $updated_at: at,
    });
}

export function recordIssueLabelsSnapshot(input: {
  repo: string;
  issue: string;
  labels: string[];
  at?: string;
}): void {
  const database = requireDb();
  const at = input.at ?? nowIso();
  const repoId = upsertRepo({ repo: input.repo, at });
  const issueNumber = parseIssueNumber(input.issue);

  if (issueNumber === null) return;

  database.transaction(() => {
    database
      .query(
        `INSERT INTO issues(repo_id, number, created_at, updated_at)
         VALUES ($repo_id, $number, $created_at, $updated_at)
         ON CONFLICT(repo_id, number) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run({
        $repo_id: repoId,
        $number: issueNumber,
        $created_at: at,
        $updated_at: at,
      });

    const issueRow = database
      .query("SELECT id FROM issues WHERE repo_id = $repo_id AND number = $number")
      .get({ $repo_id: repoId, $number: issueNumber }) as { id?: number } | undefined;

    if (!issueRow?.id) {
      throw new Error(`Failed to resolve issue id for ${input.repo}#${issueNumber}`);
    }

    database.query("DELETE FROM issue_labels WHERE issue_id = $issue_id").run({ $issue_id: issueRow.id });

    for (const label of input.labels) {
      database
        .query(
          `INSERT INTO issue_labels(issue_id, name, created_at)
           VALUES ($issue_id, $name, $created_at)
           ON CONFLICT(issue_id, name) DO NOTHING`
        )
        .run({
          $issue_id: issueRow.id,
          $name: label,
          $created_at: at,
        });
    }
  })();
}

export function listIssuesWithAllLabels(params: {
  repo: string;
  labels: string[];
}): Array<{ repo: string; number: number }> {
  if (!params.labels.length) return [];

  const database = requireDb();
  const repoRow = database
    .query("SELECT id FROM repos WHERE name = $name")
    .get({ $name: params.repo }) as { id?: number } | undefined;
  if (!repoRow?.id) return [];

  const labelParams = params.labels.map((_, idx) => `$label_${idx}`);
  const labelChecks = params.labels
    .map((_, idx) => `SUM(CASE WHEN l.name = $label_${idx} THEN 1 ELSE 0 END) > 0`)
    .join(" AND ");

  const rows = database
    .query(
      `SELECT i.number as number
       FROM issues i
       JOIN issue_labels l ON l.issue_id = i.id
       WHERE i.repo_id = $repo_id AND l.name IN (${labelParams.join(", ")})
       GROUP BY i.id
       HAVING ${labelChecks}
       ORDER BY i.number`
    )
    .all({
      $repo_id: repoRow.id,
      ...Object.fromEntries(params.labels.map((label, idx) => [`$label_${idx}`, label])),
    }) as Array<{ number?: number }>;

  return rows
    .map((row) => row?.number)
    .filter((number): number is number => Number.isFinite(number))
    .map((number) => ({ repo: params.repo, number }));
}

export function recordTaskSnapshot(input: {
  repo: string;
  issue: string;
  taskPath: string;
  taskName?: string;
  status?: string;
  sessionId?: string;
  sessionEventsPath?: string;
  worktreePath?: string;
  workerId?: string;
  repoSlot?: string;
  daemonId?: string;
  heartbeatAt?: string;
  releasedAtMs?: number | null;
  releasedReason?: string | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = input.at ?? nowIso();
  const repoId = upsertRepo({ repo: input.repo, at });
  const issueNumber = parseIssueNumber(input.issue);
  const taskPath =
    issueNumber !== null && input.taskPath.startsWith("github:")
      ? `github:${input.repo}#${issueNumber}`
      : input.taskPath;
  const sessionEventsPath =
    input.sessionEventsPath ??
    (input.sessionId && isSafeSessionId(input.sessionId) ? getSessionEventsPath(input.sessionId) : null);

  if (issueNumber !== null) {
    database
      .query(
        `INSERT INTO issues(repo_id, number, created_at, updated_at)
         VALUES ($repo_id, $number, $created_at, $updated_at)
         ON CONFLICT(repo_id, number) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run({
        $repo_id: repoId,
        $number: issueNumber,
        $created_at: at,
        $updated_at: at,
      });
  }

  database
    .query(
      `INSERT INTO tasks(
         repo_id, issue_number, task_path, task_name, status, session_id, session_events_path, worktree_path, worker_id, repo_slot, daemon_id, heartbeat_at, released_at_ms, released_reason, created_at, updated_at
       ) VALUES (
          $repo_id, $issue_number, $task_path, $task_name, $status, $session_id, $session_events_path, $worktree_path, $worker_id, $repo_slot, $daemon_id, $heartbeat_at, $released_at_ms, $released_reason, $created_at, $updated_at
       )
       ON CONFLICT(repo_id, task_path) DO UPDATE SET
          issue_number = COALESCE(excluded.issue_number, tasks.issue_number),
          task_name = COALESCE(excluded.task_name, tasks.task_name),
          status = COALESCE(excluded.status, tasks.status),
          session_id = COALESCE(excluded.session_id, tasks.session_id),
          session_events_path = COALESCE(excluded.session_events_path, tasks.session_events_path),
          worktree_path = COALESCE(excluded.worktree_path, tasks.worktree_path),
          worker_id = COALESCE(excluded.worker_id, tasks.worker_id),
          repo_slot = COALESCE(excluded.repo_slot, tasks.repo_slot),
          daemon_id = COALESCE(excluded.daemon_id, tasks.daemon_id),
          heartbeat_at = COALESCE(excluded.heartbeat_at, tasks.heartbeat_at),
          released_at_ms = excluded.released_at_ms,
          released_reason = excluded.released_reason,
          updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $issue_number: issueNumber,
      $task_path: taskPath,
      $task_name: input.taskName ?? null,
      $status: input.status ?? null,
      $session_id: input.sessionId ?? null,
      $session_events_path: sessionEventsPath,
      $worktree_path: input.worktreePath ?? null,
      $worker_id: input.workerId ?? null,
      $repo_slot: input.repoSlot ?? null,
      $daemon_id: input.daemonId ?? null,
      $heartbeat_at: input.heartbeatAt ?? null,
      $released_at_ms: typeof input.releasedAtMs === "number" ? input.releasedAtMs : null,
      $released_reason: input.releasedReason ?? null,
      $created_at: at,
      $updated_at: at,
    });
}

export function releaseTaskSlot(params: {
  repo: string;
  issueNumber: number;
  taskPath?: string;
  releasedAtMs?: number;
  releasedReason?: string | null;
  status?: string;
}): boolean {
  const database = requireDb();
  const atIso = nowIso();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const taskPath = params.taskPath ?? `github:${params.repo}#${params.issueNumber}`;
  const releasedAtMs = typeof params.releasedAtMs === "number" ? params.releasedAtMs : Date.now();

  recordTaskSnapshot({
    repo: params.repo,
    issue: `${params.repo}#${params.issueNumber}`,
    taskPath,
    status: params.status ?? "queued",
    releasedAtMs,
    releasedReason: params.releasedReason ?? null,
    at: atIso,
  });

  const result = database
    .query(
      `UPDATE tasks
         SET status = COALESCE($status, status),
             repo_slot = NULL,
             worker_id = NULL,
             daemon_id = NULL,
             heartbeat_at = NULL,
             released_at_ms = $released_at_ms,
             released_reason = $released_reason,
             updated_at = $updated_at
       WHERE repo_id = $repo_id AND task_path = $task_path`
    )
    .run({
      $repo_id: repoId,
      $task_path: taskPath,
      $status: params.status ?? "queued",
      $released_at_ms: releasedAtMs,
      $released_reason: params.releasedReason ?? null,
      $updated_at: atIso,
    });

  return result.changes > 0;
}

export type RepoLabelWriteState = {
  repo: string;
  blockedUntilMs: number | null;
  lastError: string | null;
};

export function getRepoLabelWriteState(repo: string): RepoLabelWriteState {
  const database = requireDb();
  const row = database
    .query("SELECT label_write_blocked_until_ms as blocked_until_ms, label_write_last_error as last_error FROM repos WHERE name = $name")
    .get({ $name: repo }) as { blocked_until_ms?: number | null; last_error?: string | null } | undefined;

  return {
    repo,
    blockedUntilMs: typeof row?.blocked_until_ms === "number" ? row.blocked_until_ms : null,
    lastError: row?.last_error ?? null,
  };
}

export function setRepoLabelWriteState(params: {
  repo: string;
  blockedUntilMs: number | null;
  lastError?: string | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });

  database
    .query(
      `UPDATE repos
          SET label_write_blocked_until_ms = $blocked_until_ms,
              label_write_last_error = $last_error,
              updated_at = $updated_at
        WHERE id = $repo_id`
    )
    .run({
      $repo_id: repoId,
      $blocked_until_ms: params.blockedUntilMs,
      $last_error: params.lastError ?? null,
      $updated_at: at,
    });
}

export function listRepoLabelWriteStates(): RepoLabelWriteState[] {
  const database = requireDb();
  const rows = database
    .query(
      "SELECT name, label_write_blocked_until_ms as blocked_until_ms, label_write_last_error as last_error FROM repos"
    )
    .all() as Array<{ name?: string | null; blocked_until_ms?: number | null; last_error?: string | null }>;

  return rows
    .map((row) => {
      const repo = row?.name ?? "";
      if (!repo) return null;
      return {
        repo,
        blockedUntilMs: typeof row.blocked_until_ms === "number" ? row.blocked_until_ms : null,
        lastError: row.last_error ?? null,
      };
    })
    .filter((row): row is RepoLabelWriteState => Boolean(row));
}

export function createRalphRun(params: {
  repo: string;
  issue: string;
  taskPath: string;
  attemptKind: RalphRunAttemptKind;
  startedAt?: string;
}): string {
  const database = requireDb();
  const at = params.startedAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });
  const issueNumber = parseIssueNumber(params.issue);
  const runId = randomUUID();

  database
    .query(
      `INSERT INTO ralph_runs(
         run_id, repo_id, issue_number, task_path, attempt_kind, started_at, created_at, updated_at
       ) VALUES (
         $run_id, $repo_id, $issue_number, $task_path, $attempt_kind, $started_at, $created_at, $updated_at
       )`
    )
    .run({
      $run_id: runId,
      $repo_id: repoId,
      $issue_number: issueNumber,
      $task_path: params.taskPath,
      $attempt_kind: params.attemptKind,
      $started_at: at,
      $created_at: at,
      $updated_at: at,
    });

  return runId;
}

export function recordRalphRunSessionUse(params: {
  runId: string;
  sessionId: string;
  stepTitle?: string | null;
  agent?: string | null;
  at?: string;
}): void {
  if (!isSafeSessionId(params.sessionId)) return;

  const database = requireDb();
  const at = params.at ?? nowIso();
  const stepTitle = trimRunLabel(params.stepTitle ?? undefined, 200);
  const agent = trimRunLabel(params.agent ?? undefined, 120);

  database
    .query(
      `INSERT INTO ralph_run_sessions(
         run_id, session_id, first_seen_at, last_seen_at, first_step_title, last_step_title, first_agent, last_agent, created_at, updated_at
       ) VALUES (
         $run_id, $session_id, $first_seen_at, $last_seen_at, $first_step_title, $last_step_title, $first_agent, $last_agent, $created_at, $updated_at
       )
       ON CONFLICT(run_id, session_id) DO UPDATE SET
         first_seen_at = CASE
           WHEN ralph_run_sessions.first_seen_at <= excluded.first_seen_at
             THEN ralph_run_sessions.first_seen_at
           ELSE excluded.first_seen_at
         END,
         last_seen_at = CASE
           WHEN ralph_run_sessions.last_seen_at >= excluded.last_seen_at
             THEN ralph_run_sessions.last_seen_at
           ELSE excluded.last_seen_at
         END,
         first_step_title = COALESCE(ralph_run_sessions.first_step_title, excluded.first_step_title),
         last_step_title = COALESCE(excluded.last_step_title, ralph_run_sessions.last_step_title),
         first_agent = COALESCE(ralph_run_sessions.first_agent, excluded.first_agent),
         last_agent = COALESCE(excluded.last_agent, ralph_run_sessions.last_agent),
         updated_at = excluded.updated_at`
    )
    .run({
      $run_id: params.runId,
      $session_id: params.sessionId,
      $first_seen_at: at,
      $last_seen_at: at,
      $first_step_title: stepTitle,
      $last_step_title: stepTitle,
      $first_agent: agent,
      $last_agent: agent,
      $created_at: at,
      $updated_at: at,
    });
}

export function getLatestRunIdForSession(sessionId: string): string | null {
  const sid = sessionId?.trim();
  if (!sid) return null;

  const database = requireDb();
  const row = database
    .query(
      `SELECT run_id as run_id
       FROM ralph_run_sessions
       WHERE session_id = $session_id
       ORDER BY last_seen_at DESC
       LIMIT 1`
    )
    .get({ $session_id: sid }) as { run_id?: string } | undefined;

  return typeof row?.run_id === "string" && row.run_id ? row.run_id : null;
}

export function completeRalphRun(params: {
  runId: string;
  outcome: RalphRunOutcome;
  completedAt?: string;
  details?: RalphRunDetails | null;
}): void {
  const database = requireDb();
  const at = params.completedAt ?? nowIso();
  const sanitizedDetails = sanitizeRalphRunDetails(params.details ?? null);
  const detailsJson = sanitizedDetails ? JSON.stringify(sanitizedDetails) : null;

  database
    .query(
      `UPDATE ralph_runs
       SET completed_at = CASE WHEN completed_at IS NULL THEN $completed_at ELSE completed_at END,
           outcome = CASE WHEN outcome IS NULL THEN $outcome ELSE outcome END,
           details_json = CASE WHEN details_json IS NULL THEN $details_json ELSE details_json END,
           updated_at = $updated_at
       WHERE run_id = $run_id`
    )
    .run({
      $run_id: params.runId,
      $completed_at: at,
      $outcome: params.outcome,
      $details_json: detailsJson,
      $updated_at: at,
    });
}

type GateResultRow = {
  runId: string;
  gate: GateName;
  status: GateStatus;
  command: string | null;
  skipReason: string | null;
  url: string | null;
  prNumber: number | null;
  prUrl: string | null;
  repoId: number;
  issueNumber: number | null;
  taskPath: string | null;
  createdAt: string;
  updatedAt: string;
};

type GateArtifactRow = {
  id: number;
  runId: string;
  gate: GateName;
  kind: GateArtifactKind;
  content: string;
  truncated: boolean;
  originalChars: number | null;
  originalLines: number | null;
  createdAt: string;
  updatedAt: string;
};

export type RalphRunGateState = {
  results: GateResultRow[];
  artifacts: GateArtifactRow[];
};

function getRunMeta(runId: string): { repoId: number; issueNumber: number | null; taskPath: string | null } {
  const database = requireDb();
  const row = database
    .query("SELECT repo_id, issue_number, task_path FROM ralph_runs WHERE run_id = $run_id")
    .get({ $run_id: runId }) as { repo_id?: number; issue_number?: number | null; task_path?: string | null } | undefined;

  if (!row?.repo_id) {
    throw new Error(`Failed to resolve run metadata for run_id=${runId}`);
  }

  return {
    repoId: row.repo_id,
    issueNumber: typeof row.issue_number === "number" ? row.issue_number : null,
    taskPath: row.task_path ?? null,
  };
}

function getRepoIdByName(repo: string): number | null {
  const database = requireDb();
  const row = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: repo,
  }) as { id?: number } | undefined;
  return row?.id ?? null;
}

export function ensureRalphRunGateRows(params: { runId: string; at?: string }): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const meta = getRunMeta(params.runId);

  for (const gate of GATE_NAMES) {
    database
      .query(
        `INSERT INTO ralph_run_gate_results(
           run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
         ) VALUES (
           $run_id, $gate, $status, $repo_id, $issue_number, $task_path, $created_at, $updated_at
         )
         ON CONFLICT(run_id, gate) DO NOTHING`
      )
      .run({
        $run_id: params.runId,
        $gate: gate,
        $status: "pending",
        $repo_id: meta.repoId,
        $issue_number: meta.issueNumber,
        $task_path: meta.taskPath,
        $created_at: at,
        $updated_at: at,
      });
  }
}

export function upsertRalphRunGateResult(params: {
  runId: string;
  gate: GateName;
  status?: GateStatus;
  command?: string | null;
  skipReason?: string | null;
  url?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const meta = getRunMeta(params.runId);
  const gate = assertGateName(params.gate);

  if (params.status === null) {
    throw new Error("Gate status cannot be null");
  }

  const statusPatch = params.status ? assertGateStatus(params.status) : null;
  const statusInsert = statusPatch ?? "pending";
  const statusPatchFlag = statusPatch ? 1 : 0;

  const commandPatch = sanitizeOptionalText(params.command, 1000);
  const skipReasonPatch = sanitizeOptionalText(params.skipReason, 400);
  const urlPatch = sanitizeOptionalText(params.url, 500);
  const prUrlPatch = sanitizeOptionalText(params.prUrl, 500);

  const commandPatchFlag = commandPatch !== undefined ? 1 : 0;
  const skipReasonPatchFlag = skipReasonPatch !== undefined ? 1 : 0;
  const urlPatchFlag = urlPatch !== undefined ? 1 : 0;
  const prUrlPatchFlag = prUrlPatch !== undefined ? 1 : 0;

  let prNumberPatchFlag = 0;
  let prNumberValue: number | null = null;
  if (params.prNumber !== undefined) {
    prNumberPatchFlag = 1;
    prNumberValue =
      params.prNumber === null
        ? null
        : Number.isFinite(params.prNumber)
          ? params.prNumber
          : null;
  }

  database
    .query(
      `INSERT INTO ralph_run_gate_results(
         run_id, gate, status, command, skip_reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
       ) VALUES (
         $run_id, $gate, $status_insert, $command, $skip_reason, $url, $pr_number, $pr_url, $repo_id, $issue_number, $task_path, $created_at, $updated_at
       )
       ON CONFLICT(run_id, gate) DO UPDATE SET
         status = CASE WHEN $status_patch = 1 THEN $status_update ELSE ralph_run_gate_results.status END,
         command = CASE WHEN $command_patch = 1 THEN excluded.command ELSE ralph_run_gate_results.command END,
         skip_reason = CASE WHEN $skip_reason_patch = 1 THEN excluded.skip_reason ELSE ralph_run_gate_results.skip_reason END,
         url = CASE WHEN $url_patch = 1 THEN excluded.url ELSE ralph_run_gate_results.url END,
         pr_number = CASE WHEN $pr_number_patch = 1 THEN excluded.pr_number ELSE ralph_run_gate_results.pr_number END,
         pr_url = CASE WHEN $pr_url_patch = 1 THEN excluded.pr_url ELSE ralph_run_gate_results.pr_url END,
         updated_at = $updated_at`
    )
    .run({
      $run_id: params.runId,
      $gate: gate,
      $status_insert: statusInsert,
      $status_update: statusPatch ?? "pending",
      $status_patch: statusPatchFlag,
      $command: commandPatch ?? null,
      $command_patch: commandPatchFlag,
      $skip_reason: skipReasonPatch ?? null,
      $skip_reason_patch: skipReasonPatchFlag,
      $url: urlPatch ?? null,
      $url_patch: urlPatchFlag,
      $pr_number: prNumberValue,
      $pr_number_patch: prNumberPatchFlag,
      $pr_url: prUrlPatch ?? null,
      $pr_url_patch: prUrlPatchFlag,
      $repo_id: meta.repoId,
      $issue_number: meta.issueNumber,
      $task_path: meta.taskPath,
      $created_at: at,
      $updated_at: at,
    });
}

export function recordRalphRunGateArtifact(params: {
  runId: string;
  gate: GateName;
  kind: GateArtifactKind;
  content: string;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const gate = assertGateName(params.gate);
  const kind = assertGateArtifactKind(params.kind);
  const bounded = redactAndBoundArtifact(params.content);

  database.transaction(() => {
    database
      .query(
        `INSERT INTO ralph_run_gate_artifacts(
           run_id, gate, kind, content, truncated, original_chars, original_lines, created_at, updated_at
         ) VALUES (
           $run_id, $gate, $kind, $content, $truncated, $original_chars, $original_lines, $created_at, $updated_at
         )`
      )
      .run({
        $run_id: params.runId,
        $gate: gate,
        $kind: kind,
        $content: bounded.content,
        $truncated: bounded.truncated ? 1 : 0,
        $original_chars: bounded.originalChars,
        $original_lines: bounded.originalLines,
        $created_at: at,
        $updated_at: at,
      });

    database
      .query(
        `DELETE FROM ralph_run_gate_artifacts
         WHERE id IN (
           SELECT id FROM ralph_run_gate_artifacts
           WHERE run_id = $run_id AND gate = $gate AND kind = $kind
           ORDER BY created_at DESC, id DESC
           LIMIT -1 OFFSET $limit
         )`
      )
      .run({
        $run_id: params.runId,
        $gate: gate,
        $kind: kind,
        $limit: ARTIFACT_MAX_PER_GATE_KIND,
      });
  })();
}

export function getRalphRunGateState(runId: string): RalphRunGateState {
  const database = requireDb();

  const results = database
    .query(
      `SELECT run_id, gate, status, command, skip_reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
       FROM ralph_run_gate_results
       WHERE run_id = $run_id
       ORDER BY gate ASC`
    )
    .all({ $run_id: runId }) as Array<{
    run_id: string;
    gate: string;
    status: string;
    command?: string | null;
    skip_reason?: string | null;
    url?: string | null;
    pr_number?: number | null;
    pr_url?: string | null;
    repo_id: number;
    issue_number?: number | null;
    task_path?: string | null;
    created_at: string;
    updated_at: string;
  }>;

  const artifacts = database
    .query(
      `SELECT id, run_id, gate, kind, content, truncated, original_chars, original_lines, created_at, updated_at
       FROM ralph_run_gate_artifacts
       WHERE run_id = $run_id
       ORDER BY id ASC`
    )
    .all({ $run_id: runId }) as Array<{
    id: number;
    run_id: string;
    gate: string;
    kind: string;
    content: string;
    truncated: number;
    original_chars?: number | null;
    original_lines?: number | null;
    created_at: string;
    updated_at: string;
  }>;

  return {
    results: results.map((row) => ({
      runId: row.run_id,
      gate: assertGateName(row.gate),
      status: assertGateStatus(row.status),
      command: row.command ?? null,
      skipReason: row.skip_reason ?? null,
      url: row.url ?? null,
      prNumber: typeof row.pr_number === "number" ? row.pr_number : null,
      prUrl: row.pr_url ?? null,
      repoId: row.repo_id,
      issueNumber: typeof row.issue_number === "number" ? row.issue_number : null,
      taskPath: row.task_path ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    artifacts: artifacts.map((row) => ({
      id: row.id,
      runId: row.run_id,
      gate: assertGateName(row.gate),
      kind: assertGateArtifactKind(row.kind),
      content: row.content,
      truncated: Boolean(row.truncated),
      originalChars: typeof row.original_chars === "number" ? row.original_chars : null,
      originalLines: typeof row.original_lines === "number" ? row.original_lines : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

export function getLatestRunGateStateForIssue(params: {
  repo: string;
  issueNumber: number;
}): RalphRunGateState | null {
  const database = requireDb();
  const repoId = getRepoIdByName(params.repo);
  if (!repoId) return null;

  const row = database
    .query(
      `SELECT g.run_id as run_id, MAX(g.updated_at) as updated_at, MAX(r.started_at) as started_at
       FROM ralph_run_gate_results g
       JOIN ralph_runs r ON r.run_id = g.run_id
       WHERE g.repo_id = $repo_id AND g.issue_number = $issue_number
       GROUP BY g.run_id
       ORDER BY updated_at DESC, started_at DESC, g.run_id DESC
       LIMIT 1`
    )
    .get({ $repo_id: repoId, $issue_number: params.issueNumber }) as { run_id?: string } | undefined;

  if (!row?.run_id) return null;
  return getRalphRunGateState(row.run_id);
}

export function getLatestRunGateStateForPr(params: {
  repo: string;
  prNumber: number;
}): RalphRunGateState | null {
  const database = requireDb();
  const repoId = getRepoIdByName(params.repo);
  if (!repoId) return null;

  const row = database
    .query(
      `SELECT g.run_id as run_id, MAX(g.updated_at) as updated_at, MAX(r.started_at) as started_at
       FROM ralph_run_gate_results g
       JOIN ralph_runs r ON r.run_id = g.run_id
       WHERE g.repo_id = $repo_id AND g.pr_number = $pr_number
       GROUP BY g.run_id
       ORDER BY updated_at DESC, started_at DESC, g.run_id DESC
       LIMIT 1`
    )
    .get({ $repo_id: repoId, $pr_number: params.prNumber }) as { run_id?: string } | undefined;

  if (!row?.run_id) return null;
  return getRalphRunGateState(row.run_id);
}
export function getActiveRalphRunId(params: { repo: string; issueNumber: number | null }): string | null {
  if (!params.issueNumber) return null;

  const database = requireDb();
  const active = database
    .query(
      `SELECT r.run_id as run_id
       FROM ralph_runs r
       JOIN repos repo ON repo.id = r.repo_id
       WHERE repo.name = $repo
         AND r.issue_number = $issue_number
         AND r.completed_at IS NULL
       ORDER BY r.started_at DESC
       LIMIT 1`
    )
    .get({ $repo: params.repo, $issue_number: params.issueNumber }) as { run_id?: string } | undefined;

  if (active?.run_id) return active.run_id;

  const latest = database
    .query(
      `SELECT r.run_id as run_id
       FROM ralph_runs r
       JOIN repos repo ON repo.id = r.repo_id
       WHERE repo.name = $repo
         AND r.issue_number = $issue_number
       ORDER BY r.started_at DESC
       LIMIT 1`
    )
    .get({ $repo: params.repo, $issue_number: params.issueNumber }) as { run_id?: string } | undefined;

  return latest?.run_id ?? null;
}

export function listRalphRunSessionIds(runId: string): string[] {
  if (!runId) return [];
  const database = requireDb();
  const rows = database
    .query("SELECT session_id as session_id FROM ralph_run_sessions WHERE run_id = $run_id ORDER BY session_id")
    .all({ $run_id: runId }) as Array<{ session_id?: string } | undefined>;

  return rows.map((row) => row?.session_id ?? "").filter((id) => Boolean(id));
}

export type RalphRunSessionTokenTotalsQuality = "ok" | "missing" | "unreadable" | "timeout" | "error";

export type RalphRunSessionTokenTotals = {
  runId: string;
  sessionId: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensTotal: number | null;
  quality: RalphRunSessionTokenTotalsQuality;
  updatedAt: string;
};

export type RalphRunTokenTotals = {
  runId: string;
  tokensTotal: number | null;
  tokensComplete: boolean;
  sessionCount: number;
  updatedAt: string;
};

function normalizeTokenQuality(value: unknown): RalphRunSessionTokenTotalsQuality {
  switch (value) {
    case "ok":
    case "missing":
    case "unreadable":
    case "timeout":
    case "error":
      return value;
    default:
      return "error";
  }
}

function toSqliteBool(value: boolean): number {
  return value ? 1 : 0;
}

function fromSqliteBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1";
}

export function recordRalphRunSessionTokenTotals(params: {
  runId: string;
  sessionId: string;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensReasoning?: number | null;
  tokensTotal?: number | null;
  quality: RalphRunSessionTokenTotalsQuality;
  at?: string;
}): void {
  if (!params.runId?.trim()) return;
  if (!isSafeSessionId(params.sessionId)) return;

  const database = requireDb();
  const at = params.at ?? nowIso();
  const quality = normalizeTokenQuality(params.quality);

  database
    .query(
      `INSERT INTO ralph_run_session_token_totals(
         run_id, session_id, tokens_input, tokens_output, tokens_reasoning, tokens_total, quality, created_at, updated_at
       ) VALUES (
         $run_id, $session_id, $tokens_input, $tokens_output, $tokens_reasoning, $tokens_total, $quality, $created_at, $updated_at
       )
       ON CONFLICT(run_id, session_id) DO UPDATE SET
         tokens_input = excluded.tokens_input,
         tokens_output = excluded.tokens_output,
         tokens_reasoning = excluded.tokens_reasoning,
         tokens_total = excluded.tokens_total,
         quality = excluded.quality,
         updated_at = excluded.updated_at`
    )
    .run({
      $run_id: params.runId,
      $session_id: params.sessionId,
      $tokens_input: typeof params.tokensInput === "number" ? params.tokensInput : null,
      $tokens_output: typeof params.tokensOutput === "number" ? params.tokensOutput : null,
      $tokens_reasoning: typeof params.tokensReasoning === "number" ? params.tokensReasoning : null,
      $tokens_total: typeof params.tokensTotal === "number" ? params.tokensTotal : null,
      $quality: quality,
      $created_at: at,
      $updated_at: at,
    });
}

export function listRalphRunSessionTokenTotals(runId: string): RalphRunSessionTokenTotals[] {
  if (!runId?.trim()) return [];
  const database = requireDb();
  const rows = database
    .query(
      `SELECT run_id, session_id, tokens_input, tokens_output, tokens_reasoning, tokens_total, quality, updated_at
       FROM ralph_run_session_token_totals
       WHERE run_id = $run_id
       ORDER BY session_id`
    )
    .all({ $run_id: runId }) as Array<{
    run_id?: string;
    session_id?: string;
    tokens_input?: number | null;
    tokens_output?: number | null;
    tokens_reasoning?: number | null;
    tokens_total?: number | null;
    quality?: string;
    updated_at?: string;
  }>;

  return rows
    .map((row) => {
      const runId = row.run_id ?? "";
      const sessionId = row.session_id ?? "";
      const updatedAt = row.updated_at ?? "";
      if (!runId || !sessionId || !updatedAt) return null;
      return {
        runId,
        sessionId,
        tokensInput: typeof row.tokens_input === "number" ? row.tokens_input : null,
        tokensOutput: typeof row.tokens_output === "number" ? row.tokens_output : null,
        tokensReasoning: typeof row.tokens_reasoning === "number" ? row.tokens_reasoning : null,
        tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
        quality: normalizeTokenQuality(row.quality),
        updatedAt,
      } satisfies RalphRunSessionTokenTotals;
    })
    .filter((row): row is RalphRunSessionTokenTotals => Boolean(row));
}

export function recordRalphRunTokenTotals(params: {
  runId: string;
  tokensTotal: number | null;
  tokensComplete: boolean;
  sessionCount: number;
  at?: string;
}): void {
  if (!params.runId?.trim()) return;
  const database = requireDb();
  const at = params.at ?? nowIso();

  database
    .query(
      `INSERT INTO ralph_run_token_totals(
         run_id, tokens_total, tokens_complete, session_count, created_at, updated_at
       ) VALUES (
         $run_id, $tokens_total, $tokens_complete, $session_count, $created_at, $updated_at
       )
       ON CONFLICT(run_id) DO UPDATE SET
         tokens_total = excluded.tokens_total,
         tokens_complete = excluded.tokens_complete,
         session_count = excluded.session_count,
         updated_at = excluded.updated_at`
    )
    .run({
      $run_id: params.runId,
      $tokens_total: typeof params.tokensTotal === "number" ? params.tokensTotal : null,
      $tokens_complete: toSqliteBool(params.tokensComplete),
      $session_count: Number.isFinite(params.sessionCount) ? Math.max(0, Math.floor(params.sessionCount)) : 0,
      $created_at: at,
      $updated_at: at,
    });
}

export function getRalphRunTokenTotals(runId: string): RalphRunTokenTotals | null {
  if (!runId?.trim()) return null;
  const database = requireDb();
  const row = database
    .query(
      `SELECT run_id, tokens_total, tokens_complete, session_count, updated_at
       FROM ralph_run_token_totals
       WHERE run_id = $run_id`
    )
    .get({ $run_id: runId }) as
    | {
        run_id?: string;
        tokens_total?: number | null;
        tokens_complete?: number | null;
        session_count?: number | null;
        updated_at?: string;
      }
    | undefined;

  if (!row?.run_id || !row.updated_at) return null;
  return {
    runId: row.run_id,
    tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
    tokensComplete: fromSqliteBool(row.tokens_complete),
    sessionCount: typeof row.session_count === "number" ? row.session_count : 0,
    updatedAt: row.updated_at,
  };
}

const LABEL_SEPARATOR = "\u0001";

function parseLabelList(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(LABEL_SEPARATOR)
    .map((label) => label.trim())
    .filter(Boolean);
}

export type IssueSnapshot = {
  repo: string;
  number: number;
  title?: string | null;
  state?: string | null;
  url?: string | null;
  githubNodeId?: string | null;
  githubUpdatedAt?: string | null;
  labels: string[];
};

export type TaskOpState = {
  repo: string;
  issueNumber: number | null;
  taskPath: string;
  status?: string | null;
  sessionId?: string | null;
  sessionEventsPath?: string | null;
  worktreePath?: string | null;
  workerId?: string | null;
  repoSlot?: string | null;
  daemonId?: string | null;
  heartbeatAt?: string | null;
  releasedAtMs?: number | null;
  releasedReason?: string | null;
};

type IssueSnapshotQueryParams = {
  repo: string;
  includeClosed?: boolean;
  onlyRalph?: boolean;
};

function listIssueSnapshotsInternal(params: IssueSnapshotQueryParams): IssueSnapshot[] {
  const database = requireDb();
  const includeClosed = params.includeClosed ?? false;
  const onlyRalph = params.onlyRalph ?? false;
  const conditions: string[] = ["r.name = $name"];
  if (!includeClosed) {
    conditions.push("(i.state IS NULL OR UPPER(i.state) != 'CLOSED')");
  }
  if (onlyRalph) {
    conditions.push("EXISTS (SELECT 1 FROM issue_labels l2 WHERE l2.issue_id = i.id AND l2.name LIKE 'ralph:%')");
  }

  const rows = database
    .query(
      `SELECT i.id as id, i.number as number, i.title as title, i.state as state, i.url as url,
              i.github_node_id as github_node_id, i.github_updated_at as github_updated_at,
              GROUP_CONCAT(l.name, '${LABEL_SEPARATOR}') as labels
       FROM issues i
       JOIN repos r ON r.id = i.repo_id
       LEFT JOIN issue_labels l ON l.issue_id = i.id
       WHERE ${conditions.join(" AND ")}
       GROUP BY i.id
       ORDER BY i.number ASC`
    )
    .all({ $name: params.repo }) as Array<{
    number: number;
    title?: string | null;
    state?: string | null;
    url?: string | null;
    github_node_id?: string | null;
    github_updated_at?: string | null;
    labels?: string | null;
  }>;

  return rows.map((row) => ({
    repo: params.repo,
    number: row.number,
    title: row.title ?? null,
    state: row.state ?? null,
    url: row.url ?? null,
    githubNodeId: row.github_node_id ?? null,
    githubUpdatedAt: row.github_updated_at ?? null,
    labels: parseLabelList(row.labels),
  }));
}

export function listIssueSnapshots(repo: string, opts?: { includeClosed?: boolean; onlyRalph?: boolean }): IssueSnapshot[] {
  return listIssueSnapshotsInternal({ repo, includeClosed: opts?.includeClosed, onlyRalph: opts?.onlyRalph });
}

export function listIssueSnapshotsWithRalphLabels(repo: string): IssueSnapshot[] {
  return listIssueSnapshotsInternal({ repo, includeClosed: false, onlyRalph: true });
}

export function getIssueSnapshotByNumber(repo: string, issueNumber: number): IssueSnapshot | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT i.id as id, i.number as number, i.title as title, i.state as state, i.url as url,
              i.github_node_id as github_node_id, i.github_updated_at as github_updated_at,
              GROUP_CONCAT(l.name, '${LABEL_SEPARATOR}') as labels
       FROM issues i
       JOIN repos r ON r.id = i.repo_id
       LEFT JOIN issue_labels l ON l.issue_id = i.id
       WHERE r.name = $name AND i.number = $number
       GROUP BY i.id`
    )
    .get({ $name: repo, $number: issueNumber }) as
    | {
        number?: number;
        title?: string | null;
        state?: string | null;
        url?: string | null;
        github_node_id?: string | null;
        github_updated_at?: string | null;
        labels?: string | null;
      }
    | undefined;

  if (!row?.number) return null;
  return {
    repo,
    number: row.number,
    title: row.title ?? null,
    state: row.state ?? null,
    url: row.url ?? null,
    githubNodeId: row.github_node_id ?? null,
    githubUpdatedAt: row.github_updated_at ?? null,
    labels: parseLabelList(row.labels),
  };
}

export type EscalationCommentCheckState = {
  lastCheckedAt: string | null;
  lastSeenUpdatedAt: string | null;
  lastResolvedCommentId: number | null;
  lastResolvedCommentAt: string | null;
};

export function getEscalationCommentCheckState(
  repo: string,
  issueNumber: number
): EscalationCommentCheckState | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT ecc.last_checked_at as last_checked_at,
              ecc.last_seen_updated_at as last_seen_updated_at,
              ecc.last_resolved_comment_id as last_resolved_comment_id,
              ecc.last_resolved_comment_at as last_resolved_comment_at
       FROM issue_escalation_comment_checks ecc
       JOIN issues i ON i.id = ecc.issue_id
       JOIN repos r ON r.id = i.repo_id
       WHERE r.name = $name AND i.number = $number`
    )
    .get({ $name: repo, $number: issueNumber }) as
    | {
        last_checked_at?: string | null;
        last_seen_updated_at?: string | null;
        last_resolved_comment_id?: number | null;
        last_resolved_comment_at?: string | null;
      }
    | undefined;

  if (!row) return null;
  return {
    lastCheckedAt: row.last_checked_at ?? null,
    lastSeenUpdatedAt: row.last_seen_updated_at ?? null,
    lastResolvedCommentId: row.last_resolved_comment_id ?? null,
    lastResolvedCommentAt: row.last_resolved_comment_at ?? null,
  };
}

export function recordEscalationCommentCheckState(params: {
  repo: string;
  issueNumber: number;
  lastCheckedAt: string;
  lastSeenUpdatedAt?: string | null;
  lastResolvedCommentId?: number | null;
  lastResolvedCommentAt?: string | null;
}): void {
  const database = requireDb();
  const issueRow = database
    .query(
      `SELECT i.id as id
       FROM issues i
       JOIN repos r ON r.id = i.repo_id
       WHERE r.name = $name AND i.number = $number`
    )
    .get({ $name: params.repo, $number: params.issueNumber }) as { id?: number } | undefined;

  if (!issueRow?.id) return;

  const existing = database
    .query(
      `SELECT last_resolved_comment_id as last_resolved_comment_id,
              last_resolved_comment_at as last_resolved_comment_at
       FROM issue_escalation_comment_checks
       WHERE issue_id = $issue_id`
    )
    .get({ $issue_id: issueRow.id }) as
    | { last_resolved_comment_id?: number | null; last_resolved_comment_at?: string | null }
    | undefined;

  const lastResolvedCommentId =
    params.lastResolvedCommentId !== undefined
      ? params.lastResolvedCommentId
      : (existing?.last_resolved_comment_id ?? null);
  const lastResolvedCommentAt =
    params.lastResolvedCommentAt !== undefined ? params.lastResolvedCommentAt : (existing?.last_resolved_comment_at ?? null);

  database
    .query(
      `INSERT INTO issue_escalation_comment_checks(
         issue_id,
         last_checked_at,
         last_seen_updated_at,
         last_resolved_comment_id,
         last_resolved_comment_at
       )
       VALUES ($issue_id, $last_checked_at, $last_seen_updated_at, $last_resolved_comment_id, $last_resolved_comment_at)
       ON CONFLICT(issue_id) DO UPDATE SET
          last_checked_at = excluded.last_checked_at,
          last_seen_updated_at = excluded.last_seen_updated_at,
          last_resolved_comment_id = excluded.last_resolved_comment_id,
          last_resolved_comment_at = excluded.last_resolved_comment_at`
    )
    .run({
      $issue_id: issueRow.id,
      $last_checked_at: params.lastCheckedAt,
      $last_seen_updated_at: params.lastSeenUpdatedAt ?? null,
      $last_resolved_comment_id: lastResolvedCommentId,
      $last_resolved_comment_at: lastResolvedCommentAt,
    });
}

export function getIssueLabels(repo: string, issueNumber: number): string[] {
  if (!db) return [];
  const database = requireDb();
  const row = database
    .query(
      `SELECT i.id as id
       FROM issues i
       JOIN repos r ON r.id = i.repo_id
       WHERE r.name = $name AND i.number = $number`
    )
    .get({ $name: repo, $number: issueNumber }) as { id?: number } | undefined;

  if (!row?.id) return [];
  const labels = database
    .query("SELECT name FROM issue_labels WHERE issue_id = $id ORDER BY name")
    .all({ $id: row.id }) as Array<{ name: string }>;

  return labels.map((label) => label.name);
}

function mapParentVerificationRow(row: {
  issue_number?: number | null;
  status?: string | null;
  pending_at_ms?: number | null;
  attempt_count?: number | null;
  last_attempt_at_ms?: number | null;
  next_attempt_at_ms?: number | null;
  outcome?: string | null;
  outcome_details?: string | null;
  updated_at_ms?: number | null;
} | undefined, repo: string): ParentVerificationState | null {
  if (!row || typeof row.issue_number !== "number") return null;
  const status = row.status as ParentVerificationStatus | null;
  if (!status || (status !== "pending" && status !== "running" && status !== "complete")) return null;
  const updatedAtMs = typeof row.updated_at_ms === "number" ? row.updated_at_ms : 0;
  if (!updatedAtMs) return null;
  return {
    repo,
    issueNumber: row.issue_number,
    status,
    pendingAtMs: typeof row.pending_at_ms === "number" ? row.pending_at_ms : null,
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
    lastAttemptAtMs: typeof row.last_attempt_at_ms === "number" ? row.last_attempt_at_ms : null,
    nextAttemptAtMs: typeof row.next_attempt_at_ms === "number" ? row.next_attempt_at_ms : null,
    outcome: (row.outcome as ParentVerificationOutcome | null) ?? null,
    outcomeDetails: row.outcome_details ?? null,
    updatedAtMs,
  };
}

export function getParentVerificationState(params: {
  repo: string;
  issueNumber: number;
}): ParentVerificationState | null {
  if (!db) return null;
  const database = requireDb();
  const row = database
    .query(
      `SELECT issue_number, status, pending_at_ms, attempt_count, last_attempt_at_ms, next_attempt_at_ms,
              outcome, outcome_details, updated_at_ms
       FROM parent_verification_state p
       JOIN repos r ON r.id = p.repo_id
       WHERE r.name = $name AND p.issue_number = $number`
    )
    .get({ $name: params.repo, $number: params.issueNumber }) as
    | {
        issue_number?: number | null;
        status?: string | null;
        pending_at_ms?: number | null;
        attempt_count?: number | null;
        last_attempt_at_ms?: number | null;
        next_attempt_at_ms?: number | null;
        outcome?: string | null;
        outcome_details?: string | null;
        updated_at_ms?: number | null;
      }
    | undefined;

  return mapParentVerificationRow(row, params.repo);
}

export function setParentVerificationPending(params: {
  repo: string;
  issueNumber: number;
  nowMs: number;
}): boolean {
  if (!db) return false;
  const database = requireDb();
  const updatedAtMs = params.nowMs;
  const atIso = new Date(params.nowMs).toISOString();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const existing = database
    .query(
      `SELECT status FROM parent_verification_state
       WHERE repo_id = $repo_id AND issue_number = $issue_number`
    )
    .get({ $repo_id: repoId, $issue_number: params.issueNumber }) as { status?: string | null } | undefined;

  if (existing && existing.status !== "complete") return false;

  const result = database
    .query(
      `INSERT INTO parent_verification_state(
         repo_id, issue_number, status, pending_at_ms, attempt_count, last_attempt_at_ms,
         next_attempt_at_ms, outcome, outcome_details, updated_at_ms
       ) VALUES (
         $repo_id, $issue_number, 'pending', $pending_at_ms, 0, NULL,
         $next_attempt_at_ms, NULL, NULL, $updated_at_ms
       )
       ON CONFLICT(repo_id, issue_number) DO UPDATE SET
         status = 'pending',
         pending_at_ms = excluded.pending_at_ms,
         attempt_count = 0,
         last_attempt_at_ms = NULL,
         next_attempt_at_ms = excluded.next_attempt_at_ms,
         outcome = NULL,
         outcome_details = NULL,
         updated_at_ms = excluded.updated_at_ms
       WHERE parent_verification_state.status = 'complete'`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $pending_at_ms: updatedAtMs,
      $next_attempt_at_ms: updatedAtMs,
      $updated_at_ms: updatedAtMs,
    });

  return result.changes > 0;
}

export function tryClaimParentVerification(params: {
  repo: string;
  issueNumber: number;
  nowMs: number;
}): ParentVerificationState | null {
  if (!db) return null;
  const database = requireDb();
  const atIso = new Date(params.nowMs).toISOString();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const result = database
    .query(
      `UPDATE parent_verification_state
       SET status = 'running',
           attempt_count = attempt_count + 1,
           last_attempt_at_ms = $now_ms,
           updated_at_ms = $now_ms
       WHERE repo_id = $repo_id
         AND issue_number = $issue_number
         AND status = 'pending'
         AND (next_attempt_at_ms IS NULL OR next_attempt_at_ms <= $now_ms)`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $now_ms: params.nowMs,
    });

  if (result.changes === 0) return null;
  return getParentVerificationState({ repo: params.repo, issueNumber: params.issueNumber });
}

export function recordParentVerificationAttemptFailure(params: {
  repo: string;
  issueNumber: number;
  attemptCount: number;
  nextAttemptAtMs: number;
  nowMs: number;
  details?: string | null;
}): void {
  if (!db) return;
  const database = requireDb();
  const atIso = new Date(params.nowMs).toISOString();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const outcomeDetails = sanitizeOptionalText(params.details ?? null, 1000);
  database
    .query(
      `UPDATE parent_verification_state
       SET status = 'pending',
           attempt_count = $attempt_count,
           last_attempt_at_ms = $last_attempt_at_ms,
           next_attempt_at_ms = $next_attempt_at_ms,
           outcome = 'failed',
           outcome_details = $outcome_details,
           updated_at_ms = $updated_at_ms
       WHERE repo_id = $repo_id AND issue_number = $issue_number`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $attempt_count: params.attemptCount,
      $last_attempt_at_ms: params.nowMs,
      $next_attempt_at_ms: params.nextAttemptAtMs,
      $outcome_details: outcomeDetails ?? null,
      $updated_at_ms: params.nowMs,
    });
}

export function completeParentVerification(params: {
  repo: string;
  issueNumber: number;
  outcome: ParentVerificationOutcome;
  details?: string | null;
  nowMs: number;
}): void {
  if (!db) return;
  const database = requireDb();
  const atIso = new Date(params.nowMs).toISOString();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const outcomeDetails = sanitizeOptionalText(params.details ?? null, 1000);
  database
    .query(
      `INSERT INTO parent_verification_state(
         repo_id, issue_number, status, pending_at_ms, attempt_count, last_attempt_at_ms,
         next_attempt_at_ms, outcome, outcome_details, updated_at_ms
       ) VALUES (
         $repo_id, $issue_number, 'complete', NULL, 0, NULL, NULL,
         $outcome, $outcome_details, $updated_at_ms
       )
       ON CONFLICT(repo_id, issue_number) DO UPDATE SET
         status = 'complete',
         outcome = excluded.outcome,
         outcome_details = excluded.outcome_details,
         updated_at_ms = excluded.updated_at_ms`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $outcome: params.outcome,
      $outcome_details: outcomeDetails ?? null,
      $updated_at_ms: params.nowMs,
    });
}

export function listTaskOpStatesByRepo(repo: string): TaskOpState[] {
  const database = requireDb();
  const rows = database
    .query(
      `SELECT t.task_path as task_path, t.issue_number as issue_number, t.status as status, t.session_id as session_id,
              t.session_events_path as session_events_path, t.worktree_path as worktree_path, t.worker_id as worker_id,
              t.repo_slot as repo_slot, t.daemon_id as daemon_id, t.heartbeat_at as heartbeat_at,
              t.released_at_ms as released_at_ms, t.released_reason as released_reason
       FROM tasks t
       JOIN repos r ON r.id = t.repo_id
       WHERE r.name = $name AND t.issue_number IS NOT NULL AND t.task_path LIKE 'github:%'
       ORDER BY t.updated_at DESC`
    )
    .all({ $name: repo }) as Array<{
    task_path: string;
    issue_number: number | null;
    status?: string | null;
    session_id?: string | null;
    session_events_path?: string | null;
    worktree_path?: string | null;
    worker_id?: string | null;
    repo_slot?: string | null;
    daemon_id?: string | null;
    heartbeat_at?: string | null;
    released_at_ms?: number | null;
    released_reason?: string | null;
  }>;

  return rows.map((row) => ({
    repo,
    issueNumber: row.issue_number ?? null,
    taskPath: row.task_path,
    status: row.status ?? null,
    sessionId: row.session_id ?? null,
    sessionEventsPath: row.session_events_path ?? null,
    worktreePath: row.worktree_path ?? null,
    workerId: row.worker_id ?? null,
    repoSlot: row.repo_slot ?? null,
    daemonId: row.daemon_id ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    releasedAtMs: typeof row.released_at_ms === "number" ? row.released_at_ms : null,
    releasedReason: row.released_reason ?? null,
  }));
}

export function getTaskOpStateByPath(repo: string, taskPath: string): TaskOpState | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT t.task_path as task_path, t.issue_number as issue_number, t.status as status, t.session_id as session_id,
              t.session_events_path as session_events_path, t.worktree_path as worktree_path, t.worker_id as worker_id,
              t.repo_slot as repo_slot, t.daemon_id as daemon_id, t.heartbeat_at as heartbeat_at,
              t.released_at_ms as released_at_ms, t.released_reason as released_reason
       FROM tasks t
       JOIN repos r ON r.id = t.repo_id
       WHERE r.name = $name AND t.task_path = $task_path`
    )
    .get({ $name: repo, $task_path: taskPath }) as
    | {
        task_path?: string;
        issue_number?: number | null;
        status?: string | null;
        session_id?: string | null;
        session_events_path?: string | null;
        worktree_path?: string | null;
        worker_id?: string | null;
        repo_slot?: string | null;
        daemon_id?: string | null;
        heartbeat_at?: string | null;
        released_at_ms?: number | null;
        released_reason?: string | null;
      }
    | undefined;

  if (!row?.task_path) return null;
  return {
    repo,
    issueNumber: row.issue_number ?? null,
    taskPath: row.task_path,
    status: row.status ?? null,
    sessionId: row.session_id ?? null,
    sessionEventsPath: row.session_events_path ?? null,
    worktreePath: row.worktree_path ?? null,
    workerId: row.worker_id ?? null,
    repoSlot: row.repo_slot ?? null,
    daemonId: row.daemon_id ?? null,
    heartbeatAt: row.heartbeat_at ?? null,
    releasedAtMs: typeof row.released_at_ms === "number" ? row.released_at_ms : null,
    releasedReason: row.released_reason ?? null,
  };
}

function parsePrNumber(prUrl: string): number | null {
  const match = prUrl.match(/\/pull\/(\d+)(?:$|[/?#])/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

export function recordPrSnapshot(input: {
  repo: string;
  issue: string;
  prUrl: string;
  state?: PrState;
  at?: string;
}): void {
  const database = requireDb();
  const at = input.at ?? nowIso();
  const repoId = upsertRepo({ repo: input.repo, at });
  const issueNumber = parseIssueNumber(input.issue);
  const prNumber = parsePrNumber(input.prUrl);

  database
    .query(
      `INSERT INTO prs(repo_id, issue_number, pr_number, url, state, created_at, updated_at)
       VALUES ($repo_id, $issue_number, $pr_number, $url, $state, $created_at, $updated_at)
       ON CONFLICT(repo_id, url) DO UPDATE SET
          issue_number = COALESCE(excluded.issue_number, prs.issue_number),
          pr_number = COALESCE(excluded.pr_number, prs.pr_number),
          state = CASE
            WHEN prs.state = 'merged' AND (excluded.state IS NULL OR excluded.state != 'merged') THEN prs.state
            ELSE COALESCE(excluded.state, prs.state)
          END,
          updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $issue_number: issueNumber,
      $pr_number: prNumber,
      $url: input.prUrl,
      $state: input.state ?? null,
      $created_at: at,
      $updated_at: at,
    });
}

export type PrSnapshotRow = {
  url: string;
  prNumber: number | null;
  state: string | null;
  createdAt: string;
  updatedAt: string;
};

function formatPrSnapshotRows(rows: Array<{
  url?: string | null;
  pr_number?: number | null;
  state?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}>): PrSnapshotRow[] {
  return rows
    .map((row) => {
      const url = typeof row.url === "string" ? row.url.trim() : "";
      const createdAt = typeof row.created_at === "string" ? row.created_at : "";
      const updatedAt = typeof row.updated_at === "string" ? row.updated_at : "";
      if (!url || !createdAt || !updatedAt) return null;
      return {
        url,
        prNumber: typeof row.pr_number === "number" ? row.pr_number : null,
        state: typeof row.state === "string" ? row.state : null,
        createdAt,
        updatedAt,
      };
    })
    .filter((row): row is PrSnapshotRow => Boolean(row));
}

export function listOpenPrCandidatesForIssue(repo: string, issueNumber: number): PrSnapshotRow[] {
  const database = requireDb();
  const repoRow = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: repo,
  }) as { id?: number } | undefined;
  if (!repoRow?.id) return [];

  const rows = database
    .query(
      `SELECT url, pr_number, state, created_at, updated_at
       FROM prs
       WHERE repo_id = $repo_id
         AND issue_number = $issue_number
         AND url IS NOT NULL
         AND TRIM(url) != ''
         AND (state = 'open' OR state IS NULL)
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all({
      $repo_id: repoRow.id,
      $issue_number: issueNumber,
    }) as Array<{
    url?: string | null;
    pr_number?: number | null;
    state?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;

  return formatPrSnapshotRows(rows);
}

export function listMergedPrCandidatesForIssue(repo: string, issueNumber: number): PrSnapshotRow[] {
  const database = requireDb();
  const repoRow = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: repo,
  }) as { id?: number } | undefined;
  if (!repoRow?.id) return [];

  const rows = database
    .query(
      `SELECT url, pr_number, state, created_at, updated_at
       FROM prs
       WHERE repo_id = $repo_id
         AND issue_number = $issue_number
         AND url IS NOT NULL
         AND TRIM(url) != ''
         AND state = 'merged'
       ORDER BY updated_at DESC, created_at DESC`
    )
    .all({
      $repo_id: repoRow.id,
      $issue_number: issueNumber,
    }) as Array<{
    url?: string | null;
    pr_number?: number | null;
    state?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
  }>;

  return formatPrSnapshotRows(rows);
}

export function hasIdempotencyKey(key: string): boolean {
  const database = requireDb();
  const row = database.query("SELECT key FROM idempotency WHERE key = $key").get({
    $key: key,
  }) as { key?: string } | undefined;
  return Boolean(row?.key);
}

export function getIdempotencyPayload(key: string): string | null {
  const database = requireDb();
  const row = database.query("SELECT payload_json FROM idempotency WHERE key = $key").get({
    $key: key,
  }) as { payload_json?: string | null } | undefined;
  return typeof row?.payload_json === "string" ? row.payload_json : null;
}

export function getIdempotencyRecord(
  key: string
): { key: string; scope: string | null; createdAt: string; payloadJson: string | null } | null {
  const database = requireDb();
  const row = database
    .query("SELECT key, scope, created_at, payload_json FROM idempotency WHERE key = $key")
    .get({ $key: key }) as { key?: string; scope?: string | null; created_at?: string; payload_json?: string | null } | undefined;

  if (!row?.key || !row.created_at) return null;
  return {
    key: row.key,
    scope: row.scope ?? null,
    createdAt: row.created_at,
    payloadJson: row.payload_json ?? null,
  };
}

export function recordIdempotencyKey(input: {
  key: string;
  scope?: string;
  payloadJson?: string;
  createdAt?: string;
}): boolean {
  const database = requireDb();
  const createdAt = input.createdAt ?? nowIso();

  const result = database
    .query(
      `INSERT INTO idempotency(key, scope, created_at, payload_json)
       VALUES ($key, $scope, $created_at, $payload_json)
       ON CONFLICT(key) DO NOTHING`
    )
    .run({
      $key: input.key,
      $scope: input.scope ?? null,
      $created_at: createdAt,
      $payload_json: input.payloadJson ?? null,
    });

  return result.changes > 0;
}

export function upsertIdempotencyKey(input: {
  key: string;
  scope?: string;
  payloadJson?: string;
  createdAt?: string;
}): void {
  const database = requireDb();
  const createdAt = input.createdAt ?? nowIso();

  database
    .query(
      `INSERT INTO idempotency(key, scope, created_at, payload_json)
       VALUES ($key, $scope, $created_at, $payload_json)
       ON CONFLICT(key) DO UPDATE SET
         scope = excluded.scope,
         created_at = excluded.created_at,
         payload_json = excluded.payload_json`
    )
    .run({
      $key: input.key,
      $scope: input.scope ?? null,
      $created_at: createdAt,
      $payload_json: input.payloadJson ?? null,
    });
}

export function deleteIdempotencyKey(key: string): void {
  const database = requireDb();
  database.query("DELETE FROM idempotency WHERE key = $key").run({ $key: key });
}

export type RollupBatchStatus = "open" | "rolled-up";

export type RollupBatch = {
  id: string;
  repo: string;
  botBranch: string;
  batchSize: number;
  status: RollupBatchStatus;
  rollupPrUrl?: string | null;
  rollupPrNumber?: number | null;
  createdAt: string;
  updatedAt: string;
  rollupCreatedAt?: string | null;
};

export type RollupBatchEntry = {
  prUrl: string;
  prNumber?: number | null;
  issueRefs: string[];
  mergedAt: string;
};

function resolveRollupBatch(database: Database, params: {
  repo: string;
  botBranch: string;
  batchSize: number;
  at?: string;
}): RollupBatch {
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, botBranch: params.botBranch, at });
  const existing = database
    .query(
      `SELECT id, bot_branch, batch_size, status, rollup_pr_url, rollup_pr_number,
              created_at, updated_at, rollup_created_at
       FROM rollup_batches
       WHERE repo_id = $repo_id AND bot_branch = $bot_branch AND status = 'open'`
    )
    .get({ $repo_id: repoId, $bot_branch: params.botBranch }) as {
      id?: string;
      bot_branch?: string;
      batch_size?: number;
      status?: RollupBatchStatus;
      rollup_pr_url?: string | null;
      rollup_pr_number?: number | null;
      created_at?: string;
      updated_at?: string;
      rollup_created_at?: string | null;
    } | undefined;

  if (existing?.id) {
    return {
      id: existing.id,
      repo: params.repo,
      botBranch: existing.bot_branch ?? params.botBranch,
      batchSize: existing.batch_size ?? params.batchSize,
      status: (existing.status ?? "open") as RollupBatchStatus,
      rollupPrUrl: existing.rollup_pr_url ?? null,
      rollupPrNumber: existing.rollup_pr_number ?? null,
      createdAt: existing.created_at ?? at,
      updatedAt: existing.updated_at ?? at,
      rollupCreatedAt: existing.rollup_created_at ?? null,
    };
  }

  const id = randomUUID();
  database
    .query(
      `INSERT INTO rollup_batches(
         id, repo_id, bot_branch, batch_size, status, created_at, updated_at
       ) VALUES (
         $id, $repo_id, $bot_branch, $batch_size, 'open', $created_at, $updated_at
       )`
    )
    .run({
      $id: id,
      $repo_id: repoId,
      $bot_branch: params.botBranch,
      $batch_size: params.batchSize,
      $created_at: at,
      $updated_at: at,
    });

  return {
    id,
    repo: params.repo,
    botBranch: params.botBranch,
    batchSize: params.batchSize,
    status: "open",
    rollupPrUrl: null,
    rollupPrNumber: null,
    createdAt: at,
    updatedAt: at,
    rollupCreatedAt: null,
  };
}

export function getOrCreateRollupBatch(params: {
  repo: string;
  botBranch: string;
  batchSize: number;
  at?: string;
}): RollupBatch {
  const database = requireDb();
  return resolveRollupBatch(database, params);
}

export function listOpenRollupBatches(): RollupBatch[] {
  const database = requireDb();
  const rows = database
    .query(
      `SELECT b.id, r.name as repo, b.bot_branch, b.batch_size, b.status, b.rollup_pr_url,
              b.rollup_pr_number, b.created_at, b.updated_at, b.rollup_created_at
       FROM rollup_batches b
       JOIN repos r ON r.id = b.repo_id
       WHERE b.status = 'open'
       ORDER BY b.created_at ASC`
    )
    .all() as Array<{
      id: string;
      repo: string;
      bot_branch: string;
      batch_size: number;
      status: RollupBatchStatus;
      rollup_pr_url?: string | null;
      rollup_pr_number?: number | null;
      created_at: string;
      updated_at: string;
      rollup_created_at?: string | null;
    }>;

  return rows.map((row) => ({
    id: row.id,
    repo: row.repo,
    botBranch: row.bot_branch,
    batchSize: row.batch_size,
    status: row.status,
    rollupPrUrl: row.rollup_pr_url ?? null,
    rollupPrNumber: row.rollup_pr_number ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rollupCreatedAt: row.rollup_created_at ?? null,
  }));
}

export function listRollupBatchEntries(batchId: string): RollupBatchEntry[] {
  const database = requireDb();
  const rows = database
    .query(
      `SELECT pr_url, pr_number, issue_refs_json, merged_at
       FROM rollup_batch_prs
       WHERE batch_id = $batch_id
       ORDER BY merged_at ASC, id ASC`
    )
    .all({ $batch_id: batchId }) as Array<{
      pr_url: string;
      pr_number?: number | null;
      issue_refs_json?: string | null;
      merged_at: string;
    }>;

  return rows.map((row) => ({
    prUrl: row.pr_url,
    prNumber: row.pr_number ?? null,
    issueRefs: parseJsonArray(row.issue_refs_json),
    mergedAt: row.merged_at,
  }));
}

export function updateRollupBatchEntryIssueRefs(params: {
  batchId: string;
  prUrl: string;
  issueRefs: string[];
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();

  database.transaction(() => {
    database
      .query(
        `UPDATE rollup_batch_prs
         SET issue_refs_json = $issue_refs_json
         WHERE batch_id = $batch_id AND pr_url = $pr_url`
      )
      .run({
        $batch_id: params.batchId,
        $pr_url: params.prUrl,
        $issue_refs_json: toJson(params.issueRefs),
      });

    database.query("UPDATE rollup_batches SET updated_at = $updated_at WHERE id = $id").run({
      $updated_at: at,
      $id: params.batchId,
    });
  })();
}


export function recordRollupMerge(params: {
  repo: string;
  botBranch: string;
  batchSize: number;
  prUrl: string;
  issueRefs?: string[];
  mergedAt?: string;
}): { batch: RollupBatch; entries: RollupBatchEntry[]; entryInserted: boolean } {
  const database = requireDb();
  const mergedAt = params.mergedAt ?? nowIso();
  const issueRefs = params.issueRefs ?? [];
  let snapshot: { batch: RollupBatch; entries: RollupBatchEntry[]; entryInserted: boolean } | null = null;

  database.transaction(() => {
    const batch = resolveRollupBatch(database, {
      repo: params.repo,
      botBranch: params.botBranch,
      batchSize: params.batchSize,
      at: mergedAt,
    });

    const prNumber = parsePrNumber(params.prUrl);

    const insertResult = database
      .query(
        `INSERT INTO rollup_batch_prs(
           batch_id, pr_url, pr_number, issue_refs_json, merged_at, created_at
         ) VALUES (
           $batch_id, $pr_url, $pr_number, $issue_refs_json, $merged_at, $created_at
         )
         ON CONFLICT(batch_id, pr_url) DO NOTHING`
      )
      .run({
        $batch_id: batch.id,
        $pr_url: params.prUrl,
        $pr_number: prNumber,
        $issue_refs_json: toJson(issueRefs),
        $merged_at: mergedAt,
        $created_at: mergedAt,
      });

    database
      .query("UPDATE rollup_batches SET updated_at = $updated_at WHERE id = $id")
      .run({ $updated_at: mergedAt, $id: batch.id });

    snapshot = {
      batch,
      entries: listRollupBatchEntries(batch.id),
      entryInserted: insertResult.changes > 0,
    };
  })();

  if (!snapshot) {
    throw new Error("Failed to record rollup merge");
  }

  return snapshot;
}

export function markRollupBatchRolledUp(params: {
  batchId: string;
  rollupPrUrl: string;
  rollupPrNumber?: number | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();

  database
    .query(
      `UPDATE rollup_batches
       SET status = 'rolled-up',
           rollup_pr_url = $rollup_pr_url,
           rollup_pr_number = $rollup_pr_number,
           rollup_created_at = $rollup_created_at,
           updated_at = $updated_at
       WHERE id = $id`
    )
    .run({
      $id: params.batchId,
      $rollup_pr_url: params.rollupPrUrl,
      $rollup_pr_number: params.rollupPrNumber ?? null,
      $rollup_created_at: at,
      $updated_at: at,
    });
}

export function createNewRollupBatch(params: {
  repo: string;
  botBranch: string;
  batchSize: number;
  at?: string;
}): RollupBatch {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, botBranch: params.botBranch, at });
  const id = randomUUID();

  database
    .query(
      `INSERT INTO rollup_batches(
         id, repo_id, bot_branch, batch_size, status, created_at, updated_at
       ) VALUES (
         $id, $repo_id, $bot_branch, $batch_size, 'open', $created_at, $updated_at
       )`
    )
    .run({
      $id: id,
      $repo_id: repoId,
      $bot_branch: params.botBranch,
      $batch_size: params.batchSize,
      $created_at: at,
      $updated_at: at,
    });

  return {
    id,
    repo: params.repo,
    botBranch: params.botBranch,
    batchSize: params.batchSize,
    status: "open",
    rollupPrUrl: null,
    rollupPrNumber: null,
    createdAt: at,
    updatedAt: at,
    rollupCreatedAt: null,
  };
}

export function loadRollupBatchById(batchId: string): RollupBatch | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT b.id, r.name as repo, b.bot_branch, b.batch_size, b.status, b.rollup_pr_url,
              b.rollup_pr_number, b.created_at, b.updated_at, b.rollup_created_at
       FROM rollup_batches b
       JOIN repos r ON r.id = b.repo_id
       WHERE b.id = $id`
    )
    .get({ $id: batchId }) as {
      id?: string;
      repo?: string;
      bot_branch?: string;
      batch_size?: number;
      status?: RollupBatchStatus;
      rollup_pr_url?: string | null;
      rollup_pr_number?: number | null;
      created_at?: string;
      updated_at?: string;
      rollup_created_at?: string | null;
    } | undefined;

  if (!row?.id || !row.repo) return null;

  return {
    id: row.id,
    repo: row.repo,
    botBranch: row.bot_branch ?? "",
    batchSize: row.batch_size ?? 0,
    status: (row.status ?? "open") as RollupBatchStatus,
    rollupPrUrl: row.rollup_pr_url ?? null,
    rollupPrNumber: row.rollup_pr_number ?? null,
    createdAt: row.created_at ?? nowIso(),
    updatedAt: row.updated_at ?? nowIso(),
    rollupCreatedAt: row.rollup_created_at ?? null,
  };
}
