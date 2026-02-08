import { listOpenPrCandidatesForIssue } from "../state";
import { normalizePrUrl, searchOpenPullRequestsByIssueLink, viewPullRequest, type PullRequestSearchResult } from "../github/pr";
import { selectCanonicalPr, type ResolvedPrCandidate } from "../pr-resolution";

export type ResolvedIssuePr = {
  selectedUrl: string | null;
  duplicates: string[];
  source: "db" | "gh-search" | null;
  diagnostics: string[];
};

type IssuePrResolutionCacheEntry = {
  createdAtMs: number;
  promise: Promise<ResolvedIssuePr>;
};

const DEFAULT_ISSUE_PR_RESOLUTION_CACHE_TTL_MS = 30_000;

export function createIssuePrResolver(params: {
  repo: string;
  formatGhError: (error: unknown) => string;
  recordOpenPrSnapshot: (issueRef: string, prUrl: string) => void;
  cacheTtlMs?: number;
}) {
  const cache = new Map<string, IssuePrResolutionCacheEntry>();
  const cacheTtlMs =
    Number.isFinite(params.cacheTtlMs) && (params.cacheTtlMs ?? 0) >= 0
      ? Math.floor(params.cacheTtlMs ?? 0)
      : DEFAULT_ISSUE_PR_RESOLUTION_CACHE_TTL_MS;

  const recordResolvedPrSnapshots = (
    issueNumber: string,
    resolved: { selected: ResolvedPrCandidate | null; duplicates: ResolvedPrCandidate[] }
  ): void => {
    const issueRef = `${params.repo}#${issueNumber}`;
    if (resolved.selected) {
      params.recordOpenPrSnapshot(issueRef, resolved.selected.url);
    }
    for (const duplicate of resolved.duplicates) {
      params.recordOpenPrSnapshot(issueRef, duplicate.url);
    }
  };

  const buildResolvedIssuePr = (
    resolved: { selected: ResolvedPrCandidate | null; duplicates: ResolvedPrCandidate[] },
    source: "db" | "gh-search",
    diagnostics: string[]
  ): ResolvedIssuePr => {
    if (resolved.selected) {
      diagnostics.push(`- Reusing PR: ${resolved.selected.url} (source=${source})`);
      if (resolved.duplicates.length > 0) {
        diagnostics.push(`- Duplicate PRs detected: ${resolved.duplicates.map((dup) => dup.url).join(", ")}`);
      }
    }

    return {
      selectedUrl: resolved.selected?.url ?? null,
      duplicates: resolved.duplicates.map((dup) => dup.url),
      source,
      diagnostics,
    };
  };

  const resolveDbPrCandidates = async (issueNumber: number, diagnostics: string[]): Promise<ResolvedPrCandidate[]> => {
    const rows = listOpenPrCandidatesForIssue(params.repo, issueNumber);
    if (rows.length === 0) return [];
    diagnostics.push(`- DB PR candidates: ${rows.length}`);

    const results: ResolvedPrCandidate[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const normalized = normalizePrUrl(row.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      try {
        const view = await viewPullRequest(params.repo, row.url);
        if (!view) continue;
        const state = String(view.state ?? "").toUpperCase();
        if (state !== "OPEN") continue;
        results.push({
          url: view.url,
          source: "db",
          ghCreatedAt: view.createdAt,
          ghUpdatedAt: view.updatedAt,
          dbUpdatedAt: row.updatedAt,
        });
        if (view.isDraft) {
          diagnostics.push(`- Existing PR is draft: ${view.url}`);
        }
      } catch (error: any) {
        diagnostics.push(`- Failed to validate PR ${row.url}: ${params.formatGhError(error)}`);
      }
    }

    return results;
  };

  const resolveSearchPrCandidates = async (issueNumber: string, diagnostics: string[]): Promise<ResolvedPrCandidate[]> => {
    let searchResults: PullRequestSearchResult[] = [];
    try {
      searchResults = await searchOpenPullRequestsByIssueLink(params.repo, issueNumber);
    } catch (error: any) {
      diagnostics.push(`- GitHub PR search failed: ${params.formatGhError(error)}`);
      return [];
    }

    if (searchResults.length === 0) return [];
    diagnostics.push(`- GitHub PR search candidates: ${searchResults.length}`);

    const results: ResolvedPrCandidate[] = [];
    const seen = new Set<string>();
    for (const result of searchResults) {
      const normalized = normalizePrUrl(result.url);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      results.push({
        url: result.url,
        source: "gh-search",
        ghCreatedAt: result.createdAt,
        ghUpdatedAt: result.updatedAt,
      });
    }

    return results;
  };

  const findExistingOpenPrForIssue = async (issueNumber: string): Promise<ResolvedIssuePr> => {
    const diagnostics: string[] = [];
    const parsedIssue = Number(issueNumber);
    if (!Number.isFinite(parsedIssue)) {
      diagnostics.push("- Invalid issue number; skipping PR reuse");
      return { selectedUrl: null, duplicates: [], source: null, diagnostics };
    }

    const dbCandidates = await resolveDbPrCandidates(parsedIssue, diagnostics);
    if (dbCandidates.length > 0) {
      const resolved = selectCanonicalPr(dbCandidates);
      const result = buildResolvedIssuePr(resolved, "db", diagnostics);
      recordResolvedPrSnapshots(issueNumber, resolved);
      return result;
    }

    const searchCandidates = await resolveSearchPrCandidates(issueNumber, diagnostics);
    if (searchCandidates.length > 0) {
      const resolved = selectCanonicalPr(searchCandidates);
      const result = buildResolvedIssuePr(resolved, "gh-search", diagnostics);
      recordResolvedPrSnapshots(issueNumber, resolved);
      return result;
    }

    return { selectedUrl: null, duplicates: [], source: null, diagnostics };
  };

  const getIssuePrResolution = (
    issueNumber: string,
    opts: { fresh?: boolean } = {}
  ): Promise<ResolvedIssuePr> => {
    const cacheKey = `${params.repo}#${issueNumber}`;
    if (opts.fresh) {
      cache.delete(cacheKey);
    } else {
      const cached = cache.get(cacheKey);
      if (cached) {
        if (Date.now() - cached.createdAtMs <= cacheTtlMs) {
          return cached.promise;
        }
        cache.delete(cacheKey);
      }
    }

    const promise = findExistingOpenPrForIssue(issueNumber).catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, { createdAtMs: Date.now(), promise });
    return promise;
  };

  const invalidateIssuePrResolution = (issueNumber: string): void => {
    const cacheKey = `${params.repo}#${issueNumber}`;
    cache.delete(cacheKey);
  };

  return {
    getIssuePrResolution,
    invalidateIssuePrResolution,
  };
}
