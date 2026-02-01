import { resolveGitHubToken } from "../github-auth";
import { shouldLog } from "../logging";
import { Semaphore, type ReleaseFn } from "../semaphore";
import {
  clearRepoGithubIssueBootstrapCursor,
  getRepoGithubIssueBootstrapCursor,
  hasIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
  recordRepoGithubIssueBootstrapCursor,
  recordRepoGithubIssueSync,
  runInStateTransaction,
} from "../state";
import { buildIssuesListUrl, fetchIssuesPage, fetchIssuesSince, validateIssuesCursor } from "./issues-rest";
import { buildIssueStorePlan, computeNewLastSyncAt, computeSince } from "./issues-sync-core";
import type { SyncDeps, SyncResult } from "./issues-sync-types";

const DEFAULT_ISSUE_SYNC_MAX_INFLIGHT = 2;
const DEFAULT_ISSUE_SYNC_MAX_PAGES_PER_TICK = 2;
const DEFAULT_ISSUE_SYNC_MAX_ISSUES_PER_TICK = 200;

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
  deps?: SyncDeps;
}): Promise<SyncResult> {
  const deps = params.deps ?? {};
  const fetchImpl = deps.fetch ?? fetch;
  const getToken = deps.getToken ?? resolveGitHubToken;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const nowMs = Date.now();
  const since = computeSince(params.lastSyncAt);
  const maxPages = Math.max(
    1,
    readEnvInt("RALPH_GITHUB_ISSUES_SYNC_MAX_PAGES_PER_TICK", DEFAULT_ISSUE_SYNC_MAX_PAGES_PER_TICK)
  );
  const maxIssues = Math.max(
    1,
    readEnvInt("RALPH_GITHUB_ISSUES_SYNC_MAX_ISSUES_PER_TICK", DEFAULT_ISSUE_SYNC_MAX_ISSUES_PER_TICK)
  );

  let releaseSync: ReleaseFn | null = null;

  try {
    releaseSync = await issueSyncSemaphore.acquire();
    const token = await getToken();
    if (!token) {
      if (shouldLog(`github-sync:auth-missing:${params.repo}`, 60_000)) {
        console.warn(`[ralph:gh-sync] GitHub auth is not configured; skipping issue sync for ${params.repo}`);
      }
      return {
        ok: true,
        fetched: 0,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: params.lastSyncAt ?? null,
        hadChanges: false,
        progressed: false,
      };
    }

    if (!since) {
      const bootstrapState = getRepoGithubIssueBootstrapCursor(params.repo);
      let cursorInvalid = false;
      let bootstrapHighWatermark = bootstrapState?.highWatermarkUpdatedAt ?? null;
      let url: URL | null = null;

      if (bootstrapState?.nextUrl) {
        const validated = validateIssuesCursor(bootstrapState.nextUrl, params.repo);
        if (validated) {
          url = validated;
        } else {
          cursorInvalid = true;
          if (params.persistCursor) {
            clearRepoGithubIssueBootstrapCursor({ repo: params.repo });
          }
          bootstrapHighWatermark = null;
          url = buildIssuesListUrl(params.repo);
        }
      } else {
        url = buildIssuesListUrl(params.repo);
      }

      let stored = 0;
      let ralphCount = 0;
      let fetched = 0;
      let pagesFetched = 0;
      let limitHit: SyncResult["limitHit"];
      let newLastSyncAt: string | null = null;

      while (url && pagesFetched < maxPages && fetched < maxIssues) {
        const page = await fetchIssuesPage({ url, token, fetchImpl, nowMs });

        if (!page.ok) {
          return {
            ok: false,
            fetched,
            stored,
            ralphCount,
            newLastSyncAt: null,
            hadChanges: false,
            progressed: pagesFetched > 0,
            rateLimitResetMs: page.rateLimitResetMs,
            error: page.error,
            cursorInvalid: cursorInvalid || undefined,
          };
        }

        fetched += page.fetched;
        pagesFetched += 1;

        if (!bootstrapHighWatermark && page.pageMaxUpdatedAt) {
          bootstrapHighWatermark = page.pageMaxUpdatedAt;
        }

        runInStateTransaction(() => {
          const plan = buildIssueStorePlan({
            repo: params.repo,
            issues: page.nonPrRows,
            storeAllOpen: params.storeAllOpen,
            hasIssueSnapshot,
          });

          for (const item of plan.plans) {
            recordIssueSnapshot({
              repo: params.repo,
              issue: item.issueRef,
              title: item.title,
              state: item.state,
              url: item.url,
              githubNodeId: item.githubNodeId,
              githubUpdatedAt: item.githubUpdatedAt,
              at: nowIso,
            });

            recordIssueLabelsSnapshot({
              repo: params.repo,
              issue: item.issueRef,
              labels: item.labels,
              at: nowIso,
            });
          }

          stored += plan.plans.length;
          ralphCount += plan.ralphCount;

          if (params.persistCursor) {
            if (page.nextUrlRaw) {
              recordRepoGithubIssueBootstrapCursor({
                repo: params.repo,
                repoPath: params.repoPath,
                botBranch: params.botBranch,
                nextUrl: page.nextUrlRaw,
                highWatermarkUpdatedAt: bootstrapHighWatermark ?? nowIso,
                updatedAt: nowIso,
              });
            } else {
              const finalSyncAt = bootstrapHighWatermark ?? nowIso;
              recordRepoGithubIssueSync({
                repo: params.repo,
                repoPath: params.repoPath,
                botBranch: params.botBranch,
                lastSyncAt: finalSyncAt,
              });
              clearRepoGithubIssueBootstrapCursor({ repo: params.repo });
              newLastSyncAt = finalSyncAt;
            }
          } else if (!page.nextUrlRaw) {
            newLastSyncAt = bootstrapHighWatermark ?? nowIso;
          }
        });

        const reachedMaxIssues = fetched >= maxIssues;
        const reachedMaxPages = pagesFetched >= maxPages;
        if (page.nextUrlRaw && (reachedMaxIssues || reachedMaxPages)) {
          limitHit = {
            kind: reachedMaxIssues ? "maxIssues" : "maxPages",
            pagesFetched,
            issuesFetched: fetched,
            maxPages,
            maxIssues,
          };
          break;
        }

        url = page.nextUrlRaw ? new URL(page.nextUrlRaw) : null;
      }

      return {
        ok: true,
        fetched,
        stored,
        ralphCount,
        newLastSyncAt,
        hadChanges: stored > 0,
        progressed: pagesFetched > 0,
        limitHit,
        cursorInvalid: cursorInvalid || undefined,
      };
    }

    const fetchResult = await fetchIssuesSince({
      repo: params.repo,
      since,
      token,
      fetchImpl,
      nowMs,
    });

    if (!fetchResult.ok) {
      return {
        ok: false,
        fetched: fetchResult.fetched,
        stored: 0,
        ralphCount: 0,
        newLastSyncAt: null,
        hadChanges: false,
        progressed: false,
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

    runInStateTransaction(() => {
      plan = buildIssueStorePlan({
        repo: params.repo,
        issues: fetchResult.issues,
        storeAllOpen: params.storeAllOpen,
        hasIssueSnapshot,
      });

      for (const item of plan.plans) {
        recordIssueSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          title: item.title,
          state: item.state,
          url: item.url,
          githubNodeId: item.githubNodeId,
          githubUpdatedAt: item.githubUpdatedAt,
          at: nowIso,
        });

        recordIssueLabelsSnapshot({
          repo: params.repo,
          issue: item.issueRef,
          labels: item.labels,
          at: nowIso,
        });
      }

      if (params.persistCursor && newLastSyncAt && newLastSyncAt !== params.lastSyncAt) {
        recordRepoGithubIssueSync({
          repo: params.repo,
          repoPath: params.repoPath,
          botBranch: params.botBranch,
          lastSyncAt: newLastSyncAt,
        });
      }
    });

    const finalPlan = plan ?? { plans: [], ralphCount: 0 };

    return {
      ok: true,
      fetched: fetchResult.fetched,
      stored: finalPlan.plans.length,
      ralphCount: finalPlan.ralphCount,
      newLastSyncAt,
      hadChanges: finalPlan.plans.length > 0,
      progressed: fetchResult.fetched > 0,
    };
  } catch (error: any) {
    return {
      ok: false,
      fetched: 0,
      stored: 0,
      ralphCount: 0,
      newLastSyncAt: null,
      hadChanges: false,
      progressed: false,
      error: error?.message ?? String(error),
    };
  } finally {
    releaseSync?.();
  }
}
