import type { RunSessionOptionsBase } from "../session";
import { getOpencodeTransportMode } from "../config";
import { decideTransport } from "./transport-decision-core";
import { createSdkSessionAdapter, type SessionAdapterLike } from "./sdk-session-adapter";

function runKey(repoPath: string, options?: RunSessionOptionsBase): string {
  const cacheKey = options?.cacheKey?.trim() || "default";
  return `${repoPath}::${cacheKey}`;
}

export function createConfiguredSessionAdapter(cliAdapter: SessionAdapterLike): SessionAdapterLike {
  const sdkAdapter = createSdkSessionAdapter({ cli: cliAdapter });
  const fallbackConsumed = new Map<string, boolean>();

  const withTransport = async <T>(
    repoPath: string,
    options: RunSessionOptionsBase | undefined,
    runCli: () => Promise<T>,
    runSdk: () => Promise<T>
  ): Promise<T> => {
    const mode = getOpencodeTransportMode();
    const key = runKey(repoPath, options);
    const state = { fallbackConsumed: fallbackConsumed.get(key) ?? false };
    const decision = decideTransport(mode, state);

    if (decision.mode === "cli") {
      return await runCli();
    }

    try {
      return await runSdk();
    } catch (error: any) {
      if (!decision.allowFallback) throw error;
      fallbackConsumed.set(key, true);
      const message = String(error?.message ?? error);
      const code = String(error?.code ?? "sdk-error");
      console.warn(`[ralph:session] OpenCode SDK failed (${code}); falling back to CLI for run ${key}: ${message}`);
      return await runCli();
    }
  };

  return {
    runAgent: async (repoPath, agent, message, options) =>
      await withTransport(
        repoPath,
        options,
        async () => await cliAdapter.runAgent(repoPath, agent, message, options),
        async () => await sdkAdapter.runAgent(repoPath, agent, message, options)
      ),

    continueSession: async (repoPath, sessionId, message, options) =>
      await withTransport(
        repoPath,
        options,
        async () => await cliAdapter.continueSession(repoPath, sessionId, message, options),
        async () => await sdkAdapter.continueSession(repoPath, sessionId, message, options)
      ),

    continueCommand: async (repoPath, sessionId, command, args, options) =>
      await withTransport(
        repoPath,
        options,
        async () => await cliAdapter.continueCommand(repoPath, sessionId, command, args, options),
        async () => await sdkAdapter.continueCommand(repoPath, sessionId, command, args, options)
      ),

    getRalphXdgCacheHome: cliAdapter.getRalphXdgCacheHome,
  };
}
