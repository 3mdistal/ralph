import type { AgentTask } from "../../queue-backend";
import type { RalphEvent } from "../../dashboard/events";
import type { DashboardEventContext } from "../../dashboard/publisher";
import { getRequestedOpencodeProfileName } from "../../config";
import { resolveAutoOpencodeProfileName, resolveOpencodeProfileForNewWork } from "../../opencode-auto-profile";
import { computeGitHubRateLimitPause } from "../../github/rate-limit-throttle";
import type { ThrottleAdapter } from "../ports";

export type PauseResult = {
  taskName: string;
  repo: string;
  outcome: "throttled";
  sessionId?: string;
};

type PublishDashboardEvent = (
  event: Omit<RalphEvent, "ts"> & { ts?: string },
  overrides?: Partial<DashboardEventContext>
) => void;

type UpdateTaskStatus = (
  task: AgentTask,
  status: AgentTask["status"],
  extraFields: Record<string, string>
) => Promise<boolean>;

type ApplyTaskPatch = (
  task: AgentTask,
  status: AgentTask["status"],
  extraFields: Record<string, string>
) => void;

type BuildAgentRunBodyPrefix = (params: {
  task: AgentTask;
  headline: string;
  reason?: string;
  details?: string;
  sessionId?: string;
  runLogPath?: string;
}) => string;

type CreateAgentRun = (task: AgentTask, data: {
  outcome: "throttled";
  sessionId?: string;
  started: Date;
  completed: Date;
  bodyPrefix: string;
}) => Promise<void>;

export async function pauseIfGitHubRateLimited(params: {
  task: AgentTask;
  stage: string;
  error: unknown;
  repo: string;
  publishDashboardEvent: PublishDashboardEvent;
  updateTaskStatus: UpdateTaskStatus;
  applyTaskPatch: ApplyTaskPatch;
  buildAgentRunBodyPrefix: BuildAgentRunBodyPrefix;
  createAgentRun: CreateAgentRun;
  sessionId?: string;
  runLogPath?: string;
}): Promise<PauseResult | null> {
  const pause = computeGitHubRateLimitPause({
    nowMs: Date.now(),
    stage: params.stage,
    error: params.error,
    priorResumeAtIso: params.task["resume-at"]?.trim() || null,
  });

  if (!pause) return null;

  const sid = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";

  params.publishDashboardEvent(
    {
      type: "worker.pause.requested",
      level: "warn",
      data: { reason: `github-rate-limit:${params.stage}` },
    },
    { sessionId: sid || undefined }
  );

  const extraFields: Record<string, string> = {
    "throttled-at": pause.throttledAtIso,
    "resume-at": pause.resumeAtIso,
    "usage-snapshot": pause.usageSnapshotJson,
  };

  if (sid) extraFields["session-id"] = sid;

  const enteringThrottled = params.task.status !== "throttled";
  const updated = await params.updateTaskStatus(params.task, "throttled", extraFields);
  if (!updated) {
    console.warn(
      `[ralph:worker:${params.repo}] Failed to mark task throttled after GitHub rate limit at stage=${params.stage}`
    );
    return null;
  }

  params.applyTaskPatch(params.task, "throttled", extraFields);

  if (enteringThrottled) {
    const bodyPrefix = params.buildAgentRunBodyPrefix({
      task: params.task,
      headline: `Throttled: GitHub rate limit (${params.stage})`,
      reason: `Resume at: ${pause.resumeAtIso}`,
      details: pause.usageSnapshotJson,
      sessionId: sid || undefined,
      runLogPath: params.runLogPath ?? params.task["run-log-path"]?.trim() ?? undefined,
    });
    const runTime = new Date();
    await params.createAgentRun(params.task, {
      outcome: "throttled",
      sessionId: sid || undefined,
      started: runTime,
      completed: runTime,
      bodyPrefix,
    });
  }

  console.log(
    `[ralph:worker:${params.repo}] GitHub rate limit active; pausing at stage=${params.stage} resumeAt=${pause.resumeAtIso}`
  );

  params.publishDashboardEvent(
    {
      type: "worker.pause.reached",
      level: "warn",
      data: {},
    },
    { sessionId: sid || undefined }
  );

  return {
    taskName: params.task.name,
    repo: params.repo,
    outcome: "throttled",
    sessionId: sid || undefined,
  };
}

export async function pauseIfHardThrottled(params: {
  task: AgentTask;
  stage: string;
  repo: string;
  throttle: ThrottleAdapter;
  getPinnedOpencodeProfileName: (task: AgentTask) => string | null;
  publishDashboardEvent: PublishDashboardEvent;
  updateTaskStatus: UpdateTaskStatus;
  applyTaskPatch: ApplyTaskPatch;
  buildAgentRunBodyPrefix: BuildAgentRunBodyPrefix;
  createAgentRun: CreateAgentRun;
  sessionId?: string;
}): Promise<PauseResult | null> {
  const pinned = params.getPinnedOpencodeProfileName(params.task);
  const sid = params.sessionId?.trim() || params.task["session-id"]?.trim() || "";
  const hasSession = !!sid;

  let decision: Awaited<ReturnType<ThrottleAdapter["getThrottleDecision"]>>;

  if (pinned) {
    decision = await params.throttle.getThrottleDecision(Date.now(), { opencodeProfile: pinned });
  } else {
    const requestedProfile = getRequestedOpencodeProfileName(null);

    if (requestedProfile === "auto") {
      const chosen = await resolveAutoOpencodeProfileName(Date.now(), {
        getThrottleDecision: params.throttle.getThrottleDecision,
      });

      decision = await params.throttle.getThrottleDecision(Date.now(), {
        opencodeProfile: chosen ?? null,
      });
    } else if (!hasSession) {
      decision = (
        await resolveOpencodeProfileForNewWork(Date.now(), requestedProfile || null, {
          getThrottleDecision: params.throttle.getThrottleDecision,
        })
      ).decision;
    } else {
      decision = await params.throttle.getThrottleDecision(Date.now(), {
        opencodeProfile: requestedProfile || null,
      });
    }
  }

  if (decision.state !== "hard") return null;

  const throttledAt = new Date().toISOString();
  const resumeAt = decision.resumeAtTs ? new Date(decision.resumeAtTs).toISOString() : "";

  params.publishDashboardEvent(
    {
      type: "worker.pause.requested",
      level: "warn",
      data: { reason: `hard-throttle:${params.stage}` },
    },
    { sessionId: sid || undefined }
  );

  const extraFields: Record<string, string> = {
    "throttled-at": throttledAt,
    "resume-at": resumeAt,
    "usage-snapshot": JSON.stringify(decision.snapshot),
  };

  if (sid) extraFields["session-id"] = sid;

  const enteringThrottled = params.task.status !== "throttled";
  const updated = await params.updateTaskStatus(params.task, "throttled", extraFields);
  if (updated) {
    params.applyTaskPatch(params.task, "throttled", extraFields);
  }

  if (updated && enteringThrottled) {
    const bodyPrefix = params.buildAgentRunBodyPrefix({
      task: params.task,
      headline: `Throttled: hard limit (${params.stage})`,
      reason: `Resume at: ${resumeAt || "unknown"}`,
      details: JSON.stringify(decision.snapshot),
      sessionId: sid || undefined,
      runLogPath: params.task["run-log-path"]?.trim() || undefined,
    });
    const runTime = new Date();
    await params.createAgentRun(params.task, {
      outcome: "throttled",
      sessionId: sid || undefined,
      started: runTime,
      completed: runTime,
      bodyPrefix,
    });
  }

  console.log(
    `[ralph:worker:${params.repo}] Hard throttle active; pausing at checkpoint stage=${params.stage} resumeAt=${resumeAt || "unknown"}`
  );

  params.publishDashboardEvent(
    {
      type: "worker.pause.reached",
      level: "warn",
      data: {},
    },
    { sessionId: sid || undefined }
  );

  return {
    taskName: params.task.name,
    repo: params.repo,
    outcome: "throttled",
    sessionId: sid || undefined,
  };
}
