import { fetchJson, parseLinkHeader } from "./http";
import type { IssuePayload } from "./issues-sync-types";

const ALLOWED_ISSUE_CURSOR_PARAMS = new Set(["state", "sort", "direction", "per_page", "page", "since"]);

type FetchIssuesParams = {
  repo: string;
  since: string | null;
  token: string;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
};

export type FetchIssuesResult =
  | { ok: true; issues: IssuePayload[]; fetched: number; maxUpdatedAt: string | null }
  | { ok: false; fetched: number; maxUpdatedAt: string | null; rateLimitResetMs?: number; error: string };

export type FetchIssuesPageResult =
  | {
      ok: true;
      rows: IssuePayload[];
      nonPrRows: IssuePayload[];
      fetched: number;
      pageMaxUpdatedAt: string | null;
      nextUrlRaw: string | null;
    }
  | { ok: false; rateLimitResetMs?: number; error: string };

export function buildIssuesListUrl(repo: string): URL {
  const url = new URL(`https://api.github.com/repos/${repo}/issues`);
  url.searchParams.set("state", "all");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");
  return url;
}

export function validateIssuesCursor(raw: string, repo: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.hostname !== "api.github.com") return null;
    if (url.pathname !== `/repos/${repo}/issues`) return null;
    for (const key of url.searchParams.keys()) {
      if (!ALLOWED_ISSUE_CURSOR_PARAMS.has(key)) return null;
    }
    return url;
  } catch {
    return null;
  }
}

function parseIsoMs(value?: string): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function computeMaxUpdatedAt(current: string | null, candidate?: string): string | null {
  const currentMs = parseIsoMs(current ?? undefined);
  const candidateMs = parseIsoMs(candidate);
  if (candidateMs === null) return current;
  if (currentMs === null || candidateMs > currentMs) return new Date(candidateMs).toISOString();
  return current;
}

function resolveRateLimitReset(headers: Headers): number | null {
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining !== "0" || !reset) return null;
  const resetSeconds = Number(reset);
  if (!Number.isFinite(resetSeconds)) return null;
  return resetSeconds * 1000;
}

function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

function isSecondaryRateLimitText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes("secondary rate limit") || value.includes("abuse detection") || value.includes("temporarily blocked");
}

function isPrimaryRateLimitText(text: string): boolean {
  const value = text.toLowerCase();
  return value.includes("api rate limit exceeded") || value.includes("rate limit exceeded");
}

function resolveRateLimitResetMs(headers: Headers, body: string, nowMs: number): number | null {
  const retryAfterMs = parseRetryAfterMs(headers);
  if (retryAfterMs != null) return nowMs + retryAfterMs;

  const reset = resolveRateLimitReset(headers);
  if (reset != null) return reset;

  if (isSecondaryRateLimitText(body) || isPrimaryRateLimitText(body)) {
    return nowMs + 60_000;
  }

  return null;
}

function isPullRequest(issue: IssuePayload): boolean {
  return Boolean(issue.pull_request);
}

export async function fetchIssuesPage(params: {
  url: URL;
  token: string;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  nowMs?: number;
}): Promise<FetchIssuesPageResult> {
  const result = await fetchJson<IssuePayload[]>(params.fetchImpl, params.url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `token ${params.token}`,
      "User-Agent": "ralph-loop",
    },
  });

  if (!result.ok) {
    const nowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
    const resetAt = resolveRateLimitResetMs(result.headers, result.body, nowMs);
    return {
      ok: false,
      rateLimitResetMs: resetAt ?? undefined,
      error: `HTTP ${result.status}: ${result.body.slice(0, 400)}`,
    };
  }

  const rows = Array.isArray(result.data) ? result.data : [];
  const nonPrRows = rows.filter((row) => !isPullRequest(row));
  let pageMaxUpdatedAt: string | null = null;
  for (const row of rows) {
    pageMaxUpdatedAt = computeMaxUpdatedAt(pageMaxUpdatedAt, row.updated_at);
  }

  const links = parseLinkHeader(result.headers.get("link"));
  const nextUrlRaw = links.next ?? null;

  return {
    ok: true,
    rows,
    nonPrRows,
    fetched: rows.length,
    pageMaxUpdatedAt,
    nextUrlRaw,
  };
}

export async function fetchIssuesSince(params: FetchIssuesParams): Promise<FetchIssuesResult> {
  let url: URL | null = new URL(`https://api.github.com/repos/${params.repo}/issues`);
  url.searchParams.set("state", "all");
  if (params.since) url.searchParams.set("since", params.since);
  url.searchParams.set("sort", "updated");
  url.searchParams.set("direction", "desc");
  url.searchParams.set("per_page", "100");

  const issues: IssuePayload[] = [];
  let maxUpdatedAt: string | null = null;
  let fetched = 0;

  while (url) {
    const result = await fetchJson<IssuePayload[]>(params.fetchImpl, url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `token ${params.token}`,
        "User-Agent": "ralph-loop",
      },
    });

    if (!result.ok) {
      const nowMs = typeof params.nowMs === "number" ? params.nowMs : Date.now();
      const resetAt = resolveRateLimitResetMs(result.headers, result.body, nowMs);
      return {
        ok: false,
        fetched,
        maxUpdatedAt,
        rateLimitResetMs: resetAt ?? undefined,
        error: `HTTP ${result.status}: ${result.body.slice(0, 400)}`,
      };
    }

    const rows = Array.isArray(result.data) ? result.data : [];
    fetched += rows.length;
    const nonPrRows = rows.filter((row) => !isPullRequest(row));
    issues.push(...nonPrRows);

    for (const row of rows) {
      maxUpdatedAt = computeMaxUpdatedAt(maxUpdatedAt, row.updated_at);
    }

    const links = parseLinkHeader(result.headers.get("link"));
    url = links.next ? new URL(links.next) : null;

    if (rows.length > 0) {
      const last = rows[rows.length - 1];
      const lastUpdatedMs = parseIsoMs(last.updated_at);
      const sinceMs = parseIsoMs(params.since ?? undefined);
      if (lastUpdatedMs !== null && sinceMs !== null && lastUpdatedMs < sinceMs) {
        url = null;
      }
    }
  }

  return { ok: true, issues, fetched, maxUpdatedAt };
}
