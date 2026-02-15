import type { AgentTask } from "../../queue-backend";
import type { IssueMetadata } from "../../escalation";

import { parseIssueRef } from "../../github/issue-ref";
import { redactSensitiveText } from "../../redaction";

import { findCiDebugComment, type CiDebugCommentState, type CiTriageCommentState } from "../../github/ci-debug-comment";
import { buildCiTriageDecision } from "../../ci-triage/core";
import { buildCiFailureSignatureV2 } from "../../ci-triage/signature";
import { summarizeRequiredChecks } from "../lanes/required-checks";

// Keep these values aligned with src/worker/repo-worker.ts
const CI_DEBUG_COMMENT_SCAN_LIMIT = 100;

export async function runCiFailureTriage(
  worker: any,
  params: {
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
  }
): Promise<any> {
  const issueRef = parseIssueRef(params.task.issue, params.task.repo) ?? {
    repo: worker.repo,
    number: Number(params.issueNumber),
  };
  const maxAttempts = worker.resolveCiFixAttempts();
  const sessionId = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";
  const hasSession = Boolean(sessionId);

  let summary: any;
  let headSha = "";
  let baseRefName: string | null = null;
  let headRefName: string | null = null;

  try {
    const prStatus = await worker.getPullRequestChecks(params.prUrl);
    summary = summarizeRequiredChecks(prStatus.checks, params.requiredChecks);
    headSha = prStatus.headSha;
    baseRefName = prStatus.baseRefName;
    const prState = await worker.getPullRequestMergeState(params.prUrl);
    headRefName = prState.headRefName || null;
    worker.recordCiGateSummary(params.prUrl, summary, { timedOut: params.timedOut, requiredChecks: params.requiredChecks });
  } catch (error: any) {
    const reason = `CI triage preflight failed for ${params.prUrl}: ${worker.formatGhError(error)}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return {
      status: "failed",
      run: {
        taskName: params.task.name,
        repo: worker.repo,
        outcome: "failed",
        sessionId: sessionId || undefined,
        escalationReason: reason,
      },
    };
  }

  const remediation = await worker.buildRemediationFailureContext(summary, { includeLogs: true });
  const failureEntries = remediation.logs.length > 0
    ? remediation.logs
    : remediation.failedChecks.map((check: any) => ({ ...check, logExcerpt: null }));
  const signature = buildCiFailureSignatureV2({
    timedOut: params.timedOut,
    failures: failureEntries.map((entry: any) => ({
      name: entry.name,
      rawState: entry.rawState,
      excerpt: entry.logExcerpt ?? null,
    })),
  });

  const commentMatch = await findCiDebugComment({
    github: worker.github,
    repo: worker.repo,
    issueNumber: Number(params.issueNumber),
    limit: CI_DEBUG_COMMENT_SCAN_LIMIT,
  });
  const existingState = commentMatch.state ?? ({ version: 1 } satisfies CiDebugCommentState);
  const existingTriage = existingState.triage ?? ({ version: 1, attemptCount: 0 } satisfies CiTriageCommentState);
  const attemptNumber = Math.max(0, existingTriage.attemptCount ?? 0) + 1;
  const priorSignature = existingTriage.lastSignature ?? null;

  const decision = buildCiTriageDecision({
    timedOut: params.timedOut,
    failures: failureEntries.map((entry: any) => ({
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

  const triageRecord = worker.buildCiTriageRecord({
    signature,
    decision,
    timedOut: params.timedOut,
    attempt: attemptNumber,
    maxAttempts,
    priorSignature,
    failedChecks: remediation.failedChecks,
    commands: remediation.commands,
  });
  worker.recordCiTriageArtifact(triageRecord);

  console.log(
    `[ralph:worker:${worker.repo}] CI triage decision action=${decision.action} classification=${decision.classification} ` +
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
    return worker.escalateCiDebugRecovery({
      task: params.task,
      issueNumber: Number(params.issueNumber),
      issueRef,
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: params.timedOut,
      attempts: [...(existingState.attempts ?? [])],
      signature: worker.formatCiDebugSignature(summary, params.timedOut),
      maxAttempts,
      reason,
    });
  }

  if (decision.action === "spawn") {
    return worker.runCiDebugRecovery({
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
    return worker.runCiDebugRecovery({
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
    const backoffMs = worker.computeCiRemediationBackoffMs(attemptNumber);
    const resumeAt = new Date(Date.now() + backoffMs).toISOString();
    const lines = worker.buildCiTriageCommentLines({
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
    await worker.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines, state: nextState });
    await worker.clearCiDebugLabels(issueRef);

    const run = await worker.throttleForCiQuarantine({
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

  const resumeLines = worker.buildCiTriageCommentLines({
    prUrl: params.prUrl,
    baseRefName,
    headRefName,
    summary,
    timedOut: params.timedOut,
    action: "resume",
    attemptCount: attemptNumber,
    maxAttempts,
  });
  await worker.upsertCiDebugComment({ issueNumber: Number(params.issueNumber), lines: resumeLines, state: nextState });
  await worker.applyCiDebugLabels(issueRef);

  const remediationContext = worker.formatRemediationFailureContext(remediation);
  const prompt = worker.buildCiResumePrompt({
    prUrl: params.prUrl,
    baseRefName,
    headRefName,
    summary,
    remediationContext,
  });
  const runLogPath = await worker.recordRunLogPath(
    params.task,
    params.issueNumber,
    `ci-resume-${attemptNumber}`,
    "in-progress"
  );

  const sessionResult = await worker.session.continueSession(params.repoPath, sessionId, prompt, {
    repo: worker.repo,
    cacheKey: params.cacheKey,
    runLogPath,
    introspection: {
      repo: worker.repo,
      issue: params.task.issue,
      taskName: params.task.name,
      step: 5,
      stepTitle: `ci-resume attempt ${attemptNumber}`,
    },
    ...worker.buildWatchdogOptions(params.task, `ci-resume-${attemptNumber}`),
    ...worker.buildStallOptions(params.task, `ci-resume-${attemptNumber}`),
    ...worker.buildLoopDetectionOptions(params.task, `ci-resume-${attemptNumber}`),
    ...params.opencodeSessionOptions,
  });

  const pausedAfter = await worker.pauseIfHardThrottled(
    params.task,
    `ci-resume-${attemptNumber} (post)`,
    sessionResult.sessionId
  );
  if (pausedAfter) {
    return { status: "throttled", run: pausedAfter };
  }

  if (sessionResult.watchdogTimeout) {
    const run = await worker.handleWatchdogTimeout(
      params.task,
      params.cacheKey,
      `ci-resume-${attemptNumber}`,
      sessionResult,
      params.opencodeXdg
    );
    return { status: "failed", run };
  }

  if (sessionResult.stallTimeout) {
    const run = await worker.handleStallTimeout(
      params.task,
      params.cacheKey,
      `ci-resume-${attemptNumber}`,
      sessionResult
    );
    return { status: "failed", run };
  }

  if (sessionResult.sessionId) {
    await worker.queue.updateTaskStatus(params.task, "in-progress", { "session-id": sessionResult.sessionId });
  }

  try {
    const prStatus = await worker.getPullRequestChecks(params.prUrl);
    summary = summarizeRequiredChecks(prStatus.checks, params.requiredChecks);
    headSha = prStatus.headSha;
    worker.recordCiGateSummary(params.prUrl, summary, { timedOut: false, requiredChecks: params.requiredChecks });
  } catch (error: any) {
    const reason = `Failed to re-check CI status after resume: ${worker.formatGhError(error)}`;
    console.warn(`[ralph:worker:${worker.repo}] ${reason}`);
    return {
      status: "failed",
      run: {
        taskName: params.task.name,
        repo: worker.repo,
        outcome: "failed",
        sessionId: (sessionResult.sessionId ?? sessionId) || undefined,
        escalationReason: reason,
      },
    };
  }

  if (summary.status === "success") {
    await worker.clearCiDebugLabels(issueRef);
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
    return worker.escalateCiDebugRecovery({
      task: params.task,
      issueNumber: Number(params.issueNumber),
      issueRef,
      prUrl: params.prUrl,
      baseRefName,
      headRefName,
      summary,
      timedOut: false,
      attempts: [...(existingState.attempts ?? [])],
      signature: worker.formatCiDebugSignature(summary, false),
      maxAttempts,
      reason,
    });
  }

  const backoffMs = worker.computeCiRemediationBackoffMs(attemptNumber);
  if (backoffMs > 0) {
    await worker.sleepMs(backoffMs);
  }

  return worker.runCiFailureTriage({
    ...params,
    timedOut: false,
    sessionId: sessionResult.sessionId || sessionId,
  });
}
