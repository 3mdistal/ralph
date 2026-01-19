import type { AgentTask } from "./queue";
import type { AgentEscalationNote, EditEscalationResult } from "./escalation-notes";
import type { Semaphore } from "./semaphore";
import type { AgentRun } from "./worker";

export type EscalationResumeWorker = {
  resumeTask: (task: AgentTask, opts?: { resumeMessage?: string }) => Promise<AgentRun>;
};

export type AttemptResumeResolvedEscalationsDeps = {
  isShuttingDown: () => boolean;
  now: () => number;

  resumeAttemptedThisRun: Set<string>;
  getResumeDisabledUntil: () => number;
  setResumeDisabledUntil: (ts: number) => void;
  resumeDisableMs: number;
  getVaultPathForLogs: () => string;

  ensureSemaphores: () => void;
  getGlobalSemaphore: () => Semaphore | null;
  getRepoSemaphore: (repo: string) => Semaphore;

  getTaskKey: (task: Pick<AgentTask, "_path" | "name">) => string;
  inFlightTasks: Set<string>;
  tryClaimTask: (opts: { task: AgentTask; daemonId: string; nowMs: number }) => Promise<{
    claimed: boolean;
    task: AgentTask | null;
    reason?: string;
  }>;
  recordOwnedTask: (task: AgentTask) => void;
  forgetOwnedTask: (task: AgentTask) => void;
  daemonId: string;

  getEscalationsByStatus: (status: string) => Promise<AgentEscalationNote[]>;
  editEscalation: (path: string, fields: Record<string, string>) => Promise<EditEscalationResult>;
  readResolutionMessage: (path: string) => Promise<string | null>;

  getTaskByPath: (taskPath: string) => Promise<AgentTask | null>;
  updateTaskStatus: (
    task: AgentTask,
    status: AgentTask["status"],
    fields?: Record<string, string>
  ) => Promise<boolean>;

  shouldDeferWaitingResolutionCheck: (escalation: AgentEscalationNote, nowMs: number, intervalMs: number) => boolean;
  buildWaitingResolutionUpdate: (nowIso: string, reason: string) => Record<string, string>;
  resolutionRecheckIntervalMs: number;

  getOrCreateWorker: (repo: string) => EscalationResumeWorker;
  recordMerge: (repo: string, prUrl: string) => Promise<void>;
  scheduleQueuedTasksSoon: () => void;
};

async function safeEditEscalation(
  deps: Pick<
    AttemptResumeResolvedEscalationsDeps,
    "editEscalation" | "resumeAttemptedThisRun" | "getResumeDisabledUntil" | "setResumeDisabledUntil" | "resumeDisableMs" | "getVaultPathForLogs"
  >,
  escalationPath: string,
  fields: Record<string, string>
): Promise<boolean> {
  const result = await deps.editEscalation(escalationPath, fields);
  if (result.ok) return true;

  deps.resumeAttemptedThisRun.add(escalationPath);

  if (result.kind === "vault-missing") {
    const now = Date.now();
    if (now >= deps.getResumeDisabledUntil()) {
      deps.setResumeDisabledUntil(now + deps.resumeDisableMs);
      const vault = deps.getVaultPathForLogs();
      console.error(
        `[ralph:escalations] Cannot edit escalation notes; pausing auto-resume for ${Math.round(deps.resumeDisableMs / 1000)}s. ` +
          `Check bwrbVault in ~/.ralph/config.toml or ~/.ralph/config.json (current: ${JSON.stringify(vault)}). ` +
          `Last error: ${result.error}`
      );
    }
    return false;
  }

  console.warn(`[ralph:escalations] Failed to edit escalation ${escalationPath}: ${result.error}`);
  return false;
}

export async function attemptResumeResolvedEscalations(deps: AttemptResumeResolvedEscalationsDeps): Promise<void> {
  if (deps.isShuttingDown()) return;
  if (deps.now() < deps.getResumeDisabledUntil()) return;

  deps.ensureSemaphores();
  const globalSemaphore = deps.getGlobalSemaphore();
  if (!globalSemaphore) return;

  const resolved = await deps.getEscalationsByStatus("resolved");
  if (resolved.length === 0) return;

  const pending = resolved.filter((e) => {
    const attempted = e["resume-attempted-at"]?.trim();
    const resumeStatus = e["resume-status"]?.trim();

    return (!attempted || resumeStatus === "waiting-resolution") && !deps.resumeAttemptedThisRun.has(e._path);
  });
  if (pending.length === 0) return;

  for (const escalation of pending) {
    if (deps.isShuttingDown()) return;
    if (deps.now() < deps.getResumeDisabledUntil()) return;

    const taskPath = escalation["task-path"]?.trim() ?? "";
    const sessionId = escalation["session-id"]?.trim() ?? "";
    const repo = escalation.repo?.trim() ?? "";

    if (!taskPath || !sessionId || !repo) {
      const reason = `Missing required fields (task-path='${taskPath}', session-id='${sessionId}', repo='${repo}')`;
      console.warn(`[ralph:escalations] Resolved escalation invalid; ${reason}: ${escalation._path}`);

      await safeEditEscalation(deps, escalation._path, {
        "resume-status": "failed",
        "resume-attempted-at": new Date().toISOString(),
        "resume-error": reason,
      });

      continue;
    }

    const worker = deps.getOrCreateWorker(repo);

    const task = await deps.getTaskByPath(taskPath);
    if (!task) {
      console.warn(`[ralph:escalations] Resolved escalation references missing task; skipping: ${taskPath}`);
      await safeEditEscalation(deps, escalation._path, {
        "resume-status": "failed",
        "resume-attempted-at": new Date().toISOString(),
        "resume-error": `Task not found: ${taskPath}`,
      });
      continue;
    }

    const nowIso = new Date().toISOString();
    if (deps.shouldDeferWaitingResolutionCheck(escalation, deps.now(), deps.resolutionRecheckIntervalMs)) {
      continue;
    }

    const resolution = await deps.readResolutionMessage(escalation._path);
    if (!resolution) {
      const reason = "Resolved escalation has empty/missing ## Resolution text";
      console.warn(`[ralph:escalations] ${reason}; skipping: ${escalation._path}`);

      await deps.editEscalation(escalation._path, deps.buildWaitingResolutionUpdate(nowIso, reason));

      continue;
    }

    const taskKey = deps.getTaskKey(task);
    if (deps.inFlightTasks.has(taskKey)) continue;

    const releaseGlobal = globalSemaphore.tryAcquire();
    if (!releaseGlobal) {
      if (escalation["resume-status"]?.trim() !== "deferred") {
        await safeEditEscalation(deps, escalation._path, {
          "resume-status": "deferred",
          "resume-deferred-at": new Date().toISOString(),
          "resume-error": "Global concurrency limit reached; will retry",
        });
      }
      continue;
    }

    const releaseRepo = deps.getRepoSemaphore(repo).tryAcquire();
    if (!releaseRepo) {
      releaseGlobal();
      if (escalation["resume-status"]?.trim() !== "deferred") {
        await safeEditEscalation(deps, escalation._path, {
          "resume-status": "deferred",
          "resume-deferred-at": new Date().toISOString(),
          "resume-error": "Repo concurrency limit reached; will retry",
        });
      }
      continue;
    }

    const resumeMessage = [
      "Escalation resolved. Resume the existing OpenCode session from where you left off.",
      "Apply the human guidance below. Do NOT restart from scratch unless strictly necessary.",
      "",
      "Human guidance:",
      resolution,
    ].join("\n");

    // Mark as attempted before resuming to avoid duplicate resumes.
    const markedAttempt = await safeEditEscalation(deps, escalation._path, {
      "resume-status": "attempting",
      "resume-attempted-at": new Date().toISOString(),
      "resume-error": "",
    });

    if (!markedAttempt) {
      releaseGlobal();
      releaseRepo();
      continue;
    }

    const claim = await deps.tryClaimTask({ task, daemonId: deps.daemonId, nowMs: deps.now() });
    if (!claim.claimed || !claim.task) {
      await safeEditEscalation(deps, escalation._path, {
        "resume-status": "failed",
        "resume-error": claim.reason ?? "Ownership claim failed",
      });
      releaseGlobal();
      releaseRepo();
      continue;
    }

    deps.recordOwnedTask(claim.task);

    // Ensure the task is resumable and marked in-progress.
    await deps.updateTaskStatus(claim.task, "in-progress", {
      "assigned-at": new Date().toISOString().split("T")[0],
      "session-id": sessionId,
    });

    deps.inFlightTasks.add(taskKey);

    worker
      .resumeTask(claim.task, { resumeMessage })
      .then(async (run) => {
        if (run.outcome === "success") {
          if (run.pr) {
            await deps.recordMerge(repo, run.pr);
          }

          await safeEditEscalation(deps, escalation._path, {
            "resume-status": "succeeded",
            "resume-error": "",
          });

          return;
        }

        const reason =
          run.escalationReason ??
          (run.outcome === "escalated" ? "Resumed session escalated" : "Resume failed");

        await safeEditEscalation(deps, escalation._path, {
          "resume-status": "failed",
          "resume-error": reason,
        });
      })
      .catch(async (e: any) => {
        await safeEditEscalation(deps, escalation._path, {
          "resume-status": "failed",
          "resume-error": e?.message ?? String(e),
        });
      })
      .finally(() => {
        deps.inFlightTasks.delete(taskKey);
        if (claim.task) deps.forgetOwnedTask(claim.task);
        releaseGlobal();
        releaseRepo();
        if (!deps.isShuttingDown()) deps.scheduleQueuedTasksSoon();
      });
  }
}
