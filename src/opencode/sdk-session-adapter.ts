import type { RunSessionOptionsBase, SessionResult } from "../session";
import { OpencodeServerLifecycle } from "./server-lifecycle-io";
import { createSdkClient } from "./sdk-client";
import type { OpencodeTransportFailure } from "./transport-types";

type SdkResult = {
  sessionId?: string;
  output?: string;
  prUrl?: string;
};

type SdkAdapterDeps = {
  lifecycle: OpencodeServerLifecycle;
  createClient: (baseUrl: string) => Promise<unknown>;
};

export type SessionAdapterLike = {
  runAgent: (repoPath: string, agent: string, message: string, options?: RunSessionOptionsBase) => Promise<SessionResult>;
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
    args?: string[],
    options?: RunSessionOptionsBase
  ) => Promise<SessionResult>;
  getRalphXdgCacheHome: (repo: string, cacheKey: string, xdgCacheHome?: string) => string;
};

function toMessage(command: string, args?: string[]): string {
  return ["/" + command, ...(args ?? [])].join(" ");
}

function normalizeTransportError(error: unknown, fallback: OpencodeTransportFailure): OpencodeTransportFailure {
  if (error && typeof error === "object") {
    const candidate = error as Partial<OpencodeTransportFailure>;
    if (typeof candidate.code === "string" && typeof candidate.message === "string") {
      return { code: candidate.code as OpencodeTransportFailure["code"], message: candidate.message };
    }
  }
  return fallback;
}

function mapSdkResult(result: SdkResult, fallbackSessionId?: string): SessionResult {
  return {
    sessionId: String(result.sessionId ?? fallbackSessionId ?? "").trim(),
    output: String(result.output ?? ""),
    success: true,
    ...(result.prUrl ? { prUrl: result.prUrl } : {}),
  };
}

async function callKnownSdkPath(client: any, payload: {
  mode: "run" | "continue";
  agent?: string;
  sessionId?: string;
  message: string;
}): Promise<SdkResult> {
  const attempt = async (fn: unknown): Promise<SdkResult | null> => {
    if (typeof fn !== "function") return null;
    const value = await (fn as (args: Record<string, unknown>) => Promise<any>)({
      ...(payload.agent ? { agent: payload.agent } : {}),
      ...(payload.sessionId ? { sessionID: payload.sessionId, sessionId: payload.sessionId } : {}),
      message: payload.message,
    });
    if (!value || typeof value !== "object") {
      return { output: String(value ?? "") };
    }
    const result = value as Record<string, unknown>;
    const sessionId =
      typeof result.sessionId === "string"
        ? result.sessionId
        : typeof result.sessionID === "string"
          ? result.sessionID
          : undefined;
    const output =
      typeof result.output === "string"
        ? result.output
        : typeof result.text === "string"
          ? result.text
          : typeof result.message === "string"
            ? result.message
            : JSON.stringify(result);
    const prUrl = typeof result.prUrl === "string" ? result.prUrl : undefined;
    return { sessionId, output, prUrl };
  };

  const candidates: unknown[] =
    payload.mode === "run"
      ? [
          client?.session?.createAndSend,
          client?.session?.create,
          client?.sessions?.create,
          client?.run,
          client?.send,
        ]
      : [
          client?.session?.send,
          client?.session?.message,
          client?.sessions?.send,
          client?.continue,
          client?.send,
        ];

  for (const candidate of candidates) {
    const resolved = await attempt(candidate);
    if (resolved) return resolved;
  }

  throw <OpencodeTransportFailure>{
    code: "sdk-client-shape",
    message: "Unsupported @opencode-ai/sdk client shape for session calls",
  };
}

async function runSdkCall(deps: SdkAdapterDeps, params: {
  repoPath: string;
  mode: "run" | "continue";
  agent?: string;
  sessionId?: string;
  message: string;
  options?: RunSessionOptionsBase;
}): Promise<SessionResult> {
  const ensured = await deps.lifecycle.ensureServer({ repoPath: params.repoPath, options: params.options });
  const client = await deps.createClient(ensured.baseUrl);

  const result = await callKnownSdkPath(client, {
    mode: params.mode,
    agent: params.agent,
    sessionId: params.sessionId,
    message: params.message,
  });
  return mapSdkResult(result, params.sessionId);
}

export function createSdkSessionAdapter(options: { cli: SessionAdapterLike }): SessionAdapterLike {
  const deps: SdkAdapterDeps = {
    lifecycle: new OpencodeServerLifecycle(),
    createClient: createSdkClient,
  };

  const wrap = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error: unknown) {
      throw normalizeTransportError(error, {
        code: "sdk-request-failed",
        message: String((error as any)?.message ?? error),
      });
    }
  };

  return {
    runAgent: async (repoPath, agent, message, options) =>
      await wrap(() => runSdkCall(deps, { repoPath, mode: "run", agent, message, options })),
    continueSession: async (repoPath, sessionId, message, options) =>
      await wrap(() => runSdkCall(deps, { repoPath, mode: "continue", sessionId, message, options })),
    continueCommand: async (repoPath, sessionId, command, args, options) =>
      await wrap(() =>
        runSdkCall(deps, {
          repoPath,
          mode: "continue",
          sessionId,
          message: toMessage(command, args),
          options,
        })
      ),
    getRalphXdgCacheHome: options.cli.getRalphXdgCacheHome,
  };
}
