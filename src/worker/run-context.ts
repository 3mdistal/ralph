import type { AgentTask } from "../queue-backend";
import type { DashboardEventContext } from "../dashboard/publisher";
import type { RunSessionOptionsBase, SessionResult } from "../session";
import type { SessionAdapter } from "../run-recording-session-adapter";
import type { RalphRunAttemptKind, RalphRunDetails, RalphRunOutcome } from "../state";
import { parseIssueRef } from "../github/issue-ref";
import {
  evaluatePrEvidenceCompletion,
  formatPrEvidenceCauseCodeLine,
  isNoPrTerminalReason,
  normalizePrEvidenceCauseCode,
} from "../gates/pr-evidence-gate";

import type { WorkerDashboardEventInput } from "./events";

type TokenTotals = {
  tokensComplete?: boolean | null;
  tokensTotal?: number | null;
  sessionCount: number;
};

type SessionTokenTotal = {
  quality: string;
};

type WithRunContextPorts<TResult extends { outcome?: string }> = {
  repo: string;
  getActiveRunId: () => string | null;
  setActiveRunId: (runId: string | null) => void;
  baseSession: SessionAdapter;
  createRunRecordingSessionAdapter: (params: {
    base: SessionAdapter;
    runId: string;
    repo: string;
    issue: string;
  }) => SessionAdapter;
  createContextRecoveryAdapter: (base: SessionAdapter) => SessionAdapter;
  withDashboardContext: <T>(context: DashboardEventContext, run: () => Promise<T>) => Promise<T>;
  withSessionAdapters: <T>(
    next: { baseSession: SessionAdapter; session: SessionAdapter },
    run: () => Promise<T>
  ) => Promise<T>;
  buildDashboardContext: (task: AgentTask, runId: string | null) => DashboardEventContext;
  publishDashboardEvent: (event: WorkerDashboardEventInput, overrides?: Partial<DashboardEventContext>) => void;
  createRunRecord: (params: {
    repo: string;
    issue: string;
    taskPath: string;
    attemptKind: RalphRunAttemptKind;
  }) => string | null;
  ensureRunGateRows: (runId: string) => void;
  completeRun: (params: { runId: string; outcome: RalphRunOutcome; details?: RalphRunDetails }) => void;
  upsertRunGateResult: (params: {
    runId: string;
    gate: "pr_evidence";
    status: "pass" | "fail" | "skipped";
    skipReason?: string | null;
    reason?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
  }) => void;
  recordRunGateArtifact: (params: {
    runId: string;
    gate: "pr_evidence";
    kind: "note";
    content: string;
  }) => void;
  buildRunDetails: (result: TResult | null) => RalphRunDetails | undefined;
  getPinnedOpencodeProfileName: (task: AgentTask) => string | null;
  refreshRalphRunTokenTotals: (params: { runId: string; opencodeProfile: string | null }) => Promise<unknown>;
  getRalphRunTokenTotals: (runId: string) => TokenTotals | null;
  listRalphRunSessionTokenTotals: (runId: string) => SessionTokenTotal[];
  appendFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  existsSync: (path: string) => boolean;
  computeAndStoreRunMetrics: (params: { runId: string }) => Promise<void>;
  shouldCollectTraceBundle?: (task: AgentTask) => boolean;
  collectTraceBundle?: (params: { runId: string; task: AgentTask }) => Promise<void>;
  warn: (message: string) => void;
};

function extractPrNumber(prUrl: string | undefined): number | null {
  const value = prUrl?.trim();
  if (!value) return null;
  const match = value.match(/\/pull\/(\d+)$/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildMissingPrEvidenceNote(params: {
  task: AgentTask;
  repo: string;
  runId: string;
  causeCode: string;
}): string {
  const worktreePath = params.task["worktree-path"]?.trim() || "(unknown)";
  return [
    "Missing PR evidence for issue-linked success completion.",
    `run_id: ${params.runId}`,
    `issue: ${params.task.issue}`,
    `worktree: ${worktreePath}`,
    formatPrEvidenceCauseCodeLine(params.causeCode),
    "",
    "Orchestrator recovery checks:",
    `- git -C \"${worktreePath}\" status`,
    `- git -C \"${worktreePath}\" branch --show-current`,
    `- git -C \"${worktreePath}\" rev-parse HEAD`,
    "- Ralph orchestrator then pushes the branch and creates/reuses the PR.",
  ].join("\n");
}

function buildNoPrTerminalReasonNote(params: {
  task: AgentTask;
  runId: string;
  terminalReason: string;
}): string {
  return [
    "Issue-linked success completed via explicit no-PR terminal reason.",
    `run_id: ${params.runId}`,
    `issue: ${params.task.issue}`,
    `terminal_reason: ${params.terminalReason}`,
  ].join("\n");
}

type DashboardSessionOptionsParams = {
  options?: RunSessionOptionsBase;
  overrides?: Partial<DashboardEventContext>;
  activeDashboardContext?: DashboardEventContext | null;
  publishDashboardEvent: (event: WorkerDashboardEventInput, overrides?: Partial<DashboardEventContext>) => void;
};

function resolveEventSessionId(
  context: DashboardEventContext,
  event: any
): { sessionId?: string; eventSessionId?: string } {
  const eventSessionId = event?.sessionID ?? event?.sessionId;
  const resolved = typeof eventSessionId === "string" ? eventSessionId : context.sessionId;
  return { sessionId: resolved, eventSessionId };
}

function buildDashboardOnEvent(
  params: DashboardSessionOptionsParams & { context: DashboardEventContext }
): (event: any) => void {
  const existingOnEvent = params.options?.onEvent;

  return (event: any) => {
    if (!event) return;
    const { sessionId } = resolveEventSessionId(params.context, event);

    params.publishDashboardEvent(
      {
        type: "log.opencode.event",
        level: "info",
        repo: params.context.repo,
        taskId: params.context.taskId,
        workerId: params.context.workerId,
        sessionId,
        data: { event },
      },
      { ...params.context, sessionId }
    );

    if (event.type === "text" && event.part?.text) {
      params.publishDashboardEvent(
        {
          type: "log.opencode.text",
          level: "info",
          repo: params.context.repo,
          taskId: params.context.taskId,
          workerId: params.context.workerId,
          sessionId,
          data: { text: String(event.part.text) },
        },
        { ...params.context, sessionId }
      );
    }

    existingOnEvent?.(event);
  };
}

export function withDashboardSessionOptions(
  params: DashboardSessionOptionsParams
): RunSessionOptionsBase | undefined {
  const context = params.activeDashboardContext
    ? { ...params.activeDashboardContext, ...params.overrides }
    : params.overrides;
  if (!context) return params.options;

  const onEvent = buildDashboardOnEvent({ ...params, context });
  return { ...(params.options ?? {}), onEvent };
}

export function createContextRecoveryAdapter(params: {
  base: SessionAdapter;
  withDashboardSessionOptions: (
    options?: RunSessionOptionsBase,
    overrides?: Partial<DashboardEventContext>
  ) => RunSessionOptionsBase | undefined;
  maybeRecoverFromContextLengthExceeded: (params: {
    repoPath: string;
    sessionId?: string;
    stepKey: string;
    result: SessionResult;
    options?: RunSessionOptionsBase;
    command?: string;
  }) => Promise<SessionResult>;
}): SessionAdapter {
  return {
    runAgent: async (repoPath, agent, message, options, testOverrides) => {
      const dashboardOptions = params.withDashboardSessionOptions(options);
      const result = await params.base.runAgent(repoPath, agent, message, dashboardOptions, testOverrides);
      return params.maybeRecoverFromContextLengthExceeded({
        repoPath,
        sessionId: result.sessionId,
        stepKey: options?.introspection?.stepTitle ?? `agent:${agent}`,
        result,
        options: dashboardOptions,
      });
    },
    continueSession: async (repoPath, sessionId, message, options) => {
      const dashboardOptions = params.withDashboardSessionOptions(options, { sessionId });
      const result = await params.base.continueSession(repoPath, sessionId, message, dashboardOptions);
      return params.maybeRecoverFromContextLengthExceeded({
        repoPath,
        sessionId,
        stepKey: options?.introspection?.stepTitle ?? `session:${sessionId}`,
        result,
        options: dashboardOptions,
      });
    },
    continueCommand: async (repoPath, sessionId, command, args, options) => {
      const dashboardOptions = params.withDashboardSessionOptions(options, { sessionId });
      const result = await params.base.continueCommand(repoPath, sessionId, command, args, dashboardOptions);
      return params.maybeRecoverFromContextLengthExceeded({
        repoPath,
        sessionId,
        stepKey: options?.introspection?.stepTitle ?? `command:${command}`,
        result,
        options: dashboardOptions,
        command,
      });
    },
    getRalphXdgCacheHome: params.base.getRalphXdgCacheHome,
  };
}

export async function withRunContext<TResult extends { outcome?: string }>(params: {
  task: AgentTask;
  attemptKind: RalphRunAttemptKind;
  run: () => Promise<TResult>;
  ports: WithRunContextPorts<TResult>;
}): Promise<TResult> {
  let runId: string | null = null;
  const previousRunId = params.ports.getActiveRunId();

  try {
    runId = params.ports.createRunRecord({
      repo: params.ports.repo,
      issue: params.task.issue,
      taskPath: params.task._path,
      attemptKind: params.attemptKind,
    });
  } catch (error: any) {
    params.ports.warn(
      `[ralph:worker:${params.ports.repo}] Failed to create run record for ${params.task.name}: ${error?.message ?? String(error)}`
    );
  }

  if (!runId) {
    return await params.run();
  }

  params.ports.setActiveRunId(runId);
  try {
    params.ports.ensureRunGateRows(runId);
  } catch (error: any) {
    params.ports.warn(
      `[ralph:worker:${params.ports.repo}] Failed to initialize gate rows for ${params.task.name}: ${error?.message ?? String(error)}`
    );
  }

  const recordingBase = params.ports.createRunRecordingSessionAdapter({
    base: params.ports.baseSession,
    runId,
    repo: params.ports.repo,
    issue: params.task.issue,
  });
  const recordingSession = params.ports.createContextRecoveryAdapter(recordingBase);

  let result: TResult | null = null;
  const context = params.ports.buildDashboardContext(params.task, runId);

  try {
    result = await params.ports.withDashboardContext(context, async () => {
      params.ports.publishDashboardEvent({
        type: "worker.became_busy",
        level: "info",
        data: { taskName: params.task.name, issue: params.task.issue },
      });
      return await params.ports.withSessionAdapters({ baseSession: recordingBase, session: recordingSession }, params.run);
    });
    return result;
  } finally {
    params.ports.publishDashboardEvent({
      type: "worker.became_idle",
      level: "info",
      data: { reason: result?.outcome },
    });

    const attemptedOutcome = (result?.outcome ?? "failed") as RalphRunOutcome;
    const runDetails = params.ports.buildRunDetails(result);
    const issueLinked = Boolean(parseIssueRef(params.task.issue, params.ports.repo));
    const completionDecision = evaluatePrEvidenceCompletion({
      attemptedOutcome,
      completionKind: runDetails?.completionKind ?? null,
      issueLinked,
      prUrl: runDetails?.prUrl ?? null,
      noPrTerminalReason: runDetails?.noPrTerminalReason ?? null,
      causeCode: runDetails?.prEvidenceCauseCode ?? null,
    });

    const finalDetails: RalphRunDetails = { ...(runDetails ?? {}) };
    let finalOutcome: RalphRunOutcome = completionDecision.finalOutcome;

    if (completionDecision.reasonCode && !finalDetails.reasonCode) {
      finalDetails.reasonCode = completionDecision.reasonCode;
    }

    if (completionDecision.causeCode && !finalDetails.prEvidenceCauseCode) {
      finalDetails.prEvidenceCauseCode = completionDecision.causeCode;
    }

    if (attemptedOutcome === "success" && issueLinked) {
      const prUrl = runDetails?.prUrl?.trim() || null;
      const terminalReason = runDetails?.noPrTerminalReason?.trim() || null;
      try {
        if (prUrl) {
          params.ports.upsertRunGateResult({
            runId,
            gate: "pr_evidence",
            status: "pass",
            prUrl,
            prNumber: extractPrNumber(prUrl),
          });
        } else if (terminalReason && isNoPrTerminalReason(terminalReason)) {
          params.ports.upsertRunGateResult({
            runId,
            gate: "pr_evidence",
            status: "skipped",
            skipReason: terminalReason.toLowerCase(),
            reason: `terminal_reason=${terminalReason}`,
          });
          params.ports.recordRunGateArtifact({
            runId,
            gate: "pr_evidence",
            kind: "note",
            content: buildNoPrTerminalReasonNote({
              task: params.task,
              runId,
              terminalReason,
            }),
          });
        } else {
          const causeCode = normalizePrEvidenceCauseCode(runDetails?.prEvidenceCauseCode ?? completionDecision.causeCode ?? null);
          params.ports.upsertRunGateResult({
            runId,
            gate: "pr_evidence",
            status: "fail",
            skipReason: "missing pr_url",
            reason: `cause_code=${causeCode}`,
          });
          params.ports.recordRunGateArtifact({
            runId,
            gate: "pr_evidence",
            kind: "note",
            content: buildMissingPrEvidenceNote({
              task: params.task,
              repo: params.ports.repo,
              runId,
              causeCode,
            }),
          });
        }
      } catch (error: any) {
        finalOutcome = "escalated";
        if (!finalDetails.reasonCode) {
          finalDetails.reasonCode = "pr_evidence_persist_failed";
        }
        params.ports.warn(
          `[ralph:worker:${params.ports.repo}] Failed to persist PR evidence gate for ${params.task.name}: ${error?.message ?? String(error)}`
        );
      }
    }

    try {
      params.ports.completeRun({
        runId,
        outcome: finalOutcome,
        details: Object.keys(finalDetails).length ? finalDetails : undefined,
      });
    } catch (error: any) {
      params.ports.warn(
        `[ralph:worker:${params.ports.repo}] Failed to complete run record for ${params.task.name}: ${error?.message ?? String(error)}`
      );
    }

    try {
      const opencodeProfile = params.ports.getPinnedOpencodeProfileName(params.task);
      await params.ports.refreshRalphRunTokenTotals({ runId, opencodeProfile });
      const totals = params.ports.getRalphRunTokenTotals(runId);
      const runLogPath = params.task["run-log-path"]?.trim() || "";
      if (totals && runLogPath && params.ports.existsSync(runLogPath)) {
        const totalLabel = totals.tokensComplete && typeof totals.tokensTotal === "number" ? totals.tokensTotal : "?";
        const perSession = params.ports.listRalphRunSessionTokenTotals(runId);
        const missingCount = perSession.filter((session) => session.quality !== "ok").length;
        const suffix = missingCount > 0 ? ` missingSessions=${missingCount}` : "";

        await params.ports.appendFile(
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
      await params.ports.computeAndStoreRunMetrics({ runId });
    } catch {
      // best-effort metrics persistence
    }

    try {
      const shouldCollect = params.ports.shouldCollectTraceBundle?.(params.task) ?? false;
      if (shouldCollect) {
        await params.ports.collectTraceBundle?.({ runId, task: params.task });
      }
    } catch (error: any) {
      params.ports.warn(
        `[ralph:worker:${params.ports.repo}] Failed to collect trace bundle for ${params.task.name}: ${error?.message ?? String(error)}`
      );
    }

    params.ports.setActiveRunId(previousRunId);
  }
}
