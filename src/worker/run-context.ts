import type { AgentTask } from "../queue-backend";
import type { DashboardEventContext } from "../dashboard/publisher";
import type { RunSessionOptionsBase, SessionResult } from "../session";
import type { SessionAdapter } from "../run-recording-session-adapter";
import type { RalphRunAttemptKind, RalphRunDetails, RalphRunOutcome } from "../state";

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
  buildRunDetails: (result: TResult | null) => RalphRunDetails | undefined;
  getPinnedOpencodeProfileName: (task: AgentTask) => string | null;
  refreshRalphRunTokenTotals: (params: { runId: string; opencodeProfile: string | null }) => Promise<unknown>;
  getRalphRunTokenTotals: (runId: string) => TokenTotals | null;
  listRalphRunSessionTokenTotals: (runId: string) => SessionTokenTotal[];
  appendFile: (path: string, data: string, encoding: "utf8") => Promise<void>;
  existsSync: (path: string) => boolean;
  computeAndStoreRunMetrics: (params: { runId: string }) => Promise<void>;
  warn: (message: string) => void;
};

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

    try {
      params.ports.completeRun({
        runId,
        outcome: (result?.outcome ?? "failed") as RalphRunOutcome,
        details: params.ports.buildRunDetails(result),
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

    params.ports.setActiveRunId(previousRunId);
  }
}
