import { isAbortError } from "../abort";
import { resolveGitHubToken } from "../github-auth";
import { detectLegacyWorkflowLabels } from "../github-labels";
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
  setRepoLabelSchemeState,
  runInStateTransaction,
} from "../state";
import { buildIssuesListUrl, fetchIssuesPage, fetchIssuesSince, validateIssuesCursor } from "./issues-rest";
import {
  buildIssueStorePlan,
  computeNewLastSyncAt,
  computeSince,
  extractLabelNames,
  normalizeIssueState,
} from "./issues-sync-core";
import type { SyncDeps, SyncResult, SyncStateDeps } from "./issues-sync-types";

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
  const now = deps.now ? deps.now() : new Date(Date.now());
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const since = computeSince(params.lastSyncAt);
  const stateDeps: SyncStateDeps = { ...DEFAULT_STATE_DEPS, ...(deps.state ?? {}) };
  const maxPages = Math.max(
    1,
    readEnvInt("RALPH_GITHUB_ISSUES_SYNC_MAX_PAGES_PER_TICK", DEFAULT_ISSUE_SYNC_MAX_PAGES_PER_TICK)
  );
  const maxIssues = Math.max(
    1,
    readEnvInt("RALPH_GITHUB_ISSUES_SYNC_MAX_ISSUES_PER_TICK", DEFAULT_ISSUE_SYNC_MAX_ISSUES_PER_TICK)
  );

  let releaseSync: ReleaseFn | null = null;
  const legacyDetected = new Set<string>();

  const scanLegacyLabels = (rows: Array<{ state?: string; labels?: unknown }>) => {
    for (const row of rows) {
      const state = normalizeIssueState(row.state);
      if (state === "CLOSED") continue;
      const labels = extractLabelNames(row.labels as any);
      for (const legacy of detectLegacyWorkflowLabels(labels)) {
        legacyDetected.add(legacy);
      }
    }
  };

  const persistLabelSchemeState = () => {
    const detected = Array.from(legacyDetected).sort((a, b) => a.localeCompare(b));
    if (detected.length === 0) {
      setRepoLabelSchemeState({ repo: params.repo, errorCode: null, errorDetails: null, checkedAt: nowIso });
      return;
    }

    const details =
      `Legacy workflow labels detected on OPEN issues/PRs: ${detected.join(", ")}. ` +
      `Manual cutover required: see docs/ops/label-scheme-migration.md`;
    setRepoLabelSchemeState({
      repo: params.repo,
      errorCode: "legacy-workflow-labels",
      errorDetails: details,
      checkedAt: nowIso,
    });
  };

  const buildAbortedResult = (): SyncResult => ({
    status: "aborted",
    ok: false,
    fetched: 0,
    stored: 0,
    ralphCount: 0,
    newLastSyncAt: null,
    hadChanges: false,
    progressed: false,
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
        const page = await fetchIssuesPage({ url, token, fetchImpl, nowMs, signal });

        if (!page.ok) {
          return {
            status: page.rateLimitResetMs ? "rate_limited" : "error",
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

        scanLegacyLabels(page.rows);

        if (!bootstrapHighWatermark && page.pageMaxUpdatedAt) {
          bootstrapHighWatermark = page.pageMaxUpdatedAt;
        }

        stateDeps.runInStateTransaction(() => {
          const plan = buildIssueStorePlan({
            repo: params.repo,
            issues: page.nonPrRows,
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
              stateDeps.recordRepoGithubIssueSync({
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

      persistLabelSchemeState();

      return {
        status: "ok",
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
        progressed: false,
        rateLimitResetMs: fetchResult.rateLimitResetMs,
        error: fetchResult.error,
      };
    }

    scanLegacyLabels(fetchResult.issues);

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

    persistLabelSchemeState();

    return {
      status: "ok",
      ok: true,
      fetched: fetchResult.fetched,
      stored: finalPlan.plans.length,
      ralphCount: finalPlan.ralphCount,
      newLastSyncAt,
      hadChanges: finalPlan.plans.length > 0,
      progressed: fetchResult.fetched > 0,
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
      progressed: false,
      error: error?.message ?? String(error),
    };
  } finally {
    releaseSync?.();
  }
}
