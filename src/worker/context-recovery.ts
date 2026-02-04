import { $ } from "bun";

import type { AgentTask } from "../queue-backend";
import type { RunSessionOptionsBase, SessionResult } from "../session";

import { buildContextResumePrompt, retryContextCompactOnce } from "../context-compact";
import { ensureRalphWorktreeArtifacts, RALPH_PLAN_RELATIVE_PATH } from "../worktree-artifacts";

type ContextRecoveryContext = {
  task: AgentTask;
  repoPath: string;
  planPath: string;
};

type ContextRecoveryAttempt = {
  allowed: boolean;
  attempt: number;
};

type ContextRecoverySession = {
  continueCommand: (
    repoPath: string,
    sessionId: string,
    command: string,
    args?: string[],
    options?: RunSessionOptionsBase
  ) => Promise<SessionResult>;
  continueSession: (
    repoPath: string,
    sessionId: string,
    message: string,
    options?: RunSessionOptionsBase & { agent?: string }
  ) => Promise<SessionResult>;
};

export function createContextRecoveryManager(params: {
  repo: string;
  baseSession: ContextRecoverySession;
  attempts: Map<string, number>;
  getContext: () => ContextRecoveryContext | null;
  setContext: (context: ContextRecoveryContext | null) => void;
  onCompactTriggered?: (event: { sessionId: string; stepKey: string; attempt: number }, context: ContextRecoveryContext) => void;
  warn?: (message: string) => void;
}) {
  const warn = params.warn ?? ((message: string) => console.warn(message));

  function recordAttempt(task: AgentTask, stepKey: string): ContextRecoveryAttempt {
    const key = `${task._path}:${stepKey}`;
    const next = (params.attempts.get(key) ?? 0) + 1;
    params.attempts.set(key, next);
    return { allowed: next <= 1, attempt: next };
  }

  function buildRecoveryOptions(options: RunSessionOptionsBase | undefined, stepTitle: string): RunSessionOptionsBase {
    const introspection = {
      ...(options?.introspection ?? {}),
      stepTitle,
    };
    return { ...(options ?? {}), introspection };
  }

  async function getWorktreeStatusPorcelain(worktreePath: string): Promise<string> {
    try {
      const status = await $`git status --porcelain`.cwd(worktreePath).quiet();
      return status.stdout.toString().trim();
    } catch (e: any) {
      return `ERROR: ${e?.message ?? String(e)}`;
    }
  }

  async function maybeRecoverFromContextLengthExceeded(input: {
    repoPath: string;
    sessionId?: string;
    stepKey: string;
    result: SessionResult;
    options?: RunSessionOptionsBase;
    command?: string;
  }): Promise<SessionResult> {
    if (input.result.success || input.result.errorCode !== "context_length_exceeded") return input.result;
    if (input.command === "compact") return input.result;

    const context = params.getContext();
    if (!context) return input.result;

    const sessionId = input.result.sessionId?.trim() || input.sessionId?.trim();
    if (!sessionId) return input.result;

    const attempt = recordAttempt(context.task, input.stepKey);
    if (!attempt.allowed) return input.result;

    const compactOptions = buildRecoveryOptions(input.options, `context compact (${input.stepKey})`);
    const resumeOptions = buildRecoveryOptions(input.options, `context resume (${input.stepKey})`);

    const gitStatus = await getWorktreeStatusPorcelain(input.repoPath);
    const resumeMessage = buildContextResumePrompt({
      planPath: context.planPath,
      gitStatus,
    });

    const recovered = await retryContextCompactOnce({
      session: params.baseSession,
      repoPath: input.repoPath,
      sessionId,
      stepKey: input.stepKey,
      attempt,
      resumeMessage,
      compactOptions,
      resumeOptions,
      onEvent: (event) => {
        params.onCompactTriggered?.(
          { sessionId: event.sessionId, stepKey: event.stepKey, attempt: event.attempt },
          context
        );
      },
    });

    return recovered ?? input.result;
  }

  async function prepareContextRecovery(task: AgentTask, worktreePath: string): Promise<void> {
    try {
      await ensureRalphWorktreeArtifacts(worktreePath);
    } catch (e: any) {
      warn(
        `[ralph:worker:${params.repo}] Failed to ensure worktree artifacts at ${worktreePath}: ${e?.message ?? String(e)}`
      );
    }

    params.setContext({
      task,
      repoPath: worktreePath,
      planPath: RALPH_PLAN_RELATIVE_PATH,
    });
  }

  return {
    maybeRecoverFromContextLengthExceeded,
    prepareContextRecovery,
    getWorktreeStatusPorcelain,
  };
}
