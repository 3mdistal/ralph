import { resolveGitHubToken } from "../github-auth";
import { shouldLog } from "../logging";
import { isAbortError } from "../abort";
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
import type { SyncDeps, SyncResult } from "./issues-sync-types";

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
  const fetchImpl = deps.fetch ?? fetch;
  const getToken = deps.getToken ?? resolveGitHubToken;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const since = computeSince(params.lastSyncAt);
  const signal = params.signal;
  const acquireSyncPermit =
    deps.acquireSyncPermit ?? ((opts?: { signal?: AbortSignal }) => issueSyncSemaphore.acquire(opts));
  const state = deps.state ?? {
    hasIssueSnapshot,
    recordIssueLabelsSnapshot,
    recordIssueSnapshot,
    recordRepoGithubIssueSync,
    runInStateTransaction,
  };

  const abortedResult = (): SyncResult => ({
    status: "aborted",
    fetched: 0,
    stored: 0,
    ralphCount: 0,
    newLastSyncAt: params.lastSyncAt ?? null,
    hadChanges: false,
  });

  let releaseSync: ReleaseFn | null = null;

  try {
    if (signal?.aborted) return abortedResult();
    releaseSync = await acquireSyncPermit({ signal });
    if (signal?.aborted) return abortedResult();
    const token = await getToken();
    if (!token) {
      if (shouldLog(`github-sync:auth-missing:${params.repo}`, 60_000)) {
        console.warn(`[ralph:gh-sync] GitHub auth is not configured; skipping issue sync for ${params.repo}`);
      }
      return {
        status: "ok",
        fetched: 0,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: params.lastSyncAt ?? null,
        hadChanges: false,
      };
    }

    if (signal?.aborted) return abortedResult();

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
        status: "error",
        fetched: fetchResult.fetched,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: null,
        hadChanges: false,
        rateLimitResetMs: fetchResult.rateLimitResetMs,
        error: fetchResult.error,
      };
    }

    if (signal?.aborted) return abortedResult();

    const newLastSyncAt = computeNewLastSyncAt({
      fetched: fetchResult.fetched,
      maxUpdatedAt: fetchResult.maxUpdatedAt,
      lastSyncAt: params.lastSyncAt,
      nowIso,
    });

    let plan: ReturnType<typeof buildIssueStorePlan> | null = null;

    if (signal?.aborted) return abortedResult();

    state.runInStateTransaction(() => {
      plan = buildIssueStorePlan({
        repo: params.repo,
        issues: fetchResult.issues,
        storeAllOpen: params.storeAllOpen,
        hasIssueSnapshot: state.hasIssueSnapshot,
      });

      for (const item of plan.plans) {
        state.recordIssueSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          title: item.title,
          state: item.state,
          url: item.url,
          githubNodeId: item.githubNodeId,
          githubUpdatedAt: item.githubUpdatedAt,
          at: nowIso,
        });

        state.recordIssueLabelsSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          labels: item.labels,
          at: nowIso,
        });
      }

      if (params.persistCursor && newLastSyncAt && newLastSyncAt !== params.lastSyncAt) {
        state.recordRepoGithubIssueSync({
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
      fetched: fetchResult.fetched,
      stored: finalPlan.plans.length,
      ralphCount: finalPlan.ralphCount,
      newLastSyncAt,
      hadChanges: finalPlan.plans.length > 0,
    };
  } catch (error: any) {
    if (isAbortError(error) || signal?.aborted) {
      return abortedResult();
    }
    return {
      status: "error",
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
