import { $ } from "bun";
import { appendFile, mkdir, readFile, rm } from "fs/promises";
import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { createHash } from "crypto";

import { type AgentTask, updateTaskStatus } from "../queue-backend";
import {
  getAutoUpdateBehindLabelGate,
  getAutoUpdateBehindMinMinutes,
  getOpencodeDefaultProfileName,
  getRepoBotBranch,
  getRepoConcurrencySlots,
  getRepoLoopDetectionConfig,
  getRepoPreflightCommands,
  getRepoRequiredChecksOverride,
  getRepoSetupCommands,
  isAutoUpdateBehindEnabled,
  getConfig,
} from "../config";
import { normalizeGitRef } from "../midpoint-labels";
import { applyMidpointLabelsBestEffort as applyMidpointLabelsBestEffortCore } from "../midpoint-labeler";
import { getAllowedOwners, getConfiguredGitHubAppSlug, isRepoAllowed } from "../github-app-auth";
import { safeNoteName } from "./names";
import { createWorktreeManager, type ResolveTaskRepoPathResult } from "./worktrees";
import { buildIssueContextForAgent as buildIssueContextForAgentImpl, getIssueMetadata as getIssueMetadataImpl } from "./issue-context";
import { createIssuePrResolver, type ResolvedIssuePr } from "./pr-reuse";
import { createRelationshipResolver } from "./relationships";
import { createBranchProtectionManager } from "./branch-protection";
import { syncBlockedStateForTasks as syncBlockedStateForTasksImpl } from "./blocked-sync";
import {
  continueCommand,
  continueSession,
  getRalphXdgCacheHome,
  runAgent,
  type RunSessionOptionsBase,
  type SessionResult,
} from "../session";
import { buildPlannerPrompt } from "../planner-prompt";
import { maybeRunParentVerificationLane } from "./parent-verification-lane";
import type { ParentVerificationMarker } from "../parent-verification";
import { appendChildDossierToIssueContext } from "../child-dossier/core";
import { collectChildCompletionDossier } from "../child-dossier/io";
import { getThrottleDecision } from "../throttle";
import { createContextRecoveryManager } from "./context-recovery";
import { ensureWorktreeSetup, type SetupFailure } from "../worktree-setup";
import { LogLimiter, formatDuration } from "../logging";
import { buildWorktreePath } from "../worktree-paths";

import { runPreflightGate } from "../gates/preflight";
import { prepareReviewDiffArtifacts, recordReviewGateFailure, recordReviewGateSkipped, runReviewGate } from "../gates/review";

import { PR_CREATE_LEASE_SCOPE, buildPrCreateLeaseKey, isLeaseStale } from "../pr-create-lease";

import { getPinnedOpencodeProfileName as getPinnedOpencodeProfileNameCore, resolveOpencodeXdgForTask as resolveOpencodeXdgForTaskCore } from "./opencode-profiles";
import { readControlStateSnapshot } from "../drain";
import { createPauseControl, recordCheckpoint } from "./pause-control";
import { hasProductGap, parseRoutingDecision, selectPrUrl, type RoutingDecision } from "../routing";
import {
  cleanupIntrospectionLogs,
  hasRepeatedToolPattern,
  readIntrospectionSummary,
  readLiveAnomalyCount,
} from "./introspection";
import { buildAgentRunBodyPrefix, computeBlockedPatch, summarizeBlockedDetails, summarizeForNote } from "./run-notes";
import {
  isExplicitBlockerReason,
  isImplementationTaskFromIssue,
  shouldConsultDevex,
  shouldEscalateAfterRouting,
  type IssueMetadata,
} from "../escalation";
import { notifyEscalation, notifyError, notifyTaskComplete, type EscalationContext } from "../notify";
import { buildWorkerFailureAlert, type WorkerFailureKind } from "../alerts/worker-failure-core";
import { buildNudgePreview, drainQueuedNudges, type NudgeDeliveryOutcome } from "../nudge";
import { redactSensitiveText } from "../redaction";
import { RALPH_LABEL_STATUS_IN_PROGRESS, RALPH_LABEL_STATUS_QUEUED } from "../github-labels";
import { GitHubClient } from "../github/client";
import { computeGitHubRateLimitPause } from "../github/rate-limit-throttle";
import { writeDxSurveyToGitHubIssues } from "../github/dx-survey-writeback";
import { createGhRunner } from "../github/gh-runner";
import type { ResolvedRequiredChecks } from "../github/required-checks";
import { createRalphWorkflowLabelsEnsurer } from "../github/ensure-ralph-workflow-labels";
import { resolveRelationshipSignals } from "../github/relationship-signals";
import { logRelationshipDiagnostics } from "../github/relationship-diagnostics";
import { sanitizeEscalationReason } from "../github/escalation-writeback";
import {
  buildParentVerificationPrompt as buildParentVerificationPromptLegacy,
  evaluateParentVerificationEligibility,
  parseParentVerificationOutput,
} from "../parent-verification/core";
import { collectParentVerificationEvidence } from "../parent-verification/io";
import { writeParentVerificationNoPrCompletion, writeParentVerificationToGitHub } from "../github/parent-verification-writeback";
import {
  buildCiDebugCommentBody,
  createCiDebugComment,
  findCiDebugComment,
  parseCiDebugState,
  updateCiDebugComment,
  type CiDebugAttempt,
  type CiDebugCommentState,
  type CiTriageCommentState,
} from "../github/ci-debug-comment";
import { buildCiTriageDecision, type CiFailureClassification, type CiNextAction, type CiTriageDecision } from "../ci-triage/core";
import { buildCiFailureSignatureV2, type CiFailureSignatureV2 } from "../ci-triage/signature";
import {
  buildMergeConflictCommentBody,
  createMergeConflictComment,
  findMergeConflictComment,
  parseMergeConflictState,
  updateMergeConflictComment,
  type MergeConflictAttempt,
  type MergeConflictCommentState,
} from "../github/merge-conflict-comment";
import {
  buildMergeConflictCommentLines,
  buildMergeConflictEscalationDetails,
  buildMergeConflictSignature,
  computeMergeConflictDecision,
  formatMergeConflictPaths,
} from "../merge-conflict-recovery";
import { buildWatchdogDiagnostics, writeWatchdogToGitHub } from "../github/watchdog-writeback";
import { buildLoopTripDetails } from "../loop-detection/format";
import { BLOCKED_SOURCES, type BlockedSource } from "../blocked-sources";
import { classifyOpencodeFailure } from "../opencode-error-classifier";
import { derivePrCreateEscalationReason } from "./pr-create-escalation-reason";
import { computeBlockedDecision, type RelationshipSignal } from "../github/issue-blocking-core";
import { formatIssueRef, parseIssueRef, type IssueRef } from "../github/issue-ref";
import {
  GitHubRelationshipProvider,
  type IssueRelationshipProvider,
  type IssueRelationshipSnapshot,
} from "../github/issue-relationships";
import { getRalphRunLogPath, getRalphWorktreesDir, getSessionEventsPath } from "../paths";
import { isRalphCheckpoint, type RalphCheckpoint, type RalphEvent } from "../dashboard/events";
import type { DashboardEventContext } from "../dashboard/publisher";
import { createRunRecordingSessionAdapter, type SessionAdapter } from "../run-recording-session-adapter";
import { redactHomePathForDisplay } from "../redaction";
import { isSafeSessionId } from "../session-id";
import {
  createContextRecoveryAdapter as createContextRecoveryAdapterImpl,
  withDashboardSessionOptions as withDashboardSessionOptionsImpl,
  withRunContext as withRunContextImpl,
} from "./run-context";
import {
  buildWorkerDashboardContext,
  CheckpointEventDeduper,
  publishWorkerDashboardEvent,
  type WorkerDashboardEventInput,
} from "./events";
import { PAUSED_AT_CHECKPOINT_FIELD, parseCheckpointValue } from "./checkpoint-fields";
import { applyTaskPatch } from "./task-patch";
import {
  completeParentVerification,
  completeRalphRun,
  createRalphRun,
  ensureRalphRunGateRows,
  getParentVerificationState,
  getLatestRunIdForSession,
  getRalphRunTokenTotals,
  getIdempotencyRecord,
  getIdempotencyPayload,
  listRalphRunSessionTokenTotals,
  recordIdempotencyKey,
  deleteIdempotencyKey,
  recordParentVerificationAttemptFailure,
  recordRalphRunGateArtifact,
  recordRalphRunTracePointer,
  upsertIdempotencyKey,
  recordIssueSnapshot,
  PR_STATE_MERGED,
  PR_STATE_OPEN,
  type PrState,
  type RalphRunAttemptKind,
  type RalphRunDetails,
  tryClaimParentVerification,
  upsertRalphRunGateResult,
} from "../state";
import { refreshRalphRunTokenTotals } from "../run-token-accounting";
import { computeAndStoreRunMetrics } from "../metrics/compute-and-store";
import {
  isPathUnderDir,
  parseGitWorktreeListPorcelain,
  pickWorktreeForIssue,
  stripHeadsRef,
  type GitWorktreeEntry,
} from "../git-worktree";
import {
  normalizePrUrl,
  viewPullRequestMergeCandidate,
} from "../github/pr";
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
} from "./lanes/required-checks";
import {
  getPullRequestBaseBranch as getPullRequestBaseBranchImpl,
  getPullRequestChecks as getPullRequestChecksImpl,
  mergePullRequest as mergePullRequestImpl,
  normalizeMergeStateStatus,
  type PullRequestMergeStateStatus,
} from "./merge/pull-request-io";
import { updatePullRequestBranch as updatePullRequestBranchImpl } from "./merge/update-branch";
import { waitForRequiredChecks as waitForRequiredChecksImpl } from "./merge/wait-required-checks";
import { getPullRequestMergeState as getPullRequestMergeStateImpl } from "./merge/pull-request-state";
import { updatePullRequestBranchViaWorktree as updatePullRequestBranchViaWorktreeImpl } from "./merge/auto-update-worktree";
import { getPullRequestFiles as getPullRequestFilesImpl } from "./merge/pull-request-files";
import { runMergeConflictRecovery as runMergeConflictRecoveryImpl } from "./merge/conflict-recovery";
import {
  recordAutoUpdateAttempt as recordAutoUpdateAttemptImpl,
  recordAutoUpdateFailure as recordAutoUpdateFailureImpl,
  shouldAttemptProactiveUpdate as shouldAttemptProactiveUpdateImpl,
  shouldRateLimitAutoUpdate as shouldRateLimitAutoUpdateImpl,
} from "./merge/auto-update-gate";
import { mergePrWithRequiredChecks as mergePrWithRequiredChecksImpl } from "./merge/merge-runner";
import {
  deleteMergedPrHeadBranchBestEffort as deleteMergedPrHeadBranchBestEffortImpl,
  deletePrHeadBranch as deletePrHeadBranchImpl,
  fetchMergedPullRequestDetails as fetchMergedPullRequestDetailsImpl,
  fetchPullRequestDetails as fetchPullRequestDetailsImpl,
} from "./merge/pr-cleanup";
import {
  clipLogExcerpt,
  extractCommandsFromLog,
  isActionableCheckFailure,
  parseCiFixAttempts,
  parseGhRunId,
} from "./ci/ci-utils";
import { runCiFailureTriage as runCiFailureTriageImpl } from "./ci/remediation";
import {
  recordPrSnapshotBestEffort as recordPrSnapshotBestEffortImpl,
  updateOpenPrSnapshot as updateOpenPrSnapshotImpl,
} from "./pr-snapshots";
import {
  addIssueLabel as addIssueLabelImpl,
  applyCiDebugLabels as applyCiDebugLabelsImpl,
  clearCiDebugLabels as clearCiDebugLabelsImpl,
  ensureRalphWorkflowLabelsOnce as ensureRalphWorkflowLabelsOnceImpl,
  recordIssueLabelDelta as recordIssueLabelDeltaImpl,
  removeIssueLabel as removeIssueLabelImpl,
} from "./labels";
import {
  cleanupWorktreesForTasks as cleanupWorktreesForTasksImpl,
  getGitWorktrees as getGitWorktreesImpl,
  pruneGitWorktreesOnStartup as pruneGitWorktreesOnStartupImpl,
  cleanupOrphanedWorktreesOnStartup as cleanupOrphanedWorktreesOnStartupImpl,
  warnLegacyWorktreesOnStartup as warnLegacyWorktreesOnStartupImpl,
} from "./worktree-cleanup";
import { writeEscalationWriteback as writeEscalationWritebackImpl } from "./escalation";
import { pauseIfGitHubRateLimited, pauseIfHardThrottled } from "./lanes/pause";
import type { ThrottleAdapter } from "./ports";

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
const ISSUE_RELATIONSHIP_TTL_MS = 60_000;
const LEGACY_WORKTREES_LOG_INTERVAL_MS = 12 * 60 * 60 * 1000;
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

// (applyTaskPatch extracted to src/worker/task-patch.ts)
export class RepoWorker {
  private session: SessionAdapter;
  private baseSession: SessionAdapter;
  private queue: QueueAdapter;
  private notify: NotifyAdapter;
  private throttle: ThrottleAdapter;
  private github: GitHubClient;
  private labelEnsurer: ReturnType<typeof createRalphWorkflowLabelsEnsurer>;
  private worktrees: ReturnType<typeof createWorktreeManager>;
  private contextRecoveryContext: { task: AgentTask; repoPath: string; planPath: string } | null = null;
  private contextCompactAttempts = new Map<string, number>();
  private contextRecovery: ReturnType<typeof createContextRecoveryManager>;

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
    this.contextRecovery = createContextRecoveryManager({
      repo: this.repo,
      baseSession: this.baseSession,
      attempts: this.contextCompactAttempts,
      getContext: () => this.contextRecoveryContext,
      setContext: (context) => {
        this.contextRecoveryContext = context;
      },
      onCompactTriggered: (event, context) => {
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
      warn: (message) => console.warn(message),
    });
    this.session = this.createContextRecoveryAdapter(this.baseSession);
    this.queue = opts?.queue ?? DEFAULT_QUEUE_ADAPTER;
    this.notify = opts?.notify ?? DEFAULT_NOTIFY_ADAPTER;
    this.throttle = opts?.throttle ?? DEFAULT_THROTTLE_ADAPTER;
    this.worktrees = createWorktreeManager({
      repo: this.repo,
      repoPath: this.repoPath,
      worktreesDir: RALPH_WORKTREES_DIR,
      queue: this.queue,
    });
    this.prResolver = createIssuePrResolver({
      repo: this.repo,
      formatGhError: (error) => this.formatGhError(error),
      recordOpenPrSnapshot: (issueRef, prUrl) => {
        this.recordPrSnapshotBestEffort({ issue: issueRef, prUrl, state: PR_STATE_OPEN });
      },
    });
    this.github = new GitHubClient(this.repo);
    this.branchProtection = createBranchProtectionManager({
      repo: this.repo,
      github: this.github,
      shouldLogBackoff: (key: string, intervalMs: number) => this.requiredChecksLogLimiter.shouldLog(key, intervalMs),
    });
    this.relationships = opts?.relationships ?? new GitHubRelationshipProvider(this.repo, this.github);
    this.relationshipResolver = createRelationshipResolver({
      repo: this.repo,
      provider: this.relationships,
      ttlMs: ISSUE_RELATIONSHIP_TTL_MS,
      warn: (message) => console.warn(`[ralph:worker:${this.repo}] ${message}`),
    });
    this.labelEnsurer = createRalphWorkflowLabelsEnsurer({
      githubFactory: () => this.github,
    });
  }

  private branchProtection: ReturnType<typeof createBranchProtectionManager>;
  private relationships: IssueRelationshipProvider;
  private relationshipResolver: ReturnType<typeof createRelationshipResolver>;
  private lastBlockedSyncAt = 0;
  private requiredChecksLogLimiter = new LogLimiter({ maxKeys: 2000 });
  private legacyWorktreesLogLimiter = new LogLimiter({ maxKeys: 2000 });
  private prResolver: ReturnType<typeof createIssuePrResolver>;
  private checkpointEvents = new CheckpointEventDeduper();
  private activeRunId: string | null = null;
  private activeDashboardContext: DashboardEventContext | null = null;

  // Keep thin wrapper methods on RepoWorker for test hooks.
  // Tests frequently monkeypatch these via `(worker as any)`.
  private buildParentVerificationWorktreePath(issueNumber: string): string {
    return this.worktrees.buildParentVerificationWorktreePath(issueNumber);
  }

  private async ensureGitWorktree(worktreePath: string): Promise<void> {
    return await this.worktrees.ensureGitWorktree(worktreePath);
  }

  private async safeRemoveWorktree(worktreePath: string, opts?: { allowDiskCleanup?: boolean }): Promise<void> {
    return await this.worktrees.safeRemoveWorktree(worktreePath, opts);
  }

  private async resolveTaskRepoPath(
    task: AgentTask,
    issueNumber: string,
    mode: "start" | "resume",
    repoSlot?: number | null
  ): Promise<ResolveTaskRepoPathResult> {
    return await this.worktrees.resolveTaskRepoPath(task, issueNumber, mode, repoSlot, {
      ensureGitWorktree: (worktreePath) => this.ensureGitWorktree(worktreePath),
      safeRemoveWorktree: (worktreePath, opts) => this.safeRemoveWorktree(worktreePath, opts),
    });
  }

  private async getWorktreeStatusPorcelain(worktreePath: string): Promise<string> {
    return await this.contextRecovery.getWorktreeStatusPorcelain(worktreePath);
  }

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
    if (this.activeRunId) {
      recordRalphRunTracePointer({
        runId: this.activeRunId,
        kind: "run_log_path",
        path: runLogPath,
      });
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
    return buildWorkerDashboardContext({ repo: this.repo }, task, runId);
  }

  private withDashboardContext<T>(context: DashboardEventContext, run: () => Promise<T>): Promise<T> {
    const prev = this.activeDashboardContext;
    this.activeDashboardContext = context;
    return Promise.resolve(run()).finally(() => {
      this.activeDashboardContext = prev;
    });
  }

  private publishDashboardEvent(
    event: WorkerDashboardEventInput,
    overrides?: Partial<DashboardEventContext>
  ): void {
    publishWorkerDashboardEvent({ activeDashboardContext: this.activeDashboardContext }, event, overrides);
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
    return await withRunContextImpl({
      task,
      attemptKind,
      run,
      ports: {
        repo: this.repo,
        getActiveRunId: () => this.activeRunId,
        setActiveRunId: (runId) => {
          this.activeRunId = runId;
        },
        baseSession: this.baseSession,
        createRunRecordingSessionAdapter: (params) => createRunRecordingSessionAdapter(params),
        createContextRecoveryAdapter: (base) => this.createContextRecoveryAdapter(base),
        withDashboardContext: (context, runner) => this.withDashboardContext(context, runner),
        withSessionAdapters: (next, runner) => this.withSessionAdapters(next, runner),
        buildDashboardContext: (contextTask, runId) => this.buildDashboardContext(contextTask, runId),
        publishDashboardEvent: (event, overrides) => this.publishDashboardEvent(event, overrides),
        createRunRecord: (params) => createRalphRun(params),
        ensureRunGateRows: (runId) => ensureRalphRunGateRows({ runId }),
        completeRun: (params) => completeRalphRun(params),
        upsertRunGateResult: (params) => upsertRalphRunGateResult(params),
        recordRunGateArtifact: (params) => recordRalphRunGateArtifact(params),
        buildRunDetails: (result) => buildRunDetails(result),
        getPinnedOpencodeProfileName: (contextTask) => this.getPinnedOpencodeProfileName(contextTask),
        refreshRalphRunTokenTotals: (params) => refreshRalphRunTokenTotals(params),
        getRalphRunTokenTotals: (runId) => getRalphRunTokenTotals(runId),
        listRalphRunSessionTokenTotals: (runId) => listRalphRunSessionTokenTotals(runId),
        appendFile,
        existsSync,
        computeAndStoreRunMetrics: (params) => computeAndStoreRunMetrics(params),
        warn: (message) => console.warn(message),
      },
    });
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
    return createContextRecoveryAdapterImpl({
      base,
      withDashboardSessionOptions: (options, overrides) => this.withDashboardSessionOptions(options, overrides),
      maybeRecoverFromContextLengthExceeded: async (params) => await this.maybeRecoverFromContextLengthExceeded(params),
    });
  }

  private withDashboardSessionOptions(
    options?: RunSessionOptionsBase,
    overrides?: Partial<DashboardEventContext>
  ): RunSessionOptionsBase | undefined {
    return withDashboardSessionOptionsImpl({
      options,
      overrides,
      activeDashboardContext: this.activeDashboardContext,
      publishDashboardEvent: (event, eventOverrides) => this.publishDashboardEvent(event, eventOverrides),
    });
  }

  private async maybeRecoverFromContextLengthExceeded(params: {
    repoPath: string;
    sessionId?: string;
    stepKey: string;
    result: SessionResult;
    options?: RunSessionOptionsBase;
    command?: string;
  }): Promise<SessionResult> {
    return await this.contextRecovery.maybeRecoverFromContextLengthExceeded(params);
  }

  private async prepareContextRecovery(task: AgentTask, worktreePath: string): Promise<void> {
    return await this.contextRecovery.prepareContextRecovery(task, worktreePath);
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
    if (worktreePath && !this.worktrees.isSameRepoRootPath(worktreePath)) {
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
    await ensureRalphWorkflowLabelsOnceImpl(this as any);
  }

  private async githubApiRequest<T>(
    path: string,
    opts: { method?: string; body?: unknown; allowNotFound?: boolean } = {}
  ): Promise<T | null> {
    const response = await this.github.request<T>(path, opts);
    return response.data;
  }

  private async addIssueLabel(issue: IssueRef, label: string): Promise<void> {
    await addIssueLabelImpl(this as any, issue, label);
  }

  private async removeIssueLabel(issue: IssueRef, label: string): Promise<void> {
    await removeIssueLabelImpl(this as any, issue, label);
  }

  private recordIssueLabelDelta(issue: IssueRef, delta: { add: string[]; remove: string[] }): void {
    return recordIssueLabelDeltaImpl(this as any, issue, delta);
  }

  private recordPrSnapshotBestEffort(input: { issue: string; prUrl: string; state: PrState }): void {
    return recordPrSnapshotBestEffortImpl({ repo: this.repo }, input);
  }

  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string, nextPrUrl: string | null): string;
  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string | null, nextPrUrl: string | null): string | null;
  private updateOpenPrSnapshot(task: AgentTask, currentPrUrl: string | null, nextPrUrl: string | null): string | null {
    return updateOpenPrSnapshotImpl({ repo: this.repo }, task, currentPrUrl, nextPrUrl);
  }

  private getIssuePrResolution(issueNumber: string, opts: { fresh?: boolean } = {}): Promise<ResolvedIssuePr> {
    return this.prResolver.getIssuePrResolution(issueNumber, opts);
  }

  private invalidateIssuePrResolution(issueNumber: string): void {
    this.prResolver.invalidateIssuePrResolution(issueNumber);
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
      const resolved = await this.getIssuePrResolution(params.issueNumber, { fresh: true });
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

  private async parkTaskWaitingOnOpenPr(task: AgentTask, issueNumber: string, prUrl: string): Promise<AgentRun> {
    const patch: Record<string, string> = {
      "session-id": "",
      "worktree-path": "",
      "worker-id": "",
      "repo-slot": "",
      "daemon-id": "",
      "heartbeat-at": "",
    };
    const updated = await this.queue.updateTaskStatus(task, "waiting-on-pr", patch);
    if (updated) {
      applyTaskPatch(task, "waiting-on-pr", patch);
    }
    this.updateOpenPrSnapshot(task, null, prUrl);
    console.log(
      `[ralph:worker:${this.repo}] Parking ${task.issue} in waiting-on-pr for open PR ${prUrl} (issue ${issueNumber})`
    );
    return {
      taskName: task.name,
      repo: this.repo,
      outcome: "success",
    };
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
    return await writeEscalationWritebackImpl(this as any, task, params);
  }

  private async escalateNoPrAfterRetries(params: {
    task: AgentTask;
    reason: string;
    details?: string;
    planOutput: string;
    sessionId?: string;
  }): Promise<AgentRun> {
    console.log(`[ralph:worker:${this.repo}] Escalating: ${params.reason}`);

    const wasEscalated = params.task.status === "escalated";
    const escalated = await this.queue.updateTaskStatus(params.task, "escalated");
    if (escalated) {
      applyTaskPatch(params.task, "escalated", {});
    }

    await this.writeEscalationWriteback(params.task, {
      reason: params.reason,
      details: params.details,
      escalationType: "other",
    });
    await this.notify.notifyEscalation({
      taskName: params.task.name,
      taskFileName: params.task._name,
      taskPath: params.task._path,
      issue: params.task.issue,
      repo: this.repo,
      sessionId: params.sessionId || params.task["session-id"]?.trim() || undefined,
      reason: params.reason,
      escalationType: "other",
      planOutput: params.planOutput,
    });

    if (escalated && !wasEscalated) {
      await this.recordEscalatedRunNote(params.task, {
        reason: params.reason,
        sessionId: params.sessionId || params.task["session-id"]?.trim() || undefined,
        details: [params.details, params.planOutput].filter(Boolean).join("\n\n"),
      });
    }

    return {
      taskName: params.task.name,
      repo: this.repo,
      outcome: "escalated",
      sessionId: params.sessionId,
      escalationReason: params.reason,
    };
  }

  private async fetchAvailableCheckContexts(branch: string): Promise<string[]> {
    return await this.branchProtection.fetchAvailableCheckContexts(branch);
  }

  private async fetchRepoDefaultBranch(): Promise<string | null> {
    return await this.branchProtection.fetchRepoDefaultBranch();
  }

  private async fetchGitRef(ref: string): Promise<GitRef | null> {
    return await this.branchProtection.fetchGitRef(ref);
  }

  public async __testOnlyResolveRequiredChecksForMerge(): Promise<ResolvedRequiredChecks> {
    return this.resolveRequiredChecksForMerge();
  }

  public async __testOnlyFetchAvailableCheckContexts(branch: string): Promise<string[]> {
    return this.fetchAvailableCheckContexts(branch);
  }

  private async resolveRequiredChecksForMerge(): Promise<ResolvedRequiredChecks> {
    return await this.branchProtection.resolveRequiredChecksForMerge();
  }

  private async ensureBranchProtectionForBranch(branch: string, requiredChecks: string[]): Promise<"ok" | "defer"> {
    return await this.branchProtection.ensureBranchProtectionForBranch(branch, requiredChecks);
  }

  private async ensureBranchProtectionOnce(): Promise<void> {
    return await this.branchProtection.ensureBranchProtectionOnce();
  }

  public async syncBlockedStateForTasks(tasks: AgentTask[]): Promise<Set<string>> {
    return await syncBlockedStateForTasksImpl(this as any, tasks);
  }

  private async getRelationshipSnapshot(issue: IssueRef, allowRefresh: boolean): Promise<IssueRelationshipSnapshot | null> {
    return await this.relationshipResolver.getSnapshot(issue, allowRefresh);
  }

  private buildRelationshipSignals(snapshot: IssueRelationshipSnapshot): RelationshipSignal[] {
    return this.relationshipResolver.buildSignals(snapshot);
  }

  private async cleanupGitWorktree(worktreePath: string): Promise<void> {
    await this.safeRemoveWorktree(worktreePath, { allowDiskCleanup: true });
  }

  /**
   * Fetch metadata for a GitHub issue.
   */
  private async getIssueMetadata(issue: string): Promise<IssueMetadata> {
    return await getIssueMetadataImpl(issue);
  }

  private async buildIssueContextForAgent(params: {
    repo: string;
    issueNumber: string | number;
  }): Promise<string> {
    return await buildIssueContextForAgentImpl(params);
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
    const preflight = getRepoPreflightCommands(this.repo);
    const preflightLines = preflight.commands.length > 0
      ? ["# Preflight (must pass before PR)", ...preflight.commands]
      : [];

    return [
      `No PR URL found. Create a PR targeting '${botBranch}' and paste the PR URL.`,
      "IMPORTANT: Before creating a new PR, check if one already exists for this issue.",
      "",
      "Commands (run in the task worktree):",
      "```bash",
      "git status",
      ...preflightLines,
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
    return (await getGitWorktreesImpl(this as any)) as any;
  }

  private async cleanupWorktreesOnStartup(): Promise<void> {
    try {
      await pruneGitWorktreesOnStartupImpl(this as any);
    } catch (e: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to prune git worktrees on startup: ${e?.message ?? String(e)}`
      );
    }

    try {
      await cleanupOrphanedWorktreesOnStartupImpl(this as any);
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
    await warnLegacyWorktreesOnStartupImpl(this as any, {
      managedRoot: RALPH_WORKTREES_DIR,
      legacyLogIntervalMs: LEGACY_WORKTREES_LOG_INTERVAL_MS,
    });
  }

  private async cleanupWorktreesForTasks(tasks: AgentTask[]): Promise<void> {
    await cleanupWorktreesForTasksImpl(this as any, tasks);
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

  private async runPrReadinessChecks(params: {
    task: AgentTask;
    issueNumber: string;
    worktreePath: string;
    botBranch: string;
    runId: string;
  }): Promise<{ ok: true; diagnostics: string[] } | { ok: false; diagnostics: string[] }> {
    const diagnostics: string[] = [];
    const issueContextParts: string[] = [];

    try {
      const issueContext = await this.buildIssueContextForAgent({
        repo: this.repo,
        issueNumber: params.issueNumber,
      });
      if (issueContext.trim()) issueContextParts.push(issueContext.trim());
    } catch (error: any) {
      issueContextParts.push(`Issue context unavailable: ${error?.message ?? String(error)}`);
    }

    const reviewIssueContext = issueContextParts.join("\n\n");

    let reviewDiff: { baseRef: string; headRef: string; diffPath: string; diffStat: string };
    try {
      reviewDiff = await prepareReviewDiffArtifacts({
        runId: params.runId,
        repoPath: params.worktreePath,
        baseRef: params.botBranch,
        headRef: "HEAD",
      });
      diagnostics.push(`- Review diff artifact prepared: ${reviewDiff.diffPath}`);
    } catch (error: any) {
      const reason = `Review readiness failed: could not prepare diff artifacts (${error?.message ?? String(error)})`;
      diagnostics.push(`- ${reason}`);
      recordReviewGateFailure({ runId: params.runId, gate: "product_review", reason });
      recordReviewGateFailure({ runId: params.runId, gate: "devex_review", reason });
      return { ok: false, diagnostics };
    }

    const runReviewAgent = async (
      gate: "product_review" | "devex_review",
      agent: "product" | "devex",
      stage: string
    ) => {
      return await runReviewGate({
        runId: params.runId,
        gate,
        repo: this.repo,
        issueRef: params.task.issue,
        prUrl: "(not created yet)",
        issueContext: reviewIssueContext,
        diff: reviewDiff,
        runAgent: async (prompt: string) => {
          const runLogPath = await this.recordRunLogPath(params.task, params.issueNumber, stage, "in-progress");
          return await this.session.runAgent(params.worktreePath, agent, prompt, {
            repo: this.repo,
            cacheKey: `pr-readiness-${params.issueNumber}-${agent}`,
            runLogPath,
            introspection: {
              repo: this.repo,
              issue: params.task.issue,
              taskName: params.task.name,
              step: 4,
              stepTitle: stage,
            },
            ...this.buildWatchdogOptions(params.task, stage),
            ...this.buildStallOptions(params.task, stage),
            ...this.buildLoopDetectionOptions(params.task, stage),
          });
        },
      });
    };

    const productReview = await runReviewAgent("product_review", "product", "pr readiness product review");
    if (productReview.status !== "pass") {
      diagnostics.push(`- Review failed: product (${productReview.reason})`);
      recordReviewGateSkipped({
        runId: params.runId,
        gate: "devex_review",
        reason: "Skipped because product review did not pass",
      });
      return { ok: false, diagnostics };
    }
    diagnostics.push("- Review passed: product");

    const devexReview = await runReviewAgent("devex_review", "devex", "pr readiness devex review");
    if (devexReview.status !== "pass") {
      diagnostics.push(`- Review failed: devex (${devexReview.reason})`);
      return { ok: false, diagnostics };
    }
    diagnostics.push("- Review passed: devex");

    return { ok: true, diagnostics };
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

    const runId = this.activeRunId;
    if (!runId) {
      diagnostics.push("- Missing runId; refusing PR creation because deterministic gates cannot be persisted");
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    const preflightConfig = getRepoPreflightCommands(this.repo);
    const skipReason =
      preflightConfig.source === "preflightCommand" && preflightConfig.configured && preflightConfig.commands.length === 0
        ? "preflight disabled (preflightCommand=[])"
        : preflightConfig.configured
          ? "preflight configured but empty"
          : "no preflight configured";

    const preflightResult = await runPreflightGate({
      runId,
      worktreePath: candidate.worktreePath,
      commands: preflightConfig.commands,
      skipReason,
    });

    if (preflightResult.status === "fail") {
      diagnostics.push("- Preflight failed; refusing to create PR");
      diagnostics.push(`- Gate: preflight=fail (runId=${runId})`);
      return { prUrl: null, diagnostics: diagnostics.join("\n") };
    }

    if (preflightResult.status === "skipped") {
      diagnostics.push(`- Preflight skipped: ${preflightResult.skipReason ?? "(no reason)"}`);
    } else {
      diagnostics.push("- Preflight passed");
    }

    const readiness = await this.runPrReadinessChecks({
      task,
      issueNumber,
      worktreePath: candidate.worktreePath,
      botBranch,
      runId,
    });
    diagnostics.push(...readiness.diagnostics);
    if (!readiness.ok) {
      diagnostics.push("- PR readiness failed; refusing to create PR");
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

    const canonicalBeforeCreate = await this.getIssuePrResolution(issueNumber, { fresh: true });
    if (canonicalBeforeCreate.diagnostics.length > 0) {
      diagnostics.push(...canonicalBeforeCreate.diagnostics);
    }
    if (canonicalBeforeCreate.selectedUrl) {
      diagnostics.push(`- Reusing canonical PR before create: ${canonicalBeforeCreate.selectedUrl}`);
      return { prUrl: canonicalBeforeCreate.selectedUrl, diagnostics: diagnostics.join("\n") };
    }

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
        this.invalidateIssuePrResolution(issueNumber);
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
        this.invalidateIssuePrResolution(issueNumber);
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
    return await getPullRequestChecksImpl({ repo: this.repo, prUrl });
  }

  private async getPullRequestBaseBranch(prUrl: string): Promise<string | null> {
    return await getPullRequestBaseBranchImpl({ repo: this.repo, prUrl });
  }

  private isMainMergeAllowed(baseBranch: string | null, botBranch: string, labels: string[]): boolean {
    return isMainMergeAllowed(baseBranch, botBranch, labels);
  }

  private async getPullRequestFiles(prUrl: string): Promise<string[]> {
    return await getPullRequestFilesImpl({
      repo: this.repo,
      prUrl,
      githubApiRequest: async (path) => await this.githubApiRequest(path),
    });
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
    return await waitForRequiredChecksImpl({
      repo: this.repo,
      prUrl,
      requiredChecks,
      opts,
      getPullRequestChecks: async (url) => await this.getPullRequestChecks(url),
      recordCiGateSummary: (url, summary) => this.recordCiGateSummary(url, summary),
      shouldLogBackoff: (key) => this.requiredChecksLogLimiter.shouldLog(key, REQUIRED_CHECKS_LOG_INTERVAL_MS),
      log: (message) => console.log(message),
    });
  }

  private async mergePullRequest(prUrl: string, headSha: string, cwd: string): Promise<void> {
    return await mergePullRequestImpl({ repo: this.repo, prUrl, headSha, cwd });
  }

  private async updatePullRequestBranch(prUrl: string, cwd: string): Promise<void> {
    return await updatePullRequestBranchImpl({
      repo: this.repo,
      prUrl,
      cwd,
      formatGhError: (error) => this.formatGhError(error),
      updateViaWorktree: async (url) => {
        await this.updatePullRequestBranchViaWorktree(url);
      },
    });
  }

  private resolveCiFixAttempts(): number {
    return parseCiFixAttempts(process.env.RALPH_CI_REMEDIATION_MAX_ATTEMPTS) ?? 5;
  }

  private resolveMergeConflictAttempts(): number {
    return parseCiFixAttempts(process.env.RALPH_MERGE_CONFLICT_MAX_ATTEMPTS) ?? 2;
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

  private recordMissingPrEvidence(params: {
    task: AgentTask;
    issueNumber: string;
    botBranch: string;
    reason: string;
    diagnostics?: string;
  }): void {
    const runId = this.activeRunId;
    if (!runId) return;

    try {
      upsertRalphRunGateResult({
        runId,
        gate: "pr_evidence",
        status: "fail",
        skipReason: "missing pr_url",
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to persist PR evidence gate failure: ${error?.message ?? String(error)}`
      );
    }

    try {
      const worktreePath = params.task["worktree-path"]?.trim() || "(unknown)";
      const content = [
        "PR evidence gate failed: missing PR URL.",
        `Reason: ${params.reason}`,
        `Issue: ${params.task.issue}`,
        `Worktree: ${worktreePath}`,
        "",
        "Suggested recovery commands:",
        `git -C \"${worktreePath}\" status`,
        `git -C \"${worktreePath}\" branch --show-current`,
        `git -C \"${worktreePath}\" push -u origin HEAD`,
        `gh pr create --base ${params.botBranch} --fill --body \"Fixes #${params.issueNumber}\"`,
        params.diagnostics ? "" : null,
        params.diagnostics ? "Diagnostics:" : null,
        params.diagnostics ?? null,
      ]
        .filter(Boolean)
        .join("\n");

      recordRalphRunGateArtifact({
        runId,
        gate: "pr_evidence",
        kind: "note",
        content,
      });
    } catch (error: any) {
      console.warn(
        `[ralph:worker:${this.repo}] Failed to persist PR evidence diagnostics: ${error?.message ?? String(error)}`
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
      return { runId, logExcerpt: clipLogExcerpt(output) };
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

      const runId = parseGhRunId(check.detailsUrl);
      if (!runId) {
        logs.push({ ...check });
        continue;
      }

      const logResult = await this.getCheckLog(runId);
      if (logResult.logExcerpt) {
        extractCommandsFromLog(logResult.logExcerpt).forEach((cmd) => commands.add(cmd));
      }

      if (!logResult.logExcerpt) {
        logWarnings.push(`No failing log output captured for ${check.name} (run ${runId}).`);
      }

      if (!isActionableCheckFailure(check.rawState)) {
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
        const runId = parseGhRunId(check.detailsUrl);
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
    if (!context.failedChecks.every((check) => isActionableCheckFailure(check.rawState))) return false;
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

  private isBaseBranchModifiedMergeError(error: any): boolean {
    const message = this.getGhErrorSearchText(error);
    if (!message) return false;
    return /base branch was modified/i.test(message);
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
    await applyCiDebugLabelsImpl(this as any, issue);
  }

  private async clearCiDebugLabels(issue: IssueRef): Promise<void> {
    await clearCiDebugLabelsImpl(this as any, issue);
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
    return await runMergeConflictRecoveryImpl(this as any, params);
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
      "- Inspect the failing check runs linked above, fix or rerun as needed, then apply `ralph:cmd:queue` to resume."
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
    return await runCiFailureTriageImpl(this as any, params);
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
      ...this.buildLoopDetectionOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    await this.recordImplementationCheckpoint(task, surveyResult.sessionId || mergeGate.sessionId);

    if (!surveyResult.success && surveyResult.loopTrip) {
      return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
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
      ...this.buildLoopDetectionOptions(task, "survey"),
      ...opencodeSessionOptions,
    });

    await this.recordImplementationCheckpoint(task, surveyResult.sessionId || mergeGate.sessionId);

    if (!surveyResult.success && surveyResult.loopTrip) {
      return await this.handleLoopTrip(task, cacheKey, "survey", surveyResult);
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
    return await updatePullRequestBranchViaWorktreeImpl({
      repo: this.repo,
      prUrl,
      worktreesDir: RALPH_WORKTREES_DIR,
      botBranch: getRepoBotBranch(this.repo),
      normalizeGitRef: (ref) => this.normalizeGitRef(ref),
      getPullRequestMergeState: async (url) => await this.getPullRequestMergeState(url),
      ensureGitWorktree: async (worktreePath) => await this.ensureGitWorktree(worktreePath),
      safeRemoveWorktree: async (worktreePath, opts) => await this.safeRemoveWorktree(worktreePath, opts),
    });
  }

  private async getPullRequestMergeState(prUrl: string): Promise<PullRequestMergeState> {
    return await getPullRequestMergeStateImpl({ repo: this.repo, prUrl });
  }

  private async fetchPullRequestDetails(prUrl: string): Promise<PullRequestDetailsNormalized> {
    return await fetchPullRequestDetailsImpl({
      repo: this.repo,
      prUrl,
      githubApiRequest: async (path) => await this.githubApiRequest(path),
    });
  }

  private async fetchMergedPullRequestDetails(
    prUrl: string,
    attempts: number,
    delayMs: number
  ): Promise<PullRequestDetailsNormalized> {
    return await fetchMergedPullRequestDetailsImpl({
      prUrl,
      attempts,
      delayMs,
      fetchPullRequestDetails: async (url) => await this.fetchPullRequestDetails(url),
    });
  }

  private async deleteMergedPrHeadBranchBestEffort(params: {
    prUrl: string;
    botBranch: string;
    mergedHeadSha: string;
  }): Promise<void> {
    return await deleteMergedPrHeadBranchBestEffortImpl({
      repo: this.repo,
      prUrl: params.prUrl,
      botBranch: params.botBranch,
      mergedHeadSha: params.mergedHeadSha,
      fetchMergedPullRequestDetails: async (url, attempts, delayMs) =>
        await this.fetchMergedPullRequestDetails(url, attempts, delayMs),
      fetchRepoDefaultBranch: async () => await this.fetchRepoDefaultBranch(),
      fetchGitRef: async (path) => await this.fetchGitRef(path),
      deletePrHeadBranch: async (branch) => await this.deletePrHeadBranch(branch),
      formatGhError: (error) => this.formatGhError(error),
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
    });
  }

  private async deletePrHeadBranch(branch: string): Promise<"deleted" | "missing"> {
    return await deletePrHeadBranchImpl({
      repo: this.repo,
      branch,
      githubRequest: async (path, opts) => await this.github.request(path, opts),
    });
  }

  private shouldAttemptProactiveUpdate(pr: PullRequestMergeState): { ok: boolean; reason?: string } {
    return shouldAttemptProactiveUpdateImpl({
      repo: this.repo,
      pr,
      botBranch: getRepoBotBranch(this.repo),
      normalizeGitRef: (ref) => this.normalizeGitRef(ref),
    });
  }

  private shouldRateLimitAutoUpdate(pr: PullRequestMergeState, minMinutes: number): boolean {
    return shouldRateLimitAutoUpdateImpl({
      repo: this.repo,
      prNumber: pr.number,
      minMinutes,
      getIdempotencyPayload: (key) => getIdempotencyPayload(key),
    });
  }

  private recordAutoUpdateAttempt(pr: PullRequestMergeState, minMinutes: number): void {
    return recordAutoUpdateAttemptImpl({
      repo: this.repo,
      prNumber: pr.number,
      minMinutes,
      upsertIdempotencyKey: (input) => upsertIdempotencyKey(input),
    });
  }

  private recordAutoUpdateFailure(pr: PullRequestMergeState, minMinutes: number): void {
    return recordAutoUpdateFailureImpl({
      repo: this.repo,
      prNumber: pr.number,
      minMinutes,
      upsertIdempotencyKey: (input) => upsertIdempotencyKey(input),
    });
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
    const issueNumber = params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey;
    return await mergePrWithRequiredChecksImpl({
      repo: this.repo,
      task: params.task,
      repoPath: params.repoPath,
      cacheKey: params.cacheKey,
      botBranch: params.botBranch,
      prUrl: params.prUrl,
      sessionId: params.sessionId,
      issueMeta: params.issueMeta,
      runId: this.activeRunId,
      watchdogStagePrefix: params.watchdogStagePrefix,
      notifyTitle: params.notifyTitle,
      opencodeXdg: params.opencodeXdg,
      resolveRequiredChecksForMerge: async () => await this.resolveRequiredChecksForMerge(),
      recordCheckpoint: async (task, checkpoint, sid) => {
        await this.recordCheckpoint(task, checkpoint as any, sid);
      },
      getPullRequestFiles: async (url) => await this.getPullRequestFiles(url),
      getPullRequestBaseBranch: async (url) => await this.getPullRequestBaseBranch(url),
      isMainMergeAllowed: (base, bot, labels) => this.isMainMergeAllowed(base, bot, labels),
      createAgentRun: async (task, opts) => await this.createAgentRun(task, opts as any),
      markTaskBlocked: async (task, source, opts) => await this.markTaskBlocked(task, source as any, opts as any),
      getPullRequestChecks: async (url) => await this.getPullRequestChecks(url),
      recordCiGateSummary: (url, summary) => this.recordCiGateSummary(url, summary),
      buildIssueContextForAgent: async (input) => await this.buildIssueContextForAgent(input),
      runReviewAgent: async (input) => {
        const runLogPath = await this.recordRunLogPath(params.task, issueNumber, input.stage, "in-progress");
        const baseOptions = {
          repo: this.repo,
          cacheKey: input.cacheKey,
          runLogPath,
          introspection: {
            repo: this.repo,
            issue: params.task.issue,
            taskName: params.task.name,
            step: 0,
            stepTitle: input.stage,
          },
          ...this.buildWatchdogOptions(params.task, input.stage),
          ...this.buildStallOptions(params.task, input.stage),
          ...this.buildLoopDetectionOptions(params.task, input.stage),
          ...(params.opencodeXdg ? { opencodeXdg: params.opencodeXdg } : {}),
        };
        const continueSessionId = input.continueSessionId?.trim();
        if (continueSessionId) {
          return await this.session.continueSession(params.repoPath, continueSessionId, input.prompt, {
            ...baseOptions,
            agent: input.agent,
          });
        }
        return await this.session.runAgent(params.repoPath, input.agent, input.prompt, baseOptions);
      },
      runMergeConflictRecovery: async (input) => await this.runMergeConflictRecovery(input as any),
      updatePullRequestBranch: async (url, cwd) => await this.updatePullRequestBranch(url, cwd),
      formatGhError: (err) => this.formatGhError(err),
      mergePullRequest: async (url, sha, cwd) => await this.mergePullRequest(url, sha, cwd),
      recordPrSnapshotBestEffort: (input) => this.recordPrSnapshotBestEffort(input as any),
      applyMidpointLabelsBestEffort: async (input) => await this.applyMidpointLabelsBestEffort(input as any),
      deleteMergedPrHeadBranchBestEffort: async (input) => await this.deleteMergedPrHeadBranchBestEffort(input as any),
      normalizeGitRef: (ref) => this.normalizeGitRef(ref),
      isOutOfDateMergeError: (err) => this.isOutOfDateMergeError(err as any),
      isBaseBranchModifiedMergeError: (err) => this.isBaseBranchModifiedMergeError(err as any),
      isRequiredChecksExpectedMergeError: (err) => this.isRequiredChecksExpectedMergeError(err as any),
      waitForRequiredChecks: async (url, checks, opts) => await this.waitForRequiredChecks(url, checks, opts),
      runCiFailureTriage: async (input) => await this.runCiFailureTriage(input as any),
      recordMergeFailureArtifact: (url, diag) => this.recordMergeFailureArtifact(url, diag),
      pauseIfHardThrottled: async (task, stage, sid) => await this.pauseIfHardThrottled(task, stage, sid),
      shouldAttemptProactiveUpdate: (pr) => this.shouldAttemptProactiveUpdate(pr as any),
      shouldRateLimitAutoUpdate: (pr, min) => this.shouldRateLimitAutoUpdate(pr as any, min),
      recordAutoUpdateAttempt: (pr, min) => this.recordAutoUpdateAttempt(pr as any, min),
      recordAutoUpdateFailure: (pr, min) => this.recordAutoUpdateFailure(pr as any, min),
      getPullRequestMergeState: async (url) => await this.getPullRequestMergeState(url),
      recurse: async (next) => await this.mergePrWithRequiredChecks(next as any),
      log: (message) => console.log(message),
      warn: (message) => console.warn(message),
    });
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

  private async maybeRunParentVerification(params: {
    task: AgentTask;
    issueNumber: string;
    issueMeta: IssueMetadata;
    startTime: Date;
    cacheKey: string;
    workerId?: string;
    allocatedSlot?: number | null;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions?: RunSessionOptionsBase;
  }): Promise<AgentRun | null> {
    void params.opencodeXdg;
    return await maybeRunParentVerificationLane({
      repo: this.repo,
      repoPath: this.repoPath,
      task: params.task,
      issueNumber: params.issueNumber,
      issueMeta: params.issueMeta,
      opencodeSessionOptions: params.opencodeSessionOptions,
      nowMs: () => Date.now(),
      getParentVerificationState,
      tryClaimParentVerification,
      recordParentVerificationAttemptFailure,
      completeParentVerification,
      recordRunLogPath: this.recordRunLogPath.bind(this),
      buildIssueContextForAgent: this.buildIssueContextForAgent.bind(this),
      runAgent: this.session.runAgent.bind(this.session),
      buildWatchdogOptions: this.buildWatchdogOptions.bind(this),
      buildStallOptions: this.buildStallOptions.bind(this),
      buildLoopDetectionOptions: this.buildLoopDetectionOptions.bind(this),
      handleLoopTrip: this.handleLoopTrip.bind(this),
      updateTaskStatus: this.queue.updateTaskStatus.bind(this.queue),
      applyTaskPatch,
      writeEscalationWriteback: this.writeEscalationWriteback.bind(this),
      notifyEscalation: this.notify.notifyEscalation.bind(this.notify),
      recordEscalatedRunNote: this.recordEscalatedRunNote.bind(this),
      finalizeVerifiedNoPrCompletion: async ({ task, issueNumber, marker, sessionId, output }) => {
        return await this.finalizeVerifiedNoPrCompletion({
          task,
          issueNumber,
          marker,
          startTime: params.startTime,
          cacheKey: params.cacheKey,
          sessionId,
          output,
          opencodeXdg: params.opencodeXdg,
          workerId: params.workerId,
          repoSlot: params.allocatedSlot,
        });
      },
    });
  }

  private async finalizeVerifiedNoPrCompletion(params: {
    task: AgentTask;
    issueNumber: number;
    marker: ParentVerificationMarker;
    startTime: Date;
    cacheKey: string;
    sessionId?: string;
    output?: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    workerId?: string;
    repoSlot?: number | null;
  }): Promise<AgentRun> {
    const writeback = await writeParentVerificationNoPrCompletion(
      {
        repo: this.repo,
        issueNumber: params.issueNumber,
        marker: params.marker,
      },
      { github: this.github }
    );

    if (!writeback.ok) {
      throw new Error(writeback.error ?? "Parent verification writeback failed");
    }

    const issueUrl = `https://github.com/${this.repo}/issues/${params.issueNumber}`;
    recordIssueSnapshot({
      repo: this.repo,
      issue: params.task.issue,
      state: "CLOSED",
      url: issueUrl,
    });

    return await this.finalizeTaskSuccess({
      task: params.task,
      prUrl: null,
      completionKind: "verified",
      sessionId: params.sessionId || params.task["session-id"]?.trim() || "parent-verify-no-pr",
      startTime: params.startTime,
      cacheKey: `parent-verify-${params.cacheKey}`,
      opencodeXdg: params.opencodeXdg,
      workerId: params.workerId,
      repoSlot: typeof params.repoSlot === "number" ? String(params.repoSlot) : undefined,
      notify: true,
      logMessage: `Task verified via comment-only completion: ${params.task.name}`,
      surveyResults: params.output,
    });
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
    return getPinnedOpencodeProfileNameCore(task);
  }

  private async resolveOpencodeXdgForTask(
    task: AgentTask,
    phase: "start" | "resume",
    sessionId?: string
  ): Promise<{
    profileName: string | null;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    error?: string;
  }> {
    return resolveOpencodeXdgForTaskCore({
      task,
      phase,
      sessionId,
      repo: this.repo,
      nowMs: Date.now(),
      getThrottleDecision: this.throttle.getThrottleDecision,
      log: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
      envHome: process.env.HOME,
    });
  }

  private getPauseControl() {
    return createPauseControl({
      readControlStateSnapshot,
      defaults: getConfig().control,
      isRalphCheckpoint,
      log: (message) => console.warn(message),
    });
  }

  private readPauseRequested(): boolean {
    return this.getPauseControl().readPauseRequested();
  }

  private readPauseControl(): { pauseRequested: boolean; pauseAtCheckpoint: RalphCheckpoint | null } {
    return this.getPauseControl().readPauseControl();
  }

  private async waitForPauseCleared(opts?: { signal?: AbortSignal }): Promise<void> {
    await this.getPauseControl().waitForPauseCleared(opts);
  }

  private async recordCheckpoint(task: AgentTask, checkpoint: RalphCheckpoint, sessionId?: string): Promise<void> {
    const workerId = await this.formatWorkerId(task, task._path);
    await recordCheckpoint({
      task,
      checkpoint,
      workerId,
      repo: this.repo,
      sessionId,
      pauseControl: this.getPauseControl(),
      updateTaskStatus: this.queue.updateTaskStatus,
      applyTaskPatch,
      emitter: {
        emit: (event: RalphEvent, key: string) => this.checkpointEvents.emit(event, key),
        hasEmitted: (key: string) => this.checkpointEvents.hasEmitted(key),
      },
      log: (message) => console.warn(message),
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
      escalationType: "watchdog",
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
      escalationType: "watchdog",
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

      const resolvedOpencode = await this.resolveOpencodeXdgForTask(task, "resume", existingSessionId);

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
      const mergeConflictRun = await this.maybeHandleQueuedMergeConflict({
        task,
        issueNumber: issueNumber || cacheKey,
        taskRepoPath,
        cacheKey,
        botBranch,
        issueMeta,
        startTime,
        opencodeXdg,
        opencodeSessionOptions,
      });
      if (mergeConflictRun) return mergeConflictRun;

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
      const prCreateEvidence: string[] = [];
      const addPrCreateEvidence = (text: string | null | undefined): void => {
        const normalized = String(text ?? "").trim();
        if (normalized) prCreateEvidence.push(normalized);
      };
      addPrCreateEvidence(buildResult.output);

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
            await this.writeEscalationWriteback(task, { reason, escalationType: "watchdog" });
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "watchdog",
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
              ...this.buildLoopDetectionOptions(task, "resume-loop-break"),
              ...opencodeSessionOptions,
            }
          );
          addPrCreateEvidence(buildResult.output);

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
          ...this.buildLoopDetectionOptions(task, "resume-continue"),
          ...opencodeSessionOptions,
        });
        addPrCreateEvidence(buildResult.output);

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
        const derived = derivePrCreateEscalationReason({
          continueAttempts,
          evidence: prCreateEvidence,
        });
        const planOutput = [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n");
        this.recordMissingPrEvidence({
          task,
          issueNumber,
          botBranch,
          reason: derived.reason,
          diagnostics: planOutput,
        });
        return await this.escalateNoPrAfterRetries({
          task,
          reason: derived.reason,
          details: derived.details,
          planOutput,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
        });
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
      buildResult.sessionId = mergeGate.sessionId || buildResult.sessionId;

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
        const classification = classifyOpencodeFailure(`${reason}\n${details}`);
        await this.markTaskBlocked(task, classification?.blockedSource ?? "runtime-error", {
          reason: classification?.reason ?? reason,
          details,
        });
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
      // 1. Extract issue number (e.g., "owner/repo#245" -> "245")
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
        startTime,
        cacheKey,
        workerId,
        allocatedSlot,
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
        throw new Error("Failed to mark task starting (queue status update failed)");
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

      const existingPrForQueue = await this.getIssuePrResolution(issueNumber);
      if (existingPrForQueue.selectedUrl) {
        if (existingPrForQueue.duplicates.length > 0) {
          console.log(
            `[ralph:worker:${this.repo}] Duplicate PRs detected for ${task.issue}: ${existingPrForQueue.duplicates.join(
              ", "
            )}`
          );
        }
        return await this.parkTaskWaitingOnOpenPr(task, issueNumber, existingPrForQueue.selectedUrl);
      }

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

        const classification = classifyOpencodeFailure(planResult.output);
        const reason = classification?.reason ?? `planner failed: ${planResult.output}`;
        const details = planResult.output;

        await this.markTaskBlocked(task, classification?.blockedSource ?? "runtime-error", {
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
      const prCreateEvidence: string[] = [];
      const addPrCreateEvidence = (text: string | null | undefined): void => {
        const normalized = String(text ?? "").trim();
        if (normalized) prCreateEvidence.push(normalized);
      };
      addPrCreateEvidence(buildResult.output);

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
            await this.writeEscalationWriteback(task, { reason, escalationType: "watchdog" });
            await this.notify.notifyEscalation({
              taskName: task.name,
              taskFileName: task._name,
              taskPath: task._path,
              issue: task.issue,
              repo: this.repo,
              sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
              reason,
              escalationType: "watchdog",
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
              ...this.buildLoopDetectionOptions(task, "build-loop-break"),
              ...opencodeSessionOptions,
            }
          );
          addPrCreateEvidence(buildResult.output);

          await this.recordImplementationCheckpoint(task, buildResult.sessionId);

          const pausedBuildLoopBreakAfter = await this.pauseIfHardThrottled(task, "build loop-break (post)", buildResult.sessionId);
          if (pausedBuildLoopBreakAfter) return pausedBuildLoopBreakAfter;

            if (!buildResult.success) {
              if (buildResult.loopTrip) {
                return await this.handleLoopTrip(task, cacheKey, "build-loop-break", buildResult);
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
          ...this.buildLoopDetectionOptions(task, "build-continue"),
          ...opencodeSessionOptions,
        });
        addPrCreateEvidence(buildResult.output);

        await this.recordImplementationCheckpoint(task, buildResult.sessionId);

        const pausedBuildContinueAfter = await this.pauseIfHardThrottled(task, "build continue (post)", buildResult.sessionId);
        if (pausedBuildContinueAfter) return pausedBuildContinueAfter;

        if (!buildResult.success) {
          if (buildResult.loopTrip) {
            return await this.handleLoopTrip(task, cacheKey, "build-continue", buildResult);
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
        const derived = derivePrCreateEscalationReason({
          continueAttempts,
          evidence: prCreateEvidence,
        });
        const planOutput = [buildResult.output, prRecoveryDiagnostics].filter(Boolean).join("\n\n");
        this.recordMissingPrEvidence({
          task,
          issueNumber,
          botBranch,
          reason: derived.reason,
          diagnostics: planOutput,
        });
        return await this.escalateNoPrAfterRetries({
          task,
          reason: derived.reason,
          details: derived.details,
          planOutput,
          sessionId: buildResult.sessionId || task["session-id"]?.trim() || undefined,
        });
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
      buildResult.sessionId = mergeGate.sessionId || buildResult.sessionId;

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
        const classification = classifyOpencodeFailure(`${reason}\n${details}`);
        await this.markTaskBlocked(task, classification?.blockedSource ?? "runtime-error", {
          reason: classification?.reason ?? reason,
          details,
        });
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
    // Agent-run artifacts are persisted via SQLite run records.
    if (data.sessionId) {
      await cleanupIntrospectionLogs(data.sessionId);
    }
  }
}
