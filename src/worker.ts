import { $ } from "bun";
import { appendFile, mkdir, readFile, readdir, rm } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { createHash } from "crypto";

import { type AgentTask, getBwrbVaultForStorage, getBwrbVaultIfValid, updateTaskStatus } from "./queue-backend";
import { appendBwrbNoteBody, buildAgentRunPayload, createBwrbNote } from "./bwrb/artifacts";
import {
  getAutoUpdateBehindLabelGate,
  getAutoUpdateBehindMinMinutes,
  getOpencodeDefaultProfileName,
  getRequestedOpencodeProfileName,
  getRepoBotBranch,
  getRepoConcurrencySlots,
  getRepoLoopDetectionConfig,
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
import { getAllowedOwners, getConfiguredGitHubAppSlug, isRepoAllowed } from "./github-app-auth";
import {
  continueCommand,
  continueSession,
  getRalphXdgCacheHome,
  runAgent,
  type RunSessionOptionsBase,
  type SessionResult,
} from "./session";
import { buildPlannerPrompt } from "./planner-prompt";
import { buildParentVerificationPrompt } from "./parent-verification-prompt";
import { appendChildDossierToIssueContext } from "./child-dossier/core";
import { collectChildCompletionDossier } from "./child-dossier/io";
import { getThrottleDecision } from "./throttle";
import { buildContextResumePrompt, retryContextCompactOnce } from "./context-compact";
import { ensureRalphWorktreeArtifacts, RALPH_PLAN_RELATIVE_PATH } from "./worktree-artifacts";
import { ensureWorktreeSetup, type SetupFailure } from "./worktree-setup";
import { LogLimiter, formatDuration } from "./logging";
import { buildWorktreePath } from "./worktree-paths";

import { PR_CREATE_LEASE_SCOPE, buildPrCreateLeaseKey, isLeaseStale } from "./pr-create-lease";

import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "./opencode-auto-profile";
import { readControlStateSnapshot } from "./drain";
import { buildCheckpointState, type CheckpointState } from "./checkpoints/core";
import { applyCheckpointReached } from "./checkpoints/runtime";
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
import { buildWorkerFailureAlert, type WorkerFailureKind } from "./alerts/worker-failure-core";
import { buildNudgePreview, drainQueuedNudges, type NudgeDeliveryOutcome } from "./nudge";
import { redactSensitiveText } from "./redaction";
import {
  RALPH_LABEL_STATUS_BLOCKED,
  RALPH_LABEL_STATUS_IN_PROGRESS,
  RALPH_LABEL_STATUS_QUEUED,
} from "./github-labels";
import { executeIssueLabelOps, type LabelOp } from "./github/issue-label-io";
import { GitHubApiError, GitHubClient, splitRepoFullName } from "./github/client";
import { computeGitHubRateLimitPause } from "./github/rate-limit-throttle";
import { writeDxSurveyToGitHubIssues } from "./github/dx-survey-writeback";
import { createGhRunner } from "./github/gh-runner";
import { getProtectionContexts, resolveRequiredChecks, type BranchProtection, type ResolvedRequiredChecks } from "./github/required-checks";
import { createRalphWorkflowLabelsEnsurer } from "./github/ensure-ralph-workflow-labels";
import { resolveRelationshipSignals } from "./github/relationship-signals";
import { logRelationshipDiagnostics } from "./github/relationship-diagnostics";
import { sanitizeEscalationReason, writeEscalationToGitHub } from "./github/escalation-writeback";
import { ensureEscalationCommentHasConsultantPacket } from "./github/escalation-consultant-writeback";
import {
  buildParentVerificationPrompt as buildParentVerificationPromptLegacy,
  evaluateParentVerificationEligibility,
  parseParentVerificationOutput,
} from "./parent-verification/core";
import { collectParentVerificationEvidence } from "./parent-verification/io";
import { writeParentVerificationToGitHub } from "./github/parent-verification-writeback";
import {
  buildCiDebugCommentBody,
  createCiDebugComment,
  findCiDebugComment,
  parseCiDebugState,
  updateCiDebugComment,
  type CiDebugAttempt,
  type CiDebugCommentState,
  type CiTriageCommentState,
} from "./github/ci-debug-comment";
import { buildCiTriageDecision, type CiFailureClassification, type CiNextAction, type CiTriageDecision } from "./ci-triage/core";
import { buildCiFailureSignatureV2, type CiFailureSignatureV2 } from "./ci-triage/signature";
import {
  buildMergeConflictCommentBody,
  createMergeConflictComment,
  findMergeConflictComment,
  parseMergeConflictState,
  updateMergeConflictComment,
  type MergeConflictAttempt,
  type MergeConflictCommentState,
} from "./github/merge-conflict-comment";
import {
  buildMergeConflictCommentLines,
  buildMergeConflictEscalationDetails,
  buildMergeConflictSignature,
  computeMergeConflictDecision,
  formatMergeConflictPaths,
} from "./merge-conflict-recovery";
import { buildWatchdogDiagnostics, writeWatchdogToGitHub } from "./github/watchdog-writeback";
import { buildLoopTripDetails } from "./loop-detection/format";
import { BLOCKED_SOURCES, type BlockedSource } from "./blocked-sources";
import { computeBlockedDecision, type RelationshipSignal } from "./github/issue-blocking-core";
import { formatIssueRef, parseIssueRef, type IssueRef } from "./github/issue-ref";
import { DEFAULT_WATCHDOG_THRESHOLDS_MS } from "./watchdog";
import {
  GitHubRelationshipProvider,
  type IssueRelationshipProvider,
  type IssueRelationshipSnapshot,
} from "./github/issue-relationships";
import { getRalphRunLogPath, getRalphSessionDir, getRalphWorktreesDir, getSessionEventsPath } from "./paths";
import { ralphEventBus } from "./dashboard/bus";
import { isRalphCheckpoint, type RalphCheckpoint, type RalphEvent } from "./dashboard/events";
import { publishDashboardEvent, type DashboardEventContext } from "./dashboard/publisher";
import { cleanupSessionArtifacts } from "./introspection-traces";
import { isIntrospectionSummary, type IntrospectionSummary } from "./introspection/summary";
import { createRunRecordingSessionAdapter, type SessionAdapter } from "./run-recording-session-adapter";
import { redactHomePathForDisplay } from "./redaction";
import { isSafeSessionId } from "./session-id";
import { buildDashboardContext, resolveDashboardContext } from "./worker/dashboard-context";
import {
  completeParentVerification,
  completeRalphRun,
  createRalphRun,
  ensureRalphRunGateRows,
  getParentVerificationState,
  getIssueLabels,
  getLatestRunIdForSession,
  getRalphRunTokenTotals,
  getIdempotencyRecord,
  getIdempotencyPayload,
  isStateDbInitialized,
  listRalphRunSessionTokenTotals,
  recordIdempotencyKey,
  deleteIdempotencyKey,
  recordParentVerificationAttemptFailure,
  recordRalphRunGateArtifact,
  upsertIdempotencyKey,
  recordIssueSnapshot,
  recordPrSnapshot,
  recordIssueLabelsSnapshot,
  listOpenPrCandidatesForIssue,
  PR_STATE_MERGED,
  PR_STATE_OPEN,
  type PrState,
  type RalphRunAttemptKind,
  type RalphRunDetails,
  tryClaimParentVerification,
  setParentVerificationPending,
  upsertRalphRunGateResult,
} from "./state";
import {
  getParentVerificationBackoffMs,
  getParentVerificationMaxAttempts,
  isParentVerificationDisabled,
  parseParentVerificationMarker,
  PARENT_VERIFY_MARKER_PREFIX,
  PARENT_VERIFY_MARKER_VERSION,
} from "./parent-verification";
import { parseLastLineJsonMarker } from "./markers";
import { refreshRalphRunTokenTotals } from "./run-token-accounting";
import { computeAndStoreRunMetrics } from "./metrics/compute-and-store";
import { selectCanonicalPr, type ResolvedPrCandidate } from "./pr-resolution";
import {
  detectLegacyWorktrees,
  isPathUnderDir,
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "./git-worktree";
import { formatLegacyWorktreeWarning } from "./legacy-worktrees";
import {
  normalizePrUrl,
  searchOpenPullRequestsByIssueLink,
  viewPullRequest,
  viewPullRequestMergeCandidate,
  type PullRequestSearchResult,
} from "./github/pr";
import {
  REQUIRED_CHECKS_DEFER_LOG_INTERVAL_MS,
  REQUIRED_CHECKS_DEFER_RETRY_MS,
  REQUIRED_CHECKS_JITTER_PCT,
  REQUIRED_CHECKS_LOG_INTERVAL_MS,
  REQUIRED_CHECKS_MAX_POLL_MS,
  applyRequiredChecksJitter,
  areStringArraysEqual,
  buildRequiredChecksSignature,
  computeRequiredChecksDelay,
  decideBranchProtection,
  extractPullRequestNumber,
  formatRequiredChecksForHumans,
  formatRequiredChecksGuidance,
  hasBypassAllowances,
  isCiOnlyChangeSet,
  isCiRelatedIssue,
  isMainMergeAllowed,
  isMainMergeOverride,
  normalizeEnabledFlag,
  normalizeRequiredCheckState,
  normalizeRestrictions,
  summarizeRequiredChecks,
  toSortedUniqueStrings,
  type BranchProtectionDecision,
  type CheckLogResult,
  type CheckRunsResponse,
  type CommitStatusResponse,
  type FailedCheck,
  type FailedCheckLog,
  type GitRef,
  type PrCheck,
  type PullRequestDetails,
  type PullRequestDetailsNormalized,
  type RepoDetails,
  type RequiredCheckState,
  type RequiredChecksGuidanceInput,
  type RequiredChecksSummary,
  type RestrictionList,
  type RemediationFailureContext,
} from "./worker/lanes/required-checks";
import { pauseIfGitHubRateLimited, pauseIfHardThrottled } from "./worker/lanes/pause";
import type { ThrottleAdapter } from "./worker/ports";

function prBodyClosesIssue(body: string, issueNumber: string): boolean {
  const normalized = body.replace(/\r\n/g, "\n");
  const re = new RegExp(`(^|\\n)\\s*(fixes|closes|resolves)\\s+#${issueNumber}\\b`, "i");
  return re.test(normalized);
}

export function __prBodyClosesIssueForTests(body: string, issueNumber: string): boolean {
  return prBodyClosesIssue(body, issueNumber);
}

const ghRead = (repo: string) => createGhRunner({ repo, mode: "read" });
const ghWrite = (repo: string) => createGhRunner({ repo, mode: "write" });

const PR_CREATE_LEASE_TTL_MS = 20 * 60_000;
const PR_CREATE_CONFLICT_WAIT_MS = 2 * 60_000;
const PR_CREATE_CONFLICT_POLL_MS = 15_000;
const PR_CREATE_CONFLICT_THROTTLE_MS = 5 * 60_000;

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

type MergeConflictRecoveryOutcome =
  | { status: "success"; prUrl: string; sessionId: string; headSha: string }
  | { status: "failed" | "escalated"; run: AgentRun };

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

type CiFailureTriageOutcome =
  | {
      status: "success";
      prUrl: string;
      sessionId: string;
      headSha: string;
      summary: RequiredChecksSummary;
    }
  | {
      status: "failed" | "escalated" | "throttled";
      run: AgentRun;
    };

type CiTriageRecord = {
  version: 1;
  signatureVersion: 2;
  signature: string;
  classification: CiFailureClassification;
  classificationReason: string;
  action: CiNextAction;
  actionReason: string;
  timedOut: boolean;
  attempt: number;
  maxAttempts: number;
  priorSignature: string | null;
  failingChecks: Array<{ name: string; rawState: string; detailsUrl?: string | null }>;
  commands: string[];
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
const LEGACY_WORKTREES_LOG_INTERVAL_MS = 12 * 60 * 60 * 1000;
const BLOCKED_REASON_MAX_LEN = 200;
const BLOCKED_DETAILS_MAX_LEN = 2000;
const CI_DEBUG_LEASE_TTL_MS = 20 * 60_000;
const CI_DEBUG_COMMENT_SCAN_LIMIT = 100;
const CI_DEBUG_COMMENT_MIN_EDIT_MS = 60_000;
const MERGE_CONFLICT_LEASE_TTL_MS = 20 * 60_000;
const MERGE_CONFLICT_COMMENT_SCAN_LIMIT = 50;
const MERGE_CONFLICT_COMMENT_MIN_EDIT_MS = 60_000;
const MERGE_CONFLICT_WAIT_TIMEOUT_MS = 10 * 60_000;
const MERGE_CONFLICT_WAIT_POLL_MS = 15_000;

const CI_REMEDIATION_BACKOFF_BASE_MS = 30_000;
const CI_REMEDIATION_BACKOFF_MAX_MS = 120_000;

const CHECKPOINT_SEQ_FIELD = "checkpoint-seq";
const PAUSE_REQUESTED_FIELD = "pause-requested";
const PAUSED_AT_CHECKPOINT_FIELD = "paused-at-checkpoint";
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
    const parsed = JSON.parse(content);
    return isIntrospectionSummary(parsed) ? parsed : null;
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
  completionKind?: "pr" | "verified";
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

  if (result.completionKind) {
    details.completionKind = result.completionKind;
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

function summarizeBlockedDetails(text: string): string {
  const trimmed = sanitizeDiagnosticsText(text).trim();
  if (!trimmed) return "";
  if (trimmed.length <= BLOCKED_DETAILS_MAX_LEN) return trimmed;
  return trimmed.slice(0, BLOCKED_DETAILS_MAX_LEN).trimEnd() + "…";
}

function buildBlockedSignature(source?: string, reason?: string): string {
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

  // NOTE: GitHub-backed tasks do not currently persist blocked-* metadata in durable op-state.
  // That means we can repeatedly rebuild AgentTask objects that have status=blocked but empty
  // blocked-source/reason fields. Treating that as a "signature change" causes noisy re-entry
  // notifications (blocked-deps spam) even though nothing changed.
  const priorBlockedSource = typeof task["blocked-source"] === "string" ? task["blocked-source"].trim() : "";
  const priorBlockedReason = typeof task["blocked-reason"] === "string" ? task["blocked-reason"].trim() : "";
  const hasPriorBlockedSignature = Boolean(priorBlockedSource || priorBlockedReason);

  const previousSignature = buildBlockedSignature(priorBlockedSource, priorBlockedReason);
  const nextSignature = buildBlockedSignature(opts.source, reasonSummary);
  const didChangeSignature = previousSignature !== nextSignature;

  const didEnterBlocked =
    task.status !== "blocked" ? true : (hasPriorBlockedSignature ? didChangeSignature : false);

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

function parseCheckpointSeq(value?: string): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function parsePauseRequested(value?: string): boolean {
  return value?.trim().toLowerCase() === "true";
}

function parseCheckpointValue(value?: string): RalphCheckpoint | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return isRalphCheckpoint(trimmed) ? (trimmed as RalphCheckpoint) : null;
}

function buildCheckpointPatch(state: CheckpointState): Record<string, string> {
  return {
    checkpoint: state.lastCheckpoint ?? "",
    [CHECKPOINT_SEQ_FIELD]: String(state.checkpointSeq),
    [PAUSE_REQUESTED_FIELD]: state.pauseRequested ? "true" : "false",
    [PAUSED_AT_CHECKPOINT_FIELD]: state.pausedAtCheckpoint ?? "",
  };
}

class CheckpointEventDeduper {
  #seen = new Set<string>();
  #order: string[] = [];
  #limit: number;

  constructor(limit = 5000) {
    this.#limit = Math.max(0, Math.floor(limit));
  }

  hasEmitted(key: string): boolean {
    return this.#seen.has(key);
  }

  emit(event: RalphEvent, key: string): void {
    if (this.#seen.has(key)) return;
    ralphEventBus.publish(event);
    if (this.#limit === 0) return;
    this.#seen.add(key);
    this.#order.push(key);
    if (this.#order.length > this.#limit) {
      const oldest = this.#order.shift();
      if (oldest) this.#seen.delete(oldest);
    }
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
export {
  __TEST_ONLY_DEFAULT_BRANCH,
  __TEST_ONLY_DEFAULT_SHA,
  __buildCheckRunsResponse,
  __buildGitRefResponse,
  __buildRepoDefaultBranchResponse,
  __computeRequiredChecksDelayForTests,
  __decideBranchProtectionForTests,
  __formatRequiredChecksGuidanceForTests,
  __isCiOnlyChangeSetForTests,
  __isCiRelatedIssueForTests,
  __summarizeRequiredChecksForTests,
} from "./worker/lanes/required-checks";
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
  private ensureBranchProtectionDeferUntil = 0;
  private requiredChecksForMergePromise: Promise<ResolvedRequiredChecks> | null = null;
  private relationships: IssueRelationshipProvider;
  private relationshipCache = new Map<string, { ts: number; snapshot: IssueRelationshipSnapshot }>();
  private relationshipInFlight = new Map<string, Promise<IssueRelationshipSnapshot | null>>();
  private lastBlockedSyncAt = 0;
  private requiredChecksLogLimiter = new LogLimiter({ maxKeys: 2000 });
  private legacyWorktreesLogLimiter = new LogLimiter({ maxKeys: 2000 });
  private prResolutionCache = new Map<string, Promise<ResolvedIssuePr>>();
  private checkpointEvents = new CheckpointEventDeduper();
  private activeRunId: string | null = null;
  private activeDashboardContext: DashboardEventContext | null = null;

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
        "stall-retries": "",
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

  private buildDashboardContext(task: AgentTask, runId?: string | null): DashboardEventContext {
    return buildDashboardContext({ task, repo: this.repo, runId });
  }

  private withDashboardContext<T>(context: DashboardEventContext, run: () => Promise<T>): Promise<T> {
    const prev = this.activeDashboardContext;
    this.activeDashboardContext = context;
    return Promise.resolve(run()).finally(() => {
      this.activeDashboardContext = prev;
    });
  }

  private publishDashboardEvent(
    event: Omit<RalphEvent, "ts"> & { ts?: string },
    overrides?: Partial<DashboardEventContext>
  ): void {
    const context = resolveDashboardContext(this.activeDashboardContext, overrides);
    publishDashboardEvent(event, context);
  }

  private publishCheckpoint(checkpoint: RalphCheckpoint, overrides?: Partial<DashboardEventContext>): void {
    this.publishDashboardEvent(
      {
        type: "worker.checkpoint.reached",
        level: "info",
        data: { checkpoint },
      },
      overrides
    );
  }

  private logWorker(message: string, overrides?: Partial<DashboardEventContext>): void {
    console.log(`[ralph:worker:${this.repo}] ${message}`);
    this.publishDashboardEvent(
      {
        type: "log.worker",
        level: "info",
        data: { message },
      },
      overrides
    );
  }

  private async withRunContext(
    task: AgentTask,
    attemptKind: RalphRunAttemptKind,
    run: () => Promise<AgentRun>
  ): Promise<AgentRun> {
    let runId: string | null = null;
    const previousRunId = this.activeRunId;

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

    this.activeRunId = runId;
    try {
      ensureRalphRunGateRows({ runId });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to initialize gate rows for ${task.name}: ${error?.message ?? String(error)}`
      );
    }

    const recordingBase = createRunRecordingSessionAdapter({
      base: this.baseSession,
      runId,
      repo: this.repo,
      issue: task.issue,
    });
    const recordingSession = this.createContextRecoveryAdapter(recordingBase);

    let result: AgentRun | null = null;
    const context = this.buildDashboardContext(task, runId);

    try {
      result = await this.withDashboardContext(context, async () => {
        this.publishDashboardEvent({
          type: "worker.became_busy",
          level: "info",
          data: { taskName: task.name, issue: task.issue },
        });
        return await this.withSessionAdapters({ baseSession: recordingBase, session: recordingSession }, run);
      });
      return result;
    } finally {
      this.publishDashboardEvent({
        type: "worker.became_idle",
        level: "info",
        data: { reason: result?.outcome },
      });

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

      // Best-effort: persist token totals + append to the latest run log.
      try {
        const opencodeProfile = this.getPinnedOpencodeProfileName(task);
        await refreshRalphRunTokenTotals({ runId, opencodeProfile });
        const totals = getRalphRunTokenTotals(runId);
        const runLogPath = task["run-log-path"]?.trim() || "";
        if (totals && runLogPath && existsSync(runLogPath)) {
          const totalLabel = totals.tokensComplete && typeof totals.tokensTotal === "number" ? totals.tokensTotal : "?";
          const perSession = listRalphRunSessionTokenTotals(runId);
          const missingCount = perSession.filter((s) => s.quality !== "ok").length;
          const suffix = missingCount > 0 ? ` missingSessions=${missingCount}` : "";

          await appendFile(
            runLogPath,
            "\n" +
              [
                "-----",
                `Token usage: total=${totalLabel} complete=${totals.tokensComplete ? "true" : "false"} sessions=${totals.sessionCount}${suffix}`,
              ].join("\n") +
              "\n",
            "utf8"
          );
        }
      } catch {
        // best-effort token accounting
      }

      try {
        await computeAndStoreRunMetrics({ runId });
      } catch {
        // best-effort metrics persistence
      }

      this.activeRunId = previousRunId;
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

  private async escalateParentVerificationFailure(task: AgentTask, reason: string, sessionId?: string): Promise<AgentRun> {
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
        const dashboardOptions = this.withDashboardSessionOptions(options);
        const result = await base.runAgent(repoPath, agent, message, dashboardOptions, testOverrides);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId: result.sessionId,
          stepKey: options?.introspection?.stepTitle ?? `agent:${agent}`,
          result,
          options: dashboardOptions,
        });
      },
      continueSession: async (repoPath, sessionId, message, options) => {
        const dashboardOptions = this.withDashboardSessionOptions(options, { sessionId });
        const result = await base.continueSession(repoPath, sessionId, message, dashboardOptions);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId,
          stepKey: options?.introspection?.stepTitle ?? `session:${sessionId}`,
          result,
          options: dashboardOptions,
        });
      },
      continueCommand: async (repoPath, sessionId, command, args, options) => {
        const dashboardOptions = this.withDashboardSessionOptions(options, { sessionId });
        const result = await base.continueCommand(repoPath, sessionId, command, args, dashboardOptions);
        return this.maybeRecoverFromContextLengthExceeded({
          repoPath,
          sessionId,
          stepKey: options?.introspection?.stepTitle ?? `command:${command}`,
          result,
          options: dashboardOptions,
          command,
        });
      },
      getRalphXdgCacheHome: base.getRalphXdgCacheHome,
    };
  }

  private withDashboardSessionOptions(
    options?: RunSessionOptionsBase,
    overrides?: Partial<DashboardEventContext>
  ): RunSessionOptionsBase | undefined {
    const context = this.activeDashboardContext ? { ...this.activeDashboardContext, ...overrides } : overrides;
    if (!context) return options;

    const existingOnEvent = options?.onEvent;
    const onEvent = (event: any) => {
      if (!event) return;
      const eventSessionId = event.sessionID ?? event.sessionId;
      const sessionId = typeof eventSessionId === "string" ? eventSessionId : context.sessionId;

      this.publishDashboardEvent(
        {
          type: "log.opencode.event",
          level: "info",
          repo: context.repo,
          taskId: context.taskId,
          workerId: context.workerId,
          sessionId,
          data: { event },
        },
        { ...context, sessionId }
      );

      if (event.type === "text" && event.part?.text) {
        this.publishDashboardEvent(
          {
            type: "log.opencode.text",
            level: "info",
            repo: context.repo,
            taskId: context.taskId,
            workerId: context.workerId,
            sessionId,
            data: { text: String(event.part.text) },
          },
          { ...context, sessionId }
        );
      }

      existingOnEvent?.(event);
    };

    return { ...(options ?? {}), onEvent };
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
        this.publishDashboardEvent(
          {
            type: "worker.context_compact.triggered",
            level: "info",
            repo: this.repo,
            taskId: context.task._path,
            sessionId: event.sessionId,
            data: {
              stepTitle: event.stepKey,
              attempt: event.attempt,
            },
          },
          { sessionId: event.sessionId }
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
        "stall-retries": "",
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
    const { patch, didEnterBlocked, reasonSummary, detailsSummary } = computeBlockedPatch(task, {
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
    const priorWorktreePath = task["worktree-path"]?.trim() || "";
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

    if (updated && didEnterBlocked && source !== "allowlist") {
      const kind: WorkerFailureKind = source === "runtime-error" ? "runtime-error" : "blocked";
      const reason = reasonSummary || `Blocked: ${source}`;
      await this.notifyTaskFailure(task, {
        kind,
        stage: `blocked:${source}`,
        reason,
        details: detailsSummary || undefined,
        sessionId: opts?.sessionId,
        runLogPath: opts?.runLogPath,
        worktreePath: priorWorktreePath || undefined,
      });
    }

    return updated;
  }

  private buildFailurePointers(
    task: AgentTask,
    overrides?: { sessionId?: string; runLogPath?: string; worktreePath?: string }
  ) {
    return {
      sessionId: overrides?.sessionId ?? task["session-id"]?.trim() ?? null,
      worktreePath: overrides?.worktreePath ?? task["worktree-path"]?.trim() ?? null,
      runLogPath: overrides?.runLogPath ?? task["run-log-path"]?.trim() ?? null,
      workerId: task["worker-id"]?.trim() ?? null,
      repoSlot: task["repo-slot"]?.trim() ?? null,
    };
  }

  private async notifyTaskFailure(
    task: AgentTask,
    params: {
      kind: WorkerFailureKind;
      stage: string;
      reason: string;
      details?: string;
      sessionId?: string;
      runLogPath?: string;
      worktreePath?: string;
    }
  ): Promise<void> {
    const alert = buildWorkerFailureAlert({
      kind: params.kind,
      stage: params.stage,
      reason: params.reason,
      details: params.details,
      pointers: this.buildFailurePointers(task, {
        sessionId: params.sessionId,
        runLogPath: params.runLogPath,
        worktreePath: params.worktreePath,
      }),
    });

    await this.notify.notifyError(`${params.stage} ${task.name}`, params.details ?? params.reason, {
      taskName: task.name,
      repo: task.repo,
      issue: task.issue,
      alertOverride: {
        fingerprintSeed: alert.fingerprintSeed,
        summary: alert.summary,
        details: alert.details ?? undefined,
      },
    });
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
      if (result.kind === "transient") {
        console.warn(
          `[ralph:worker:${this.repo}] GitHub label write skipped (transient): ${String(result.error)}`
        );
        return;
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }

    if (result.add.length > 0 || result.remove.length > 0) {
      this.recordIssueLabelDelta(issue, { add: result.add, remove: result.remove });
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
      if (result.kind === "transient") {
        console.warn(
          `[ralph:worker:${this.repo}] GitHub label write skipped (transient): ${String(result.error)}`
        );
        return;
      }
      throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }

    if (result.add.length > 0 || result.remove.length > 0) {
      this.recordIssueLabelDelta(issue, { add: result.add, remove: result.remove });
    }
  }

  private recordIssueLabelDelta(issue: IssueRef, delta: { add: string[]; remove: string[] }): void {
    try {
      const nowIso = new Date().toISOString();
      const current = getIssueLabels(issue.repo, issue.number);
      const set = new Set(current);
      for (const label of delta.remove) set.delete(label);
      for (const label of delta.add) set.add(label);
      recordIssueLabelsSnapshot({ repo: issue.repo, issue: `${issue.repo}#${issue.number}`, labels: Array.from(set), at: nowIso });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to record label snapshot for ${formatIssueRef(issue)}: ${error?.message ?? String(error)}`
      );
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

  private buildPrCreateLeaseKey(issueNumber: string, botBranch: string): string {
    return buildPrCreateLeaseKey({ repo: this.repo, issueNumber, baseBranch: botBranch });
  }

  private tryClaimPrCreateLease(params: {
    task: AgentTask;
    issueNumber: string;
    botBranch: string;
    sessionId?: string | null;
    stage: string;
  }): { key: string; claimed: boolean; staleDeleted: boolean; existingCreatedAt: string | null } {
    const key = this.buildPrCreateLeaseKey(params.issueNumber, params.botBranch);
    const nowMs = Date.now();
    const existing = getIdempotencyRecord(key);
    const existingCreatedAt = existing?.createdAt ?? null;
    let staleDeleted = false;

    if (
      existing &&
      isLeaseStale({
        createdAtIso: existing.createdAt,
        nowMs,
        ttlMs: PR_CREATE_LEASE_TTL_MS,
      })
    ) {
      try {
        deleteIdempotencyKey(key);
        staleDeleted = true;
      } catch {
        // ignore
      }
    }

    const payloadJson = JSON.stringify({
      repo: this.repo,
      issue: `${this.repo}#${params.issueNumber}`,
      base: normalizeGitRef(params.botBranch),
      stage: params.stage,
      workerId: params.task["worker-id"]?.trim() ?? "",
      daemonId: params.task["daemon-id"]?.trim() ?? "",
      sessionId: params.sessionId?.trim() ?? "",
      claimedAt: new Date(nowMs).toISOString(),
    });

    const claimed = recordIdempotencyKey({ key, scope: PR_CREATE_LEASE_SCOPE, payloadJson });
    return { key, claimed, staleDeleted, existingCreatedAt };
  }

  private async waitForExistingPrDuringPrCreateConflict(params: {
    issueNumber: string;
    maxWaitMs: number;
  }): Promise<ResolvedIssuePr | null> {
    const deadline = Date.now() + Math.max(0, Math.floor(params.maxWaitMs));
    while (Date.now() < deadline) {
      const resolved = await this.getIssuePrResolution(params.issueNumber);
      if (resolved.selectedUrl) return resolved;
      await this.sleepMs(PR_CREATE_CONFLICT_POLL_MS);
    }
    return null;
  }

  private async throttleForPrCreateConflict(params: {
    task: AgentTask;
    issueNumber: string;
    sessionId?: string | null;
    leaseKey: string;
    existingCreatedAt?: string | null;
    stage: string;
  }): Promise<AgentRun | null> {
    const sid = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";
    const enteringThrottled = params.task.status !== "throttled";
    const throttledAt = new Date().toISOString();
    const resumeAt = new Date(Date.now() + PR_CREATE_CONFLICT_THROTTLE_MS).toISOString();

    this.publishDashboardEvent(
      {
        type: "worker.pause.requested",
        level: "warn",
        data: { reason: `pr-create-conflict:${params.stage}` },
      },
      { sessionId: sid || undefined }
    );

    const details = JSON.stringify({
      reason: "pr-create-lease-conflict",
      leaseKey: params.leaseKey,
      existingCreatedAt: params.existingCreatedAt ?? null,
      stage: params.stage,
      waitMs: PR_CREATE_CONFLICT_WAIT_MS,
      ttlMs: PR_CREATE_LEASE_TTL_MS,
    });

    const extraFields: Record<string, string> = {
      "throttled-at": throttledAt,
      "resume-at": resumeAt,
      "usage-snapshot": details,
    };
    if (sid) extraFields["session-id"] = sid;

    const updated = await this.queue.updateTaskStatus(params.task, "throttled", extraFields);
    if (!updated) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to throttle task after PR-create conflict (lease=${params.leaseKey}, issue=${this.repo}#${params.issueNumber})`
      );
      return null;
    }

    applyTaskPatch(params.task, "throttled", extraFields);

    if (enteringThrottled) {
      const runTime = new Date();
      const bodyPrefix = buildAgentRunBodyPrefix({
        task: params.task,
        headline: `Throttled: PR creation conflict (${params.stage})`,
        reason: `Resume at: ${resumeAt}`,
        details,
        sessionId: sid || undefined,
        runLogPath: params.task["run-log-path"]?.trim() || undefined,
      });

      await this.createAgentRun(params.task, {
        outcome: "throttled",
        sessionId: sid || undefined,
        started: runTime,
        completed: runTime,
        bodyPrefix,
      });
    }

    console.warn(
      `[ralph:worker:${this.repo}] PR-create lease conflict; throttling (lease=${params.leaseKey}, resumeAt=${resumeAt})`
    );

    this.publishDashboardEvent(
      {
        type: "worker.pause.reached",
        level: "warn",
        data: {},
      },
      { sessionId: sid || undefined }
    );

    return {
      taskName: params.task.name,
      repo: this.repo,
      outcome: "throttled",
      sessionId: sid || undefined,
    };
  }

  private async throttleForCiQuarantine(params: {
    task: AgentTask;
    sessionId?: string | null;
    resumeAt: string;
    reason: string;
    details: string;
  }): Promise<AgentRun> {
    const sid = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";
    const enteringThrottled = params.task.status !== "throttled";
    const throttledAt = new Date().toISOString();

    const extraFields: Record<string, string> = {
      "throttled-at": throttledAt,
      "resume-at": params.resumeAt,
      "usage-snapshot": params.details,
    };
    if (sid) extraFields["session-id"] = sid;

    const updated = await this.queue.updateTaskStatus(params.task, "throttled", extraFields);
    if (!updated) {
      console.warn(`[ralph:worker:${this.repo}] Failed to throttle task for CI quarantine (${params.reason})`);
      return {
        taskName: params.task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: sid || undefined,
        escalationReason: params.reason,
      };
    }

    applyTaskPatch(params.task, "throttled", extraFields);

    if (enteringThrottled) {
      const bodyPrefix = buildAgentRunBodyPrefix({
        task: params.task,
        headline: "Throttled: CI quarantine",
        reason: `Resume at: ${params.resumeAt}`,
        details: params.details,
        sessionId: sid || undefined,
        runLogPath: params.task["run-log-path"]?.trim() || undefined,
      });
      const runTime = new Date();
      await this.createAgentRun(params.task, {
        outcome: "throttled",
        sessionId: sid || undefined,
        started: runTime,
        completed: runTime,
        bodyPrefix,
      });
    }

    console.warn(`[ralph:worker:${this.repo}] CI quarantine; throttling until ${params.resumeAt}`);

    return {
      taskName: params.task.name,
      repo: this.repo,
      outcome: "throttled",
      sessionId: sid || undefined,
    };
  }

  private async markIssueInProgressForOpenPrBestEffort(task: AgentTask, prUrl: string): Promise<void> {
    const issueRef = parseIssueRef(task.issue, this.repo);
    if (!issueRef) return;
    try {
      await this.addIssueLabel(issueRef, RALPH_LABEL_STATUS_IN_PROGRESS);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to apply ${RALPH_LABEL_STATUS_IN_PROGRESS} for open PR ${prUrl}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  /**
   * Reconciliation lane: if a queued issue already has a Ralph-authored PR that is mergeable,
   * merge it and apply midpoint labels. This avoids "orphan" PRs when the daemon restarts
   * between PR creation and merge.
   */
  public async tryReconcileMergeablePrForQueuedTask(task: AgentTask): Promise<
    | { handled: false }
    | { handled: true; merged: true; prUrl: string }
    | { handled: true; merged: false; reason: string }
  > {
    const issueMatch = task.issue.match(/^([^#]+)#(\d+)$/);
    if (!issueMatch) return { handled: false };
    const issueNumber = issueMatch[2];
    if (!issueNumber) return { handled: false };

    const botBranch = getRepoBotBranch(this.repo);

    const resolved = await this.getIssuePrResolution(issueNumber);
    const prUrl = resolved.selectedUrl;
    if (!prUrl) return { handled: false };

    let pr: Awaited<ReturnType<typeof viewPullRequestMergeCandidate>> | null = null;
    try {
      pr = await viewPullRequestMergeCandidate(this.repo, prUrl);
    } catch {
      return { handled: false };
    }
    if (!pr) return { handled: false };

    const prState = String(pr.state ?? "").toUpperCase();
    if (prState !== "OPEN") return { handled: false };
    if (pr.isDraft) return { handled: false };

    const baseBranch = pr.baseRefName ? this.normalizeGitRef(pr.baseRefName) : "";
    const normalizedBot = this.normalizeGitRef(botBranch);
    if (!baseBranch || baseBranch !== normalizedBot) return { handled: false };

    const mergeable = String(pr.mergeable ?? "").toUpperCase();
    if (mergeable !== "MERGEABLE") return { handled: false };

    const mergeStateStatus = normalizeMergeStateStatus(pr.mergeStateStatus);
    if (mergeStateStatus === "DIRTY" || mergeStateStatus === "DRAFT") return { handled: false };

    const body = pr.body ?? "";
    if (!body || !prBodyClosesIssue(body, issueNumber)) return { handled: false };

    let appSlug: string | null = null;
    try {
      appSlug = await getConfiguredGitHubAppSlug();
    } catch {
      appSlug = null;
    }

    const expectedAuthor = appSlug ? `app/${appSlug}` : null;
    if (!expectedAuthor) return { handled: false };
    if (!pr.authorIsBot || pr.authorLogin !== expectedAuthor) return { handled: false };

    const issueMeta = await this.getIssueMetadata(task.issue);
    const cacheKey = `reconcile-merge-${issueNumber}`;
    const sessionId = task["session-id"]?.trim() ?? "";
    const notifyTitle = `${this.repo}#${issueNumber} reconcile merge`;

    const merged = await this.mergePrWithRequiredChecks({
      task,
      repoPath: this.repoPath,
      cacheKey,
      botBranch,
      prUrl,
      sessionId,
      issueMeta,
      watchdogStagePrefix: "reconcile-merge",
      notifyTitle,
    });

    if (!merged.ok) {
      return { handled: true, merged: false, reason: merged.run.escalationReason ?? "Merge failed" };
    }

    const completedAt = new Date().toISOString().split("T")[0];
    await this.queue.updateTaskStatus(task, "done", {
      "completed-at": completedAt,
      "session-id": "",
      "worktree-path": "",
      "worker-id": "",
      "repo-slot": "",
      "daemon-id": "",
      "heartbeat-at": "",
      "watchdog-retries": "",
      "blocked-source": "",
      "blocked-reason": "",
      "blocked-details": "",
      "blocked-at": "",
      "blocked-checked-at": "",
    });

    return { handled: true, merged: true, prUrl: merged.prUrl };
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
      notifyError: async (title, body, context) =>
        this.notify.notifyError(title, body, {
          taskName: context?.taskName ?? params.task.name,
          repo: context?.repo ?? params.task.repo,
          issue: context?.issue ?? params.task.issue,
        }),
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
      const commentUrl = result.commentUrl ?? null;

      if (commentUrl) {
        try {
          const repoPath = task["worktree-path"]?.trim() || this.repoPath;
          await ensureEscalationCommentHasConsultantPacket({
            github: this.github,
            repo: escalationIssueRef.repo,
            escalationCommentUrl: commentUrl,
            repoPath,
            input: {
              issue: task.issue,
              repo: escalationIssueRef.repo,
              taskName: task.name,
              taskPath: task._path ?? task.name,
              escalationType: params.escalationType,
              reason: params.reason,
              sessionId: task["session-id"]?.trim() || null,
              githubCommentUrl: commentUrl,
            },
            log: (m) => console.log(m),
          });
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Failed to attach consultant packet to escalation comment: ${
              error?.message ?? String(error)
            }`
          );
        }
      }

      return commentUrl;
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
      const fallbackBranch = await this.resolveFallbackBranch(botBranch);
      return resolveRequiredChecks({
        override,
        primaryBranch: botBranch,
        fallbackBranch,
        fetchBranchProtection: (branch) => this.fetchBranchProtection(branch),
        logger: {
          warn: (message) => console.warn(`[ralph:worker:${this.repo}] ${message}`),
          info: (message) => console.log(`[ralph:worker:${this.repo}] ${message}`),
        },
      });
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

  private async ensureBranchProtectionForBranch(branch: string, requiredChecks: string[]): Promise<"ok" | "defer"> {
    if (requiredChecks.length === 0) return "ok";

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

    const decision = decideBranchProtection({ requiredChecks, availableChecks });
    if (decision.kind !== "ok") {
      const guidance = formatRequiredChecksGuidance({
        repo: this.repo,
        branch,
        requiredChecks,
        missingChecks: decision.missingChecks,
        availableChecks,
      });
      if (decision.kind === "defer") {
        const logKey = `branch-protection-defer:${this.repo}:${branch}:${decision.missingChecks.join(",") || "none"}::${availableChecks.join(",") || "none"}`;
        if (this.requiredChecksLogLimiter.shouldLog(logKey, REQUIRED_CHECKS_DEFER_LOG_INTERVAL_MS)) {
          console.warn(
            `[ralph:worker:${this.repo}] RALPH_BRANCH_PROTECTION_SKIPPED_MISSING_CHECKS ` +
              `Required checks missing for ${this.repo}@${branch} ` +
              `(required: ${requiredChecks.join(", ") || "(none)"}; ` +
              `missing: ${decision.missingChecks.join(", ") || "(none)"}). ` +
              `Proceeding without branch protection for now; will retry in ${formatDuration(
                REQUIRED_CHECKS_DEFER_RETRY_MS
              )}.
${guidance}`
          );
        }
        return "defer";
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

    return "ok";
  }

  private async ensureBranchProtectionOnce(): Promise<void> {
    if (this.ensureBranchProtectionPromise) return this.ensureBranchProtectionPromise;

    const now = Date.now();
    if (now < this.ensureBranchProtectionDeferUntil) return;

    this.ensureBranchProtectionPromise = (async () => {
      const botBranch = getRepoBotBranch(this.repo);
      const requiredChecksOverride = getRepoRequiredChecksOverride(this.repo);

      if (requiredChecksOverride === null || requiredChecksOverride.length === 0) {
        return;
      }

      const fallbackBranch = await this.resolveFallbackBranch(botBranch);
      const branches = Array.from(new Set([botBranch, fallbackBranch]));

      let deferred = false;

      for (const branch of branches) {
        const result = await this.ensureBranchProtectionForBranch(branch, requiredChecksOverride);
        if (result === "defer") deferred = true;
      }

      return deferred;
    })().then((deferred) => {
      if (deferred) {
        this.ensureBranchProtectionDeferUntil = Date.now() + REQUIRED_CHECKS_DEFER_RETRY_MS;
        this.ensureBranchProtectionPromise = null;
      }
    });

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
      const labelsKnown = isStateDbInitialized();
      const issueLabels = getIssueLabels(entry.issue.repo, entry.issue.number);
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

        const hasBlockedLabel = issueLabels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_BLOCKED);
        if (!labelsKnown || !hasBlockedLabel) {
          try {
            await this.addIssueLabel(entry.issue, RALPH_LABEL_STATUS_BLOCKED);
          } catch (error: any) {
            console.warn(
              `[ralph:worker:${this.repo}] Failed to add ${RALPH_LABEL_STATUS_BLOCKED} label: ${
                error?.message ?? String(error)
              }`
            );
          }
        }
        continue;
      }

      if (!decision.blocked && decision.confidence === "certain") {
        const labels = issueLabels;
        const shouldSetParentVerification =
          labels.length === 0
            ? true
            : labels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_QUEUED);
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
          } else {
            if (shouldSetParentVerification) {
              const didSet = setParentVerificationPending({
                repo: this.repo,
                issueNumber: entry.issue.number,
                nowMs: now,
              });
              if (didSet) {
                console.log(
                  `[ralph:worker:${this.repo}] Parent verification pending for ${formatIssueRef(entry.issue)}`
                );
              }
            }
          }
        }

        if (shouldRemoveBlockedLabel) {
          const hasBlockedLabel = issueLabels.some((label) => label.trim().toLowerCase() === RALPH_LABEL_STATUS_BLOCKED);
          if (!labelsKnown || hasBlockedLabel) {
            try {
              await this.removeIssueLabel(entry.issue, RALPH_LABEL_STATUS_BLOCKED);
            } catch (error: any) {
              console.warn(
                `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STATUS_BLOCKED} label: ${
                  error?.message ?? String(error)
                }`
              );
            }
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
    const resolved = resolveRelationshipSignals(snapshot);
    logRelationshipDiagnostics({ repo: this.repo, issue: snapshot.issue, diagnostics: resolved.diagnostics, area: "worker" });
    return resolved.signals;
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

  private buildParentVerificationWorktreePath(issueNumber: string): string {
    const repoKey = safeNoteName(this.repo);
    return join(RALPH_WORKTREES_DIR, repoKey, `parent-verify-${issueNumber}`);
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
        const resetPatch = this.buildQueuedResetPatch();
        let updated = await this.queue.updateTaskStatus(task, "queued", resetPatch);
        if (!updated) {
          await this.refreshIssueSnapshotBestEffort(task);
          updated = await this.queue.updateTaskStatus(task, "queued", resetPatch);
          if (!updated) {
            console.warn(
              `[ralph:worker:${this.repo}] Failed to reset task after stale worktree-path: ${recorded}`
            );
          }
        }
        await this.safeRemoveWorktree(recorded, { allowDiskCleanup: true });
        return { kind: "reset", reason: `${reason} (task reset to queued)` };
      }

      console.warn(`[ralph:worker:${this.repo}] ${reason} (recreating worktree)`);
      await this.safeRemoveWorktree(recorded, { allowDiskCleanup: true });
    }

    if (mode === "resume") {
      const reason = "Missing worktree-path for in-progress task";
      console.warn(`[ralph:worker:${this.repo}] ${reason} (resetting task for retry)`);
      const resetPatch = this.buildQueuedResetPatch();
      let updated = await this.queue.updateTaskStatus(task, "queued", resetPatch);
      if (!updated) {
        await this.refreshIssueSnapshotBestEffort(task);
        updated = await this.queue.updateTaskStatus(task, "queued", resetPatch);
        if (!updated) {
          console.warn(`[ralph:worker:${this.repo}] Failed to reset task after missing worktree-path`);
        }
      }
      return { kind: "reset", reason: `${reason} (task reset to queued)` };
    }

    const resolvedSlot = typeof repoSlot === "number" && Number.isFinite(repoSlot) ? repoSlot : 0;
    const taskKey = task._path || task._name || task.name;
    const worktreePath = buildWorktreePath({
      repo: this.repo,
      issueNumber,
      taskKey,
      repoSlot: resolvedSlot,
    });

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
      const prefetchTimeoutMs = Number.isFinite(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS))
        ? Math.max(0, Math.floor(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS)))
        : 1_500;
      const github = new GitHubClient(repo, { requestTimeoutMs: prefetchTimeoutMs });
      const raw = await github.getIssue(Number(number));
      const data = raw && typeof raw === "object" ? (raw as any) : {};
      const metadata: IssueMetadata = {
        labels: Array.isArray(data.labels) ? data.labels.map((l: any) => l?.name ?? "").filter(Boolean) : [],
        title: typeof data.title === "string" ? data.title : "",
        state: typeof data.state === "string" ? data.state : undefined,
        stateReason: typeof data.state_reason === "string" ? data.state_reason : undefined,
        closedAt: typeof data.closed_at === "string" ? data.closed_at : undefined,
        url: typeof data.html_url === "string" ? data.html_url : undefined,
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

  private async buildIssueContextForAgent(params: {
    repo: string;
    issueNumber: string | number;
  }): Promise<string> {
    const repo = params.repo.trim();
    const issueNumber = Number(String(params.issueNumber).trim());

    const prefetchTimeoutMs = Number.isFinite(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS))
      ? Math.max(0, Math.floor(Number(process.env.RALPH_ISSUE_CONTEXT_PREFETCH_TIMEOUT_MS)))
      : 1_500;

    if (process.env.BUN_TEST || process.env.NODE_ENV === "test") {
      return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context prefetch skipped in tests`;
    }

    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      return `Issue context (prefetched)\nRepo: ${repo}\nIssue: ${String(params.issueNumber).trim()}\n\nIssue context unavailable: invalid issue number`;
    }

    const truncate = (input: string, maxChars: number): string => {
      const trimmed = String(input ?? "").trimEnd();
      if (trimmed.length <= maxChars) return trimmed;
      return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
    };

    try {
      const github = new GitHubClient(repo, { requestTimeoutMs: prefetchTimeoutMs });
      const rawIssue = await github.getIssue(issueNumber);
      const issue = rawIssue && typeof rawIssue === "object" ? (rawIssue as any) : {};
      const rawComments = await github.listIssueComments(issueNumber, { maxPages: 3, perPage: 100 });
      const comments = Array.isArray(rawComments) ? rawComments : [];

      const title = typeof issue.title === "string" ? issue.title : "";
      const url = typeof issue.html_url === "string" ? issue.html_url : "";
      const state = typeof issue.state === "string" ? issue.state : "";
      const stateReason = typeof issue.state_reason === "string" ? issue.state_reason : "";
      const labels = Array.isArray(issue.labels)
        ? issue.labels.map((l: any) => String(l?.name ?? "").trim()).filter(Boolean)
        : [];
      const body = typeof issue.body === "string" ? issue.body : "";

      const parsedComments = comments
        .map((c: any) => ({
          author: typeof c?.user?.login === "string" ? c.user.login : "unknown",
          createdAt: typeof c?.created_at === "string" ? c.created_at : "",
          url: typeof c?.html_url === "string" ? c.html_url : "",
          body: typeof c?.body === "string" ? c.body : "",
        }))
        .filter((c: any) => c.body || c.createdAt || c.author)
        .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));

      const maxComments = 25;
      const recent = parsedComments.length > maxComments ? parsedComments.slice(-maxComments) : parsedComments;

      const headerLines = [
        "Issue context (prefetched)",
        `Repo: ${repo}`,
        `Issue: #${issueNumber}`,
        url ? `URL: ${url}` : null,
        title ? `Title: ${title}` : null,
        state ? `State: ${state}${stateReason ? ` (${stateReason})` : ""}` : null,
        `Labels: ${labels.length ? labels.join(", ") : "(none)"}`,
      ].filter(Boolean);

      const renderedBody = truncate(sanitizeEscalationReason(body), 12_000);

      const renderedComments = recent
        .map((c: any) => {
          const prefix = `- ${c.createdAt || ""} @${c.author}${c.url ? ` (${c.url})` : ""}`.trim();
          const text = truncate(sanitizeEscalationReason(c.body), 2_000);
          return [prefix, text ? text : "(empty)", ""].join("\n");
        })
        .join("\n");

      return [
        ...headerLines,
        "",
        "Body:",
        renderedBody || "(empty)",
        "",
        "Recent comments:",
        renderedComments || "(none)",
      ].join("\n");
    } catch (error: any) {
      if (error instanceof GitHubApiError) {
        const requestId = error.requestId ? ` requestId=${error.requestId}` : "";
        const resumeAt = error.resumeAtTs ? ` resumeAt=${new Date(error.resumeAtTs).toISOString()}` : "";
        return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context unavailable: ${error.code} HTTP ${error.status}${requestId}${resumeAt}\n${truncate(error.message, 800)}`;
      }
      return `Issue context (prefetched)\nRepo: ${repo}\nIssue: #${issueNumber}\n\nIssue context unavailable: ${truncate(error?.message ?? String(error), 800)}`;
    }
  }

  private async buildChildCompletionDossierText(params: { issueRef: IssueRef }): Promise<string | null> {
    if (process.env.BUN_TEST || process.env.NODE_ENV === "test") return null;

    try {
      const snapshot = await this.getRelationshipSnapshot(params.issueRef, true);
      if (!snapshot) return null;
      const signals = this.buildRelationshipSignals(snapshot);
      const result = await collectChildCompletionDossier({
        parent: params.issueRef,
        snapshot,
        signals,
      });

      if (result.diagnostics.length > 0) {
        console.log(
          `[ralph:worker:${this.repo}] Child dossier diagnostics for ${params.issueRef.repo}#${params.issueRef.number}:
            result.diagnostics.join("\n")
          }`
        );
      }

      return result.text ? result.text : null;
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to build child completion dossier: ${error?.message ?? String(error)}`
      );
      return null;
    }
  }

  private buildPrCreationNudge(botBranch: string, issueNumber: string, issueRef: string): string {
    const fixes = issueNumber ? `Fixes #${issueNumber}` : `Fixes ${issueRef}`;

    return [
      `No PR URL found. Create a PR targeting '${botBranch}' and paste the PR URL.`,
      "IMPORTANT: Before creating a new PR, check if one already exists for this issue.",
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git status",
      "git push -u origin HEAD",
      issueNumber
        ? `gh pr list --state open --search "fixes #${issueNumber} OR closes #${issueNumber} OR resolves #${issueNumber}" --json url,baseRefName,headRefName --limit 10`
        : "",
      `gh pr create --base ${botBranch} --fill --body \"${fixes}\"`,
      "```",
      "",
      "If a PR already exists:",
      "```bash",
      "gh pr list --head $(git branch --show-current) --json url,baseRefName,headRefName --limit 10",
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

    try {
      await this.warnLegacyWorktreesOnStartup();
    } catch (e: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to check for legacy worktrees: ${e?.message ?? String(e)}`
      );
    }
  }

  private async warnLegacyWorktreesOnStartup(): Promise<void> {
    const config = getConfig();
    const entries = await this.getGitWorktrees();
    const legacy = detectLegacyWorktrees(entries, {
      devDir: config.devDir,
      managedRoot: RALPH_WORKTREES_DIR,
    });

    if (legacy.length === 0) return;

    const key = `${this.repo}:legacy-worktrees`;
    if (!this.legacyWorktreesLogLimiter.shouldLog(key, LEGACY_WORKTREES_LOG_INTERVAL_MS)) return;

    console.warn(
      formatLegacyWorktreeWarning({
        repo: this.repo,
        repoPath: this.repoPath,
        devDir: config.devDir,
        managedRoot: RALPH_WORKTREES_DIR,
        legacyPaths: legacy.map((entry) => entry.worktreePath),
      })
    );
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

  private buildQueuedResetPatch(): Record<string, string> {
    return {
      "session-id": "",
      "worktree-path": "",
      "worker-id": "",
      "repo-slot": "",
      "daemon-id": "",
      "heartbeat-at": "",
      "watchdog-retries": "",
      "stall-retries": "",
    };
  }

  private async refreshIssueSnapshotBestEffort(task: AgentTask): Promise<void> {
    const issueRef = parseIssueRef(task.issue, task.repo);
    if (!issueRef) return;

    try {
      const data = await this.githubApiRequest<any>(`/repos/${issueRef.repo}/issues/${issueRef.number}`, {
        allowNotFound: true,
      });
      if (!data || typeof data !== "object") return;

      recordIssueSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        title: typeof data.title === "string" ? data.title : "",
        state: typeof data.state === "string" ? data.state : undefined,
        url: typeof data.html_url === "string" ? data.html_url : undefined,
      });

      const labels = Array.isArray(data.labels)
        ? data.labels.map((label: any) => String(label?.name ?? "").trim()).filter(Boolean)
        : [];
      recordIssueLabelsSnapshot({
        repo: issueRef.repo,
        issue: `${issueRef.repo}#${issueRef.number}`,
        labels,
        at: new Date().toISOString(),
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to refresh issue snapshot for ${issueRef.repo}#${issueRef.number}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private buildWorkerId(task: AgentTask, taskId?: string | null): string | undefined {
    const rawTaskId = taskId ?? task._path ?? task._name ?? task.name;
    const normalizedTaskId = rawTaskId?.trim();
    if (!normalizedTaskId) return undefined;
    return `${this.repo}#${normalizedTaskId}`;
  }

  private buildStableWorkerIdFallback(task: AgentTask, taskId?: string | null): string {
    const parts = [this.repo, task.issue, task._path, task._name, task.name, taskId]
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter(Boolean);
    const seed = parts.join("|") || this.repo;
    const hash = createHash("sha256").update(seed).digest("hex").slice(0, 12);
    return `w_${hash}`;
  }

  private compactWorkerId(workerId: string): string {
    const base = workerId || this.repo;
    const hash = createHash("sha256").update(base).digest("hex").slice(0, 12);
    const prefix = base.slice(0, 200).replace(/\s+/g, " ").trim();
    return `${prefix}-${hash}`;
  }

  private async ensureWorkerId(task: AgentTask, taskId?: string | null): Promise<string> {
    const existing = task["worker-id"]?.trim();
    if (existing && existing !== this.repo) return existing;
    const derived = this.buildWorkerId(task, taskId);
    if (derived) return derived;
    const fallback = this.buildStableWorkerIdFallback(task, taskId);
    await this.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worker-id": fallback,
    });
    return fallback;
  }

  private async formatWorkerId(task: AgentTask, taskId?: string | null): Promise<string> {
    const workerId = await this.ensureWorkerId(task, taskId);
    const trimmed = workerId.trim();
    if (trimmed && trimmed.length <= 256 && trimmed !== this.repo) return trimmed;
    const fallback = this.compactWorkerId(trimmed || this.buildStableWorkerIdFallback(task, taskId));
    console.warn(
      `[dashboard] invalid workerId; falling back (repo=${this.repo}, task=${taskId ?? task._path ?? task._name ?? task.name})`
    );
    await this.queue.updateTaskStatus(task, task.status === "in-progress" ? "in-progress" : "starting", {
      "worker-id": fallback,
    });
    return fallback;
  }

  private normalizeRepoSlot(value: number, limit: number): number {
    if (Number.isInteger(value) && value >= 0 && value < limit) return value;
    console.warn(`[scheduler] repoSlot allocation failed; using slot 0 (repo=${this.repo})`);
    return 0;
  }

  private getRepoSlotLimit(): number {
    const limit = getRepoConcurrencySlots(this.repo);
    return Number.isFinite(limit) && limit > 0 ? limit : 1;
  }

  private parseRepoSlotValue(value: unknown): number | null {
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? value : null;
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 0) return null;
    return parsed;
  }

  private resolveAssignedRepoSlot(task: AgentTask, repoSlot?: number | null): number {
    const limit = this.getRepoSlotLimit();
    const preferred = typeof repoSlot === "number" ? repoSlot : this.parseRepoSlotValue(task["repo-slot"]);
    if (preferred === null || preferred === undefined) return this.normalizeRepoSlot(0, limit);
    return this.normalizeRepoSlot(preferred, limit);
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

    const lease = this.tryClaimPrCreateLease({
      task,
      issueNumber,
      botBranch,
      sessionId: task["session-id"]?.trim() || null,
      stage: "recovery",
    });

    if (!lease.claimed) {
      diagnostics.push(`- PR-create lease already held; skipping auto-create (lease=${lease.key})`);
      const waited = await this.waitForExistingPrDuringPrCreateConflict({
        issueNumber,
        maxWaitMs: PR_CREATE_CONFLICT_WAIT_MS,
      });
      if (waited?.selectedUrl) {
        diagnostics.push(...waited.diagnostics);
        return { prUrl: waited.selectedUrl, diagnostics: diagnostics.join("\n") };
      }
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    diagnostics.push(`- Acquired PR-create lease: ${lease.key}`);

    try {
      const created = await ghWrite(this.repo)`gh pr create --repo ${this.repo} --base ${botBranch} --head ${branch} --title ${title} --body ${body}`
        .cwd(candidate.worktreePath)
        .quiet();

      const prUrl = selectPrUrl({ output: created.stdout.toString(), repo: this.repo }) ?? null;
      diagnostics.push(prUrl ? `- Created PR: ${prUrl}` : "- gh pr create succeeded but no URL detected");

      if (prUrl) {
        try {
          deleteIdempotencyKey(lease.key);
        } catch {
          // ignore
        }
        return { prUrl, diagnostics: diagnostics.join("\n") };
      }
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
        this.recordCiGateSummary(prUrl, summary);
        return { headSha, mergeStateStatus, baseRefName, summary, checks, timedOut: false, stopReason: "merge-conflict" };
      }

      if (summary.status === "success" || summary.status === "failure") {
        this.recordCiGateSummary(prUrl, summary);
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
      this.recordCiGateSummary(prUrl, last.summary);
      return { ...last, timedOut: true };
    }

    // Should be unreachable, but keep types happy.
    const fallback = await this.getPullRequestChecks(prUrl);
    const fallbackSummary = summarizeRequiredChecks(fallback.checks, requiredChecks);
    this.recordCiGateSummary(prUrl, fallbackSummary);
    return {
      headSha: fallback.headSha,
      mergeStateStatus: fallback.mergeStateStatus,
      baseRefName: fallback.baseRefName,
      summary: fallbackSummary,
      checks: fallback.checks,
      timedOut: true,
    };
  }

  private async mergePullRequest(prUrl: string, headSha: string, cwd: string): Promise<void> {
    const prNumber = extractPullRequestNumber(prUrl);
    if (!prNumber) {
      throw new Error(`Could not parse pull request number from URL: ${prUrl}`);
    }

    const { owner, name } = splitRepoFullName(this.repo);

    // Never pass --admin or -d (delete branch). Branch cleanup is handled separately with guardrails.
    // Use the merge REST API to avoid interactive gh pr merge behavior in daemon mode.
    await ghWrite(this.repo)`gh api -X PUT /repos/${owner}/${name}/pulls/${prNumber}/merge -f merge_method=merge -f sha=${headSha}`
      .cwd(cwd)
      .quiet();
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
    return this.parseCiFixAttempts(process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS) ?? 5;
  }

  private resolveMergeConflictAttempts(): number {
    return this.parseCiFixAttempts(process.env.RALPH_MERGE_CONFLICT_MAX_ATTEMPTS) ?? 2;
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

  private recordCiGateSummary(prUrl: string, summary: RequiredChecksSummary): void {
    const runId = this.activeRunId;
    if (!runId) return;
    const status = summary.status === "success" ? "pass" : summary.status === "failure" ? "fail" : "pending";
    const prNumber = extractPullRequestNumber(prUrl);
    const ciUrl = summary.required.map((check) => check.detailsUrl).find(Boolean) ?? null;

    try {
      upsertRalphRunGateResult({
        runId,
        gate: "ci",
        status,
        url: ciUrl,
        prNumber: prNumber ?? null,
        prUrl,
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to persist CI gate status for ${prUrl}: ${error?.message ?? String(error)}`
      );
    }
  }

  private recordMergeFailureArtifact(prUrl: string, details: string): void {
    const runId = this.activeRunId;
    if (!runId) return;

    try {
      recordRalphRunGateArtifact({
        runId,
        gate: "ci",
        kind: "note",
        content: [`Merge failure while attempting to merge ${prUrl}`, "", details].join("\n").trim(),
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to persist merge failure artifact for ${prUrl}: ${error?.message ?? String(error)}`
      );
    }
  }

  private recordCiFailureArtifacts(logs: FailedCheckLog[]): void {
    const runId = this.activeRunId;
    if (!runId) return;

    for (const entry of logs) {
      if (!entry.logExcerpt) continue;
      try {
        recordRalphRunGateArtifact({
          runId,
          gate: "ci",
          kind: "failure_excerpt",
          content: entry.logExcerpt,
        });
      } catch (error: any) {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to persist CI gate artifact: ${error?.message ?? String(error)}`
        );
      }
    }
  }

  private recordCiTriageArtifact(record: CiTriageRecord): void {
    const runId = this.activeRunId;
    if (!runId) return;

    try {
      recordRalphRunGateArtifact({
        runId,
        gate: "ci",
        kind: "note",
        content: JSON.stringify(record),
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to persist CI triage artifact: ${error?.message ?? String(error)}`
      );
    }
  }

  private buildCiTriageRecord(params: {
    signature: CiFailureSignatureV2;
    decision: CiTriageDecision;
    timedOut: boolean;
    attempt: number;
    maxAttempts: number;
    priorSignature: string | null;
    failedChecks: FailedCheck[];
    commands: string[];
  }): CiTriageRecord {
    return {
      version: 1,
      signatureVersion: params.signature.version,
      signature: params.signature.signature,
      classification: params.decision.classification,
      classificationReason: params.decision.classificationReason,
      action: params.decision.action,
      actionReason: params.decision.actionReason,
      timedOut: params.timedOut,
      attempt: params.attempt,
      maxAttempts: params.maxAttempts,
      priorSignature: params.priorSignature,
      failingChecks: params.failedChecks.map((check) => ({
        name: check.name,
        rawState: check.rawState,
        detailsUrl: check.detailsUrl ?? null,
      })),
      commands: params.commands,
    };
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

    if (opts.includeLogs) {
      this.recordCiFailureArtifacts(logs);
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
    const message = this.getGhErrorSearchText(error);
    if (!message) return false;
    return /not up to date with the base branch/i.test(message);
  }

  private isRequiredChecksExpectedMergeError(error: any): boolean {
    const message = this.getGhErrorSearchText(error);
    if (!message) return false;
    return /required status checks are expected/i.test(message);
  }

  private getGhErrorSearchText(error: any): string {
    const parts: string[] = [];
    const message = String(error?.message ?? "").trim();
    const stderr = this.stringifyGhOutput(error?.stderr);
    const stdout = this.stringifyGhOutput(error?.stdout);

    if (message) parts.push(message);
    if (stderr) parts.push(stderr);
    if (stdout) parts.push(stdout);

    return parts.join("\n").trim();
  }

  private stringifyGhOutput(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof (value as any)?.toString === "function") {
      try {
        return String((value as any).toString()).trim();
      } catch {
        return "";
      }
    }
    try {
      return String(value).trim();
    } catch {
      return "";
    }
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
    const lines: string[] = [];

    const command = String(error?.ghCommand ?? error?.command ?? "").trim();
    const redactedCommand = command ? redactSensitiveText(command).trim() : "";
    if (redactedCommand) lines.push(`Command: ${redactedCommand}`);

    const exitCodeRaw = error?.exitCode ?? error?.code ?? null;
    const exitCode = exitCodeRaw === null || exitCodeRaw === undefined ? "" : String(exitCodeRaw).trim();
    if (exitCode) lines.push(`Exit code: ${exitCode}`);

    const message = String(error?.message ?? "").trim();
    if (message) lines.push(message);

    const stderr = this.stringifyGhOutput(error?.stderr);
    const stdout = this.stringifyGhOutput(error?.stdout);

    if (stderr) lines.push("", "stderr:", summarizeForNote(stderr, 1600));
    if (stdout) lines.push("", "stdout:", summarizeForNote(stdout, 1600));

    return lines.join("\n").trim();
  }

  private buildMergeConflictPrompt(prUrl: string, baseRefName: string | null, botBranch: string): string {
    const baseName = baseRefName || botBranch;
    return [
      `This issue already has an open PR with merge conflicts blocking CI: ${prUrl}.`,
      `Resolve merge conflicts by merging '${baseName}' into the PR branch (no rebase or force-push).`,
      "The base branch has already been merged into the PR branch in this worktree; finish the merge and resolve conflicts if present.",
      "Do NOT create a new PR.",
      "After resolving conflicts, run tests/typecheck/build/knip and push updates on the PR branch.",
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
    const normalizedHead = params.headRefName ? this.normalizeGitRef(params.headRefName) : "";
    const timedOutLine = params.timedOut ? "Timed out waiting for required checks to complete." : "";

    const pushLine = normalizedHead
      ? `git push origin HEAD:${normalizedHead}`
      : "# If head ref is unknown, resolve it and push: gh pr view --json headRefName -q .headRefName";

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
      `gh pr checkout --detach ${params.prUrl}`,
      "git status",
      "",
      "# After making a deterministic fix and committing it:",
      pushLine,
      "```",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private buildCiResumePrompt(params: {
    prUrl: string;
    baseRefName: string | null;
    headRefName: string | null;
    summary: RequiredChecksSummary;
    remediationContext: string;
  }): string {
    const base = params.baseRefName || "(unknown)";
    const head = params.headRefName || "(unknown)";

    return [
      "CI fix for an existing PR with failing required checks.",
      `PR: ${params.prUrl}`,
      `Base: ${base}`,
      `Head: ${head}`,
      "",
      "Ralph is resuming the existing session to fix failing checks.",
      "Do NOT create a new PR.",
      "",
      params.remediationContext,
      "",
      "Commands (run in the task worktree):",
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

  private buildCiTriageCommentLines(params: {
    prUrl: string;
    baseRefName: string | null;
    headRefName: string | null;
    summary: RequiredChecksSummary;
    timedOut: boolean;
    action: CiNextAction;
    attemptCount: number;
    maxAttempts: number;
    resumeAt?: string | null;
  }): string[] {
    const base = params.baseRefName || "(unknown)";
    const head = params.headRefName || "(unknown)";
    const lines: string[] = [];

    lines.push("CI triage status");
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

    if (params.action === "resume") {
      lines.push("", "Action: Ralph is resuming the existing session to fix failing checks.");
    } else if (params.action === "quarantine") {
      const resumeAt = params.resumeAt ? `Retry after: ${params.resumeAt}` : "Retry scheduled.";
      lines.push("", "Action: Ralph is quarantining this failure as suspected flake/infra.", resumeAt);
    } else {
      lines.push("", "Action: Ralph is spawning a dedicated CI-debug run to make required checks green.");
    }

    lines.push(`Attempts: ${params.attemptCount}/${params.maxAttempts}`);
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
      await this.addIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to add ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(
          issue
        )}: ${
          error?.message ?? String(error)
        }`
      );
    }

    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_STATUS_BLOCKED);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STATUS_BLOCKED} label for ${formatIssueRef(
          issue
        )}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private async clearCiDebugLabels(issue: IssueRef): Promise<void> {
    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(
          issue
        )}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private computeCiRemediationBackoffMs(attemptNumber: number): number {
    const exponent = Math.max(0, attemptNumber - 1);
    const raw = CI_REMEDIATION_BACKOFF_BASE_MS * Math.pow(2, exponent);
    const clamped = Math.min(raw, CI_REMEDIATION_BACKOFF_MAX_MS);
    return applyRequiredChecksJitter(clamped);
  }

  private async sleepMs(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async escalateCiDebugRecovery(params: {
    task: AgentTask;
    issueNumber: number;
    issueRef: IssueRef;
    prUrl: string;
    baseRefName: string | null;
    headRefName: string | null;
    summary: RequiredChecksSummary;
    timedOut: boolean;
    attempts: CiDebugAttempt[];
    signature: string;
    maxAttempts: number;
    reason: string;
  }): Promise<CiDebugRecoveryOutcome> {
    const finalState: CiDebugCommentState = {
      version: 1,
      attempts: params.attempts,
      lastSignature: params.signature,
    };

    const lines = this.buildCiDebugCommentLines({
      prUrl: params.prUrl,
      baseRefName: params.baseRefName,
      headRefName: params.headRefName,
      summary: params.summary,
      timedOut: params.timedOut,
      attemptCount: params.attempts.length,
      maxAttempts: params.maxAttempts,
    });
    await this.upsertCiDebugComment({ issueNumber: params.issueNumber, lines, state: finalState });
    await this.clearCiDebugLabels(params.issueRef);

    const escalationBody = this.buildCiDebugEscalationSummary({
      prUrl: params.prUrl,
      summary: params.summary,
      attempts: params.attempts,
      reason: params.reason,
    });

    const wasEscalated = params.task.status === "escalated";
    if (!wasEscalated) {
      const escalated = await this.queue.updateTaskStatus(params.task, "escalated");
      if (escalated) {
        applyTaskPatch(params.task, "escalated", {});
      }

      // Use the idempotent escalation writeback comment for the human-facing summary.
      await this.writeEscalationWriteback(params.task, { reason: params.reason, details: escalationBody, escalationType: "blocked" });

      await this.notify.notifyEscalation({
        taskName: params.task.name,
        taskFileName: params.task._name,
        taskPath: params.task._path,
        issue: params.task.issue,
        repo: this.repo,
        sessionId: params.task["session-id"]?.trim() || undefined,
        reason: params.reason,
        escalationType: "blocked",
        planOutput: escalationBody,
      });

      if (escalated) {
        await this.recordEscalatedRunNote(params.task, {
          reason: params.reason,
          sessionId: params.task["session-id"]?.trim(),
          details: escalationBody,
        });
      }
    }

    return {
      status: "escalated",
      run: {
        taskName: params.task.name,
        repo: this.repo,
        outcome: "escalated",
        sessionId: params.task["session-id"]?.trim(),
        escalationReason: params.reason,
      },
    };
  }

  private isMergeConflictLeaseActive(lease: MergeConflictCommentState["lease"], nowMs: number): boolean {
    if (!lease?.expiresAt) return false;
    const expiresAt = Date.parse(lease.expiresAt);
    if (!Number.isFinite(expiresAt)) return false;
    return expiresAt > nowMs;
  }

  private buildMergeConflictLease(holder: string, nowMs: number): MergeConflictCommentState["lease"] {
    return { holder, expiresAt: new Date(nowMs + MERGE_CONFLICT_LEASE_TTL_MS).toISOString() };
  }

  private async upsertMergeConflictComment(params: {
    issueNumber: number;
    lines: string[];
    state: MergeConflictCommentState;
  }): Promise<void> {
    const match = await findMergeConflictComment({
      github: this.github,
      repo: this.repo,
      issueNumber: params.issueNumber,
      limit: MERGE_CONFLICT_COMMENT_SCAN_LIMIT,
    });

    const body = buildMergeConflictCommentBody({ marker: match.marker, state: params.state, lines: params.lines });
    const existing = match.comment?.body ?? "";
    if (existing.trim() === body.trim()) return;

    if (match.comment?.updatedAt) {
      const updatedAtMs = Date.parse(match.comment.updatedAt);
      if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < MERGE_CONFLICT_COMMENT_MIN_EDIT_MS) {
        const existingState = parseMergeConflictState(existing);
        const nextState = params.state;
        if (existingState && JSON.stringify(existingState) === JSON.stringify(nextState)) {
          return;
        }
      }
    }

    if (match.comment) {
      await updateMergeConflictComment({ github: this.github, repo: this.repo, commentId: match.comment.id, body });
      return;
    }

    await createMergeConflictComment({ github: this.github, repo: this.repo, issueNumber: params.issueNumber, body });
  }

  private async applyMergeConflictLabels(issue: IssueRef): Promise<void> {
    try {
      await this.addIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to add ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(
          issue
        )}: ${
          error?.message ?? String(error)
        }`
      );
    }

    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_STATUS_BLOCKED);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STATUS_BLOCKED} label for ${formatIssueRef(
          issue
        )}: ${
          error?.message ?? String(error)
        }`
      );
    }
  }

  private async clearMergeConflictLabels(issue: IssueRef): Promise<void> {
    try {
      await this.removeIssueLabel(issue, RALPH_LABEL_STATUS_IN_PROGRESS);
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to remove ${RALPH_LABEL_STATUS_IN_PROGRESS} label for ${formatIssueRef(
          issue
        )}: ${
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

  private parseMergeConflictPathsFromLsFiles(output: string): string[] {
    const paths = new Set<string>();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const tabIndex = trimmed.indexOf("\t");
      if (tabIndex === -1) continue;
      const path = trimmed.slice(tabIndex + 1).trim();
      if (path) paths.add(path);
    }
    return Array.from(paths);
  }

  private async listMergeConflictPaths(worktreePath: string): Promise<string[]> {
    const result = await $`git ls-files -u`.cwd(worktreePath).quiet();
    return this.parseMergeConflictPathsFromLsFiles(result.stdout.toString());
  }

  private async waitForMergeConflictRecoverySignals(params: {
    prUrl: string;
    previousHeadSha: string;
    requiredChecks: string[];
    timeoutMs: number;
    pollIntervalMs: number;
  }): Promise<{
    headSha: string;
    mergeStateStatus: PullRequestMergeStateStatus | null;
    baseRefName: string;
    summary: RequiredChecksSummary;
    checks: PrCheck[];
    timedOut: boolean;
  }> {
    const startedAt = Date.now();
    let last: {
      headSha: string;
      mergeStateStatus: PullRequestMergeStateStatus | null;
      baseRefName: string;
      summary: RequiredChecksSummary;
      checks: PrCheck[];
    } | null = null;

    while (Date.now() - startedAt < params.timeoutMs) {
      const { headSha, mergeStateStatus, baseRefName, checks } = await this.getPullRequestChecks(params.prUrl);
      const summary = summarizeRequiredChecks(checks, params.requiredChecks);
      last = { headSha, mergeStateStatus, baseRefName, summary, checks };

      const headUpdated = !params.previousHeadSha || headSha !== params.previousHeadSha;
      const mergeOk = mergeStateStatus !== "DIRTY";
      const checksObserved =
        params.requiredChecks.length === 0 || summary.required.some((check) => check.state !== "UNKNOWN");

      if (headUpdated && mergeOk && checksObserved) {
        return { headSha, mergeStateStatus, baseRefName, summary, checks, timedOut: false };
      }

      await new Promise((r) => setTimeout(r, params.pollIntervalMs));
    }

    if (last) {
      return { ...last, timedOut: true };
    }

    const fallback = await this.getPullRequestChecks(params.prUrl);
    return {
      headSha: fallback.headSha,
      mergeStateStatus: fallback.mergeStateStatus,
      baseRefName: fallback.baseRefName,
      summary: summarizeRequiredChecks(fallback.checks, params.requiredChecks),
      checks: fallback.checks,
      timedOut: true,
    };
  }

  private async finalizeMergeConflictEscalation(params: {
    task: AgentTask;
    issueNumber: string;
    prUrl: string;
    reason: string;
    attempts: MergeConflictAttempt[];
    baseRefName: string | null;
    headRefName: string | null;
    sessionId?: string;
  }): Promise<MergeConflictRecoveryOutcome> {
    const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
      repo: this.repo,
      number: Number(params.issueNumber),
    };

    await this.clearMergeConflictLabels(issueRef);

    const escalationBody = buildMergeConflictEscalationDetails({
      prUrl: params.prUrl,
      baseRefName: params.baseRefName,
      headRefName: params.headRefName,
      attempts: params.attempts,
      reason: params.reason,
      botBranch: getRepoBotBranch(this.repo),
    });

    const wasEscalated = params.task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(params.task, "escalated");
    if (escalated) {
      applyTaskPatch(params.task, "escalated", {});
    }
    await this.writeEscalationWriteback(params.task, {
      reason: params.reason,
      details: escalationBody,
      escalationType: "merge-conflict",
    });
    await this.notify.notifyEscalation({
      taskName: params.task.name,
      taskFileName: params.task._name,
      taskPath: params.task._path,
      issue: params.task.issue,
      repo: this.repo,
      sessionId: params.sessionId,
      reason: params.reason,
      escalationType: "merge-conflict",
      planOutput: escalationBody,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(params.task, {
        reason: params.reason,
        sessionId: params.sessionId,
        details: escalationBody,
      });
    }

    return {
      status: "escalated",
      run: {
        taskName: params.task.name,
        repo: this.repo,
        outcome: "escalated",
        sessionId: params.sessionId,
        escalationReason: params.reason,
      },
    };
  }

  private async runMergeConflictRecovery(params: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    issueMeta: IssueMetadata;
    botBranch: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }): Promise<MergeConflictRecoveryOutcome> {
    const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
      repo: this.repo,
      number: Number(params.issueNumber),
    };
    const maxAttempts = this.resolveMergeConflictAttempts();
    const workerId = await this.formatWorkerId(params.task, params.task._path);

    let prState: PullRequestMergeState;
    let requiredChecks: string[] = [];
    let baseRefName: string | null = null;
    let headRefName: string | null = null;
    let previousHeadSha = "";

    try {
      prState = await this.getPullRequestMergeState(params.prUrl);
      baseRefName = prState.baseRefName || params.botBranch;
      headRefName = prState.headRefName || null;
      ({ checks: requiredChecks } = await this.resolveRequiredChecksForMerge());
      const prStatus = await this.getPullRequestChecks(params.prUrl);
      previousHeadSha = prStatus.headSha;
    } catch (error: any) {
      const reason = `Merge-conflict recovery preflight failed for ${params.prUrl}: ${this.formatGhError(error)}`;
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

    if (prState.isCrossRepository || prState.headRepoFullName !== this.repo) {
      const reason = `Merge-conflict recovery cannot push cross-repo PR ${params.prUrl}; requires same-repo branch access`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return await this.finalizeMergeConflictEscalation({
        task: params.task,
        issueNumber: params.issueNumber,
        prUrl: params.prUrl,
        reason,
        attempts: [],
        baseRefName,
        headRefName,
        sessionId: params.task["session-id"]?.trim(),
      });
    }

    if (!headRefName) {
      const reason = `Merge-conflict recovery missing head ref for ${params.prUrl}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return await this.finalizeMergeConflictEscalation({
        task: params.task,
        issueNumber: params.issueNumber,
        prUrl: params.prUrl,
        reason,
        attempts: [],
        baseRefName,
        headRefName,
        sessionId: params.task["session-id"]?.trim(),
      });
    }

    const commentMatch = await findMergeConflictComment({
      github: this.github,
      repo: this.repo,
      issueNumber: Number(params.issueNumber),
      limit: MERGE_CONFLICT_COMMENT_SCAN_LIMIT,
    });
    const existingState = commentMatch.state ?? ({ version: 1 } satisfies MergeConflictCommentState);
    const attempts = [...(existingState.attempts ?? [])];

    const nowMs = Date.now();
    const lease = existingState.lease;
    if (this.isMergeConflictLeaseActive(lease, nowMs) && lease?.holder !== workerId) {
      const reason = `Merge-conflict lease already held by ${lease?.holder ?? "unknown"}; skipping duplicate run for ${params.prUrl}`;
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
    const worktreePath = join(
      RALPH_WORKTREES_DIR,
      safeNoteName(this.repo),
      "merge-conflict",
      params.issueNumber,
      safeNoteName(`attempt-${attemptNumber}`)
    );

    await this.ensureGitWorktree(worktreePath);

    let conflictPaths: string[] = [];
    let baseSha = "";
    let headSha = "";
    let normalizedBase = this.normalizeGitRef(baseRefName || params.botBranch);
    let normalizedHead = this.normalizeGitRef(headRefName);

    try {
      await $`git fetch origin`.cwd(worktreePath).quiet();
      await ghWrite(this.repo)`gh pr checkout ${params.prUrl}`.cwd(worktreePath).quiet();

      if (!normalizedHead) {
        throw new Error(`Missing head ref for merge-conflict recovery: ${params.prUrl}`);
      }

      try {
        await $`git push --dry-run origin HEAD:${normalizedHead}`.cwd(worktreePath).quiet();
      } catch (error: any) {
        const reason = `Merge-conflict recovery cannot push to ${normalizedHead} for ${params.prUrl}: ${this.formatGhError(error)}`;
        console.warn(`[ralph:worker:${this.repo}] ${reason}`);
        const finalState: MergeConflictCommentState = {
          version: 1,
          attempts,
          lastSignature: existingState.lastSignature,
        };
        const lines = buildMergeConflictCommentLines({
          prUrl: params.prUrl,
          baseRefName,
          headRefName,
          conflictPaths,
          attemptCount: attempts.length,
          maxAttempts,
          action: "Ralph cannot push to the PR branch; escalating merge-conflict recovery.",
          reason,
        });
        await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: finalState });
        await this.clearMergeConflictLabels(issueRef);
        await this.cleanupGitWorktree(worktreePath);
        return await this.finalizeMergeConflictEscalation({
          task: params.task,
          issueNumber: params.issueNumber,
          prUrl: params.prUrl,
          reason,
          attempts,
          baseRefName,
          headRefName,
          sessionId: params.task["session-id"]?.trim(),
        });
      }

      try {
        await $`git merge --no-commit origin/${normalizedBase}`.cwd(worktreePath).quiet();
      } catch {
        // Expected when conflicts exist.
      }

      conflictPaths = await this.listMergeConflictPaths(worktreePath);
      baseSha = (await $`git rev-parse origin/${normalizedBase}`.cwd(worktreePath).quiet()).stdout.toString().trim();
      headSha = (await $`git rev-parse HEAD`.cwd(worktreePath).quiet()).stdout.toString().trim();
    } catch (error: any) {
      const reason = `Merge-conflict recovery setup failed for ${params.prUrl}: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      await this.cleanupGitWorktree(worktreePath);
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

    const signature = buildMergeConflictSignature({ baseSha, headSha, conflictPaths });
    const decision = computeMergeConflictDecision({ attempts, maxAttempts, nextSignature: signature });
    if (decision.stop) {
      const reason = decision.reason || "Merge-conflict recovery stopping without a specific reason.";
      const finalState: MergeConflictCommentState = {
        version: 1,
        attempts,
        lastSignature: signature,
      };
      const lines = buildMergeConflictCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        conflictPaths,
        attemptCount: attempts.length,
        maxAttempts,
        action: "Ralph is escalating merge-conflict recovery.",
        reason,
      });
      await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: finalState });
      await this.clearMergeConflictLabels(issueRef);
      await this.cleanupGitWorktree(worktreePath);
      return await this.finalizeMergeConflictEscalation({
        task: params.task,
        issueNumber: params.issueNumber,
        prUrl: params.prUrl,
        reason,
        attempts,
        baseRefName,
        headRefName,
        sessionId: params.task["session-id"]?.trim(),
      });
    }

    const attemptStart = new Date().toISOString();
    const conflictSummary = formatMergeConflictPaths(conflictPaths);
    const attempt: MergeConflictAttempt = {
      attempt: attemptNumber,
      signature,
      startedAt: attemptStart,
      status: "running",
      conflictCount: conflictSummary.total,
      conflictPaths: conflictSummary.sample,
    };

    const nextState: MergeConflictCommentState = {
      version: 1,
      lease: this.buildMergeConflictLease(workerId, nowMs),
      attempts: [...attempts, attempt],
      lastSignature: signature,
    };

    const lines = buildMergeConflictCommentLines({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      conflictPaths,
      attemptCount: attemptNumber,
      maxAttempts,
      action: "Ralph is spawning a dedicated merge-conflict recovery run to resolve conflicts.",
    });
    await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: nextState });
    await this.applyMergeConflictLabels(issueRef);

    const prompt = this.buildMergeConflictPrompt(params.prUrl, baseRefName, params.botBranch);
    const runLogPath = await this.recordRunLogPath(params.task, params.issueNumber, `merge-conflict-${attemptNumber}`, "in-progress");

    let sessionResult = await this.session.runAgent(worktreePath, "general", prompt, {
      repo: this.repo,
      cacheKey: params.cacheKey,
      runLogPath,
      introspection: {
        repo: this.repo,
        issue: params.task.issue,
        taskName: params.task.name,
        step: 4,
        stepTitle: `merge-conflict attempt ${attemptNumber}`,
      },
      ...this.buildWatchdogOptions(params.task, `merge-conflict-${attemptNumber}`),
      ...this.buildStallOptions(params.task, `merge-conflict-${attemptNumber}`),
      ...this.buildGuardrailsOptions(params.task, `merge-conflict-${attemptNumber}`),
      ...this.buildLoopDetectionOptions(params.task, `merge-conflict-${attemptNumber}`),
      ...params.opencodeSessionOptions,
    });

    const pausedAfter = await this.pauseIfHardThrottled(
      params.task,
      `merge-conflict-${attemptNumber} (post)`,
      sessionResult.sessionId
    );
    if (pausedAfter) {
      await this.cleanupGitWorktree(worktreePath);
      return { status: "failed", run: pausedAfter };
    }

    if (sessionResult.loopTrip) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleLoopTrip(params.task, params.cacheKey, `merge-conflict-${attemptNumber}`, sessionResult);
      return { status: "failed", run };
    }

    if (sessionResult.guardrailTimeout) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleGuardrailTimeout(
        params.task,
        params.cacheKey,
        `merge-conflict-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    if (sessionResult.watchdogTimeout) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleWatchdogTimeout(
        params.task,
        params.cacheKey,
        `merge-conflict-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    const completedAt = new Date().toISOString();
    if (sessionResult.sessionId) {
      await this.queue.updateTaskStatus(params.task, "in-progress", { "session-id": sessionResult.sessionId });
    }

    if (!sessionResult.success) {
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      const failedState: MergeConflictCommentState = {
        version: 1,
        attempts: [...attempts, attempt],
        lastSignature: signature,
      };
      const failedLines = buildMergeConflictCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        conflictPaths,
        attemptCount: attemptNumber,
        maxAttempts,
        action: "Merge-conflict recovery attempt failed; retrying if attempts remain.",
      });
      await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: failedLines, state: failedState });
      await this.cleanupGitWorktree(worktreePath);
      return await this.runMergeConflictRecovery({ ...params, opencodeSessionOptions: params.opencodeSessionOptions });
    }

    let postRecovery;
    try {
      postRecovery = await this.waitForMergeConflictRecoverySignals({
        prUrl: params.prUrl,
        previousHeadSha,
        requiredChecks,
        timeoutMs: MERGE_CONFLICT_WAIT_TIMEOUT_MS,
        pollIntervalMs: MERGE_CONFLICT_WAIT_POLL_MS,
      });
    } catch (error: any) {
      const reason = `Merge-conflict recovery failed while waiting for updated PR state: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      const failedState: MergeConflictCommentState = {
        version: 1,
        attempts: [...attempts, attempt],
        lastSignature: signature,
      };
      const failedLines = buildMergeConflictCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        conflictPaths,
        attemptCount: attemptNumber,
        maxAttempts,
        action: "Merge-conflict recovery attempt failed; retrying if attempts remain.",
        reason,
      });
      await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: failedLines, state: failedState });
      await this.cleanupGitWorktree(worktreePath);
      return await this.runMergeConflictRecovery({ ...params, opencodeSessionOptions: params.opencodeSessionOptions });
    }

    if (postRecovery.mergeStateStatus === "DIRTY" || postRecovery.timedOut) {
      const reason = postRecovery.timedOut
        ? `Merge-conflict recovery timed out waiting for updated PR state for ${params.prUrl}`
        : `Merge conflicts remain after recovery attempt for ${params.prUrl}`;
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      const failedState: MergeConflictCommentState = {
        version: 1,
        attempts: [...attempts, attempt],
        lastSignature: signature,
      };
      const failedLines = buildMergeConflictCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        conflictPaths,
        attemptCount: attemptNumber,
        maxAttempts,
        action: "Merge-conflict recovery attempt failed; retrying if attempts remain.",
        reason,
      });
      await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: failedLines, state: failedState });
      await this.cleanupGitWorktree(worktreePath);
      return await this.runMergeConflictRecovery({ ...params, opencodeSessionOptions: params.opencodeSessionOptions });
    }

    attempt.status = "succeeded";
    attempt.completedAt = completedAt;

    const finalState: MergeConflictCommentState = {
      version: 1,
      attempts: [...attempts, attempt],
      lastSignature: signature,
    };
    const finalLines = buildMergeConflictCommentLines({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      conflictPaths,
      attemptCount: attemptNumber,
      maxAttempts,
      action: "Merge conflicts resolved; waiting for required checks to finish.",
    });
    await this.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: finalLines, state: finalState });
    await this.cleanupGitWorktree(worktreePath);

    await this.clearMergeConflictLabels(issueRef);

    return {
      status: "success",
      prUrl: params.prUrl,
      sessionId: sessionResult.sessionId || params.task["session-id"]?.trim() || "",
      headSha: postRecovery.headSha,
    };
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
        const status = attempt.status ?? "unknown";
        const signatureBefore = attempt.signature || "(no signature)";
        const signatureAfter = attempt.signatureAfter ? ` -> ${attempt.signatureAfter}` : "";
        lines.push(`- Attempt ${attempt.attempt} (${status}, ${when}): ${signatureBefore}${signatureAfter}`);

        if (attempt.headShaBefore || attempt.headShaAfter) {
          const before = attempt.headShaBefore ? attempt.headShaBefore.slice(0, 7) : "?";
          const after = attempt.headShaAfter ? attempt.headShaAfter.slice(0, 7) : "?";
          lines.push(`  - head: ${before} -> ${after}`);
        }

        if (typeof attempt.backoffMs === "number" && Number.isFinite(attempt.backoffMs) && attempt.backoffMs > 0) {
          lines.push(`  - backoff: ${Math.round(attempt.backoffMs / 1000)}s`);
        }

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
      "- Inspect the failing check runs linked above, fix or rerun as needed, then re-add `ralph:status:queued` (or comment `RALPH RESOLVED:`) to resume."
    );

    return lines.join("\n");
  }

  private async runCiFailureTriage(params: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    requiredChecks: string[];
    issueMeta: IssueMetadata;
    botBranch: string;
    timedOut: boolean;
    repoPath: string;
    sessionId?: string | null;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }): Promise<CiFailureTriageOutcome> {
    const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
      repo: this.repo,
      number: Number(params.issueNumber),
    };
    const maxAttempts = this.resolveCiFixAttempts();
    const sessionId = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";
    const hasSession = Boolean(sessionId);

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
      this.recordCiGateSummary(params.prUrl, summary);
    } catch (error: any) {
      const reason = `CI triage preflight failed for ${params.prUrl}: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return {
        status: "failed",
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: sessionId || undefined,
          escalationReason: reason,
        },
      };
    }

    const remediation = await this.buildRemediationFailureContext(summary, { includeLogs: true });
    const failureEntries = remediation.logs.length > 0
      ? remediation.logs
      : remediation.failedChecks.map((check) => ({ ...check, logExcerpt: null }));
    const signature = buildCiFailureSignatureV2({
      timedOut: params.timedOut,
      failures: failureEntries.map((entry) => ({
        name: entry.name,
        rawState: entry.rawState,
        excerpt: entry.logExcerpt ?? null,
      })),
    });

    const commentMatch = await findCiDebugComment({
      github: this.github,
      repo: this.repo,
      issueNumber: Number(params.issueNumber),
      limit: CI_DEBUG_COMMENT_SCAN_LIMIT,
    });
    const existingState = commentMatch.state ?? ({ version: 1 } satisfies CiDebugCommentState);
    const existingTriage = existingState.triage ?? ({ version: 1, attemptCount: 0 } satisfies CiTriageCommentState);
    const attemptNumber = Math.max(0, existingTriage.attemptCount ?? 0) + 1;
    const priorSignature = existingTriage.lastSignature ?? null;

    const decision = buildCiTriageDecision({
      timedOut: params.timedOut,
      failures: failureEntries.map((entry) => ({
        name: entry.name,
        rawState: entry.rawState,
        excerpt: entry.logExcerpt ? redactSensitiveText(entry.logExcerpt) : null,
      })),
      commands: remediation.commands,
      attempt: attemptNumber,
      maxAttempts,
      hasSession,
      signature: signature.signature,
      priorSignature,
    });

    const triageRecord = this.buildCiTriageRecord({
      signature,
      decision,
      timedOut: params.timedOut,
      attempt: attemptNumber,
      maxAttempts,
      priorSignature,
      failedChecks: remediation.failedChecks,
      commands: remediation.commands,
    });
    this.recordCiTriageArtifact(triageRecord);

    console.log(
      `[ralph:worker:${this.repo}] CI triage decision action=${decision.action} classification=${decision.classification} ` +
        `signature=${signature.signature} pr=${params.prUrl}`
    );

    const nextTriageState: CiTriageCommentState = {
      version: 1,
      attemptCount: attemptNumber,
      lastSignature: signature.signature,
      lastClassification: decision.classification,
      lastAction: decision.action,
      lastUpdatedAt: new Date().toISOString(),
    };

    if (attemptNumber > maxAttempts) {
      const reason = `Required checks not passing after ${maxAttempts} triage attempt(s); refusing to merge ${params.prUrl}`;
      return this.escalateCiDebugRecovery({
        task: params.task,
        issueNumber: Number(params.issueNumber),
        issueRef,
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: params.timedOut,
        attempts: [...(existingState.attempts ?? [])],
        signature: this.formatCiDebugSignature(summary, params.timedOut),
        maxAttempts,
        reason,
      });
    }

    if (decision.action === "spawn") {
      return this.runCiDebugRecovery({
        task: params.task,
        issueNumber: params.issueNumber,
        cacheKey: params.cacheKey,
        prUrl: params.prUrl,
        requiredChecks: params.requiredChecks,
        issueMeta: params.issueMeta,
        botBranch: params.botBranch,
        timedOut: params.timedOut,
        opencodeXdg: params.opencodeXdg,
        opencodeSessionOptions: params.opencodeSessionOptions,
        remediationContext: remediation,
        triageState: nextTriageState,
      });
    }

    if (decision.action === "resume" && !hasSession) {
      return this.runCiDebugRecovery({
        task: params.task,
        issueNumber: params.issueNumber,
        cacheKey: params.cacheKey,
        prUrl: params.prUrl,
        requiredChecks: params.requiredChecks,
        issueMeta: params.issueMeta,
        botBranch: params.botBranch,
        timedOut: params.timedOut,
        opencodeXdg: params.opencodeXdg,
        opencodeSessionOptions: params.opencodeSessionOptions,
        remediationContext: remediation,
        triageState: nextTriageState,
      });
    }

    const nextState: CiDebugCommentState = {
      ...existingState,
      version: 1,
      triage: nextTriageState,
    };

    if (decision.action === "quarantine") {
      const backoffMs = this.computeCiRemediationBackoffMs(attemptNumber);
      const resumeAt = new Date(Date.now() + backoffMs).toISOString();
      const lines = this.buildCiTriageCommentLines({
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: params.timedOut,
        action: "quarantine",
        attemptCount: attemptNumber,
        maxAttempts,
        resumeAt,
      });
      await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines, state: nextState });
      await this.clearCiDebugLabels(issueRef);

      const run = await this.throttleForCiQuarantine({
        task: params.task,
        sessionId,
        resumeAt,
        reason: "ci-quarantine",
        details: JSON.stringify({
          signature: signature.signature,
          classification: decision.classification,
          action: decision.action,
          resumeAt,
        }),
      });

      return { status: run.outcome === "throttled" ? "throttled" : "failed", run };
    }

    const resumeLines = this.buildCiTriageCommentLines({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: params.timedOut,
      action: "resume",
      attemptCount: attemptNumber,
      maxAttempts,
    });
    await this.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines: resumeLines, state: nextState });
    await this.applyCiDebugLabels(issueRef);

    const remediationContext = this.formatRemediationFailureContext(remediation);
    const prompt = this.buildCiResumePrompt({
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      remediationContext,
    });
    const runLogPath = await this.recordRunLogPath(
      params.task,
      params.issueNumber,
      `ci-resume-${attemptNumber}`,
      "in-progress"
    );

    let sessionResult = await this.session.continueSession(params.repoPath, sessionId, prompt, {
      repo: this.repo,
      cacheKey: params.cacheKey,
      runLogPath,
      introspection: {
        repo: this.repo,
        issue: params.task.issue,
        taskName: params.task.name,
        step: 5,
        stepTitle: `ci-resume attempt ${attemptNumber}`,
      },
      ...this.buildWatchdogOptions(params.task, `ci-resume-${attemptNumber}`),
      ...this.buildStallOptions(params.task, `ci-resume-${attemptNumber}`),
      ...this.buildGuardrailsOptions(params.task, `ci-resume-${attemptNumber}`),
      ...this.buildLoopDetectionOptions(params.task, `ci-resume-${attemptNumber}`),
      ...params.opencodeSessionOptions,
    });

    const pausedAfter = await this.pauseIfHardThrottled(
      params.task,
      `ci-resume-${attemptNumber} (post)`,
      sessionResult.sessionId
    );
    if (pausedAfter) {
      return { status: "throttled", run: pausedAfter };
    }

    if (sessionResult.watchdogTimeout) {
      const run = await this.handleWatchdogTimeout(
        params.task,
        params.cacheKey,
        `ci-resume-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    if (sessionResult.guardrailTimeout) {
      const run = await this.handleGuardrailTimeout(
        params.task,
        params.cacheKey,
        `ci-resume-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    if (sessionResult.stallTimeout) {
      const run = await this.handleStallTimeout(params.task, params.cacheKey, `ci-resume-${attemptNumber}`, sessionResult);
      return { status: "failed", run };
    }

    if (sessionResult.sessionId) {
      await this.queue.updateTaskStatus(params.task, "in-progress", { "session-id": sessionResult.sessionId });
    }

    try {
      const prStatus = await this.getPullRequestChecks(params.prUrl);
      summary = summarizeRequiredChecks(prStatus.checks, params.requiredChecks);
      headSha = prStatus.headSha;
      this.recordCiGateSummary(params.prUrl, summary);
    } catch (error: any) {
      const reason = `Failed to re-check CI status after resume: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      return {
        status: "failed",
        run: {
          taskName: params.task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: (sessionResult.sessionId ?? sessionId) || undefined,
          escalationReason: reason,
        },
      };
    }

    if (summary.status === "success") {
      await this.clearCiDebugLabels(issueRef);
      return {
        status: "success",
        prUrl: params.prUrl,
        sessionId: sessionResult.sessionId || sessionId,
        headSha,
        summary,
      };
    }

    if (attemptNumber >= maxAttempts) {
      const reason = `Required checks not passing after ${maxAttempts} triage attempt(s); refusing to merge ${params.prUrl}`;
      return this.escalateCiDebugRecovery({
        task: params.task,
        issueNumber: Number(params.issueNumber),
        issueRef,
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: false,
        attempts: [...(existingState.attempts ?? [])],
        signature: this.formatCiDebugSignature(summary, false),
        maxAttempts,
        reason,
      });
    }

    const backoffMs = this.computeCiRemediationBackoffMs(attemptNumber);
    if (backoffMs > 0) {
      await this.sleepMs(backoffMs);
    }

    return this.runCiFailureTriage({
      ...params,
      timedOut: false,
      sessionId: sessionResult.sessionId || sessionId,
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
    remediationContext?: RemediationFailureContext;
    triageState?: CiTriageCommentState;
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
      this.recordCiGateSummary(params.prUrl, summary);
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
    const triageState = params.triageState ?? existingState.triage;
    const attempts = [...(existingState.attempts ?? [])];
    if (attempts.length >= maxAttempts) {
      const reason = `Required checks not passing after ${maxAttempts} attempt(s); refusing to merge ${params.prUrl}`;
      return this.escalateCiDebugRecovery({
        task: params.task,
        issueNumber: Number(params.issueNumber),
        issueRef,
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: params.timedOut,
        attempts,
        signature,
        maxAttempts,
        reason,
      });
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
      headShaBefore: headSha,
      startedAt: new Date().toISOString(),
      status: "running",
      runUrls: this.collectFailureRunUrls(summary),
    };

    const nextState: CiDebugCommentState = {
      version: 1,
      lease: this.buildCiDebugLease(workerId, nowMs),
      attempts: [...attempts, attempt],
      lastSignature: signature,
      triage: triageState,
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
      params.remediationContext ?? (await this.buildRemediationFailureContext(summary, { includeLogs: true }))
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
      ...this.buildStallOptions(params.task, `ci-debug-${attemptNumber}`),
      ...this.buildGuardrailsOptions(params.task, `ci-debug-${attemptNumber}`),
      ...this.buildLoopDetectionOptions(params.task, `ci-debug-${attemptNumber}`),
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

    if (sessionResult.guardrailTimeout) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleGuardrailTimeout(
        params.task,
        params.cacheKey,
        `ci-debug-${attemptNumber}`,
        sessionResult,
        params.opencodeXdg
      );
      return { status: "failed", run };
    }

    if (sessionResult.stallTimeout) {
      await this.cleanupGitWorktree(worktreePath);
      const run = await this.handleStallTimeout(params.task, params.cacheKey, `ci-debug-${attemptNumber}`, sessionResult);
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
      this.recordCiGateSummary(params.prUrl, summary);
      attempt.headShaAfter = headSha;
      attempt.signatureAfter = this.formatCiDebugSignature(summary, false);
    } catch (error: any) {
      const reason = `Failed to re-check CI status after CI-debug run: ${this.formatGhError(error)}`;
      console.warn(`[ralph:worker:${this.repo}] ${reason}`);
      attempt.status = "failed";
      attempt.completedAt = completedAt;
      const failedState: CiDebugCommentState = {
        version: 1,
        attempts: [...attempts, attempt],
        lastSignature: signature,
        triage: triageState,
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

    const signatureAfter = attempt.signatureAfter ?? this.formatCiDebugSignature(summary, false);

    attempt.status = summary.status === "success" ? "succeeded" : "failed";
    attempt.completedAt = completedAt;

    const noProgress =
      attempt.status === "failed" &&
      Boolean(attempt.headShaBefore) &&
      Boolean(attempt.headShaAfter) &&
      attempt.headShaBefore === attempt.headShaAfter;

    if (!noProgress && attempt.status === "failed" && attemptNumber < maxAttempts) {
      attempt.backoffMs = this.computeCiRemediationBackoffMs(attemptNumber);
    }

    const finalAttempts = [...attempts, attempt];
    const finalState: CiDebugCommentState = {
      version: 1,
      attempts: finalAttempts,
      lastSignature: signatureAfter,
      triage: triageState,
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

    if (noProgress) {
      const reason = `CI remediation made no progress (head SHA unchanged); stopping remediation for ${params.prUrl}`;
      return this.escalateCiDebugRecovery({
        task: params.task,
        issueNumber: Number(params.issueNumber),
        issueRef,
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: false,
        attempts: finalAttempts,
        signature: signatureAfter,
        maxAttempts,
        reason,
      });
    }

    if (attemptNumber >= maxAttempts) {
      const reason = `Required checks not passing after ${maxAttempts} attempt(s); refusing to merge ${params.prUrl}`;
      return this.escalateCiDebugRecovery({
        task: params.task,
        issueNumber: Number(params.issueNumber),
        issueRef,
        prUrl: params.prUrl,
        baseRefName,
        headRefName,
        summary,
        timedOut: false,
        attempts: finalAttempts,
        signature: signatureAfter,
        maxAttempts,
        reason,
      });
    }

    if (typeof attempt.backoffMs === "number" && Number.isFinite(attempt.backoffMs) && attempt.backoffMs > 0) {
      await this.sleepMs(attempt.backoffMs);
    }

    return this.runCiDebugRecovery({
      ...params,
      timedOut: false,
      triageState: params.triageState,
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

    // Escalated tasks are explicitly waiting on humans; do not attempt autonomous CI remediation.
    const issueLabels = issueMeta.labels ?? [];
    if (task.status === "escalated") {
      return null;
    }

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

    const recovery = await this.runMergeConflictRecovery({
      task,
      issueNumber,
      cacheKey,
      prUrl: existingPr.selectedUrl,
      issueMeta,
      botBranch,
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
      watchdogStagePrefix: "merge-conflict",
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
      ...this.buildStallOptions(task, "survey"),
      ...this.buildGuardrailsOptions(task, "survey"),
      ...this.buildLoopDetectionOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    await this.recordImplementationCheckpoint(task, surveyResult.sessionId || mergeGate.sessionId);

    if (!surveyResult.success && surveyResult.loopTrip) {
      return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
    }

    if (!surveyResult.success && surveyResult.guardrailTimeout) {
      return await this.handleGuardrailTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.watchdogTimeout) {
      return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.stallTimeout) {
      return await this.handleStallTimeout(task, cacheKey, "survey", surveyResult);
    }

    try {
      await writeDxSurveyToGitHubIssues({
        github: this.github,
        targetRepo: this.repo,
        ralphRepo: "3mdistal/ralph",
        issueNumber,
        taskName: task.name,
        cacheKey,
        prUrl: recovery.prUrl ?? null,
        sessionId: surveyResult.sessionId || mergeGate.sessionId || recovery.sessionId || null,
        surveyOutput: surveyResult.output,
      });
    } catch (error: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
    }

    await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || mergeGate.sessionId);

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
      sessionId: mergeGate.sessionId,
      surveyResults: surveyResult.output,
    };
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

    const recovery = await this.runCiFailureTriage({
      task,
      issueNumber,
      cacheKey,
      prUrl: existingPr.selectedUrl,
      requiredChecks,
      issueMeta,
      botBranch,
      timedOut: false,
      repoPath: taskRepoPath,
      sessionId: task["session-id"]?.trim() || null,
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
      ...this.buildStallOptions(task, "survey"),
      ...this.buildGuardrailsOptions(task, "survey"),
      ...this.buildLoopDetectionOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    await this.recordImplementationCheckpoint(task, surveyResult.sessionId || mergeGate.sessionId);

    if (!surveyResult.success && surveyResult.loopTrip) {
      return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
    }

    if (!surveyResult.success && surveyResult.guardrailTimeout) {
      return await this.handleGuardrailTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.watchdogTimeout) {
      return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.stallTimeout) {
      return await this.handleStallTimeout(task, cacheKey, "survey", surveyResult);
    }

    try {
      await writeDxSurveyToGitHubIssues({
        github: this.github,
        targetRepo: this.repo,
        ralphRepo: "3mdistal/ralph",
        issueNumber,
        taskName: task.name,
        cacheKey,
        prUrl: recovery.prUrl ?? null,
        sessionId: surveyResult.sessionId || mergeGate.sessionId || recovery.sessionId || null,
        surveyOutput: surveyResult.output,
      });
    } catch (error: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
    }

    await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || mergeGate.sessionId);

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
           ...this.buildStallOptions(task, stage),
           ...this.buildGuardrailsOptions(task, stage),
           ...this.buildLoopDetectionOptions(task, stage),
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
           ...this.buildStallOptions(task, stage),
           ...this.buildGuardrailsOptions(task, stage),
           ...this.buildLoopDetectionOptions(task, stage),
           ...opencodeSessionOptions,
         });

    if (resumeSessionId) {
      await this.recordImplementationCheckpoint(task, recoveryResult.sessionId || resumeSessionId);
    }

    const pausedAfter = await this.pauseIfHardThrottled(task, `${stage} (post)`, recoveryResult.sessionId);
    if (pausedAfter) return pausedAfter;

    if (!recoveryResult.success) {
      if (recoveryResult.loopTrip) {
        return await this.handleLoopTrip(task, cacheKey, stage, recoveryResult);
      }

      if (recoveryResult.guardrailTimeout) {
        return await this.handleGuardrailTimeout(task, cacheKey, stage, recoveryResult, opencodeXdg);
      }
      if (recoveryResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, stage, recoveryResult, opencodeXdg);
      }

      if (recoveryResult.stallTimeout) {
        return await this.handleStallTimeout(task, cacheKey, stage, recoveryResult);
      }

      const details = summarizeBlockedDetails(recoveryResult.output);
      await this.markTaskBlocked(task, blocked.source, {
        reason: blocked.reason,
        details,
        sessionId: recoveryResult.sessionId ?? task["session-id"]?.trim(),
      });
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
      ...this.buildStallOptions(task, "survey"),
      ...this.buildGuardrailsOptions(task, "survey"),
      ...this.buildLoopDetectionOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    await this.recordImplementationCheckpoint(task, surveyResult.sessionId || mergeGate.sessionId);

    const pausedSurveyAfter = await this.pauseIfHardThrottled(
      task,
      "survey (post)",
      surveyResult.sessionId || mergeGate.sessionId
    );
    if (pausedSurveyAfter) return pausedSurveyAfter;

    if (!surveyResult.success && surveyResult.loopTrip) {
      return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
    }

    if (!surveyResult.success && surveyResult.guardrailTimeout) {
      return await this.handleGuardrailTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.watchdogTimeout) {
      return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
    }

    if (!surveyResult.success && surveyResult.stallTimeout) {
      return await this.handleStallTimeout(task, cacheKey, "survey", surveyResult);
    }

    try {
      await writeDxSurveyToGitHubIssues({
        github: this.github,
        targetRepo: this.repo,
        ralphRepo: "3mdistal/ralph",
        issueNumber,
        taskName: task.name,
        cacheKey,
        prUrl: mergeGate.prUrl ?? null,
        sessionId: surveyResult.sessionId || mergeGate.sessionId || recoverySessionId || null,
        surveyOutput: surveyResult.output,
      });
    } catch (error: any) {
      console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
    }

    await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || mergeGate.sessionId);

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
    prUrl?: string | null;
    completionKind?: "pr" | "verified";
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
      completionKind,
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
    const resolvedPrUrl = prUrl ?? undefined;
    const resolvedCompletionKind = completionKind ?? (resolvedPrUrl ? "pr" : "verified");
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
      pr: resolvedPrUrl ?? null,
      outcome: "success",
      started: startTime,
      completed: endTime,
      surveyResults,
      devex,
    });

    await this.recordCheckpoint(task, "recorded", sessionId);
    this.publishCheckpoint("recorded", { sessionId });

    await this.queue.updateTaskStatus(task, "done", {
      "completed-at": endTime.toISOString().split("T")[0],
      "session-id": "",
      "watchdog-retries": "",
      "stall-retries": "",
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
      await this.notify.notifyTaskComplete(task.name, this.repo, resolvedPrUrl);
    }
    if (logMessage) {
      console.log(`[ralph:worker:${this.repo}] ${logMessage}`);
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
      sessionId,
      pr: resolvedPrUrl,
      completionKind: resolvedCompletionKind,
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

    await this.recordCheckpoint(params.task, "pr_ready", sessionId);

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
          "stall-retries": "",
          ...(params.task["worktree-path"] ? { "worktree-path": "" } : {}),
        },
      });

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
          "stall-retries": "",
          ...(params.task["worktree-path"] ? { "worktree-path": "" } : {}),
        },
      });

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

    const mergeWhenReady = async (
      headSha: string
    ): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> => {
      // Pre-merge guard: required checks and mergeability can change between polling and the merge API call.
      try {
        const status = await this.getPullRequestChecks(prUrl);
        const summary = summarizeRequiredChecks(status.checks, REQUIRED_CHECKS);
        this.recordCiGateSummary(prUrl, summary);

        if (status.mergeStateStatus === "DIRTY") {
          const recovery = await this.runMergeConflictRecovery({
            task: params.task,
            issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
            cacheKey: params.cacheKey,
            prUrl,
            issueMeta: params.issueMeta,
            botBranch: params.botBranch,
            opencodeXdg: params.opencodeXdg,
            opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
          });
          if (recovery.status !== "success") return { ok: false, run: recovery.run };
          sessionId = recovery.sessionId || sessionId;
          return await this.mergePrWithRequiredChecks({
            ...params,
            prUrl: recovery.prUrl,
            sessionId,
          });
        }

        if (!didUpdateBranch && status.mergeStateStatus === "BEHIND") {
          console.log(`[ralph:worker:${this.repo}] PR BEHIND at merge time; updating branch ${prUrl}`);
          didUpdateBranch = true;
          try {
            await this.updatePullRequestBranch(prUrl, params.repoPath);
          } catch (updateError: any) {
            const reason = `Failed while updating PR branch before merge: ${this.formatGhError(updateError)}`;
            console.warn(`[ralph:worker:${this.repo}] ${reason}`);
            await this.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
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

          return await this.mergePrWithRequiredChecks({
            ...params,
            prUrl,
            sessionId,
          });
        }

        if (summary.status !== "success") {
          if (summary.status === "pending") {
            console.log(`[ralph:worker:${this.repo}] Required checks pending at merge time; resuming merge gate ${prUrl}`);
            return await this.mergePrWithRequiredChecks({
              ...params,
              prUrl,
              sessionId,
            });
          }

          const reason = `Merge blocked: required checks not green for ${prUrl}`;
          const details = [formatRequiredChecksForHumans(summary), "", "Merge attempt would be rejected by branch protection."].join("\n");
          await this.markTaskBlocked(params.task, "ci-failure", { reason, details, sessionId });
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

        headSha = status.headSha;
      } catch (error: any) {
        console.warn(`[ralph:worker:${this.repo}] Pre-merge guard failed (continuing): ${this.formatGhError(error)}`);
      }

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
        await this.recordCheckpoint(params.task, "merge_step_complete", sessionId);
        return { ok: true, prUrl, sessionId };
      } catch (error: any) {
        const shouldUpdateBeforeRetry =
          !didUpdateBranch && (this.isOutOfDateMergeError(error) || this.isRequiredChecksExpectedMergeError(error));

        if (shouldUpdateBeforeRetry) {
          const why = this.isRequiredChecksExpectedMergeError(error)
            ? "required checks expected"
            : "out of date with base";
          console.log(`[ralph:worker:${this.repo}] PR ${why}; updating branch ${prUrl}`);
          didUpdateBranch = true;
          try {
            await this.updatePullRequestBranch(prUrl, params.repoPath);
          } catch (updateError: any) {
            const reason = `Failed while updating PR branch before merge: ${this.formatGhError(updateError)}`;
            console.warn(`[ralph:worker:${this.repo}] ${reason}`);
            await this.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
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
            const recovery = await this.runMergeConflictRecovery({
              task: params.task,
              issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
              cacheKey: params.cacheKey,
              prUrl,
              issueMeta: params.issueMeta,
              botBranch: params.botBranch,
              opencodeXdg: params.opencodeXdg,
              opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
            });
            if (recovery.status !== "success") return { ok: false, run: recovery.run };
            sessionId = recovery.sessionId || sessionId;
            return await this.mergePrWithRequiredChecks({
              ...params,
              prUrl: recovery.prUrl,
              sessionId,
            });
          }

          if (refreshed.summary.status === "success") {
            return await mergeWhenReady(refreshed.headSha);
          }

          const ciDebug = await this.runCiFailureTriage({
            task: params.task,
            issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
            cacheKey: params.cacheKey,
            prUrl,
            requiredChecks: REQUIRED_CHECKS,
            issueMeta: params.issueMeta,
            botBranch: params.botBranch,
            timedOut: refreshed.timedOut,
            repoPath: params.repoPath,
            sessionId,
            opencodeXdg: params.opencodeXdg,
            opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
          });
          if (ciDebug.status !== "success") return { ok: false, run: ciDebug.run };
          sessionId = ciDebug.sessionId || sessionId;
          return await mergeWhenReady(ciDebug.headSha);
        }

        const diagnostic = this.formatGhError(error);
        this.recordMergeFailureArtifact(prUrl, diagnostic);

        let source: BlockedSource = "runtime-error";
        let reason = `Merge failed for ${prUrl}`;
        let details = diagnostic;

        try {
          const status = await this.getPullRequestChecks(prUrl);
          const summary = summarizeRequiredChecks(status.checks, REQUIRED_CHECKS);
          this.recordCiGateSummary(prUrl, summary);

          if (status.mergeStateStatus === "DIRTY") {
            source = "merge-conflict";
            reason = `Merge blocked by conflicts for ${prUrl}`;
            details = `mergeStateStatus=DIRTY\n\n${diagnostic}`;
          } else if (status.mergeStateStatus === "BEHIND") {
            source = "auto-update";
            reason = `Merge blocked: PR behind base for ${prUrl}`;
            details = `mergeStateStatus=BEHIND\n\n${diagnostic}`;
          } else if (summary.status !== "success") {
            source = "ci-failure";
            reason = `Merge blocked: required checks not green for ${prUrl}`;
            details = [diagnostic, "", formatRequiredChecksForHumans(summary)].join("\n").trim();
          } else if (this.isRequiredChecksExpectedMergeError(error)) {
            source = "ci-failure";
            reason = `Merge blocked: required checks expected for ${prUrl}`;
          } else if (this.isOutOfDateMergeError(error)) {
            source = "auto-update";
            reason = `Merge blocked: PR not up to date with base for ${prUrl}`;
          }
        } catch (statusError: any) {
          details = [diagnostic, "", `Additionally failed to refresh PR status: ${this.formatGhError(statusError)}`]
            .join("\n")
            .trim();
        }

        await this.markTaskBlocked(params.task, source, { reason, details, sessionId });
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
    };

    if (!didUpdateBranch && isAutoUpdateBehindEnabled(this.repo)) {
      try {
        const prState = await this.getPullRequestMergeState(prUrl);
        const guard = this.shouldAttemptProactiveUpdate(prState);
        const labelGate = getAutoUpdateBehindLabelGate(this.repo);
        const minMinutes = getAutoUpdateBehindMinMinutes(this.repo);
        const rateLimited = this.shouldRateLimitAutoUpdate(prState, minMinutes);

        if (prState.mergeStateStatus === "DIRTY") {
          const recovery = await this.runMergeConflictRecovery({
            task: params.task,
            issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
            cacheKey: params.cacheKey,
            prUrl,
            issueMeta: params.issueMeta,
            botBranch: params.botBranch,
            opencodeXdg: params.opencodeXdg,
            opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
          });
          if (recovery.status !== "success") return { ok: false, run: recovery.run };
          sessionId = recovery.sessionId || sessionId;
          return await this.mergePrWithRequiredChecks({
            ...params,
            prUrl: recovery.prUrl,
            sessionId,
          });
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
      const recovery = await this.runMergeConflictRecovery({
        task: params.task,
        issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
        cacheKey: params.cacheKey,
        prUrl,
        issueMeta: params.issueMeta,
        botBranch: params.botBranch,
        opencodeXdg: params.opencodeXdg,
        opencodeSessionOptions: params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {},
      });
      if (recovery.status !== "success") return { ok: false, run: recovery.run };
      sessionId = recovery.sessionId || sessionId;
      return await this.mergePrWithRequiredChecks({
        ...params,
        prUrl: recovery.prUrl,
        sessionId,
      });
    }

    const throttled = await this.pauseIfHardThrottled(params.task, `${params.watchdogStagePrefix}-ci-remediation`, sessionId);
    if (throttled) return { ok: false, run: throttled };

    if (checkResult.summary.status === "success") {
      return await mergeWhenReady(checkResult.headSha);
    }

    const ciDebug = await this.runCiFailureTriage({
      task: params.task,
      issueNumber: params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey,
      cacheKey: params.cacheKey,
      prUrl,
      requiredChecks: REQUIRED_CHECKS,
      issueMeta: params.issueMeta,
      botBranch: params.botBranch,
      timedOut: checkResult.timedOut,
      repoPath: params.repoPath,
      sessionId,
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
      "stall-retries": "",
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

  private async deferParentVerification(task: AgentTask, reason: string): Promise<AgentRun> {
    const patch: Record<string, string> = {
      "daemon-id": "",
      "heartbeat-at": "",
    };
    const updated = await this.queue.updateTaskStatus(task, "queued", patch);
    if (updated) {
      applyTaskPatch(task, "queued", patch);
    }

    console.log(`[ralph:worker:${this.repo}] Parent verification deferred: ${reason}`);
    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "failed",
      escalationReason: reason,
    };
  }

  private async maybeRunParentVerification(params: {
    task: AgentTask;
    issueNumber: string;
    issueMeta: IssueMetadata;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions?: RunSessionOptionsBase;
  }): Promise<AgentRun | null> {
    if (isParentVerificationDisabled()) return null;
    const parsedIssueNumber = Number(params.issueNumber);
    if (!Number.isFinite(parsedIssueNumber)) return null;

    const state = getParentVerificationState({ repo: this.repo, issueNumber: parsedIssueNumber });
    if (!state || state.status !== "pending") return null;

    const nowMs = Date.now();
    if (state.nextAttemptAtMs && state.nextAttemptAtMs > nowMs) {
      return await this.deferParentVerification(
        params.task,
        `backoff active until ${new Date(state.nextAttemptAtMs).toISOString()}`
      );
    }

    const maxAttempts = getParentVerificationMaxAttempts();
    if (state.attemptCount >= maxAttempts) {
      completeParentVerification({
        repo: this.repo,
        issueNumber: parsedIssueNumber,
        outcome: "skipped",
        details: `max attempts (${maxAttempts}) reached`,
        nowMs,
      });
      console.log(
        `[ralph:worker:${this.repo}] Parent verification skipped (attempts=${state.attemptCount} max=${maxAttempts})`
      );
      return null;
    }

    const claimed = tryClaimParentVerification({ repo: this.repo, issueNumber: parsedIssueNumber, nowMs });
    if (!claimed) {
      return await this.deferParentVerification(params.task, "pending claim not acquired");
    }

    const attemptCount = claimed.attemptCount;
    await this.recordRunLogPath(params.task, params.issueNumber, "parent-verify", "queued");
    const issueContext = await this.buildIssueContextForAgent({ repo: this.repo, issueNumber: params.issueNumber });
    const prompt = buildParentVerificationPrompt({ repo: this.repo, issueNumber: params.issueNumber, issueContext });
    let result: SessionResult;
    try {
      result = await this.session.runAgent(this.repoPath, "ralph-parent-verify", prompt, {
        repo: this.repo,
        cacheKey: `parent-verify-${params.issueNumber}`,
        introspection: {
          repo: this.repo,
          issue: params.task.issue,
          taskName: params.task.name,
          step: 0,
          stepTitle: "parent verification",
        },
        ...this.buildWatchdogOptions(params.task, "parent-verify"),
        ...this.buildStallOptions(params.task, "parent-verify"),
        ...this.buildGuardrailsOptions(params.task, "parent-verify"),
        ...this.buildLoopDetectionOptions(params.task, "parent-verify"),
        ...(params.opencodeSessionOptions ?? {}),
      });
    } catch (error: any) {
      const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
      recordParentVerificationAttemptFailure({
        repo: this.repo,
        issueNumber: parsedIssueNumber,
        attemptCount,
        nextAttemptAtMs,
        nowMs,
        details: error?.message ?? String(error),
      });
      if (attemptCount >= maxAttempts) {
        completeParentVerification({
          repo: this.repo,
          issueNumber: parsedIssueNumber,
          outcome: "skipped",
          details: "parent verification failed; proceeding to implementation",
          nowMs,
        });
        return null;
      }
      return await this.deferParentVerification(params.task, "parent verification error");
    }

    if (result.loopTrip) {
      return await this.handleLoopTrip(params.task, `parent-verify-${params.issueNumber}`, "parent-verify", result);
    }

    if (result.guardrailTimeout) {
      return await this.deferParentVerification(params.task, "parent verification guardrail tripped");
    }

    if (!result.success) {
      const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
      recordParentVerificationAttemptFailure({
        repo: this.repo,
        issueNumber: parsedIssueNumber,
        attemptCount,
        nextAttemptAtMs,
        nowMs,
        details: result.output,
      });
      if (attemptCount >= maxAttempts) {
        completeParentVerification({
          repo: this.repo,
          issueNumber: parsedIssueNumber,
          outcome: "skipped",
          details: "parent verification failed; proceeding to implementation",
          nowMs,
        });
        return null;
      }
      return await this.deferParentVerification(params.task, "parent verification failed");
    }

    const markerResult = parseLastLineJsonMarker(result.output ?? "", PARENT_VERIFY_MARKER_PREFIX);
    const parsedMarker = markerResult.ok ? parseParentVerificationMarker(markerResult.value) : null;
    if (!markerResult.ok || !parsedMarker || parsedMarker.version !== PARENT_VERIFY_MARKER_VERSION) {
      const detail = markerResult.ok ? "invalid marker payload" : markerResult.error;
      const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
      recordParentVerificationAttemptFailure({
        repo: this.repo,
        issueNumber: parsedIssueNumber,
        attemptCount,
        nextAttemptAtMs,
        nowMs,
        details: detail,
      });
      if (attemptCount >= maxAttempts) {
        completeParentVerification({
          repo: this.repo,
          issueNumber: parsedIssueNumber,
          outcome: "skipped",
          details: "parent verification marker invalid; proceeding to implementation",
          nowMs,
        });
        return null;
      }
      return await this.deferParentVerification(params.task, "parent verification marker invalid");
    }

    if (parsedMarker.work_remains) {
      completeParentVerification({
        repo: this.repo,
        issueNumber: parsedIssueNumber,
        outcome: "work_remains",
        details: parsedMarker.reason,
        nowMs,
      });
      console.log(
        `[ralph:worker:${this.repo}] Parent verification: work remains for ${params.task.issue} (${parsedMarker.reason})`
      );
      return null;
    }

    completeParentVerification({
      repo: this.repo,
      issueNumber: parsedIssueNumber,
      outcome: "no_work",
      details: parsedMarker.reason,
      nowMs,
    });

    const reason = `Parent verification: no remaining work. ${parsedMarker.reason}`;
    const wasEscalated = params.task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(params.task, "escalated", {
      "daemon-id": "",
      "heartbeat-at": "",
    });
    if (escalated) {
      applyTaskPatch(params.task, "escalated", {
        "daemon-id": "",
        "heartbeat-at": "",
      });
    }

    await this.writeEscalationWriteback(params.task, { reason, details: parsedMarker.reason, escalationType: "other" });
    await this.notify.notifyEscalation({
      taskName: params.task.name,
      taskFileName: params.task._name,
      taskPath: params.task._path,
      issue: params.task.issue,
      repo: this.repo,
      sessionId: result.sessionId || params.task["session-id"]?.trim() || undefined,
      reason,
      escalationType: "other",
      planOutput: result.output,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(params.task, {
        reason,
        sessionId: result.sessionId,
        details: result.output,
      });
    }

    return {
      taskName: params.task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: result.sessionId || undefined,
      escalationReason: reason,
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

  private getStallRetryCount(task: AgentTask): number {
    const raw = task["stall-retries"];
    const parsed = Number.parseInt(String(raw ?? "0"), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private getGuardrailRetryCount(task: AgentTask): number {
    const raw = task["guardrail-retries"];
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

  private buildStallOptions(task: AgentTask, stage: string) {
    const cfg = getConfig().stall;
    const context = `[${this.repo}] ${task.name} (${task.issue}) stage=${stage}`;
    const idleMs = cfg?.nudgeAfterMs ?? cfg?.idleMs ?? 5 * 60_000;

    return {
      stall: {
        enabled: cfg?.enabled ?? true,
        idleMs,
        context,
      },
    };
  }

  private buildGuardrailsOptions(task: AgentTask, stage: string, mode: "normal" | "checkpoint" = "normal") {
    const watchdogCfg = getConfig().watchdog;
    const bashHardMs =
      watchdogCfg?.thresholdsMs?.bash?.hardMs ??
      DEFAULT_WATCHDOG_THRESHOLDS_MS.bash.hardMs;

    const context = `[${this.repo}] ${task.name} (${task.issue}) stage=${stage}`;

    if (mode === "checkpoint") {
      return {
        guardrails: {
          enabled: true,
          wallSoftMs: 2 * 60_000,
          wallHardMs: 4 * 60_000,
          toolCallsSoft: 150,
          toolCallsHard: 250,
          softLogIntervalMs: 30_000,
          context,
        },
      };
    }

    const wallHardMs = Math.max(60_000, bashHardMs - 2 * 60_000);
    const wallSoftMs = Math.max(30_000, wallHardMs - 5 * 60_000);

    return {
      guardrails: {
        enabled: true,
        wallSoftMs,
        wallHardMs,
        toolCallsSoft: 800,
        toolCallsHard: 1400,
        softLogIntervalMs: 60_000,
        context,
      },
    };
  }

  private buildLoopDetectionOptions(task: AgentTask, stage: string) {
    void stage;
    const cfg = getRepoLoopDetectionConfig(this.repo);
    if (!cfg) return {};

    return {
      loopDetection: {
        enabled: true,
        gateMatchers: cfg.gateMatchers,
        recommendedGateCommand: cfg.recommendedGateCommand,
        thresholds: cfg.thresholds,
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

    // Source of truth is config (opencode.defaultProfile). The control file no longer controls profile.
    const requested = getRequestedOpencodeProfileName(null);

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

  private readPauseRequested(): boolean {
    return this.readPauseControl().pauseRequested;
  }

  private readPauseControl(): { pauseRequested: boolean; pauseAtCheckpoint: RalphCheckpoint | null } {
    const defaults = getConfig().control;
    const control = readControlStateSnapshot({ log: (message) => console.warn(message), defaults });

    const pauseRequested = control.pauseRequested === true;
    const pauseAtCheckpoint =
      typeof control.pauseAtCheckpoint === "string" && isRalphCheckpoint(control.pauseAtCheckpoint)
        ? (control.pauseAtCheckpoint as RalphCheckpoint)
        : null;

    return { pauseRequested, pauseAtCheckpoint };
  }

  private async waitForPauseCleared(opts?: { signal?: AbortSignal }): Promise<void> {
    const minMs = 250;
    const maxMs = 2000;
    let delayMs = minMs;

    while (this.readPauseRequested()) {
      if (opts?.signal?.aborted) return;

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, delayMs);
        if (opts?.signal) {
          const onAbort = () => {
            clearTimeout(timeout);
            resolve();
          };
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      });

      const jitter = Math.floor(Math.random() * 125);
      delayMs = Math.min(maxMs, Math.floor(delayMs * 1.6) + jitter);
    }
  }

  private getCheckpointState(task: AgentTask): CheckpointState {
    return buildCheckpointState({
      lastCheckpoint: parseCheckpointValue(task.checkpoint),
      checkpointSeq: parseCheckpointSeq(task[CHECKPOINT_SEQ_FIELD]),
      pausedAtCheckpoint: parseCheckpointValue(task[PAUSED_AT_CHECKPOINT_FIELD]),
      pauseRequested: parsePauseRequested(task[PAUSE_REQUESTED_FIELD]),
    });
  }

  private async recordCheckpoint(task: AgentTask, checkpoint: RalphCheckpoint, sessionId?: string): Promise<void> {
    const workerId = await this.formatWorkerId(task, task._path);
    const state = this.getCheckpointState(task);

    const store = {
      persist: async (nextState: CheckpointState) => {
        const patch = buildCheckpointPatch(nextState);
        try {
          const updated = await this.queue.updateTaskStatus(task, task.status, patch);
          if (!updated) {
            console.warn(
              `[ralph:worker:${this.repo}] Failed to persist checkpoint state (checkpoint=${checkpoint}, task=${task.issue})`
            );
            return;
          }
          applyTaskPatch(task, task.status, patch);
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Failed to persist checkpoint state (checkpoint=${checkpoint}, task=${task.issue}): ${
              error?.message ?? String(error)
            }`
          );
        }
      },
    };

    const pauseSource = {
      isPauseRequested: () => this.readPauseRequested(),
      waitUntilCleared: (opts?: { signal?: AbortSignal }) => this.waitForPauseCleared(opts),
    };

    const pauseAtCheckpoint = this.readPauseControl().pauseAtCheckpoint;

    const emitter = {
      emit: (event: RalphEvent, key: string) => this.checkpointEvents.emit(event, key),
      hasEmitted: (key: string) => this.checkpointEvents.hasEmitted(key),
    };

    await applyCheckpointReached({
      checkpoint,
      pauseAtCheckpoint,
      state,
      context: {
        workerId,
        repo: this.repo,
        taskId: task._path,
        sessionId: sessionId ?? (task["session-id"]?.trim() || undefined),
      },
      store,
      pauseSource,
      emitter,
    });
  }

  private async recordImplementationCheckpoint(task: AgentTask, sessionId?: string): Promise<void> {
    await this.recordCheckpoint(task, "implementation_step_complete", sessionId);
  }

  private async pauseIfGitHubRateLimited(
    task: AgentTask,
    stage: string,
    error: unknown,
    opts?: { sessionId?: string; runLogPath?: string }
  ): Promise<AgentRun | null> {
    return pauseIfGitHubRateLimited({
      task,
      stage,
      error,
      repo: this.repo,
      sessionId: opts?.sessionId,
      runLogPath: opts?.runLogPath,
      publishDashboardEvent: this.publishDashboardEvent.bind(this),
      updateTaskStatus: this.queue.updateTaskStatus,
      applyTaskPatch,
      buildAgentRunBodyPrefix,
      createAgentRun: this.createAgentRun.bind(this),
    });
  }

  private async pauseIfHardThrottled(task: AgentTask, stage: string, sessionId?: string): Promise<AgentRun | null> {
    return pauseIfHardThrottled({
      task,
      stage,
      repo: this.repo,
      throttle: this.throttle,
      getPinnedOpencodeProfileName: this.getPinnedOpencodeProfileName.bind(this),
      publishDashboardEvent: this.publishDashboardEvent.bind(this),
      updateTaskStatus: this.queue.updateTaskStatus,
      applyTaskPatch,
      buildAgentRunBodyPrefix,
      createAgentRun: this.createAgentRun.bind(this),
      sessionId,
    });
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
      const maxAttempts = 3;
      const pausedAtCheckpoint = parseCheckpointValue(task[PAUSED_AT_CHECKPOINT_FIELD]);
      let deferredReason: string | null = pausedAtCheckpoint ? "paused_at_checkpoint" : null;

      if (!deferredReason) {
        const paused = await this.pauseIfHardThrottled(task, `nudge-${stage}`, sid);
        if (paused) deferredReason = "hard_throttled";
      }

      const result = await drainQueuedNudges(
        sid,
        async (message): Promise<NudgeDeliveryOutcome> => {
          if (deferredReason) return { kind: "deferred", reason: deferredReason };
          const runLogPath = await this.recordRunLogPath(task, issueNumber, `nudge-${stage}`, "in-progress");

          const res = await this.session.continueSession(repoPath, sid, message, {
            repo: this.repo,
            cacheKey,
            runLogPath,
            ...this.buildWatchdogOptions(task, `nudge-${stage}`),
            ...this.buildStallOptions(task, `nudge-${stage}`),
            ...this.buildGuardrailsOptions(task, `nudge-${stage}`, "checkpoint"),
            ...this.buildLoopDetectionOptions(task, `nudge-${stage}`),
            ...opencodeSessionOptions,
          });
          await this.recordImplementationCheckpoint(task, res.sessionId || sid);
          return res.success ? { kind: "delivered" } : { kind: "failed", error: res.output };
        },
        {
          maxAttempts,
          onDetect: (state) => {
            if (state.pending.length === 0 && !state.blocked) return;
            this.publishDashboardEvent(
              {
                type: "message.detected",
                level: "info",
                data: { count: state.pending.length, ...(state.blocked ? { blocked: true } : {}) },
              },
              { sessionId: sid }
            );
          },
          onOutcome: (nudge, outcome) => {
            if (outcome.kind === "deferred") {
              this.publishDashboardEvent(
                {
                  type: "message.delivery.deferred",
                  level: deferredReason === "hard_throttled" ? "warn" : "info",
                  data: { id: nudge.id, reason: outcome.reason },
                },
                { sessionId: sid }
              );
              return;
            }

            const preview = buildNudgePreview(nudge.message);
            const error =
              outcome.kind === "failed"
                ? redactSensitiveText(String(outcome.error ?? "").trim()).slice(0, 400)
                : undefined;
            this.publishDashboardEvent(
              {
                type: "message.delivery.attempted",
                level: outcome.kind === "failed" ? "warn" : "info",
                data: {
                  id: nudge.id,
                  len: preview.len,
                  preview: preview.preview,
                  success: outcome.kind === "delivered",
                  ...(error ? { error } : {}),
                },
              },
              { sessionId: sid }
            );
          },
        }
      );

      if (result.blocked && result.blockedNudge) {
        this.publishDashboardEvent(
          {
            type: "message.delivery.blocked",
            level: "warn",
            data: {
              id: result.blockedNudge.id,
              failedAttempts: result.blockedNudge.failedAttempts,
              maxAttempts,
            },
          },
          { sessionId: sid }
        );
      }

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

  private async handleStallTimeout(
    task: AgentTask,
    cacheKey: string,
    stage: string,
    result: SessionResult
  ): Promise<AgentRun> {
    const cfg = getConfig().stall;
    const maxRestarts = cfg?.maxRestarts ?? 1;

    const timeout = result.stallTimeout;
    const retryCount = this.getStallRetryCount(task);
    const nextRetryCount = retryCount + 1;
    const sessionId = result.sessionId || task["session-id"]?.trim() || "";

    const idleSeconds = timeout ? Math.round(timeout.lastActivityMsAgo / 1000) : 0;
    const reason = timeout
      ? `Session stalled: no activity for ${idleSeconds}s (${stage})`
      : `Session stalled (${stage})`;

    if (retryCount === 0 && sessionId) {
      const nudgeReason = `${reason}; nudging session`;
      console.warn(`[ralph:worker:${this.repo}] Stall detected; nudging by re-queuing for resume: ${nudgeReason}`);
      await this.queue.updateTaskStatus(task, "queued", {
        "session-id": sessionId,
        "stall-retries": String(nextRetryCount),
        "blocked-source": "stall",
        "blocked-reason": nudgeReason,
        "blocked-details": timeout?.context ? `Context: ${timeout.context}` : "",
        "blocked-at": new Date().toISOString(),
        "blocked-checked-at": new Date().toISOString(),
      });

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: sessionId || undefined,
        escalationReason: nudgeReason,
      };
    }

    if (retryCount <= maxRestarts) {
      console.warn(`[ralph:worker:${this.repo}] Stall repeated; restarting with fresh session: ${reason}`);
      await this.queue.updateTaskStatus(task, "queued", {
        "session-id": "",
        "stall-retries": String(nextRetryCount),
        "blocked-source": "",
        "blocked-reason": "",
        "blocked-details": "",
        "blocked-at": "",
        "blocked-checked-at": "",
      });

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: sessionId || undefined,
        escalationReason: reason,
      };
    }

    console.log(`[ralph:worker:${this.repo}] Stall repeated after restart; escalating: ${reason}`);
    const escalationFields: Record<string, string> = {
      "stall-retries": String(nextRetryCount),
    };
    if (sessionId) escalationFields["session-id"] = sessionId;

    const wasEscalated = task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(task, "escalated", escalationFields);
    if (escalated) {
      applyTaskPatch(task, "escalated", escalationFields);
    }

    const details = [
      timeout?.context ? `Context: ${timeout.context}` : null,
      sessionId ? `Session: ${sessionId}` : null,
      task["run-log-path"]?.trim() ? `Run log: ${task["run-log-path"]?.trim()}` : null,
      sessionId ? `Events: ${getSessionEventsPath(sessionId)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const githubCommentUrl = await this.writeEscalationWriteback(task, {
      reason,
      details: details || undefined,
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
      sessionId: sessionId || undefined,
      reason,
      escalationType: "other",
      githubCommentUrl: githubCommentUrl ?? undefined,
      planOutput: result.output,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(task, {
        reason,
        sessionId: sessionId || undefined,
        details: result.output,
      });
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: sessionId || undefined,
      escalationReason: reason,
    };
  }

  private async handleGuardrailTimeout(
    task: AgentTask,
    cacheKey: string,
    stage: string,
    result: SessionResult,
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string }
  ): Promise<AgentRun> {
    const timeout = result.guardrailTimeout;
    const retryCount = this.getGuardrailRetryCount(task);
    const nextRetryCount = retryCount + 1;

    const sessionId = (result.sessionId || task["session-id"]?.trim() || "").trim();
    const worktreePath = (task["worktree-path"]?.trim() || "").trim();
    const repoPath = worktreePath && existsSync(worktreePath) ? worktreePath : this.repoPath;

    const reason = timeout
      ? timeout.reason === "tool-churn"
        ? `Session guardrail tripped: tool churn (${timeout.toolStartCount} tool starts) (${stage})`
        : `Session guardrail tripped: wall time ${Math.round(timeout.elapsedMs / 1000)}s (${stage})`
      : `Session guardrail tripped (${stage})`;

    const issueNumber = task.issue.match(/#(\d+)$/)?.[1] ?? cacheKey;
    const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

    if (retryCount === 0) {
      let checkpointOutput: string | null = null;

      if (sessionId) {
        const message = [
          "Long-running guardrail tripped. Do NOT continue expanding scope.",
          "",
          "Do ONE of the following:",
          "1) If you have meaningful partial progress: open a PR targeting bot/integration now and reply with the PR URL.",
          "2) If not ready for a PR: write a small checkpoint plan (<=8 bullets) with exact next commands and file paths.",
          "",
          "Then stop.",
        ].join("\n");

        try {
          const runLogPath = await this.recordRunLogPath(task, issueNumber, `guardrail-${stage}`, "in-progress");
          const checkpointResult = await this.session.continueSession(repoPath, sessionId, message, {
            repo: this.repo,
            cacheKey,
            runLogPath,
            ...this.buildWatchdogOptions(task, `guardrail-${stage}`),
            ...this.buildStallOptions(task, `guardrail-${stage}`),
            ...this.buildGuardrailsOptions(task, `guardrail-${stage}`, "checkpoint"),
            ...this.buildLoopDetectionOptions(task, `guardrail-${stage}`),
            ...opencodeSessionOptions,
          });

          await this.recordImplementationCheckpoint(task, checkpointResult.sessionId || sessionId);
          checkpointOutput = checkpointResult.output;
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Guardrail checkpoint prompt failed for ${task.issue}: ${error?.message ?? String(error)}`
          );
        }
      }

      const truncated = checkpointOutput
        ? redactSensitiveText(String(checkpointOutput)).trim().slice(0, 800)
        : null;

      const details = [
        timeout?.context ? `Context: ${timeout.context}` : null,
        timeout?.reason ? `Reason: ${timeout.reason}` : null,
        timeout?.elapsedMs != null ? `Elapsed: ${Math.round(timeout.elapsedMs / 1000)}s` : null,
        timeout?.toolStartCount != null ? `Tool starts: ${timeout.toolStartCount}` : null,
        truncated ? `Checkpoint output (truncated): ${truncated}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      console.warn(`[ralph:worker:${this.repo}] Guardrail tripped; re-queuing for resume: ${reason}`);
      await this.queue.updateTaskStatus(task, "queued", {
        "session-id": sessionId,
        "guardrail-retries": String(nextRetryCount),
        "blocked-source": "guardrail",
        "blocked-reason": reason,
        "blocked-details": details,
        "blocked-at": new Date().toISOString(),
        "blocked-checked-at": new Date().toISOString(),
      });

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        sessionId: sessionId || undefined,
        escalationReason: reason,
      };
    }

    console.log(`[ralph:worker:${this.repo}] Guardrail repeated; escalating: ${reason}`);

    const escalationFields: Record<string, string> = {
      "guardrail-retries": String(nextRetryCount),
    };
    if (sessionId) escalationFields["session-id"] = sessionId;

    const wasEscalated = task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(task, "escalated", escalationFields);
    if (escalated) {
      applyTaskPatch(task, "escalated", escalationFields);
    }

    const details = [
      timeout?.context ? `Context: ${timeout.context}` : null,
      timeout?.reason ? `Reason: ${timeout.reason}` : null,
      timeout?.elapsedMs != null ? `Elapsed: ${Math.round(timeout.elapsedMs / 1000)}s` : null,
      timeout?.toolStartCount != null ? `Tool starts: ${timeout.toolStartCount}` : null,
      sessionId ? `Session: ${sessionId}` : null,
      task["run-log-path"]?.trim() ? `Run log: ${task["run-log-path"]?.trim()}` : null,
      sessionId ? `Events: ${getSessionEventsPath(sessionId)}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const githubCommentUrl = await this.writeEscalationWriteback(task, {
      reason,
      details: details || undefined,
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
      sessionId: sessionId || undefined,
      reason,
      escalationType: "other",
      githubCommentUrl: githubCommentUrl ?? undefined,
      planOutput: result.output,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(task, {
        reason,
        sessionId: sessionId || undefined,
        details: result.output,
      });
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: sessionId || undefined,
      escalationReason: reason,
    };
  }

  private async handleLoopTrip(task: AgentTask, cacheKey: string, stage: string, result: SessionResult): Promise<AgentRun> {
    const trip = result.loopTrip;
    const sessionId = result.sessionId || task["session-id"]?.trim() || "";
    const worktreePath = task["worktree-path"]?.trim() || "";

    const reason = trip ? `Loop detection tripped: ${trip.reason} (${stage})` : `Loop detection tripped (${stage})`;

    let fallbackTouchedFiles: string[] | null = null;
    if (trip && trip.metrics.topFiles.length === 0 && worktreePath) {
      try {
        const names = (await $`git diff --name-only`.cwd(worktreePath).quiet()).stdout
          .toString()
          .split("\n")
          .map((v: string) => v.trim())
          .filter(Boolean);
        fallbackTouchedFiles = names.slice(0, 10);
      } catch {
        // ignore
      }
    }

    const loopCfg = getRepoLoopDetectionConfig(this.repo);
    const recommendedGateCommand = loopCfg?.recommendedGateCommand ?? "bun test";

    const details =
      trip != null
        ? buildLoopTripDetails({
            trip,
            recommendedGateCommand,
            lastDiagnosticSnippet: result.output,
            fallbackTouchedFiles,
          })
        : undefined;

    const escalationFields: Record<string, string> = {};
    if (sessionId) escalationFields["session-id"] = sessionId;

    const wasEscalated = task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(task, "escalated", escalationFields);
    if (escalated) {
      applyTaskPatch(task, "escalated", escalationFields);
    }

    const githubCommentUrl = await this.writeEscalationWriteback(task, {
      reason,
      details,
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
      sessionId: sessionId || undefined,
      reason,
      escalationType: "other",
      githubCommentUrl: githubCommentUrl ?? undefined,
      planOutput: result.output,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(task, {
        reason,
        sessionId: sessionId || undefined,
        details: result.output,
      });
    }

    // Best-effort: clear per-task cache after a loop-trip, since we killed the session.
    try {
      await rm(this.session.getRalphXdgCacheHome(this.repo, cacheKey), { recursive: true, force: true });
    } catch {
      // ignore
    }

    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: sessionId || undefined,
      escalationReason: reason,
    };
  }

  async resumeTask(task: AgentTask, opts?: { resumeMessage?: string; repoSlot?: number | null }): Promise<AgentRun> {
    const startTime = new Date();

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
    const allocatedSlot = this.resolveAssignedRepoSlot(task, opts?.repoSlot);

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
        await this.markIssueInProgressForOpenPrBestEffort(task, existingPr.selectedUrl);
        if (existingPr.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPr.duplicates.join(", ")}`
          );
        }
      }

      const pausedBefore = await this.pauseIfHardThrottled(task, "resume", existingSessionId);
      if (pausedBefore) return pausedBefore;

      return await this.withRunContext(task, "resume", async () => {
      this.publishDashboardEvent(
        {
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
        },
        { sessionId: existingSessionId, workerId: eventWorkerId }
      );

      this.logWorker(`Resuming task: ${task.name}`, { sessionId: existingSessionId, workerId: eventWorkerId });

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
        ...this.buildStallOptions(task, "resume"),
        ...this.buildGuardrailsOptions(task, "resume"),
        ...this.buildLoopDetectionOptions(task, "resume"),
        ...opencodeSessionOptions,
      });

      await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

      const pausedAfter = await this.pauseIfHardThrottled(task, "resume (post)", buildResult.sessionId || existingSessionId);
      if (pausedAfter) return pausedAfter;

      if (!buildResult.success) {
        if (buildResult.loopTrip) {
          return await this.handleLoopTrip(task, cacheKey, "resume", buildResult);
        }
        if (buildResult.guardrailTimeout) {
          return await this.handleGuardrailTimeout(task, cacheKey, "resume", buildResult, opencodeXdg);
        }
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume", buildResult, opencodeXdg);
        }

        if (buildResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "resume", buildResult);
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

      this.publishCheckpoint("implementation_step_complete", {
        sessionId: buildResult.sessionId || existingSessionId || undefined,
      });

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
      let prCreateLeaseKey: string | null = null;

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
              ...this.buildStallOptions(task, "resume-loop-break"),
              ...this.buildGuardrailsOptions(task, "resume-loop-break", "checkpoint"),
              ...this.buildLoopDetectionOptions(task, "resume-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

          const pausedLoopBreakAfter = await this.pauseIfHardThrottled(
            task,
            "resume loop-break (post)",
            buildResult.sessionId || existingSessionId
          );
          if (pausedLoopBreakAfter) return pausedLoopBreakAfter;

            if (!buildResult.success) {
              if (buildResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "resume-loop-break", buildResult);
              }
              if (buildResult.guardrailTimeout) {
                return await this.handleGuardrailTimeout(task, cacheKey, "resume-loop-break", buildResult, opencodeXdg);
              }
              if (buildResult.watchdogTimeout) {
                return await this.handleWatchdogTimeout(task, cacheKey, "resume-loop-break", buildResult, opencodeXdg);
              }

            if (buildResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "resume-loop-break", buildResult);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          this.publishCheckpoint("implementation_step_complete", {
            sessionId: buildResult.sessionId || existingSessionId || undefined,
          });

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
          await this.markIssueInProgressForOpenPrBestEffort(task, canonical.selectedUrl);
          if (canonical.duplicates.length > 0) {
            console.log(
              `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
            );
          }
          prRecoveryDiagnostics = [prRecoveryDiagnostics, canonical.diagnostics.join("\n")].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
          break;
        }

        if (!prCreateLeaseKey) {
          const lease = this.tryClaimPrCreateLease({
            task,
            issueNumber,
            botBranch,
            sessionId: buildResult.sessionId,
            stage: "resume",
          });

          if (!lease.claimed) {
            console.warn(
              `[ralph:worker:${this.repo}] PR-create lease already held; waiting instead of creating duplicate (lease=${lease.key})`
            );

            const waited = await this.waitForExistingPrDuringPrCreateConflict({
              issueNumber,
              maxWaitMs: PR_CREATE_CONFLICT_WAIT_MS,
            });

            if (waited?.selectedUrl) {
              await this.markIssueInProgressForOpenPrBestEffort(task, waited.selectedUrl);
              prRecoveryDiagnostics = [prRecoveryDiagnostics, waited.diagnostics.join("\n")].filter(Boolean).join("\n\n");
              prUrl = this.updateOpenPrSnapshot(task, prUrl, waited.selectedUrl);
              break;
            }

            const throttled = await this.throttleForPrCreateConflict({
              task,
              issueNumber,
              sessionId: buildResult.sessionId,
              leaseKey: lease.key,
              existingCreatedAt: lease.existingCreatedAt,
              stage: "resume",
            });
            if (throttled) return throttled;

            prRecoveryDiagnostics = [
              prRecoveryDiagnostics,
              `PR-create conflict: lease=${lease.key} (createdAt=${lease.existingCreatedAt ?? "unknown"})`,
            ]
              .filter(Boolean)
              .join("\n\n");
            break;
          }

          prCreateLeaseKey = lease.key;
          console.log(`[ralph:worker:${this.repo}] pr_mode=create lease=${lease.key}`);
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
          ...this.buildStallOptions(task, "resume-continue"),
          ...this.buildGuardrailsOptions(task, "resume-continue", "checkpoint"),
          ...this.buildLoopDetectionOptions(task, "resume-continue"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, buildResult.sessionId || existingSessionId);

        const pausedContinueAfter = await this.pauseIfHardThrottled(
          task,
          "resume continue (post)",
          buildResult.sessionId || existingSessionId
        );
        if (pausedContinueAfter) return pausedContinueAfter;

        if (!buildResult.success) {
          if (buildResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "resume-continue", buildResult);
          }
          if (buildResult.guardrailTimeout) {
            return await this.handleGuardrailTimeout(task, cacheKey, "resume-continue", buildResult, opencodeXdg);
          }
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "resume-continue", buildResult, opencodeXdg);
          }

          if (buildResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "resume-continue", buildResult);
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
          this.publishCheckpoint("implementation_step_complete", {
            sessionId: buildResult.sessionId || existingSessionId || undefined,
          });
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

      if (prUrl && prCreateLeaseKey) {
        try {
          deleteIdempotencyKey(prCreateLeaseKey);
        } catch {
          // ignore
        }
        prCreateLeaseKey = null;
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

      this.publishCheckpoint("pr_ready", { sessionId: buildResult.sessionId || existingSessionId || undefined });

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

      this.publishCheckpoint("merge_step_complete", {
        sessionId: mergeGate.sessionId || buildResult.sessionId || existingSessionId || undefined,
      });

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
        ...this.buildStallOptions(task, "resume-survey"),
        ...this.buildGuardrailsOptions(task, "resume-survey"),
        ...this.buildLoopDetectionOptions(task, "resume-survey"),
        ...opencodeSessionOptions,
      });

      await this.recordImplementationCheckpoint(task, surveyResult.sessionId || buildResult.sessionId || existingSessionId);


      const pausedSurveyAfter = await this.pauseIfHardThrottled(
        task,
        "resume survey (post)",
        surveyResult.sessionId || buildResult.sessionId || existingSessionId
      );
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.loopTrip) {
          return await this.handleLoopTrip(task, cacheKey, "resume-survey", surveyResult);
        }
        if (surveyResult.guardrailTimeout) {
          return await this.handleGuardrailTimeout(task, cacheKey, "resume-survey", surveyResult, opencodeXdg);
        }
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "resume-survey", surveyResult, opencodeXdg);
        }

        if (surveyResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "resume-survey", surveyResult);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      try {
        await writeDxSurveyToGitHubIssues({
          github: this.github,
          targetRepo: this.repo,
          ralphRepo: "3mdistal/ralph",
          issueNumber,
          taskName: task.name,
          cacheKey,
          prUrl: prUrl ?? null,
          sessionId: surveyResult.sessionId || buildResult.sessionId || existingSessionId || null,
          surveyOutput: surveyResult.output,
        });
      } catch (error: any) {
        console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
      }

      await this.recordCheckpoint(
        task,
        "survey_complete",
        surveyResult.sessionId || buildResult.sessionId || existingSessionId
      );
      this.publishCheckpoint("survey_complete", {
        sessionId: surveyResult.sessionId || buildResult.sessionId || existingSessionId || undefined,
      });

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
        const paused = await this.pauseIfGitHubRateLimited(task, "resume", error, {
          sessionId: task["session-id"]?.trim() || undefined,
          runLogPath: task["run-log-path"]?.trim() || undefined,
        });
        if (paused) return paused;

        const reason = error?.message ?? String(error);
        const details = error?.stack ?? reason;
        await this.markTaskBlocked(task, "runtime-error", { reason, details });
      }

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      // slot release handled by scheduler-level reservation
    }
  }

  private async maybeHandleParentVerification(params: {
    task: AgentTask;
    issueNumber: string;
    issueMeta: IssueMetadata;
    cacheKey: string;
    startTime: Date;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions?: RunSessionOptionsBase;
    worktreePath?: string;
    workerId?: string;
    allocatedSlot?: number | null;
  }): Promise<AgentRun | null> {
    const issueRef = parseIssueRef(params.task.issue, params.task.repo);
    if (!issueRef) return null;

    const snapshot = await this.getRelationshipSnapshot(issueRef, true);
    if (!snapshot) return null;

    const signals = this.buildRelationshipSignals(snapshot);
    const eligibility = evaluateParentVerificationEligibility({ snapshot, signals });
    if (eligibility.decision !== "verify") {
      console.log(
        `[ralph:worker:${this.repo}] Parent verification skipped for ${params.task.issue}: ${eligibility.reason}`
      );
      return null;
    }

    const issueUrl =
      params.issueMeta.url ?? `https://github.com/${issueRef.repo}/issues/${issueRef.number}`;
    const evidence = await collectParentVerificationEvidence({ childIssues: eligibility.childIssues });
    if (evidence.diagnostics.length > 0) {
      console.log(
        `[ralph:worker:${this.repo}] Parent verification evidence diagnostics for ${params.task.issue}:\n${evidence.diagnostics.join(
          "\n"
        )}`
      );
    }

    const prompt = buildParentVerificationPromptLegacy({
      repo: this.repo,
      issueNumber: Number(params.issueNumber),
      issueUrl,
      childIssues: eligibility.childIssues,
      evidence: evidence.evidence,
    });

    const verifyWorktreePath = this.buildParentVerificationWorktreePath(params.issueNumber);
    const verifyCacheKey = `${params.cacheKey}-parent-verify`;
    let dirtyWorktree = false;

    try {
      try {
        await this.ensureGitWorktree(verifyWorktreePath);
      } catch (error: any) {
        console.warn(
          `[ralph:worker:${this.repo}] Failed to prepare parent verification worktree: ${error?.message ?? String(error)}`
        );
        return null;
      }

      const preStatus = await this.getWorktreeStatusPorcelain(verifyWorktreePath);
      if (preStatus) {
        console.warn(
          `[ralph:worker:${this.repo}] Parent verification worktree not clean; skipping verification for ${params.task.issue}.`
        );
        dirtyWorktree = true;
        return null;
      }

      const pausedVerify = await this.pauseIfHardThrottled(params.task, "parent verification");
      if (pausedVerify) return pausedVerify;

      const verifyRunLogPath = await this.recordRunLogPath(
        params.task,
        params.issueNumber,
        "parent-verify",
        "starting"
      );

      const verifyResult = await this.session.runAgent(verifyWorktreePath, "general", prompt, {
        repo: this.repo,
        cacheKey: verifyCacheKey,
        runLogPath: verifyRunLogPath,
        introspection: {
          repo: this.repo,
          issue: params.task.issue,
          taskName: params.task.name,
          step: 1,
          stepTitle: "parent verification",
        },
        ...this.buildWatchdogOptions(params.task, "parent-verify"),
        ...this.buildStallOptions(params.task, "parent-verify"),
        ...this.buildGuardrailsOptions(params.task, "parent-verify"),
        ...this.buildLoopDetectionOptions(params.task, "parent-verify"),
        ...(params.opencodeSessionOptions ?? {}),
      });

      const pausedAfterVerify = await this.pauseIfHardThrottled(
        params.task,
        "parent verification (post)",
        verifyResult.sessionId
      );
      if (pausedAfterVerify) return pausedAfterVerify;

      if (verifyResult.loopTrip) {
        return await this.handleLoopTrip(params.task, verifyCacheKey, "parent-verify", verifyResult);
      }

      if (verifyResult.guardrailTimeout) {
        console.warn(
          `[ralph:worker:${this.repo}] Parent verification guardrail tripped; continuing with normal flow for ${params.task.issue}.`
        );
        return null;
      }

      if (!verifyResult.success && verifyResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(params.task, verifyCacheKey, "parent-verify", verifyResult, params.opencodeXdg);
      }

      if (!verifyResult.success && verifyResult.stallTimeout) {
        return await this.handleStallTimeout(params.task, verifyCacheKey, "parent-verify", verifyResult);
      }

      const postStatus = await this.getWorktreeStatusPorcelain(verifyWorktreePath);
      if (postStatus) {
        console.warn(
          `[ralph:worker:${this.repo}] Parent verification dirtied its worktree; skipping verification for ${params.task.issue}.`
        );
        dirtyWorktree = true;
        return null;
      }

      if (!verifyResult.success) {
        console.warn(
          `[ralph:worker:${this.repo}] Parent verification run failed; continuing with normal flow for ${params.task.issue}.`
        );
        return null;
      }

      if (verifyResult.sessionId) {
        await this.queue.updateTaskStatus(params.task, "in-progress", {
          "session-id": verifyResult.sessionId,
          ...(params.workerId ? { "worker-id": params.workerId } : {}),
          ...(typeof params.allocatedSlot === "number" ? { "repo-slot": String(params.allocatedSlot) } : {}),
        });
      }

      const parsed = parseParentVerificationOutput(verifyResult.output);
      if (!parsed.satisfied) {
        console.log(
          `[ralph:worker:${this.repo}] Parent verification not satisfied for ${params.task.issue}: ${parsed.reason ?? "unsatisfied"}`
        );
        return null;
      }

      const writeback = await writeParentVerificationToGitHub(
        {
          repo: this.repo,
          issueNumber: Number(params.issueNumber),
          childIssues: eligibility.childIssues,
          evidence: evidence.evidence,
        },
        { github: this.github }
      );

      if (!writeback.ok) {
        const reason = writeback.error ?? "Parent verification writeback failed";
        return await this.escalateParentVerificationFailure(params.task, reason, verifyResult.sessionId);
      }

      recordIssueSnapshot({
        repo: issueRef.repo,
        issue: params.task.issue,
        title: params.issueMeta.title,
        state: "CLOSED",
        url: issueUrl,
      });

      return await this.finalizeTaskSuccess({
        task: params.task,
        prUrl: null,
        completionKind: "verified",
        sessionId: verifyResult.sessionId || params.task["session-id"]?.trim() || "",
        startTime: params.startTime,
        cacheKey: verifyCacheKey,
        opencodeXdg: params.opencodeXdg,
        worktreePath: params.worktreePath,
        workerId: params.workerId,
        repoSlot: typeof params.allocatedSlot === "number" ? String(params.allocatedSlot) : undefined,
        notify: true,
        logMessage: `Task verified without changes: ${params.task.name}`,
      });
    } finally {
      if (dirtyWorktree) {
        console.warn(
          `[ralph:worker:${this.repo}] Parent verification worktree left for inspection: ${verifyWorktreePath}`
        );
      }

      if (!dirtyWorktree) {
        try {
          await this.cleanupGitWorktree(verifyWorktreePath);
        } catch (error: any) {
          console.warn(
            `[ralph:worker:${this.repo}] Failed to cleanup parent verification worktree: ${error?.message ?? String(error)}`
          );
        }
      }
    }
  }

  async processTask(task: AgentTask, opts?: { repoSlot?: number | null }): Promise<AgentRun> {
    const startTime = new Date();

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
      allocatedSlot = this.resolveAssignedRepoSlot(task, opts?.repoSlot);

      const pausedPreStart = await this.pauseIfHardThrottled(task, "pre-start");
      if (pausedPreStart) return pausedPreStart;

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "start");
      if (resolvedOpencode.error) throw new Error(resolvedOpencode.error);

      const opencodeProfileName = resolvedOpencode.profileName;
      const opencodeXdg = resolvedOpencode.opencodeXdg;
      const opencodeSessionOptions = opencodeXdg ? { opencodeXdg } : {};

      const parentVerifyRun = await this.maybeRunParentVerification({
        task,
        issueNumber,
        issueMeta,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (parentVerifyRun) return parentVerifyRun;

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

      await this.assertRepoRootClean(task, "start");

      return await this.withRunContext(task, "process", async () => {
      this.publishDashboardEvent(
        {
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
        },
        { sessionId: task["session-id"]?.trim() || undefined, workerId }
      );

      this.logWorker(`Starting task: ${task.name}`, { workerId });

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

      const baseIssueContext = await this.buildIssueContextForAgent({ repo: this.repo, issueNumber });
      let issueContext = baseIssueContext;
      const issueRef = parseIssueRef(task.issue, this.repo);
      if (issueRef) {
        const dossierText = await this.buildChildCompletionDossierText({ issueRef });
        if (dossierText) {
          issueContext = appendChildDossierToIssueContext(baseIssueContext, dossierText);
        }
      }
      const plannerPrompt = buildPlannerPrompt({ repo: this.repo, issueNumber, issueContext });
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
        ...this.buildStallOptions(task, "plan"),
        ...this.buildGuardrailsOptions(task, "plan"),
        ...this.buildLoopDetectionOptions(task, "plan"),
        ...opencodeSessionOptions,
      });

      const pausedAfterPlan = await this.pauseIfHardThrottled(task, "plan (post)", planResult.sessionId);
      if (pausedAfterPlan) return pausedAfterPlan;

      if (!planResult.success && planResult.watchdogTimeout) {
        return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
      }

      if (!planResult.success && planResult.stallTimeout) {
        return await this.handleStallTimeout(task, cacheKey, "plan", planResult);
      }

      if (!planResult.success && planResult.guardrailTimeout) {
        return await this.handleGuardrailTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
      }

      if (!planResult.success && planResult.loopTrip) {
        return await this.handleLoopTrip(task, cacheKey, "plan", planResult);
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
          ...this.buildStallOptions(task, "plan-retry"),
          ...this.buildGuardrailsOptions(task, "plan-retry"),
          ...this.buildLoopDetectionOptions(task, "plan-retry"),
          ...opencodeSessionOptions,
        });
      }

      const pausedAfterPlanRetry = await this.pauseIfHardThrottled(task, "plan (post retry)", planResult.sessionId);
      if (pausedAfterPlanRetry) return pausedAfterPlanRetry;

      if (!planResult.success) {
        if (planResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
        }

        if (planResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "plan", planResult);
        }

        if (planResult.guardrailTimeout) {
          return await this.handleGuardrailTimeout(task, cacheKey, "plan", planResult, opencodeXdg);
        }

        const reason = `planner failed: ${planResult.output}`;
        const details = planResult.output;

        await this.markTaskBlocked(task, "runtime-error", {
          reason,
          details,
          sessionId: planResult.sessionId,
          runLogPath: planRunLogPath,
        });
        return {
          taskName: task.name,
          repo: this.repo,
          outcome: "failed",
          sessionId: planResult.sessionId,
          escalationReason: reason,
        };
      }

      // Persist OpenCode session ID for crash recovery
      if (planResult.sessionId) {
        await this.queue.updateTaskStatus(task, "in-progress", {
          "session-id": planResult.sessionId,
          ...(workerId ? { "worker-id": workerId } : {}),
          ...(typeof allocatedSlot === "number" ? { "repo-slot": String(allocatedSlot) } : {}),
        });
      }

      await this.recordCheckpoint(task, "planned", planResult.sessionId);
      this.publishCheckpoint("planned", { sessionId: planResult.sessionId || undefined });

      // 5. Parse routing decision
      let routing = parseRoutingDecision(planResult.output);
      let hasGap = hasProductGap(planResult.output);

      await this.recordCheckpoint(task, "routed", planResult.sessionId);

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
          ...this.buildStallOptions(task, "consult devex"),
          ...this.buildGuardrailsOptions(task, "consult devex", "checkpoint"),
          ...this.buildLoopDetectionOptions(task, "consult devex"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, devexResult.sessionId || baseSessionId);

        const pausedAfterDevexConsult = await this.pauseIfHardThrottled(
          task,
          "consult devex (post)",
          devexResult.sessionId || baseSessionId
        );
        if (pausedAfterDevexConsult) return pausedAfterDevexConsult;

        if (!devexResult.success) {
          if (devexResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "consult devex", devexResult);
          }
          if (devexResult.guardrailTimeout) {
            return await this.handleGuardrailTimeout(task, cacheKey, "consult devex", devexResult, opencodeXdg);
          }
          if (devexResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "consult devex", devexResult);
          }
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
            ...this.buildStallOptions(task, "reroute after devex"),
            ...this.buildGuardrailsOptions(task, "reroute after devex", "checkpoint"),
            ...this.buildLoopDetectionOptions(task, "reroute after devex"),
            ...opencodeSessionOptions,
          });

          await this.recordImplementationCheckpoint(task, rerouteResult.sessionId || baseSessionId);

          const pausedAfterReroute = await this.pauseIfHardThrottled(
            task,
            "reroute after devex (post)",
            rerouteResult.sessionId || baseSessionId
          );
          if (pausedAfterReroute) return pausedAfterReroute;

          if (!rerouteResult.success) {
            if (rerouteResult.loopTrip) {
              return await this.handleLoopTrip(task, cacheKey, "reroute after devex", rerouteResult);
            }
            if (rerouteResult.guardrailTimeout) {
              return await this.handleGuardrailTimeout(task, cacheKey, "reroute after devex", rerouteResult, opencodeXdg);
            }
            if (rerouteResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "reroute after devex", rerouteResult);
            }
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
      this.publishCheckpoint("routed", { sessionId: planResult.sessionId || undefined });
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
        await this.markIssueInProgressForOpenPrBestEffort(task, existingPr.selectedUrl);
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
        ...this.buildStallOptions(task, "build"),
        ...this.buildGuardrailsOptions(task, "build"),
        ...this.buildLoopDetectionOptions(task, "build"),
        ...opencodeSessionOptions,
      });

      await this.recordImplementationCheckpoint(task, buildResult.sessionId || planResult.sessionId);

      const pausedAfterBuild = await this.pauseIfHardThrottled(task, "build (post)", buildResult.sessionId || planResult.sessionId);
      if (pausedAfterBuild) return pausedAfterBuild;

      if (!buildResult.success) {
        if (buildResult.loopTrip) {
          return await this.handleLoopTrip(task, cacheKey, "build", buildResult);
        }
        if (buildResult.guardrailTimeout) {
          return await this.handleGuardrailTimeout(task, cacheKey, "build", buildResult, opencodeXdg);
        }
        if (buildResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "build", buildResult, opencodeXdg);
        }

        if (buildResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "build", buildResult);
        }
        throw new Error(`Build failed: ${buildResult.output}`);
      }

      this.publishCheckpoint("implementation_step_complete", {
        sessionId: buildResult.sessionId || planResult.sessionId || undefined,
      });

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
      let prCreateLeaseKey: string | null = null;

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
              ...this.buildStallOptions(task, "build-loop-break"),
              ...this.buildGuardrailsOptions(task, "build-loop-break", "checkpoint"),
              ...this.buildLoopDetectionOptions(task, "build-loop-break"),
              ...opencodeSessionOptions,
            }
          );

          await this.recordImplementationCheckpoint(task, buildResult.sessionId);

          const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
          if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

            if (!buildResult.success) {
              if (buildResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "build-loop-break", buildResult);
              }
              if (buildResult.guardrailTimeout) {
                return await this.handleGuardrailTimeout(task, cacheKey, "build-loop-break", buildResult, opencodeXdg);
              }
              if (buildResult.watchdogTimeout) {
                return await this.handleWatchdogTimeout(task, cacheKey, "build-loop-break", buildResult, opencodeXdg);
              }

            if (buildResult.stallTimeout) {
              return await this.handleStallTimeout(task, cacheKey, "build-loop-break", buildResult);
            }
            console.warn(`[ralph:worker:${this.repo}] Loop-break nudge failed: ${buildResult.output}`);
            break;
          }

          this.publishCheckpoint("implementation_step_complete", {
            sessionId: buildResult.sessionId || planResult.sessionId || undefined,
          });

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
          await this.markIssueInProgressForOpenPrBestEffort(task, canonical.selectedUrl);
          if (canonical.duplicates.length > 0) {
            console.log(
              `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${canonical.duplicates.join(", ")}`
            );
          }
          prRecoveryDiagnostics = [prRecoveryDiagnostics, canonical.diagnostics.join("\n")].filter(Boolean).join("\n\n");
          prUrl = this.updateOpenPrSnapshot(task, prUrl, canonical.selectedUrl);
          break;
        }

        if (!prCreateLeaseKey) {
          const lease = this.tryClaimPrCreateLease({
            task,
            issueNumber,
            botBranch,
            sessionId: buildResult.sessionId,
            stage: "build",
          });

          if (!lease.claimed) {
            console.warn(
              `[ralph:worker:${this.repo}] PR-create lease already held; waiting instead of creating duplicate (lease=${lease.key})`
            );

            const waited = await this.waitForExistingPrDuringPrCreateConflict({
              issueNumber,
              maxWaitMs: PR_CREATE_CONFLICT_WAIT_MS,
            });

            if (waited?.selectedUrl) {
              await this.markIssueInProgressForOpenPrBestEffort(task, waited.selectedUrl);
              prRecoveryDiagnostics = [prRecoveryDiagnostics, waited.diagnostics.join("\n")].filter(Boolean).join("\n\n");
              prUrl = this.updateOpenPrSnapshot(task, prUrl, waited.selectedUrl);
              break;
            }

            const throttled = await this.throttleForPrCreateConflict({
              task,
              issueNumber,
              sessionId: buildResult.sessionId,
              leaseKey: lease.key,
              existingCreatedAt: lease.existingCreatedAt,
              stage: "build",
            });
            if (throttled) return throttled;

            prRecoveryDiagnostics = [
              prRecoveryDiagnostics,
              `PR-create conflict: lease=${lease.key} (createdAt=${lease.existingCreatedAt ?? "unknown"})`,
            ]
              .filter(Boolean)
              .join("\n\n");
            break;
          }

          prCreateLeaseKey = lease.key;
          console.log(`[ralph:worker:${this.repo}] pr_mode=create lease=${lease.key}`);
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
          ...this.buildStallOptions(task, "build-continue"),
          ...this.buildGuardrailsOptions(task, "build-continue", "checkpoint"),
          ...this.buildLoopDetectionOptions(task, "build-continue"),
          ...opencodeSessionOptions,
        });

        await this.recordImplementationCheckpoint(task, buildResult.sessionId);

        const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
        if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

        if (!buildResult.success) {
          if (buildResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "build-continue", buildResult);
          }
          if (buildResult.guardrailTimeout) {
            return await this.handleGuardrailTimeout(task, cacheKey, "build-continue", buildResult, opencodeXdg);
          }
          if (buildResult.watchdogTimeout) {
            return await this.handleWatchdogTimeout(task, cacheKey, "build-continue", buildResult, opencodeXdg);
          }

          if (buildResult.stallTimeout) {
            return await this.handleStallTimeout(task, cacheKey, "build-continue", buildResult);
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
          this.publishCheckpoint("implementation_step_complete", {
            sessionId: buildResult.sessionId || planResult.sessionId || undefined,
          });
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

      if (prUrl && prCreateLeaseKey) {
        try {
          deleteIdempotencyKey(prCreateLeaseKey);
        } catch {
          // ignore
        }
        prCreateLeaseKey = null;
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

      this.publishCheckpoint("pr_ready", { sessionId: buildResult.sessionId || planResult.sessionId || undefined });

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

      this.publishCheckpoint("merge_step_complete", {
        sessionId: mergeGate.sessionId || buildResult.sessionId || planResult.sessionId || undefined,
      });

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
        ...this.buildStallOptions(task, "survey"),
        ...this.buildGuardrailsOptions(task, "survey"),
        ...this.buildLoopDetectionOptions(task, "survey"),
        ...opencodeSessionOptions,
      });

      await this.recordImplementationCheckpoint(task, surveyResult.sessionId || buildResult.sessionId);

      const pausedSurveyAfter = await this.pauseIfHardThrottled(task, "survey (post)", surveyResult.sessionId || buildResult.sessionId);
      if (pausedSurveyAfter) return pausedSurveyAfter;

      if (!surveyResult.success) {
        if (surveyResult.loopTrip) {
          return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
        }
        if (surveyResult.guardrailTimeout) {
          return await this.handleGuardrailTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
        }
        if (surveyResult.watchdogTimeout) {
          return await this.handleWatchdogTimeout(task, cacheKey, "survey", surveyResult, opencodeXdg);
        }

        if (surveyResult.stallTimeout) {
          return await this.handleStallTimeout(task, cacheKey, "survey", surveyResult);
        }
        console.warn(`[ralph:worker:${this.repo}] Survey may have failed: ${surveyResult.output}`);
      }

      try {
        await writeDxSurveyToGitHubIssues({
          github: this.github,
          targetRepo: this.repo,
          ralphRepo: "3mdistal/ralph",
          issueNumber,
          taskName: task.name,
          cacheKey,
          prUrl: prUrl ?? null,
          sessionId: surveyResult.sessionId || buildResult.sessionId || null,
          surveyOutput: surveyResult.output,
        });
      } catch (error: any) {
        console.warn(`[ralph:worker:${this.repo}] Failed to file DX survey issues: ${error?.message ?? String(error)}`);
      }

      await this.recordCheckpoint(task, "survey_complete", surveyResult.sessionId || buildResult.sessionId);
      this.publishCheckpoint("survey_complete", {
        sessionId: surveyResult.sessionId || buildResult.sessionId || planResult.sessionId || undefined,
      });

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
        const paused = await this.pauseIfGitHubRateLimited(task, "process", error, {
          sessionId: task["session-id"]?.trim() || undefined,
          runLogPath: task["run-log-path"]?.trim() || undefined,
        });
        if (paused) return paused;

        const reason = error?.message ?? String(error);
        const details = error?.stack ?? reason;
        await this.markTaskBlocked(task, "runtime-error", { reason, details });
      }

      return {
        taskName: task.name,
        repo: this.repo,
        outcome: "failed",
        escalationReason: error?.message ?? String(error),
      };
    } finally {
      // slot release handled by scheduler-level reservation
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
    if (this.isGitHubQueueTask(task)) {
      return;
    }
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

      // Add token totals (best-effort). GitHub queue tasks skip agent-run notes.
      const tokenRunId = this.activeRunId ?? (data.sessionId ? getLatestRunIdForSession(data.sessionId) : null);
      if (tokenRunId) {
        try {
          const opencodeProfile = this.getPinnedOpencodeProfileName(task);
          let tokenTotals = getRalphRunTokenTotals(tokenRunId);
          let sessionTotals = listRalphRunSessionTokenTotals(tokenRunId);
          if (!tokenTotals || !tokenTotals.tokensComplete) {
            await refreshRalphRunTokenTotals({ runId: tokenRunId, opencodeProfile });
            tokenTotals = getRalphRunTokenTotals(tokenRunId);
            sessionTotals = listRalphRunSessionTokenTotals(tokenRunId);
          }

          if (tokenTotals) {
            const totalLabel = tokenTotals.tokensComplete && typeof tokenTotals.tokensTotal === "number" ? tokenTotals.tokensTotal : "?";
            const showSessions = sessionTotals.length > 1;
            bodySections.push(
              "## Token Usage",
              "",
              `- **Total:** ${totalLabel}`,
              `- **Complete:** ${tokenTotals.tokensComplete ? "Yes" : "No"}`,
              `- **Sessions:** ${tokenTotals.sessionCount}`,
              ""
            );

            if (showSessions) {
              const lines = sessionTotals.slice(0, 10).map((s) => {
                const label = typeof s.tokensTotal === "number" ? s.tokensTotal : "?";
                return `- ${s.sessionId}: ${label} (${s.quality})`;
              });
              if (lines.length > 0) {
                bodySections.push("### Sessions", "", ...lines, "");
              }
            }
          }
        } catch {
          // best-effort token accounting
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
