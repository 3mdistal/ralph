import { $ } from "bun";
import { appendFile, mkdir, readFile, readdir, rm } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import { type AgentTask, getBwrbVaultForStorage, getBwrbVaultIfValid, updateTaskStatus } from "./queue-backend";
import { appendBwrbNoteBody, buildAgentRunPayload, createBwrbNote } from "./bwrb/artifacts";
import {
  getAutoUpdateBehindLabelGate,
  getAutoUpdateBehindMinMinutes,
  getOpencodeDefaultProfileName,
  getRepoBotBranch,
  getRepoMaxWorkers,
  getRepoRequiredChecksOverride,
  getRepoSetupCommands,
  isAutoUpdateBehindEnabled,
  isOpencodeProfilesEnabled,
  getConfig,
  resolveOpencodeProfile,
} from "./config";
import { normalizeGitRef } from "./midpoint-labels";
import { computeHeadBranchDeletionDecision } from "./pr-head-branch-cleanup";
import { applyMidpointLabelsBestEffort as applyMidpointLabelsBestEffortCore } from "./midpoint-labeler";
import { getAllowedOwners, isRepoAllowed } from "./github-app-auth";
import {
  continueCommand,
  continueSession,
  getRalphXdgCacheHome,
  runAgent,
  type RunSessionOptionsBase,
  type SessionResult,
} from "./session";
import { buildPlannerPrompt } from "./planner-prompt";
import { getThrottleDecision } from "./throttle";
import { buildContextResumePrompt, retryContextCompactOnce } from "./context-compact";
import { ensureRalphWorktreeArtifacts, RALPH_PLAN_RELATIVE_PATH } from "./worktree-artifacts";
import { ensureWorktreeSetup, type SetupFailure } from "./worktree-setup";
import { LogLimiter } from "./logging";

import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { readControlStateSnapshot } from "./drain";
import { hasProductGap, parseRoutingDecision, selectPrUrl, type RoutingDecision } from "./routing";
import { computeLiveAnomalyCountFromJsonl } from "./anomaly";
import {
  isExplicitBlockerReason,
  isImplementationTaskFromIssue,
  shouldConsultDevex,
  shouldEscalateAfterRouting,
  type IssueMetadata,
} from "./escalation";
import { notifyEscalation, notifyError, notifyTaskComplete, type EscalationContext } from "./notify";
import { drainQueuedNudges } from "./nudge";
import { RALPH_LABEL_BLOCKED, RALPH_LABEL_STUCK } from "./github-labels";
import { executeIssueLabelOps, type LabelOp } from "./github/issue-label-io";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "./github/client";
import { createGhRunner } from "./github/gh-runner";
import { createRalphWorkflowLabelsEnsurer } from "./github/ensure-ralph-workflow-labels";
import { sanitizeEscalationReason, writeEscalationToGitHub } from "./github/escalation-writeback";
import {
  buildCiDebugCommentBody,
  createCiDebugComment,
  findCiDebugComment,
  parseCiDebugState,
  updateCiDebugComment,
  type CiDebugAttempt,
  type CiDebugCommentState,
} from "./github/ci-debug-comment";
import { buildWatchdogDiagnostics, writeWatchdogToGitHub } from "./github/watchdog-writeback";
import { BLOCKED_SOURCES, type BlockedSource } from "./blocked-sources";
import { computeBlockedDecision, type RelationshipSignal } from "./github/issue-blocking-core";
import { formatIssueRef, parseIssueRef, type IssueRef } from "./github/issue-ref";
import {
  GitHubRelationshipProvider,
  type IssueRelationshipProvider,
  type IssueRelationshipSnapshot,
} from "./github/issue-relationships";
import { getRalphRunLogPath, getRalphSessionDir, getRalphWorktreesDir, getSessionEventsPath } from "./paths";
import { ralphEventBus } from "./dashboard/bus";
import { buildRalphEvent } from "./dashboard/events";
import { cleanupSessionArtifacts } from "./introspection-traces";
import { createRunRecordingSessionAdapter, type SessionAdapter } from "./run-recording-session-adapter";
import { redactHomePathForDisplay } from "./redaction";
import { isSafeSessionId } from "./session-id";
import {
  completeRalphRun,
  createRalphRun,
  getIdempotencyPayload,
  upsertIdempotencyKey,
  recordIssueSnapshot,
  recordPrSnapshot,
  listOpenPrCandidatesForIssue,
  PR_STATE_MERGED,
  PR_STATE_OPEN,
  type PrState,
  type RalphRunAttemptKind,
  type RalphRunDetails,
} from "./state";
import { selectCanonicalPr, type ResolvedPrCandidate } from "./pr-resolution";
import {
  isPathUnderDir,
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "./git-worktree";
import {
  normalizePrUrl,
  searchOpenPullRequestsByIssueLink,
  viewPullRequest,
  type PullRequestSearchResult,
} from "./github/pr";

const ghRead = (repo: string) => createGhRunner({ repo, mode: "read" });
const ghWrite = (repo: string) => createGhRunner({ repo, mode: "write" });
type PullRequestMergeStateStatus =
  | "BEHIND"
  | "BLOCKED"
  | "CLEAN"
  | "DIRTY"
  | "DRAFT"
  | "HAS_HOOKS"
  | "UNSTABLE"
  | "UNKNOWN";

type PullRequestMergeState = {
  number: number;
  url: string;
  mergeStateStatus: PullRequestMergeStateStatus | null;
  isCrossRepository: boolean;
  headRefName: string;
  headRepoFullName: string;
  baseRefName: string;
  labels: string[];
};

type ResolvedIssuePr = {
  selectedUrl: string | null;
  duplicates: string[];
  source: "db" | "gh-search" | null;
  diagnostics: string[];
};

const DEFAULT_SESSION_ADAPTER: SessionAdapter = {
  runAgent,
  continueSession,
  continueCommand,
  getRalphXdgCacheHome,
};

type QueueAdapter = {
  updateTaskStatus: typeof updateTaskStatus;
};

type NotifyAdapter = {
  notifyEscalation: typeof notifyEscalation;
  notifyError: typeof notifyError;
  notifyTaskComplete: typeof notifyTaskComplete;
};

type ThrottleAdapter = {
  getThrottleDecision: typeof getThrottleDecision;
};

const DEFAULT_QUEUE_ADAPTER: QueueAdapter = {
  updateTaskStatus,
};

const DEFAULT_NOTIFY_ADAPTER: NotifyAdapter = {
  notifyEscalation,
  notifyError,
  notifyTaskComplete,
};

const DEFAULT_THROTTLE_ADAPTER: ThrottleAdapter = {
  getThrottleDecision,
};

// Git worktrees for per-task repo isolation
const RALPH_WORKTREES_DIR = getRalphWorktreesDir();

// Anomaly detection thresholds
const ANOMALY_BURST_THRESHOLD = 50; // Abort if this many anomalies detected
const MAX_ANOMALY_ABORTS = 3; // Max times to abort and retry before escalating
const BLOCKED_SYNC_INTERVAL_MS = 30_000;
const ISSUE_RELATIONSHIP_TTL_MS = 60_000;
const IGNORED_BODY_DEPS_LOG_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IGNORED_BODY_DEPS_LOG_MAX_KEYS = 2000;
const BLOCKED_REASON_MAX_LEN = 200;
const BLOCKED_DETAILS_MAX_LEN = 2000;
const CI_DEBUG_LEASE_TTL_MS = 20 * 60_000;
const CI_DEBUG_COMMENT_SCAN_LIMIT = 50;
const CI_DEBUG_COMMENT_MIN_EDIT_MS = 60_000;

interface IntrospectionSummary {
  sessionId: string;
  endTime: number;
  toolResultAsTextCount: number;
  totalToolCalls: number;
  stepCount: number;
  hasAnomalies: boolean;
  recentTools: string[];
}

interface LiveAnomalyCount {
  total: number;
  recentBurst: boolean;
}

async function readIntrospectionSummary(sessionId: string): Promise<IntrospectionSummary | null> {
  if (!isSafeSessionId(sessionId)) return null;
  const summaryPath = join(getRalphSessionDir(sessionId), "summary.json");
  if (!existsSync(summaryPath)) return null;
  
  try {
    const content = await readFile(summaryPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Read live anomaly count from the session's events.jsonl.
 * Returns total count and whether there's been a recent burst.
 */
async function readLiveAnomalyCount(sessionId: string): Promise<LiveAnomalyCount> {
  if (!isSafeSessionId(sessionId)) return { total: 0, recentBurst: false };
  const eventsPath = getSessionEventsPath(sessionId);
  if (!existsSync(eventsPath)) return { total: 0, recentBurst: false };

  try {
    const content = await readFile(eventsPath, "utf8");
    return computeLiveAnomalyCountFromJsonl(content, Date.now());
  } catch {
    return { total: 0, recentBurst: false };
  }
}

function hasRepeatedToolPattern(recentEvents?: string[]): boolean {
  if (!recentEvents?.length) return false;
  const counts = new Map<string, number>();

  for (const line of recentEvents) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (!event || typeof event !== "object" || event.type !== "tool-start") continue;
    const toolName = String(event.toolName ?? "");
    if (!toolName) continue;
    const argsPreview = typeof event.argsPreview === "string" ? event.argsPreview : "";
    const key = `${toolName}:${argsPreview}`;
    const nextCount = (counts.get(key) ?? 0) + 1;
    if (nextCount >= 3) return true;
    counts.set(key, nextCount);
  }

  return false;
}

async function cleanupIntrospectionLogs(sessionId: string): Promise<void> {
  try {
    await cleanupSessionArtifacts(sessionId);
  } catch (e) {
    console.warn(`[ralph:worker] Failed to cleanup introspection logs: ${e}`);
  }
}

export interface AgentRun {
  taskName: string;
  repo: string;
  outcome: "success" | "throttled" | "escalated" | "failed";
  pr?: string;
  sessionId?: string;
  escalationReason?: string;
  surveyResults?: string;
}

function safeNoteName(name: string): string {
  return name
    .replace(/[\\/]/g, " - ")
    .replace(/[:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeForNote(text: string, maxChars = 900): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars).trimEnd() + "…";
}

function sanitizeDiagnosticsText(text: string): string {
  return sanitizeEscalationReason(text);
}

function summarizeBlockedReason(text: string): string {
  const trimmed = sanitizeDiagnosticsText(text).trim();
  if (!trimmed) return "";
  if (trimmed.length <= BLOCKED_REASON_MAX_LEN) return trimmed;
  return trimmed.slice(0, BLOCKED_REASON_MAX_LEN).trimEnd() + "…";
}

function buildRunDetails(result: AgentRun | null): RalphRunDetails | undefined {
  if (!result) return undefined;
  const details: RalphRunDetails = {};

  if (result.pr) {
    details.prUrl = result.pr;
  }

  if (result.outcome === "escalated") {
    details.reasonCode = "escalated";
  }

  if (result.outcome === "failed") {
    details.reasonCode = "failed";
  }

  return Object.keys(details).length ? details : undefined;
}

function normalizeMergeStateStatus(value: unknown): PullRequestMergeStateStatus | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;
  const upper = trimmed.toUpperCase();
  switch (upper) {
    case "BEHIND":
    case "BLOCKED":
    case "CLEAN":
    case "DIRTY":
    case "DRAFT":
    case "HAS_HOOKS":
    case "UNSTABLE":
    case "UNKNOWN":
      return upper as PullRequestMergeStateStatus;
    default:
      return "UNKNOWN";
  }
}

function formatMergeConflictMessage(params: {
  prUrl: string;
  baseRefName?: string | null;
}): { blockedReasonShort: string; notifyBody: string } {
  const baseRefName = params.baseRefName?.trim() || "";
  const blockedReasonShort = `PR has merge conflicts; CI will not start until conflicts are resolved. PR: ${params.prUrl}`;
  const notifyBody = [
    "PR has merge conflicts; GitHub will not start CI until conflicts are resolved.",
    "Resolve conflicts by rebasing/merging the base branch into the PR branch, then push updates.",
    `PR: ${params.prUrl}`,
    baseRefName ? `Base: ${baseRefName}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { blockedReasonShort, notifyBody };
}

function summarizeBlockedDetails(text: string): string {
  const trimmed = sanitizeDiagnosticsText(text).trim();
  if (!trimmed) return "";
  if (trimmed.length <= BLOCKED_DETAILS_MAX_LEN) return trimmed;
  return trimmed.slice(0, BLOCKED_DETAILS_MAX_LEN).trimEnd() + "…";
}

function buildBlockedSignature(source?: BlockedSource, reason?: string): string {
  return `${source ?? ""}::${reason ?? ""}`;
}

function computeBlockedPatch(
  task: AgentTask,
  opts: { source: BlockedSource; reason?: string; details?: string; nowIso: string }
): {
  patch: Record<string, string>;
  didEnterBlocked: boolean;
  reasonSummary: string;
  detailsSummary: string;
} {
  const reasonSummary = opts.reason ? summarizeBlockedReason(opts.reason) : "";
  const detailsSource = opts.details ?? opts.reason ?? "";
  const detailsSummary = detailsSource ? summarizeBlockedDetails(detailsSource) : "";
  const previousSignature = buildBlockedSignature(task["blocked-source"], task["blocked-reason"]);
  const nextSignature = buildBlockedSignature(opts.source, reasonSummary);
  const didChangeSignature = previousSignature !== nextSignature;
  const didEnterBlocked = task.status !== "blocked" || didChangeSignature;

  const patch: Record<string, string> = {
    "blocked-source": opts.source,
    "blocked-reason": reasonSummary,
    "blocked-details": detailsSummary,
    "blocked-checked-at": opts.nowIso,
  };

  if (didEnterBlocked) {
    patch["blocked-at"] = opts.nowIso;
  }

  return { patch, didEnterBlocked, reasonSummary, detailsSummary };
}

function applyTaskPatch(task: AgentTask, status: AgentTask["status"], patch: Record<string, string | number>): void {
  task.status = status;
  for (const [key, value] of Object.entries(patch)) {
    (task as unknown as Record<string, unknown>)[key] = typeof value === "number" ? String(value) : value;
  }
}

function buildAgentRunBodyPrefix(params: {
  task: AgentTask;
  headline: string;
  reason?: string;
  details?: string;
  sessionId?: string;
  runLogPath?: string;
}): string {
  const lines: string[] = [params.headline];
  lines.push("", `Issue: ${params.task.issue}`, `Repo: ${params.task.repo}`);
  if (params.sessionId) lines.push(`Session: ${params.sessionId}`);
  if (params.runLogPath) lines.push(`Run log: ${redactHomePathForDisplay(params.runLogPath)}`);
  if (params.sessionId && isSafeSessionId(params.sessionId)) {
    const eventsPath = getSessionEventsPath(params.sessionId);
    if (existsSync(eventsPath)) {
      lines.push(`Trace: ${redactHomePathForDisplay(eventsPath)}`);
    }
  }

  const sanitizedReason = params.reason ? sanitizeDiagnosticsText(params.reason) : "";
  const reasonSummary = sanitizedReason ? summarizeForNote(sanitizedReason, 800) : "";
  if (reasonSummary) lines.push("", `Reason: ${reasonSummary}`);

  const sanitizedDetails = params.details ? sanitizeDiagnosticsText(params.details) : "";
  const detailText =
    sanitizedDetails && sanitizedDetails !== sanitizedReason ? summarizeForNote(sanitizedDetails, 1400) : "";
  if (detailText) lines.push("", "Details:", detailText);

  return lines.join("\n").trim();
}

function resolveVaultPath(p: string): string {
  const vault = getBwrbVaultIfValid();
  if (!vault) return p;
  return isAbsolute(p) ? p : join(vault, p);
}

type RequiredCheckState = "SUCCESS" | "PENDING" | "FAILURE" | "UNKNOWN";

type PrCheck = {
  name: string;
  state: RequiredCheckState;
  rawState: string;
  detailsUrl?: string | null;
};

type RequiredChecksSummary = {
  status: "success" | "pending" | "failure";
  required: Array<{ name: string; state: RequiredCheckState; rawState: string; detailsUrl?: string | null }>;
  available: string[];
};

type CiDebugRecoveryOutcome =
  | {
      status: "success";
      prUrl: string;
      sessionId: string;
      headSha: string;
      summary: RequiredChecksSummary;
    }
  | {
      status: "failed" | "escalated";
      run: AgentRun;
    };

type ResolvedRequiredChecks = {
  checks: string[];
  source: "config" | "protection" | "none";
  branch?: string;
};

type FailedCheck = {
  name: string;
  state: RequiredCheckState;
  rawState: string;
  detailsUrl?: string | null;
};

type FailedCheckLog = FailedCheck & {
  runId?: string;
  runUrl?: string;
  logExcerpt?: string;
};

type RestrictionEntry = { login?: string | null; slug?: string | null };

type RestrictionList = {
  users?: RestrictionEntry[] | null;
  teams?: RestrictionEntry[] | null;
  apps?: RestrictionEntry[] | null;
};

type BranchProtection = {
  required_status_checks?: {
    strict?: boolean | null;
    contexts?: string[] | null;
    checks?: Array<{ context?: string | null }> | null;
  } | null;
  enforce_admins?: { enabled?: boolean | null } | boolean | null;
  required_pull_request_reviews?: {
    dismissal_restrictions?: RestrictionList | null;
    dismiss_stale_reviews?: boolean | null;
    require_code_owner_reviews?: boolean | null;
    required_approving_review_count?: number | null;
    require_last_push_approval?: boolean | null;
    bypass_pull_request_allowances?: RestrictionList | null;
  } | null;
  restrictions?: RestrictionList | null;
  required_linear_history?: { enabled?: boolean | null } | boolean | null;
  allow_force_pushes?: { enabled?: boolean | null } | boolean | null;
  allow_deletions?: { enabled?: boolean | null } | boolean | null;
  block_creations?: { enabled?: boolean | null } | boolean | null;
  required_conversation_resolution?: { enabled?: boolean | null } | boolean | null;
  required_signatures?: { enabled?: boolean | null } | boolean | null;
  lock_branch?: { enabled?: boolean | null } | boolean | null;
  allow_fork_syncing?: { enabled?: boolean | null } | boolean | null;
};

type CheckRunsResponse = {
  check_runs?: Array<{ name?: string | null }> | null;
};

type CommitStatusResponse = {
  statuses?: Array<{ context?: string | null }> | null;
};

type RepoDetails = {
  default_branch?: string | null;
};

type PullRequestDetails = {
  number?: number | null;
  url?: string | null;
  merged?: boolean | null;
  merged_at?: string | null;
  base?: { ref?: string | null } | null;
  head?: { ref?: string | null; sha?: string | null; repo?: { full_name?: string | null } | null } | null;
};

type PullRequestDetailsNormalized = {
  number: number;
  url: string;
  merged: boolean;
  baseRefName: string;
  headRefName: string;
  headRepoFullName: string;
  headSha: string;
};

type GitRef = {
  object?: { sha?: string | null } | null;
};

function toSortedUniqueStrings(values: Array<string | null | undefined>): string[] {
  const normalized = values.map((value) => (value ?? "").trim()).filter(Boolean);
  return Array.from(new Set(normalized)).sort();
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function normalizeEnabledFlag(value: { enabled?: boolean | null } | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  return Boolean(value?.enabled);
}

function normalizeRestrictions(source: RestrictionList | null | undefined): { users: string[]; teams: string[]; apps: string[] } | null {
  const users = toSortedUniqueStrings(source?.users?.map((entry) => entry?.login ?? "") ?? []);
  const teams = toSortedUniqueStrings(source?.teams?.map((entry) => entry?.slug ?? "") ?? []);
  const apps = toSortedUniqueStrings(source?.apps?.map((entry) => entry?.slug ?? "") ?? []);
  if (users.length === 0 && teams.length === 0 && apps.length === 0) return null;
  return { users, teams, apps };
}

function hasBypassAllowances(source: RestrictionList | null | undefined): boolean {
  const normalized = normalizeRestrictions(source);
  if (!normalized) return false;
  return normalized.users.length > 0 || normalized.teams.length > 0 || normalized.apps.length > 0;
}

function getProtectionContexts(protection: BranchProtection | null): string[] {
  const contexts = protection?.required_status_checks?.contexts ?? [];
  const checks = protection?.required_status_checks?.checks ?? [];
  const checkContexts = checks.map((check) => check?.context ?? "");
  return toSortedUniqueStrings([...contexts, ...checkContexts]);
}

function extractPullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)(?:$|\b|\/)/);
  if (!match) return null;
  return Number.parseInt(match[1], 10);
}

const CI_ONLY_PATH_PREFIXES = [".github/workflows/", ".github/actions/"] as const;
const CI_ONLY_PATH_EXACT = [".github/action.yml", ".github/action.yaml"] as const;
const CI_LABEL_KEYWORDS = ["ci", "build", "infra"] as const;

function isCiOnlyPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (!normalized) return false;
  if (CI_ONLY_PATH_EXACT.includes(normalized as (typeof CI_ONLY_PATH_EXACT)[number])) return true;
  return CI_ONLY_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isCiOnlyChangeSet(files: string[]): boolean {
  const normalized = files.map((file) => file.trim()).filter(Boolean);
  if (normalized.length === 0) return false;
  return normalized.every((file) => isCiOnlyPath(file));
}

function isCiRelatedIssue(labels: string[]): boolean {
  return labels.some((label) => {
    const normalized = label.toLowerCase();
    return CI_LABEL_KEYWORDS.some((keyword) => {
      const re = new RegExp(`(^|[-_/])${keyword}($|[-_/])`);
      return re.test(normalized);
    });
  });
}

export function __isCiOnlyChangeSetForTests(files: string[]): boolean {
  return isCiOnlyChangeSet(files);
}

export function __isCiRelatedIssueForTests(labels: string[]): boolean {
  return isCiRelatedIssue(labels);
}

function normalizeRequiredCheckState(raw: string | null | undefined): RequiredCheckState {
  const val = String(raw ?? "").toUpperCase();
  if (!val) return "UNKNOWN";
  if (val === "SUCCESS") return "SUCCESS";

  // Common non-success terminal states.
  if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STALE"].includes(val)) {
    return "FAILURE";
  }

  // Treat everything else (including IN_PROGRESS, QUEUED, PENDING) as pending.
  return "PENDING";
}

function summarizeRequiredChecks(allChecks: PrCheck[], requiredChecks: string[]): RequiredChecksSummary {
  const available = Array.from(new Set(allChecks.map((c) => c.name))).sort();

  const required = requiredChecks.map((name) => {
    const match = allChecks.find((c) => c.name === name);
    if (!match) return { name, state: "UNKNOWN" as const, rawState: "missing" };
    return { name, state: match.state, rawState: match.rawState, detailsUrl: match.detailsUrl };
  });

  if (requiredChecks.length === 0) {
    return { status: "success", required: [], available };
  }

  const hasFailure = required.some((c) => c.state === "FAILURE");
  if (hasFailure) return { status: "failure", required, available };

  const allSuccess = required.length > 0 && required.every((c) => c.state === "SUCCESS");
  if (allSuccess) return { status: "success", required, available };

  return { status: "pending", required, available };
}

const REQUIRED_CHECKS_BACKOFF_MULTIPLIER = 1.5;
const REQUIRED_CHECKS_MAX_POLL_MS = 120_000;
const REQUIRED_CHECKS_JITTER_PCT = 0.2;
const REQUIRED_CHECKS_LOG_INTERVAL_MS = 60_000;

function applyRequiredChecksJitter(valueMs: number, jitterPct = REQUIRED_CHECKS_JITTER_PCT): number {
  const clamped = Math.max(1000, valueMs);
  const variance = clamped * jitterPct;
  const delta = (Math.random() * 2 - 1) * variance;
  return Math.max(1000, Math.round(clamped + delta));
}

function buildRequiredChecksSignature(summary: RequiredChecksSummary): string {
  return JSON.stringify({
    status: summary.status,
    required: summary.required.map((check) => ({
      name: check.name,
      state: check.state,
      rawState: check.rawState,
    })),
  });
}

function computeRequiredChecksDelay(params: {
  baseIntervalMs: number;
  maxIntervalMs: number;
  attempt: number;
  lastSignature: string | null;
  nextSignature: string;
  pending: boolean;
}): { delayMs: number; nextAttempt: number; reason: "progress" | "backoff" } {
  if (!params.pending) {
    return { delayMs: params.baseIntervalMs, nextAttempt: 0, reason: "progress" };
  }

  if (params.lastSignature && params.lastSignature === params.nextSignature) {
    const nextAttempt = params.attempt + 1;
    const delay = Math.min(
      Math.round(params.baseIntervalMs * Math.pow(REQUIRED_CHECKS_BACKOFF_MULTIPLIER, nextAttempt)),
      params.maxIntervalMs
    );
    return { delayMs: delay, nextAttempt, reason: "backoff" };
  }

  return { delayMs: params.baseIntervalMs, nextAttempt: 0, reason: "progress" };
}

export function __computeRequiredChecksDelayForTests(
  params: Parameters<typeof computeRequiredChecksDelay>[0]
): ReturnType<typeof computeRequiredChecksDelay> {
  return computeRequiredChecksDelay(params);
}

export function __summarizeRequiredChecksForTests(
  allChecks: PrCheck[],
  requiredChecks: string[]
): RequiredChecksSummary {
  return summarizeRequiredChecks(allChecks, requiredChecks);
}

export const __TEST_ONLY_DEFAULT_BRANCH = "__default_branch__";

export const __TEST_ONLY_DEFAULT_SHA = "__default_sha__";

export function __buildRepoDefaultBranchResponse(): RepoDetails {
  return { default_branch: __TEST_ONLY_DEFAULT_BRANCH };
}

export function __buildGitRefResponse(sha: string): GitRef {
  return { object: { sha } };
}

export function __buildCheckRunsResponse(names: string[]): CheckRunsResponse {
  return { check_runs: names.map((name) => ({ name })) };
}

function formatRequiredChecksForHumans(summary: RequiredChecksSummary): string {
  const lines: string[] = [];
  lines.push(`Required checks: ${summary.required.map((c) => c.name).join(", ") || "(none)"}`);
  for (const chk of summary.required) {
    const details = chk.detailsUrl ? ` (${chk.detailsUrl})` : "";
    lines.push(`- ${chk.name}: ${chk.rawState}${details}`);
  }

  if (summary.available.length > 0) {
    lines.push("", "Available check contexts:", ...summary.available.map((c) => `- ${c}`));
  }

  return lines.join("\n");
}

type RequiredChecksGuidanceInput = {
  repo: string;
  branch: string;
  requiredChecks: string[];
  missingChecks: string[];
  availableChecks: string[];
};

type CheckLogResult = {
  runId?: string;
  runUrl?: string;
  logExcerpt?: string;
};

type RemediationFailureContext = {
  summary: RequiredChecksSummary;
  failedChecks: FailedCheck[];
  logs: FailedCheckLog[];
  logWarnings: string[];
  commands: string[];
};

function formatRequiredChecksGuidance(input: RequiredChecksGuidanceInput): string {
  const lines = [
    `Repo: ${input.repo}`,
    `Branch: ${input.branch}`,
    `Required checks: ${input.requiredChecks.join(", ") || "(none)"}`,
    `Missing checks: ${input.missingChecks.join(", ") || "(none)"}`,
    `Available check contexts: ${input.availableChecks.join(", ") || "(none)"}`,
    "Next steps: trigger CI on this branch (push a commit or rerun workflows), or update repos[].requiredChecks (set [] to disable gating).",
  ];

  return lines.join("\n");
}

const MAIN_MERGE_OVERRIDE_LABEL = "allow-main";

function isMainMergeOverride(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase() === MAIN_MERGE_OVERRIDE_LABEL);
}

function isMainMergeAllowed(baseBranch: string | null, botBranch: string, labels: string[]): boolean {
  if (!baseBranch) return true;
  if (baseBranch !== "main") return true;
  if (botBranch === "main") return true;
  if (isMainMergeOverride(labels)) return true;
  return false;
}

export function __formatRequiredChecksGuidanceForTests(input: RequiredChecksGuidanceInput): string {
  return formatRequiredChecksGuidance(input);
}

export class RepoWorker {
  private session: SessionAdapter;
  private baseSession: SessionAdapter;
  private queue: QueueAdapter;
  private notify: NotifyAdapter;
  private throttle: ThrottleAdapter;
  private github: GitHubClient;
  private labelEnsurer: ReturnType<typeof createRalphWorkflowLabelsEnsurer>;
  private contextRecoveryContext: { task: AgentTask; repoPath: string; planPath: string } | null = null;
  private contextCompactAttempts = new Map<string, number>();

  constructor(
    public readonly repo: string,
    public readonly repoPath: string,
    opts?: {
      session?: SessionAdapter;
      queue?: QueueAdapter;
      notify?: NotifyAdapter;
      throttle?: ThrottleAdapter;
      relationships?: IssueRelationshipProvider;
    }
  ) {
    this.baseSession = opts?.session ?? DEFAULT_SESSION_ADAPTER;
    this.session = this.createContextRecoveryAdapter(this.baseSession);
    this.queue = opts?.queue ?? DEFAULT_QUEUE_ADAPTER;
    this.notify = opts?.notify ?? DEFAULT_NOTIFY_ADAPTER;
    this.throttle = opts?.throttle ?? DEFAULT_THROTTLE_ADAPTER;
    this.github = new GitHubClient(this.repo);
    this.relationships = opts?.relationships ?? new GitHubRelationshipProvider(this.repo, this.github);
    this.labelEnsurer = createRalphWorkflowLabelsEnsurer({
      githubFactory: () => this.github,
    });
  }

  private ensureBranchProtectionPromise: Promise<void> | null = null;
  private requiredChecksForMergePromise: Promise<ResolvedRequiredChecks> | null = null;
  private repoSlotsInUse: Set<number> | null = null;
  private relationships: IssueRelationshipProvider;
  private relationshipCache = new Map<string, { ts: number; snapshot: IssueRelationshipSnapshot }>();
  private relationshipInFlight = new Map<string, Promise<IssueRelationshipSnapshot | null>>();
  private lastBlockedSyncAt = 0;
  private ignoredBodyDepsLogLimiter = new LogLimiter({ maxKeys: IGNORED_BODY_DEPS_LOG_MAX_KEYS });
  private requiredChecksLogLimiter = new LogLimiter({ maxKeys: 2000 });
  private prResolutionCache = new Map<string, Promise<ResolvedIssuePr>>();

  private async blockDisallowedRepo(task: AgentTask, started: Date, phase: "start" | "resume"): Promise<AgentRun> {
    const completed = new Date();
    const completedAt = completed.toISOString().split("T")[0];
    const owners = getAllowedOwners();

    const reason = `Repo owner is not in allowlist (repo=${task.repo}, allowedOwners=${owners.join(", ") || "none"})`;

    console.warn(`[ralph:worker:${this.repo}] RALPH_BLOCKED_ALLOWLIST ${reason}`);

    await this.createAgentRun(task, {
      outcome: "failed",
      started,
      completed,
      sessionId: task["session-id"]?.trim() || undefined,
      bodyPrefix: [
        "Blocked: repo owner not in allowlist",
        "",
        `Phase: ${phase}`,
        `Repo: ${task.repo}`,
        `Allowed owners: ${owners.join(", ")}`,
      ].join("\n"),
    });

    await this.markTaskBlocked(task, "allowlist", {
      reason,
      skipRunNote: true,
      extraFields: {
        "completed-at": completedAt,
        "session-id": "",
        "watchdog-retries": "",
        ...(task["worktree-path"] ? { "worktree-path": "" } : {}),
        ...(task["worker-id"] ? { "worker-id": "" } : {}),
        ...(task["repo-slot"] ? { "repo-slot": "" } : {}),
      },
    });

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "failed",
      escalationReason: reason,
    };
  }

  private async recordRunLogPath(
    task: AgentTask,
    issueNumber: string,
    stepTitle: string,
    status: AgentTask["status"]
  ): Promise<string | undefined> {
    const runLogPath = getRalphRunLogPath({ repo: this.repo, issueNumber, stepTitle, ts: Date.now() });
    const updated = await this.queue.updateTaskStatus(task, status, { "run-log-path": runLogPath });
    if (!updated) {
      console.warn(`[ralph:worker:${this.repo}] Failed to persist run-log-path (continuing): ${runLogPath}`);
    }
    return runLogPath;
  }

  private async withSessionAdapters<T>(
    next: { baseSession: SessionAdapter; session: SessionAdapter },
    run: () => Promise<T>
  ): Promise<T> {
    const previousBase = this.baseSession;
    const previousSession = this.session;
    this.baseSession = next.baseSession;
    this.session = next.session;

    try {
      return await run();
    } finally {
      this.baseSession = previousBase;
      this.session = previousSession;
    }
  }

  private async withRunContext(
    task: AgentTask,
    attemptKind: RalphRunAttemptKind,
    run: () => Promise<AgentRun>
  ): Promise<AgentRun> {
    let runId: string | null = null;

    try {
      runId = createRalphRun({
        repo: this.repo,
        issue: task.issue,
        taskPath: task._path,
        attemptKind,
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to create run record for ${task.name}: ${error?.message ?? String(error)}`
      );
    }

    if (!runId) {
      return await run();
    }

    const recordingBase = createRunRecordingSessionAdapter({
      base: this.baseSession,
      runId,
      repo: this.repo,
      issue: task.issue,
    });
    const recordingSession = this.createContextRecoveryAdapter(recordingBase);

    let result: AgentRun | null = null;

    try {
      result = await this.withSessionAdapters({ baseSession: recordingBase, session: recordingSession }, run);
      return result;
    } finally {
      try {
        completeRalphRun({
          runId,
          outcome: result?.outcome ?? "failed",
          details: buildRunDetails(result),
        });
      } catch (error: any) {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to complete run record for ${task.name}: ${error?.message ?? String(error)}`
        );
      }
    }
  }

  private formatSetupFailureReason(failure: SetupFailure): string {
    const lines: string[] = [];
    if (failure.command) {
      lines.push(`Setup command failed (${failure.commandIndex}/${failure.totalCommands}).`);
      lines.push(`Command: ${failure.command}`);
      const exitInfo = [
        `Exit code: ${failure.exitCode ?? "null"}`,
        failure.signal ? `Signal: ${failure.signal}` : "",
        failure.timedOut ? "Timed out: true" : "",
      ]
        .filter(Boolean)
        .join(" ");
      if (exitInfo) lines.push(exitInfo);
    } else if (failure.reason) {
      lines.push(failure.reason);
    }
    if (failure.outputTail) {
      lines.push("Output tail:");
      lines.push(failure.outputTail);
    }
    return lines.join("\n").trim() || "Setup failed.";
  }

  private async escalateSetupFailure(task: AgentTask, reason: string, sessionId?: string): Promise<AgentRun> {
    const wasEscalated = task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(task, "escalated");
    if (escalated) {
      applyTaskPatch(task, "escalated", {});
    }

    await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
    await this.notify.notifyEscalation({
      taskName: task.name,
      taskFileName: task._name,
      taskPath: task._path,
      issue: task.issue,
      repo: this.repo,
      scope: task.scope,
      priority: task.priority,
      sessionId: (sessionId ?? task["session-id"]?.trim()) || undefined,
      reason,
      escalationType: "other",
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(task, { reason, sessionId, details: reason });
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId,
      escalationReason: reason,
    };
  }

  private async ensureSetupForTask(params: {
    task: AgentTask;
    issueNumber: string;
    taskRepoPath: string;
    status: AgentTask["status"];
    sessionId?: string;
  }): Promise<AgentRun | null> {
    const setupCommands = getRepoSetupCommands(this.repo);
    if (!setupCommands || setupCommands.length === 0) return null;

    const setupRunLogPath = await this.recordRunLogPath(params.task, params.issueNumber, "setup", params.status);
    const result = await ensureWorktreeSetup({
      worktreePath: params.taskRepoPath,
      commands: setupCommands,
      runLogPath: setupRunLogPath,
    });

    if (result.ok) {
      if (result.skipped) {
        console.log(`[ralph:worker:${this.repo}] Setup skipped: ${result.skipReason ?? "no reason"}`);
      } else {
        console.log(`[ralph:worker:${this.repo}] Setup completed successfully.`);
      }
      return null;
    }

    const failure = result.failure ?? {
      command: "",
      commandIndex: 0,
      totalCommands: setupCommands.length,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      outputTail: "",
      reason: "Setup failed.",
    };

    const reason = this.formatSetupFailureReason(failure);
    console.warn(`[ralph:worker:${this.repo}] Setup failed; escalating: ${reason}`);
    return await this.escalateSetupFailure(params.task, reason, params.sessionId);
  }

  private createContextRecoveryAdapter(base: SessionAdapter): SessionAdapter {
    return {
      runAgent: async (repoPath, agent, message, options, testOverrides) => {
        const result = await base.runAgent(repoPath, agent, message, options, testOverrides);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId: result.sessionId,
          stepKey: options?.introspection?.stepTitle ?? `agent:${agent}`,
          result,
          options,
        });
      },
      continueSession: async (repoPath, sessionId, message, options) => {
        const result = await base.continueSession(repoPath, sessionId, message, options);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId,
          stepKey: options?.introspection?.stepTitle ?? `session:${sessionId}`,
          result,
          options,
        });
      },
      continueCommand: async (repoPath, sessionId, command, args, options) => {
        const result = await base.continueCommand(repoPath, sessionId, command, args, options);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId,
          stepKey: options?.introspection?.stepTitle ?? `command:${command}`,
          result,
          options,
          command,
        });
      },
      getRalphXdgCacheHome: base.getRalphXdgCacheHome,
    };
  }

  private recordContextCompactAttempt(task: AgentTask, stepKey: string): { allowed: boolean; attempt: number } {
    const key = `${task._path}:${stepKey}`;
    const next = (this.contextCompactAttempts.get(key) ?? 0) + 1;
    this.contextCompactAttempts.set(key, next);
    return { allowed: next <= 1, attempt: next };
  }

  private buildContextRecoveryOptions(
    options: RunSessionOptionsBase | undefined,
    stepTitle: string
  ): RunSessionOptionsBase {
    const introspection = {
      ...(options?.introspection ?? {}),
      stepTitle,
    };
    return { ...(options ?? {}), introspection };
  }

  private async getWorktreeStatusPorcelain(worktreePath: string): Promise<string> {
    try {
      const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
      return status.stdout.toString().trim();
    } catch (e: any) {
      return `ERROR: ${e?.message ?? String(e)}`;
    }
  }

  private async maybeRecoverFromContextLengthExceeded(params: {
    repoPath: string;
    sessionId?: string;
    stepKey: string;
    result: SessionResult;
    options?: RunSessionOptionsBase;
    command?: string;
  }): Promise<SessionResult> {
    if (params.result.success || params.result.errorCode !== "context_length_exceeded") return params.result;
    if (params.command === "compact") return params.result;

    const context = this.contextRecoveryContext;
    if (!context) return params.result;

    const sessionId = params.result.sessionId?.trim() || params.sessionId?.trim();
    if (!sessionId) return params.result;

    const attempt = this.recordContextCompactAttempt(context.task, params.stepKey);
    if (!attempt.allowed) return params.result;

    const compactOptions = this.buildContextRecoveryOptions(
      params.options,
      `context compact (${params.stepKey})`
    );
    const resumeOptions = this.buildContextRecoveryOptions(
      params.options,
      `context resume (${params.stepKey})`
    );

    const gitStatus = await this.getWorktreeStatusPorcelain(params.repoPath);
    const resumeMessage = buildContextResumePrompt({
      planPath: context.planPath,
      gitStatus,
    });

    const recovered = await retryContextCompactOnce({
      session: this.baseSession,
      repoPath: params.repoPath,
      sessionId,
      stepKey: params.stepKey,
      attempt,
      resumeMessage,
      compactOptions,
      resumeOptions,
      onEvent: (event) => {
        ralphEventBus.publish(
          buildRalphEvent({
            type: "worker.context_compact.triggered",
            level: "info",
            repo: this.repo,
            taskId: context.task._path,
            sessionId: event.sessionId,
            data: {
              stepTitle: event.stepKey,
              attempt: event.attempt,
            },
          })
        );
      },
    });

    return recovered ?? params.result;
  }

  private async prepareContextRecovery(task: AgentTask, worktreePath: string): Promise<void> {
    try {
      await ensureRalphWorktreeArtifacts(worktreePath);
    } catch (e: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to ensure worktree artifacts at ${worktreePath}: ${e?.message ?? String(e)}`
      );
    }

    this.contextRecoveryContext = {
      task,
      repoPath: worktreePath,
      planPath: RALPH_PLAN_RELATIVE_PATH,
    };
  }

  private async getRepoRootStatusPorcelain(): Promise<string> {
    try {
      const status = await $`git status --porcelain`.cwd(this.repoPath).quiet();
      return status.stdout.toString().trim();
    } catch (e: any) {
      throw new Error(`Failed to check repo root status: ${e?.message ?? String(e)}`);
    }
  }

  private async assertRepoRootClean(task: AgentTask, phase: "start" | "resume" | "post-run"): Promise<void> {
    const status = await this.getRepoRootStatusPorcelain();
    if (!status) return;

    const worktreePath = task["worktree-path"]?.trim();
    if (worktreePath && !this.isSameRepoRootPath(worktreePath)) {
      console.warn(
        `[ralph:worker:${this.repo}] Repo root dirty but task is isolated in worktree (${phase}); continuing.`
      );
      return;
    }

    const reason = `Repo root has uncommitted changes; refusing to run to protect main checkout (${phase}).`;
    const message = [reason, "", "Status:", status].join("\n");

    await this.markTaskBlocked(task, "dirty-repo", {
      reason,
      skipRunNote: true,
      extraFields: {
        "completed-at": new Date().toISOString().split("T")[0],
        "session-id": "",
        "watchdog-retries": "",
        ...(task["worktree-path"] ? { "worktree-path": "" } : {}),
      },
    });

    await this.createAgentRun(task, {
      outcome: "failed",
      started: new Date(),
      completed: new Date(),
      sessionId: task["session-id"]?.trim() || undefined,
      bodyPrefix: [
        "Blocked: repo root dirty",
        "",
        `Phase: ${phase}`,
        `Repo: ${task.repo}`,
        "",
        "Status:",
        status,
      ].join("\n"),
    });

    await this.notify.notifyError(`Worker isolation guardrail: ${task.name}`, message, task.name);

    const error = new Error(reason) as Error & { ralphRootDirty?: boolean };
    error.ralphRootDirty = true;
    throw error;
  }

  private async markTaskBlocked(
    task: AgentTask,
    source: BlockedSource,
    opts?: {
      reason?: string;
      details?: string;
      sessionId?: string;
      runLogPath?: string;
      extraFields?: Record<string, string | number>;
      skipRunNote?: boolean;
    }
  ): Promise<boolean> {
    if (!BLOCKED_SOURCES.includes(source)) {
      console.warn(`[ralph:worker:${this.repo}] Unknown blocked-source '${source}'; defaulting to runtime-error`);
      source = "runtime-error";
    }
    const nowIso = new Date().toISOString();
    const { patch, didEnterBlocked, reasonSummary } = computeBlockedPatch(task, {
      source,
      reason: opts?.reason,
      details: opts?.details,
      nowIso,
    });
    const extraFields = opts?.extraFields ?? {};
    const reservedBlockedFields = new Set([
      "blocked-source",
      "blocked-reason",
      "blocked-at",
      "blocked-details",
      "blocked-checked-at",
    ]);
    const sanitizedExtraFields = Object.fromEntries(
      Object.entries(extraFields).filter(([key]) => {
        if (!reservedBlockedFields.has(key)) return true;
        console.warn(`[ralph:worker:${this.repo}] Ignoring blocked override field '${key}' in markTaskBlocked`);
        return false;
      })
    );
    const updatePatch = { ...sanitizedExtraFields, ...patch };
    const updated = await this.queue.updateTaskStatus(task, "blocked", updatePatch);

    if (updated) {
      applyTaskPatch(task, "blocked", updatePatch);
    }

    if (updated && didEnterBlocked && !opts?.skipRunNote) {
      const sessionId = (opts?.sessionId ?? task["session-id"]?.trim()) || undefined;
      const runLogPath = (opts?.runLogPath ?? task["run-log-path"]?.trim()) || undefined;
      const details = opts?.details ?? opts?.reason ?? "";
      const bodyPrefix = buildAgentRunBodyPrefix({
        task,
        headline: `Blocked: ${source}`,
        reason: reasonSummary,
        details,
        sessionId,
        runLogPath,
      });
      const runTime = new Date();
      await this.createAgentRun(task, {
        outcome: "failed",
        sessionId,
        started: runTime,
        completed: runTime,
        bodyPrefix,
      });
    }

    return updated;
  }

  private async markTaskUnblocked(task: AgentTask): Promise<boolean> {
    const updatePatch = {
      "blocked-source": "",
      "blocked-reason": "",
      "blocked-at": "",
      "blocked-details": "",
      "blocked-checked-at": "",
    };
    const updated = await this.queue.updateTaskStatus(task, "queued", updatePatch);
    if (updated) {
      applyTaskPatch(task, "queued", updatePatch);
    }
    return updated;
  }

  private async recordEscalatedRunNote(task: AgentTask, params: { reason: string; sessionId?: string; details?: string }) {
    const sessionId = (params.sessionId ?? task["session-id"]?.trim()) || undefined;
    const runLogPath = task["run-log-path"]?.trim() || undefined;
    const bodyPrefix = buildAgentRunBodyPrefix({
      task,
      headline: "Escalated",
      reason: params.reason,
      details: params.details,
      sessionId,
      runLogPath,
    });
    const runTime = new Date();
    await this.createAgentRun(task, {
      outcome: "escalated",
      sessionId,
      started: runTime,
      completed: runTime,
      bodyPrefix,
    });
  }

  private async ensureRalphWorkflowLabelsOnce(): Promise<void> {
    await this.labelEnsurer.ensure(this.repo);
  }

  private async githubApiRequest<T>(
    path: string,
    opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}
  ): Promise<T | null> {
    const response = await this.github.request<T>(path, opts);
    return response.data;
  }

  private async addIssueLabel(issue: IssueRef, label: string): Promise<void> {
    const result = await executeIssueLabelOps({
      github: this.github,
      repo: issue.repo,
      issueNumber: issue.number,
      ops: [{ action: "add", label } satisfies LabelOp],
      log: (message: string) => console.warn(`[ralph:worker:${this.repo}] ${message}`),
      logLabel: `${issue.repo}#${issue.number}`,
      ensureLabels: async () => await this.labelEnsurer.ensure(issue.repo),
      retryMissingLabelOnce: true,
      ensureBefore: true,
    });
    if (!result.ok) {
      if (result.kind === "policy") {
        console.warn(`[ralph:worker:${this.repo}] ${String(result.error)}`);
        return;
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
  }

  private async removeIssueLabel(issue: IssueRef, label: string): Promise<void> {
    const result = await executeIssueLabelOps({
      github: this.github,
      repo: issue.repo,
      issueNumber: issue.number,
      ops: [{ action: "remove", label } satisfies LabelOp],
      log: (message: string) => console.warn(`[ralph:worker:${this.repo}] ${message}`),
      logLabel: `${issue.repo}#${issue.number}`,
      ensureLabels: async () => await this.labelEnsurer.ensure(issue.repo),
      retryMissingLabelOnce: true,
      ensureBefore: true,
    });
    if (!result.ok) {
      if (result.kind === "policy") {
        console.warn(`[ralph:worker:${this.repo}] ${String(result.error)}`);
        return;
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
  }

  private recordPrSnapshotBestEffort(input: { issue: string; prUrl: string; state: PrState }): void {
    try {
      recordPrSnapshot({ repo: this.repo, issue: input.issue, prUrl: input.prUrl, state: input.state });
    } catch (error: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to record PR snapshot: ${error?.message ?? String(error)}`);
    }
  }

  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string, nextPrUrl: string | null): string;
  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string | null, nextPrUrl: string | null): string | null;
  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string | null, nextPrUrl: string | null): string | null {
    if (!nextPrUrl) return currentPrUrl;
    if (nextPrUrl === currentPrUrl) return currentPrUrl;
    this.recordPrSnapshotBestEffort({ issue: task.issue, prUrl: nextPrUrl, state: PR_STATE_OPEN });
    return nextPrUrl;
  }

  private getIssuePrResolution(issueNumber: string): Promise<ResolvedIssuePr> {
    const cacheKey = `${this.repo}#${issueNumber}`;
    const cached = this.prResolutionCache.get(cacheKey);
    if (cached) return cached;
    const promise = this.findExistingOpenPrForIssue(issueNumber).catch((error) => {
      this.prResolutionCache.delete(cacheKey);
      throw error;
    });
    this.prResolutionCache.set(cacheKey, promise);
    return promise;
  }

  private async findExistingOpenPrForIssue(issueNumber: string): Promise<ResolvedIssuePr> {
    const diagnostics: string[] = [];
    const parsedIssue = Number(issueNumber);
    if (!Number.isFinite(parsedIssue)) {
      diagnostics.push("- Invalid issue number; skipping PR reuse");
      return { selectedUrl: null, duplicates: [], source: null, diagnostics };
    }

    const dbCandidates = await this.resolveDbPrCandidates(parsedIssue, diagnostics);
    if (dbCandidates.length > 0) {
      const resolved = selectCanonicalPr(dbCandidates);
      const result = this.buildResolvedIssuePr(issueNumber, resolved, "db", diagnostics);
      this.recordResolvedPrSnapshots(issueNumber, resolved);
      return result;
    }

    const searchCandidates = await this.resolveSearchPrCandidates(issueNumber, diagnostics);
    if (searchCandidates.length > 0) {
      const resolved = selectCanonicalPr(searchCandidates);
      const result = this.buildResolvedIssuePr(issueNumber, resolved, "gh-search", diagnostics);
      this.recordResolvedPrSnapshots(issueNumber, resolved);
      return result;
    }

    return { selectedUrl: null, duplicates: [], source: null, diagnostics };
  }

  private buildResolvedIssuePr(
    issueNumber: string,
    resolved: { selected: ResolvedPrCandidate | null; duplicates: ResolvedPrCandidate[] },
    source: "db" | "gh-search",
    diagnostics: string[]
  ): ResolvedIssuePr {
    if (resolved.selected) {
      diagnostics.push(`- Reusing PR: ${resolved.selected.url} (source=${source})`);
      if (resolved.duplicates.length > 0) {
        diagnostics.push(`- Duplicate PRs detected: ${resolved.duplicates.map((dup) => dup.url).join(", ")}`);
      }
    }

    return {
      selectedUrl: resolved.selected?.url ?? null,
      duplicates: resolved.duplicates.map((dup) => dup.url),
      source,
      diagnostics,
    };
  }

  private recordResolvedPrSnapshots(
    issueNumber: string,
    resolved: { selected: ResolvedPrCandidate | null; duplicates: ResolvedPrCandidate[] }
  ): void {
    const issueRef = `${this.repo}#${issueNumber}`;
    if (resolved.selected) {
      this.recordPrSnapshotBestEffort({ issue: issueRef, prUrl: resolved.selected.url, state: PR_STATE_OPEN });
    }
    for (const duplicate of resolved.duplicates) {
      this.recordPrSnapshotBestEffort({ issue: issueRef, prUrl: duplicate.url, state: PR_STATE_OPEN });
    }
  }

  private async resolveDbPrCandidates(issueNumber: number, diagnostics: string[]): Promise<ResolvedPrCandidate[]> {
    const rows = listOpenPrCandidatesForIssue(this.repo, issueNumber);
    if (rows.length === 0) return [];
    diagnostics.push(`- DB PR candidates: ${rows.length}`);

    const results: ResolvedPrCandidate[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const normalized = normalizePrUrl(row.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      try {
        const view = await viewPullRequest(this.repo, row.url);
        if (!view) continue;
        const state = String(view.state ?? "").toUpperCase();
        if (state !== "OPEN") continue;
        results.push({
          url: view.url,
          source: "db",
          ghCreatedAt: view.createdAt,
          ghUpdatedAt: view.updatedAt,
          dbUpdatedAt: row.updatedAt,
        });
        if (view.isDraft) {
          diagnostics.push(`- Existing PR is draft: ${view.url}`);
        }
      } catch (error: any) {
        diagnostics.push(`- Failed to validate PR ${row.url}: ${this.formatGhError(error)}`);
      }
    }

    return results;
  }

  private async resolveSearchPrCandidates(issueNumber: string, diagnostics: string[]): Promise<ResolvedPrCandidate[]> {
    let searchResults: PullRequestSearchResult[] = [];
    try {
      searchResults = await searchOpenPullRequestsByIssueLink(this.repo, issueNumber);
    } catch (error: any) {
      diagnostics.push(`- GitHub PR search failed: ${this.formatGhError(error)}`);
      return [];
    }

    if (searchResults.length === 0) return [];
    diagnostics.push(`- GitHub PR search candidates: ${searchResults.length}`);

    const results: ResolvedPrCandidate[] = [];
    const seen = new Set<string>();
    for (const result of searchResults) {
      const normalized = normalizePrUrl(result.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({
        url: result.url,
        source: "gh-search",
        ghCreatedAt: result.createdAt,
        ghUpdatedAt: result.updatedAt,
      });
    }

    return results;
  }

  private isSamePrUrl(left: string | null | undefined, right: string | null | undefined): boolean {
    if (!left || !right) return false;
    return normalizePrUrl(left) === normalizePrUrl(right);
  }

  private async applyMidpointLabelsBestEffort(params: {
    task: AgentTask;
    prUrl: string | null;
    botBranch: string;
    baseBranch?: string | null;
  }): Promise<void> {
    const issueRef = parseIssueRef(params.task.issue, this.repo);
    if (!issueRef) return;
    if (!params.prUrl) return;
    await applyMidpointLabelsBestEffortCore({
      issueRef,
      issue: params.task.issue,
      taskName: params.task.name,
      prUrl: params.prUrl,
      botBranch: params.botBranch,
      baseBranch: params.baseBranch ?? "",
      fetchDefaultBranch: async () => this.fetchRepoDefaultBranch(),
      fetchBaseBranch: async (prUrl) => this.getPullRequestBaseBranch(prUrl),
      addIssueLabel: async (issue, label) => this.addIssueLabel(issue, label),
      removeIssueLabel: async (issue, label) => this.removeIssueLabel(issue, label),
      notifyError: async (title, body, taskName) => this.notify.notifyError(title, body, taskName ?? undefined),
      warn: (message) => console.warn(`[ralph:worker:${this.repo}] ${message}`),
    });
  }

  private async writeEscalationWriteback(
    task: AgentTask,
    params: { reason: string; details?: string; escalationType: EscalationContext["escalationType"] }
  ): Promise<string | null> {
    const escalationIssueRef = parseIssueRef(task.issue, task.repo);
    if (!escalationIssueRef) {
      console.warn(`[ralph:worker:${this.repo}] Cannot parse issue ref for escalation writeback: ${task.issue}`);
      return null;
    }

    try {
      await this.ensureRalphWorkflowLabelsOnce();
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to ensure ralph workflow labels before escalation writeback: ${
          error?.message ?? String(error)
        }`
      );
    }

    try {
      const result = await writeEscalationToGitHub(
        {
          repo: escalationIssueRef.repo,
          issueNumber: escalationIssueRef.number,
          taskName: task.name,
          taskPath: task._path ?? task.name,
          reason: params.reason,
          details: params.details,
          escalationType: params.escalationType,
        },
        {
          github: this.github,
          log: (message) => console.log(message),
        }
      );
      return result.commentUrl ?? null;
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Escalation writeback failed for ${task.issue}: ${error?.message ?? String(error)}`
      );
    }
    return null;
  }

  private isNoCommitFoundError(error: unknown): boolean {
    if (!(error instanceof GitHubApiError)) return false;
    if (error.status !== 422) return false;
    return /No commit found for SHA/i.test(error.responseText);
  }

  private isRefAlreadyExistsError(error: unknown): boolean {
    if (!(error instanceof GitHubApiError)) return false;
    if (error.status !== 422) return false;
    return /Reference already exists/i.test(error.responseText);
  }

  private buildMissingBranchError(error: GitHubApiError): Error {
    const message = error.message || error.responseText || "Missing branch";
    const missingBranchError = new Error(message);
    missingBranchError.cause = "missing-branch";
    return missingBranchError;
  }
  private async fetchCheckRunNames(branch: string): Promise<string[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const encodedBranch = encodeURIComponent(branch);
    try {
      const payload = await this.githubApiRequest<CheckRunsResponse>(
        `/repos/${owner}/${name}/commits/${encodedBranch}/check-runs?per_page=100`
      );
      return toSortedUniqueStrings(payload?.check_runs?.map((run) => run?.name ?? "") ?? []);
    } catch (e: any) {
      if (this.isNoCommitFoundError(e)) {
        throw this.buildMissingBranchError(e);
      }
      throw e;
    }
  }

  private async fetchStatusContextNames(branch: string): Promise<string[]> {
    const { owner, name } = splitRepoFullName(this.repo);
    const encodedBranch = encodeURIComponent(branch);
    try {
      const payload = await this.githubApiRequest<CommitStatusResponse>(
        `/repos/${owner}/${name}/commits/${encodedBranch}/status?per_page=100`
      );
      return toSortedUniqueStrings(payload?.statuses?.map((status) => status?.context ?? "") ?? []);
    } catch (e: any) {
      if (this.isNoCommitFoundError(e)) {
        throw this.buildMissingBranchError(e);
      }
      throw e;
    }
  }

  private async fetchAvailableCheckContexts(branch: string): Promise<string[]> {
    const errors: string[] = [];
    let missingBranchError: Error | null = null;
    let checkRuns: string[] = [];
    let statusContexts: string[] = [];

    try {
      checkRuns = await this.fetchCheckRunNames(branch);
    } catch (e: any) {
      if (e?.cause === "missing-branch") {
        missingBranchError = e;
      } else {
        errors.push(`check-runs: ${e?.message ?? String(e)}`);
      }
    }

    try {
      statusContexts = await this.fetchStatusContextNames(branch);
    } catch (e: any) {
      if (e?.cause === "missing-branch") {
        missingBranchError = e;
      } else {
        errors.push(`status: ${e?.message ?? String(e)}`);
      }
    }

    if (missingBranchError) throw missingBranchError;

    const hasData = checkRuns.length > 0 || statusContexts.length > 0;
    const hasAuthError = errors.some((entry) => /HTTP 401|HTTP 403|Missing GH_TOKEN/i.test(entry));

    if (hasAuthError || (errors.length >= 2 && !hasData)) {
      throw new Error(`Unable to read check contexts for ${branch}: ${errors.join(" | ")}`);
    }

    if (errors.length > 0) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to fetch some check contexts for ${branch}: ${errors.join(" | ")}`
      );
    }

    return toSortedUniqueStrings([...checkRuns, ...statusContexts]);
  }

  private async fetchRepoDefaultBranch(): Promise<string | null> {
    const { owner, name } = splitRepoFullName(this.repo);
    const payload = await this.githubApiRequest<RepoDetails>(`/repos/${owner}/${name}`);
    const branch = payload?.default_branch ?? null;
    return branch ? String(branch) : null;
  }

  private async fetchGitRef(ref: string): Promise<GitRef | null> {
    const { owner, name } = splitRepoFullName(this.repo);
    return this.githubApiRequest<GitRef>(`/repos/${owner}/${name}/git/ref/${ref}`, { allowNotFound: true });
  }

  private async createGitRef(ref: string, sha: string): Promise<void> {
    const { owner, name } = splitRepoFullName(this.repo);
    await this.githubApiRequest(`/repos/${owner}/${name}/git/refs`, {
      method: "POST",
      body: { ref: `refs/${ref}`, sha },
    });
  }

  private async ensureRemoteBranchExists(branch: string): Promise<boolean> {
    const ref = `heads/${branch}`;
    const existing = await this.fetchGitRef(ref);
    if (existing?.object?.sha) return false;

    const defaultBranch = await this.fetchRepoDefaultBranch();
    if (!defaultBranch) {
      throw new Error(`Unable to resolve default branch for ${this.repo}; cannot create ${branch}.`);
    }

    const defaultRef = await this.fetchGitRef(`heads/${defaultBranch}`);
    const defaultSha = defaultRef?.object?.sha ? String(defaultRef.object.sha) : null;
    if (!defaultSha) {
      throw new Error(`Unable to resolve ${this.repo}@${defaultBranch} sha; cannot create ${branch}.`);
    }

    try {
      await this.createGitRef(ref, defaultSha);
      console.log(
        `[ralph:worker:${this.repo}] Created missing branch ${branch} from ${defaultBranch} (${defaultSha}).`
      );
      return true;
    } catch (e: any) {
      if (this.isRefAlreadyExistsError(e)) return false;
      throw e;
    }
  }

  private async fetchBranchProtection(branch: string): Promise<BranchProtection | null> {
    const { owner, name } = splitRepoFullName(this.repo);
    return this.githubApiRequest<BranchProtection>(
      `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
      { allowNotFound: true }
    );
  }

  public async __testOnlyResolveRequiredChecksForMerge(): Promise<ResolvedRequiredChecks> {
    return this.resolveRequiredChecksForMerge();
  }

  public async __testOnlyFetchAvailableCheckContexts(branch: string): Promise<string[]> {
    return this.fetchAvailableCheckContexts(branch);
  }

  private async resolveRequiredChecksForMerge(): Promise<ResolvedRequiredChecks> {
    if (this.requiredChecksForMergePromise) return this.requiredChecksForMergePromise;

    this.requiredChecksForMergePromise = (async () => {
      const override = getRepoRequiredChecksOverride(this.repo);
      if (override !== null) {
        return { checks: override, source: "config" };
      }

      const botBranch = getRepoBotBranch(this.repo);
      const protectionErrors: Array<{ branch: string; error: unknown }> = [];
      let fallbackBranch = botBranch;
      const tryFetchProtection = async (branch: string): Promise<BranchProtection | null> => {
        try {
          return await this.fetchBranchProtection(branch);
        } catch (e: any) {
          protectionErrors.push({ branch, error: e });
          return null;
        }
      };

      const botProtection = await tryFetchProtection(botBranch);
      if (botProtection) {
        return { checks: getProtectionContexts(botProtection), source: "protection", branch: botBranch };
      }

      fallbackBranch = await this.resolveFallbackBranch(botBranch);
      if (fallbackBranch !== botBranch) {
        const fallbackProtection = await tryFetchProtection(fallbackBranch);
        if (fallbackProtection) {
          return { checks: getProtectionContexts(fallbackProtection), source: "protection", branch: fallbackBranch };
        }
      }

      if (protectionErrors.length > 0) {
        for (const entry of protectionErrors) {
          const msg = (entry.error as any)?.message ?? String(entry.error);
          console.warn(`[ralph:worker:${this.repo}] Unable to read branch protection for ${entry.branch}: ${msg}`);
        }
      } else {
        const attempted = Array.from(new Set([botBranch, fallbackBranch])).join(", ");
        console.log(
          `[ralph:worker:${this.repo}] No branch protection found for ${attempted}; merge gating disabled.`
        );
      }

      return { checks: [], source: "none" };
    })();

    return this.requiredChecksForMergePromise;
  }

  private async resolveFallbackBranch(botBranch: string): Promise<string> {
    try {
      const defaultBranch = await this.fetchRepoDefaultBranch();
      if (defaultBranch && defaultBranch !== botBranch) return defaultBranch;
    } catch {
      // ignore; fallback handled below
    }

    return "main";
  }

  private async ensureBranchProtectionForBranch(branch: string, requiredChecks: string[]): Promise<void> {
    if (requiredChecks.length === 0) return;

    const botBranch = getRepoBotBranch(this.repo);
    if (branch === botBranch) {
      await this.ensureRemoteBranchExists(branch);
    }

    let availableChecks: string[] = [];
    try {
      availableChecks = await this.fetchAvailableCheckContexts(branch);
    } catch (e: any) {
      if (branch === botBranch && e?.cause === "missing-branch") {
        await this.ensureRemoteBranchExists(branch);
        availableChecks = await this.fetchAvailableCheckContexts(branch);
      } else {
        throw e;
      }
    }

    const missingChecks = requiredChecks.filter((check) => !availableChecks.includes(check));
    if (missingChecks.length > 0) {
      const guidance = formatRequiredChecksGuidance({
        repo: this.repo,
        branch,
        requiredChecks,
        missingChecks,
        availableChecks,
      });
      if (availableChecks.length === 0) {
        console.warn(
          `[ralph:worker:${this.repo}] Required checks not yet available for ${branch}. ` +
            `Proceeding without branch protection until CI runs.
${guidance}`
        );
        return;
      }

      throw new Error(
        `Required checks missing for ${this.repo}@${branch}. ` +
          `The configured required check contexts are not present.
${guidance}`
      );
    }

    const existing = await this.fetchBranchProtection(branch);
    const contexts = toSortedUniqueStrings([...getProtectionContexts(existing), ...requiredChecks]);
    const strict = existing?.required_status_checks?.strict === true;
    const reviews = existing?.required_pull_request_reviews;

    const desiredReviews = {
      dismissal_restrictions: normalizeRestrictions(reviews?.dismissal_restrictions),
      dismiss_stale_reviews: reviews?.dismiss_stale_reviews ?? false,
      require_code_owner_reviews: reviews?.require_code_owner_reviews ?? false,
      required_approving_review_count: 0,
      require_last_push_approval: reviews?.require_last_push_approval ?? false,
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    };

    const desiredPayload = {
      required_status_checks: { strict, contexts },
      enforce_admins: true,
      required_pull_request_reviews: desiredReviews,
      restrictions: normalizeRestrictions(existing?.restrictions),
      required_linear_history: normalizeEnabledFlag(existing?.required_linear_history),
      allow_force_pushes: normalizeEnabledFlag(existing?.allow_force_pushes),
      allow_deletions: normalizeEnabledFlag(existing?.allow_deletions),
      block_creations: normalizeEnabledFlag(existing?.block_creations),
      required_conversation_resolution: normalizeEnabledFlag(existing?.required_conversation_resolution),
      required_signatures: normalizeEnabledFlag(existing?.required_signatures),
      lock_branch: normalizeEnabledFlag(existing?.lock_branch),
      allow_fork_syncing: normalizeEnabledFlag(existing?.allow_fork_syncing),
    };

    const existingContexts = getProtectionContexts(existing);
    const needsStatusUpdate = !existing || !areStringArraysEqual(existingContexts, contexts);
    const existingApprovals = reviews?.required_approving_review_count ?? null;
    const needsReviewUpdate =
      !reviews || existingApprovals !== 0 || hasBypassAllowances(reviews?.bypass_pull_request_allowances);
    const needsAdminUpdate = !normalizeEnabledFlag(existing?.enforce_admins);

    if (!existing || needsStatusUpdate || needsReviewUpdate || needsAdminUpdate) {
      const { owner, name } = splitRepoFullName(this.repo);
      await this.githubApiRequest(
        `/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`,
        { method: "PUT", body: desiredPayload }
      );
      console.log(
        `[ralph:worker:${this.repo}] Ensured branch protection for ${branch} (required checks: ${requiredChecks.join(", ")})`
      );
    }
  }

  private async ensureBranchProtectionOnce(): Promise<void> {
    if (this.ensureBranchProtectionPromise) return this.ensureBranchProtectionPromise;

    this.ensureBranchProtectionPromise = (async () => {
      const botBranch = getRepoBotBranch(this.repo);
      const requiredChecksOverride = getRepoRequiredChecksOverride(this.repo);

      if (requiredChecksOverride === null || requiredChecksOverride.length === 0) {
        return;
      }

      const fallbackBranch = await this.resolveFallbackBranch(botBranch);
      const branches = Array.from(new Set([botBranch, fallbackBranch]));

      for (const branch of branches) {
        await this.ensureBranchProtectionForBranch(branch, requiredChecksOverride);
      }
    })();

    return this.ensureBranchProtectionPromise;
  }

  public async syncBlockedStateForTasks(tasks: AgentTask[]): Promise<Set<string>> {
    const blockedPaths = new Set<string>();
    if (tasks.length === 0) return blockedPaths;

    const now = Date.now();
    const allowRefresh = now - this.lastBlockedSyncAt >= BLOCKED_SYNC_INTERVAL_MS;
    if (allowRefresh) {
      this.lastBlockedSyncAt = now;
    }

    const byIssue = new Map<string, { issue: IssueRef; tasks: AgentTask[] }>();
    for (const task of tasks) {
      const issueRef = parseIssueRef(task.issue, task.repo);
      if (!issueRef) continue;
      const key = `${issueRef.repo}#${issueRef.number}`;
      const entry = byIssue.get(key) ?? { issue: issueRef, tasks: [] };
      entry.tasks.push(task);
      byIssue.set(key, entry);
    }

    for (const entry of byIssue.values()) {
      const snapshot = await this.getRelationshipSnapshot(entry.issue, allowRefresh);
      if (!snapshot) continue;

      const signals = this.buildRelationshipSignals(snapshot);
      const decision = computeBlockedDecision(signals);

      if (decision.blocked && decision.confidence === "certain") {
        for (const task of entry.tasks) {
          if (task.status !== "blocked" && task._path) blockedPaths.add(task._path);
          const isBlockedForOtherReason =
            task.status === "blocked" && task["blocked-source"] && task["blocked-source"] !== "deps";
          if (isBlockedForOtherReason) continue;
          const reason = decision.reasons.join("; ") || "blocked by dependencies";
          await this.markTaskBlocked(task, "deps", { reason, details: reason });
        }

        try {
          await this.addIssueLabel(entry.issue, RALPH_LABEL_BLOCKED);
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Failed to add ${RALPH_LABEL_BLOCKED} label: ${error?.message ?? String(error)}`
          );
        }
        continue;
      }

      if (!decision.blocked && decision.confidence === "certain") {
        let shouldRemoveBlockedLabel = true;
        for (const task of entry.tasks) {
          if (task.status !== "blocked") continue;
          if (task["blocked-source"] !== "deps") {
            shouldRemoveBlockedLabel = false;
            continue;
          }
          const unblocked = await this.markTaskUnblocked(task);
          if (!unblocked) {
            shouldRemoveBlockedLabel = false;
          }
        }

        if (shouldRemoveBlockedLabel) {
          try {
            await this.removeIssueLabel(entry.issue, RALPH_LABEL_BLOCKED);
          } catch (error: any) {
            console.warn(
              `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_BLOCKED} label: ${error?.message ?? String(error)}`
            );
          }
        }
      }
    }

    return blockedPaths;
  }

  private async getRelationshipSnapshot(issue: IssueRef, allowRefresh: boolean): Promise<IssueRelationshipSnapshot | null> {
    const key = `${issue.repo}#${issue.number}`;
    const now = Date.now();
    const cached = this.relationshipCache.get(key);
    if (cached && (!allowRefresh || now - cached.ts < ISSUE_RELATIONSHIP_TTL_MS)) {
      return cached.snapshot;
    }

    const inFlight = this.relationshipInFlight.get(key);
    if (inFlight) return await inFlight;

    const promise = this.relationships
      .getSnapshot(issue)
      .then((snapshot) => {
        this.relationshipCache.set(key, { ts: Date.now(), snapshot });
        return snapshot;
      })
      .catch((error) => {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to fetch relationship snapshot for ${formatIssueRef(issue)}: ${error?.message ?? String(error)}`
        );
        return null;
      })
      .finally(() => {
        this.relationshipInFlight.delete(key);
      });

    this.relationshipInFlight.set(key, promise);
    return await promise;
  }

  private buildRelationshipSignals(snapshot: IssueRelationshipSnapshot): RelationshipSignal[] {
    const resolved = this.resolveDependencySignals(snapshot);
    if (resolved.ignoredBodyBlockers > 0) {
      this.logIgnoredBodyBlockers(snapshot.issue, resolved.ignoredBodyBlockers, resolved.ignoreReason);
    }

    if (!snapshot.coverage.githubDepsComplete && !resolved.hasBodyDepsCoverage) {
      resolved.signals.push({ source: "github", kind: "blocked_by", state: "unknown" });
    }
    if (!snapshot.coverage.githubSubIssuesComplete) {
      resolved.signals.push({ source: "github", kind: "sub_issue", state: "unknown" });
    }
    return resolved.signals;
  }

  private resolveDependencySignals(snapshot: IssueRelationshipSnapshot): {
    signals: RelationshipSignal[];
    hasBodyDepsCoverage: boolean;
    ignoredBodyBlockers: number;
    ignoreReason: "complete" | "partial";
  } {
    const signals = [...snapshot.signals];
    const githubDepsSignals = signals.filter((signal) => signal.source === "github" && signal.kind === "blocked_by");
    const bodyDepsSignals = signals.filter((signal) => signal.source === "body" && signal.kind === "blocked_by");
    const hasGithubDepsSignals = githubDepsSignals.length > 0;
    const hasGithubDepsCoverage = snapshot.coverage.githubDepsComplete;
    const shouldIgnoreBodyDeps = hasGithubDepsCoverage || (!hasGithubDepsCoverage && hasGithubDepsSignals);
    const filteredSignals = shouldIgnoreBodyDeps
      ? signals.filter((signal) => !(signal.source === "body" && signal.kind === "blocked_by"))
      : signals;
    const hasBodyDepsCoverage = snapshot.coverage.bodyDeps && !shouldIgnoreBodyDeps;
    const ignoredBodyBlockers = shouldIgnoreBodyDeps ? bodyDepsSignals.length : 0;
    const ignoreReason = hasGithubDepsCoverage ? "complete" : "partial";

    return { signals: filteredSignals, hasBodyDepsCoverage, ignoredBodyBlockers, ignoreReason };
  }

  private logIgnoredBodyBlockers(issue: IssueRef, ignoredCount: number, reason: "complete" | "partial"): void {
    const key = `${issue.repo}#${issue.number}`;
    if (!this.ignoredBodyDepsLogLimiter.shouldLog(key, IGNORED_BODY_DEPS_LOG_INTERVAL_MS)) return;
    const reasonLabel = reason === "complete" ? "complete" : "partial";
    console.log(
      `[ralph:worker:${this.repo}] Ignoring ${ignoredCount} body blocker(s) for ${formatIssueRef(issue)} due to ${reasonLabel} ` +
        `GitHub dependency coverage.`
    );
  }

  private async resolveWorktreeRef(): Promise<string> {
    const botBranch = getRepoBotBranch(this.repo);
    try {
      await $`git rev-parse --verify ${botBranch}`.cwd(this.repoPath).quiet();
      return botBranch;
    } catch {
      return "HEAD";
    }
  }

  private isManagedWorktreePath(worktreePath: string, baseDir = RALPH_WORKTREES_DIR): boolean {
    return isPathUnderDir(worktreePath, baseDir);
  }

  private isRepoWorktreePath(worktreePath: string): boolean {
    const repoSlug = this.repo.split("/")[1] ?? this.repo;
    const repoKey = safeNoteName(this.repo);
    return (
      this.isManagedWorktreePath(worktreePath, join(RALPH_WORKTREES_DIR, repoSlug)) ||
      this.isManagedWorktreePath(worktreePath, join(RALPH_WORKTREES_DIR, repoKey))
    );
  }

  private isSameRepoRootPath(worktreePath: string): boolean {
    return this.normalizeRepoRootPath(this.repoPath) === this.normalizeRepoRootPath(worktreePath);
  }

  private normalizeRepoRootPath(path: string): string {
    try {
      return realpathSync(path);
    } catch {
      return resolve(path);
    }
  }

  private isHealthyWorktreePath(worktreePath: string): boolean {
    return existsSync(worktreePath) && existsSync(join(worktreePath, ".git"));
  }

  private async safeRemoveWorktree(worktreePath: string, opts?: { allowDiskCleanup?: boolean }): Promise<void> {
    const allowDiskCleanup = opts?.allowDiskCleanup ?? false;

    try {
      await $`git worktree remove --force ${worktreePath}`.cwd(this.repoPath).quiet();
      return;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      console.warn(`[ralph:worker:${this.repo}] Failed to remove worktree ${worktreePath}: ${msg}`);
    }

    if (!allowDiskCleanup) return;

    try {
      await rm(worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  private async ensureGitWorktree(worktreePath: string): Promise<void> {
    const hasHealthyWorktree = () => this.isHealthyWorktreePath(worktreePath);

    const cleanupBrokenWorktree = async (): Promise<void> => {
      try {
        await $`git worktree remove --force ${worktreePath}`.cwd(this.repoPath).quiet();
      } catch {
        // ignore
      }

      try {
        await rm(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    };

    // If git knows about the worktree but the path is broken, clean it up.
    try {
      const list = await $`git worktree list --porcelain`.cwd(this.repoPath).quiet();
      const out = list.stdout.toString();
      if (out.includes(`worktree ${worktreePath}\n`)) {
        if (hasHealthyWorktree()) return;
        console.warn(`[ralph:worker:${this.repo}] Worktree registered but unhealthy; recreating: ${worktreePath}`);
        await cleanupBrokenWorktree();
      }
    } catch {
      // ignore and attempt create
    }

    // If the directory exists but is not a valid git worktree, remove it.
    if (existsSync(worktreePath) && !hasHealthyWorktree()) {
      console.warn(`[ralph:worker:${this.repo}] Worktree path exists but is not a worktree; recreating: ${worktreePath}`);
      await cleanupBrokenWorktree();
    }

    await mkdir(dirname(worktreePath), { recursive: true });

    const ref = await this.resolveWorktreeRef();
    const create = async () => {
      await $`git worktree add --detach ${worktreePath} ${ref}`.cwd(this.repoPath).quiet();
      if (!hasHealthyWorktree()) {
        throw new Error(`Worktree created but missing .git marker: ${worktreePath}`);
      }
    };

    try {
      await create();
    } catch (e: any) {
      // Retry once after forcing cleanup. This handles half-created directories or stale git metadata.
      await cleanupBrokenWorktree();
      await create();
    }
  }

  private async cleanupGitWorktree(worktreePath: string): Promise<void> {
    await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
  }

  private async cleanupOrphanedWorktrees(): Promise<void> {
    const entries = await this.getGitWorktrees();
    const knownWorktrees = new Set(entries.map((entry) => entry.worktreePath));

    if (entries.length > 0) {
      for (const entry of entries) {
        if (!this.isRepoWorktreePath(entry.worktreePath)) continue;
        if (this.isHealthyWorktreePath(entry.worktreePath)) continue;

        console.warn(
          `[ralph:worker:${this.repo}] Worktree registered but unhealthy; pruning: ${entry.worktreePath}`
        );
        await this.safeRemoveWorktree(entry.worktreePath, { allowDiskCleanup: false });
      }
    }

    const repoRoot = this.repoPath;
    const repoRootManaged = this.isManagedWorktreePath(repoRoot);
    if (repoRootManaged) return;

    const repoSlug = this.repo.split("/")[1] ?? this.repo;
    const repoKey = safeNoteName(this.repo);

    const repoCandidates = [join(RALPH_WORKTREES_DIR, repoSlug), join(RALPH_WORKTREES_DIR, repoKey)];

    for (const repoDir of repoCandidates) {
      if (!existsSync(repoDir)) continue;

      let issueDirs: { name: string; isDirectory(): boolean }[] = [];
      try {
        issueDirs = await readdir(repoDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const issueEntry of issueDirs) {
        if (!issueEntry.isDirectory()) continue;
        const issueDir = join(repoDir, issueEntry.name);

        let taskDirs: { name: string; isDirectory(): boolean }[] = [];
        try {
          taskDirs = await readdir(issueDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const taskEntry of taskDirs) {
          if (!taskEntry.isDirectory()) continue;
          const worktreeDir = join(issueDir, taskEntry.name);
          if (knownWorktrees.has(worktreeDir)) continue;
          if (!existsSync(worktreeDir)) continue;
          if (!this.isRepoWorktreePath(worktreeDir)) continue;
          if (this.isManagedWorktreePath(repoRoot, worktreeDir)) continue;
          if (this.isSameRepoRootPath(worktreeDir)) continue;

          console.warn(`[ralph:worker:${this.repo}] Stale worktree directory; pruning: ${worktreeDir}`);
          await this.safeRemoveWorktree(worktreeDir, { allowDiskCleanup: true });
        }
      }
    }
  }

  private async resolveTaskRepoPath(
    task: AgentTask,
    issueNumber: string,
    mode: "start" | "resume",
    repoSlot?: number | null
  ): Promise<{ kind: "ok"; repoPath: string; worktreePath?: string } | { kind: "reset"; reason: string }> {
    const recorded = task["worktree-path"]?.trim();
    if (recorded) {
      if (this.isSameRepoRootPath(recorded)) {
        throw new Error(`Recorded worktree-path matches repo root; refusing to run in main checkout: ${recorded}`);
      }
      if (!this.isRepoWorktreePath(recorded)) {
        throw new Error(`Recorded worktree-path is outside managed worktrees dir: ${recorded}`);
      }
      if (this.isHealthyWorktreePath(recorded)) {
        return { kind: "ok", repoPath: recorded, worktreePath: recorded };
      }
      const reason = !existsSync(recorded)
        ? `Recorded worktree-path does not exist: ${recorded}`
        : `Recorded worktree-path is not a valid git worktree: ${recorded}`;

      if (mode === "resume") {
        console.warn(`[ralph:worker:${this.repo}] ${reason} (resetting task for retry)`);
        const updated = await this.queue.updateTaskStatus(task, "queued", {
          "session-id": "",
          "worktree-path": "",
          "worker-id": "",
          "repo-slot": "",
          "daemon-id": "",
          "heartbeat-at": "",
          "watchdog-retries": "",
        });
        if (!updated) {
          throw new Error(`Failed to reset task after stale worktree-path: ${recorded}`);
        }
        await this.safeRemoveWorktree(recorded, { allowDiskCleanup: true });
        return { kind: "reset", reason: `${reason} (task reset to queued)` };
      }

      console.warn(`[ralph:worker:${this.repo}] ${reason} (recreating worktree)`);
      await this.safeRemoveWorktree(recorded, { allowDiskCleanup: true });
    }

    if (mode === "resume") {
      throw new Error("Missing worktree-path for in-progress task; refusing to resume in main checkout");
    }

    const resolvedSlot = typeof repoSlot === "number" && Number.isFinite(repoSlot) ? repoSlot : 0;
    const taskKey = safeNoteName(task._path || task._name || task.name);
    const repoKey = safeNoteName(this.repo);
    const worktreePath = join(RALPH_WORKTREES_DIR, repoKey, `slot-${resolvedSlot}`, issueNumber, taskKey);

    await this.ensureGitWorktree(worktreePath);
    await this.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worktree-path": worktreePath,
    });

    return { kind: "ok", repoPath: worktreePath, worktreePath };
  }

  /**
   * Fetch metadata for a GitHub issue.
   */
  private async getIssueMetadata(issue: string): Promise<IssueMetadata> {
    // issue format: "owner/repo#123"
    const match = issue.match(/^([^#]+)#(\d+)$/);
    if (!match) return { labels: [], title: "" };

    const [, repo, number] = match;
    try {
      const result = await ghRead(repo)`gh issue view ${number} --repo ${repo} --json state,stateReason,closedAt,url,labels,title`.quiet();
      const data = JSON.parse(result.stdout.toString());
      const metadata: IssueMetadata = {
        labels: data.labels?.map((l: any) => l.name) ?? [],
        title: data.title ?? "",
        state: typeof data.state === "string" ? data.state : undefined,
        stateReason: typeof data.stateReason === "string" ? data.stateReason : undefined,
        closedAt: typeof data.closedAt === "string" ? data.closedAt : undefined,
        url: typeof data.url === "string" ? data.url : undefined,
      };

      recordIssueSnapshot({
        repo,
        issue,
        title: metadata.title,
        state: metadata.state,
        url: metadata.url,
      });

      return metadata;
    } catch {
      return { labels: [], title: "" };
    }
  }

  private buildPrCreationNudge(botBranch: string, issueNumber: string, issueRef: string): string {
    const fixes = issueNumber ? `Fixes #${issueNumber}` : `Fixes ${issueRef}`;

    return [
      `No PR URL found. Create a PR targeting '${botBranch}' and paste the PR URL.`,
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git status",
      "git push -u origin HEAD",
      `gh pr create --base ${botBranch} --fill --body \"${fixes}\"`,
      "```",
      "",
      "If a PR already exists:",
      "```bash",
      "gh pr list --head $(git branch --show-current) --json url --limit 1",
      "```",
    ].join("\n");
  }

  private async getGitWorktrees(): Promise<GitWorktreeEntry[]> {
    try {
      const result = await $`git worktree list --porcelain`.cwd(this.repoPath).quiet();
      return parseGitWorktreeListPorcelain(result.stdout.toString());
    } catch {
      return [];
    }
  }

  private async cleanupWorktreesOnStartup(): Promise<void> {
    try {
      await $`git worktree prune`.cwd(this.repoPath).quiet();
    } catch (e: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to prune git worktrees on startup: ${e?.message ?? String(e)}`
      );
    }

    try {
      await this.cleanupOrphanedWorktrees();
    } catch (e: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to cleanup orphaned worktrees on startup: ${e?.message ?? String(e)}`
      );
    }
  }

  private async cleanupWorktreesForTasks(tasks: AgentTask[]): Promise<void> {
    const managedPaths = new Set<string>();
    for (const task of tasks) {
      const recorded = task["worktree-path"]?.trim();
      if (recorded) managedPaths.add(recorded);
    }

    for (const worktreePath of managedPaths) {
      if (!this.isRepoWorktreePath(worktreePath)) continue;
      if (this.isHealthyWorktreePath(worktreePath)) continue;

      console.warn(
        `[ralph:worker:${this.repo}] Recorded worktree-path unhealthy; pruning: ${worktreePath}`
      );
      await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: false });
    }
  }

  async runStartupCleanup(): Promise<void> {
    await this.cleanupWorktreesOnStartup();
  }

  async runTaskCleanup(tasks: AgentTask[]): Promise<void> {
    await this.cleanupWorktreesForTasks(tasks);
  }

  private buildWorkerId(task: AgentTask, taskId?: string | null): string | undefined {
    const rawTaskId = taskId ?? task._path ?? task._name ?? task.name;
    const normalizedTaskId = rawTaskId?.trim();
    if (!normalizedTaskId) return undefined;
    return `${this.repo}#${normalizedTaskId}`;
  }

  private async ensureWorkerId(task: AgentTask, taskId?: string | null): Promise<string> {
    const existing = task["worker-id"]?.trim();
    if (existing) return existing;
    const derived = this.buildWorkerId(task, taskId);
    if (derived) return derived;
    const fallback = `w_${randomUUID()}`;
    await this.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worker-id": fallback,
    });
    return fallback;
  }

  private async formatWorkerId(task: AgentTask, taskId?: string | null): Promise<string> {
    const workerId = await this.ensureWorkerId(task, taskId);
    const trimmed = workerId.trim();
    if (trimmed && trimmed.length <= 256) return trimmed;
    const fallback = `w_${randomUUID()}`;
    console.warn(
      `[dashboard] invalid workerId; falling back (repo=${this.repo}, task=${taskId ?? task._path ?? task._name ?? task.name})`
    );
    await this.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worker-id": fallback,
    });
    return fallback;
  }

  private sanitizeRepoSlot(value: number): number {
    return this.normalizeRepoSlot(value, this.getRepoSlotLimit());
  }

  private normalizeRepoSlot(value: number, limit: number): number {
    if (Number.isInteger(value) && value >= 0 && value < limit) return value;
    console.warn(`[scheduler] repoSlot allocation failed; using slot 0 (repo=${this.repo})`);
    return 0;
  }

  private getRepoSlotLimit(): number {
    const limit = getRepoMaxWorkers(this.repo);
    return Number.isFinite(limit) && limit > 0 ? limit : 1;
  }

  private allocateRepoSlot(): number {
    const limit = this.getRepoSlotLimit();

    if (!this.repoSlotsInUse) {
      this.repoSlotsInUse = new Set<number>();
    }

    for (let slot = 0; slot < limit; slot++) {
      if (!this.repoSlotsInUse.has(slot)) {
        this.repoSlotsInUse.add(slot);
        return slot;
      }
    }

    console.warn(`[scheduler] repoSlot allocation failed; using slot 0 (repo=${this.repo})`);
    this.repoSlotsInUse.add(0);
    return 0;
  }

  private releaseRepoSlot(slot: number | null): void {
    if (slot === null) return;
    if (!this.repoSlotsInUse) return;
    this.repoSlotsInUse.delete(slot);
  }

  private async tryEnsurePrFromWorktree(params: {
    task: AgentTask;
    issueNumber: string;
    issueTitle: string;
    botBranch: string;
  }): Promise<{ prUrl: string | null; diagnostics: string }> {
    const { task, issueNumber, issueTitle, botBranch } = params;

    const diagnostics: string[] = [

      "Ralph PR recovery:",
      `- Repo: ${this.repo}`,
      `- Issue: ${task.issue}`,
      `- Base: ${botBranch}`,
    ];

    if (!issueNumber) {
      diagnostics.push("- No issue number detected; skipping auto PR recovery");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const existingPr = await this.getIssuePrResolution(issueNumber);
    if (existingPr.diagnostics.length > 0) {
      diagnostics.push(...existingPr.diagnostics);
    }
    if (existingPr.selectedUrl) {
      return { prUrl: existingPr.selectedUrl, diagnostics: diagnostics.join("\n") };
    }

    const entries = await this.getGitWorktrees();
    const candidate = pickWorktreeForIssue(entries, issueNumber, {
      deprioritizeBranches: ["main", botBranch],
    });

    if (!candidate) {
      diagnostics.push(`- No worktree matched issue ${issueNumber}`);
      diagnostics.push("- Manual: run `git worktree list` in the repo root to locate the task worktree");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const branch = stripHeadsRef(candidate.branch);
    diagnostics.push(`- Worktree: ${candidate.worktreePath}`);
    diagnostics.push(`- Branch: ${branch ?? "(unknown)"}`);

    if (!branch || candidate.detached) {
      diagnostics.push("- Cannot auto-create PR: detached HEAD or unknown branch");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    try {
      const list = await ghRead(this.repo)`gh pr list --repo ${this.repo} --head ${branch} --json url --limit 1`.quiet();
      const data = JSON.parse(list.stdout.toString());
      const existingUrl = data?.[0]?.url as string | undefined;
      if (existingUrl) {
        diagnostics.push(`- Found existing PR: ${existingUrl}`);
        return { prUrl: existingUrl, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- gh pr list failed: ${e?.message ?? String(e)}`);
    }

    try {
      const status = await $`git status --porcelain`.cwd(candidate.worktreePath).quiet();
      if (status.stdout.toString().trim()) {
        diagnostics.push("- Worktree has uncommitted changes; skipping auto push/PR create");
        diagnostics.push(`- Manual: cd ${candidate.worktreePath} && git status`);
        return { prUrl: null, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- git status failed: ${e?.message ?? String(e)}`);
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    try {
      await $`git push -u origin HEAD`.cwd(candidate.worktreePath).quiet();
      diagnostics.push("- Pushed branch to origin");
    } catch (e: any) {
      diagnostics.push(`- git push failed: ${e?.message ?? String(e)}`);
      diagnostics.push(`- Manual: cd ${candidate.worktreePath} && git push -u origin ${branch}`);
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const title = issueTitle?.trim() ? issueTitle.trim() : `Fixes #${issueNumber}`;
    const body = [
      `Fixes #${issueNumber}`,
      "",
      "## Summary",
      "- (Auto-created by Ralph: agent completed without a PR URL)",
      "",
      "## Testing",
      "- (Please fill in)",
      "",
    ].join("\n");

    try {
      const created = await ghWrite(this.repo)`gh pr create --repo ${this.repo} --base ${botBranch} --head ${branch} --title ${title} --body ${body}`
        .cwd(candidate.worktreePath)
        .quiet();

      const prUrl = selectPrUrl({ output: created.stdout.toString(), repo: this.repo }) ?? null;
      diagnostics.push(prUrl ? `- Created PR: ${prUrl}` : "- gh pr create succeeded but no URL detected");

      if (prUrl) return { prUrl, diagnostics: diagnostics.join("\n") };
    } catch (e: any) {
      diagnostics.push(`- gh pr create failed: ${e?.message ?? String(e)}`);
    }

    try {
      const list = await ghRead(this.repo)`gh pr list --repo ${this.repo} --head ${branch} --json url --limit 1`.quiet();
      const data = JSON.parse(list.stdout.toString());
      const url = data?.[0]?.url as string | undefined;
      if (url) {
        diagnostics.push(`- Found PR after create attempt: ${url}`);
        return { prUrl: url, diagnostics: diagnostics.join("\n") };
      }
    } catch (e: any) {
      diagnostics.push(`- Final gh pr list failed: ${e?.message ?? String(e)}`);
    }

    diagnostics.push("- No PR URL recovered");
    return { prUrl: null, diagnostics: diagnostics.join("\n") };
  }

  private async getPullRequestChecks(
    prUrl: string
  ): Promise<{
    headSha: string;
    mergeStateStatus: PullRequestMergeStateStatus | null;
    baseRefName: string;
    checks: PrCheck[];
  }> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);

    const query = [
      "query($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "pullRequest(number:$number){",
      "headRefOid",
      "mergeStateStatus",
      "baseRefName",
      "statusCheckRollup{",
      "contexts(first:100){nodes{__typename ... on CheckRun{name status conclusion detailsUrl} ... on StatusContext{context state targetUrl}}}",
      "}",
      "}",
      "}",
      "}",
    ].join(" ");

    const result = await ghRead(this.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
    const parsed = JSON.parse(result.stdout.toString());

    const pr = parsed?.data?.repository?.pullRequest;
    const headSha = pr?.headRefOid as string | undefined;
    if (!headSha) {
      throw new Error(`Failed to read pull request head SHA for ${prUrl}`);
    }

    const mergeStateStatus = normalizeMergeStateStatus(pr?.mergeStateStatus);
    const baseRefName = String(pr?.baseRefName ?? "").trim();
    if (!baseRefName) {
      throw new Error(`Failed to read pull request base branch for ${prUrl}`);
    }

    const nodes = pr?.statusCheckRollup?.contexts?.nodes;
    const checksRaw = Array.isArray(nodes) ? nodes : [];

    const checks: PrCheck[] = [];

    for (const node of checksRaw) {
      const type = String(node?.__typename ?? "");

      if (type === "CheckRun") {
        const name = String(node?.name ?? "").trim();
        if (!name) continue;

        const status = String(node?.status ?? "");
        const conclusion = String(node?.conclusion ?? "");
        const detailsUrl = node?.detailsUrl ? String(node.detailsUrl).trim() : null;

        // If it's not completed yet, treat status as the state.
        const rawState = status && status !== "COMPLETED" ? status : conclusion || status || "UNKNOWN";
        checks.push({ name, rawState, state: normalizeRequiredCheckState(rawState), detailsUrl });
        continue;
      }

      if (type === "StatusContext") {
        const name = String(node?.context ?? "").trim();
        if (!name) continue;

        const rawState = String(node?.state ?? "UNKNOWN");
        const detailsUrl = node?.targetUrl ? String(node.targetUrl).trim() : null;
        checks.push({ name, rawState, state: normalizeRequiredCheckState(rawState), detailsUrl });
        continue;
      }
    }

    return { headSha, mergeStateStatus, baseRefName, checks };
  }

  private async getPullRequestBaseBranch(prUrl: string): Promise<string | null> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) return null;

    const { owner, name } = splitRepoFullName(this.repo);
    const query = [
      "query($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "pullRequest(number:$number){",
      "baseRefName",
      "}",
      "}",
      "}",
    ].join(" ");

    const result = await ghRead(this.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
    const parsed = JSON.parse(result.stdout.toString());
    const base = parsed?.data?.repository?.pullRequest?.baseRefName;
    return typeof base === "string" && base.trim() ? base.trim() : null;
  }

  private isMainMergeAllowed(baseBranch: string | null, botBranch: string, labels: string[]): boolean {
    return isMainMergeAllowed(baseBranch, botBranch, labels);
  }

  private async getPullRequestFiles(prUrl: string): Promise<string[]> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);
    const files: string[] = [];
    let page = 1;

    while (true) {
      const payload = await this.githubApiRequest<Array<{ filename?: string | null }>>(
        `/repos/${owner}/${name}/pulls/${prNumber}/files?per_page=100&page=${page}`
      );

      if (!payload || payload.length === 0) break;

      for (const entry of payload) {
        const filename = String(entry?.filename ?? "").trim();
        if (filename) files.push(filename);
      }

      if (payload.length < 100) break;
      page += 1;
    }

    return files;
  }

  private async waitForRequiredChecks(
    prUrl: string,
    requiredChecks: string[],
    opts: { timeoutMs: number; pollIntervalMs: number }
  ): Promise<{
    headSha: string;
    mergeStateStatus: PullRequestMergeStateStatus | null;
    baseRefName: string;
    summary: RequiredChecksSummary;
    checks: PrCheck[];
    timedOut: boolean;
    stopReason?: "merge-conflict";
  }> {
    const startedAt = Date.now();
    let pollDelayMs = opts.pollIntervalMs;
    let lastSignature: string | null = null;
    let attempt = 0;
    const prNumber = extractPullRequestNumber(prUrl);
    const logKey = `ralph:checks:${this.repo}:${prNumber ?? prUrl}`;
    let last: {
      headSha: string;
      mergeStateStatus: PullRequestMergeStateStatus | null;
      baseRefName: string;
      summary: RequiredChecksSummary;
      checks: PrCheck[];
    } | null = null;

    while (Date.now() - startedAt < opts.timeoutMs) {
      const { headSha, mergeStateStatus, baseRefName, checks } = await this.getPullRequestChecks(prUrl);
      const summary = summarizeRequiredChecks(checks, requiredChecks);
      last = { headSha, mergeStateStatus, baseRefName, summary, checks };

      if (mergeStateStatus === "DIRTY") {
        return { headSha, mergeStateStatus, baseRefName, summary, checks, timedOut: false, stopReason: "merge-conflict" };
      }

      if (summary.status === "success" || summary.status === "failure") {
        return { headSha, mergeStateStatus, baseRefName, summary, checks, timedOut: false };
      }

      const signature = buildRequiredChecksSignature(summary);
      const decision = computeRequiredChecksDelay({
        baseIntervalMs: opts.pollIntervalMs,
        maxIntervalMs: REQUIRED_CHECKS_MAX_POLL_MS,
        attempt,
        lastSignature,
        nextSignature: signature,
        pending: summary.status === "pending",
      });
      attempt = decision.nextAttempt;
      pollDelayMs = decision.delayMs;
      lastSignature = signature;

      if (decision.reason === "backoff" && pollDelayMs > opts.pollIntervalMs) {
        if (this.requiredChecksLogLimiter.shouldLog(logKey, REQUIRED_CHECKS_LOG_INTERVAL_MS)) {
          console.log(
            `[ralph:worker:${this.repo}] Required checks pending; backing off polling to ${Math.round(pollDelayMs / 1000)}s`
          );
        }
      }

      await new Promise((r) => setTimeout(r, applyRequiredChecksJitter(pollDelayMs)));
    }

    if (last) {
      return { ...last, timedOut: true };
    }

    // Should be unreachable, but keep types happy.
    const fallback = await this.getPullRequestChecks(prUrl);
    return {
      headSha: fallback.headSha,
      mergeStateStatus: fallback.mergeStateStatus,
      baseRefName: fallback.baseRefName,
      summary: summarizeRequiredChecks(fallback.checks, requiredChecks),
      checks: fallback.checks,
      timedOut: true,
    };
  }

  private async mergePullRequest(prUrl: string, headSha: string, cwd: string): Promise<void> {
    // Never pass --admin or -d (delete branch). Branch cleanup is handled separately with guardrails.
    await ghWrite(this.repo)`gh pr merge ${prUrl} --repo ${this.repo} --merge --match-head-commit ${headSha}`.cwd(cwd).quiet();
  }

  private async updatePullRequestBranch(prUrl: string, cwd: string): Promise<void> {
    try {
      await ghWrite(this.repo)`gh pr update-branch ${prUrl} --repo ${this.repo}`.cwd(cwd).quiet();
      return;
    } catch (error: any) {
      const message = this.formatGhError(error);
      if (!this.shouldFallbackToWorktreeUpdate(message)) throw error;
    }

    await this.updatePullRequestBranchViaWorktree(prUrl);
  }

  private parseCiFixAttempts(raw: string | undefined): number | null {
    const trimmed = (raw ?? "").trim();
    if (!trimmed) return null;
    const parsed = Number.parseInt(trimmed, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  private resolveCiFixAttempts(): number {
    return this.parseCiFixAttempts(process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS) ?? 2;
  }

  private isActionableCheckFailure(rawState: string): boolean {
    const normalized = rawState.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.includes("action_required")) return false;
    if (normalized.includes("stale")) return false;
    if (normalized.includes("cancel")) return false;
    return true;
  }

  private parseGhRunId(detailsUrl: string | null | undefined): string | null {
    if (!detailsUrl) return null;
    const match = detailsUrl.match(/\/actions\/runs\/(\d+)/);
    if (!match) return null;
    return match[1] ?? null;
  }

  private extractCommandsFromLog(log: string): string[] {
    const lines = log.split("\n");
    const commands = new Set<string>();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const bunMatch = trimmed.match(/\b(bun\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
      if (bunMatch?.[1]) {
        commands.add(bunMatch[1]);
      }
      const npmMatch = trimmed.match(/\b(npm\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
      if (npmMatch?.[1]) {
        commands.add(npmMatch[1]);
      }
      const pnpmMatch = trimmed.match(/\b(pnpm\s+(?:run\s+)?[\w:.-]+(?:\s+[^\s].*)?)$/i);
      if (pnpmMatch?.[1]) {
        commands.add(pnpmMatch[1]);
      }
    }
    return Array.from(commands).sort();
  }

  private clipLogExcerpt(log: string, maxLines = 120): string {
    const lines = log.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length <= maxLines) return lines.join("\n");
    const head = lines.slice(0, Math.floor(maxLines * 0.6));
    const tail = lines.slice(lines.length - Math.ceil(maxLines * 0.4));
    return [...head, "...", ...tail].join("\n");
  }

  private async getCheckLog(runId: string): Promise<CheckLogResult> {
    try {
      const result = await ghRead(this.repo)`gh run view ${runId} --repo ${this.repo} --log-failed`.quiet();
      const output = result.stdout.toString();
      if (!output.trim()) return { runId };
      return { runId, logExcerpt: this.clipLogExcerpt(output) };
    } catch (error: any) {
      const message = this.formatGhError(error);
      console.warn(`[ralph:worker:${this.repo}] Failed to fetch CI logs for run ${runId}: ${message}`);
      return { runId };
    }
  }

  private async buildRemediationFailureContext(
    summary: RequiredChecksSummary,
    opts: { includeLogs: boolean }
  ): Promise<RemediationFailureContext> {
    const failedChecks = summary.required.filter((check) => check.state === "FAILURE");
    const logs: FailedCheckLog[] = [];
    const logWarnings: string[] = [];
    const commands = new Set<string>();

    for (const check of failedChecks) {
      if (!opts.includeLogs) {
        logs.push({ ...check });
        continue;
      }

      const runId = this.parseGhRunId(check.detailsUrl);
      if (!runId) {
        logs.push({ ...check });
        continue;
      }

      const logResult = await this.getCheckLog(runId);
      if (logResult.logExcerpt) {
        this.extractCommandsFromLog(logResult.logExcerpt).forEach((cmd) => commands.add(cmd));
      }

      if (!logResult.logExcerpt) {
        logWarnings.push(`No failing log output captured for ${check.name} (run ${runId}).`);
      }

      if (!this.isActionableCheckFailure(check.rawState)) {
        logWarnings.push(`Check ${check.name} returned non-actionable status (${check.rawState}).`);
      }

      logs.push({ ...check, ...logResult, runUrl: check.detailsUrl ?? undefined });
    }

    return {
      summary,
      failedChecks,
      logs,
      logWarnings,
      commands: Array.from(commands).sort(),
    };
  }

  private formatRemediationFailureContext(context: RemediationFailureContext): string {
    const lines: string[] = [];
    lines.push(formatRequiredChecksForHumans(context.summary));

    if (context.failedChecks.length === 0) {
      lines.push("", "Failed checks: (none)");
    } else {
      lines.push("", "Failed checks:");
      for (const check of context.failedChecks) {
        const details = check.detailsUrl ? ` (${check.detailsUrl})` : "";
        lines.push(`- ${check.name}: ${check.rawState}${details}`);
      }
    }

    if (context.logs.length > 0) {
      lines.push("", "Failed log excerpts:");
      for (const entry of context.logs) {
        if (!entry.logExcerpt) continue;
        lines.push("", `### ${entry.name}`, "```", entry.logExcerpt, "```");
      }
    }

    if (context.commands.length > 0) {
      lines.push("", "Detected failing commands:", ...context.commands.map((cmd) => `- ${cmd}`));
    }

    if (context.logWarnings.length > 0) {
      lines.push("", "Log warnings:", ...context.logWarnings.map((warning) => `- ${warning}`));
    }

    return lines.join("\n");
  }

  private formatFailureSignature(summary: RequiredChecksSummary): string {
    const failed = summary.required
      .filter((check) => check.state === "FAILURE")
      .map((check) => {
        const runId = this.parseGhRunId(check.detailsUrl);
        const suffix = runId ? `:run:${runId}` : "";
        return `${check.name}:${check.rawState}${suffix}`;
      })
      .sort();
    return failed.join("|") || "none";
  }

  private async ensurePrNotBehind(prUrl: string, cwd: string): Promise<{ updated: boolean; reason?: string }> {
    try {
      const status = await this.getPullRequestChecks(prUrl);
      if (status.mergeStateStatus !== "BEHIND") return { updated: false };
      console.log(`[ralph:worker:${this.repo}] PR behind ${status.baseRefName}; updating branch ${prUrl}`);
      await this.updatePullRequestBranch(prUrl, cwd);
      return { updated: true };
    } catch (error: any) {
      const reason = `Failed to update PR branch while behind: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return { updated: false, reason };
    }
  }

  private async isPrBehind(prUrl: string): Promise<boolean> {
    const status = await this.getPullRequestChecks(prUrl);
    return status.mergeStateStatus === "BEHIND";
  }

  private isActionableFailureContext(context: RemediationFailureContext): boolean {
    if (context.failedChecks.length === 0) return false;
    if (!context.failedChecks.every((check) => this.isActionableCheckFailure(check.rawState))) return false;
    if (context.commands.length > 0) return true;

    return context.failedChecks.some((check) => {
      const name = check.name.toLowerCase();
      return name.includes("test") || name.includes("lint") || name.includes("typecheck") || name.includes("knip");
    });
  }

  private isOutOfDateMergeError(error: any): boolean {
    const message = String(error?.stderr ?? error?.message ?? "");
    if (!message) return false;
    return /not up to date with the base branch/i.test(message);
  }

  private shouldFallbackToWorktreeUpdate(message: string): boolean {
    const lowered = message.toLowerCase();
    if (!lowered) return false;
    if (lowered.includes("unknown command")) return true;
    if (lowered.includes("not a known command")) return true;
    if (lowered.includes("could not resolve to a pull request")) return true;
    if (lowered.includes("requires a GitHub Enterprise")) return true;
    if (lowered.includes("not supported")) return true;
    return false;
  }

  private formatGhError(error: any): string {
    const message = String(error?.message ?? "").trim();
    const stderr = String(error?.stderr ?? "").trim();
    return [message, stderr].filter(Boolean).join("\n");
  }

  private buildMergeConflictPrompt(prUrl: string, baseRefName: string | null, botBranch: string): string {
    const baseName = baseRefName || botBranch;
    return [
      `This issue already has an open PR with merge conflicts blocking CI: ${prUrl}.`,
      `Resolve merge conflicts by rebasing/merging '${baseName}' into the PR branch.`,
      "Do NOT create a new PR.",
      "After resolving conflicts, push updates and keep working on this PR until required checks pass.",
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git fetch origin",
      `gh pr checkout ${prUrl}`,
      "git status",
      "```",
    ].join("\n");
  }

  private buildCiFailurePrompt(prUrl: string, summary: RequiredChecksSummary): string {
    return [
      `An open PR already exists for this issue: ${prUrl}.`,
      "Do NOT create a new PR.",
      "Required checks are failing.",
      "Fix failing CI checks or re-run stalled workflows on the existing PR branch.",
      "After checks pass, continue with the existing PR only.",
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git fetch origin",
      `gh pr checkout ${prUrl}`,
      "git status",
      "```",
      "",
      formatRequiredChecksForHumans(summary),
    ].join("\n");
  }

  private formatCiDebugSignature(summary: RequiredChecksSummary, timedOut: boolean): string {
    const signature = this.formatFailureSignature(summary);
    if (signature !== "none") return signature;
    if (!timedOut) return signature;
    const required = summary.required.map((check) => check.name).sort().join("|") || "checks";
    return `timeout:${required}`;
  }

  private buildCiDebugPrompt(params: {
    prUrl: string;
    baseRefName: string | null;
    headRefName: string | null;
    summary: RequiredChecksSummary;
    timedOut: boolean;
    remediationContext: string;
  }): string {
    const base = params.baseRefName || "(unknown)";
    const head = params.headRefName || "(unknown)";
    const timedOutLine = params.timedOut ? "Timed out waiting for required checks to complete." : "";

    return [
      "CI-debug run for an existing PR with failing required checks.",
      `PR: ${params.prUrl}`,
      `Base: ${base}`,
      `Head: ${head}`,
      "",
      "Ralph is spawning a dedicated CI-debug run to make required checks green.",
      "If failures appear flaky, attempt deterministic reruns before code changes.",
      "Do NOT create a new PR.",
      "",
      timedOutLine,
      params.remediationContext,
      "",
      "Commands (run in the CI-debug worktree):",
      "```bash",
      "git fetch origin",
      `gh pr checkout ${params.prUrl}`,
      "git status",
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildCiDebugCommentLines(params: {
    prUrl: string;
    baseRefName: string | null;
    headRefName: string | null;
    summary: RequiredChecksSummary;
    timedOut: boolean;
    attemptCount: number;
    maxAttempts: number;
  }): string[] {
    const base = params.baseRefName || "(unknown)";
    const head = params.headRefName || "(unknown)";
    const lines: string[] = [];

    lines.push("CI-debug status");
    lines.push("", `PR: ${params.prUrl}`, `Base: ${base}`, `Head: ${head}`);

    const failing = params.summary.required.filter((check) => check.state === "FAILURE");
    lines.push("", "Failing required checks:");
    if (failing.length === 0) {
      lines.push("- (none listed)");
    } else {
      for (const check of failing) {
        const details = check.detailsUrl ? ` (${check.detailsUrl})` : "";
        lines.push(`- ${check.name}: ${check.rawState}${details}`);
      }
    }

    if (params.timedOut) {
      lines.push("", "Timed out waiting for required checks to complete.");
    }

    lines.push(
      "",
      "Action: Ralph is spawning a dedicated CI-debug run to make required checks green.",
      `Attempts: ${params.attemptCount}/${params.maxAttempts}`
    );

    lines.push("", formatRequiredChecksForHumans(params.summary));
    return lines;
  }

  private isCiDebugLeaseActive(lease: CiDebugCommentState["lease"], nowMs: number): boolean {
    if (!lease?.expiresAt) return false;
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > nowMs;
  }

  private buildCiDebugLease(holder: string, nowMs: number): CiDebugCommentState["lease"] {
    return { holder, expiresAt: new Date(nowMs + CI_DEBUG_LEASE_TTL_MS).toISOString() };
  }

  private async upsertCiDebugComment(params: {
    issueNumber: number;
    lines: string[];
    state: CiDebugCommentState;
  }): Promise<void> {
    const match = await findCiDebugComment({
      github: this.github,
      repo: this.repo,
      issueNumber: params.issueNumber,
      limit: CI_DEBUG_COMMENT_SCAN_LIMIT,
    });

    const body = buildCiDebugCommentBody({ marker: match.marker, state: params.state, lines: params.lines });
    const existing = match.comment?.body ?? "";
    if (existing.trim() === body.trim()) return;

    if (match.comment?.updatedAt) {
      const updatedAtMs = Date.parse(match.comment.updatedAt);
      if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < CI_DEBUG_COMMENT_MIN_EDIT_MS) {
        const existingState = parseCiDebugState(existing);
        const nextState = params.state;
        if (existingState && JSON.stringify(existingState) === JSON.stringify(nextState)) {
          return;
        }
      }
    }

    if (match.comment) {
      await updateCiDebugComment({ github: this.github, repo: this.repo, commentId: match.comment.id, body });
      return;
    }

    await createCiDebugComment({ github: this.github, repo: this.repo, issueNumber: params.issueNumber, body });
  }

  private async applyCiDebugLabels(issue: IssueRef): Promise<void> {
    try {
      await this.addIssueLabel(issue, RALPH_LABEL_STUCK);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to add ${RALPH_LABEL_STUCK} label for ${formatIssueRef(issue)}: ${
          error?.message ?? String(error)
        }`
      );
    }

    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_BLOCKED);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_BLOCKED} label for ${formatIssueRef(issue)}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private async clearCiDebugLabels(issue: IssueRef): Promise<void> {
    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_STUCK);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STUCK} label for ${formatIssueRef(issue)}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private collectFailureRunUrls(summary: RequiredChecksSummary): string[] {
    const urls = summary.required
      .filter((check) => check.state === "FAILURE" && check.detailsUrl)
      .map((check) => check.detailsUrl ?? "")
      .filter(Boolean);
    return Array.from(new Set(urls));
  }

  private buildCiDebugEscalationSummary(params: {
    prUrl: string;
    summary: RequiredChecksSummary;
    attempts: CiDebugAttempt[];
    reason: string;
  }): string {
    const lines: string[] = [];
    lines.push("CI-debug escalation summary", "", `PR: ${params.prUrl}`, "", "Reason:", params.reason, "");

    if (params.attempts.length > 0) {
      lines.push("Attempts:");
      for (const attempt of params.attempts) {
        const when = attempt.completedAt || attempt.startedAt;
        lines.push(
          `- Attempt ${attempt.attempt} (${attempt.status ?? "unknown"}, ${when}): ${attempt.signature || "(no signature)"}`
        );
        if (attempt.runUrls && attempt.runUrls.length > 0) {
          lines.push(...attempt.runUrls.map((url) => `  - ${url}`));
        }
      }
      lines.push("");
    }

    lines.push("Failing required checks:");
    const failing = params.summary.required.filter((check) => check.state === "FAILURE");
    if (failing.length === 0) {
      lines.push("- (none listed)");
    } else {
      for (const check of failing) {
        const details = check.detailsUrl ? ` (${check.detailsUrl})` : "";
        lines.push(`- ${check.name}: ${check.rawState}${details}`);
      }
    }

    lines.push(
      "",
      "Next action:",
      "- Inspect the failing check runs linked above, fix or rerun as needed, then re-add `ralph:queued` (or comment `RALPH RESOLVED:`) to resume."
    );

    return lines.join("\n");
  }

  private async writeCiDebugEscalationComment(params: {
    issueNumber: number;
    body: string;
  }): Promise<void> {
    const { owner, name } = splitRepoFullName(this.repo);
    await this.github.request(`/repos/${owner}/${name}/issues/${params.issueNumber}/comments`, {
      method: "POST",
      body: { body: params.body },
    });
  }

  private async runCiDebugRecovery(params: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    requiredChecks: string[];
    issueMeta: IssueMetadata;
    botBranch: string;
    timedOut: boolean;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }): Promise<CiDebugRecoveryOutcome> {
    const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
      repo: this.repo,
      number: Number(params.issueNumber),
    };
    const maxAttempts = this.resolveCiFixAttempts();
    const workerId = await this.formatWorkerId(params.task, params.task._path);

    let summary: RequiredChecksSummary;
    let headSha = "";
    let baseRefName: string | null = null;
    let headRefName: string | null = null;

    try {
      const prStatus = await this.getPullRequestChecks(params.prUrl);
      summary = summarizeRequiredChecks(prStatus.checks, params.requiredChecks);
      headSha = prStatus.headSha;
      baseRefName = prStatus.baseRefName;
      const prState = await this.getPullRequestMergeState(params.prUrl);
      headRefName = prState.headRefName || null;
    } catch (error: any) {
      const reason = `CI-debug preflight failed for ${params.prUrl}: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      const run: AgentRun = {
        taskName: params.task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: params.task["session-id"]?.trim(),
        escalationReason: reason,
      };
      return { status: "failed", run };
    }

    const signature = this.formatCiDebugSignature(summary, params.timedOut);
    const commentMatch = await findCiDebugComment({
      github: this.github,
      repo: this.repo,
      issueNumber: Number(params.issueNumber),
      limit: CI_DEBUG_COMMENT_SCAN_LIMIT,
    });
    const existingState = commentMatch.state ?? ({ version: 1 } satisfies CiDebugCommentState);
    const attempts = [...(existingState.attempts ?? [])];
    const lastAttempt = attempts[attempts.length - 1];
    const repeatedFailure =
      signature !== "none" && existingState.lastSignature === signature && lastAttempt?.status === "failed";

    if (repeatedFailure || attempts.length >= maxAttempts) {
      const reason = repeatedFailure
        ? `CI failed repeatedly with identical failures; stopping remediation for ${params.prUrl}`
        : `Required checks not passing after ${maxAttempts} attempt(s); refusing to merge ${params.prUrl}`;

      const finalState: CiDebugCommentState = {
        version: 1,
        attempts,
        lastSignature: signature,
      };

      const lines = this.buildCiDebugCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: params.timedOut,
        attemptCount: attempts.length,
        maxAttempts,
      });
      await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines, state: finalState });

      await this.clearCiDebugLabels(issueRef);

      const escalationBody = this.buildCiDebugEscalationSummary({
        prUrl: params.prUrl,
        summary,
        attempts,
        reason,
      });
      await this.writeCiDebugEscalationComment({ issueNumber: Number(params.issueNumber), body: escalationBody });

      const wasEscalated = params.task.status === "escalated";
      const escalated = await this.queue.updateTaskStatus(params.task, "escalated");
      if (escalated) {
        applyTaskPatch(params.task, "escalated", {});
      }
      await this.writeEscalationWriteback(params.task, { reason, escalationType: "blocked" });
      await this.notify.notifyEscalation({
        taskName: params.task.name,
        taskFileName: params.task._name,
        taskPath: params.task._path,
        issue: params.task.issue,
        repo: this.repo,
        sessionId: params.task["session-id"]?.trim() || undefined,
        reason,
        escalationType: "blocked",
        planOutput: escalationBody,
      });

      if (escalated && !wasEscalated) {
        await this.recordEscalatedRunNote(params.task, {
          reason,
          sessionId: params.task["session-id"]?.trim(),
          details: escalationBody,
        });
      }

      return {
        status: "escalated",
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: params.task["session-id"]?.trim(),
          escalationReason: reason,
        },
      };
    }

    const nowMs = Date.now();
    const lease = existingState.lease;
    if (this.isCiDebugLeaseActive(lease, nowMs) && lease?.holder !== workerId) {
      const reason = `CI-debug lease already held by ${lease?.holder ?? "unknown"}; skipping duplicate run for ${params.prUrl}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return {
        status: "failed",
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: params.task["session-id"]?.trim(),
          escalationReason: reason,
        },
      };
    }

    const attemptNumber = attempts.length + 1;
    const attempt: CiDebugAttempt = {
      attempt: attemptNumber,
      signature,
      startedAt: new Date().toISOString(),
      status: "running",
      runUrls: this.collectFailureRunUrls(summary),
    };

    const nextState: CiDebugCommentState = {
      version: 1,
      lease: this.buildCiDebugLease(workerId, nowMs),
      attempts: [...attempts, attempt],
      lastSignature: signature,
    };

    const lines = this.buildCiDebugCommentLines({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: params.timedOut,
      attemptCount: attemptNumber,
      maxAttempts,
    });
    await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines, state: nextState });
    await this.applyCiDebugLabels(issueRef);

    const remediationContext = this.formatRemediationFailureContext(
      await this.buildRemediationFailureContext(summary, { includeLogs: true })
    );
    const prompt = this.buildCiDebugPrompt({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: params.timedOut,
      remediationContext,
    });

    const runLogPath = await this.recordRunLogPath(
      params.task,
      params.issueNumber,
      `ci-debug-${attemptNumber}`,
      "in-progress"
    );

    const worktreePath = join(
      RALPH_WORKTREES_DIR,
      safeNoteName(this.repo),
      "ci-debug",
      params.issueNumber,
      safeNoteName(`attempt-${attemptNumber}`)
    );

    await this.ensureGitWorktree(worktreePath);

    let sessionResult = await this.session.runAgent(worktreePath, "general", prompt, {
      repo: this.repo,
      cacheKey: params.cacheKey,
      runLogPath,
      introspection: {
        repo: this.repo,
        issue: params.task.issue,
        taskName: params.task.name,
        step: 5,
        stepTitle: `ci-debug attempt ${attemptNumber}`,
      },
      ...this.buildWatchdogOptions(params.task, `ci-debug-${attemptNumber}`),
      ...params.opencodeSessionOptions,
    });

    const pausedAfter = await this.pauseIfHardThrottled(params.task, `ci-debug-${attemptNumber} (post)`, sessionResult.sessionId);
    if (pausedAfter) {
      await this.cleanupGitWorktree(worktreePath);
      return { status: "failed", run: pausedAfter };
    }

    if (sessionResult.watchdogTimeout) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleWatchdogTimeout(
        params.task,
        params.cacheKey,
        `ci-debug-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    const completedAt = new Date().toISOString();
    if (sessionResult.sessionId) {
      await this.queue.updateTaskStatus(params.task, "in-progress", { "session-id": sessionResult.sessionId });
    }

    try {
      const prStatus = await this.getPullRequestChecks(params.prUrl);
      summary = summarizeRequiredChecks(prStatus.checks, params.requiredChecks);
      headSha = prStatus.headSha;
    } catch (error: any) {
      const reason = `Failed to re-check CI status after CI-debug run: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      const failedState: CiDebugCommentState = {
        version: 1,
        attempts: [...attempts, attempt],
        lastSignature: signature,
      };
      await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines, state: failedState });
      await this.cleanupGitWorktree(worktreePath);
      return {
        status: "failed",
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: sessionResult.sessionId ?? params.task["session-id"]?.trim(),
          escalationReason: reason,
        },
      };
    }

    attempt.status = summary.status === "success" ? "succeeded" : "failed";
    attempt.completedAt = completedAt;

    const finalState: CiDebugCommentState = {
      version: 1,
      attempts: [...attempts, attempt],
      lastSignature: this.formatCiDebugSignature(summary, false),
    };
    const finalLines = this.buildCiDebugCommentLines({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: false,
      attemptCount: attemptNumber,
      maxAttempts,
    });
    await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines: finalLines, state: finalState });

    await this.cleanupGitWorktree(worktreePath);

    if (summary.status === "success") {
      await this.clearCiDebugLabels(issueRef);
      return {
        status: "success",
        prUrl: params.prUrl,
        sessionId: sessionResult.sessionId || params.task["session-id"]?.trim() || "",
        headSha,
        summary,
      };
    }

    return this.runCiDebugRecovery({
      ...params,
      timedOut: false,
    });
  }

  private isGitHubQueueTask(task: AgentTask): boolean {
    return Boolean(task._path?.startsWith("github:"));
  }

  private async maybeHandleQueuedMergeConflict(params: {
    task: AgentTask;
    issueNumber: string;
    taskRepoPath: string;
    cacheKey: string;
    botBranch: string;
    issueMeta: IssueMetadata;
    startTime: Date;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }): Promise<AgentRun | null> {
    const { task, issueNumber, taskRepoPath, cacheKey, botBranch, issueMeta, startTime, opencodeXdg, opencodeSessionOptions } = params;

    if (!this.isGitHubQueueTask(task)) return null;

    let existingPr: ResolvedIssuePr;
    try {
      existingPr = await this.getIssuePrResolution(issueNumber);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Merge conflict preflight failed for ${task.issue}: ${this.formatGhError(error)}`
      );
      return null;
    }
    if (!existingPr.selectedUrl) return null;

    let prState: PullRequestMergeState;
    try {
      prState = await this.getPullRequestMergeState(existingPr.selectedUrl);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Merge conflict preflight failed for ${existingPr.selectedUrl}: ${this.formatGhError(
          error
        )}`
      );
      return null;
    }
    if (prState.mergeStateStatus !== "DIRTY") return null;

    console.warn(
      `[ralph:worker:${this.repo}] Existing PR has merge conflicts; skipping planner for ${task.issue}.`
    );

    this.updateOpenPrSnapshot(task, null, existingPr.selectedUrl);

    const mergeConflictPrompt = this.buildMergeConflictPrompt(
      existingPr.selectedUrl,
      prState.baseRefName ?? null,
      botBranch
    );
    const { blockedReasonShort, notifyBody } = formatMergeConflictMessage({
      prUrl: existingPr.selectedUrl,
      baseRefName: prState.baseRefName,
    });

    return await this.runExistingPrRecovery({
      task,
      issueNumber,
      taskRepoPath,
      cacheKey,
      botBranch,
      issueMeta,
      startTime,
      opencodeXdg,
      opencodeSessionOptions,
      prUrl: existingPr.selectedUrl,
      stage: "merge-conflict",
      prompt: mergeConflictPrompt,
      blocked: {
        source: "merge-conflict",
        reason: blockedReasonShort,
        notifyBody,
      },
    });
  }

  private async maybeHandleQueuedCiFailure(params: {
    task: AgentTask;
    issueNumber: string;
    taskRepoPath: string;
    cacheKey: string;
    botBranch: string;
    issueMeta: IssueMetadata;
    startTime: Date;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }): Promise<AgentRun | null> {
    const { task, issueNumber, taskRepoPath, cacheKey, botBranch, issueMeta, startTime, opencodeXdg, opencodeSessionOptions } = params;

    if (!this.isGitHubQueueTask(task)) return null;

    let existingPr: ResolvedIssuePr;
    try {
      existingPr = await this.getIssuePrResolution(issueNumber);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] CI recovery preflight failed for ${task.issue}: ${this.formatGhError(error)}`
      );
      return null;
    }
    if (!existingPr.selectedUrl) return null;

    let requiredChecks: string[] = [];
    let prStatus: Awaited<ReturnType<RepoWorker["getPullRequestChecks"]>>;
    try {
      ({ checks: requiredChecks } = await this.resolveRequiredChecksForMerge());
      prStatus = await this.getPullRequestChecks(existingPr.selectedUrl);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] CI recovery preflight failed for ${existingPr.selectedUrl}: ${this.formatGhError(
          error
        )}`
      );
      return null;
    }
    if (prStatus.mergeStateStatus === "DIRTY") return null;

    const summary = summarizeRequiredChecks(prStatus.checks, requiredChecks);
    if (summary.status !== "failure") return null;

    console.warn(
      `[ralph:worker:${this.repo}] Existing PR has non-green checks; skipping planner for ${task.issue}.`
    );

    this.updateOpenPrSnapshot(task, null, existingPr.selectedUrl);

    const recovery = await this.runCiDebugRecovery({
      task,
      issueNumber,
      cacheKey,
      prUrl: existingPr.selectedUrl,
      requiredChecks,
      issueMeta,
      botBranch,
      timedOut: false,
      opencodeXdg,
      opencodeSessionOptions,
    });

    if (recovery.status !== "success") return recovery.run;

    const mergeGate = await this.mergePrWithRequiredChecks({
      task,
      repoPath: taskRepoPath,
      cacheKey,
      botBranch,
      prUrl: recovery.prUrl,
      sessionId: recovery.sessionId,
      issueMeta,
      watchdogStagePrefix: "ci-debug",
      notifyTitle: `Merging ${task.name}`,
      opencodeXdg,
    });

    if (!mergeGate.ok) return mergeGate.run;

    const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", mergeGate.sessionId || recovery.sessionId);
    if (pausedSurvey) return pausedSurvey;

    const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
    const surveyRunLogPath = await this.recordRunLogPath(task, issueNumber, "survey", "in-progress");

    const surveyResult = await this.session.continueCommand(surveyRepoPath, mergeGate.sessionId, "survey", [], {
      repo: this.repo,
      cacheKey,
      runLogPath: surveyRunLogPath,
      introspection: {
        repo: this.repo,
        issue: task.issue,
        taskName: task.name,
        step: 3,
        stepTitle: "survey",
      },
      ...this.buildWatchdogOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    if (!surveyResult.success && surveyResult.watchdogTimeout) {
      return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
      sessionId: mergeGate.sessionId,
      surveyResults: surveyResult.output,
    };
  }

  private async runExistingPrRecovery(params: {
    task: AgentTask;
    issueNumber: string;
    taskRepoPath: string;
    cacheKey: string;
    botBranch: string;
    issueMeta: IssueMetadata;
    startTime: Date;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
    prUrl: string;
    stage: "merge-conflict" | "ci-failure";
    prompt: string;
    blocked: { source: BlockedSource; reason: string; notifyBody: string };
  }): Promise<AgentRun | null> {
    const {
      task,
      issueNumber,
      taskRepoPath,
      cacheKey,
      botBranch,
      issueMeta,
      startTime,
      opencodeXdg,
      opencodeSessionOptions,
      prUrl,
      stage,
      prompt,
      blocked,
    } = params;

    const pausedBefore = await this.pauseIfHardThrottled(task, stage, task["session-id"]?.trim());
    if (pausedBefore) return pausedBefore;

    const runLogPath = await this.recordRunLogPath(task, issueNumber, stage, "in-progress");
    const resumeSessionId = task["session-id"]?.trim();

    const recoveryResult = resumeSessionId
      ? await this.session.continueSession(taskRepoPath, resumeSessionId, prompt, {
          repo: this.repo,
          cacheKey,
          runLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 2,
            stepTitle: stage,
          },
          ...this.buildWatchdogOptions(task, stage),
          ...opencodeSessionOptions,
        })
      : await this.session.runAgent(taskRepoPath, "general", prompt, {
          repo: this.repo,
          cacheKey,
          runLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 2,
            stepTitle: stage,
          },
          ...this.buildWatchdogOptions(task, stage),
          ...opencodeSessionOptions,
        });

    const pausedAfter = await this.pauseIfHardThrottled(task, `${stage} (post)`, recoveryResult.sessionId);
    if (pausedAfter) return pausedAfter;

    if (!recoveryResult.success) {
      if (recoveryResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, stage, recoveryResult, opencodeXdg);
      }

      const details = summarizeBlockedDetails(recoveryResult.output);
      await this.markTaskBlocked(task, blocked.source, {
        reason: blocked.reason,
        details,
        sessionId: recoveryResult.sessionId ?? task["session-id"]?.trim(),
      });
      await this.notify.notifyError(`${stage} ${task.name}`, blocked.notifyBody, task.name);

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: recoveryResult.sessionId,
        escalationReason: blocked.reason,
      };
    }

    if (recoveryResult.sessionId) {
      await this.queue.updateTaskStatus(task, "in-progress", { "session-id": recoveryResult.sessionId });
    }

    await this.drainNudges(task, taskRepoPath, recoveryResult.sessionId, cacheKey, stage, opencodeXdg);

    const recoverySessionId = recoveryResult.sessionId || resumeSessionId || "";
    const mergeGate = await this.mergePrWithRequiredChecks({
      task,
      repoPath: taskRepoPath,
      cacheKey,
      botBranch,
      prUrl,
      sessionId: recoverySessionId,
      issueMeta,
      watchdogStagePrefix: stage,
      notifyTitle: `Merging ${task.name}`,
      opencodeXdg,
    });

    if (!mergeGate.ok) return mergeGate.run;

    const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", mergeGate.sessionId || recoverySessionId);
    if (pausedSurvey) return pausedSurvey;

    const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
    const surveyRunLogPath = await this.recordRunLogPath(task, issueNumber, "survey", "in-progress");

    const surveyResult = await this.session.continueCommand(surveyRepoPath, mergeGate.sessionId, "survey", [], {
      repo: this.repo,
      cacheKey,
      runLogPath: surveyRunLogPath,
      introspection: {
        repo: this.repo,
        issue: task.issue,
        taskName: task.name,
        step: 3,
        stepTitle: "survey",
      },
      ...this.buildWatchdogOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    const pausedSurveyAfter = await this.pauseIfHardThrottled(
      task,
      "survey (post)",
      surveyResult.sessionId || mergeGate.sessionId
    );
    if (pausedSurveyAfter) return pausedSurveyAfter;

    if (!surveyResult.success && surveyResult.watchdogTimeout) {
      return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    return await this.finalizeTaskSuccess({
      task,
      prUrl: mergeGate.prUrl,
      sessionId: mergeGate.sessionId,
      startTime,
      surveyResults: surveyResult.output,
      cacheKey,
      opencodeXdg,
      notify: true,
      logMessage: `Task completed (recovery): ${task.name}`,
    });
  }

  private async finalizeTaskSuccess(params: {
    task: AgentTask;
    prUrl: string;
    sessionId: string;
    startTime: Date;
    surveyResults?: string;
    cacheKey: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    worktreePath?: string;
    workerId?: string;
    repoSlot?: string | number | null;
    devex?: EscalationContext["devex"];
    notify?: boolean;
    logMessage?: string;
  }): Promise<AgentRun> {
    const {
      task,
      prUrl,
      sessionId,
      startTime,
      surveyResults,
      cacheKey,
      opencodeXdg,
      worktreePath,
      workerId,
      repoSlot,
      devex,
      notify,
      logMessage,
    } = params;
    const resolvedWorktreePath = worktreePath ?? task["worktree-path"]?.trim();
    const resolvedWorkerId = workerId ?? task["worker-id"]?.trim();
    const resolvedRepoSlot = repoSlot ?? task["repo-slot"]?.trim();
    const shouldClearWorktree = Boolean(resolvedWorktreePath && String(resolvedWorktreePath).trim());
    const shouldClearWorkerId = Boolean(resolvedWorkerId && String(resolvedWorkerId).trim());
    const shouldClearRepoSlot = Boolean(
      resolvedRepoSlot !== undefined && resolvedRepoSlot !== null && String(resolvedRepoSlot).trim()
    );

    const endTime = new Date();
    await this.createAgentRun(task, {
      sessionId,
      pr: prUrl,
      outcome: "success",
      started: startTime,
      completed: endTime,
      surveyResults,
      devex,
    });

    await this.queue.updateTaskStatus(task, "done", {
      "completed-at": endTime.toISOString().split("T")[0],
      "session-id": "",
      "watchdog-retries": "",
      ...(shouldClearWorktree ? { "worktree-path": "" } : {}),
      ...(shouldClearWorkerId ? { "worker-id": "" } : {}),
      ...(shouldClearRepoSlot ? { "repo-slot": "" } : {}),
    });

    await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey, opencodeXdg?.cacheHome), { recursive: true, force: true });

    if (shouldClearWorktree && resolvedWorktreePath) {
      await this.cleanupGitWorktree(resolvedWorktreePath);
    }

    await this.assertRepoRootClean(task, "post-run");

    if (notify ?? true) {
      await this.notify.notifyTaskComplete(task.name, this.repo, prUrl ?? undefined);
    }
    if (logMessage) {
      console.log(`[ralph:worker:${this.repo}] ${logMessage}`);
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
      sessionId,
      pr: prUrl ?? undefined,
    };
  }

  private async updatePullRequestBranchViaWorktree(prUrl: string): Promise<void> {
    const pr = await this.getPullRequestMergeState(prUrl);
    const botBranch = this.normalizeGitRef(getRepoBotBranch(this.repo));
    const headRef = this.normalizeGitRef(pr.headRefName);
    const baseRef = this.normalizeGitRef(pr.baseRefName || botBranch);
    if (pr.isCrossRepository || pr.headRepoFullName !== this.repo) {
      throw new Error(`Cannot update cross-repo PR ${prUrl}; requires same-repo branch access`);
    }

    if (pr.mergeStateStatus === "DIRTY") {
      throw new Error(`Refusing to update PR with merge conflicts: ${prUrl}`);
    }

    if (pr.mergeStateStatus === "DRAFT") {
      throw new Error(`Refusing to update draft PR: ${prUrl}`);
    }

    if (!headRef) {
      throw new Error(`PR missing head ref for update: ${prUrl}`);
    }

    const worktreePath = await this.createAutoUpdateWorktree(prUrl);

    try {
      await $`git fetch origin`.cwd(worktreePath).quiet();
      await $`git checkout ${headRef}`.cwd(worktreePath).quiet();
      await $`git merge --no-edit origin/${baseRef}`.cwd(worktreePath).quiet();
      await $`git push origin ${headRef}`.cwd(worktreePath).quiet();
    } catch (error: any) {
      const message = error?.message ?? String(error);
      throw new Error(`Worktree update failed for ${prUrl}: ${message}`);
    } finally {
      await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
    }
  }

  private async createAutoUpdateWorktree(prUrl: string): Promise<string> {
    const slug = safeNoteName(this.repo);
    const prNumber = extractPullRequestNumber(prUrl) ?? "unknown";
    const worktreePath = join(RALPH_WORKTREES_DIR, slug, `pr-${prNumber}-auto-update`);

    if (existsSync(worktreePath)) {
      try {
        const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
        if (status.stdout.toString().trim()) {
          await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
        }
      } catch {
        await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
      }
    }

    await this.ensureGitWorktree(worktreePath);
    return worktreePath;
  }

  private async getPullRequestMergeState(prUrl: string): Promise<PullRequestMergeState> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);
    const query = [
      "query($owner:String!,$name:String!,$number:Int!){",
      "repository(owner:$owner,name:$name){",
      "pullRequest(number:$number){",
      "number",
      "url",
      "mergeStateStatus",
      "isCrossRepository",
      "headRefName",
      "baseRefName",
      "headRepository{ nameWithOwner }",
      "labels(first:100){nodes{name}}",
      "}",
      "}",
      "}",
    ].join(" ");

    const result = await ghRead(this.repo)`gh api graphql -f query=${query} -f owner=${owner} -f name=${name} -F number=${prNumber}`.quiet();
    const parsed = JSON.parse(result.stdout.toString());
    const pr = parsed?.data?.repository?.pullRequest;

    if (!pr?.url) {
      throw new Error(`Failed to read pull request metadata for ${prUrl}`);
    }

    const labels = Array.isArray(pr?.labels?.nodes)
      ? pr.labels.nodes.map((node: any) => String(node?.name ?? "").trim()).filter(Boolean)
      : [];

    return {
      number: Number(pr?.number ?? prNumber),
      url: String(pr?.url ?? prUrl),
      mergeStateStatus: normalizeMergeStateStatus(pr?.mergeStateStatus),
      isCrossRepository: Boolean(pr?.isCrossRepository),
      headRefName: String(pr?.headRefName ?? ""),
      headRepoFullName: String(pr?.headRepository?.nameWithOwner ?? ""),
      baseRefName: String(pr?.baseRefName ?? ""),
      labels,
    };
  }

  private async fetchPullRequestDetails(prUrl: string): Promise<PullRequestDetailsNormalized> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);
    const payload = await this.githubApiRequest<PullRequestDetails>(`/repos/${owner}/${name}/pulls/${prNumber}`);

    const mergedFlag = payload?.merged ?? null;
    const mergedAt = payload?.merged_at ?? null;
    const merged = mergedFlag === true || Boolean(mergedAt);

    return {
      number: Number(payload?.number ?? prNumber),
      url: String(payload?.url ?? prUrl),
      merged,
      baseRefName: String(payload?.base?.ref ?? ""),
      headRefName: String(payload?.head?.ref ?? ""),
      headRepoFullName: String(payload?.head?.repo?.full_name ?? ""),
      headSha: String(payload?.head?.sha ?? ""),
    };
  }

  private async fetchMergedPullRequestDetails(
    prUrl: string,
    attempts: number,
    delayMs: number
  ): Promise<PullRequestDetailsNormalized> {
    let last = await this.fetchPullRequestDetails(prUrl);
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      if (last.merged) return last;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      last = await this.fetchPullRequestDetails(prUrl);
    }
    return last;
  }

  private async deleteMergedPrHeadBranchBestEffort(params: {
    prUrl: string;
    botBranch: string;
    mergedHeadSha: string;
  }): Promise<void> {
    const { prUrl } = params;
    let details: PullRequestDetailsNormalized;
    try {
      details = await this.fetchMergedPullRequestDetails(prUrl, 3, 1000);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to read PR details for head branch cleanup: ${this.formatGhError(error)}`
      );
      return;
    }

    if (!details.merged) {
      console.log(`[ralph:worker:${this.repo}] Skipped PR head branch deletion (not merged): ${prUrl}`);
      return;
    }

    let defaultBranch: string | null = null;
    try {
      defaultBranch = await this.fetchRepoDefaultBranch();
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to fetch default branch for cleanup: ${this.formatGhError(error)}`
      );
    }

    let currentHeadSha: string | null = null;
    if (details.headRefName) {
      const headRef = await this.fetchGitRef(`heads/${details.headRefName}`);
      currentHeadSha = headRef?.object?.sha ? String(headRef.object.sha) : null;
    }

    const sameRepo = details.headRepoFullName.trim().toLowerCase() === this.repo.toLowerCase();
    const decision = computeHeadBranchDeletionDecision({
      merged: details.merged,
      isCrossRepository: !sameRepo,
      headRepoFullName: details.headRepoFullName,
      headRefName: details.headRefName,
      baseRefName: details.baseRefName,
      botBranch: params.botBranch,
      defaultBranch,
      mergedHeadSha: params.mergedHeadSha,
      currentHeadSha,
    });

    if (decision.action === "skip") {
      console.log(
        `[ralph:worker:${this.repo}] Skipped PR head branch deletion (${decision.reason}): ${prUrl}`
      );
      return;
    }

    try {
      const result = await this.deletePrHeadBranch(decision.branch);
      if (result === "missing") {
        console.log(
          `[ralph:worker:${this.repo}] PR head branch already missing (${decision.branch}): ${prUrl}`
        );
        return;
      }
      console.log(`[ralph:worker:${this.repo}] Deleted PR head branch ${decision.branch}: ${prUrl}`);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to delete PR head branch ${decision.branch}: ${this.formatGhError(error)}`
      );
    }
  }

  private async deletePrHeadBranch(branch: string): Promise<"deleted" | "missing"> {
    const { owner, name } = splitRepoFullName(this.repo);
    const encoded = branch
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const response = await this.github.request(`/repos/${owner}/${name}/git/refs/heads/${encoded}`, {
      method: "DELETE",
      allowNotFound: true,
    });
    if (response.status === 404) return "missing";
    return "deleted";
  }

  private shouldAttemptProactiveUpdate(pr: PullRequestMergeState): { ok: boolean; reason?: string } {
    if (pr.mergeStateStatus !== "BEHIND") {
      return { ok: false, reason: `Merge state is ${pr.mergeStateStatus ?? "unknown"}` };
    }

    const baseRef = this.normalizeGitRef(pr.baseRefName);
    const botBranch = this.normalizeGitRef(getRepoBotBranch(this.repo));
    if (baseRef && baseRef !== botBranch) {
      return { ok: false, reason: `PR base branch is ${pr.baseRefName}` };
    }

    if (pr.isCrossRepository || pr.headRepoFullName !== this.repo) {
      return { ok: false, reason: "PR head repo is not the same as base repo" };
    }

    if (!pr.headRefName) {
      return { ok: false, reason: "PR missing head ref" };
    }

    return { ok: true };
  }

  private shouldRateLimitAutoUpdate(pr: PullRequestMergeState, minMinutes: number): boolean {
    const key = `autoUpdateBehind:${this.repo}:${pr.number}`;
    let payload: string | null = null;

    try {
      payload = getIdempotencyPayload(key);
    } catch {
      return false;
    }

    if (!payload) return false;

    try {
      const parsed = JSON.parse(payload) as { lastAttemptAt?: number };
      const lastAttemptAt = typeof parsed?.lastAttemptAt === "number" ? parsed.lastAttemptAt : 0;
      if (!lastAttemptAt) return false;
      const expiresMs = minMinutes * 60_000;
      return Date.now() - lastAttemptAt < expiresMs;
    } catch {
      return false;
    }
  }

  private recordAutoUpdateAttempt(pr: PullRequestMergeState, minMinutes: number): void {
    const key = `autoUpdateBehind:${this.repo}:${pr.number}`;
    const payload = JSON.stringify({ lastAttemptAt: Date.now(), minMinutes });
    try {
      upsertIdempotencyKey({ key, scope: "auto-update-behind", payloadJson: payload });
    } catch {
      // best-effort
    }
  }

  private recordAutoUpdateFailure(pr: PullRequestMergeState, minMinutes: number): void {
    const key = `autoUpdateBehind:${this.repo}:${pr.number}`;
    const payload = JSON.stringify({ lastAttemptAt: Date.now(), minMinutes, status: "failed" });
    try {
      upsertIdempotencyKey({ key, scope: "auto-update-behind", payloadJson: payload });
    } catch {
      // best-effort
    }
  }

  private normalizeGitRef(ref: string): string {
    return normalizeGitRef(ref);
  }

  private async mergePrWithRequiredChecks(params: {
    task: AgentTask;
    repoPath: string;
    cacheKey: string;
    botBranch: string;
    prUrl: string;
    sessionId: string;
    issueMeta: IssueMetadata;
    watchdogStagePrefix: string;
    notifyTitle: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
  }): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> {
    const { checks: REQUIRED_CHECKS } = await this.resolveRequiredChecksForMerge();

    let prUrl = params.prUrl;
    let sessionId = params.sessionId;
    let didUpdateBranch = false;

    const prFiles = await this.getPullRequestFiles(prUrl);
    const ciOnly = isCiOnlyChangeSet(prFiles);
    const isCiIssue = isCiRelatedIssue(params.issueMeta.labels ?? []);

    const baseBranch = await this.getPullRequestBaseBranch(prUrl);
    if (!this.isMainMergeAllowed(baseBranch, params.botBranch, params.issueMeta.labels ?? [])) {
      const completed = new Date();
      const completedAt = completed.toISOString().split("T")[0];
      const reason = `Blocked: Ralph refuses to auto-merge PRs targeting '${baseBranch}'. Use ${params.botBranch} or an explicit override.`;

      await this.createAgentRun(params.task, {
        outcome: "failed",
        started: completed,
        completed,
        sessionId,
        bodyPrefix: [
          reason,
          "",
          `Issue: ${params.task.issue}`,
          `PR: ${prUrl}`,
          baseBranch ? `Base: ${baseBranch}` : "Base: unknown",
        ].join("\n"),
      });

      await this.markTaskBlocked(params.task, "merge-target", {
        reason,
        skipRunNote: true,
        extraFields: {
          "completed-at": completedAt,
          "session-id": "",
          "watchdog-retries": "",
          ...(params.task["worktree-path"] ? { "worktree-path": "" } : {}),
        },
      });

      await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          pr: prUrl ?? undefined,
          sessionId,
          escalationReason: reason,
        },
      };
    }

    if (ciOnly && !isCiIssue) {
      const completed = new Date();
      const completedAt = completed.toISOString().split("T")[0];
      const reason = `Guardrail: PR only changes CI/workflows for non-CI issue ${params.task.issue}`;

      await this.createAgentRun(params.task, {
        outcome: "failed",
        started: completed,
        completed,
        sessionId,
        bodyPrefix: [
          "Blocked: CI-only PR for non-CI issue",
          "",
          `Issue: ${params.task.issue}`,
          `PR: ${prUrl}`,
          `Files: ${prFiles.join(", ") || "(none)"}`,
        ].join("\n"),
      });

      await this.markTaskBlocked(params.task, "ci-only", {
        reason,
        skipRunNote: true,
        extraFields: {
          "completed-at": completedAt,
          "session-id": "",
          "watchdog-retries": "",
          ...(params.task["worktree-path"] ? { "worktree-path": "" } : {}),
        },
      });

      await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          pr: prUrl ?? undefined,
          sessionId,
          escalationReason: reason,
        },
      };
    }

    const mergeWhenReady = async (headSha: string): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> => {
      console.log(`[ralph:worker:${this.repo}] Required checks passed; merging ${prUrl}`);
      try {
        await this.mergePullRequest(prUrl, headSha, params.repoPath);
        this.recordPrSnapshotBestEffort({ issue: params.task.issue, prUrl, state: PR_STATE_MERGED });
        try {
          await this.applyMidpointLabelsBestEffort({
            task: params.task,
            prUrl,
            botBranch: params.botBranch,
            baseBranch,
          });
        } catch (error: any) {
          console.warn(`[ralph:worker:${this.repo}] Failed to apply midpoint labels: ${this.formatGhError(error)}`);
        }
        try {
          const normalizedBase = baseBranch ? this.normalizeGitRef(baseBranch) : "";
          const normalizedBot = this.normalizeGitRef(params.botBranch);
          if (normalizedBase && normalizedBase === normalizedBot) {
            await this.deleteMergedPrHeadBranchBestEffort({
              prUrl,
              botBranch: params.botBranch,
              mergedHeadSha: headSha,
            });
          }
        } catch (error: any) {
          console.warn(`[ralph:worker:${this.repo}] Failed to delete PR head branch: ${this.formatGhError(error)}`);
        }
        return { ok: true, prUrl, sessionId };
      } catch (error: any) {
        if (!didUpdateBranch && this.isOutOfDateMergeError(error)) {
          console.log(`[ralph:worker:${this.repo}] PR out of date with base; updating branch ${prUrl}`);
          didUpdateBranch = true;
          try {
            await this.updatePullRequestBranch(prUrl, params.repoPath);
          } catch (updateError: any) {
            const reason = `Failed while updating PR branch before merge: ${this.formatGhError(updateError)}`;
            console.warn(`[ralph:worker:${this.repo}] ${reason}`);
            await this.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
            await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

            return {
              ok: false,
              run: {
                taskName: params.task.name,
                repo: this.repo,
                outcome: "failed",
                sessionId,
                escalationReason: reason,
              },
            };
          }

          const refreshed = await this.waitForRequiredChecks(prUrl, REQUIRED_CHECKS, {
            timeoutMs: 45 * 60_000,
            pollIntervalMs: 30_000,
          });

          if (refreshed.stopReason === "merge-conflict") {
            const { blockedReasonShort, notifyBody } = formatMergeConflictMessage({
              prUrl,
              baseRefName: refreshed.baseRefName,
            });
            console.warn(`[ralph:worker:${this.repo}] ${blockedReasonShort}`);
            await this.markTaskBlocked(params.task, "merge-conflict", { reason: blockedReasonShort });
            await this.notify.notifyError(params.notifyTitle, notifyBody, params.task.name);

            return {
              ok: false,
              run: {
                taskName: params.task.name,
                repo: this.repo,
                outcome: "failed",
                sessionId,
                escalationReason: blockedReasonShort,
              },
            };
          }

          if (refreshed.summary.status === "success") {
            return await mergeWhenReady(refreshed.headSha);
          }

          const ciDebug = await this.runCiDebugRecovery({
            task: params.task,
            issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
            cacheKey: params.cacheKey,
            prUrl,
            requiredChecks: REQUIRED_CHECKS,
            issueMeta: params.issueMeta,
            botBranch: params.botBranch,
            timedOut: refreshed.timedOut,
            opencodeXdg: params.opencodeXdg,
            opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
          });
          if (ciDebug.status !== "success") return { ok: false, run: ciDebug.run };
          sessionId = ciDebug.sessionId || sessionId;
          return await mergeWhenReady(ciDebug.headSha);
        }
        throw error;
      }
    };

    if (!didUpdateBranch && isAutoUpdateBehindEnabled(this.repo)) {
      try {
        const prState = await this.getPullRequestMergeState(prUrl);
        const guard = this.shouldAttemptProactiveUpdate(prState);
        const labelGate = getAutoUpdateBehindLabelGate(this.repo);
        const minMinutes = getAutoUpdateBehindMinMinutes(this.repo);
        const rateLimited = this.shouldRateLimitAutoUpdate(prState, minMinutes);

        if (prState.mergeStateStatus === "DIRTY") {
          const { blockedReasonShort, notifyBody } = formatMergeConflictMessage({
            prUrl,
            baseRefName: prState.baseRefName,
          });
          const reason = `PR has merge conflicts; refusing auto-update ${prUrl}`;
          console.warn(`[ralph:worker:${this.repo}] ${reason}`);
          this.recordAutoUpdateFailure(prState, minMinutes);
          await this.markTaskBlocked(params.task, "merge-conflict", {
            reason: blockedReasonShort,
            details: notifyBody,
            sessionId,
          });
          await this.notify.notifyError(params.notifyTitle, notifyBody, params.task.name);

          return {
            ok: false,
            run: {
              taskName: params.task.name,
              repo: this.repo,
              outcome: "failed",
              sessionId,
              escalationReason: blockedReasonShort,
            },
          };
        }

        const hasLabelGate = labelGate
          ? prState.labels.map((label) => label.toLowerCase()).includes(labelGate.toLowerCase())
          : true;

        if (!hasLabelGate) {
          console.log(
            `[ralph:worker:${this.repo}] PR behind but missing label gate ${labelGate ?? ""}; skipping auto-update ${prUrl}`
          );
        } else if (!guard.ok) {
          console.log(`[ralph:worker:${this.repo}] PR auto-update skipped (${guard.reason ?? "guardrail"}): ${prUrl}`);
        } else if (rateLimited) {
          console.log(`[ralph:worker:${this.repo}] PR auto-update rate-limited; skipping ${prUrl}`);
        } else {
          console.log(`[ralph:worker:${this.repo}] PR BEHIND; updating branch ${prUrl}`);
          this.recordAutoUpdateAttempt(prState, minMinutes);
          await this.updatePullRequestBranch(prUrl, params.repoPath);
          didUpdateBranch = true;
        }
      } catch (updateError: any) {
        const reason = `Failed while auto-updating PR branch: ${this.formatGhError(updateError)}`;
        console.warn(`[ralph:worker:${this.repo}] ${reason}`);
        try {
          const prState = await this.getPullRequestMergeState(prUrl);
          const minMinutes = getAutoUpdateBehindMinMinutes(this.repo);
          this.recordAutoUpdateFailure(prState, minMinutes);
        } catch {
          // best-effort
        }
        await this.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
        await this.notify.notifyError(params.notifyTitle, reason, params.task.name);

        return {
          ok: false,
          run: {
            taskName: params.task.name,
            repo: this.repo,
            outcome: "failed",
            sessionId,
            escalationReason: reason,
          },
        };
      }
    }

    const checkResult = await this.waitForRequiredChecks(prUrl, REQUIRED_CHECKS, {
      timeoutMs: 45 * 60_000,
      pollIntervalMs: 30_000,
    });

    if (checkResult.stopReason === "merge-conflict") {
      const { blockedReasonShort, notifyBody } = formatMergeConflictMessage({
        prUrl,
        baseRefName: checkResult.baseRefName,
      });
      console.warn(`[ralph:worker:${this.repo}] ${blockedReasonShort}`);
      await this.markTaskBlocked(params.task, "merge-conflict", { reason: blockedReasonShort });
      await this.notify.notifyError(params.notifyTitle, notifyBody, params.task.name);

      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId,
          escalationReason: blockedReasonShort,
        },
      };
    }

    const throttled = await this.pauseIfHardThrottled(params.task, `${params.watchdogStagePrefix}-ci-remediation`, sessionId);
    if (throttled) return { ok: false, run: throttled };

    if (checkResult.summary.status === "success") {
      return await mergeWhenReady(checkResult.headSha);
    }

    const ciDebug = await this.runCiDebugRecovery({
      task: params.task,
      issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
      cacheKey: params.cacheKey,
      prUrl,
      requiredChecks: REQUIRED_CHECKS,
      issueMeta: params.issueMeta,
      botBranch: params.botBranch,
      timedOut: checkResult.timedOut,
      opencodeXdg: params.opencodeXdg,
      opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
    });

    if (ciDebug.status !== "success") return { ok: false, run: ciDebug.run };

    sessionId = ciDebug.sessionId || sessionId;
    return await mergeWhenReady(ciDebug.headSha);
  }

  private async skipClosedIssue(task: AgentTask, issueMeta: IssueMetadata, started: Date): Promise<AgentRun> {
    const completed = new Date();
    const completedAt = completed.toISOString().split("T")[0];

    const issueUrl = issueMeta.url ?? task.issue;
    const closedAt = issueMeta.closedAt ?? "";
    const stateReason = issueMeta.stateReason ?? "";

    console.log(
      `[ralph:worker:${this.repo}] RALPH_SKIP_CLOSED issue=${issueUrl} closedAt=${closedAt || "unknown"} task=${task.name}`
    );

    await this.createAgentRun(task, {
      outcome: "success",
      started,
      completed,
      sessionId: task["session-id"]?.trim() || undefined,
      bodyPrefix: [
        "Skipped: issue already closed upstream",
        "",
        `Issue: ${issueUrl}`,
        `closedAt: ${closedAt || "unknown"}`,
        stateReason ? `stateReason: ${stateReason}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });

    await this.queue.updateTaskStatus(task, "done", {
      "completed-at": completedAt,
      "session-id": "",
      "watchdog-retries": "",
      ...(task["worktree-path"] ? { "worktree-path": "" } : {}),
      ...(task["worker-id"] ? { "worker-id": "" } : {}),
      ...(task["repo-slot"] ? { "repo-slot": "" } : {}),
    });

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
    };
  }

  /**
   * Determine if we should escalate based on routing decision.
   */
  private shouldEscalate(

    routing: RoutingDecision | null,
    hasGap: boolean,
    isImplementationTask: boolean
  ): boolean {
    return shouldEscalateAfterRouting({ routing, hasGap });
  }

  private getWatchdogRetryCount(task: AgentTask): number {
    const raw = task["watchdog-retries"];
    const parsed = Number.parseInt(String(raw ?? "0"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private buildWatchdogOptions(task: AgentTask, stage: string) {
    const cfg = getConfig().watchdog;
    const context = `[${this.repo}] ${task.name} (${task.issue}) stage=${stage}`;

    return {
      watchdog: {
        enabled: cfg?.enabled ?? true,
        thresholdsMs: cfg?.thresholdsMs,
        softLogIntervalMs: cfg?.softLogIntervalMs,
        recentEventLimit: cfg?.recentEventLimit,
        context,
      },
    };
  }

  private getPinnedOpencodeProfileName(task: AgentTask): string | null {
    const raw = task["opencode-profile"];
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    return trimmed ? trimmed : null;
  }

  private async resolveOpencodeXdgForTask(
    task: AgentTask,
    phase: "start" | "resume"
  ): Promise<{
    profileName: string | null;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    error?: string;
  }> {
    if (!isOpencodeProfilesEnabled()) return { profileName: null };

    const pinned = this.getPinnedOpencodeProfileName(task);

    if (pinned) {
      const resolved = resolveOpencodeProfile(pinned);
      if (!resolved) {
        return {
          profileName: pinned,
          error:
            `Task is pinned to an unknown OpenCode profile ${JSON.stringify(pinned)} (task ${task.issue}). ` +
            `Configure it under [opencode.profiles.${pinned}] in ~/.ralph/config.toml (paths must be absolute; no '~' expansion).`,
        };
      }

      return {
        profileName: resolved.name,
        opencodeXdg: {
          dataHome: resolved.xdgDataHome,
          configHome: resolved.xdgConfigHome,
          stateHome: resolved.xdgStateHome,
          cacheHome: resolved.xdgCacheHome,
        },
      };
    }

    const defaults = getConfig().control;
    const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults });
    const requested = control.opencodeProfile?.trim() ?? "";

    let resolved = null as ReturnType<typeof resolveOpencodeProfile>;

    if (requested === "auto") {
      const chosen = await resolveAutoOpencodeProfileName(Date.now(), {
        getThrottleDecision: this.throttle.getThrottleDecision,
      });
      if (phase === "start") {
        console.log(`[ralph:worker:${this.repo}] Auto-selected OpenCode profile=${JSON.stringify(chosen ?? "")}`);
      }
      resolved = chosen ? resolveOpencodeProfile(chosen) : resolveOpencodeProfile(null);
    } else if (phase === "start") {
      const selection = await resolveOpencodeProfileForNewWork(Date.now(), requested || null, {
        getThrottleDecision: this.throttle.getThrottleDecision,
      });
      const chosen = selection.profileName;

      if (selection.source === "failover") {
        console.log(
          `[ralph:worker:${this.repo}] Hard throttle on profile=${selection.requestedProfile ?? "default"}; ` +
            `failing over to profile=${chosen ?? "ambient"}`
        );
      }

      resolved = chosen ? resolveOpencodeProfile(chosen) : null;
    } else {
      resolved = requested ? resolveOpencodeProfile(requested) : null;
    }

    if (requested && requested !== "auto" && !resolved) {
      console.warn(
        `[ralph:worker:${this.repo}] Control opencode_profile=${JSON.stringify(requested)} does not match a configured profile; ` +
          `falling back to defaultProfile=${JSON.stringify(getOpencodeDefaultProfileName() ?? "")}`
      );
      resolved = resolveOpencodeProfile(null);
    }

    if (!resolved) {
      if (phase === "start" && requested) {
        console.warn(`[ralph:worker:${this.repo}] Unable to resolve OpenCode profile for new task; running with ambient XDG dirs`);
      }
      return { profileName: null };
    }

    return {
      profileName: resolved.name,
      opencodeXdg: {
        dataHome: resolved.xdgDataHome,
        configHome: resolved.xdgConfigHome,
        stateHome: resolved.xdgStateHome,
        cacheHome: resolved.xdgCacheHome,
      },
    };
  }

  private async pauseIfHardThrottled(task: AgentTask, stage: string, sessionId?: string): Promise<AgentRun | null> {
    const pinned = this.getPinnedOpencodeProfileName(task);
    const sid = sessionId?.trim() || task["session-id"]?.trim() || "";
    const hasSession = !!sid;

    let decision: Awaited<ReturnType<typeof getThrottleDecision>>;

    if (pinned) {
      decision = await this.throttle.getThrottleDecision(Date.now(), { opencodeProfile: pinned });
    } else {
      const defaults = getConfig().control;
      const controlProfile =
        readControlStateSnapshot({ log: (message) => console.warn(message), defaults }).opencodeProfile?.trim() ?? "";

      if (controlProfile === "auto") {
        const chosen = await resolveAutoOpencodeProfileName(Date.now(), {
          getThrottleDecision: this.throttle.getThrottleDecision,
        });

        decision = await this.throttle.getThrottleDecision(Date.now(), {
          opencodeProfile: chosen ?? getOpencodeDefaultProfileName(),
        });
      } else if (!hasSession) {
        // Safe to fail over between profiles before starting a new session.
        decision = (
          await resolveOpencodeProfileForNewWork(Date.now(), controlProfile || null, {
            getThrottleDecision: this.throttle.getThrottleDecision,
          })
        ).decision;
      } else {
        // Do not fail over while a session is in flight/resuming.
        decision = await this.throttle.getThrottleDecision(Date.now(), { opencodeProfile: controlProfile || getOpencodeDefaultProfileName() });
      }
    }

    if (decision.state !== "hard") return null;

    const throttledAt = new Date().toISOString();
    const resumeAt = decision.resumeAtTs ? new Date(decision.resumeAtTs).toISOString() : "";

    const extraFields: Record<string, string> = {
      "throttled-at": throttledAt,
      "resume-at": resumeAt,
      "usage-snapshot": JSON.stringify(decision.snapshot),
    };

    if (sid) extraFields["session-id"] = sid;

    const enteringThrottled = task.status !== "throttled";
    const updated = await this.queue.updateTaskStatus(task, "throttled", extraFields);
    if (updated) {
      applyTaskPatch(task, "throttled", extraFields);
    }

    if (updated && enteringThrottled) {
      const bodyPrefix = buildAgentRunBodyPrefix({
        task,
        headline: `Throttled: hard limit (${stage})`,
        reason: `Resume at: ${resumeAt || "unknown"}`,
        details: JSON.stringify(decision.snapshot),
        sessionId: sid || undefined,
        runLogPath: task["run-log-path"]?.trim() || undefined,
      });
      const runTime = new Date();
      await this.createAgentRun(task, {
        outcome: "throttled",
        sessionId: sid || undefined,
        started: runTime,
        completed: runTime,
        bodyPrefix,
      });
    }

    console.log(
      `[ralph:worker:${this.repo}] Hard throttle active; pausing at checkpoint stage=${stage} resumeAt=${resumeAt || "unknown"}`
    );

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "throttled",
      sessionId: sid || undefined,
    };
  }

  private async drainNudges(
    task: AgentTask,
    repoPath: string,
    sessionId: string,
    cacheKey: string,
    stage: string,
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string }
  ): Promise<void> {
    const sid = sessionId?.trim();
    if (!sid) return;

    try {
      const issueNumber = task.issue.match(/#(\d+)$/)?.[1] ?? cacheKey;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      const result = await drainQueuedNudges(sid, async (message) => {
        const paused = await this.pauseIfHardThrottled(task, `nudge-${stage}`, sid);
        if (paused) {
          return { success: false, error: "hard throttled" };
        }

        const runLogPath = await this.recordRunLogPath(task, issueNumber, `nudge-${stage}`, "in-progress");

        const res = await this.session.continueSession(repoPath, sid, message, {
          repo: this.repo,
          cacheKey,
          runLogPath,
          ...this.buildWatchdogOptions(task, `nudge-${stage}`),
          ...opencodeSessionOptions,
        });
        return { success: res.success, error: res.success ? undefined : res.output };
      });

      if (result.attempted > 0) {
        const suffix = result.stoppedOnError ? " (stopped on error)" : "";
        console.log(
          `[ralph:worker:${this.repo}] Delivered ${result.delivered}/${result.attempted} queued nudge(s)${suffix}`
        );
      }
    } catch (e: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to drain nudges: ${e?.message ?? String(e)}`);
    }
  }

  private async handleWatchdogTimeout(
    task: AgentTask,
    cacheKey: string,
    stage: string,
    result: SessionResult,
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string }
  ): Promise<AgentRun> {
    const timeout = result.watchdogTimeout;
    const retryCount = this.getWatchdogRetryCount(task);
    const nextRetryCount = retryCount + 1;
    const sessionId = result.sessionId || task["session-id"]?.trim() || null;
    const worktreePath = task["worktree-path"]?.trim() || null;

    const reason = timeout
      ? `Tool call timed out: ${timeout.toolName} ${timeout.callId} after ${Math.round(timeout.elapsedMs / 1000)}s (${stage})`
      : `Tool call timed out (${stage})`;

    const issueRef = parseIssueRef(task.issue, task.repo);
    const watchdogWritebackContext = issueRef
      ? {
          repo: issueRef.repo,
          issueNumber: issueRef.number,
          taskName: task.name,
          taskPath: task._path ?? task.name,
          sessionId,
          worktreePath,
          stage,
          watchdogTimeout: timeout ?? null,
          output: result.output ?? null,
          kind: "stuck" as const,
          suggestedCommands: ["bun test", "bun run typecheck", "bun run build"],
        }
      : null;
    const earlyTermination = retryCount === 0 && hasRepeatedToolPattern(timeout?.recentEvents);
    const escalationReason = earlyTermination
      ? `${reason} (early termination: repeated watchdog signature)`
      : reason;

    // Cleanup per-task OpenCode cache on watchdog timeouts (best-effort)
    try {
      await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey, opencodeXdg?.cacheHome), { recursive: true, force: true });
    } catch {
      // ignore
    }

    if (retryCount === 0 && !earlyTermination) {
      if (watchdogWritebackContext) {
        try {
          await this.ensureRalphWorkflowLabelsOnce();
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Failed to ensure ralph workflow labels before watchdog writeback: ${
              error?.message ?? String(error)
            }`
          );
        }

        try {
          await writeWatchdogToGitHub(watchdogWritebackContext, { github: this.github, log: (m) => console.log(m) });
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Watchdog writeback failed for ${task.issue}: ${error?.message ?? String(error)}`
          );
        }
      }

      console.warn(`[ralph:worker:${this.repo}] Watchdog hard timeout; re-queuing once for recovery: ${reason}`);
      await this.queue.updateTaskStatus(task, "queued", {
        "session-id": "",
        "watchdog-retries": String(nextRetryCount),
      });

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: result.sessionId || undefined,
        escalationReason: reason,
      };
    }

    if (earlyTermination) {
      console.log(
        `[ralph:worker:${this.repo}] Watchdog timeout signature repeats; escalating without retry: ${escalationReason}`
      );
    } else {
      console.log(`[ralph:worker:${this.repo}] Watchdog hard timeout repeated; escalating: ${escalationReason}`);
    }

    const escalationFields: Record<string, string> = {
      "watchdog-retries": String(nextRetryCount),
    };
    if (result.sessionId) escalationFields["session-id"] = result.sessionId;

    const wasEscalated = task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(task, "escalated", escalationFields);
    if (escalated) {
      applyTaskPatch(task, "escalated", escalationFields);
    }

    let diagnostics: string | null = null;
    if (watchdogWritebackContext) {
      try {
        diagnostics = await buildWatchdogDiagnostics({ ...watchdogWritebackContext, kind: "escalated" });
      } catch (error: any) {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to build watchdog diagnostics for ${task.issue}: ${
            error?.message ?? String(error)
          }`
        );
      }
    }

    const githubCommentUrl = await this.writeEscalationWriteback(task, {
      reason: escalationReason,
      details: diagnostics ?? undefined,
      escalationType: "other",
    });
    await this.notify.notifyEscalation({
      taskName: task.name,
      taskFileName: task._name,
      taskPath: task._path,
      issue: task.issue,
      repo: this.repo,
      scope: task.scope,
      priority: task.priority,
      sessionId: result.sessionId || task["session-id"]?.trim() || undefined,
      reason: escalationReason,
      escalationType: "other",
      githubCommentUrl: githubCommentUrl ?? undefined,
      planOutput: result.output,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(task, {
        reason: escalationReason,
        sessionId: result.sessionId || task["session-id"]?.trim() || undefined,
        details: result.output,
      });
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: result.sessionId || undefined,
      escalationReason: escalationReason,
    };
  }

  async resumeTask(task: AgentTask, opts?: { resumeMessage?: string }): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Resuming task: ${task.name}`);

    if (!isRepoAllowed(task.repo)) {
      return await this.blockDisallowedRepo(task, startTime, "resume");
    }

    const issueMeta = await this.getIssueMetadata(task.issue);
    if (issueMeta.state === "CLOSED") {
      return await this.skipClosedIssue(task, issueMeta, startTime);
    }

    await this.ensureRalphWorkflowLabelsOnce();
    await this.ensureBranchProtectionOnce();

    const issueMatch = task.issue.match(/#(\d+)$/);
    const issueNumber = issueMatch?.[1] ?? "";
    const cacheKey = issueNumber || task._name;

    const existingSessionId = task["session-id"]?.trim();
    if (!existingSessionId) {
      const reason = "In-progress task has no session-id; cannot resume";
      console.warn(`[ralph:worker:${this.repo}] ${reason}: ${task.name}`);
      await this.queue.updateTaskStatus(task, "starting", { "session-id": "" });
      return { taskName: task.name, repo: this.repo, outcome: "failed", escalationReason: reason };
    }

    const workerId = await this.formatWorkerId(task, task._path);
    const allocatedSlot = this.sanitizeRepoSlot(this.allocateRepoSlot());

    try {
      await this.assertRepoRootClean(task, "resume");

      const resolvedRepoPath = await this.resolveTaskRepoPath(
        task,
        issueNumber || cacheKey,
        "resume",
        allocatedSlot
      );

      if (resolvedRepoPath.kind === "reset") {
        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: existingSessionId,
          escalationReason: resolvedRepoPath.reason,
        };
      }

      const { repoPath: taskRepoPath, worktreePath } = resolvedRepoPath;
      if (worktreePath) task["worktree-path"] = worktreePath;

      await this.prepareContextRecovery(task, taskRepoPath);

      const workerIdChanged = task["worker-id"]?.trim() !== workerId;
      const repoSlotChanged = task["repo-slot"]?.trim() !== String(allocatedSlot);

      if (workerIdChanged || repoSlotChanged) {
        await this.queue.updateTaskStatus(task, "in-progress", {
          ...(workerIdChanged ? { "worker-id": workerId } : {}),
          ...(repoSlotChanged ? { "repo-slot": String(allocatedSlot) } : {}),
        });
        task["worker-id"] = workerId;
        task["repo-slot"] = String(allocatedSlot);
      }

      const eventWorkerId = task["worker-id"]?.trim();

      ralphEventBus.publish(
        buildRalphEvent({
          type: "worker.created",
          level: "info",
          ...(eventWorkerId ? { workerId: eventWorkerId } : {}),
          repo: this.repo,
          taskId: task._path,
          sessionId: existingSessionId,
          data: {
            ...(worktreePath ? { worktreePath } : {}),
            ...(typeof allocatedSlot === "number" ? { repoSlot: allocatedSlot } : {}),
          },
        })
      );

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "resume");

      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      if (!task["opencode-profile"]?.trim() && opencodeProfileName) {
        await this.queue.updateTaskStatus(task, "in-progress", { "opencode-profile": opencodeProfileName });
      }

      const pausedSetup = await this.pauseIfHardThrottled(task, "setup (resume)", existingSessionId);
      if (pausedSetup) return pausedSetup;

      const setupRun = await this.ensureSetupForTask({
        task,
        issueNumber: issueNumber || cacheKey,
        taskRepoPath,
        status: "in-progress",
        sessionId: existingSessionId,
      });
      if (setupRun) return setupRun;

      const botBranch = getRepoBotBranch(this.repo);
      const issueMeta = await this.getIssueMetadata(task.issue);

      const defaultResumeMessage =
        "Ralph restarted while this task was in progress. " +
        "Resume from where you left off. " +
        "If you already created a PR, paste the PR URL. " +
        `Otherwise continue implementing and create a PR targeting the '${botBranch}' branch.`;

      const resumeMessage = opts?.resumeMessage?.trim();
      const baseResumeMessage = resumeMessage || defaultResumeMessage;
      const existingPr = await this.getIssuePrResolution(issueNumber);
      const finalResumeMessage = existingPr.selectedUrl
        ? [
            `An open PR already exists for this issue: ${existingPr.selectedUrl}.`,
            "Do NOT create a new PR.",
            "Continue work on the existing PR branch and push updates as needed.",
            resumeMessage ?? "",
            "Only paste a PR URL if it changes.",
          ]
            .filter(Boolean)
            .join(" ")
        : baseResumeMessage;

      if (existingPr.selectedUrl) {
        console.log(
          `[ralph:worker:${this.repo}] Reusing existing PR for resume: ${existingPr.selectedUrl} (source=${
            existingPr.source ?? "unknown"
          })`
        );
        if (existingPr.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPr.duplicates.join(", ")}`
          );
        }
      }

      const pausedBefore = await this.pauseIfHardThrottled(task, "resume", existingSessionId);
      if (pausedBefore) return pausedBefore;

      return await this.withRunContext(task, "resume", async () => {
      const resumeRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "resume", "in-progress");

      let buildResult = await this.session.continueSession(taskRepoPath, existingSessionId, finalResumeMessage, {
        repo: this.repo,
        cacheKey,
        runLogPath: resumeRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "resume",
        },
        ...this.buildWatchdogOptions(task, "resume"),
        ...opencodeSessionOptions,
      });

      const pausedAfter = await this.pauseIfHardThrottled(task, "resume (post)", buildResult.sessionId || existingSessionId);
      if (pausedAfter) return pausedAfter;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume", buildResult, opencodeXdg);
        }

        const reason = `Failed to resume OpenCode session ${existingSessionId}: ${buildResult.output}`;
        console.warn(`[ralph:worker:${this.repo}] Resume failed; falling back to fresh run: ${reason}`);

        // Fall back to a fresh run by clearing session-id and re-queueing.
        await this.queue.updateTaskStatus(task, "queued", { "session-id": "" });

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: existingSessionId,
          escalationReason: reason,
        };
      }

      if (buildResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

      // Extract PR URL (with retry loop if agent stopped without creating PR)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = this.updateOpenPrSnapshot(
        task,
        null,
        selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
      );
      let prRecoveryDiagnostics = "";

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = recovered.diagnostics;
        prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
      }

      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId || existingSessionId, cacheKey, "resume", opencodeXdg);

        const anomalyStatus = await readLiveAnomalyCount(buildResult.sessionId);
        const newAnomalies = anomalyStatus.total - lastAnomalyCount;
        lastAnomalyCount = anomalyStatus.total;

        if (anomalyStatus.total >= ANOMALY_BURST_THRESHOLD || anomalyStatus.recentBurst) {
          anomalyAborts++;
          console.warn(
            `[ralph:worker:${this.repo}] Anomaly burst detected (${anomalyStatus.total} total, ${newAnomalies} new). ` +
              `Abort #${anomalyAborts}/${MAX_ANOMALY_ABORTS}`
          );

          if (anomalyAborts >= MAX_ANOMALY_ABORTS) {
            const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
            console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

            const wasEscalated = task.status === "escalated";
            const escalated = await this.queue.updateTaskStatus(task, "escalated");
            if (escalated) {
              applyTaskPatch(task, "escalated", {});
            }
            await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "other",
              planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            });

            if (escalated && !wasEscalated) {
              await this.recordEscalatedRunNote(task, {
                reason,
                sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
                details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
              });
            }

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);

          const pausedLoopBreak = await this.pauseIfHardThrottled(task, "resume loop-break", buildResult.sessionId || existingSessionId);
          if (pausedLoopBreak) return pausedLoopBreak;

          const loopBreakRunLogPath = await this.recordRunLogPath(
            task,
            issueNumber || cacheKey,
            "resume loop-break",
            "in-progress"
          );

          buildResult = await this.session.continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              runLogPath: loopBreakRunLogPath,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "resume loop-break",
              },
              ...this.buildWatchdogOptions(task, "resume-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          const pausedLoopBreakAfter = await this.pauseIfHardThrottled(
            task,
            "resume loop-break (post)",
            buildResult.sessionId || existingSessionId
          );
          if (pausedLoopBreakAfter) return pausedLoopBreakAfter;

          if (!buildResult.success) {
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "resume-loop-break", buildResult, opencodeXdg);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          lastAnomalyCount = anomalyStatus.total;
          prUrl = this.updateOpenPrSnapshot(
            task,
            prUrl,
            selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
          );

          continue;
        }

        const canonical = await this.getIssuePrResolution(issueNumber);
        if (canonical.selectedUrl) {
          console.log(
            `[ralph:worker:${this.repo}] Reusing existing PR during resume: ${canonical.selectedUrl} (source=${
              canonical.source ?? "unknown"
            })`
          );
          if (canonical.duplicates.length > 0) {
            console.log(
              `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
            );
          }
          prRecoveryDiagnostics = [prRecoveryDiagnostics, canonical.diagnostics.join("\n")].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
          break;
        }

        continueAttempts++;
        console.log(
          `[ralph:worker:${this.repo}] No PR URL found; requesting PR creation (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
        );

        const pausedContinue = await this.pauseIfHardThrottled(task, "resume continue", buildResult.sessionId || existingSessionId);
        if (pausedContinue) return pausedContinue;

        const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
        const resumeContinueRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "continue", "in-progress");

        buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          runLogPath: resumeContinueRunLogPath,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "continue",
          },
          ...this.buildWatchdogOptions(task, "resume-continue"),
          ...opencodeSessionOptions,
        });

        const pausedContinueAfter = await this.pauseIfHardThrottled(
          task,
          "resume continue (post)",
          buildResult.sessionId || existingSessionId
        );
        if (pausedContinueAfter) return pausedContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume-continue", buildResult, opencodeXdg);
          }

          // If the session ended without printing a URL, try to recover PR from git state.
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);

          if (!prUrl) {
            console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
            break;
          }
        } else {
          prUrl = this.updateOpenPrSnapshot(
            task,
            prUrl,
            selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
          );
        }
      }

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
        prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
      }

      if (!prUrl) {
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        const wasEscalated = task.status === "escalated";
        const escalated = await this.queue.updateTaskStatus(task, "escalated");
        if (escalated) {
          applyTaskPatch(task, "escalated", {});
        }
        await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
          reason,
          escalationType: "other",
          planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
        });

        if (escalated && !wasEscalated) {
          await this.recordEscalatedRunNote(task, {
            reason,
            sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
            details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
          });
        }

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      const canonical = await this.getIssuePrResolution(issueNumber);
      if (canonical.selectedUrl && !this.isSamePrUrl(prUrl, canonical.selectedUrl)) {
        console.log(
          `[ralph:worker:${this.repo}] Detected duplicate PR; using existing ${canonical.selectedUrl} instead of ${prUrl}`
        );
        if (canonical.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
          );
        }
        prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
      }

      const pausedMerge = await this.pauseIfHardThrottled(task, "resume merge", buildResult.sessionId || existingSessionId);
      if (pausedMerge) return pausedMerge;

      const mergeGate = await this.mergePrWithRequiredChecks({
        task,
        repoPath: taskRepoPath,
        cacheKey,
        botBranch,
        prUrl,
        sessionId: buildResult.sessionId,
        issueMeta,
        watchdogStagePrefix: "merge",
        notifyTitle: `Merging ${task.name}`,
        opencodeXdg,
      });


      if (!mergeGate.ok) return mergeGate.run;

      const pausedMergeAfter = await this.pauseIfHardThrottled(
        task,
        "resume merge (post)",
        mergeGate.sessionId || buildResult.sessionId || existingSessionId
      );
      if (pausedMergeAfter) return pausedMergeAfter;

      prUrl = mergeGate.prUrl;
      buildResult.sessionId = mergeGate.sessionId;

      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "resume survey", buildResult.sessionId || existingSessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const resumeSurveyRunLogPath = await this.recordRunLogPath(task, issueNumber || cacheKey, "survey", "in-progress");

      const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
        runLogPath: resumeSurveyRunLogPath,
        ...this.buildWatchdogOptions(task, "resume-survey"),
        ...opencodeSessionOptions,
      });


      const pausedSurveyAfter = await this.pauseIfHardThrottled(
        task,
        "resume survey (post)",
        surveyResult.sessionId || buildResult.sessionId || existingSessionId
      );
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume-survey", surveyResult, opencodeXdg);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      return await this.finalizeTaskSuccess({
        task,
        prUrl,
        sessionId: buildResult.sessionId,
        startTime,
        surveyResults: surveyResult.output,
        cacheKey,
        opencodeXdg,
        worktreePath,
        workerId,
        repoSlot: typeof allocatedSlot === "number" ? String(allocatedSlot) : undefined,
        notify: false,
        logMessage: `Task resumed to completion: ${task.name}`,
      });
      });
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Resume failed:`, error);

      if (!error?.ralphRootDirty) {
        const reason = error?.message ?? String(error);
        const details = error?.stack ?? reason;
        await this.markTaskBlocked(task, "runtime-error", { reason, details });
        await this.notify.notifyError(`Resuming ${task.name}`, error?.message ?? String(error), task.name);
      }

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      if (typeof allocatedSlot === "number") {
        this.releaseRepoSlot(allocatedSlot);
      }
    }
  }

  async processTask(task: AgentTask): Promise<AgentRun> {
    const startTime = new Date();
    console.log(`[ralph:worker:${this.repo}] Starting task: ${task.name}`);

    let workerId: string | undefined;
    let allocatedSlot: number | null = null;

    try {
      // 1. Extract issue number (e.g., "3mdistal/bwrb#245" -> "245")
      const issueMatch = task.issue.match(/#(\d+)$/);
      if (!issueMatch) throw new Error(`Invalid issue format: ${task.issue}`);
      const issueNumber = issueMatch[1];
      const cacheKey = issueNumber;

      if (!isRepoAllowed(task.repo)) {
        return await this.blockDisallowedRepo(task, startTime, "start");
      }

      // 2. Preflight: skip work if the upstream issue is already CLOSED
      const issueMeta = await this.getIssueMetadata(task.issue);
      if (issueMeta.state === "CLOSED") {
        return await this.skipClosedIssue(task, issueMeta, startTime);
      }

      workerId = await this.formatWorkerId(task, task._path);
      allocatedSlot = this.sanitizeRepoSlot(this.allocateRepoSlot());

      const pausedPreStart = await this.pauseIfHardThrottled(task, "pre-start");
      if (pausedPreStart) return pausedPreStart;

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "start");
      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      await this.ensureRalphWorkflowLabelsOnce();

      // 3. Mark task starting (restart-safe pre-session state)
      const shouldClearBlocked = Boolean(
        task["blocked-source"]?.trim() || task["blocked-reason"]?.trim() || task["blocked-details"]?.trim()
      );
      const markedStarting = await this.queue.updateTaskStatus(task, "starting", {
        "assigned-at": startTime.toISOString().split("T")[0],
        ...(!task["opencode-profile"]?.trim() && opencodeProfileName ? { "opencode-profile": opencodeProfileName } : {}),
        ...(workerId ? { "worker-id": workerId } : {}),
        ...(typeof allocatedSlot === "number" ? { "repo-slot": String(allocatedSlot) } : {}),
        ...(shouldClearBlocked
          ? {
              "blocked-source": "",
              "blocked-reason": "",
              "blocked-details": "",
              "blocked-at": "",
              "blocked-checked-at": "",
            }
          : {}),
      });
      if (workerId) task["worker-id"] = workerId;
      if (typeof allocatedSlot === "number") task["repo-slot"] = String(allocatedSlot);
      if (!markedStarting) {
        throw new Error("Failed to mark task starting (bwrb edit failed)");
      }

      await this.ensureBranchProtectionOnce();

      const resolvedRepoPath = await this.resolveTaskRepoPath(task, issueNumber, "start", allocatedSlot);
      if (resolvedRepoPath.kind !== "ok") {
        throw new Error(resolvedRepoPath.reason);
      }
      const { repoPath: taskRepoPath, worktreePath } = resolvedRepoPath;
      if (worktreePath) task["worktree-path"] = worktreePath;

      await this.prepareContextRecovery(task, taskRepoPath);

      ralphEventBus.publish(
        buildRalphEvent({
          type: "worker.created",
          level: "info",
          ...(workerId ? { workerId } : {}),
          repo: this.repo,
          taskId: task._path,
          sessionId: task["session-id"]?.trim() || undefined,
          data: {
            ...(worktreePath ? { worktreePath } : {}),
            ...(typeof allocatedSlot === "number" ? { repoSlot: allocatedSlot } : {}),
          },
        })
      );

      await this.assertRepoRootClean(task, "start");

      return await this.withRunContext(task, "process", async () => {
      const pausedSetup = await this.pauseIfHardThrottled(task, "setup");
      if (pausedSetup) return pausedSetup;

      const setupRun = await this.ensureSetupForTask({
        task,
        issueNumber,
        taskRepoPath,
        status: "starting",
      });
      if (setupRun) return setupRun;

      const botBranch = getRepoBotBranch(this.repo);
      const mergeConflictRun = await this.maybeHandleQueuedMergeConflict({
        task,
        issueNumber,
        taskRepoPath,
        cacheKey,
        botBranch,
        issueMeta,
        startTime,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (mergeConflictRun) return mergeConflictRun;

      const ciFailureRun = await this.maybeHandleQueuedCiFailure({
        task,
        issueNumber,
        taskRepoPath,
        cacheKey,
        botBranch,
        issueMeta,
        startTime,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (ciFailureRun) return ciFailureRun;

      // 4. Determine whether this is an implementation-ish task
      const isImplementationTask = isImplementationTaskFromIssue(issueMeta);

      // 4. Run planner prompt with ralph-plan agent
      console.log(`[ralph:worker:${this.repo}] Running planner prompt for issue ${issueNumber}`);

      // Transient OpenCode cache races can cause ENOENT during module imports (e.g. zod locales).
      // With per-run cache isolation this should be rare, but we still retry once for robustness.
      const isTransientCacheENOENT = (output: string) =>
        /ENOENT\s+reading\s+"[^"]*\/opencode\/node_modules\//.test(output) ||
        /ENOENT\s+reading\s+"[^"]*zod\/v4\/locales\//.test(output);

      const pausedPlan = await this.pauseIfHardThrottled(task, "plan");
      if (pausedPlan) return pausedPlan;

      const plannerPrompt = buildPlannerPrompt({ repo: this.repo, issueNumber });
      const planRunLogPath = await this.recordRunLogPath(task, issueNumber, "plan", "starting");

      let planResult = await this.session.runAgent(taskRepoPath, "ralph-plan", plannerPrompt, {
        repo: this.repo,
        cacheKey,
        runLogPath: planRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 1,
          stepTitle: "plan",
        },
        ...this.buildWatchdogOptions(task, "plan"),
        ...opencodeSessionOptions,
      });

      const pausedAfterPlan = await this.pauseIfHardThrottled(task, "plan (post)", planResult.sessionId);
      if (pausedAfterPlan) return pausedAfterPlan;

      if (!planResult.success && planResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
      }

      if (!planResult.success && isTransientCacheENOENT(planResult.output)) {
        console.warn(`[ralph:worker:${this.repo}] planner hit transient cache ENOENT; retrying once...`);
        await new Promise((r) => setTimeout(r, 750));
        const planRetryRunLogPath = await this.recordRunLogPath(task, issueNumber, "plan-retry", "starting");

        planResult = await this.session.runAgent(taskRepoPath, "ralph-plan", plannerPrompt, {
          repo: this.repo,
          cacheKey,
          runLogPath: planRetryRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 1,
            stepTitle: "plan (retry)",
          },
          ...this.buildWatchdogOptions(task, "plan-retry"),
          ...opencodeSessionOptions,
        });
      }

      const pausedAfterPlanRetry = await this.pauseIfHardThrottled(task, "plan (post retry)", planResult.sessionId);
      if (pausedAfterPlanRetry) return pausedAfterPlanRetry;

      if (!planResult.success) {
        if (planResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
        }
        throw new Error(`planner failed: ${planResult.output}`);
      }

      // Persist OpenCode session ID for crash recovery
      if (planResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", {
          "session-id": planResult.sessionId,
          ...(workerId ? { "worker-id": workerId } : {}),
          ...(typeof allocatedSlot === "number" ? { "repo-slot": String(allocatedSlot) } : {}),
        });
      }

      // 5. Parse routing decision
      let routing = parseRoutingDecision(planResult.output);
      let hasGap = hasProductGap(planResult.output);

      // 6. Consult devex once before escalating implementation tasks
      let devexContext: EscalationContext["devex"] | undefined;
      if (shouldConsultDevex({ routing, hasGap, isImplementationTask })) {
        const baseSessionId = planResult.sessionId;
        console.log(
          `[ralph:worker:${this.repo}] Consulting @devex before escalation (task: ${task.name}, session: ${baseSessionId})`
        );

        const devexPrompt = [
          "You are @devex.",
          "Resolve low-level implementation ambiguity (style, error message patterns, validation scope that does not change public behavior).",
          "IMPORTANT: This runs in a non-interactive daemon. Do NOT ask questions; make reasonable default choices and proceed.",
          "Return a short, actionable summary.",
        ].join("\n");

        const pausedDevexConsult = await this.pauseIfHardThrottled(task, "consult devex", baseSessionId);
        if (pausedDevexConsult) return pausedDevexConsult;

        const devexRunLogPath = await this.recordRunLogPath(task, issueNumber, "consult devex", "in-progress");

        const devexResult = await this.session.continueSession(taskRepoPath, baseSessionId, devexPrompt, {
          agent: "devex",
          repo: this.repo,
          cacheKey,
          runLogPath: devexRunLogPath,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 2,
            stepTitle: "consult devex",
          },
          ...opencodeSessionOptions,
        });

        const pausedAfterDevexConsult = await this.pauseIfHardThrottled(
          task,
          "consult devex (post)",
          devexResult.sessionId || baseSessionId
        );
        if (pausedAfterDevexConsult) return pausedAfterDevexConsult;

        if (!devexResult.success) {
          console.warn(`[ralph:worker:${this.repo}] Devex consult failed: ${devexResult.output}`);
          devexContext = {
            consulted: true,
            sessionId: devexResult.sessionId || baseSessionId,
            summary: `Devex consult failed: ${summarizeForNote(devexResult.output, 400)}`,
          };
        } else {
          const devexSummary = summarizeForNote(devexResult.output);
          devexContext = {
            consulted: true,
            sessionId: devexResult.sessionId || baseSessionId,
            summary: devexSummary,
          };

          console.log(
            `[ralph:worker:${this.repo}] Devex consulted (task: ${task.name}, session: ${devexContext.sessionId})`
          );

          const reroutePrompt = [
            "Incorporate the devex guidance below into your plan.",
            "Then output ONLY the routing decision JSON code block.",
            "Do not ask questions.",
            "If an open question touches a user-facing contract surface (e.g. CLI flags/args, exit codes, stdout/stderr formats, config schema, machine-readable outputs), set decision=escalate (policy: docs/escalation-policy.md).",
            "",
            "Devex guidance:",
            devexSummary || devexResult.output,
          ].join("\n");

          const pausedReroute = await this.pauseIfHardThrottled(task, "reroute after devex", baseSessionId);
          if (pausedReroute) return pausedReroute;

          const rerouteRunLogPath = await this.recordRunLogPath(task, issueNumber, "reroute after devex", "in-progress");

          const rerouteResult = await this.session.continueSession(taskRepoPath, baseSessionId, reroutePrompt, {
            repo: this.repo,
            cacheKey,
            runLogPath: rerouteRunLogPath,
            introspection: {
              repo: this.repo,
              issue: task.issue,
              taskName: task.name,
              step: 3,
              stepTitle: "reroute after devex",
            },
            ...opencodeSessionOptions,
          });

          const pausedAfterReroute = await this.pauseIfHardThrottled(
            task,
            "reroute after devex (post)",
            rerouteResult.sessionId || baseSessionId
          );
          if (pausedAfterReroute) return pausedAfterReroute;

          if (!rerouteResult.success) {
            console.warn(`[ralph:worker:${this.repo}] Reroute after devex consult failed: ${rerouteResult.output}`);
          } else {
            if (rerouteResult.sessionId) {
              await this.queue.updateTaskStatus(task, "in-progress", { "session-id": rerouteResult.sessionId });
            }

            const updatedRouting = parseRoutingDecision(rerouteResult.output);
            if (updatedRouting) routing = updatedRouting;

            // Allow product-gap detection to trigger if the reroute output explicitly flags it.
            hasGap = hasGap || hasProductGap(rerouteResult.output);
          }
        }

      }

      // 7. Decide whether to escalate
      const shouldEscalate = this.shouldEscalate(routing, hasGap, isImplementationTask);
      
      if (shouldEscalate) {
        const reason =
          routing?.escalation_reason ||
          (hasGap
            ? "Product documentation gap identified"
            : routing?.decision === "escalate" && routing?.confidence === "high"
              ? "High-confidence escalation requested"
              : "Escalation requested");

        // Determine escalation type
        let escalationType: EscalationContext["escalationType"] = "other";
        if (hasGap) {
          escalationType = "product-gap";
        } else if (isExplicitBlockerReason(routing?.escalation_reason)) {
          escalationType = "blocked";
        } else if (routing?.escalation_reason?.toLowerCase().includes("ambiguous")) {
          escalationType = "ambiguous-requirements";
        }


        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        const wasEscalated = task.status === "escalated";
        const escalated = await this.queue.updateTaskStatus(task, "escalated");
        if (escalated) {
          applyTaskPatch(task, "escalated", {});
        }
        await this.writeEscalationWriteback(task, { reason, escalationType });
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: planResult.sessionId,
          reason,
          escalationType,
          planOutput: planResult.output,
          routing: routing
            ? {
                decision: routing.decision,
                confidence: routing.confidence,
                escalation_reason: routing.escalation_reason ?? undefined,
                plan_summary: routing.plan_summary ?? undefined,
              }
            : undefined,
          devex: devexContext,
        });

        if (escalated && !wasEscalated) {
          await this.recordEscalatedRunNote(task, {
            reason,
            sessionId: planResult.sessionId,
            details: planResult.output,
          });
        }

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: planResult.sessionId,
          escalationReason: reason,
        };
      }

      // 6. Proceed with build
      console.log(`[ralph:worker:${this.repo}] Proceeding with build...`);
      const existingPr = await this.getIssuePrResolution(issueNumber);
      const proceedMessage = existingPr.selectedUrl
        ? [
            `An open PR already exists for this issue: ${existingPr.selectedUrl}.`,
            "Do NOT create a new PR.",
            "Fix any failing checks and push updates to the existing PR branch.",
            "Only paste a PR URL if it changes.",
          ].join(" ")
        : `Proceed with implementation. Target your PR to the \`${botBranch}\` branch.`;

      if (existingPr.selectedUrl) {
        console.log(
          `[ralph:worker:${this.repo}] Reusing existing PR for build: ${existingPr.selectedUrl} (source=${
            existingPr.source ?? "unknown"
          })`
        );
        if (existingPr.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPr.duplicates.join(", ")}`
          );
        }
      }

      const pausedBuild = await this.pauseIfHardThrottled(task, "build", planResult.sessionId);
      if (pausedBuild) return pausedBuild;

      const buildRunLogPath = await this.recordRunLogPath(task, issueNumber, "build", "in-progress");

      let buildResult = await this.session.continueSession(taskRepoPath, planResult.sessionId, proceedMessage, {
        repo: this.repo,
        cacheKey,
        runLogPath: buildRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 4,
          stepTitle: "build",
        },
        ...this.buildWatchdogOptions(task, "build"),
        ...opencodeSessionOptions,
      });

      const pausedAfterBuild = await this.pauseIfHardThrottled(task, "build (post)", buildResult.sessionId || planResult.sessionId);
      if (pausedAfterBuild) return pausedAfterBuild;

      if (!buildResult.success) {
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "build", buildResult, opencodeXdg);
        }
        throw new Error(`Build failed: ${buildResult.output}`);
      }

      // Keep the latest session ID persisted
      if (buildResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", { "session-id": buildResult.sessionId });
      }

      await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

      // 7. Extract PR URL (with retry loop if agent stopped without creating PR)
      // Also monitors for anomaly bursts (GPT tool-result-as-text loop)
      const MAX_CONTINUE_RETRIES = 5;
      let prUrl = this.updateOpenPrSnapshot(
        task,
        null,
        selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
      );
      let prRecoveryDiagnostics = "";

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = recovered.diagnostics;
        prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
      }

      let continueAttempts = 0;
      let anomalyAborts = 0;
      let lastAnomalyCount = 0;

      while (!prUrl && continueAttempts < MAX_CONTINUE_RETRIES) {
        await this.drainNudges(task, taskRepoPath, buildResult.sessionId, cacheKey, "build", opencodeXdg);

        // Check for anomaly burst before continuing
        const anomalyStatus = await readLiveAnomalyCount(buildResult.sessionId);
        const newAnomalies = anomalyStatus.total - lastAnomalyCount;
        lastAnomalyCount = anomalyStatus.total;

        if (anomalyStatus.total >= ANOMALY_BURST_THRESHOLD || anomalyStatus.recentBurst) {
          anomalyAborts++;
          console.warn(
            `[ralph:worker:${this.repo}] Anomaly burst detected (${anomalyStatus.total} total, ${newAnomalies} new). ` +
            `Abort #${anomalyAborts}/${MAX_ANOMALY_ABORTS}`
          );

          if (anomalyAborts >= MAX_ANOMALY_ABORTS) {
            // Too many anomaly aborts - escalate
            const reason = `Agent stuck in tool-result-as-text loop (${anomalyStatus.total} anomalies detected, aborted ${anomalyAborts} times)`;
            console.log(`[ralph:worker:${this.repo}] Escalating due to repeated anomaly loops`);

            const wasEscalated = task.status === "escalated";
            const escalated = await this.queue.updateTaskStatus(task, "escalated");
            if (escalated) {
              applyTaskPatch(task, "escalated", {});
            }
            await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "other",
              planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
            });

            if (escalated && !wasEscalated) {
              await this.recordEscalatedRunNote(task, {
                reason,
                sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
                details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
              });
            }

            return {
              taskName: task.name,
              repo: this.repo,
              outcome: "escalated",
              sessionId: buildResult.sessionId,
              escalationReason: reason,
            };
          }

          // Send a specific nudge to break the loop
          console.log(`[ralph:worker:${this.repo}] Sending loop-break nudge...`);

          const pausedBuildLoopBreak = await this.pauseIfHardThrottled(task, "build loop-break", buildResult.sessionId);
          if (pausedBuildLoopBreak) return pausedBuildLoopBreak;

          const buildLoopBreakRunLogPath = await this.recordRunLogPath(
            task,
            issueNumber,
            "build loop-break",
            "in-progress"
          );

          buildResult = await this.session.continueSession(
            taskRepoPath,
            buildResult.sessionId,
            "You appear to be stuck. Stop repeating previous output and proceed with the next concrete step.",
            {
              repo: this.repo,
              cacheKey,
              runLogPath: buildLoopBreakRunLogPath,
              introspection: {
                repo: this.repo,
                issue: task.issue,
                taskName: task.name,
                step: 4,
                stepTitle: "build loop-break",
              },
              ...this.buildWatchdogOptions(task, "build-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
          if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

          if (!buildResult.success) {
            if (buildResult.watchdogTimeout) {
              return await this.handleWatchdogTimeout(task, cacheKey, "build-loop-break", buildResult, opencodeXdg);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          // Reset anomaly tracking for fresh window
          lastAnomalyCount = anomalyStatus.total;
          prUrl = this.updateOpenPrSnapshot(
            task,
            prUrl,
            selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
          );
          continue;
        }

        const canonical = await this.getIssuePrResolution(issueNumber);
        if (canonical.selectedUrl) {
          console.log(
            `[ralph:worker:${this.repo}] Reusing existing PR during build: ${canonical.selectedUrl} (source=${
              canonical.source ?? "unknown"
            })`
          );
          if (canonical.duplicates.length > 0) {
            console.log(
              `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
            );
          }
          prRecoveryDiagnostics = [prRecoveryDiagnostics, canonical.diagnostics.join("\n")].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
          break;
        }

        continueAttempts++;
        console.log(
          `[ralph:worker:${this.repo}] No PR URL found; requesting PR creation (attempt ${continueAttempts}/${MAX_CONTINUE_RETRIES})`
        );

        const pausedBuildContinue = await this.pauseIfHardThrottled(task, "build continue", buildResult.sessionId);
        if (pausedBuildContinue) return pausedBuildContinue;

        const nudge = this.buildPrCreationNudge(botBranch, issueNumber, task.issue);
        const buildContinueRunLogPath = await this.recordRunLogPath(task, issueNumber, "build continue", "in-progress");

        buildResult = await this.session.continueSession(taskRepoPath, buildResult.sessionId, nudge, {
          repo: this.repo,
          cacheKey,
          runLogPath: buildContinueRunLogPath,
          timeoutMs: 10 * 60_000,
          introspection: {
            repo: this.repo,
            issue: task.issue,
            taskName: task.name,
            step: 4,
            stepTitle: "build continue",
          },
          ...this.buildWatchdogOptions(task, "build-continue"),
          ...opencodeSessionOptions,
        });

        const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
        if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

        if (!buildResult.success) {
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "build-continue", buildResult, opencodeXdg);
          }

          // If the session ended without printing a URL, try to recover PR from git state.
          const recovered = await this.tryEnsurePrFromWorktree({
            task,
            issueNumber,
            issueTitle: issueMeta.title || task.name,
            botBranch,
          });
          prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);

          if (!prUrl) {
            console.warn(`[ralph:worker:${this.repo}] Continue attempt failed: ${buildResult.output}`);
            break;
          }
        } else {
          prUrl = this.updateOpenPrSnapshot(
            task,
            prUrl,
            selectPrUrl({ output: buildResult.output, repo: this.repo, prUrl: buildResult.prUrl })
          );
        }
      }

      if (!prUrl) {
        const recovered = await this.tryEnsurePrFromWorktree({
          task,
          issueNumber,
          issueTitle: issueMeta.title || task.name,
          botBranch,
        });
        prRecoveryDiagnostics = [prRecoveryDiagnostics, recovered.diagnostics].filter(Boolean).join("\n\n");
        prUrl = this.updateOpenPrSnapshot(task, prUrl, recovered.prUrl ?? null);
      }

      if (!prUrl) {
        // Escalate if we still don't have a PR after retries
        const reason = `Agent completed but did not create a PR after ${continueAttempts} continue attempts`;
        console.log(`[ralph:worker:${this.repo}] Escalating: ${reason}`);

        const wasEscalated = task.status === "escalated";
        const escalated = await this.queue.updateTaskStatus(task, "escalated");
        if (escalated) {
          applyTaskPatch(task, "escalated", {});
        }
        await this.writeEscalationWriteback(task, { reason, escalationType: "other" });
        await this.notify.notifyEscalation({
          taskName: task.name,
          taskFileName: task._name,
          taskPath: task._path,
          issue: task.issue,
          repo: this.repo,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
          reason,
          escalationType: "other",
          planOutput: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
        });

        if (escalated && !wasEscalated) {
          await this.recordEscalatedRunNote(task, {
            reason,
            sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
            details: [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n"),
          });
        }

        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "escalated",
          sessionId: buildResult.sessionId,
          escalationReason: reason,
        };
      }

      const canonical = await this.getIssuePrResolution(issueNumber);
      if (canonical.selectedUrl && !this.isSamePrUrl(prUrl, canonical.selectedUrl)) {
        console.log(
          `[ralph:worker:${this.repo}] Detected duplicate PR; using existing ${canonical.selectedUrl} instead of ${prUrl}`
        );
        if (canonical.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
          );
        }
        prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
      }

      const pausedMerge = await this.pauseIfHardThrottled(task, "merge", buildResult.sessionId);
      if (pausedMerge) return pausedMerge;

      const mergeGate = await this.mergePrWithRequiredChecks({
        task,
        repoPath: taskRepoPath,
        cacheKey,
        botBranch,
        prUrl,
        sessionId: buildResult.sessionId,
        issueMeta,
        watchdogStagePrefix: "merge",
        notifyTitle: `Merging ${task.name}`,
        opencodeXdg,
      });

      if (!mergeGate.ok) return mergeGate.run;

      const pausedMergeAfter = await this.pauseIfHardThrottled(task, "merge (post)", mergeGate.sessionId || buildResult.sessionId);
      if (pausedMergeAfter) return pausedMergeAfter;

      prUrl = mergeGate.prUrl;
      buildResult.sessionId = mergeGate.sessionId;

      // 9. Run survey (configured command)
      console.log(`[ralph:worker:${this.repo}] Running survey...`);
      const pausedSurvey = await this.pauseIfHardThrottled(task, "survey", buildResult.sessionId);
      if (pausedSurvey) return pausedSurvey;

      const surveyRepoPath = existsSync(taskRepoPath) ? taskRepoPath : this.repoPath;
      const surveyRunLogPath = await this.recordRunLogPath(task, issueNumber, "survey", "in-progress");

      const surveyResult = await this.session.continueCommand(surveyRepoPath, buildResult.sessionId, "survey", [], {
        repo: this.repo,
        cacheKey,
        runLogPath: surveyRunLogPath,
        introspection: {
          repo: this.repo,
          issue: task.issue,
          taskName: task.name,
          step: 6,
          stepTitle: "survey",
        },
        ...this.buildWatchdogOptions(task, "survey"),
        ...opencodeSessionOptions,
      });

      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "survey (post)", surveyResult.sessionId || buildResult.sessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      return await this.finalizeTaskSuccess({
        task,
        prUrl,
        sessionId: buildResult.sessionId,
        startTime,
        surveyResults: surveyResult.output,
        cacheKey,
        opencodeXdg,
        worktreePath,
        workerId,
        repoSlot: typeof allocatedSlot === "number" ? String(allocatedSlot) : undefined,
        devex: devexContext,
        notify: true,
        logMessage: `Task completed: ${task.name}`,
      });
      });
    } catch (error: any) {
      console.error(`[ralph:worker:${this.repo}] Task failed:`, error);

      if (!error?.ralphRootDirty) {
        const reason = error?.message ?? String(error);
        const details = error?.stack ?? reason;
        await this.markTaskBlocked(task, "runtime-error", { reason, details });
        await this.notify.notifyError(`Processing ${task.name}`, error?.message ?? String(error), task.name);
      }

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      if (typeof allocatedSlot === "number") {
        this.releaseRepoSlot(allocatedSlot);
      }
    }
  }


  private async createAgentRun(
    task: AgentTask,
    data: {
      sessionId?: string;
      pr?: string | null;
      outcome: "success" | "throttled" | "escalated" | "failed";
      started: Date;
      completed: Date;
      surveyResults?: string;
      devex?: EscalationContext["devex"];
      bodyPrefix?: string;
    }
  ): Promise<void> {
    const vault = getBwrbVaultForStorage("create agent-run note");
    if (!vault) {
      return;
    }
    const taskPath = typeof task._path === "string" ? task._path : "";
    const resolvedTaskPath = taskPath.endsWith(".md") ? resolveVaultPath(taskPath) : "";
    if (!resolvedTaskPath || !existsSync(resolvedTaskPath)) {
      console.warn(
        `[ralph:worker:${this.repo}] Skipping agent-run note; task note missing at ${taskPath || "(unknown)"}`
      );
      return;
    }
    const today = data.completed.toISOString().split("T")[0];
    const shortIssue = task.issue.split("/").pop() || task.issue;

    const runName = safeNoteName(`Run for ${shortIssue} - ${task.name.slice(0, 40)}`);

    const payload = buildAgentRunPayload({
      name: runName,
      task: `[[${task._name}]]`,  // Use _name (filename) not name (display) for wikilinks
      started: data.started.toISOString().split("T")[0],
      completed: today,
      outcome: data.outcome,
      pr: data.pr || "",
      creationDate: today,
      scope: "builder",
    });

    try {
      const output = await createBwrbNote({
        type: "agent-run",
        action: "create agent-run note",
        payload,
      });

      if (!output.ok || !output.path) {
        const error = output.ok ? "bwrb did not return a note path" : output.error;
        const log = !output.ok && output.skipped ? console.warn : console.error;
        log(`[ralph:worker:${this.repo}] Failed to create agent-run: ${error}`);
        return;
      }

      const bodySections: string[] = [];

      if (data.bodyPrefix?.trim()) {
        bodySections.push(data.bodyPrefix.trim(), "");
      }

      // Add introspection summary if available
      if (data.sessionId) {
        const introspection = await readIntrospectionSummary(data.sessionId);
        if (introspection) {
          bodySections.push(
            "## Session Summary",
            "",
            `- **Steps:** ${introspection.stepCount}`,
            `- **Tool calls:** ${introspection.totalToolCalls}`,
            `- **Anomalies:** ${introspection.hasAnomalies ? `Yes (${introspection.toolResultAsTextCount} tool-result-as-text)` : "None"}`,
            `- **Recent tools:** ${introspection.recentTools.join(", ") || "none"}`,
            ""
          );
        }
      }


      // Add devex consult summary (if we used devex-before-escalate)
      if (data.devex?.consulted) {
        bodySections.push(
          "## Devex Consult",
          "",
          data.devex.sessionId ? `- **Session:** ${data.devex.sessionId}` : "",
          data.devex.summary ?? "",
          ""
        );
      }

      // Add survey results
      if (data.surveyResults) {
        bodySections.push("## Survey Results", "", data.surveyResults, "");
      }

      if (bodySections.length > 0) {
        const bodyResult = await appendBwrbNoteBody({
          notePath: output.path,
          body: "\n" + bodySections.join("\n"),
        });
        if (!bodyResult.ok) {
          const log = bodyResult.skipped ? console.warn : console.error;
          log(`[ralph:worker:${this.repo}] Failed to write agent-run body: ${bodyResult.error}`);
        }
      }

      // Clean up introspection logs
      if (data.sessionId) {
        await cleanupIntrospectionLogs(data.sessionId);
      }

      console.log(`[ralph:worker:${this.repo}] Created agent-run note`);
    } catch (e) {
      console.error(`[ralph:worker:${this.repo}] Failed to create agent-run:`, e);
    }
  }
}
