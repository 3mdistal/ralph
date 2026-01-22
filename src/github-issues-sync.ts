import { type RepoConfig } from "./config";
import { getInstallationToken, isRepoAllowed } from "./github-app-auth";
import {
  getRepoLastSyncAt,
  hasIssueSnapshot,
  recordIssueLabelsSnapshot,
  recordIssueSnapshot,
  recordRepoSync,
  runInStateTransaction,
} from "./state";

type IssueLabel = { name?: string } | string;

type IssuePayload = {
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
  node_id?: string;
  labels?: IssueLabel[];
  pull_request?: unknown;
};

type FetchResult<T> =
  | { ok: true; data: T; headers: Headers }
  | { ok: false; status: number; body: string; headers: Headers };

type SyncDeps = {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  getToken?: () => Promise<string>;
  now?: () => Date;
};

export type SyncResult = {
  ok: boolean;
  fetched: number;
  stored: number;
  ralphCount: number;
  newLastSyncAt: string | null;
  hadChanges: boolean;
  rateLimitResetMs?: number;
  error?: string;
};

type PollerHandle = { stop: () => void };

const DEFAULT_SKEW_SECONDS = 5;
const DEFAULT_JITTER_PCT = 0.2;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_ERROR_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 10;
const MIN_DELAY_MS = 1000;

function applyJitter(valueMs: number, pct = DEFAULT_JITTER_PCT): number {
  const clamped = Math.max(valueMs, MIN_DELAY_MS);
  const variance = clamped * pct;
  const delta = (Math.random() * 2 - 1) * variance;
  return Math.max(MIN_DELAY_MS, Math.round(clamped + delta));
}

function nextDelayMs(params: {
  baseMs: number;
  previousMs: number;
  hadChanges: boolean;
  hadError: boolean;
  maxMultiplier?: number;
}): number {
  if (params.hadChanges) return params.baseMs;
  const multiplier = params.hadError ? DEFAULT_ERROR_MULTIPLIER : DEFAULT_BACKOFF_MULTIPLIER;
  const maxMultiplier = params.maxMultiplier ?? DEFAULT_MAX_BACKOFF_MULTIPLIER;
  const next = params.previousMs * multiplier;
  return Math.min(next, params.baseMs * maxMultiplier);
}

function computeSince(lastSyncAt: string | null, skewSeconds = DEFAULT_SKEW_SECONDS): string | null {
  if (!lastSyncAt) {
    return null;
  }

  const parsed = Date.parse(lastSyncAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed - skewSeconds * 1000).toISOString();
}

function parseLinkHeader(link: string | null): Record<string, string> {
  if (!link) return {};
  const out: Record<string, string> = {};
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel=\"([^\"]+)\"/);
    if (!match) continue;
    const [, url, rel] = match;
    out[rel] = url;
  }
  return out;
}

function isPullRequest(issue: IssuePayload): boolean {
  return Boolean(issue.pull_request);
}

function extractLabelNames(labels: IssueLabel[] | undefined): string[] {
  if (!Array.isArray(labels)) return [];
  const out: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      const trimmed = label.trim();
      if (trimmed) out.push(trimmed);
      continue;
    }
    const name = typeof label?.name === "string" ? label.name.trim() : "";
    if (name) out.push(name);
  }
  return out;
}

function hasRalphLabel(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase().startsWith("ralph:"));
}

async function fetchJson<T>(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit
): Promise<FetchResult<T>> {
  const res = await fetchImpl(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, status: res.status, body: text, headers: res.headers };
  }

  const data = (await res.json()) as T;
  return { ok: true, data, headers: res.headers };
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

function resolveRateLimitDelayMs(resetAtMs: number, nowMs: number): number {
  return Math.max(MIN_DELAY_MS, resetAtMs - nowMs);
}

async function fetchIssuesSince(params: {
  repo: string;
  since: string | null;
  token: string;
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}): Promise<
  | { ok: true; issues: IssuePayload[]; fetched: number; maxUpdatedAt: string | null }
  | { ok: false; fetched: number; maxUpdatedAt: string | null; rateLimitResetMs?: number; error: string }
> {
  let url = new URL(`https://api.github.com/repos/${params.repo}/issues`);
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
      const resetAt = resolveRateLimitReset(result.headers);
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

    for (const issue of nonPrRows) {
      maxUpdatedAt = computeMaxUpdatedAt(maxUpdatedAt, issue.updated_at);
    }

    const links = parseLinkHeader(result.headers.get("link"));
    const nextUrl = links.next ? new URL(links.next) : null;
    url = nextUrl;

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

export async function syncRepoIssuesOnce(params: {
  repo: string;
  lastSyncAt: string | null;
  deps?: SyncDeps;
}): Promise<SyncResult> {
  const deps = params.deps ?? {};
  const fetchImpl = deps.fetch ?? fetch;
  const getToken = deps.getToken ?? getInstallationToken;
  const now = deps.now ? deps.now() : new Date();
  const nowIso = now.toISOString();
  const since = computeSince(params.lastSyncAt);

  try {
    const token = await getToken();
    const fetchResult = await fetchIssuesSince({
      repo: params.repo,
      since,
      token,
      fetchImpl,
    });

    if (!fetchResult.ok) {
      return {
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

    let stored = 0;
    let ralphCount = 0;
    runInStateTransaction(() => {
      for (const issue of fetchResult.issues) {
        const number = issue.number ? String(issue.number) : "";
        if (!number) continue;

        const labels = extractLabelNames(issue.labels);
        const issueRef = `${params.repo}#${number}`;
        const hasRalph = hasRalphLabel(labels);
        if (hasRalph) ralphCount += 1;

        if (!hasRalph && !hasIssueSnapshot(params.repo, issueRef)) continue;

        const normalizedState = issue.state ? issue.state.toUpperCase() : undefined;

        recordIssueSnapshot({
          repo: params.repo,
          issue: issueRef,
          title: issue.title ?? undefined,
          state: normalizedState,
          url: issue.html_url ?? undefined,
          githubNodeId: issue.node_id ?? undefined,
          githubUpdatedAt: issue.updated_at ?? undefined,
          at: nowIso,
        });

        recordIssueLabelsSnapshot({
          repo: params.repo,
          issue: issueRef,
          labels,
          at: nowIso,
          useTransaction: false,
        });

        stored += 1;
      }
    });

    const hasIssues = fetchResult.issues.length > 0;
    const newLastSyncAt = hasIssues
      ? fetchResult.maxUpdatedAt ?? params.lastSyncAt ?? nowIso
      : params.lastSyncAt ?? null;

    return {
      ok: true,
      fetched: fetchResult.fetched,
      stored,
      ralphCount,
      newLastSyncAt,
      hadChanges: fetchResult.issues.length > 0,
    };
  } catch (error: any) {
    return {
      ok: false,
      fetched: 0,
      stored: 0,
      ralphCount: 0,
      newLastSyncAt: null,
      hadChanges: false,
      error: error?.message ?? String(error),
    };
  }
}

function formatRepoLabel(repo: string): string {
  return repo.includes("/") ? repo.split("/")[1] : repo;
}

function resolveBaseIntervalMs(baseIntervalMs: number): number {
  return Math.max(baseIntervalMs, MIN_DELAY_MS);
}

function startRepoPoller(params: {
  repo: RepoConfig;
  baseIntervalMs: number;
  log: (msg: string) => void;
}): PollerHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let delayMs = resolveBaseIntervalMs(params.baseIntervalMs);
  const repoName = params.repo.name;
  const repoLabel = formatRepoLabel(repoName);

  const scheduleNext = (nextDelayMsValue: number) => {
    if (stopped) return;
    const delay = applyJitter(nextDelayMsValue);
    timer = setTimeout(() => {
      void tick();
    }, delay);
  };

  const tick = async () => {
    if (stopped) return;
    const lastSyncAt = getRepoLastSyncAt(repoName);

    const result = await syncRepoIssuesOnce({ repo: repoName, lastSyncAt });

    if (result.ok) {
      if (result.newLastSyncAt && result.newLastSyncAt !== lastSyncAt) {
        recordRepoSync({
          repo: repoName,
          repoPath: params.repo.path,
          botBranch: params.repo.botBranch,
          lastSyncAt: result.newLastSyncAt,
        });
      }

      delayMs = nextDelayMs({
        baseMs: params.baseIntervalMs,
        previousMs: delayMs,
        hadChanges: result.hadChanges,
        hadError: false,
      });

      params.log(
        `[ralph:gh-sync:${repoLabel}] fetched=${result.fetched} stored=${result.stored} ` +
          `ralph=${result.ralphCount} cursor=${lastSyncAt ?? "none"}->${result.newLastSyncAt ?? "none"} ` +
          `delayMs=${delayMs}`
      );

      scheduleNext(delayMs);
      return;
    }

    if (result.rateLimitResetMs) {
      const nowMs = Date.now();
      const resetDelay = resolveRateLimitDelayMs(result.rateLimitResetMs, nowMs);
      delayMs = Math.max(delayMs, resetDelay);
      params.log(
        `[ralph:gh-sync:${repoLabel}] rate-limit reset in ${Math.round(resetDelay / 1000)}s (delayMs=${delayMs})`
      );
      scheduleNext(delayMs);
      return;
    }

    delayMs = nextDelayMs({
      baseMs: params.baseIntervalMs,
      previousMs: delayMs,
      hadChanges: false,
      hadError: true,
    });
    params.log(
      `[ralph:gh-sync:${repoLabel}] error=${result.error ?? "unknown"} delayMs=${delayMs}`
    );
    scheduleNext(delayMs);
  };

  scheduleNext(delayMs);

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function startGitHubIssuePollers(params: {
  repos: RepoConfig[];
  baseIntervalMs: number;
  log?: (msg: string) => void;
}): PollerHandle {
  const log = params.log ?? ((msg: string) => console.log(msg));
  const handles: PollerHandle[] = [];

  for (const repo of params.repos) {
    if (!isRepoAllowed(repo.name)) {
      log(`[ralph:gh-sync] Skipping ${repo.name} (owner not in allowlist)`);
      continue;
    }

    if (!repo.name || !repo.path || !repo.botBranch) {
      log(`[ralph:gh-sync] Skipping repo with missing config: ${JSON.stringify(repo.name)}`);
      continue;
    }

    handles.push(
      startRepoPoller({
        repo,
        baseIntervalMs: params.baseIntervalMs,
        log,
      })
    );
  }

  if (handles.length === 0) {
    log("[ralph:gh-sync] No repos configured for polling.");
  } else {
    log(`[ralph:gh-sync] Started polling ${handles.length} repo(s).`);
  }

  return {
    stop: () => {
      for (const handle of handles) handle.stop();
      handles.length = 0;
    },
  };
}
