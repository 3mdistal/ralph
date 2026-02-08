import { $ } from "bun";

import { join } from "path";

import type { AgentTask } from "../../queue-backend";
import type { IssueMetadata } from "../../escalation";

import { createGhRunner } from "../../github/gh-runner";
import { getRalphWorktreesDir } from "../../paths";
import { parseIssueRef } from "../../github/issue-ref";
import { safeNoteName } from "../names";

import {
  findMergeConflictComment,
  type MergeConflictAttempt,
  type MergeConflictCommentState,
} from "../../github/merge-conflict-comment";
import {
  buildMergeConflictCommentLines,
  buildMergeConflictSignature,
  classifyMergeConflictFailure,
  computeMergeConflictDecision,
  formatMergeConflictPaths,
  type MergeConflictFailureClass,
} from "../../merge-conflict-recovery";

// Keep these values aligned with src/worker/repo-worker.ts
const MERGE_CONFLICT_COMMENT_SCAN_LIMIT = 50;
const MERGE_CONFLICT_WAIT_TIMEOUT_MS = 10 * 60_000;
const MERGE_CONFLICT_WAIT_POLL_MS = 15_000;

const ghWrite = (repo: string) => createGhRunner({ repo, mode: "write" });

export async function runMergeConflictRecovery(
  worker: any,
  params: {
    task: AgentTask;
    issueNumber: string;
    cacheKey: string;
    prUrl: string;
    issueMeta: IssueMetadata;
    botBranch: string;
    opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string };
    opencodeSessionOptions: { opencodeXdg?: { dataHome?: string; configHome?: string; stateHome?: string; cacheHome?: string } };
  }
): Promise<any> {
  const RALPH_WORKTREES_DIR = getRalphWorktreesDir();

  const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
    repo: worker.repo,
    number: Number(params.issueNumber),
  };
  const maxAttempts = worker.resolveMergeConflictAttempts();
  const workerId = await worker.formatWorkerId(params.task, params.task._path);

  let prState: any;
  let requiredChecks: string[] = [];
  let baseRefName: string | null = null;
  let headRefName: string | null = null;
  let previousHeadSha = "";

  try {
    prState = await worker.getPullRequestMergeState(params.prUrl);
    baseRefName = prState.baseRefName || params.botBranch;
    headRefName = prState.headRefName || null;
    ({ checks: requiredChecks } = await worker.resolveRequiredChecksForMerge());
    const prStatus = await worker.getPullRequestChecks(params.prUrl);
    previousHeadSha = prStatus.headSha;
  } catch (error: any) {
    const reason = `Merge-conflict recovery preflight failed for ${params.prUrl}: ${worker.formatGhError(error)}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return {
      status: "failed",
      run: {
        taskName: params.task.name,
        repo: worker.repo,
        outcome: "failed",
        sessionId: params.task["session-id"]?.trim(),
        escalationReason: reason,
      },
    };
  }

  if (prState.isCrossRepository || prState.headRepoFullName !== worker.repo) {
    const reason = `Merge-conflict recovery cannot push cross-repo PR ${params.prUrl}; requires same-repo branch access`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return await worker.finalizeMergeConflictEscalation({
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
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return await worker.finalizeMergeConflictEscalation({
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
    github: worker.github,
    repo: worker.repo,
    issueNumber: Number(params.issueNumber),
    limit: MERGE_CONFLICT_COMMENT_SCAN_LIMIT,
  });
  const existingState = commentMatch.state ?? ({ version: 1 } satisfies MergeConflictCommentState);
  const attempts = [...(existingState.attempts ?? [])];

  const nowMs = Date.now();
  const lease = existingState.lease;
  if (worker.isMergeConflictLeaseActive(lease, nowMs) && lease?.holder !== workerId) {
    const reason = `Merge-conflict lease already held by ${lease?.holder ?? "unknown"}; skipping duplicate run for ${params.prUrl}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return {
      status: "failed",
      run: {
        taskName: params.task.name,
        repo: worker.repo,
        outcome: "failed",
        sessionId: params.task["session-id"]?.trim(),
        escalationReason: reason,
      },
    };
  }

  const attemptNumber = attempts.length + 1;
  const worktreePath = join(
    RALPH_WORKTREES_DIR,
    safeNoteName(worker.repo),
    "merge-conflict",
    params.issueNumber,
    safeNoteName(`attempt-${attemptNumber}`)
  );

  await worker.ensureGitWorktree(worktreePath);

  let conflictPaths: string[] = [];
  let baseSha = "";
  let headSha = "";
  let normalizedBase = worker.normalizeGitRef(baseRefName || params.botBranch);
  let normalizedHead = worker.normalizeGitRef(headRefName);

  try {
    await $`git fetch origin`.cwd(worktreePath).quiet();
    await ghWrite(worker.repo)`gh pr checkout ${params.prUrl}`.cwd(worktreePath).quiet();

    if (!normalizedHead) {
      throw new Error(`Missing head ref for merge-conflict recovery: ${params.prUrl}`);
    }

    try {
      await $`git push --dry-run origin HEAD:${normalizedHead}`.cwd(worktreePath).quiet();
    } catch (error: any) {
      const reason = `Merge-conflict recovery cannot push to ${normalizedHead} for ${params.prUrl}: ${worker.formatGhError(error)}`;
      console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
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
      await worker.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: finalState });
      await worker.clearMergeConflictLabels(issueRef);
      await worker.cleanupGitWorktree(worktreePath);
      return await worker.finalizeMergeConflictEscalation({
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

    conflictPaths = await worker.listMergeConflictPaths(worktreePath);
    baseSha = (await $`git rev-parse origin/${normalizedBase}`.cwd(worktreePath).quiet()).stdout.toString().trim();
    headSha = (await $`git rev-parse HEAD`.cwd(worktreePath).quiet()).stdout.toString().trim();
  } catch (error: any) {
    const reason = `Merge-conflict recovery setup failed for ${params.prUrl}: ${worker.formatGhError(error)}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    await worker.cleanupGitWorktree(worktreePath);
    return {
      status: "failed",
      run: {
        taskName: params.task.name,
        repo: worker.repo,
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
    await worker.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: finalState });
    await worker.clearMergeConflictLabels(issueRef);
    await worker.cleanupGitWorktree(worktreePath);
    return await worker.finalizeMergeConflictEscalation({
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
    lease: worker.buildMergeConflictLease(workerId, nowMs),
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
    reason: decision.graceApplied
      ? "Repeated conflict signature after non-merge-progress failure; consuming one bounded grace retry (1/1)."
      : undefined,
  });
  await worker.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines, state: nextState });
  await worker.applyMergeConflictLabels(issueRef);

  const finalizeFailedAttempt = async (failure: {
    failureClass: MergeConflictFailureClass;
    reason?: string;
    retry: boolean;
    action?: string;
  }) => {
    attempt.status = "failed";
    attempt.completedAt = new Date().toISOString();
    attempt.failureClass = failure.failureClass;

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
      action:
        failure.action ||
        (failure.retry
          ? "Merge-conflict recovery attempt failed; retrying if attempts remain."
          : "Merge-conflict recovery attempt failed; awaiting orchestrator retry/escalation handling."),
      reason: failure.reason,
    });
    await worker.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: failedLines, state: failedState });
    await worker.cleanupGitWorktree(worktreePath);
    if (failure.retry) {
      return await runMergeConflictRecovery(worker, { ...params, opencodeSessionOptions: params.opencodeSessionOptions });
    }
    return null;
  };

  const prompt = worker.buildMergeConflictPrompt(params.prUrl, baseRefName, params.botBranch);
  const runLogPath = await worker.recordRunLogPath(
    params.task,
    params.issueNumber,
    `merge-conflict-${attemptNumber}`,
    "in-progress"
  );

  let sessionResult = await worker.session.runAgent(worktreePath, "general", prompt, {
    repo: worker.repo,
    cacheKey: params.cacheKey,
    runLogPath,
    introspection: {
      repo: worker.repo,
      issue: params.task.issue,
      taskName: params.task.name,
      step: 4,
      stepTitle: `merge-conflict attempt ${attemptNumber}`,
    },
    ...worker.buildWatchdogOptions(params.task, `merge-conflict-${attemptNumber}`),
    ...worker.buildStallOptions(params.task, `merge-conflict-${attemptNumber}`),
    ...worker.buildLoopDetectionOptions(params.task, `merge-conflict-${attemptNumber}`),
    ...params.opencodeSessionOptions,
  });

  const pausedAfter = await worker.pauseIfHardThrottled(
    params.task,
    `merge-conflict-${attemptNumber} (post)`,
    sessionResult.sessionId
  );
  if (pausedAfter) {
    await finalizeFailedAttempt({
      failureClass: "runtime",
      reason: "Merge-conflict recovery paused by hard-throttle guardrail after attempt execution.",
      retry: false,
      action: "Merge-conflict recovery paused due to hard throttling; waiting for orchestrator resume.",
    });
    return { status: "failed", run: pausedAfter };
  }

  if (sessionResult.loopTrip) {
    await finalizeFailedAttempt({
      failureClass: "runtime",
      reason: "Merge-conflict recovery run hit loop-detection guardrails.",
      retry: false,
    });
    const run = await worker.handleLoopTrip(params.task, params.cacheKey, `merge-conflict-${attemptNumber}`, sessionResult);
    return { status: "failed", run };
  }

  if (sessionResult.watchdogTimeout) {
    await finalizeFailedAttempt({
      failureClass: "runtime",
      reason: "Merge-conflict recovery run hit watchdog timeout guardrails.",
      retry: false,
    });
    const run = await worker.handleWatchdogTimeout(
      params.task,
      params.cacheKey,
      `merge-conflict-${attemptNumber}`,
      sessionResult,
      params.opencodeXdg
    );
    return { status: "failed", run };
  }

  if (sessionResult.sessionId) {
    await worker.queue.updateTaskStatus(params.task, "in-progress", { "session-id": sessionResult.sessionId });
  }

  if (!sessionResult.success) {
    const failureClass = classifyMergeConflictFailure({ reason: sessionResult.output || "" });
    const retryResult = await finalizeFailedAttempt({
      failureClass,
      reason: `Merge-conflict recovery session exited without success for ${params.prUrl}.`,
      retry: true,
    });
    return retryResult;
  }

  let postRecovery;
  try {
    postRecovery = await worker.waitForMergeConflictRecoverySignals({
      prUrl: params.prUrl,
      previousHeadSha,
      requiredChecks,
      timeoutMs: MERGE_CONFLICT_WAIT_TIMEOUT_MS,
      pollIntervalMs: MERGE_CONFLICT_WAIT_POLL_MS,
    });
  } catch (error: any) {
    const reason = `Merge-conflict recovery failed while waiting for updated PR state: ${worker.formatGhError(error)}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    const failureClass = classifyMergeConflictFailure({ reason });
    const retryResult = await finalizeFailedAttempt({ failureClass, reason, retry: true });
    return retryResult;
  }

  if (postRecovery.mergeStateStatus === "DIRTY" || postRecovery.timedOut) {
    const reason = postRecovery.timedOut
      ? `Merge-conflict recovery timed out waiting for updated PR state for ${params.prUrl}`
      : `Merge conflicts remain after recovery attempt for ${params.prUrl}`;
    const failureClass = postRecovery.timedOut ? "runtime" : "merge-content";
    const retryResult = await finalizeFailedAttempt({ failureClass, reason, retry: true });
    return retryResult;
  }

  attempt.status = "succeeded";
  attempt.completedAt = new Date().toISOString();

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
  await worker.upsertMergeConflictComment({ issueNumber: Number(params.issueNumber), lines: finalLines, state: finalState });
  await worker.cleanupGitWorktree(worktreePath);

  await worker.clearMergeConflictLabels(issueRef);

  return {
    status: "success",
    prUrl: params.prUrl,
    sessionId: sessionResult.sessionId || params.task["session-id"]?.trim() || "",
    headSha: postRecovery.headSha,
  };
}
