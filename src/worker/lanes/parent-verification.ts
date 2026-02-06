import type { AgentTask } from "../../queue-backend";
import type { IssueMetadata } from "../../escalation";
import { buildParentVerificationPrompt } from "../../parent-verification-prompt";
import {
  evaluateParentVerificationNoPrEligibility,
  getParentVerificationBackoffMs,
  getParentVerificationMaxAttempts,
  isParentVerificationDisabled,
  type ParentVerificationMarker,
  parseParentVerificationMarker,
  PARENT_VERIFY_MARKER_PREFIX,
  PARENT_VERIFY_MARKER_VERSION,
} from "../../parent-verification";
import { parseLastLineJsonMarker } from "../../markers";
import type { RunSessionOptionsBase, SessionResult } from "../../session";
import type { EscalationType } from "../../github/escalation-constants";
import type { EscalationContext } from "../../notify";
import type { AgentRun } from "../repo-worker";

type UpdateTaskStatus = (
  task: AgentTask,
  status: AgentTask["status"],
  extraFields?: Record<string, string>
) => Promise<boolean>;

type ApplyTaskPatch = (
  task: AgentTask,
  status: AgentTask["status"],
  extraFields: Record<string, string>
) => void;

type ParentVerificationState = {
  status: "pending" | "running" | "complete";
  attemptCount: number;
  nextAttemptAtMs?: number | null;
};

export type ParentVerificationLaneDeps = {
  repo: string;
  repoPath: string;
  task: AgentTask;
  issueNumber: string;
  issueMeta: IssueMetadata;
  opencodeSessionOptions?: RunSessionOptionsBase;
  nowMs: () => number;
  getParentVerificationState: (params: { repo: string; issueNumber: number }) => ParentVerificationState | null;
  tryClaimParentVerification: (params: { repo: string; issueNumber: number; nowMs: number }) => { attemptCount: number } | null;
  recordParentVerificationAttemptFailure: (params: {
    repo: string;
    issueNumber: number;
    attemptCount: number;
    nextAttemptAtMs: number;
    nowMs: number;
    details: string;
  }) => void;
  completeParentVerification: (params: {
    repo: string;
    issueNumber: number;
    outcome: "skipped" | "work_remains" | "no_work";
    details: string;
    nowMs: number;
  }) => void;
  recordRunLogPath: (
    task: AgentTask,
    issueNumber: string,
    stage: string,
    status: "queued" | "starting" | "in-progress"
  ) => Promise<string | null | void>;
  buildIssueContextForAgent: (params: { repo: string; issueNumber: string }) => Promise<string | null>;
  runAgent: (
    repoPath: string,
    agentName: string,
    prompt: string,
    options: Record<string, unknown>
  ) => Promise<SessionResult>;
  buildWatchdogOptions: (task: AgentTask, stage: string) => Record<string, unknown>;
  buildStallOptions: (task: AgentTask, stage: string) => Record<string, unknown>;
  buildLoopDetectionOptions: (task: AgentTask, stage: string) => Record<string, unknown>;
  handleLoopTrip: (task: AgentTask, cacheKey: string, stage: string, result: SessionResult) => Promise<AgentRun>;
  updateTaskStatus: UpdateTaskStatus;
  applyTaskPatch: ApplyTaskPatch;
  writeEscalationWriteback: (task: AgentTask, params: {
    reason: string;
    details?: string;
    escalationType: EscalationType;
  }) => Promise<string | null>;
  notifyEscalation: (params: EscalationContext) => Promise<boolean>;
  recordEscalatedRunNote: (task: AgentTask, params: {
    reason: string;
    sessionId?: string;
    details?: string;
  }) => Promise<void>;
  finalizeVerifiedNoPrCompletion: (params: {
    task: AgentTask;
    issueNumber: number;
    marker: ParentVerificationMarker;
    sessionId?: string;
    output?: string;
  }) => Promise<AgentRun>;
};

async function escalateNoPrCompletion(params: {
  task: AgentTask;
  repo: string;
  reason: string;
  details: string;
  sessionId?: string;
  output?: string;
  updateTaskStatus: UpdateTaskStatus;
  applyTaskPatch: ApplyTaskPatch;
  writeEscalationWriteback: ParentVerificationLaneDeps["writeEscalationWriteback"];
  notifyEscalation: ParentVerificationLaneDeps["notifyEscalation"];
  recordEscalatedRunNote: ParentVerificationLaneDeps["recordEscalatedRunNote"];
}): Promise<AgentRun> {
  const wasEscalated = params.task.status === "escalated";
  const escalated = await params.updateTaskStatus(params.task, "escalated", {
    "daemon-id": "",
    "heartbeat-at": "",
  });
  if (escalated) {
    params.applyTaskPatch(params.task, "escalated", {
      "daemon-id": "",
      "heartbeat-at": "",
    });
  }

  await params.writeEscalationWriteback(params.task, {
    reason: params.reason,
    details: params.details,
    escalationType: "other",
  });
  await params.notifyEscalation({
    taskName: params.task.name,
    taskFileName: params.task._name,
    taskPath: params.task._path,
    issue: params.task.issue,
    repo: params.repo,
    sessionId: params.sessionId || params.task["session-id"]?.trim() || undefined,
    reason: params.reason,
    escalationType: "other",
    planOutput: params.output,
  });

  if (escalated && !wasEscalated) {
    await params.recordEscalatedRunNote(params.task, {
      reason: params.reason,
      sessionId: params.sessionId,
      details: params.details,
    });
  }

  return {
    taskName: params.task.name,
    repo: params.repo,
    outcome: "escalated",
    sessionId: params.sessionId || undefined,
    escalationReason: params.reason,
  };
}

async function deferParentVerification(params: {
  repo: string;
  task: AgentTask;
  reason: string;
  updateTaskStatus: UpdateTaskStatus;
  applyTaskPatch: ApplyTaskPatch;
}): Promise<AgentRun> {
  const patch: Record<string, string> = {
    "daemon-id": "",
    "heartbeat-at": "",
  };
  const updated = await params.updateTaskStatus(params.task, "queued", patch);
  if (updated) {
    params.applyTaskPatch(params.task, "queued", patch);
  }

  console.log(`[ralph:worker:${params.repo}] Parent verification deferred: ${params.reason}`);
  return {
    taskName: params.task.name,
    repo: params.repo,
    outcome: "failed",
    escalationReason: params.reason,
  };
}

export async function maybeRunParentVerificationLane(params: ParentVerificationLaneDeps): Promise<AgentRun | null> {
  if (isParentVerificationDisabled()) return null;
  const parsedIssueNumber = Number(params.issueNumber);
  if (!Number.isFinite(parsedIssueNumber)) return null;

  const state = params.getParentVerificationState({ repo: params.repo, issueNumber: parsedIssueNumber });
  if (!state || state.status !== "pending") return null;

  const nowMs = params.nowMs();
  if (state.nextAttemptAtMs && state.nextAttemptAtMs > nowMs) {
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: `backoff active until ${new Date(state.nextAttemptAtMs).toISOString()}`,
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }

  const maxAttempts = getParentVerificationMaxAttempts();
  if (state.attemptCount >= maxAttempts) {
    params.completeParentVerification({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      outcome: "skipped",
      details: `max attempts (${maxAttempts}) reached`,
      nowMs,
    });
    console.log(
      `[ralph:worker:${params.repo}] Parent verification skipped (attempts=${state.attemptCount} max=${maxAttempts})`
    );
    return null;
  }

  const claimed = params.tryClaimParentVerification({ repo: params.repo, issueNumber: parsedIssueNumber, nowMs });
  if (!claimed) {
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: "pending claim not acquired",
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }

  const attemptCount = claimed.attemptCount;
  await params.recordRunLogPath(params.task, params.issueNumber, "parent-verify", "queued");
  const issueContext = await params.buildIssueContextForAgent({ repo: params.repo, issueNumber: params.issueNumber });
  const prompt = buildParentVerificationPrompt({
    repo: params.repo,
    issueNumber: params.issueNumber,
    issueContext,
  });

  let result: SessionResult;
  try {
    result = await params.runAgent(params.repoPath, "ralph-parent-verify", prompt, {
      repo: params.repo,
      cacheKey: `parent-verify-${params.issueNumber}`,
      introspection: {
        repo: params.repo,
        issue: params.task.issue,
        taskName: params.task.name,
        step: 0,
        stepTitle: "parent verification",
      },
      ...params.buildWatchdogOptions(params.task, "parent-verify"),
      ...params.buildStallOptions(params.task, "parent-verify"),
      ...params.buildLoopDetectionOptions(params.task, "parent-verify"),
      ...(params.opencodeSessionOptions ?? {}),
    });
  } catch (error: any) {
    const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
    params.recordParentVerificationAttemptFailure({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      attemptCount,
      nextAttemptAtMs,
      nowMs,
      details: error?.message ?? String(error),
    });
    if (attemptCount >= maxAttempts) {
      params.completeParentVerification({
        repo: params.repo,
        issueNumber: parsedIssueNumber,
        outcome: "skipped",
        details: "parent verification failed; proceeding to implementation",
        nowMs,
      });
      return null;
    }
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: "parent verification error",
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }

  if (result.loopTrip) {
    return await params.handleLoopTrip(params.task, `parent-verify-${params.issueNumber}`, "parent-verify", result);
  }

  if (!result.success) {
    const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
    params.recordParentVerificationAttemptFailure({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      attemptCount,
      nextAttemptAtMs,
      nowMs,
      details: result.output,
    });
    if (attemptCount >= maxAttempts) {
      params.completeParentVerification({
        repo: params.repo,
        issueNumber: parsedIssueNumber,
        outcome: "skipped",
        details: "parent verification failed; proceeding to implementation",
        nowMs,
      });
      return null;
    }
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: "parent verification failed",
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }

  const markerResult = parseLastLineJsonMarker(result.output ?? "", PARENT_VERIFY_MARKER_PREFIX);
  const parsedMarker = markerResult.ok ? parseParentVerificationMarker(markerResult.value) : null;
  if (!markerResult.ok || !parsedMarker || parsedMarker.version !== PARENT_VERIFY_MARKER_VERSION) {
    const detail = markerResult.ok ? "invalid marker payload" : markerResult.error;
    const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
    params.recordParentVerificationAttemptFailure({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      attemptCount,
      nextAttemptAtMs,
      nowMs,
      details: detail,
    });
    if (attemptCount >= maxAttempts) {
      params.completeParentVerification({
        repo: params.repo,
        issueNumber: parsedIssueNumber,
        outcome: "skipped",
        details: "parent verification marker invalid; proceeding to implementation",
        nowMs,
      });
      return null;
    }
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: "parent verification marker invalid",
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }

  if (parsedMarker.work_remains) {
    params.completeParentVerification({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      outcome: "work_remains",
      details: parsedMarker.reason,
      nowMs,
    });
    console.log(
      `[ralph:worker:${params.repo}] Parent verification: work remains for ${params.task.issue} (${parsedMarker.reason})`
    );
    return null;
  }

  const eligibility = evaluateParentVerificationNoPrEligibility(parsedMarker);
  if (!eligibility.ok) {
    params.completeParentVerification({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      outcome: "skipped",
      details: `close or clarify: ${eligibility.reason}`,
      nowMs,
    });
    const reason = `Parent verification returned no_work but cannot auto-complete (${eligibility.reason}); close or clarify.`;
    return await escalateNoPrCompletion({
      task: params.task,
      repo: params.repo,
      reason,
      details: parsedMarker.reason,
      sessionId: result.sessionId || undefined,
      output: result.output,
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
      writeEscalationWriteback: params.writeEscalationWriteback,
      notifyEscalation: params.notifyEscalation,
      recordEscalatedRunNote: params.recordEscalatedRunNote,
    });
  }

  try {
    const completionRun = await params.finalizeVerifiedNoPrCompletion({
      task: params.task,
      issueNumber: parsedIssueNumber,
      marker: parsedMarker,
      sessionId: result.sessionId || undefined,
      output: result.output,
    });
    params.completeParentVerification({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      outcome: "no_work",
      details: parsedMarker.why_satisfied ?? parsedMarker.reason,
      nowMs,
    });
    return completionRun;
  } catch (error: any) {
    const detail = error?.message ?? String(error);
    const nextAttemptAtMs = nowMs + getParentVerificationBackoffMs(attemptCount);
    params.recordParentVerificationAttemptFailure({
      repo: params.repo,
      issueNumber: parsedIssueNumber,
      attemptCount,
      nextAttemptAtMs,
      nowMs,
      details: detail,
    });
    if (attemptCount >= maxAttempts) {
      const reason = `Parent verification no-PR completion failed after ${attemptCount} attempts`;
      return await escalateNoPrCompletion({
        task: params.task,
        repo: params.repo,
        reason,
        details: detail,
        sessionId: result.sessionId || undefined,
        output: result.output,
        updateTaskStatus: params.updateTaskStatus,
        applyTaskPatch: params.applyTaskPatch,
        writeEscalationWriteback: params.writeEscalationWriteback,
        notifyEscalation: params.notifyEscalation,
        recordEscalatedRunNote: params.recordEscalatedRunNote,
      });
    }
    return await deferParentVerification({
      repo: params.repo,
      task: params.task,
      reason: "parent verification no-pr completion failed",
      updateTaskStatus: params.updateTaskStatus,
      applyTaskPatch: params.applyTaskPatch,
    });
  }
}
