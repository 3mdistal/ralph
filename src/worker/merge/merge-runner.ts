import type { AgentTask } from "../../queue-backend";
import type { IssueMetadata } from "../../escalation";
import type { BlockedSource } from "../../blocked-sources";
import type { SessionResult } from "../../session";

import { getAutoUpdateBehindLabelGate, getAutoUpdateBehindMinMinutes, isAutoUpdateBehindEnabled } from "../../config";
import { PR_STATE_MERGED } from "../../state";
import {
  prepareReviewDiffArtifacts,
  recordReviewGateFailure,
  recordReviewGateSkipped,
  runReviewGate,
  type ReviewDiffArtifacts,
  type ReviewGateResult,
  type ReviewGateName,
} from "../../gates/review";

import {
  formatRequiredChecksForHumans,
  isCiOnlyChangeSet,
  isCiRelatedIssue,
  summarizeRequiredChecks,
  type PrCheck,
  type RequiredChecksSummary,
} from "../lanes/required-checks";

type AgentRun = {
  taskName: string;
  repo: string;
  outcome: "success" | "throttled" | "escalated" | "failed";
  pr?: string;
  completionKind?: "pr" | "verified";
  sessionId?: string;
  escalationReason?: string;
  surveyResults?: string;
};

type PullRequestChecks = {
  headSha: string;
  mergeStateStatus: string | null;
  baseRefName: string;
  checks: PrCheck[];
};

type WaitForRequiredChecksResult = {
  headSha: string;
  mergeStateStatus: string | null;
  baseRefName: string;
  summary: RequiredChecksSummary;
  checks: PrCheck[];
  timedOut: boolean;
  stopReason?: "merge-conflict";
};

type MergeConflictRecoveryResult =
  | { status: "success"; prUrl: string; sessionId?: string; headSha?: string }
  | { status: "failed" | "escalated" | "throttled"; run: AgentRun };

type CiFailureTriageResult =
  | { status: "success"; headSha: string; sessionId?: string }
  | { status: "failed" | "escalated" | "throttled"; run: AgentRun };

export async function mergePrWithRequiredChecks(params: {
  repo: string;
  task: AgentTask;
  repoPath: string;
  cacheKey: string;
  botBranch: string;
  prUrl: string;
  sessionId: string;
  issueMeta: IssueMetadata;
  runId?: string | null;
  watchdogStagePrefix: string;
  notifyTitle: string;
  opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };

  resolveRequiredChecksForMerge: () => Promise<{ checks: string[] }>;
  recordCheckpoint: (task: AgentTask, checkpoint: string, sessionId?: string) => Promise<void>;
  getPullRequestFiles: (prUrl: string) => Promise<string[]>;
  getPullRequestBaseBranch: (prUrl: string) => Promise<string | null>;
  isMainMergeAllowed: (baseBranch: string | null, botBranch: string, labels: string[]) => boolean;
  createAgentRun: (
    task: AgentTask,
    opts: {
      outcome: "success" | "failed" | "escalated";
      started: Date;
      completed: Date;
      sessionId?: string;
      bodyPrefix?: string;
    }
  ) => Promise<unknown>;
  markTaskBlocked: (
    task: AgentTask,
    source: BlockedSource,
    opts: {
      reason: string;
      details?: string;
      sessionId?: string;
      skipRunNote?: boolean;
      extraFields?: Record<string, string>;
    }
  ) => Promise<unknown>;

  getPullRequestChecks: (prUrl: string) => Promise<PullRequestChecks>;
  recordCiGateSummary: (prUrl: string, summary: RequiredChecksSummary) => void;
  buildIssueContextForAgent: (params: { repo: string; issueNumber: string }) => Promise<string>;
  runReviewAgent: (params: {
    agent: "product" | "devex" | "general" | "ralph-plan";
    prompt: string;
    cacheKey: string;
    stage: string;
    sessionId: string;
    continueSessionId?: string;
  }) => Promise<SessionResult>;
  runMergeConflictRecovery: (input: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    issueMeta: IssueMetadata;
    botBranch: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: any;
  }) => Promise<MergeConflictRecoveryResult>;

  updatePullRequestBranch: (prUrl: string, cwd: string) => Promise<void>;
  formatGhError: (error: unknown) => string;
  isAuthError: (error: unknown) => boolean;

  mergePullRequest: (prUrl: string, headSha: string, cwd: string) => Promise<void>;
  recordPrSnapshotBestEffort: (input: { issue: string; prUrl: string; state: string }) => void;
  applyMidpointLabelsBestEffort: (input: {
    task: AgentTask;
    prUrl: string;
    botBranch: string;
    baseBranch: string | null;
  }) => Promise<void>;
  deleteMergedPrHeadBranchBestEffort: (input: { prUrl: string; botBranch: string; mergedHeadSha: string }) => Promise<void>;
  normalizeGitRef: (ref: string) => string;

  isOutOfDateMergeError: (error: unknown) => boolean;
  isBaseBranchModifiedMergeError: (error: unknown) => boolean;
  isRequiredChecksExpectedMergeError: (error: unknown) => boolean;
  waitForRequiredChecks: (prUrl: string, requiredChecks: string[], opts: { timeoutMs: number; pollIntervalMs: number }) => Promise<WaitForRequiredChecksResult>;
  runCiFailureTriage: (input: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    requiredChecks: string[];
    issueMeta: IssueMetadata;
    botBranch: string;
    timedOut: boolean;
    repoPath: string;
    sessionId: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: any;
  }) => Promise<CiFailureTriageResult>;
  recordMergeFailureArtifact: (prUrl: string, diagnostic: string) => void;

  pauseIfHardThrottled: (task: AgentTask, stage: string, sessionId?: string) => Promise<AgentRun | null>;

  shouldAttemptProactiveUpdate: (prState: any) => { ok: boolean; reason?: string };
  shouldRateLimitAutoUpdate: (prState: any, minMinutes: number) => boolean;
  recordAutoUpdateAttempt: (prState: any, minMinutes: number) => void;
  recordAutoUpdateFailure: (prState: any, minMinutes: number) => void;
  getPullRequestMergeState: (prUrl: string) => Promise<any>;

  recurse: (next: {
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
  }) => Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }>;

  log?: (message: string) => void;
  warn?: (message: string) => void;
}): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));

  const { checks: REQUIRED_CHECKS } = await params.resolveRequiredChecksForMerge();

  let prUrl = params.prUrl;
  let sessionId = params.sessionId;
  let didUpdateBranch = false;

  await params.recordCheckpoint(params.task, "pr_ready", sessionId);

  const prFiles = await params.getPullRequestFiles(prUrl);
  const ciOnly = isCiOnlyChangeSet(prFiles);
  const isCiIssue = isCiRelatedIssue(params.issueMeta.labels ?? []);
  const issueNumber = params.task.issue.match(/#(\d+)$/)?.[1] ?? params.cacheKey;

  const blockOnAuthFailure = async (error: unknown, context: string) => {
    const reason = `Blocked: GitHub auth failed (${context})`;
    const details = params.formatGhError(error);
    await params.markTaskBlocked(params.task, "auth", { reason, details, sessionId });
    return {
      ok: false as const,
      run: {
        taskName: params.task.name,
        repo: params.repo,
        outcome: "failed" as const,
        pr: prUrl ?? undefined,
        sessionId,
        escalationReason: reason,
      },
    };
  };

  let baseBranch: string | null = null;
  try {
    baseBranch = await params.getPullRequestBaseBranch(prUrl);
  } catch (error: any) {
    if (params.isAuthError(error)) return await blockOnAuthFailure(error, "reading PR base branch");
    throw error;
  }
  if (!params.isMainMergeAllowed(baseBranch, params.botBranch, params.issueMeta.labels ?? [])) {
    const completed = new Date();
    const completedAt = completed.toISOString().split("T")[0];
    const reason = `Blocked: Ralph refuses to auto-merge PRs targeting '${baseBranch}'. Use ${params.botBranch} or an explicit override.`;

    await params.createAgentRun(params.task, {
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

    await params.markTaskBlocked(params.task, "merge-target", {
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
        repo: params.repo,
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

    await params.createAgentRun(params.task, {
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

    await params.markTaskBlocked(params.task, "ci-only", {
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
        repo: params.repo,
        outcome: "failed",
        pr: prUrl ?? undefined,
        sessionId,
        escalationReason: reason,
      },
    };
  }

  const reviewRunId = params.runId ?? null;
  if (!reviewRunId) {
    warn(`[ralph:worker:${params.repo}] Missing run id; skipping deterministic review gates for ${prUrl}`);
  } else {
    let issueContext = "";
    try {
      issueContext = await params.buildIssueContextForAgent({ repo: params.repo, issueNumber });
    } catch (error: any) {
      issueContext = `Issue context unavailable: ${error?.message ?? String(error)}`;
    }

    let reviewDiff: ReviewDiffArtifacts | null = null;
    try {
      const prStatus = await params.getPullRequestChecks(prUrl);
      reviewDiff = await prepareReviewDiffArtifacts({
        runId: reviewRunId,
        repoPath: params.repoPath,
        baseRef: prStatus.baseRefName,
        headRef: prStatus.headSha,
      });
    } catch (error: any) {
      if (params.isAuthError(error)) {
        return await blockOnAuthFailure(error, "preparing review diff artifacts");
      }
      const reason = `Review gate skipped: could not prepare diff artifacts (${error?.message ?? String(error)})`;
      warn(`[ralph:worker:${params.repo}] ${reason}`);
      recordReviewGateSkipped({ runId: reviewRunId, gate: "product_review", reason });
      recordReviewGateSkipped({ runId: reviewRunId, gate: "devex_review", reason });
    }

    if (!reviewDiff) {
      // Continue merge flow when diff artifacts cannot be produced.
      // This preserves existing merge behavior in degraded environments.
    } else {

    const runReview = async (
      gate: ReviewGateName,
      agent: "product" | "devex",
      stage: string
    ): Promise<ReviewGateResult> => {
      return await runReviewGate({
        runId: reviewRunId,
        gate,
        repo: params.repo,
        issueRef: params.task.issue,
        prUrl,
        issueContext,
        diff: reviewDiff,
        runAgent: (prompt) =>
          params.runReviewAgent({
            agent,
            prompt,
            cacheKey: `review-${params.cacheKey}-${agent}`,
            stage,
            sessionId,
          }),
        runRepairAgent: (prompt, continueSessionId) =>
          params.runReviewAgent({
            agent: "ralph-plan",
            prompt,
            cacheKey: `review-${params.cacheKey}-${agent}-repair`,
            stage: `${stage} marker repair`,
            sessionId,
            continueSessionId,
          }),
      });
    };

      const productReview = await runReview("product_review", "product", "product review");
      sessionId = productReview.sessionId || sessionId;
      if (productReview.status !== "pass") {
        const reason = `Review gate failed: product review (${productReview.reason})`;
        await params.markTaskBlocked(params.task, "review", {
          reason,
          details: reason,
          sessionId,
        });
        return {
          ok: false,
          run: {
            taskName: params.task.name,
            repo: params.repo,
            outcome: "failed",
            sessionId,
            escalationReason: reason,
          },
        };
      }

      const devexReview = await runReview("devex_review", "devex", "devex review");
      sessionId = devexReview.sessionId || sessionId;
      if (devexReview.status !== "pass") {
        const reason = `Review gate failed: devex review (${devexReview.reason})`;
        await params.markTaskBlocked(params.task, "review", {
          reason,
          details: reason,
          sessionId,
        });
        return {
          ok: false,
          run: {
            taskName: params.task.name,
            repo: params.repo,
            outcome: "failed",
            sessionId,
            escalationReason: reason,
          },
        };
      }
    }
  }

  const recurse = async (next: { prUrl: string; sessionId: string }): Promise<
    { ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }
  > => {
    return await params.recurse({
      task: params.task,
      repoPath: params.repoPath,
      cacheKey: params.cacheKey,
      botBranch: params.botBranch,
      prUrl: next.prUrl,
      sessionId: next.sessionId,
      issueMeta: params.issueMeta,
      watchdogStagePrefix: params.watchdogStagePrefix,
      notifyTitle: params.notifyTitle,
      opencodeXdg: params.opencodeXdg,
    });
  };

  const mergeWhenReady = async (
    headSha: string
  ): Promise<{ ok: true; prUrl: string; sessionId: string } | { ok: false; run: AgentRun }> => {
    // Pre-merge guard: required checks and mergeability can change between polling and the merge API call.
    try {
      const status = await params.getPullRequestChecks(prUrl);
      const summary = summarizeRequiredChecks(status.checks, REQUIRED_CHECKS);
      params.recordCiGateSummary(prUrl, summary);

      if (status.mergeStateStatus === "DIRTY") {
        const recovery = await params.runMergeConflictRecovery({
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
        return await recurse({ prUrl: recovery.prUrl, sessionId });
      }

      if (!didUpdateBranch && status.mergeStateStatus === "BEHIND") {
        log(`[ralph:worker:${params.repo}] PR BEHIND at merge time; updating branch ${prUrl}`);
        didUpdateBranch = true;
        try {
          await params.updatePullRequestBranch(prUrl, params.repoPath);
        } catch (updateError: any) {
          const reason = `Failed while updating PR branch before merge: ${params.formatGhError(updateError)}`;
          warn(`[ralph:worker:${params.repo}] ${reason}`);
          await params.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
          return {
            ok: false,
            run: {
              taskName: params.task.name,
              repo: params.repo,
              outcome: "failed",
              sessionId,
              escalationReason: reason,
            },
          };
        }

        return await recurse({ prUrl, sessionId });
      }

      if (summary.status !== "success") {
        if (summary.status === "pending") {
          log(`[ralph:worker:${params.repo}] Required checks pending at merge time; resuming merge gate ${prUrl}`);
          return await recurse({ prUrl, sessionId });
        }

        const reason = `Merge blocked: required checks not green for ${prUrl}`;
        const details = [
          formatRequiredChecksForHumans(summary),
          "",
          "Merge attempt would be rejected by branch protection.",
        ].join("\n");
        await params.markTaskBlocked(params.task, "ci-failure", { reason, details, sessionId });
        return {
          ok: false,
          run: {
            taskName: params.task.name,
            repo: params.repo,
            outcome: "failed",
            sessionId,
            escalationReason: reason,
          },
        };
      }

      headSha = status.headSha;
    } catch (error: any) {
      if (params.isAuthError(error)) {
        return await blockOnAuthFailure(error, "pre-merge guard (reading PR checks/state)");
      }
      warn(`[ralph:worker:${params.repo}] Pre-merge guard failed (continuing): ${params.formatGhError(error)}`);
    }

    log(`[ralph:worker:${params.repo}] Required checks passed; merging ${prUrl}`);
    try {
      await params.mergePullRequest(prUrl, headSha, params.repoPath);
      params.recordPrSnapshotBestEffort({ issue: params.task.issue, prUrl, state: PR_STATE_MERGED });
      try {
        await params.applyMidpointLabelsBestEffort({
          task: params.task,
          prUrl,
          botBranch: params.botBranch,
          baseBranch,
        });
      } catch (error: any) {
        warn(`[ralph:worker:${params.repo}] Failed to apply midpoint labels: ${params.formatGhError(error)}`);
      }
      try {
        const normalizedBase = baseBranch ? params.normalizeGitRef(baseBranch) : "";
        const normalizedBot = params.normalizeGitRef(params.botBranch);
        if (normalizedBase && normalizedBase === normalizedBot) {
          await params.deleteMergedPrHeadBranchBestEffort({
            prUrl,
            botBranch: params.botBranch,
            mergedHeadSha: headSha,
          });
        }
      } catch (error: any) {
        warn(`[ralph:worker:${params.repo}] Failed to delete PR head branch: ${params.formatGhError(error)}`);
      }
      await params.recordCheckpoint(params.task, "merge_step_complete", sessionId);
      return { ok: true, prUrl, sessionId };
    } catch (error: any) {
      const shouldUpdateBeforeRetry =
        !didUpdateBranch &&
        (params.isOutOfDateMergeError(error) ||
          params.isBaseBranchModifiedMergeError(error) ||
          params.isRequiredChecksExpectedMergeError(error));

      if (shouldUpdateBeforeRetry) {
        const why = params.isRequiredChecksExpectedMergeError(error)
          ? "required checks expected"
          : params.isBaseBranchModifiedMergeError(error)
            ? "base branch changed"
            : "out of date with base";
        log(`[ralph:worker:${params.repo}] PR ${why}; updating branch ${prUrl}`);
        didUpdateBranch = true;
        try {
          await params.updatePullRequestBranch(prUrl, params.repoPath);
        } catch (updateError: any) {
          const reason = `Failed while updating PR branch before merge: ${params.formatGhError(updateError)}`;
          warn(`[ralph:worker:${params.repo}] ${reason}`);
          await params.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
          return {
            ok: false,
            run: {
              taskName: params.task.name,
              repo: params.repo,
              outcome: "failed",
              sessionId,
              escalationReason: reason,
            },
          };
        }

        const refreshed = await params.waitForRequiredChecks(prUrl, REQUIRED_CHECKS, {
          timeoutMs: 45 * 60_000,
          pollIntervalMs: 30_000,
        });

        if (refreshed.stopReason === "merge-conflict") {
          const recovery = await params.runMergeConflictRecovery({
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
          return await recurse({ prUrl: recovery.prUrl, sessionId });
        }

        if (refreshed.summary.status === "success") {
          return await mergeWhenReady(refreshed.headSha);
        }

        const ciDebug = await params.runCiFailureTriage({
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

      const diagnostic = params.formatGhError(error);
      params.recordMergeFailureArtifact(prUrl, diagnostic);

      let source: BlockedSource = "runtime-error";
      let reason = `Merge failed for ${prUrl}`;
      let details = diagnostic;

      try {
        const status = await params.getPullRequestChecks(prUrl);
        const summary = summarizeRequiredChecks(status.checks, REQUIRED_CHECKS);
        params.recordCiGateSummary(prUrl, summary);

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
        } else if (params.isBaseBranchModifiedMergeError(error)) {
          source = "auto-update";
          reason = `Merge blocked: base branch changed for ${prUrl}`;
        } else if (params.isRequiredChecksExpectedMergeError(error)) {
          source = "ci-failure";
          reason = `Merge blocked: required checks expected for ${prUrl}`;
        } else if (params.isOutOfDateMergeError(error)) {
          source = "auto-update";
          reason = `Merge blocked: PR not up to date with base for ${prUrl}`;
        }
      } catch (statusError: any) {
        details = [diagnostic, "", `Additionally failed to refresh PR status: ${params.formatGhError(statusError)}`]
          .join("\n")
          .trim();
      }

      await params.markTaskBlocked(params.task, source, { reason, details, sessionId });
      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: params.repo,
          outcome: "failed",
          pr: prUrl ?? undefined,
          sessionId,
          escalationReason: reason,
        },
      };
    }
  };

  if (!didUpdateBranch && isAutoUpdateBehindEnabled(params.repo)) {
    try {
      const prState = await params.getPullRequestMergeState(prUrl);
      const guard = params.shouldAttemptProactiveUpdate(prState);
      const labelGate = getAutoUpdateBehindLabelGate(params.repo);
      const minMinutes = getAutoUpdateBehindMinMinutes(params.repo);
      const rateLimited = params.shouldRateLimitAutoUpdate(prState, minMinutes);

      if (prState.mergeStateStatus === "DIRTY") {
        const recovery = await params.runMergeConflictRecovery({
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
        return await recurse({ prUrl: recovery.prUrl, sessionId });
      }

      const hasLabelGate = labelGate
        ? prState.labels.map((label: string) => label.toLowerCase()).includes(labelGate.toLowerCase())
        : true;

      if (!hasLabelGate) {
        log(`[ralph:worker:${params.repo}] PR behind but missing label gate ${labelGate ?? ""}; skipping auto-update ${prUrl}`);
      } else if (!guard.ok) {
        log(`[ralph:worker:${params.repo}] PR auto-update skipped (${guard.reason ?? "guardrail"}): ${prUrl}`);
      } else if (rateLimited) {
        log(`[ralph:worker:${params.repo}] PR auto-update rate-limited; skipping ${prUrl}`);
      } else {
        log(`[ralph:worker:${params.repo}] PR BEHIND; updating branch ${prUrl}`);
        params.recordAutoUpdateAttempt(prState, minMinutes);
        await params.updatePullRequestBranch(prUrl, params.repoPath);
        didUpdateBranch = true;
      }
    } catch (updateError: any) {
      const reason = `Failed while auto-updating PR branch: ${params.formatGhError(updateError)}`;
      warn(`[ralph:worker:${params.repo}] ${reason}`);
      try {
        const prState = await params.getPullRequestMergeState(prUrl);
        const minMinutes = getAutoUpdateBehindMinMinutes(params.repo);
        params.recordAutoUpdateFailure(prState, minMinutes);
      } catch {
        // best-effort
      }
      await params.markTaskBlocked(params.task, "auto-update", { reason, details: reason, sessionId });
      return {
        ok: false,
        run: {
          taskName: params.task.name,
          repo: params.repo,
          outcome: "failed",
          sessionId,
          escalationReason: reason,
        },
      };
    }
  }

  const checkResult = await params.waitForRequiredChecks(prUrl, REQUIRED_CHECKS, {
    timeoutMs: 45 * 60_000,
    pollIntervalMs: 30_000,
  });

  if (checkResult.stopReason === "merge-conflict") {
    const recovery = await params.runMergeConflictRecovery({
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
    return await recurse({ prUrl: recovery.prUrl, sessionId });
  }

  const throttled = await params.pauseIfHardThrottled(
    params.task,
    `${params.watchdogStagePrefix}-ci-remediation`,
    sessionId
  );
  if (throttled) return { ok: false, run: throttled };

  if (checkResult.summary.status === "success") {
    return await mergeWhenReady(checkResult.headSha);
  }

  const ciDebug = await params.runCiFailureTriage({
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
