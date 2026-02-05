import type { RepoConfig } from "../config";
import { shouldLog } from "../logging";
import {
  getRepoGithubDoneReconcileCursor,
  getRepoLabelSchemeState,
  recordRepoGithubDoneReconcileCursor,
  type RepoGithubDoneCursor,
} from "../state";
import { isRepoAllowed } from "../github-app-auth";
import { createRalphWorkflowLabelsEnsurer, ensureRalphWorkflowLabelsOnce, type EnsureOutcome } from "./ensure-ralph-workflow-labels";
import { GitHubClient, splitRepoFullName } from "./client";
import { executeIssueLabelOps, planIssueLabelOps } from "./issue-label-io";
import { RALPH_LABEL_STATUS_DONE } from "../github-labels";

type PollerHandle = { stop: () => void };
type TimeoutHandle = ReturnType<typeof setTimeout>;

type GraphQlResponse<T> = { data?: T; errors?: Array<{ message?: string | null }> };

type ClosingIssue = {
  number: number;
  url: string;
  state: string;
  labels: string[];
};

type MergedPullRequest = {
  number: number;
  url: string;
  mergedAt: string;
  closingIssues: ClosingIssue[];
};

type EnsureLabels = (repo: string) => Promise<EnsureOutcome>;
type ResolveDefaultBranch = (repo: string, github: GitHubClient) => Promise<string | null>;

type DoneReconcileResult = {
  ok: boolean;
  processedPrs: number;
  updatedIssues: number;
  error?: string;
  initializedCursor?: boolean;
};

const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_MAX_PRS_PER_RUN = 200;
const DEFAULT_BACKOFF_MULTIPLIER = 1.5;
const DEFAULT_ERROR_MULTIPLIER = 2;
const DEFAULT_MAX_BACKOFF_MULTIPLIER = 10;
const MIN_DELAY_MS = 1000;
const DEFAULT_DEFAULT_BRANCH_CACHE_TTL_MS = 10 * 60_000;
const IDLE_LOG_INTERVAL_MS = 60_000;

const DONE_LABEL = RALPH_LABEL_STATUS_DONE;
const TRANSITION_LABELS = [
  "ralph:status:queued",
  "ralph:status:in-progress",
  "ralph:status:in-bot",
  "ralph:status:paused",
  "ralph:status:escalated",
  "ralph:status:stopped",
];

function applyJitter(valueMs: number): number {
  const clamped = Math.max(valueMs, MIN_DELAY_MS);
  const variance = clamped * 0.2;
  const delta = (Math.random() * 2 - 1) * variance;
  return Math.max(MIN_DELAY_MS, Math.round(clamped + delta));
}

function nextDelayMs(params: {
  baseMs: number;
  previousMs: number;
  hadError: boolean;
}): number {
  const multiplier = params.hadError ? DEFAULT_ERROR_MULTIPLIER : DEFAULT_BACKOFF_MULTIPLIER;
  const next = params.previousMs * multiplier;
  return Math.min(next, params.baseMs * DEFAULT_MAX_BACKOFF_MULTIPLIER);
}

function resolveDelay(params: {
  baseMs: number;
  previousMs: number;
  hadError: boolean;
  hadWork: boolean;
}): { delayMs: number; reason: "work" | "idle" | "error" } {
  if (params.hadError) {
    return { delayMs: nextDelayMs({ baseMs: params.baseMs, previousMs: params.previousMs, hadError: true }), reason: "error" };
  }
  if (params.hadWork) {
    return { delayMs: params.baseMs, reason: "work" };
  }
  return {
    delayMs: nextDelayMs({ baseMs: params.baseMs, previousMs: params.previousMs, hadError: false }),
    reason: "idle",
  };
}

function parseIsoMs(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRepoFromIssueUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    return `${parts[0]}/${parts[1]}`;
  } catch {
    return null;
  }
}

function hasRalphLabel(labels: string[]): boolean {
  return labels.some((label) => label.toLowerCase().startsWith("ralph:"));
}

function selectUnprocessedMergedPrs(prs: MergedPullRequest[], cursor: RepoGithubDoneCursor): MergedPullRequest[] {
  const cursorMs = parseIsoMs(cursor.lastMergedAt) ?? 0;
  return prs
    .filter((pr) => {
      const mergedMs = parseIsoMs(pr.mergedAt);
      if (mergedMs === null) return false;
      if (mergedMs < cursorMs) return false;
      if (mergedMs === cursorMs && pr.number <= cursor.lastPrNumber) return false;
      return true;
    })
    .sort((a, b) => {
      const aMs = parseIsoMs(a.mergedAt) ?? 0;
      const bMs = parseIsoMs(b.mergedAt) ?? 0;
      if (aMs !== bMs) return aMs - bMs;
      return a.number - b.number;
    });
}

async function graphqlRequest<T>(github: GitHubClient, query: string, variables: Record<string, unknown>): Promise<T> {
  const response = await github.request<GraphQlResponse<T>>("/graphql", {
    method: "POST",
    body: { query, variables },
  });
  const payload = response.data;
  if (!payload) {
    throw new Error("GraphQL response missing payload");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(`GraphQL: ${payload.errors[0]?.message ?? "Unknown error"}`);
  }
  return payload.data ?? ({} as T);
}

async function fetchDefaultBranch(github: GitHubClient, repo: string): Promise<string | null> {
  const { owner, name } = splitRepoFullName(repo);
  const response = await github.request<{ default_branch?: string | null }>(`/repos/${owner}/${name}`);
  const branch = response.data?.default_branch ?? null;
  return typeof branch === "string" && branch.trim() ? branch.trim() : null;
}

function createDefaultBranchCache(params?: { ttlMs?: number; now?: () => number }) {
  const ttlMs = params?.ttlMs ?? DEFAULT_DEFAULT_BRANCH_CACHE_TTL_MS;
  const now = params?.now ?? (() => Date.now());
  const cache = new Map<string, { value: string | null; expiresAt: number }>();

  const get = async (repo: string, github: GitHubClient): Promise<string | null> => {
    const cached = cache.get(repo);
    const nowMs = now();
    if (cached && cached.expiresAt > nowMs) return cached.value;

    try {
      const value = await fetchDefaultBranch(github, repo);
      cache.set(repo, { value, expiresAt: nowMs + ttlMs });
      return value;
    } catch (error) {
      if (cached) return cached.value;
      throw error;
    }
  };

  return { get };
}

export function __resolveDoneReconcileDelayForTests(
  params: Parameters<typeof resolveDelay>[0]
): ReturnType<typeof resolveDelay> {
  return resolveDelay(params);
}

export function __createDefaultBranchCacheForTests(params?: { ttlMs?: number; now?: () => number }) {
  return createDefaultBranchCache(params);
}

async function fetchMergedPullRequests(params: {
  github: GitHubClient;
  repo: string;
  defaultBranch: string;
  since: string;
}): Promise<MergedPullRequest[]> {
  const { owner, name } = splitRepoFullName(params.repo);
  const query = `repo:${owner}/${name} is:pr is:merged base:${params.defaultBranch} merged:>=${params.since}`;
  const results: MergedPullRequest[] = [];
  let after: string | null = null;

  for (;;) {
    const data: {
      search?: {
        nodes?: Array<{
          __typename?: string | null;
          number?: number | null;
          url?: string | null;
          mergedAt?: string | null;
          closingIssuesReferences?: {
            nodes?: Array<{
              number?: number | null;
              url?: string | null;
              state?: string | null;
              labels?: { nodes?: Array<{ name?: string | null }> } | null;
            }>;
          } | null;
        }>;
        pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      };
    } = await graphqlRequest(
      params.github,
      `query($query: String!, $after: String) {
        search(type: ISSUE, query: $query, first: ${DEFAULT_PAGE_SIZE}, after: $after) {
          nodes {
            __typename
            ... on PullRequest {
              number
              url
              mergedAt
              closingIssuesReferences(first: 50) {
                nodes {
                  number
                  url
                  state
                  labels(first: 50) {
                    nodes { name }
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { query, after }
    );

    const nodes = data.search?.nodes ?? [];
    for (const node of nodes) {
      if (node?.__typename !== "PullRequest") continue;
      const number = typeof node.number === "number" ? node.number : null;
      const url = typeof node.url === "string" ? node.url : null;
      const mergedAt = typeof node.mergedAt === "string" ? node.mergedAt : null;
      if (!number || !url || !mergedAt) continue;

      const closingIssues = (node.closingIssuesReferences?.nodes ?? [])
        .map((issue: {
          number?: number | null;
          url?: string | null;
          state?: string | null;
          labels?: { nodes?: Array<{ name?: string | null }> } | null;
        }) => {
          const issueNumber = typeof issue?.number === "number" ? issue.number : null;
          const issueUrl = typeof issue?.url === "string" ? issue.url : null;
          if (!issueNumber || !issueUrl) return null;
          const labels = (issue?.labels?.nodes ?? [])
            .map((label: { name?: string | null }) => (typeof label?.name === "string" ? label.name.trim() : ""))
            .filter(Boolean);
          return {
            number: issueNumber,
            url: issueUrl,
            state: String(issue?.state ?? ""),
            labels,
          } satisfies ClosingIssue;
        })
        .filter(Boolean) as ClosingIssue[];

      results.push({ number, url, mergedAt, closingIssues });
    }

    const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } = data.search?.pageInfo ?? {};
    if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
    after = pageInfo.endCursor;
  }

  return results;
}

export async function reconcileRepoDoneState(params: {
  repo: RepoConfig;
  github: GitHubClient;
  now?: () => Date;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  maxPrsPerRun?: number;
  ensureLabels?: EnsureLabels;
  resolveDefaultBranch?: ResolveDefaultBranch;
}): Promise<DoneReconcileResult> {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));
  const now = params.now ?? (() => new Date());
  const repo = params.repo.name;
  const maxPrs = params.maxPrsPerRun ?? DEFAULT_MAX_PRS_PER_RUN;
  const prefix = `[ralph:done:${repo}]`;
  const ensureLabels =
    params.ensureLabels ??
    (async (targetRepo: string) => ensureRalphWorkflowLabelsOnce({ repo: targetRepo, github: params.github }));
  const resolveDefaultBranch = params.resolveDefaultBranch ?? ((targetRepo, github) => fetchDefaultBranch(github, targetRepo));

  if (!isRepoAllowed(repo)) {
    log(`${prefix} Skipping repo (owner not in allowlist)`);
    return { ok: true, processedPrs: 0, updatedIssues: 0 };
  }

  const scheme = getRepoLabelSchemeState(repo);
  if (scheme.errorCode === "legacy-workflow-labels") {
    log(`${prefix} Repo unschedulable due to legacy workflow labels; skipping done reconciler. See docs/ops/label-scheme-migration.md`);
    return { ok: true, processedPrs: 0, updatedIssues: 0 };
  }

  const labelOutcome = await ensureLabels(repo);
  if (!labelOutcome.ok) {
    const key = `ralph:done:labels:${repo}`;
    if (shouldLog(key, 60_000)) {
      warn(`${prefix} Failed to ensure workflow labels: ${labelOutcome.error instanceof Error ? labelOutcome.error.message : String(labelOutcome.error)}`);
    }
    return { ok: false, processedPrs: 0, updatedIssues: 0, error: "label-ensure-failed" };
  }

  const cursor = getRepoGithubDoneReconcileCursor(repo);
  if (!cursor) {
    const initAt = now().toISOString();
    recordRepoGithubDoneReconcileCursor({
      repo,
      repoPath: params.repo.path,
      botBranch: params.repo.botBranch,
      lastMergedAt: initAt,
      lastPrNumber: 0,
      updatedAt: initAt,
    });
    log(`${prefix} Initialized cursor at ${initAt}`);
    return { ok: true, processedPrs: 0, updatedIssues: 0, initializedCursor: true };
  }

  let defaultBranch: string | null = null;
  try {
    defaultBranch = await resolveDefaultBranch(repo, params.github);
  } catch (error: any) {
    warn(`${prefix} Failed to fetch default branch: ${error?.message ?? String(error)}`);
    return { ok: false, processedPrs: 0, updatedIssues: 0, error: "default-branch" };
  }

  if (!defaultBranch) {
    warn(`${prefix} Missing default branch; skipping done reconciliation`);
    return { ok: false, processedPrs: 0, updatedIssues: 0, error: "missing-default-branch" };
  }

  let mergedPrs: MergedPullRequest[] = [];
  try {
    mergedPrs = await fetchMergedPullRequests({ github: params.github, repo, defaultBranch, since: cursor.lastMergedAt });
  } catch (error: any) {
    warn(`${prefix} Failed to list merged PRs: ${error?.message ?? String(error)}`);
    return { ok: false, processedPrs: 0, updatedIssues: 0, error: "list-prs" };
  }

  const unprocessed = selectUnprocessedMergedPrs(mergedPrs, cursor);
  if (unprocessed.length === 0) {
    return { ok: true, processedPrs: 0, updatedIssues: 0 };
  }

  const toProcess = unprocessed.slice(0, maxPrs);
  let processed = 0;
  let updatedIssues = 0;
  let lastProcessed: MergedPullRequest | null = null;
  let hadFailure = false;

  for (const pr of toProcess) {
    const issues = pr.closingIssues.filter((issue) => {
      if (issue.state.toUpperCase() !== "OPEN") return false;
      const issueRepo = parseRepoFromIssueUrl(issue.url);
      if (issueRepo !== repo) return false;
      return hasRalphLabel(issue.labels);
    });

    for (const issue of issues) {
      const ops = planIssueLabelOps({ add: [DONE_LABEL], remove: TRANSITION_LABELS });
      const result = await executeIssueLabelOps({
        github: params.github,
        repo,
        issueNumber: issue.number,
        ops,
        log: (message) => log(`${prefix} ${message}`),
        logLabel: `${repo}#${issue.number}`,
      });
      if (!result.ok) {
        hadFailure = true;
        warn(`${prefix} Failed to update labels for #${issue.number}; will retry on next run.`);
        break;
      }
      updatedIssues += 1;
    }

    processed += 1;
    lastProcessed = pr;

    if (hadFailure) break;
  }

  if (hadFailure) {
    return { ok: false, processedPrs: processed, updatedIssues, error: "label-update" };
  }

  if (lastProcessed) {
    recordRepoGithubDoneReconcileCursor({
      repo,
      repoPath: params.repo.path,
      botBranch: params.repo.botBranch,
      lastMergedAt: lastProcessed.mergedAt,
      lastPrNumber: lastProcessed.number,
    });
  }

  log(`${prefix} processed=${processed} updatedIssues=${updatedIssues}`);
  return { ok: true, processedPrs: processed, updatedIssues };
}

function startRepoDoneReconciler(params: {
  repo: RepoConfig;
  baseIntervalMs: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  ensureLabels?: EnsureLabels;
  resolveDefaultBranch?: ResolveDefaultBranch;
}): PollerHandle {
  let stopped = false;
  let timer: TimeoutHandle | null = null;
  let inFlight = false;
  let delayMs = params.baseIntervalMs;

  const scheduleNext = (nextDelay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, applyJitter(nextDelay));
  };

  const tick = async () => {
    if (stopped) return;
    if (inFlight) {
      scheduleNext(delayMs);
      return;
    }
    inFlight = true;

    const github = new GitHubClient(params.repo.name);
    let hadError = false;
    try {
      const result = await reconcileRepoDoneState({
        repo: params.repo,
        github,
        log: params.log,
        warn: params.warn,
        ensureLabels: params.ensureLabels,
        resolveDefaultBranch: params.resolveDefaultBranch,
      });
      hadError = !result.ok;
      const hadWork = result.ok && (result.processedPrs > 0 || result.updatedIssues > 0);
      const resolved = resolveDelay({
        baseMs: params.baseIntervalMs,
        previousMs: delayMs,
        hadError,
        hadWork,
      });
      delayMs = resolved.delayMs;
      if (resolved.reason === "idle" && shouldLog(`ralph:done:${params.repo.name}:idle`, IDLE_LOG_INTERVAL_MS)) {
        const seconds = Math.round(delayMs / 1000);
        const details = result.initializedCursor ? "initialized cursor" : "no new merges";
        (params.log ?? ((message: string) => console.log(message)))(
          `[ralph:done:${params.repo.name}] idle (${details}); next check in ${seconds}s`
        );
      }
    } catch (error: any) {
      hadError = true;
      const warn = params.warn ?? ((message: string) => console.warn(message));
      warn(`[ralph:done:${params.repo.name}] Unexpected error: ${error?.message ?? String(error)}`);
      delayMs = nextDelayMs({ baseMs: params.baseIntervalMs, previousMs: delayMs, hadError });
    } finally {
      inFlight = false;
      if (!stopped) {
        scheduleNext(delayMs);
      }
    }
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

export function startGitHubDoneReconciler(params: {
  repos: RepoConfig[];
  baseIntervalMs: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): PollerHandle {
  const log = params.log ?? ((message: string) => console.log(message));
  const warn = params.warn ?? ((message: string) => console.warn(message));
  const handles: PollerHandle[] = [];
  const labelsEnsurer = createRalphWorkflowLabelsEnsurer({
    githubFactory: (repo) => new GitHubClient(repo),
    log,
    warn,
  });
  const defaultBranchCache = createDefaultBranchCache();

  for (const repo of params.repos) {
    if (!repo.name || !repo.path || !repo.botBranch) {
      log(`[ralph:done] Skipping repo with missing config: ${JSON.stringify(repo.name)}`);
      continue;
    }
    handles.push(
      startRepoDoneReconciler({
        repo,
        baseIntervalMs: params.baseIntervalMs,
        log,
        warn,
        ensureLabels: labelsEnsurer.ensure,
        resolveDefaultBranch: defaultBranchCache.get,
      })
    );
  }

  if (handles.length === 0) {
    log("[ralph:done] No repos configured for done reconciliation.");
  } else {
    log(`[ralph:done] Started done reconciliation for ${handles.length} repo(s).`);
  }

  return {
    stop: () => {
      for (const handle of handles) handle.stop();
      handles.length = 0;
    },
  };
}
