import { existsSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { createHash, randomUUID } from "crypto";
import { Database } from "bun:sqlite";

import { getRalphHomeDir, getRalphStateDbPath, getSessionEventsPath } from "./paths";
import { applyGateArtifactPolicy, applyGateFieldPolicy, type ArtifactTruncationMode } from "./gates/artifact-policy";
import { isSafeSessionId } from "./session-id";
import type { AlertKind, AlertTargetType } from "./alerts/core";
import {
  evaluateDurableStateCapability,
  formatReadableSchemaRange,
  formatWritableSchemaRange,
  normalizeSchemaWindow,
  type DurableStateCapability,
  type DurableStateCapabilityVerdict,
  type DurableStateSchemaWindow,
} from "./durable-state-capability";

const SCHEMA_VERSION = 24;
const MIN_SUPPORTED_SCHEMA_VERSION = 1;
const MAX_READABLE_SCHEMA_VERSION = SCHEMA_VERSION + 1;
const DEFAULT_MIGRATION_BUSY_TIMEOUT_MS = 3_000;
const DEFAULT_PROBE_BUSY_TIMEOUT_MS = 250;

const DURABLE_STATE_SCHEMA_WINDOW: DurableStateSchemaWindow = normalizeSchemaWindow({
  minReadableSchema: MIN_SUPPORTED_SCHEMA_VERSION,
  maxReadableSchema: MAX_READABLE_SCHEMA_VERSION,
  maxWritableSchema: SCHEMA_VERSION,
});

export type DurableStateIssueCode = "forward_incompatible" | "lock_timeout" | "invariant_failure" | "unknown";

export type DurableStateStatus =
  | {
      ok: true;
      verdict: "readable_writable" | "readable_readonly_forward_newer";
      canReadState: true;
      canWriteState: boolean;
      requiresMigration: boolean;
      schemaVersion?: number;
      minReadableSchema: number;
      maxReadableSchema: number;
      maxWritableSchema: number;
      supportedRange: string;
      writableRange: string;
    }
  | {
      ok: false;
      code: DurableStateIssueCode;
      message: string;
      verdict?: DurableStateCapabilityVerdict;
      canReadState?: boolean;
      canWriteState?: boolean;
      requiresMigration?: boolean;
      schemaVersion?: number;
      supportedRange?: string;
      writableRange?: string;
      minReadableSchema?: number;
      maxReadableSchema?: number;
      maxWritableSchema?: number;
    };

function parsePositiveIntEnv(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  if (normalized <= 0) return null;
  return normalized;
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export type PrState = "open" | "merged";
export type RalphRunOutcome = "success" | "paused" | "throttled" | "escalated" | "failed";
export type RalphRunAttemptKind = "process" | "resume";
export type RalphRunTracePointerKind = "run_log_path" | "session_events_path";
export type RalphRunTracePointer = {
  runId: string;
  kind: RalphRunTracePointerKind;
  sessionId: string | null;
  path: string;
  createdAt: string;
  updatedAt: string;
};
export type RalphRunDetails = {
  reasonCode?: string;
  errorCode?: string;
  escalationType?: string;
  prUrl?: string;
  completionKind?: "pr" | "verified";
  noPrTerminalReason?: string;
  prEvidenceCauseCode?: string;
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

export type GateName = "preflight" | "plan_review" | "product_review" | "devex_review" | "ci" | "pr_evidence";
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

export type LoopTriageAttemptState = {
  repo: string;
  issueNumber: number;
  signature: string;
  attemptCount: number;
  lastDecision: string | null;
  lastRationale: string | null;
  lastUpdatedAtMs: number;
};

export type CiQuarantineFollowupMapping = {
  repo: string;
  signature: string;
  issueNumber: number;
  issueUrl: string;
  sourceIssueNumber: number;
  updatedAt: string;
};

const GATE_NAMES: GateName[] = ["preflight", "plan_review", "product_review", "devex_review", "ci", "pr_evidence"];
const GATE_STATUSES: GateStatus[] = ["pending", "pass", "fail", "skipped"];
const GATE_ARTIFACT_KINDS: GateArtifactKind[] = ["command_output", "failure_excerpt", "note"];
const GATE_NAME_CHECK_CONSTRAINT_SQL = `CHECK (gate IN (${GATE_NAMES.map((gate) => quoteSqlLiteral(gate)).join(", ")}))`;

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
  const noPrTerminalReason = sanitizeRunDetailString(details.noPrTerminalReason, 120);
  const prEvidenceCauseCode = sanitizeRunDetailString(details.prEvidenceCauseCode, 64);

  if (reasonCode) sanitized.reasonCode = reasonCode;
  if (errorCode) sanitized.errorCode = errorCode;
  if (escalationType) sanitized.escalationType = escalationType;
  if (prUrl) sanitized.prUrl = prUrl;
  if (completionKind) sanitized.completionKind = completionKind;
  if (noPrTerminalReason) sanitized.noPrTerminalReason = noPrTerminalReason;
  if (prEvidenceCauseCode) sanitized.prEvidenceCauseCode = prEvidenceCauseCode;
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

function requireDb(): Database {
  if (!db) {
    throw new Error("State DB not initialized. Call initStateDb() at startup.");
  }
  return db;
}

function tableExists(database: Database, name: string): boolean {
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = $name")
    .get({ $name: name }) as { name?: string } | undefined;
  return row?.name === name;
}

function schemaObjectType(database: Database, name: string): string | null {
  const row = database
    .query("SELECT type FROM sqlite_master WHERE name = $name")
    .get({ $name: name }) as { type?: string } | undefined;
  return row?.type ?? null;
}

function tableCreateSql(database: Database, name: string): string | null {
  const row = database
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $name")
    .get({ $name: name }) as { sql?: string } | undefined;
  return row?.sql ?? null;
}

function indexExists(database: Database, name: string): boolean {
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = $name")
    .get({ $name: name }) as { name?: string } | undefined;
  return row?.name === name;
}

function columnExists(database: Database, tableName: string, columnName: string): boolean {
  if (!tableExists(database, tableName)) return false;
  const rows = database
    .query(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(database: Database, tableName: string, columnName: string, definition: string): void {
  if (!tableExists(database, tableName)) return;
  if (columnExists(database, tableName, columnName)) return;
  database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function gateConstraintIncludes(tableSql: string | null, gateName: GateName): boolean {
  if (!tableSql) return false;
  return tableSql.includes(quoteSqlLiteral(gateName));
}

function requiresGateEnumRepair(database: Database): boolean {
  if (!tableExists(database, "ralph_run_gate_results") || !tableExists(database, "ralph_run_gate_artifacts")) {
    return false;
  }
  const gateResultsSql = tableCreateSql(database, "ralph_run_gate_results");
  const gateArtifactsSql = tableCreateSql(database, "ralph_run_gate_artifacts");
  for (const gateName of GATE_NAMES) {
    if (!gateConstraintIncludes(gateResultsSql, gateName) || !gateConstraintIncludes(gateArtifactsSql, gateName)) {
      return true;
    }
  }
  return false;
}

function rebuildGateTablesForCurrentGateSet(database: Database): void {
  const hasReason = columnExists(database, "ralph_run_gate_results", "reason");
  const hasArtifactPolicyVersion = columnExists(database, "ralph_run_gate_artifacts", "artifact_policy_version");
  const hasTruncationMode = columnExists(database, "ralph_run_gate_artifacts", "truncation_mode");
  const resultsInsert = hasReason
    ? `
      INSERT INTO ralph_run_gate_results_repaired(
        run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
      )
      SELECT
        run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
      FROM ralph_run_gate_results;
    `
    : `
      INSERT INTO ralph_run_gate_results_repaired(
        run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
      )
      SELECT
        run_id, gate, status, command, skip_reason, NULL, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
      FROM ralph_run_gate_results;
    `;

  const artifactsInsert =
    hasArtifactPolicyVersion && hasTruncationMode
      ? `
      INSERT INTO ralph_run_gate_artifacts_repaired(
        id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
      )
      SELECT
        id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
      FROM ralph_run_gate_artifacts;
    `
      : `
      INSERT INTO ralph_run_gate_artifacts_repaired(
        id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
      )
      SELECT
        id, run_id, gate, kind, content, truncated, original_chars, original_lines, 0, 'tail', created_at, updated_at
      FROM ralph_run_gate_artifacts;
    `;

  database.exec(`
    CREATE TABLE ralph_run_gate_results_repaired (
      run_id TEXT NOT NULL,
      gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
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
    ${resultsInsert}
    DROP TABLE ralph_run_gate_results;
    ALTER TABLE ralph_run_gate_results_repaired RENAME TO ralph_run_gate_results;

    CREATE TABLE ralph_run_gate_artifacts_repaired (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
      kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
      content TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      original_chars INTEGER,
      original_lines INTEGER,
      artifact_policy_version INTEGER NOT NULL DEFAULT 0,
      truncation_mode TEXT NOT NULL DEFAULT 'tail',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
    );
    ${artifactsInsert}
    DROP TABLE ralph_run_gate_artifacts;
    ALTER TABLE ralph_run_gate_artifacts_repaired RENAME TO ralph_run_gate_artifacts;

    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
      ON ralph_run_gate_results(repo_id, issue_number, updated_at);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
      ON ralph_run_gate_results(repo_id, pr_number);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
      ON ralph_run_gate_artifacts(run_id);

    INSERT OR IGNORE INTO ralph_run_gate_results(
      run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
    )
    SELECT
      r.run_id,
      'plan_review',
      'pending',
      r.repo_id,
      r.issue_number,
      r.task_path,
      r.started_at,
      r.started_at
    FROM ralph_runs r;
  `);
}

function applyGateEnumRepair(database: Database): void {
  if (!requiresGateEnumRepair(database)) return;
  if (
    !tableExists(database, "ralph_run_gate_results") ||
    !tableExists(database, "ralph_run_gate_artifacts") ||
    !tableExists(database, "ralph_runs") ||
    !tableExists(database, "repos")
  ) {
    throw formatSchemaInvariantError("gate enum drift detected but required tables are missing and cannot be rebuilt safely");
  }
  rebuildGateTablesForCurrentGateSet(database);
}

type SchemaInvariant =
  | {
      kind: "column";
      tableName: string;
      columnName: string;
      definition: string;
    }
  | {
      kind: "index";
      tableName: string;
      indexName: string;
      createSql: string;
    };

const SCHEMA_INVARIANTS: SchemaInvariant[] = [
  {
    kind: "column",
    tableName: "ralph_run_gate_results",
    columnName: "reason",
    definition: "TEXT",
  },
  {
    kind: "column",
    tableName: "ralph_run_gate_artifacts",
    columnName: "artifact_policy_version",
    definition: "INTEGER NOT NULL DEFAULT 0",
  },
  {
    kind: "column",
    tableName: "ralph_run_gate_artifacts",
    columnName: "truncation_mode",
    definition: "TEXT NOT NULL DEFAULT 'tail'",
  },
  {
    kind: "index",
    tableName: "ralph_run_gate_results",
    indexName: "idx_ralph_run_gate_results_repo_issue_updated",
    createSql:
      "CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated ON ralph_run_gate_results(repo_id, issue_number, updated_at)",
  },
  {
    kind: "index",
    tableName: "ralph_run_gate_results",
    indexName: "idx_ralph_run_gate_results_repo_pr",
    createSql: "CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr ON ralph_run_gate_results(repo_id, pr_number)",
  },
];

function formatSchemaInvariantError(message: string): Error {
  return new Error(
    `state.sqlite schema invariant failed: ${message}. ` +
      `Expected durable-state shape for schema_version=${SCHEMA_VERSION}. ` +
      "If this persists after restarting the latest Ralph binary, restore from backup and retry."
  );
}

function ensureSchemaInvariantObjectTypes(database: Database): void {
  const tableNames = new Set(SCHEMA_INVARIANTS.map((invariant) => invariant.tableName));
  for (const tableName of tableNames) {
    const objectType = schemaObjectType(database, tableName);
    if (objectType && objectType !== "table") {
      throw formatSchemaInvariantError(
        `table=${tableName} has incompatible object type=${objectType}; expected table`
      );
    }
  }
}

function applySchemaInvariants(database: Database): void {
  for (const invariant of SCHEMA_INVARIANTS) {
    if (!tableExists(database, invariant.tableName)) {
      throw formatSchemaInvariantError(
        `table=${invariant.tableName} is missing and cannot be repaired additively`
      );
    }

    if (invariant.kind === "column") {
      if (columnExists(database, invariant.tableName, invariant.columnName)) continue;
      try {
        addColumnIfMissing(database, invariant.tableName, invariant.columnName, invariant.definition);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw formatSchemaInvariantError(
          `table=${invariant.tableName} missing column=${invariant.columnName}; additive repair failed: ${detail}`
        );
      }
      if (!columnExists(database, invariant.tableName, invariant.columnName)) {
        throw formatSchemaInvariantError(
          `table=${invariant.tableName} missing column=${invariant.columnName}; additive repair did not apply`
        );
      }
      continue;
    }

    if (indexExists(database, invariant.indexName)) continue;
    try {
      database.exec(invariant.createSql);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw formatSchemaInvariantError(
        `table=${invariant.tableName} missing index=${invariant.indexName}; additive repair failed: ${detail}`
      );
    }
    if (!indexExists(database, invariant.indexName)) {
      throw formatSchemaInvariantError(
        `table=${invariant.tableName} missing index=${invariant.indexName}; additive repair did not apply`
      );
    }
  }
}

function requiresSchemaInvariantRepair(database: Database): boolean {
  for (const invariant of SCHEMA_INVARIANTS) {
    if (!tableExists(database, invariant.tableName)) continue;
    if (invariant.kind === "column" && !columnExists(database, invariant.tableName, invariant.columnName)) {
      return true;
    }
    if (invariant.kind === "index" && !indexExists(database, invariant.indexName)) {
      return true;
    }
  }
  return false;
}

function readSchemaVersion(database: Database): number | null {
  const existing = database
    .query("SELECT value FROM meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  const raw = existing?.value?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid state.sqlite schema_version value: ${raw}`);
  }
  const normalized = Math.floor(parsed);
  if (normalized <= 0) {
    throw new Error(`Invalid state.sqlite schema_version value: ${raw}`);
  }
  return normalized;
}

export function getDurableStateSchemaWindow(): DurableStateSchemaWindow {
  return DURABLE_STATE_SCHEMA_WINDOW;
}

function getSchemaWindowDetails() {
  return {
    minReadableSchema: DURABLE_STATE_SCHEMA_WINDOW.minReadableSchema,
    maxReadableSchema: DURABLE_STATE_SCHEMA_WINDOW.maxReadableSchema,
    maxWritableSchema: DURABLE_STATE_SCHEMA_WINDOW.maxWritableSchema,
    supportedRange: formatReadableSchemaRange(DURABLE_STATE_SCHEMA_WINDOW),
    writableRange: formatWritableSchemaRange(DURABLE_STATE_SCHEMA_WINDOW),
  };
}

function buildReadableDurableStateStatus(
  verdict: "readable_writable" | "readable_readonly_forward_newer",
  schemaVersion?: number
): Extract<DurableStateStatus, { ok: true }> {
  const writable = verdict === "readable_writable";
  return {
    ok: true,
    verdict,
    canReadState: true,
    canWriteState: writable,
    requiresMigration: !writable,
    schemaVersion,
    ...getSchemaWindowDetails(),
  };
}

function formatSchemaCompatibilityError(capability: DurableStateCapability): string {
  if (capability.verdict === "readable_readonly_forward_newer") {
    return (
      `state.sqlite schema_version=${capability.schemaVersion} is readable but not writable by this Ralph binary; ` +
      `readable range=${formatReadableSchemaRange(capability)} writable range=${formatWritableSchemaRange(capability)}. ` +
      "Upgrade Ralph to a compatible/newer binary before restarting daemon write paths. " +
      "Status-style read-only diagnostics remain available."
    );
  }
  return (
    `Unsupported state.sqlite schema_version=${capability.schemaVersion}; ` +
    `supported range=${formatReadableSchemaRange(capability)} writable range=${formatWritableSchemaRange(capability)}. ` +
    "Upgrade Ralph to a compatible/newer binary before restarting. " +
    "If you must run an older binary, restore a compatible state.sqlite backup first."
  );
}

class DurableStateInitError extends Error {
  readonly status: Extract<DurableStateStatus, { ok: false }>;

  constructor(status: Extract<DurableStateStatus, { ok: false }>) {
    super(status.message);
    this.name = "DurableStateInitError";
    this.status = status;
  }
}

function buildForwardCompatibilityFailure(capability: DurableStateCapability): Extract<DurableStateStatus, { ok: false }> {
  const details = getSchemaWindowDetails();
  return {
    ok: false,
    code: "forward_incompatible",
    message: formatSchemaCompatibilityError(capability),
    verdict: capability.verdict,
    canReadState: capability.canReadState,
    canWriteState: capability.canWriteState,
    requiresMigration: capability.requiresMigration,
    schemaVersion: capability.schemaVersion,
    ...details,
  };
}

function throwForwardCompatibilityFailure(capability: DurableStateCapability): never {
  throw new DurableStateInitError(buildForwardCompatibilityFailure(capability));
}

export function classifyDurableStateInitError(error: unknown): Extract<DurableStateStatus, { ok: false }> {
  if (error instanceof DurableStateInitError) {
    return error.status;
  }
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("unsupported state.sqlite schema_version=") ||
    normalized.includes("state.sqlite schema_version=")
  ) {
    const details = getSchemaWindowDetails();
    return {
      ok: false,
      code: "forward_incompatible",
      message,
      ...details,
    };
  }
  if (normalized.includes("schema invariant failed")) {
      return {
        ok: false,
        code: "invariant_failure",
        message,
        verdict: "unreadable_invariant_failure",
        canReadState: false,
        canWriteState: false,
        requiresMigration: false,
        ...getSchemaWindowDetails(),
      };
  }
  if (normalized.includes("migration lock timeout") || normalized.includes("database is locked")) {
    return {
      ok: false,
      code: "lock_timeout",
      message,
    };
  }
  return {
    ok: false,
    code: "unknown",
    message,
  };
}

export function isDurableStateInitError(error: unknown): boolean {
  const classified = classifyDurableStateInitError(error);
  return classified.code !== "unknown";
}

export function probeDurableState(): DurableStateStatus {
  const stateDbPath = getRalphStateDbPath();
  if (!existsSync(stateDbPath)) return buildReadableDurableStateStatus("readable_writable");

  let probeDb: Database | null = null;
  try {
    const busyTimeoutMs =
      parsePositiveIntEnv("RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS") ?? DEFAULT_PROBE_BUSY_TIMEOUT_MS;
    probeDb = new Database(stateDbPath, { readonly: true });
    probeDb.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    const hasMeta = tableExists(probeDb, "meta");
    if (!hasMeta) return buildReadableDurableStateStatus("readable_writable");

    const schemaVersion = readSchemaVersion(probeDb);
    if (schemaVersion) {
      const capability = evaluateDurableStateCapability({
        schemaVersion,
        window: DURABLE_STATE_SCHEMA_WINDOW,
      });
      if (!capability.canReadState) {
        return buildForwardCompatibilityFailure(capability);
      }
      if (capability.verdict === "readable_readonly_forward_newer") {
        return buildReadableDurableStateStatus(capability.verdict, capability.schemaVersion);
      }
    }

    ensureSchemaInvariantObjectTypes(probeDb);
    return buildReadableDurableStateStatus("readable_writable", schemaVersion ?? undefined);
  } catch (error) {
    return classifyDurableStateInitError(error);
  } finally {
    try {
      probeDb?.close();
    } catch {
      // Best effort close for probe connections.
    }
  }
}

function runIntegrityCheck(database: Database): void {
  const rows = database
    .query("PRAGMA integrity_check")
    .all() as Array<{ integrity_check?: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    const details = rows.map((row) => row.integrity_check ?? "unknown").join("; ");
    throw new Error(
      `state.sqlite integrity_check failed before migration: ${details || "unknown"}. ` +
        "Restore from backup and retry with a compatible/newer Ralph binary."
    );
  }
}

function validateBackupIntegrity(backupPath: string): void {
  const backupDb = new Database(backupPath, { readonly: true });
  try {
    const rows = backupDb.query("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      const details = rows.map((row) => row.integrity_check ?? "unknown").join("; ");
      throw new Error(`Backup integrity_check failed: ${details || "unknown"}`);
    }
  } finally {
    backupDb.close();
  }
}

type StateBackupMetadata = {
  backupPath: string;
  createdAt: string;
  fromVersion: number;
  sha256: string;
  sizeBytes: number;
};

function createBackupBeforeSchemaMutation(database: Database, stateDbPath: string, fromVersion: number): StateBackupMetadata {
  const configuredDir = process.env.RALPH_STATE_DB_BACKUP_DIR?.trim();
  const backupDir = configuredDir || dirname(stateDbPath);
  mkdirSync(backupDir, { recursive: true });
  const createdAt = nowIso();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `state.schema-v${fromVersion}.${timestamp}.backup.sqlite`);
  database.exec(`VACUUM INTO ${quoteSqlLiteral(backupPath)}`);
  validateBackupIntegrity(backupPath);
  const sizeBytes = statSync(backupPath).size;
  const sha256 = sha256Hex(readFileSync(backupPath));
  return {
    backupPath,
    createdAt,
    fromVersion,
    sha256,
    sizeBytes,
  };
}

const MIGRATION_CHECKPOINT_INVARIANT_REPAIR = "invariant-repair";
const MIGRATION_CHECKSUM_INVARIANT_REPAIR = sha256Hex("state:invariant-repair:v22");

function ensureStateMigrationTables(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS state_migration_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      backup_path TEXT NOT NULL,
      backup_sha256 TEXT,
      backup_size_bytes INTEGER,
      backup_created_at TEXT NOT NULL,
      integrity_check_result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_state_migration_backups_path ON state_migration_backups(backup_path);

    CREATE TABLE IF NOT EXISTS state_migration_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      checksum TEXT NOT NULL,
      backup_id INTEGER,
      applied_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(backup_id) REFERENCES state_migration_backups(id) ON DELETE SET NULL,
      UNIQUE(from_schema_version, to_schema_version, checkpoint, checksum)
    );

    CREATE TABLE IF NOT EXISTS state_migration_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      backup_id INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(backup_id) REFERENCES state_migration_backups(id) ON DELETE SET NULL
    );
  `);
}

function recordStateMigrationBackup(database: Database, metadata: StateBackupMetadata, toVersion: number): number {
  database
    .query(
      `INSERT INTO state_migration_backups(
         from_schema_version,
         to_schema_version,
         backup_path,
         backup_sha256,
         backup_size_bytes,
         backup_created_at,
         integrity_check_result,
         created_at
       )
       VALUES($from_schema_version, $to_schema_version, $backup_path, $backup_sha256, $backup_size_bytes, $backup_created_at, 'ok', $created_at)`
    )
    .run({
      $from_schema_version: metadata.fromVersion,
      $to_schema_version: toVersion,
      $backup_path: metadata.backupPath,
      $backup_sha256: metadata.sha256,
      $backup_size_bytes: metadata.sizeBytes,
      $backup_created_at: metadata.createdAt,
      $created_at: metadata.createdAt,
    });

  const row = database
    .query("SELECT id FROM state_migration_backups WHERE backup_path = $backup_path")
    .get({ $backup_path: metadata.backupPath }) as { id?: number } | undefined;
  if (!row?.id) {
    throw new Error(`Failed to record migration backup metadata for ${metadata.backupPath}`);
  }
  return row.id;
}

function recordStateMigrationCheckpoint(
  database: Database,
  params: {
    fromVersion: number;
    toVersion: number;
    checkpoint: string;
    checksum: string;
    backupId: number | null;
    appliedAt: string;
  }
): void {
  database
    .query(
      `INSERT INTO state_migration_ledger(
         from_schema_version,
         to_schema_version,
         checkpoint,
         checksum,
         backup_id,
         applied_at,
         created_at
       )
       VALUES($from_schema_version, $to_schema_version, $checkpoint, $checksum, $backup_id, $applied_at, $created_at)
       ON CONFLICT(from_schema_version, to_schema_version, checkpoint, checksum) DO NOTHING`
    )
    .run({
      $from_schema_version: params.fromVersion,
      $to_schema_version: params.toVersion,
      $checkpoint: params.checkpoint,
      $checksum: params.checksum,
      $backup_id: params.backupId,
      $applied_at: params.appliedAt,
      $created_at: params.appliedAt,
    });
}

function runMigrationsWithLock(database: Database, migrate: () => void): void {
  const busyTimeoutMs =
    parsePositiveIntEnv("RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS") ?? DEFAULT_MIGRATION_BUSY_TIMEOUT_MS;
  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);

  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("database is locked")) {
      throw new Error(
        `state.sqlite migration lock timeout after ${busyTimeoutMs}ms. ` +
          "Another process is using the state DB; stop/drain the other daemon and retry."
      );
    }
    throw error;
  }

  let committed = false;
  try {
    migrate();
    database.exec("COMMIT");
    committed = true;
  } finally {
    if (!committed) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // Best effort rollback after failed migration.
      }
    }
  }
}

function toMigrationLockError(error: unknown, busyTimeoutMs: number): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("database is locked")) {
    return new Error(
      `state.sqlite migration lock timeout after ${busyTimeoutMs}ms. ` +
        "Another process is using the state DB; stop/drain the other daemon and retry."
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function ensureSchema(database: Database, stateDbPath: string): void {
  const busyTimeoutMs =
    parsePositiveIntEnv("RALPH_STATE_DB_MIGRATION_BUSY_TIMEOUT_MS") ?? DEFAULT_MIGRATION_BUSY_TIMEOUT_MS;
  const hasMetaTable = tableExists(database, "meta");
  const existingVersion = hasMetaTable ? readSchemaVersion(database) : null;
  const needsVersionMigration = Boolean(existingVersion && existingVersion < SCHEMA_VERSION);
  const needsSchemaInvariantRepair = !needsVersionMigration && requiresSchemaInvariantRepair(database);
  const needsGateEnumRepair = !needsVersionMigration && requiresGateEnumRepair(database);
  const needsInvariantRepair = needsSchemaInvariantRepair || needsGateEnumRepair;

  if (existingVersion) {
    const capability = evaluateDurableStateCapability({
      schemaVersion: existingVersion,
      window: DURABLE_STATE_SCHEMA_WINDOW,
    });
    if (!capability.canWriteState) {
      throwForwardCompatibilityFailure(capability);
    }
  }

  let backupMetadata: StateBackupMetadata | null = null;
  let recordedBackupId: number | null = null;
  if ((needsVersionMigration || needsInvariantRepair) && existsSync(stateDbPath)) {
    const fromVersion = existingVersion ?? SCHEMA_VERSION;
    backupMetadata = createBackupBeforeSchemaMutation(database, stateDbPath, fromVersion);
  }

  database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  try {
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec("PRAGMA synchronous = NORMAL;");
    database.exec("PRAGMA foreign_keys = ON;");

    database.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    );

  if (needsVersionMigration && existingVersion) {
    runMigrationsWithLock(database, () => {
      const lockedVersion = readSchemaVersion(database);
      if (!lockedVersion || lockedVersion >= SCHEMA_VERSION) return;
      const lockedCapability = evaluateDurableStateCapability({
        schemaVersion: lockedVersion,
        window: DURABLE_STATE_SCHEMA_WINDOW,
      });
      if (!lockedCapability.canWriteState) {
        throwForwardCompatibilityFailure(lockedCapability);
      }

      runIntegrityCheck(database);

      const fromVersion = lockedVersion;
      database.transaction(() => {
        const existingVersion = fromVersion;
        ensureStateMigrationTables(database);
        const backupId = backupMetadata ? recordStateMigrationBackup(database, backupMetadata, SCHEMA_VERSION) : null;
        recordedBackupId = backupId;
        const attemptAt = nowIso();
        database
          .query(
            `INSERT INTO state_migration_attempts(
               from_schema_version,
               to_schema_version,
               backup_id,
               started_at,
               completed_at,
               created_at,
               updated_at
             )
             VALUES($from_schema_version, $to_schema_version, $backup_id, $started_at, $completed_at, $created_at, $updated_at)`
          )
          .run({
            $from_schema_version: existingVersion,
            $to_schema_version: SCHEMA_VERSION,
            $backup_id: backupId,
            $started_at: attemptAt,
            $completed_at: attemptAt,
            $created_at: attemptAt,
            $updated_at: attemptAt,
          });

        if (existingVersion < 3) {
          addColumnIfMissing(database, "tasks", "worker_id", "TEXT");
          addColumnIfMissing(database, "tasks", "repo_slot", "TEXT");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 3,
            checkpoint: "v3-tasks-worker-slot",
            checksum: sha256Hex("state:migration:v3-tasks-worker-slot"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 4) {
          addColumnIfMissing(database, "issues", "github_node_id", "TEXT");
          addColumnIfMissing(database, "issues", "github_updated_at", "TEXT");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 4,
            checkpoint: "v4-issues-github-columns",
            checksum: sha256Hex("state:migration:v4-issues-github-columns"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 5) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS repo_github_issue_sync (repo_id INTEGER PRIMARY KEY, last_sync_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
          );
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 5,
            checkpoint: "v5-repo-github-issue-sync",
            checksum: sha256Hex("state:migration:v5-repo-github-issue-sync"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 6) {
          addColumnIfMissing(database, "tasks", "daemon_id", "TEXT");
          addColumnIfMissing(database, "tasks", "heartbeat_at", "TEXT");
          database.exec(
            "UPDATE tasks SET task_path = 'github:' || (SELECT name FROM repos r WHERE r.id = tasks.repo_id) || '#' || tasks.issue_number " +
              "WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL"
          );
          database.exec(
            "DELETE FROM tasks WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL AND rowid NOT IN (" +
              "SELECT MAX(rowid) FROM tasks WHERE task_path LIKE 'github:%' AND issue_number IS NOT NULL GROUP BY repo_id, issue_number" +
              ")"
          );
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 6,
            checkpoint: "v6-task-daemon-heartbeat-path-dedupe",
            checksum: sha256Hex("state:migration:v6-task-daemon-heartbeat-path-dedupe"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 7) {
          database.exec(
              "CREATE TABLE IF NOT EXISTS repo_github_done_reconcile_cursor (repo_id INTEGER PRIMARY KEY, last_merged_at TEXT NOT NULL, last_pr_number INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
          );
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 7,
            checkpoint: "v7-done-reconcile-cursor",
            checksum: sha256Hex("state:migration:v7-done-reconcile-cursor"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 8) {
          addColumnIfMissing(database, "tasks", "session_events_path", "TEXT");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 8,
            checkpoint: "v8-tasks-session-events-path",
            checksum: sha256Hex("state:migration:v8-tasks-session-events-path"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 16) {
          addColumnIfMissing(database, "ralph_run_gate_results", "reason", "TEXT");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 16,
            checkpoint: "v16-run-gate-reason-column",
            checksum: sha256Hex("state:migration:v16-run-gate-reason-column"),
            backupId,
            appliedAt: nowIso(),
          });
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
          addColumnIfMissing(database, "repos", "label_write_blocked_until_ms", "INTEGER");
          addColumnIfMissing(database, "repos", "label_write_last_error", "TEXT");
          addColumnIfMissing(database, "tasks", "released_at_ms", "INTEGER");
          addColumnIfMissing(database, "tasks", "released_reason", "TEXT");

        database.exec(`
          CREATE TABLE IF NOT EXISTS ralph_run_gate_results (
            run_id TEXT NOT NULL,
            gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
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
          CREATE TABLE IF NOT EXISTS ralph_run_gate_artifacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
            kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
            content TEXT NOT NULL,
            truncated INTEGER NOT NULL DEFAULT 0,
            original_chars INTEGER,
            original_lines INTEGER,
            artifact_policy_version INTEGER NOT NULL DEFAULT 0,
            truncation_mode TEXT NOT NULL DEFAULT 'tail',
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
          addColumnIfMissing(database, "issue_escalation_comment_checks", "last_resolved_comment_id", "INTEGER");
          addColumnIfMissing(database, "issue_escalation_comment_checks", "last_resolved_comment_at", "TEXT");
        }
        if (existingVersion < 11) {
          addColumnIfMissing(database, "alert_deliveries", "comment_id", "INTEGER");
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
            triage_score REAL,
            triage_reasons_json TEXT NOT NULL DEFAULT '[]',
            triage_computed_at TEXT,
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
          CREATE INDEX IF NOT EXISTS idx_ralph_run_metrics_triage_score
            ON ralph_run_metrics(triage_score);
          `);
        }


        if (existingVersion < 14) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS repo_github_issue_sync_bootstrap_cursor (repo_id INTEGER PRIMARY KEY, next_url TEXT NOT NULL, high_watermark_updated_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE)"
          );
        }

        if (existingVersion < 15) {
          addColumnIfMissing(database, "repos", "label_scheme_error_code", "TEXT");
          addColumnIfMissing(database, "repos", "label_scheme_error_details", "TEXT");
          addColumnIfMissing(database, "repos", "label_scheme_checked_at", "TEXT");
          addColumnIfMissing(database, "ralph_run_metrics", "triage_score", "REAL");
          addColumnIfMissing(
            database,
            "ralph_run_metrics",
            "triage_reasons_json",
            "TEXT NOT NULL DEFAULT '[]'"
          );
          addColumnIfMissing(database, "ralph_run_metrics", "triage_computed_at", "TEXT");
          if (tableExists(database, "ralph_run_metrics")) {
            database.exec(
              "CREATE INDEX IF NOT EXISTS idx_ralph_run_metrics_triage_score ON ralph_run_metrics(triage_score)"
            );
          }
        }

        if (existingVersion < 16) {
          if (
            tableExists(database, "ralph_run_gate_results") &&
            tableExists(database, "ralph_run_gate_artifacts") &&
            tableExists(database, "ralph_runs") &&
            tableExists(database, "repos")
          ) {
            database.exec(`
              CREATE TABLE ralph_run_gate_results_new (
                run_id TEXT NOT NULL,
                gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
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
              INSERT INTO ralph_run_gate_results_new(
                run_id, gate, status, command, skip_reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
              )
              SELECT
                run_id, gate, status, command, skip_reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
              FROM ralph_run_gate_results;
              DROP TABLE ralph_run_gate_results;
              ALTER TABLE ralph_run_gate_results_new RENAME TO ralph_run_gate_results;

              CREATE TABLE ralph_run_gate_artifacts_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
                kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
                content TEXT NOT NULL,
                truncated INTEGER NOT NULL DEFAULT 0,
                original_chars INTEGER,
                original_lines INTEGER,
                artifact_policy_version INTEGER NOT NULL DEFAULT 0,
                truncation_mode TEXT NOT NULL DEFAULT 'tail',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
              );
              INSERT INTO ralph_run_gate_artifacts_new(
                id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
              )
              SELECT
                id, run_id, gate, kind, content, truncated, original_chars, original_lines, 0, 'tail', created_at, updated_at
              FROM ralph_run_gate_artifacts;
              DROP TABLE ralph_run_gate_artifacts;
              ALTER TABLE ralph_run_gate_artifacts_new RENAME TO ralph_run_gate_artifacts;

              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
                ON ralph_run_gate_results(repo_id, issue_number, updated_at);
              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
                ON ralph_run_gate_results(repo_id, pr_number);
              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
                ON ralph_run_gate_artifacts(run_id);
            `);
          }
        }

        if (existingVersion < 17) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS issue_status_transition_guard (" +
              "repo_id INTEGER NOT NULL, " +
              "issue_number INTEGER NOT NULL, " +
              "from_status TEXT, " +
              "to_status TEXT NOT NULL, " +
              "reason TEXT, " +
              "updated_at_ms INTEGER NOT NULL, " +
              "PRIMARY KEY(repo_id, issue_number), " +
              "FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE" +
              ")"
          );
          database.exec(
            "CREATE INDEX IF NOT EXISTS idx_issue_status_transition_guard_repo_updated ON issue_status_transition_guard(repo_id, updated_at_ms)"
          );
        }

        if (existingVersion < 18) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS loop_triage_attempts (" +
              "repo_id INTEGER NOT NULL, " +
              "issue_number INTEGER NOT NULL, " +
              "signature TEXT NOT NULL, " +
              "attempt_count INTEGER NOT NULL DEFAULT 0, " +
              "last_decision TEXT, " +
              "last_rationale TEXT, " +
              "last_updated_at_ms INTEGER NOT NULL, " +
              "PRIMARY KEY(repo_id, issue_number, signature), " +
              "FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE" +
              ")"
          );
          database.exec(
            "CREATE INDEX IF NOT EXISTS idx_loop_triage_attempts_repo_issue_updated " +
              "ON loop_triage_attempts(repo_id, issue_number, last_updated_at_ms)"
          );
        }

        if (existingVersion < 19) {
          const gateResultsSql = tableCreateSql(database, "ralph_run_gate_results");
          const gateArtifactsSql = tableCreateSql(database, "ralph_run_gate_artifacts");
          const needsGateResultsRepair =
            Boolean(gateResultsSql) && !gateResultsSql!.includes("pr_evidence");
          const needsGateArtifactsRepair =
            Boolean(gateArtifactsSql) && !gateArtifactsSql!.includes("pr_evidence");

          if (
            (needsGateResultsRepair || needsGateArtifactsRepair) &&
            tableExists(database, "ralph_run_gate_results") &&
            tableExists(database, "ralph_run_gate_artifacts") &&
            tableExists(database, "ralph_runs") &&
            tableExists(database, "repos")
          ) {
            const hasReason = columnExists(database, "ralph_run_gate_results", "reason");
            const resultsInsert = hasReason
              ? `
                INSERT INTO ralph_run_gate_results_repaired(
                  run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
                )
                SELECT
                  run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
                FROM ralph_run_gate_results;
              `
              : `
                INSERT INTO ralph_run_gate_results_repaired(
                  run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
                )
                SELECT
                  run_id, gate, status, command, skip_reason, NULL, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
                FROM ralph_run_gate_results;
              `;

            database.exec(`
              CREATE TABLE ralph_run_gate_results_repaired (
                run_id TEXT NOT NULL,
                gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
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
              ${resultsInsert}
              DROP TABLE ralph_run_gate_results;
              ALTER TABLE ralph_run_gate_results_repaired RENAME TO ralph_run_gate_results;

              CREATE TABLE ralph_run_gate_artifacts_repaired (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
                kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
                content TEXT NOT NULL,
                truncated INTEGER NOT NULL DEFAULT 0,
                original_chars INTEGER,
                original_lines INTEGER,
                artifact_policy_version INTEGER NOT NULL DEFAULT 0,
                truncation_mode TEXT NOT NULL DEFAULT 'tail',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(run_id) REFERENCES ralph_runs(run_id) ON DELETE CASCADE
              );
              INSERT INTO ralph_run_gate_artifacts_repaired(
                id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
              )
              SELECT
                id, run_id, gate, kind, content, truncated, original_chars, original_lines, 0, 'tail', created_at, updated_at
              FROM ralph_run_gate_artifacts;
              DROP TABLE ralph_run_gate_artifacts;
              ALTER TABLE ralph_run_gate_artifacts_repaired RENAME TO ralph_run_gate_artifacts;

              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
                ON ralph_run_gate_results(repo_id, issue_number, updated_at);
              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
                ON ralph_run_gate_results(repo_id, pr_number);
              CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
                ON ralph_run_gate_artifacts(run_id);
            `);
          }
        }

        if (existingVersion < 20) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS repo_github_in_bot_reconcile_cursor (" +
              "repo_id INTEGER PRIMARY KEY, " +
              "bot_branch TEXT NOT NULL, " +
              "last_merged_at TEXT NOT NULL, " +
              "last_pr_number INTEGER NOT NULL, " +
              "updated_at TEXT NOT NULL, " +
              "FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE" +
              ")"
          );
          database.exec(
            "CREATE TABLE IF NOT EXISTS repo_github_in_bot_pending (" +
              "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
              "repo_id INTEGER NOT NULL, " +
              "issue_number INTEGER NOT NULL, " +
              "pr_number INTEGER NOT NULL, " +
              "pr_url TEXT NOT NULL, " +
              "merged_at TEXT NOT NULL, " +
              "attempt_count INTEGER NOT NULL DEFAULT 0, " +
              "last_attempt_at TEXT NOT NULL, " +
              "last_error TEXT, " +
              "created_at TEXT NOT NULL, " +
              "updated_at TEXT NOT NULL, " +
              "FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE, " +
              "UNIQUE(repo_id, issue_number, pr_number)" +
              ")"
          );
          database.exec(
            "CREATE INDEX IF NOT EXISTS idx_repo_github_in_bot_pending_repo_updated " +
              "ON repo_github_in_bot_pending(repo_id, updated_at)"
          );
        }

        if (existingVersion < 21) {
          applyGateEnumRepair(database);
          if (
            tableExists(database, "ralph_run_gate_results") &&
            tableExists(database, "ralph_runs") &&
            tableExists(database, "repos")
          ) {
            database.exec(`
              INSERT OR IGNORE INTO ralph_run_gate_results(
                run_id, gate, status, repo_id, issue_number, task_path, created_at, updated_at
              )
              SELECT
                r.run_id,
                'plan_review',
                'pending',
                r.repo_id,
                r.issue_number,
                r.task_path,
                r.started_at,
                r.started_at
              FROM ralph_runs r;
            `);
          }
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 21,
            checkpoint: "v21-plan-review-gate-record",
            checksum: sha256Hex("state:migration:v21-plan-review-gate-record"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 22) {
          addColumnIfMissing(database, "tasks", "blocked_source", "TEXT");
          addColumnIfMissing(database, "tasks", "blocked_reason", "TEXT");
          addColumnIfMissing(database, "tasks", "blocked_at", "TEXT");
          addColumnIfMissing(database, "tasks", "blocked_details", "TEXT");
          addColumnIfMissing(database, "tasks", "blocked_checked_at", "TEXT");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 22,
            checkpoint: "v22-tasks-blocked-columns",
            checksum: sha256Hex("state:migration:v22-tasks-blocked-columns"),
            backupId,
            appliedAt: nowIso(),
          });
        }

        if (existingVersion < 23) {
          addColumnIfMissing(database, "ralph_run_gate_artifacts", "artifact_policy_version", "INTEGER NOT NULL DEFAULT 0");
          addColumnIfMissing(database, "ralph_run_gate_artifacts", "truncation_mode", "TEXT NOT NULL DEFAULT 'tail'");
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 23,
            checkpoint: "v23-artifact-policy-columns",
            checksum: sha256Hex("state:migration:v23-artifact-policy-columns"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        if (existingVersion < 24) {
          database.exec(
            "CREATE TABLE IF NOT EXISTS ci_quarantine_followups (" +
              "repo_id INTEGER NOT NULL, " +
              "signature TEXT NOT NULL, " +
              "followup_issue_number INTEGER NOT NULL, " +
              "followup_issue_url TEXT NOT NULL, " +
              "source_issue_number INTEGER NOT NULL, " +
              "created_at TEXT NOT NULL, " +
              "updated_at TEXT NOT NULL, " +
              "PRIMARY KEY(repo_id, signature), " +
              "UNIQUE(repo_id, followup_issue_number), " +
              "FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE" +
              ")"
          );
          database.exec(
            "CREATE INDEX IF NOT EXISTS idx_ci_quarantine_followups_repo_source_updated " +
              "ON ci_quarantine_followups(repo_id, source_issue_number, updated_at)"
          );
          recordStateMigrationCheckpoint(database, {
            fromVersion: existingVersion,
            toVersion: 24,
            checkpoint: "v24-ci-quarantine-followup-mapping",
            checksum: sha256Hex("state:migration:v24-ci-quarantine-followup-mapping"),
            backupId,
            appliedAt: nowIso(),
          });
        }
        recordStateMigrationCheckpoint(database, {
          fromVersion: existingVersion,
          toVersion: SCHEMA_VERSION,
          checkpoint: `schema-v${SCHEMA_VERSION}-complete`,
          checksum: sha256Hex(`state:migration:schema-v${SCHEMA_VERSION}-complete`),
          backupId,
          appliedAt: nowIso(),
        });

        database.exec(
          `INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
           ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
        );
      })();
    });
  }

  database.exec(
    `INSERT INTO meta(key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value;`
  );

  ensureSchemaInvariantObjectTypes(database);

  database.exec(`
    CREATE TABLE IF NOT EXISTS repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      local_path TEXT,
      bot_branch TEXT,
      label_write_blocked_until_ms INTEGER,
      label_write_last_error TEXT,
      label_scheme_error_code TEXT,
      label_scheme_error_details TEXT,
      label_scheme_checked_at TEXT,
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
      blocked_source TEXT,
      blocked_reason TEXT,
      blocked_at TEXT,
      blocked_details TEXT,
      blocked_checked_at TEXT,
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

    CREATE TABLE IF NOT EXISTS repo_github_in_bot_reconcile_cursor (
      repo_id INTEGER PRIMARY KEY,
      bot_branch TEXT NOT NULL,
      last_merged_at TEXT NOT NULL,
      last_pr_number INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS repo_github_in_bot_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      issue_number INTEGER NOT NULL,
      pr_number INTEGER NOT NULL,
      pr_url TEXT NOT NULL,
      merged_at TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE,
      UNIQUE(repo_id, issue_number, pr_number)
    );
    CREATE INDEX IF NOT EXISTS idx_repo_github_in_bot_pending_repo_updated
      ON repo_github_in_bot_pending(repo_id, updated_at);

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

    CREATE TABLE IF NOT EXISTS ralph_run_trace_pointers (
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('run_log_path', 'session_events_path')),
      session_id TEXT,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(run_id, kind, session_id, path),
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
      triage_score REAL,
      triage_reasons_json TEXT NOT NULL DEFAULT '[]',
      triage_computed_at TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_ralph_run_metrics_triage_score
      ON ralph_run_metrics(triage_score);

    CREATE TABLE IF NOT EXISTS ralph_run_gate_results (
      run_id TEXT NOT NULL,
      gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
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

    CREATE TABLE IF NOT EXISTS ralph_run_gate_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      gate TEXT NOT NULL ${GATE_NAME_CHECK_CONSTRAINT_SQL},
      kind TEXT NOT NULL CHECK (kind IN ('command_output', 'failure_excerpt', 'note')),
      content TEXT NOT NULL,
      truncated INTEGER NOT NULL DEFAULT 0,
      original_chars INTEGER,
      original_lines INTEGER,
      artifact_policy_version INTEGER NOT NULL DEFAULT 0,
      truncation_mode TEXT NOT NULL DEFAULT 'tail',
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

    CREATE TABLE IF NOT EXISTS issue_status_transition_guard (
      repo_id INTEGER NOT NULL,
      issue_number INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      reason TEXT,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(repo_id, issue_number),
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS loop_triage_attempts (
      repo_id INTEGER NOT NULL,
      issue_number INTEGER NOT NULL,
      signature TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_decision TEXT,
      last_rationale TEXT,
      last_updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY(repo_id, issue_number, signature),
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ci_quarantine_followups (
      repo_id INTEGER NOT NULL,
      signature TEXT NOT NULL,
      followup_issue_number INTEGER NOT NULL,
      followup_issue_url TEXT NOT NULL,
      source_issue_number INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(repo_id, signature),
      UNIQUE(repo_id, followup_issue_number),
      FOREIGN KEY(repo_id) REFERENCES repos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS state_migration_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      backup_path TEXT NOT NULL,
      backup_sha256 TEXT,
      backup_size_bytes INTEGER,
      backup_created_at TEXT NOT NULL,
      integrity_check_result TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state_migration_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      checkpoint TEXT NOT NULL,
      checksum TEXT NOT NULL,
      backup_id INTEGER,
      applied_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(backup_id) REFERENCES state_migration_backups(id) ON DELETE SET NULL,
      UNIQUE(from_schema_version, to_schema_version, checkpoint, checksum)
    );

    CREATE TABLE IF NOT EXISTS state_migration_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_schema_version INTEGER,
      to_schema_version INTEGER NOT NULL,
      backup_id INTEGER,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(backup_id) REFERENCES state_migration_backups(id) ON DELETE SET NULL
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
    CREATE INDEX IF NOT EXISTS idx_ralph_runs_started_at ON ralph_runs(started_at);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_token_totals_tokens_total ON ralph_run_token_totals(tokens_total);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_trace_pointers_run ON ralph_run_trace_pointers(run_id);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_issue_updated
      ON ralph_run_gate_results(repo_id, issue_number, updated_at);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_results_repo_pr
      ON ralph_run_gate_results(repo_id, pr_number);
    CREATE INDEX IF NOT EXISTS idx_ralph_run_gate_artifacts_run
      ON ralph_run_gate_artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_alerts_repo_target ON alerts(repo_id, target_type, target_number, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert_channel ON alert_deliveries(alert_id, channel);
    CREATE INDEX IF NOT EXISTS idx_alert_deliveries_target ON alert_deliveries(target_type, target_number, status);
    CREATE INDEX IF NOT EXISTS idx_issue_status_transition_guard_repo_updated
      ON issue_status_transition_guard(repo_id, updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_loop_triage_attempts_repo_issue_updated
      ON loop_triage_attempts(repo_id, issue_number, last_updated_at_ms);
    CREATE INDEX IF NOT EXISTS idx_ci_quarantine_followups_repo_source_updated
      ON ci_quarantine_followups(repo_id, source_issue_number, updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_state_migration_backups_path ON state_migration_backups(backup_path);
  `);

  // Backstop for mixed/partially-migrated schema 22 states where meta schema_version
  // may already be 22 but blocked-* columns are still absent on tasks.
  addColumnIfMissing(database, "tasks", "blocked_source", "TEXT");
  addColumnIfMissing(database, "tasks", "blocked_reason", "TEXT");
  addColumnIfMissing(database, "tasks", "blocked_at", "TEXT");
  addColumnIfMissing(database, "tasks", "blocked_details", "TEXT");
  addColumnIfMissing(database, "tasks", "blocked_checked_at", "TEXT");

    runMigrationsWithLock(database, () => {
      database.transaction(() => {
        const neededSchemaInvariantRepair = requiresSchemaInvariantRepair(database);
        const neededGateEnumRepair = requiresGateEnumRepair(database);
        applySchemaInvariants(database);
        applyGateEnumRepair(database);
        if (!neededSchemaInvariantRepair && !neededGateEnumRepair) return;

        ensureStateMigrationTables(database);
        if (backupMetadata && recordedBackupId === null) {
          recordedBackupId = recordStateMigrationBackup(database, backupMetadata, SCHEMA_VERSION);
        }
        recordStateMigrationCheckpoint(database, {
          fromVersion: existingVersion ?? SCHEMA_VERSION,
          toVersion: SCHEMA_VERSION,
          checkpoint: MIGRATION_CHECKPOINT_INVARIANT_REPAIR,
          checksum: MIGRATION_CHECKSUM_INVARIANT_REPAIR,
          backupId: recordedBackupId,
          appliedAt: nowIso(),
        });
      })();
    });
  } catch (error) {
    throw toMigrationLockError(error, busyTimeoutMs);
  }
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
  ensureSchema(database, stateDbPath);

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

const RUNTIME_SNAPSHOT_KEY_PREFIX = "runtime_snapshot:";

function normalizeRuntimeSnapshotKey(key: string): string {
  const trimmed = String(key ?? "").trim();
  if (!trimmed) throw new Error("Runtime snapshot key must be non-empty");
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(trimmed)) {
    throw new Error(`Invalid runtime snapshot key: ${trimmed}`);
  }
  return `${RUNTIME_SNAPSHOT_KEY_PREFIX}${trimmed}`;
}

export function setRuntimeSnapshot(key: string, value: unknown | null): void {
  const database = requireDb();
  const metaKey = normalizeRuntimeSnapshotKey(key);
  if (value === null) {
    database.query("DELETE FROM meta WHERE key = $key").run({ $key: metaKey });
    return;
  }
  database
    .query(
      `INSERT INTO meta(key, value) VALUES ($key, $value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run({ $key: metaKey, $value: JSON.stringify(value) });
}

export function getRuntimeSnapshot<T = unknown>(key: string): T | null {
  const database = requireDb();
  const metaKey = normalizeRuntimeSnapshotKey(key);
  const row = database.query("SELECT value FROM meta WHERE key = $key").get({
    $key: metaKey,
  }) as { value?: string | null } | undefined;
  if (!row?.value) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
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

export type RepoGithubInBotCursor = {
  botBranch: string;
  lastMergedAt: string;
  lastPrNumber: number;
};

export type RepoGithubInBotPendingIssue = {
  repo: string;
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
  attemptCount: number;
  lastAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

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

export function getRepoGithubInBotReconcileCursor(repo: string): RepoGithubInBotCursor | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT c.bot_branch as bot_branch, c.last_merged_at as last_merged_at, c.last_pr_number as last_pr_number
       FROM repo_github_in_bot_reconcile_cursor c
       JOIN repos r ON r.id = c.repo_id
       WHERE r.name = $name`
    )
    .get({ $name: repo }) as
    | { bot_branch?: string; last_merged_at?: string; last_pr_number?: number }
    | undefined;

  if (!row?.bot_branch || !row.last_merged_at || typeof row.last_pr_number !== "number") return null;
  return {
    botBranch: row.bot_branch,
    lastMergedAt: row.last_merged_at,
    lastPrNumber: row.last_pr_number,
  };
}

export function recordRepoGithubInBotReconcileCursor(params: {
  repo: string;
  repoPath?: string;
  botBranch: string;
  lastMergedAt: string;
  lastPrNumber: number;
  updatedAt?: string;
}): void {
  const database = requireDb();
  const at = params.updatedAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });

  database
    .query(
      `INSERT INTO repo_github_in_bot_reconcile_cursor(repo_id, bot_branch, last_merged_at, last_pr_number, updated_at)
       VALUES ($repo_id, $bot_branch, $last_merged_at, $last_pr_number, $updated_at)
       ON CONFLICT(repo_id) DO UPDATE SET
         bot_branch = excluded.bot_branch,
         last_merged_at = excluded.last_merged_at,
         last_pr_number = excluded.last_pr_number,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $bot_branch: params.botBranch,
      $last_merged_at: params.lastMergedAt,
      $last_pr_number: params.lastPrNumber,
      $updated_at: at,
    });
}

export function clearRepoGithubInBotPendingIssues(repo: string): void {
  const database = requireDb();
  database
    .query(
      `DELETE FROM repo_github_in_bot_pending
       WHERE repo_id = (SELECT id FROM repos WHERE name = $name)`
    )
    .run({ $name: repo });
}

export function upsertRepoGithubInBotPendingIssue(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  issueNumber: number;
  prNumber: number;
  prUrl: string;
  mergedAt: string;
  attemptError?: string | null;
  attemptedAt?: string;
}): void {
  const database = requireDb();
  const at = params.attemptedAt ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, repoPath: params.repoPath, botBranch: params.botBranch, at });
  const errorText = sanitizeOptionalText(params.attemptError ?? null, 500) ?? null;

  database
    .query(
      `INSERT INTO repo_github_in_bot_pending(
         repo_id, issue_number, pr_number, pr_url, merged_at, attempt_count, last_attempt_at, last_error, created_at, updated_at
       ) VALUES (
         $repo_id, $issue_number, $pr_number, $pr_url, $merged_at, 1, $last_attempt_at, $last_error, $created_at, $updated_at
       )
       ON CONFLICT(repo_id, issue_number, pr_number) DO UPDATE SET
         pr_url = excluded.pr_url,
         merged_at = excluded.merged_at,
         attempt_count = repo_github_in_bot_pending.attempt_count + 1,
         last_attempt_at = excluded.last_attempt_at,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $pr_number: params.prNumber,
      $pr_url: params.prUrl,
      $merged_at: params.mergedAt,
      $last_attempt_at: at,
      $last_error: errorText,
      $created_at: at,
      $updated_at: at,
    });
}

export function listRepoGithubInBotPendingIssues(repo: string, limit = 50): RepoGithubInBotPendingIssue[] {
  const database = requireDb();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
  const rows = database
    .query(
      `SELECT r.name as repo,
              p.issue_number as issue_number,
              p.pr_number as pr_number,
              p.pr_url as pr_url,
              p.merged_at as merged_at,
              p.attempt_count as attempt_count,
              p.last_attempt_at as last_attempt_at,
              p.last_error as last_error,
              p.created_at as created_at,
              p.updated_at as updated_at
       FROM repo_github_in_bot_pending p
       JOIN repos r ON r.id = p.repo_id
       WHERE r.name = $name
       ORDER BY p.updated_at ASC
       LIMIT $limit`
    )
    .all({ $name: repo, $limit: safeLimit }) as Array<{
    repo?: string;
    issue_number?: number;
    pr_number?: number;
    pr_url?: string;
    merged_at?: string;
    attempt_count?: number;
    last_attempt_at?: string;
    last_error?: string | null;
    created_at?: string;
    updated_at?: string;
  }>;

  return rows
    .map((row) => {
      if (
        !row.repo ||
        typeof row.issue_number !== "number" ||
        typeof row.pr_number !== "number" ||
        !row.pr_url ||
        !row.merged_at ||
        !row.last_attempt_at ||
        !row.created_at ||
        !row.updated_at
      ) {
        return null;
      }
      return {
        repo: row.repo,
        issueNumber: row.issue_number,
        prNumber: row.pr_number,
        prUrl: row.pr_url,
        mergedAt: row.merged_at,
        attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      } satisfies RepoGithubInBotPendingIssue;
    })
    .filter((row): row is RepoGithubInBotPendingIssue => Boolean(row));
}

export function deleteRepoGithubInBotPendingIssue(params: { repo: string; issueNumber: number; prNumber: number }): void {
  const database = requireDb();
  const repoRow = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: params.repo,
  }) as { id?: number } | undefined;
  if (!repoRow?.id) return;

  database
    .query(
      `DELETE FROM repo_github_in_bot_pending
       WHERE repo_id = $repo_id AND issue_number = $issue_number AND pr_number = $pr_number`
    )
    .run({
      $repo_id: repoRow.id,
      $issue_number: params.issueNumber,
      $pr_number: params.prNumber,
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
  blockedSource?: string | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
  blockedDetails?: string | null;
  blockedCheckedAt?: string | null;
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
         repo_id, issue_number, task_path, task_name, status, session_id, session_events_path, worktree_path, worker_id, repo_slot, daemon_id, heartbeat_at, released_at_ms, released_reason, blocked_source, blocked_reason, blocked_at, blocked_details, blocked_checked_at, created_at, updated_at
       ) VALUES (
          $repo_id, $issue_number, $task_path, $task_name, $status, $session_id, $session_events_path, $worktree_path, $worker_id, $repo_slot, $daemon_id, $heartbeat_at, $released_at_ms, $released_reason, $blocked_source, $blocked_reason, $blocked_at, $blocked_details, $blocked_checked_at, $created_at, $updated_at
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
          blocked_source = excluded.blocked_source,
          blocked_reason = excluded.blocked_reason,
          blocked_at = excluded.blocked_at,
          blocked_details = excluded.blocked_details,
          blocked_checked_at = excluded.blocked_checked_at,
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
      $blocked_source: input.blockedSource ?? null,
      $blocked_reason: input.blockedReason ?? null,
      $blocked_at: input.blockedAt ?? null,
      $blocked_details: input.blockedDetails ?? null,
      $blocked_checked_at: input.blockedCheckedAt ?? null,
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

export function clearTaskExecutionStateForIssue(params: {
  repo: string;
  issueNumber: number;
  reason?: string | null;
  status?: string;
  at?: string;
}): { updated: boolean; hadActiveOwner: boolean } {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });
  const nextStatus = (params.status ?? "done").trim() || "done";
  const reason = sanitizeOptionalText(params.reason ?? null, 300) ?? null;

  const active = database
    .query(
      `SELECT COUNT(*) as n
       FROM tasks
       WHERE repo_id = $repo_id
         AND issue_number = $issue_number
         AND task_path LIKE 'github:%'
         AND ((COALESCE(TRIM(daemon_id), '') <> '') OR (COALESCE(TRIM(heartbeat_at), '') <> ''))`
    )
    .get({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
    }) as { n?: number } | undefined;
  const hadActiveOwner = Number(active?.n ?? 0) > 0;

  const result = database
    .query(
      `UPDATE tasks
          SET status = $status,
              session_id = NULL,
              session_events_path = NULL,
              worktree_path = NULL,
              worker_id = NULL,
              repo_slot = NULL,
              daemon_id = NULL,
              heartbeat_at = NULL,
              released_at_ms = NULL,
              released_reason = $reason,
              updated_at = $updated_at
        WHERE repo_id = $repo_id
          AND issue_number = $issue_number
          AND task_path LIKE 'github:%'`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $status: nextStatus,
      $reason: reason,
      $updated_at: at,
    });

  return { updated: result.changes > 0, hadActiveOwner };
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

export type RepoLabelSchemeState = {
  repo: string;
  errorCode: string | null;
  errorDetails: string | null;
  checkedAt: string | null;
};

export function getRepoLabelSchemeState(repo: string): RepoLabelSchemeState {
  const database = requireDb();
  const row = database
    .query(
      "SELECT label_scheme_error_code as error_code, label_scheme_error_details as error_details, label_scheme_checked_at as checked_at FROM repos WHERE name = $name"
    )
    .get({ $name: repo }) as
    | { error_code?: string | null; error_details?: string | null; checked_at?: string | null }
    | undefined;

  return {
    repo,
    errorCode: row?.error_code ?? null,
    errorDetails: row?.error_details ?? null,
    checkedAt: row?.checked_at ?? null,
  };
}

export function setRepoLabelSchemeState(params: {
  repo: string;
  errorCode: string | null;
  errorDetails?: string | null;
  checkedAt?: string;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });
  const checkedAt = params.checkedAt ?? at;

  database
    .query(
      `UPDATE repos
          SET label_scheme_error_code = $error_code,
              label_scheme_error_details = $error_details,
              label_scheme_checked_at = $checked_at,
              updated_at = $updated_at
        WHERE id = $repo_id`
    )
    .run({
      $repo_id: repoId,
      $error_code: params.errorCode,
      $error_details: params.errorDetails ?? null,
      $checked_at: checkedAt,
      $updated_at: at,
    });
}

export function listRepoLabelSchemeStates(): RepoLabelSchemeState[] {
  const database = requireDb();
  const rows = database
    .query(
      "SELECT name, label_scheme_error_code as error_code, label_scheme_error_details as error_details, label_scheme_checked_at as checked_at FROM repos"
    )
    .all() as Array<{ name?: string | null; error_code?: string | null; error_details?: string | null; checked_at?: string | null }>;

  return rows
    .map((row) => {
      const repo = row?.name ?? "";
      if (!repo) return null;
      return {
        repo,
        errorCode: row.error_code ?? null,
        errorDetails: row.error_details ?? null,
        checkedAt: row.checked_at ?? null,
      };
    })
    .filter((row): row is RepoLabelSchemeState => Boolean(row));
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

  recordRalphRunTracePointer({
    runId: params.runId,
    kind: "session_events_path",
    sessionId: params.sessionId,
    path: getSessionEventsPath(params.sessionId),
    at,
  });
}

export function recordRalphRunTracePointer(params: {
  runId: string;
  kind: RalphRunTracePointerKind;
  sessionId?: string | null;
  path: string;
  at?: string;
}): void {
  const runId = params.runId?.trim();
  if (!runId) return;
  const rawPath = String(params.path ?? "").trim();
  if (!rawPath) return;

  const sessionId = params.sessionId?.trim() ?? null;
  if (params.kind === "session_events_path" && (!sessionId || !isSafeSessionId(sessionId))) return;

  const safeSessionId = sessionId && isSafeSessionId(sessionId) ? sessionId : null;
  const database = requireDb();
  const at = params.at ?? nowIso();

  database
    .query(
      `INSERT INTO ralph_run_trace_pointers(
         run_id, kind, session_id, path, created_at, updated_at
       ) VALUES (
         $run_id, $kind, $session_id, $path, $created_at, $updated_at
       )
       ON CONFLICT(run_id, kind, session_id, path) DO UPDATE SET
         updated_at = excluded.updated_at`
    )
    .run({
      $run_id: runId,
      $kind: params.kind,
      $session_id: safeSessionId,
      $path: rawPath,
      $created_at: at,
      $updated_at: at,
    });
}

export function listRalphRunTracePointers(runId: string): RalphRunTracePointer[] {
  const trimmed = runId?.trim();
  if (!trimmed) return [];
  const database = requireDb();
  const rows = database
    .query(
      `SELECT run_id as run_id, kind as kind, session_id as session_id, path as path, created_at as created_at, updated_at as updated_at
       FROM ralph_run_trace_pointers
       WHERE run_id = $run_id
       ORDER BY kind, session_id, path`
    )
    .all({ $run_id: trimmed }) as Array<{
    run_id?: string;
    kind?: string;
    session_id?: string | null;
    path?: string;
    created_at?: string;
    updated_at?: string;
  }>;

  return rows
    .map((row) => {
      const runId = row.run_id ?? "";
      const kind = row.kind === "run_log_path" || row.kind === "session_events_path" ? row.kind : null;
      const path = row.path ?? "";
      const createdAt = row.created_at ?? "";
      const updatedAt = row.updated_at ?? "";
      if (!runId || !kind || !path || !createdAt || !updatedAt) return null;
      return {
        runId,
        kind,
        sessionId: row.session_id ?? null,
        path,
        createdAt,
        updatedAt,
      } satisfies RalphRunTracePointer;
    })
    .filter((row): row is RalphRunTracePointer => Boolean(row));
}

export function listRalphRunTracePointersByRunIds(runIds: string[]): Map<string, RalphRunTracePointer[]> {
  const deduped = Array.from(new Set(runIds.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) return new Map();
  const database = requireDb();

  const params: Record<string, string> = {};
  const placeholders = deduped.map((runId, idx) => {
    const key = `$run_id_${idx}`;
    params[key] = runId;
    return key;
  });

  const rows = database
    .query(
      `SELECT run_id as run_id, kind as kind, session_id as session_id, path as path, created_at as created_at, updated_at as updated_at
       FROM ralph_run_trace_pointers
       WHERE run_id IN (${placeholders.join(", ")})
       ORDER BY run_id, kind, session_id, path`
    )
    .all(params) as Array<{
    run_id?: string;
    kind?: string;
    session_id?: string | null;
    path?: string;
    created_at?: string;
    updated_at?: string;
  }>;

  const byRun = new Map<string, RalphRunTracePointer[]>();
  for (const row of rows) {
    const runId = row.run_id ?? "";
    const kind = row.kind === "run_log_path" || row.kind === "session_events_path" ? row.kind : null;
    const path = row.path ?? "";
    const createdAt = row.created_at ?? "";
    const updatedAt = row.updated_at ?? "";
    if (!runId || !kind || !path || !createdAt || !updatedAt) continue;
    const entry: RalphRunTracePointer = {
      runId,
      kind,
      sessionId: row.session_id ?? null,
      path,
      createdAt,
      updatedAt,
    };
    const list = byRun.get(runId);
    if (list) list.push(entry);
    else byRun.set(runId, [entry]);
  }

  return byRun;
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

export function getLatestSessionSeenAt(sessionId: string): string | null {
  const sid = sessionId?.trim();
  if (!sid) return null;

  const database = requireDb();
  const row = database
    .query(
      `SELECT last_seen_at as last_seen_at
       FROM ralph_run_sessions
       WHERE session_id = $session_id
       ORDER BY last_seen_at DESC
       LIMIT 1`
    )
    .get({ $session_id: sid }) as { last_seen_at?: string } | undefined;

  const at = typeof row?.last_seen_at === "string" ? row.last_seen_at.trim() : "";
  return at || null;
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
  reason: string | null;
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
  truncationMode: ArtifactTruncationMode;
  artifactPolicyVersion: number;
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
  return getRepoIdByNameFromDatabase(database, repo);
}

function getRepoIdByNameFromDatabase(database: Database, repo: string): number | null {
  const row = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: repo,
  }) as { id?: number } | undefined;
  return row?.id ?? null;
}

function getRalphRunGateStateFromDatabase(database: Database, runId: string): RalphRunGateState {
  const results = database
    .query(
       `SELECT run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
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
    reason?: string | null;
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
      `SELECT id, run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
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
    artifact_policy_version?: number | null;
    truncation_mode?: string | null;
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
      reason: row.reason ?? null,
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
      truncationMode: row.truncation_mode === "head" ? "head" : "tail",
      artifactPolicyVersion: typeof row.artifact_policy_version === "number" ? row.artifact_policy_version : 0,
      originalChars: typeof row.original_chars === "number" ? row.original_chars : null,
      originalLines: typeof row.original_lines === "number" ? row.original_lines : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

function getLatestRunIdForIssueFromDatabase(database: Database, params: { repoId: number; issueNumber: number }): string | null {
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
    .get({ $repo_id: params.repoId, $issue_number: params.issueNumber }) as { run_id?: string } | undefined;
  return row?.run_id ?? null;
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
  reason?: string | null;
  url?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  at?: string;
}): void {
  const database = requireDb();
  const at = params.at ?? nowIso();
  const meta = getRunMeta(params.runId);
  const gate = assertGateName(params.gate);

  if (gate === "pr_evidence" && params.status === "fail") {
    const existing = database
      .query(
        `SELECT status
         FROM ralph_run_gate_results
         WHERE run_id = $run_id AND gate = $gate`
      )
      .get({ $run_id: params.runId, $gate: gate }) as { status?: string } | undefined;
    if (existing?.status === "pass") {
      return;
    }
  }

  if (params.status === null) {
    throw new Error("Gate status cannot be null");
  }

  const statusPatch = params.status ? assertGateStatus(params.status) : null;
  const statusInsert = statusPatch ?? "pending";
  const statusPatchFlag = statusPatch ? 1 : 0;

  const commandPatch = applyGateFieldPolicy(params.command, 1000);
  const skipReasonPatch = applyGateFieldPolicy(params.skipReason, 400);
  const reasonPatch = applyGateFieldPolicy(params.reason, 400);
  const urlPatch = applyGateFieldPolicy(params.url, 500);
  const prUrlPatch = applyGateFieldPolicy(params.prUrl, 500);

  const commandPatchFlag = commandPatch !== undefined ? 1 : 0;
  const skipReasonPatchFlag = skipReasonPatch !== undefined ? 1 : 0;
  const reasonPatchFlag = reasonPatch !== undefined ? 1 : 0;
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
         run_id, gate, status, command, skip_reason, reason, url, pr_number, pr_url, repo_id, issue_number, task_path, created_at, updated_at
       ) VALUES (
         $run_id, $gate, $status_insert, $command, $skip_reason, $reason, $url, $pr_number, $pr_url, $repo_id, $issue_number, $task_path, $created_at, $updated_at
       )
       ON CONFLICT(run_id, gate) DO UPDATE SET
         status = CASE WHEN $status_patch = 1 THEN $status_update ELSE ralph_run_gate_results.status END,
         command = CASE WHEN $command_patch = 1 THEN excluded.command ELSE ralph_run_gate_results.command END,
         skip_reason = CASE WHEN $skip_reason_patch = 1 THEN excluded.skip_reason ELSE ralph_run_gate_results.skip_reason END,
         reason = CASE WHEN $reason_patch = 1 THEN excluded.reason ELSE ralph_run_gate_results.reason END,
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
      $reason: reasonPatch ?? null,
      $reason_patch: reasonPatchFlag,
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
  const bounded = applyGateArtifactPolicy({ kind, content: params.content });

  database.transaction(() => {
    database
      .query(
        `INSERT INTO ralph_run_gate_artifacts(
           run_id, gate, kind, content, truncated, original_chars, original_lines, artifact_policy_version, truncation_mode, created_at, updated_at
         ) VALUES (
           $run_id, $gate, $kind, $content, $truncated, $original_chars, $original_lines, $artifact_policy_version, $truncation_mode, $created_at, $updated_at
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
        $artifact_policy_version: bounded.artifactPolicyVersion,
        $truncation_mode: bounded.truncationMode,
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
  return getRalphRunGateStateFromDatabase(database, runId);
}

export function getLatestRunGateStateForIssue(params: {
  repo: string;
  issueNumber: number;
}): RalphRunGateState | null {
  const database = requireDb();
  const repoId = getRepoIdByName(params.repo);
  if (!repoId) return null;
  const runId = getLatestRunIdForIssueFromDatabase(database, { repoId, issueNumber: params.issueNumber });
  if (!runId) return null;
  return getRalphRunGateStateFromDatabase(database, runId);
}

export function getLatestRunGateStateForIssueReadonly(params: {
  repo: string;
  issueNumber: number;
}): RalphRunGateState | null {
  const stateDbPath = getRalphStateDbPath();
  if (!existsSync(stateDbPath)) return null;

  const database = new Database(stateDbPath, { readonly: true });
  try {
    const busyTimeoutMs =
      parsePositiveIntEnv("RALPH_STATE_DB_PROBE_BUSY_TIMEOUT_MS") ?? DEFAULT_PROBE_BUSY_TIMEOUT_MS;
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    if (!tableExists(database, "repos")) return null;
    if (!tableExists(database, "ralph_run_gate_results")) return null;
    if (!tableExists(database, "ralph_run_gate_artifacts")) return null;
    if (!tableExists(database, "ralph_runs")) return null;

    const repoId = getRepoIdByNameFromDatabase(database, params.repo);
    if (!repoId) return null;
    const runId = getLatestRunIdForIssueFromDatabase(database, { repoId, issueNumber: params.issueNumber });
    if (!runId) return null;
    return getRalphRunGateStateFromDatabase(database, runId);
  } finally {
    database.close();
  }
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

export function listRalphRunSessionIdsByRunIds(runIds: string[]): Map<string, string[]> {
  const deduped = Array.from(new Set(runIds.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) return new Map();
  const database = requireDb();

  const params: Record<string, string> = {};
  const placeholders = deduped.map((runId, idx) => {
    const key = `$run_id_${idx}`;
    params[key] = runId;
    return key;
  });

  const rows = database
    .query(
      `SELECT run_id as run_id, session_id as session_id
       FROM ralph_run_sessions
       WHERE run_id IN (${placeholders.join(", ")})
       ORDER BY run_id, session_id`
    )
    .all(params) as Array<{ run_id?: string; session_id?: string } | undefined>;

  const byRun = new Map<string, string[]>();
  for (const row of rows) {
    const runId = row?.run_id ?? "";
    const sessionId = row?.session_id ?? "";
    if (!runId || !sessionId) continue;
    const list = byRun.get(runId);
    if (list) list.push(sessionId);
    else byRun.set(runId, [sessionId]);
  }

  return byRun;
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

export type RalphRunTopSort = "tokens_total" | "triage_score";

export type RalphRunSummary = {
  runId: string;
  repo: string;
  issueNumber: number | null;
  startedAt: string;
  completedAt: string | null;
  outcome: RalphRunOutcome | null;
  tokensTotal: number | null;
  tokensComplete: boolean;
  triageScore: number | null;
  triageFlags: string[];
};

export type RalphRunStepMetric = {
  runId: string;
  stepTitle: string;
  wallTimeMs: number | null;
  toolCallCount: number;
  toolTimeMs: number | null;
  anomalyCount: number;
  tokensTotal: number | null;
  quality: string;
};

export function listRalphRunStepMetrics(runId: string): RalphRunStepMetric[] {
  const trimmed = runId?.trim();
  if (!trimmed) return [];

  const database = requireDb();
  const rows = database
    .query(
      `SELECT
         run_id as run_id,
         step_title as step_title,
         wall_time_ms as wall_time_ms,
         tool_call_count as tool_call_count,
         tool_time_ms as tool_time_ms,
         anomaly_count as anomaly_count,
         tokens_total as tokens_total,
         quality as quality
       FROM ralph_run_step_metrics
       WHERE run_id = $run_id
       ORDER BY step_title ASC`
    )
    .all({ $run_id: trimmed }) as Array<{
    run_id?: string;
    step_title?: string;
    wall_time_ms?: number | null;
    tool_call_count?: number | null;
    tool_time_ms?: number | null;
    anomaly_count?: number | null;
    tokens_total?: number | null;
    quality?: string | null;
  }>;

  return rows
    .map((row) => {
      const runId = row.run_id ?? "";
      const stepTitle = row.step_title ?? "";
      if (!runId || !stepTitle) return null;
      return {
        runId,
        stepTitle,
        wallTimeMs: typeof row.wall_time_ms === "number" ? row.wall_time_ms : null,
        toolCallCount: typeof row.tool_call_count === "number" ? row.tool_call_count : 0,
        toolTimeMs: typeof row.tool_time_ms === "number" ? row.tool_time_ms : null,
        anomalyCount: typeof row.anomaly_count === "number" ? row.anomaly_count : 0,
        tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
        quality: typeof row.quality === "string" && row.quality ? row.quality : "missing",
      } satisfies RalphRunStepMetric;
    })
    .filter((row): row is RalphRunStepMetric => Boolean(row));
}

export function listRalphRunStepMetricsByRunIds(runIds: string[]): Map<string, RalphRunStepMetric[]> {
  const deduped = Array.from(new Set(runIds.map((id) => id.trim()).filter(Boolean)));
  if (deduped.length === 0) return new Map();

  const database = requireDb();
  const params: Record<string, string> = {};
  const placeholders = deduped.map((runId, idx) => {
    const key = `$run_id_${idx}`;
    params[key] = runId;
    return key;
  });

  const rows = database
    .query(
      `SELECT
         run_id as run_id,
         step_title as step_title,
         wall_time_ms as wall_time_ms,
         tool_call_count as tool_call_count,
         tool_time_ms as tool_time_ms,
         anomaly_count as anomaly_count,
         tokens_total as tokens_total,
         quality as quality
       FROM ralph_run_step_metrics
       WHERE run_id IN (${placeholders.join(", ")})
       ORDER BY run_id ASC, step_title ASC`
    )
    .all(params) as Array<{
    run_id?: string;
    step_title?: string;
    wall_time_ms?: number | null;
    tool_call_count?: number | null;
    tool_time_ms?: number | null;
    anomaly_count?: number | null;
    tokens_total?: number | null;
    quality?: string | null;
  }>;

  const byRun = new Map<string, RalphRunStepMetric[]>();
  for (const row of rows) {
    const runId = row.run_id ?? "";
    const stepTitle = row.step_title ?? "";
    if (!runId || !stepTitle) continue;

    const entry: RalphRunStepMetric = {
      runId,
      stepTitle,
      wallTimeMs: typeof row.wall_time_ms === "number" ? row.wall_time_ms : null,
      toolCallCount: typeof row.tool_call_count === "number" ? row.tool_call_count : 0,
      toolTimeMs: typeof row.tool_time_ms === "number" ? row.tool_time_ms : null,
      anomalyCount: typeof row.anomaly_count === "number" ? row.anomaly_count : 0,
      tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
      quality: typeof row.quality === "string" && row.quality ? row.quality : "missing",
    };

    const list = byRun.get(runId);
    if (list) list.push(entry);
    else byRun.set(runId, [entry]);
  }

  return byRun;
}

export function listRalphRunsTop(params?: {
  limit?: number;
  sinceIso?: string | null;
  untilIso?: string | null;
  sort?: RalphRunTopSort;
  includeMissing?: boolean;
}): RalphRunSummary[] {
  const database = requireDb();
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 20;
  const sort: RalphRunTopSort = params?.sort === "triage_score" ? "triage_score" : "tokens_total";
  const includeMissing = params?.includeMissing === true;
  const sinceIso = params?.sinceIso ?? null;
  const untilIso = params?.untilIso ?? null;

  const sortColumn = sort === "triage_score" ? "m.triage_score" : "t.tokens_total";
  const conditions: string[] = [];
  if (sinceIso) conditions.push("r.started_at >= $since");
  if (untilIso) conditions.push("r.started_at <= $until");
  if (!includeMissing) conditions.push(`${sortColumn} IS NOT NULL`);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = database
    .query(
      `SELECT
         r.run_id as run_id,
         repo.name as repo,
         r.issue_number as issue_number,
         r.started_at as started_at,
         r.completed_at as completed_at,
         r.outcome as outcome,
         t.tokens_total as tokens_total,
         t.tokens_complete as tokens_complete,
         m.triage_score as triage_score,
         m.triage_reasons_json as triage_reasons_json
       FROM ralph_runs r
       JOIN repos repo ON repo.id = r.repo_id
       LEFT JOIN ralph_run_token_totals t ON t.run_id = r.run_id
       LEFT JOIN ralph_run_metrics m ON m.run_id = r.run_id
       ${where}
       ORDER BY ${sortColumn} IS NULL ASC, ${sortColumn} DESC, r.started_at DESC, r.run_id DESC
       LIMIT $limit`
    )
    .all({ $limit: limit, $since: sinceIso, $until: untilIso }) as Array<{
    run_id?: string;
    repo?: string;
    issue_number?: number | null;
    started_at?: string;
    completed_at?: string | null;
    outcome?: RalphRunOutcome | null;
    tokens_total?: number | null;
    tokens_complete?: number | null;
    triage_score?: number | null;
    triage_reasons_json?: string | null;
  }>;

  return rows
    .map((row) => {
      const runId = row.run_id ?? "";
      const repo = row.repo ?? "";
      const startedAt = row.started_at ?? "";
      if (!runId || !repo || !startedAt) return null;
      return {
        runId,
        repo,
        issueNumber: typeof row.issue_number === "number" ? row.issue_number : null,
        startedAt,
        completedAt: row.completed_at ?? null,
        outcome: row.outcome ?? null,
        tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
        tokensComplete: fromSqliteBool(row.tokens_complete),
        triageScore: typeof row.triage_score === "number" ? row.triage_score : null,
        triageFlags: safeParseJsonStringList(row.triage_reasons_json),
      } satisfies RalphRunSummary;
    })
    .filter((row): row is RalphRunSummary => Boolean(row));
}

export function getRalphRunDetails(runId: string): RalphRunSummary | null {
  const trimmed = runId?.trim();
  if (!trimmed) return null;
  const database = requireDb();
  const row = database
    .query(
      `SELECT
         r.run_id as run_id,
         repo.name as repo,
         r.issue_number as issue_number,
         r.started_at as started_at,
         r.completed_at as completed_at,
         r.outcome as outcome,
         t.tokens_total as tokens_total,
         t.tokens_complete as tokens_complete,
         m.triage_score as triage_score,
         m.triage_reasons_json as triage_reasons_json
       FROM ralph_runs r
       JOIN repos repo ON repo.id = r.repo_id
       LEFT JOIN ralph_run_token_totals t ON t.run_id = r.run_id
       LEFT JOIN ralph_run_metrics m ON m.run_id = r.run_id
       WHERE r.run_id = $run_id
       LIMIT 1`
    )
    .get({ $run_id: trimmed }) as
    | {
        run_id?: string;
        repo?: string;
        issue_number?: number | null;
        started_at?: string;
        completed_at?: string | null;
        outcome?: RalphRunOutcome | null;
        tokens_total?: number | null;
        tokens_complete?: number | null;
        triage_score?: number | null;
        triage_reasons_json?: string | null;
      }
    | undefined;

  if (!row?.run_id || !row.repo || !row.started_at) return null;
  return {
    runId: row.run_id,
    repo: row.repo,
    issueNumber: typeof row.issue_number === "number" ? row.issue_number : null,
    startedAt: row.started_at,
    completedAt: row.completed_at ?? null,
    outcome: row.outcome ?? null,
    tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
    tokensComplete: fromSqliteBool(row.tokens_complete),
    triageScore: typeof row.triage_score === "number" ? row.triage_score : null,
    triageFlags: safeParseJsonStringList(row.triage_reasons_json),
  } satisfies RalphRunSummary;
}

export type RalphRunTriageSummary = {
  runId: string;
  repo: string;
  issueNumber: number | null;
  startedAt: string;
  completedAt: string | null;
  outcome: RalphRunOutcome | null;
  score: number;
  reasons: string[];
  tokensTotal: number | null;
  toolCallCount: number;
  wallTimeMs: number | null;
  quality: string;
  computedAt: string;
};

function safeParseJsonStringList(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function listTopRalphRunTriages(params?: { limit?: number; sinceDays?: number }): RalphRunTriageSummary[] {
  const database = requireDb();
  const limit =
    typeof params?.limit === "number" && Number.isFinite(params.limit) ? Math.max(1, Math.floor(params.limit)) : 10;
  const sinceDays =
    typeof params?.sinceDays === "number" && Number.isFinite(params.sinceDays) ? Math.max(0, Math.floor(params.sinceDays)) : 14;

  const sinceIso = sinceDays > 0 ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString() : null;

  const where: string[] = ["m.triage_score IS NOT NULL", "m.computed_at IS NOT NULL"];
  if (sinceIso) where.push("r.started_at >= $since");

  const rows = database
    .query(
      `SELECT
         r.run_id as run_id,
         repo.name as repo,
         r.issue_number as issue_number,
         r.started_at as started_at,
         r.completed_at as completed_at,
         r.outcome as outcome,
         m.triage_score as triage_score,
         m.triage_reasons_json as triage_reasons_json,
         m.tokens_total as tokens_total,
         m.tool_call_count as tool_call_count,
         m.wall_time_ms as wall_time_ms,
         m.quality as quality,
         m.computed_at as computed_at
       FROM ralph_run_metrics m
       JOIN ralph_runs r ON r.run_id = m.run_id
       JOIN repos repo ON repo.id = r.repo_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.triage_score DESC, r.started_at DESC, r.run_id DESC
       LIMIT $limit`
    )
    .all({ $limit: limit, $since: sinceIso }) as Array<{
    run_id?: string;
    repo?: string;
    issue_number?: number | null;
    started_at?: string;
    completed_at?: string | null;
    outcome?: RalphRunOutcome | null;
    triage_score?: number | null;
    triage_reasons_json?: string | null;
    tokens_total?: number | null;
    tool_call_count?: number | null;
    wall_time_ms?: number | null;
    quality?: string;
    computed_at?: string;
  }>;

  return rows
    .map((row) => {
      const runId = row.run_id ?? "";
      const repo = row.repo ?? "";
      const startedAt = row.started_at ?? "";
      const computedAt = row.computed_at ?? "";
      const score = typeof row.triage_score === "number" ? row.triage_score : null;
      if (!runId || !repo || !startedAt || !computedAt || score == null) return null;
      return {
        runId,
        repo,
        issueNumber: typeof row.issue_number === "number" ? row.issue_number : null,
        startedAt,
        completedAt: row.completed_at ?? null,
        outcome: row.outcome ?? null,
        score,
        reasons: safeParseJsonStringList(row.triage_reasons_json),
        tokensTotal: typeof row.tokens_total === "number" ? row.tokens_total : null,
        toolCallCount: typeof row.tool_call_count === "number" ? row.tool_call_count : 0,
        wallTimeMs: typeof row.wall_time_ms === "number" ? row.wall_time_ms : null,
        quality: typeof row.quality === "string" && row.quality ? row.quality : "missing",
        computedAt,
      } satisfies RalphRunTriageSummary;
    })
    .filter((row): row is RalphRunTriageSummary => Boolean(row));
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
  blockedSource?: string | null;
  blockedReason?: string | null;
  blockedAt?: string | null;
  blockedDetails?: string | null;
  blockedCheckedAt?: string | null;
};

export type OrphanedTaskOpState = TaskOpState & {
  issueState: string | null;
  issueLabels: string[];
  orphanReason: "closed" | "no-ralph-labels";
};

export function hasDurableOpState(opState: TaskOpState | null | undefined): boolean {
  if (!opState) return false;
  const hasNonEmpty = (value: string | null | undefined): boolean => typeof value === "string" && value.trim().length > 0;
  return (
    hasNonEmpty(opState.sessionId) ||
    hasNonEmpty(opState.sessionEventsPath) ||
    hasNonEmpty(opState.worktreePath) ||
    hasNonEmpty(opState.workerId) ||
    hasNonEmpty(opState.repoSlot) ||
    hasNonEmpty(opState.daemonId) ||
    hasNonEmpty(opState.heartbeatAt)
  );
}

export type IssueStatusTransitionRecord = {
  repo: string;
  issueNumber: number;
  fromStatus: string | null;
  toStatus: string;
  reason: string;
  updatedAtMs: number;
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

export function shouldAllowLoopTriageAttempt(attemptCount: number, maxAttempts: number): boolean {
  const normalizedAttempts = Number.isFinite(attemptCount) ? Math.max(0, Math.floor(attemptCount)) : 0;
  const normalizedMax = Number.isFinite(maxAttempts) ? Math.max(1, Math.floor(maxAttempts)) : 1;
  return normalizedAttempts < normalizedMax;
}

export function getLoopTriageAttempt(params: {
  repo: string;
  issueNumber: number;
  signature: string;
}): LoopTriageAttemptState | null {
  if (!db) return null;
  const signature = params.signature.trim();
  if (!signature) return null;

  const database = requireDb();
  const row = database
    .query(
      `SELECT lta.issue_number as issue_number,
              lta.signature as signature,
              lta.attempt_count as attempt_count,
              lta.last_decision as last_decision,
              lta.last_rationale as last_rationale,
              lta.last_updated_at_ms as last_updated_at_ms
       FROM loop_triage_attempts lta
       JOIN repos r ON r.id = lta.repo_id
       WHERE r.name = $repo AND lta.issue_number = $issue_number AND lta.signature = $signature`
    )
    .get({
      $repo: params.repo,
      $issue_number: params.issueNumber,
      $signature: signature,
    }) as
    | {
        issue_number?: number | null;
        signature?: string | null;
        attempt_count?: number | null;
        last_decision?: string | null;
        last_rationale?: string | null;
        last_updated_at_ms?: number | null;
      }
    | undefined;

  if (!row) return null;

  const issueNumber = Number.isFinite(row.issue_number) ? Number(row.issue_number) : params.issueNumber;
  const attemptCount = Number.isFinite(row.attempt_count) ? Math.max(0, Math.floor(Number(row.attempt_count))) : 0;
  const lastUpdatedAtMs = Number.isFinite(row.last_updated_at_ms)
    ? Math.max(0, Math.floor(Number(row.last_updated_at_ms)))
    : 0;

  return {
    repo: params.repo,
    issueNumber,
    signature: String(row.signature ?? signature),
    attemptCount,
    lastDecision: row.last_decision ?? null,
    lastRationale: row.last_rationale ?? null,
    lastUpdatedAtMs,
  };
}

export function bumpLoopTriageAttempt(params: {
  repo: string;
  issueNumber: number;
  signature: string;
  decision?: string | null;
  rationale?: string | null;
  nowMs?: number;
}): LoopTriageAttemptState {
  const database = requireDb();
  const signature = params.signature.trim();
  if (!signature) {
    throw new Error("Loop triage signature is required");
  }

  const nowMs = Number.isFinite(params.nowMs) ? Number(params.nowMs) : Date.now();
  const atIso = new Date(nowMs).toISOString();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const decision = sanitizeOptionalText(params.decision ?? null, 120);
  const rationale = sanitizeOptionalText(params.rationale ?? null, 400);

  database
    .query(
      `INSERT INTO loop_triage_attempts(
         repo_id, issue_number, signature, attempt_count, last_decision, last_rationale, last_updated_at_ms
       ) VALUES (
         $repo_id, $issue_number, $signature, 1, $last_decision, $last_rationale, $last_updated_at_ms
       )
       ON CONFLICT(repo_id, issue_number, signature) DO UPDATE SET
         attempt_count = loop_triage_attempts.attempt_count + 1,
         last_decision = excluded.last_decision,
         last_rationale = excluded.last_rationale,
         last_updated_at_ms = excluded.last_updated_at_ms`
    )
    .run({
      $repo_id: repoId,
      $issue_number: params.issueNumber,
      $signature: signature,
      $last_decision: decision ?? null,
      $last_rationale: rationale ?? null,
      $last_updated_at_ms: Math.max(0, Math.floor(nowMs)),
    });

  return (
    getLoopTriageAttempt({ repo: params.repo, issueNumber: params.issueNumber, signature }) ?? {
      repo: params.repo,
      issueNumber: params.issueNumber,
      signature,
      attemptCount: 1,
      lastDecision: decision ?? null,
      lastRationale: rationale ?? null,
      lastUpdatedAtMs: Math.max(0, Math.floor(nowMs)),
    }
  );
}

export function getCiQuarantineFollowupMapping(params: {
  repo: string;
  signature: string;
}): CiQuarantineFollowupMapping | null {
  if (!db) return null;
  const signature = params.signature.trim();
  if (!signature) return null;

  const database = requireDb();
  const row = database
    .query(
      `SELECT c.signature as signature,
              c.followup_issue_number as followup_issue_number,
              c.followup_issue_url as followup_issue_url,
              c.source_issue_number as source_issue_number,
              c.updated_at as updated_at
       FROM ci_quarantine_followups c
       JOIN repos r ON r.id = c.repo_id
       WHERE r.name = $repo AND c.signature = $signature`
    )
    .get({
      $repo: params.repo,
      $signature: signature,
    }) as
    | {
        signature?: string | null;
        followup_issue_number?: number | null;
        followup_issue_url?: string | null;
        source_issue_number?: number | null;
        updated_at?: string | null;
      }
    | undefined;

  const issueNumber = Number(row?.followup_issue_number ?? 0);
  const issueUrl = String(row?.followup_issue_url ?? "").trim();
  if (!issueNumber || !issueUrl) return null;
  return {
    repo: params.repo,
    signature: String(row?.signature ?? signature),
    issueNumber,
    issueUrl,
    sourceIssueNumber: Number(row?.source_issue_number ?? 0) || 0,
    updatedAt: String(row?.updated_at ?? "").trim() || nowIso(),
  };
}

export function upsertCiQuarantineFollowupMapping(params: {
  repo: string;
  signature: string;
  followupIssueNumber: number;
  followupIssueUrl: string;
  sourceIssueNumber: number;
  at?: string;
}): CiQuarantineFollowupMapping {
  const database = requireDb();
  const signature = params.signature.trim();
  if (!signature) {
    throw new Error("CI quarantine follow-up signature is required");
  }
  const issueNumber = Math.max(1, Math.floor(params.followupIssueNumber));
  const sourceIssueNumber = Math.max(1, Math.floor(params.sourceIssueNumber));
  const issueUrl = sanitizeOptionalText(params.followupIssueUrl, 500);
  if (!issueUrl) {
    throw new Error("CI quarantine follow-up issue URL is required");
  }
  const at = params.at?.trim() || nowIso();
  const repoId = upsertRepo({ repo: params.repo, at });

  database
    .query(
      `INSERT INTO ci_quarantine_followups(
         repo_id,
         signature,
         followup_issue_number,
         followup_issue_url,
         source_issue_number,
         created_at,
         updated_at
       ) VALUES (
         $repo_id,
         $signature,
         $followup_issue_number,
         $followup_issue_url,
         $source_issue_number,
         $created_at,
         $updated_at
       )
       ON CONFLICT(repo_id, signature) DO UPDATE SET
         followup_issue_number = excluded.followup_issue_number,
         followup_issue_url = excluded.followup_issue_url,
         source_issue_number = excluded.source_issue_number,
         updated_at = excluded.updated_at`
    )
    .run({
      $repo_id: repoId,
      $signature: signature,
      $followup_issue_number: issueNumber,
      $followup_issue_url: issueUrl,
      $source_issue_number: sourceIssueNumber,
      $created_at: at,
      $updated_at: at,
    });

  return {
    repo: params.repo,
    signature,
    issueNumber,
    issueUrl,
    sourceIssueNumber,
    updatedAt: at,
  };
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
              t.released_at_ms as released_at_ms, t.released_reason as released_reason,
              t.blocked_source as blocked_source, t.blocked_reason as blocked_reason, t.blocked_at as blocked_at,
              t.blocked_details as blocked_details, t.blocked_checked_at as blocked_checked_at
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
    blocked_source?: string | null;
    blocked_reason?: string | null;
    blocked_at?: string | null;
    blocked_details?: string | null;
    blocked_checked_at?: string | null;
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
    blockedSource: row.blocked_source ?? null,
    blockedReason: row.blocked_reason ?? null,
    blockedAt: row.blocked_at ?? null,
    blockedDetails: row.blocked_details ?? null,
    blockedCheckedAt: row.blocked_checked_at ?? null,
  }));
}

export function getTaskOpStateByPath(repo: string, taskPath: string): TaskOpState | null {
  const database = requireDb();
  const row = database
    .query(
      `SELECT t.task_path as task_path, t.issue_number as issue_number, t.status as status, t.session_id as session_id,
              t.session_events_path as session_events_path, t.worktree_path as worktree_path, t.worker_id as worker_id,
              t.repo_slot as repo_slot, t.daemon_id as daemon_id, t.heartbeat_at as heartbeat_at,
              t.released_at_ms as released_at_ms, t.released_reason as released_reason,
              t.blocked_source as blocked_source, t.blocked_reason as blocked_reason, t.blocked_at as blocked_at,
              t.blocked_details as blocked_details, t.blocked_checked_at as blocked_checked_at
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
        blocked_source?: string | null;
        blocked_reason?: string | null;
        blocked_at?: string | null;
        blocked_details?: string | null;
        blocked_checked_at?: string | null;
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
    blockedSource: row.blocked_source ?? null,
    blockedReason: row.blocked_reason ?? null,
    blockedAt: row.blocked_at ?? null,
    blockedDetails: row.blocked_details ?? null,
    blockedCheckedAt: row.blocked_checked_at ?? null,
  };
}

export function clearTaskOpState(params: {
  repo: string;
  taskPath: string;
  releasedAtMs?: number;
  releasedReason?: string | null;
  status?: string | null;
  expectedDaemonId?: string | null;
  expectedHeartbeatAt?: string | null;
}): { cleared: boolean; raceSkipped: boolean } {
  const database = requireDb();
  const atIso = nowIso();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const releasedAtMs = typeof params.releasedAtMs === "number" ? params.releasedAtMs : Date.now();

  const result = database
    .query(
      `UPDATE tasks
         SET status = COALESCE($status, status),
             session_id = NULL,
             session_events_path = NULL,
             worktree_path = NULL,
             worker_id = NULL,
             repo_slot = NULL,
             daemon_id = NULL,
             heartbeat_at = NULL,
             released_at_ms = $released_at_ms,
             released_reason = $released_reason,
             updated_at = $updated_at
       WHERE repo_id = $repo_id
         AND task_path = $task_path
         AND (
           session_id IS NOT NULL OR
           session_events_path IS NOT NULL OR
           worktree_path IS NOT NULL OR
           worker_id IS NOT NULL OR
           repo_slot IS NOT NULL OR
           daemon_id IS NOT NULL OR
           heartbeat_at IS NOT NULL
         )
         AND (
           ($expected_daemon_id IS NULL AND daemon_id IS NULL) OR
           daemon_id = $expected_daemon_id
         )
         AND (
           ($expected_heartbeat_at IS NULL AND heartbeat_at IS NULL) OR
           heartbeat_at = $expected_heartbeat_at
         )`
    )
    .run({
      $repo_id: repoId,
      $task_path: params.taskPath,
      $status: params.status ?? null,
      $released_at_ms: releasedAtMs,
      $released_reason: params.releasedReason ?? null,
      $updated_at: atIso,
      $expected_daemon_id: params.expectedDaemonId ?? null,
      $expected_heartbeat_at: params.expectedHeartbeatAt ?? null,
    });

  if (result.changes > 0) return { cleared: true, raceSkipped: false };

  const row = database
    .query("SELECT task_path as task_path FROM tasks WHERE repo_id = $repo_id AND task_path = $task_path")
    .get({ $repo_id: repoId, $task_path: params.taskPath }) as { task_path?: string } | undefined;

  return { cleared: false, raceSkipped: Boolean(row?.task_path) };
}

export function updateTaskStatusIfOwnershipUnchanged(params: {
  repo: string;
  taskPath: string;
  status: string;
  releasedAtMs?: number;
  releasedReason?: string | null;
  expectedDaemonId?: string | null;
  expectedHeartbeatAt?: string | null;
}): { updated: boolean; raceSkipped: boolean } {
  const database = requireDb();
  const atIso = nowIso();
  const repoId = upsertRepo({ repo: params.repo, at: atIso });
  const releasedAtMs = typeof params.releasedAtMs === "number" ? params.releasedAtMs : Date.now();

  const result = database
    .query(
      `UPDATE tasks
         SET status = $status,
             repo_slot = NULL,
             worker_id = NULL,
             daemon_id = NULL,
             heartbeat_at = NULL,
             released_at_ms = $released_at_ms,
             released_reason = $released_reason,
             updated_at = $updated_at
       WHERE repo_id = $repo_id
         AND task_path = $task_path
         AND (
           ($expected_daemon_id IS NULL AND daemon_id IS NULL) OR
           daemon_id = $expected_daemon_id
         )
         AND (
           ($expected_heartbeat_at IS NULL AND heartbeat_at IS NULL) OR
           heartbeat_at = $expected_heartbeat_at
         )`
    )
    .run({
      $repo_id: repoId,
      $task_path: params.taskPath,
      $status: params.status,
      $released_at_ms: releasedAtMs,
      $released_reason: params.releasedReason ?? null,
      $updated_at: atIso,
      $expected_daemon_id: params.expectedDaemonId ?? null,
      $expected_heartbeat_at: params.expectedHeartbeatAt ?? null,
    });

  if (result.changes > 0) return { updated: true, raceSkipped: false };

  const row = database
    .query("SELECT task_path as task_path FROM tasks WHERE repo_id = $repo_id AND task_path = $task_path")
    .get({ $repo_id: repoId, $task_path: params.taskPath }) as { task_path?: string } | undefined;

  return { updated: false, raceSkipped: Boolean(row?.task_path) };
}

export function listOrphanedTasksWithOpState(repo: string): OrphanedTaskOpState[] {
  const database = requireDb();
  const rows = database
    .query(
      `SELECT t.task_path as task_path,
              t.issue_number as issue_number,
              t.status as status,
              t.session_id as session_id,
              t.session_events_path as session_events_path,
              t.worktree_path as worktree_path,
              t.worker_id as worker_id,
              t.repo_slot as repo_slot,
              t.daemon_id as daemon_id,
              t.heartbeat_at as heartbeat_at,
              t.released_at_ms as released_at_ms,
              t.released_reason as released_reason,
              i.state as issue_state,
              GROUP_CONCAT(l.name, '${LABEL_SEPARATOR}') as labels
       FROM tasks t
       JOIN repos r ON r.id = t.repo_id
       JOIN issues i ON i.repo_id = t.repo_id AND i.number = t.issue_number
       LEFT JOIN issue_labels l ON l.issue_id = i.id
       WHERE r.name = $name
         AND t.issue_number IS NOT NULL
         AND t.task_path LIKE 'github:%'
       GROUP BY t.id, i.id
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
    issue_state?: string | null;
    labels?: string | null;
  }>;

  const out: OrphanedTaskOpState[] = [];
  for (const row of rows) {
    const base: TaskOpState = {
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
    if (!hasDurableOpState(base)) continue;

    const labels = parseLabelList(row.labels);
    const issueState = row.issue_state?.trim().toUpperCase() ?? null;
    if (issueState === "CLOSED") {
      out.push({ ...base, issueState, issueLabels: labels, orphanReason: "closed" });
      continue;
    }

    const hasRalphLabel = labels.some((label) => label.toLowerCase().startsWith("ralph:"));
    if (!hasRalphLabel) {
      out.push({ ...base, issueState, issueLabels: labels, orphanReason: "no-ralph-labels" });
    }
  }

  return out;
}

export function getIssueStatusTransitionRecord(repo: string, issueNumber: number): IssueStatusTransitionRecord | null {
  const database = requireDb();
  const repoRow = database.query("SELECT id FROM repos WHERE name = $name").get({
    $name: repo,
  }) as { id?: number } | undefined;
  if (!repoRow?.id) return null;

  const row = database
    .query(
      `SELECT from_status, to_status, reason, updated_at_ms
       FROM issue_status_transition_guard
       WHERE repo_id = $repo_id AND issue_number = $issue_number`
    )
    .get({
      $repo_id: repoRow.id,
      $issue_number: issueNumber,
    }) as { from_status?: string | null; to_status?: string | null; reason?: string | null; updated_at_ms?: number } | undefined;

  if (!row?.to_status || typeof row.updated_at_ms !== "number") return null;
  return {
    repo,
    issueNumber,
    fromStatus: row.from_status ?? null,
    toStatus: row.to_status,
    reason: row.reason ?? "",
    updatedAtMs: row.updated_at_ms,
  };
}

export function recordIssueStatusTransition(input: {
  repo: string;
  issueNumber: number;
  fromStatus: string | null;
  toStatus: string;
  reason?: string | null;
  updatedAtMs: number;
}): void {
  const database = requireDb();
  const atIso = nowIso();
  const repoId = upsertRepo({ repo: input.repo, at: atIso });
  const reason = sanitizeOptionalText(input.reason ?? null, 300) ?? "";

  database
    .query(
      `INSERT INTO issue_status_transition_guard(repo_id, issue_number, from_status, to_status, reason, updated_at_ms)
       VALUES ($repo_id, $issue_number, $from_status, $to_status, $reason, $updated_at_ms)
       ON CONFLICT(repo_id, issue_number) DO UPDATE SET
         from_status = excluded.from_status,
         to_status = excluded.to_status,
         reason = excluded.reason,
         updated_at_ms = excluded.updated_at_ms`
    )
    .run({
      $repo_id: repoId,
      $issue_number: input.issueNumber,
      $from_status: input.fromStatus,
      $to_status: input.toStatus,
      $reason: reason,
      $updated_at_ms: Math.floor(input.updatedAtMs),
    });
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

export type DependencySatisfactionOverride = {
  key: string;
  repo: string;
  issueNumber: number;
  createdAt: string;
  satisfiedAt: string | null;
  via: string | null;
};

const DEP_SATISFY_KEY_PREFIX = "ralph:satisfy:v1:";

function parseDependencySatisfactionKey(key: string): { repo: string; issueNumber: number } | null {
  if (!key.startsWith(DEP_SATISFY_KEY_PREFIX)) return null;
  const rest = key.slice(DEP_SATISFY_KEY_PREFIX.length);
  const hashIdx = rest.lastIndexOf("#");
  if (hashIdx <= 0 || hashIdx >= rest.length - 1) return null;
  const repo = rest.slice(0, hashIdx).trim();
  const issueNumber = Number(rest.slice(hashIdx + 1));
  if (!repo) return null;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return null;
  return { repo, issueNumber: Math.floor(issueNumber) };
}

export function listDependencySatisfactionOverrides(params?: { limit?: number }): DependencySatisfactionOverride[] {
  const database = requireDb();
  const limit = Math.max(1, Math.min(500, Math.floor(params?.limit ?? 50)));
  const rows = database
    .query(
      `SELECT key, created_at, payload_json
       FROM idempotency
       WHERE scope = 'dependency-satisfaction'
       ORDER BY created_at DESC
       LIMIT $limit`
    )
    .all({ $limit: limit }) as Array<{ key?: string | null; created_at?: string | null; payload_json?: string | null }>;

  const out: DependencySatisfactionOverride[] = [];
  for (const row of rows) {
    const key = typeof row?.key === "string" ? row.key : "";
    const createdAt = typeof row?.created_at === "string" ? row.created_at : "";
    if (!key || !createdAt) continue;
    const parsedKey = parseDependencySatisfactionKey(key);
    if (!parsedKey) continue;

    let satisfiedAt: string | null = null;
    let via: string | null = null;
    const payload = typeof row.payload_json === "string" ? row.payload_json : null;
    if (payload) {
      try {
        const parsed = JSON.parse(payload) as any;
        if (typeof parsed?.satisfiedAt === "string" && parsed.satisfiedAt.trim()) satisfiedAt = parsed.satisfiedAt.trim();
        if (typeof parsed?.via === "string" && parsed.via.trim()) via = parsed.via.trim();
      } catch {
        // ignore invalid payload
      }
    }

    out.push({
      key,
      repo: parsedKey.repo,
      issueNumber: parsedKey.issueNumber,
      createdAt,
      satisfiedAt,
      via,
    });
  }

  return out;
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
