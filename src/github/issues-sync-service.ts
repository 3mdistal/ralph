import { isAbortError } from "../abort";
import { resolveGitHubToken } from "../github-auth";
import { shouldLog } from "../logging";
import { Semaphore, type ReleaseFn } from "../semaphore";
import {
  hasIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
  recordRepoGithubIssueSync,
  runInStateTransaction,
} from "../state";
import { fetchIssuesSince } from "./issues-rest";
import { buildIssueStorePlan, computeNewLastSyncAt, computeSince } from "./issues-sync-core";
import type { SyncDeps, SyncResult, SyncStateDeps } from "./issues-sync-types";

const DEFAULT_ISSUE_SYNC_MAX_INFLIGHT = 2;

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

const issueSyncSemaphore = new Semaphore(
  Math.max(1, readEnvInt("RALPH_GITHUB_ISSUES_SYNC_MAX_INFLIGHT", DEFAULT_ISSUE_SYNC_MAX_INFLIGHT))
);

const DEFAULT_STATE_DEPS: SyncStateDeps = {
  runInStateTransaction,
  hasIssueSnapshot,
  recordIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordRepoGithubIssueSync,
};

export async function syncRepoIssuesOnce(params: {
  repo: string;
  repoPath?: string;
  botBranch?: string;
  lastSyncAt: string | null;
  persistCursor?: boolean;
  storeAllOpen?: boolean;
  signal?: AbortSignal;
  deps?: SyncDeps;
}): Promise<SyncResult> {
  const deps = params.deps ?? {};
  const signal = params.signal;
  const fetchImpl = deps.fetch ?? fetch;
  const getToken = deps.getToken ?? resolveGitHubToken;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const since = computeSince(params.lastSyncAt);
  const stateDeps: SyncStateDeps = { ...DEFAULT_STATE_DEPS, ...(deps.state ?? {}) };

  let releaseSync: ReleaseFn | null = null;

  const buildAbortedResult = (): SyncResult => ({
    status: "aborted",
    ok: false,
    fetched: 0,
    stored: 0,
    ralphCount: 0,
    newLastSyncAt: null,
    hadChanges: false,
  });

  try {
    if (signal?.aborted) return buildAbortedResult();
    releaseSync = await issueSyncSemaphore.acquire({ signal });
    if (signal?.aborted) return buildAbortedResult();
    const token = await getToken();
    if (!token) {
      if (shouldLog(`github-sync:auth-missing:${params.repo}`, 60_000)) {
        console.warn(`[ralph:gh-sync] GitHub auth is not configured; skipping issue sync for ${params.repo}`);
      }
      return {
        status: "ok",
        ok: true,
        fetched: 0,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: params.lastSyncAt ?? null,
        hadChanges: false,
      };
    }

    const fetchResult = await fetchIssuesSince({
      repo: params.repo,
      since,
      token,
      fetchImpl,
      nowMs,
      signal,
    });

    if (!fetchResult.ok) {
      return {
        status: fetchResult.rateLimitResetMs ? "rate_limited" : "error",
        ok: false,
        fetched: fetchResult.fetched,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: null,
        hadChanges: false,
        rateLimitResetMs: fetchResult.rateLimitResetMs,
        error: fetchResult.error,
      };
    }

    const newLastSyncAt = computeNewLastSyncAt({
      fetched: fetchResult.fetched,
      maxUpdatedAt: fetchResult.maxUpdatedAt,
      lastSyncAt: params.lastSyncAt,
      nowIso,
    });

    let plan: ReturnType<typeof buildIssueStorePlan> | null = null;

    if (signal?.aborted) return buildAbortedResult();

    stateDeps.runInStateTransaction(() => {
      plan = buildIssueStorePlan({
        repo: params.repo,
        issues: fetchResult.issues,
        storeAllOpen: params.storeAllOpen,
        hasIssueSnapshot: stateDeps.hasIssueSnapshot,
      });

      for (const item of plan.plans) {
        stateDeps.recordIssueSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          title: item.title,
          state: item.state,
          url: item.url,
          githubNodeId: item.githubNodeId,
          githubUpdatedAt: item.githubUpdatedAt,
          at: nowIso,
        });

        stateDeps.recordIssueLabelsSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          labels: item.labels,
          at: nowIso,
        });
      }

      if (params.persistCursor && newLastSyncAt && newLastSyncAt !== params.lastSyncAt) {
        stateDeps.recordRepoGithubIssueSync({
          repo: params.repo,
          repoPath: params.repoPath,
          botBranch: params.botBranch,
          lastSyncAt: newLastSyncAt,
        });
      }
    });

    const finalPlan = plan ?? { plans: [], ralphCount: 0 };

    return {
      status: "ok",
      ok: true,
      fetched: fetchResult.fetched,
      stored: finalPlan.plans.length,
      ralphCount: finalPlan.ralphCount,
      newLastSyncAt,
      hadChanges: finalPlan.plans.length > 0,
    };
  } catch (error: any) {
    if (isAbortError(error, signal)) {
      return buildAbortedResult();
    }
    return {
      status: "error",
      ok: false,
      fetched: 0,
      stored: 0,
      ralphCount: 0,
      newLastSyncAt: null,
      hadChanges: false,
      error: error?.message ?? String(error),
    };
  } finally {
    releaseSync?.();
  }
}
