import type { RunSessionOptionsBase, RunSessionTestOverrides, SessionResult } from "./session";
import { recordRalphRunSessionUse } from "./state";

export type SessionAdapter = {
  runAgent: (
    repoPath: string,
    agent: string,
    message: string,
    options?: RunSessionOptionsBase,
    testOverrides?: RunSessionTestOverrides
  ) => Promise<SessionResult>;
  continueSession: (
    repoPath: string,
    sessionId: string,
    message: string,
    options?: RunSessionOptionsBase & { agent?: string }
  ) => Promise<SessionResult>;
  continueCommand: (
    repoPath: string,
    sessionId: string,
    command: string,
    args: string[],
    options?: RunSessionOptionsBase
  ) => Promise<SessionResult>;
  getRalphXdgCacheHome: (repo: string, cacheKey: string, xdgCacheHome?: string) => string;
};

type RecordUseParams = {
  runId: string;
  sessionId?: string;
  stepTitle?: string;
  agent?: string | null;
};

function resolveStepTitle(value: string | undefined | null, fallback: string): string {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
}

async function recordSessionUse(params: RecordUseParams): Promise<void> {
  if (!params.sessionId) return;
  try {
    recordRalphRunSessionUse({
      runId: params.runId,
      sessionId: params.sessionId,
      stepTitle: params.stepTitle,
      agent: params.agent ?? null,
    });
  } catch {
    // best-effort recording
  }
}

export function createRunRecordingSessionAdapter(params: {
  base: SessionAdapter;
  runId: string;
  repo: string;
  issue: string;
}): SessionAdapter {
  const { base, runId } = params;

  return {
    runAgent: async (repoPath, agent, message, options, testOverrides) => {
      const fallbackTitle = `agent:${agent}`;
      const stepTitle = resolveStepTitle(options?.introspection?.stepTitle, fallbackTitle);
      const result = await base.runAgent(repoPath, agent, message, options, testOverrides);
      await recordSessionUse({
        runId,
        sessionId: result.sessionId?.trim(),
        stepTitle,
        agent,
      });
      return result;
    },
    continueSession: async (repoPath, sessionId, message, options) => {
      const fallbackTitle = `session:${sessionId}`;
      const stepTitle = resolveStepTitle(options?.introspection?.stepTitle, fallbackTitle);
      const result = await base.continueSession(repoPath, sessionId, message, options);
      await recordSessionUse({
        runId,
        sessionId: result.sessionId?.trim() || sessionId?.trim(),
        stepTitle,
        agent: options?.agent ?? null,
      });
      return result;
    },
    continueCommand: async (repoPath, sessionId, command, args, options) => {
      const fallbackTitle = `command:${command}`;
      const stepTitle = resolveStepTitle(options?.introspection?.stepTitle, fallbackTitle);
      const result = await base.continueCommand(repoPath, sessionId, command, args, options);
      await recordSessionUse({
        runId,
        sessionId: result.sessionId?.trim() || sessionId?.trim(),
        stepTitle,
      });
      return result;
    },
    getRalphXdgCacheHome: base.getRalphXdgCacheHome,
  };
}
