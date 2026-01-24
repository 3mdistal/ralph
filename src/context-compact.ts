import type { RunSessionOptionsBase, SessionResult } from "./session";

type ContextCompactSession = {
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

export type ContextCompactAttempt = {
  allowed: boolean;
  attempt: number;
};

export type ContextCompactEvent = {
  stepKey: string;
  attempt: number;
  sessionId: string;
};

export function buildContextResumePrompt(params: { planPath: string; gitStatus: string }): string {
  const status = params.gitStatus.trim() ? params.gitStatus.trim() : "(clean)";

  return [
    "Continue with the original plan.",
    `The plan checklist is in ${params.planPath}. Open it and resume from the first unchecked item.`,
    "If the plan file is missing, recreate it as a checklist and continue.",
    "Current worktree status:",
    "```",
    status,
    "```",
  ].join("\n");
}

export async function retryContextCompactOnce(params: {
  session: ContextCompactSession;
  repoPath: string;
  sessionId: string;
  stepKey: string;
  attempt: ContextCompactAttempt;
  resumeMessage: string;
  compactOptions?: RunSessionOptionsBase;
  resumeOptions?: RunSessionOptionsBase & { agent?: string };
  onEvent?: (event: ContextCompactEvent) => void;
}): Promise<SessionResult | null> {
  if (!params.attempt.allowed) return null;

  params.onEvent?.({
    stepKey: params.stepKey,
    attempt: params.attempt.attempt,
    sessionId: params.sessionId,
  });

  const compactResult = await params.session.continueCommand(
    params.repoPath,
    params.sessionId,
    "compact",
    [],
    params.compactOptions
  );

  if (!compactResult.success) return compactResult;

  const resumeSessionId = compactResult.sessionId || params.sessionId;
  return params.session.continueSession(
    params.repoPath,
    resumeSessionId,
    params.resumeMessage,
    params.resumeOptions
  );
}
